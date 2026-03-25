const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createStoryStore } = require("../lib/story-store");
const { createWorkspaceTools } = require("../lib/workspace");
const { createContextTools } = require("../lib/context");
const { createMemoryTools } = require("../lib/memory");
const { consolidateMemoryRecords } = require("../lib/memory-consolidation");
const {
  createEmbeddingTools,
  normalizeEmbeddingConfig,
  normalizeEmbeddingMode,
  normalizeEmbeddingRemoteHost,
} = require("../lib/embeddings");
const { createKnowledgeRetrievalTools } = require("../lib/knowledge-retrieval");
const { buildMemoryQuery, selectRelevantMemoryRecords, formatMemoryContext } = require("../lib/memory-engine");
const { createMemoryRetrievalTools } = require("../lib/memory-retrieval");
const { createLocalVectorSearchItems, createLocalVectorSearchRecords } = require("../lib/memory-vector");
const { createProposalTools } = require("../lib/proposals");
const { createChatTools } = require("../lib/chat");
const { createProviderTools } = require("../lib/providers");
const { createServerConfigTools } = require("../lib/server-config");
const { createGroundingCheckTools } = require("../lib/grounding-check");

const DEFAULT_CONTEXT_BLOCKS = 6;
const DEFAULT_SUMMARY_INTERVAL = 4;
const DEFAULT_MAX_COMPLETION_TOKENS = 900;

function summarizeText(value, maxLength) {
  const text = String(value || "").trim();
  if (!maxLength || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || `story-${Date.now()}`;
}

let idCounter = 0;
function safeId(prefix) {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-atlas-test-"));
}

function createStoreHarness(rootDir) {
  const DATA_DIR = path.join(rootDir, "data");
  const CONFIG_DIR = path.join(DATA_DIR, "config");
  const LIBRARY_DIR = path.join(DATA_DIR, "library");
  const STORIES_DIR = path.join(DATA_DIR, "stories");

  let workspaceTools = null;
  const storyStore = createStoryStore({
    DATA_DIR,
    CONFIG_DIR,
    LIBRARY_DIR,
    STORIES_DIR,
    DEFAULT_CONTEXT_BLOCKS,
    DEFAULT_SUMMARY_INTERVAL,
    DEFAULT_MAX_COMPLETION_TOKENS,
    safeId,
    slugify,
    getSyncStoryWorkspace: () => workspaceTools,
  });

  workspaceTools = createWorkspaceTools({
    getLibraryTypeDir: storyStore.getLibraryTypeDir,
    getStoryWorkspaceDir: storyStore.getStoryWorkspaceDir,
    getStory: storyStore.getStory,
    readJson: storyStore.readJson,
    writeJson: storyStore.writeJson,
    listJsonFiles: storyStore.listJsonFiles,
  });

  return {
    ...storyStore,
    workspaceTools,
  };
}

function buildMemoryTools() {
  return createMemoryTools({
    DEFAULT_SUMMARY_INTERVAL,
    MEMORY_SUMMARY_CHAR_LIMIT: 160,
    classifyPressure: (usedTokens, maxTokens) => {
      const ratio = maxTokens ? usedTokens / maxTokens : 0;
      if (ratio >= 0.82) {
        return "high";
      }
      if (ratio >= 0.6) {
        return "medium";
      }
      return "low";
    },
    summarizeText,
    safeId,
    getProviderForStory: () => null,
    decryptSecret: () => "",
    callOpenAICompatible: async () => {
      throw new Error("Provider should not be called in smoke tests");
    },
    tryParseJsonObject: (value) => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    },
  });
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

async function main() {
  await runTest("story-store creates a story and syncs enabled library items", () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      harness.saveLibraryItem("characters", {
        id: "char_hero",
        name: "Hero",
        traits: ["brave"],
        updatedAt: "2026-03-23T00:00:00.000Z",
        createdAt: "2026-03-23T00:00:00.000Z",
      });

      const story = harness.createDefaultStory({
        title: "Smoke Story",
        enabled: { characters: ["char_hero"], worldbooks: [], styles: [] },
      });

      const workspaceCharacter = harness.readJson(
        path.join(harness.getStoryWorkspaceDir(story.id, "characters"), "char_hero.json")
      );

      assert.equal(story.title, "Smoke Story");
      assert.equal(workspaceCharacter.name, "Hero");
      assert.equal(workspaceCharacter.sourceId, "char_hero");
      assert.deepEqual(
        harness.workspaceTools.loadActiveWorkspaceItems(story.id, "characters", story.enabled.characters).map((item) => item.id),
        ["char_hero"]
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  await runTest("story-store rejects unsafe library item ids", () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      assert.throws(
        () =>
          harness.saveLibraryItem("characters", {
            id: "..\\escape",
            name: "Unsafe",
          }),
        /Library item id/
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  await runTest("context tools assemble system, workspace, memory, and history blocks", async () => {
    const { embedText, buildQueryEmbeddingText } = createEmbeddingTools();
    const { retrieveKnowledgeChunks, formatKnowledgeContext } = createKnowledgeRetrievalTools({
      embedText,
      extractKeywords: require("../lib/memory-engine").extractKeywords,
    });
    const contextTools = createContextTools({
      DEFAULT_CONTEXT_BLOCKS,
      estimateTokens: (value) => Math.max(1, Math.ceil(String(value || "").length / 4)),
      selectRelevantMemoryRecords: (memoryRecords) => ({
        selectedRecords: memoryRecords.slice(0, 1),
        reasonsById: memoryRecords[0] ? { [memoryRecords[0].id]: ["keyword match"] } : {},
      }),
      formatMemoryContext: (records) => records.map((item) => item.summary).join("\n"),
      getProviderContextWindow: () => 2000,
      buildQueryEmbedding: ({ userMessage, messages, workspace, embeddingOptions }) =>
        embedText(buildQueryEmbeddingText({ userMessage, messages, workspace }), embeddingOptions),
      retrieveKnowledgeChunks,
      formatKnowledgeContext,
    });

    const story = {
      promptConfig: {
        globalSystemPrompt: "Global prompt",
        storySystemPrompt: "Story prompt",
      },
      settings: { contextBlocks: 3 },
    };
    const workspace = {
      characters: [{ name: "Hero", core: { role: "lead" }, traits: ["brave"], arcState: { current: "chooses duty" }, relationships: { Mira: "ally" }, notes: "Carries a silver compass." }],
      worldbooks: [{ title: "Nocturne City", category: "city", rules: ["Never cross the red bridge"], content: "A rain-soaked city.", revealedFacts: ["The archive sleeps"], storyState: "Unrest is rising" }],
      styles: [{ name: "Velvet Gothic", tone: "lush", voice: "close third", pacing: "measured", dos: ["Use concrete imagery"], donts: ["Break canon"] }],
    };
    const messages = [
      { role: "user", content: "Continue the story." },
      { role: "assistant", content: "Hero finds the archive key." },
    ];
    const memoryRecords = [{ id: "mem_1", summary: "Hero learned Mira guards the archive." }];

    const result = await contextTools.buildContextBlocks(story, messages, memoryRecords, workspace);
    const labels = result.blocks.map((item) => item.label);

    assert.ok(labels.includes("system:global"));
    assert.ok(labels.includes("system:story"));
    assert.ok(labels.includes("system:retrieval_policy"));
    assert.ok(labels.includes("characters"));
    assert.ok(labels.includes("worldbook"));
    assert.ok(labels.includes("style"));
    assert.ok(labels.includes("knowledge:retrieved"));
    assert.ok(labels.includes("memory:critical") || labels.includes("memory:recent") || labels.includes("memory:long_term"));
    assert.ok(labels.some((label) => label.startsWith("history_turn:")));
    assert.equal(result.selectedMemoryRecords[0].id, "mem_1");
    assert.ok(result.selectedKnowledgeChunks.length > 0);
    assert.ok(result.selectedKnowledgeChunks.some((item) => item.chunkType));
    assert.equal(result.knowledgeRetrievalMeta.mode, "rag");
    assert.ok(Number.isFinite(result.knowledgeRetrievalMeta.vectorCandidateCount || 0));
    const characterBlock = result.blocks.find((item) => item.label === "characters");
    const worldbookBlock = result.blocks.find((item) => item.label === "worldbook");
    assert.ok(characterBlock?.content.includes("Character: Hero"));
    assert.ok(!characterBlock?.content.includes("Relationships:"));
    assert.ok(worldbookBlock?.content.includes("World: Nocturne City"));
    assert.ok(!worldbookBlock?.content.includes("Content: A rain-soaked city."));
  });

  await runTest("knowledge retrieval builds focused query cues from workspace and recent turns", async () => {
    const { buildKnowledgeQuery } = createKnowledgeRetrievalTools({
      extractKeywords: require("../lib/memory-engine").extractKeywords,
    });

    const query = buildKnowledgeQuery({
      userMessage: "How does Mira cross the red bridge now?",
      messages: [
        { role: "assistant", content: "Mira learns the city still forbids crossing the red bridge at dusk." },
        { role: "user", content: "Does Nocturne City still matter here?" },
      ],
      workspace: {
        characters: [{ id: "mira", name: "Mira", core: { role: "Scout" }, traits: ["bridge-runner"] }],
        worldbooks: [{ id: "city", title: "Nocturne City", category: "city", rules: ["Never cross the red bridge"] }],
        styles: [{ id: "style_gothic", name: "Velvet Gothic", tone: "lush", voice: "close third" }],
      },
    });

    assert.ok(query.focusClauses.length > 0);
    assert.ok(query.keywords.includes("mira"));
    assert.ok(query.matchedEntries.some((item) => item.id === "mira"));
    assert.ok(query.matchedEntries.some((item) => item.id === "city"));
    assert.ok(query.primaryMatchedEntries.some((item) => item.id === "mira"));
    assert.ok(query.primaryMatchedEntries.some((item) => item.id === "city"));
    assert.ok(query.embeddingText.includes("Current ask:"));
    assert.ok(query.embeddingText.includes("Focus cues:"));
    assert.ok(query.embeddingText.includes("Primary focus:"));
    assert.ok(query.embeddingText.includes("Entity focus:"));
  });

  await runTest("knowledge query keeps primary focus on the current ask over stale recent history", async () => {
    const { buildKnowledgeQuery } = createKnowledgeRetrievalTools({
      extractKeywords: require("../lib/memory-engine").extractKeywords,
    });

    const query = buildKnowledgeQuery({
      userMessage: "Continue with Bai meeting Yian on the path.",
      messages: [
        { role: "assistant", content: "Earlier, Bai woke in Eira's cave and noticed Eira still studying the array map." },
        { role: "user", content: "What was Eira doing with the array map?" },
      ],
      workspace: {
        characters: [
          { id: "bai", name: "Bai", core: { role: "Lead" } },
          { id: "yian", name: "Yian", core: { role: "Youngest disciple" } },
          { id: "eira", name: "Eira", core: { role: "First senior sister" } },
        ],
        worldbooks: [],
        styles: [],
      },
    });

    assert.ok(query.matchedEntries.some((item) => item.id === "eira"));
    assert.ok(query.primaryMatchedEntries.some((item) => item.id === "bai"));
    assert.ok(query.primaryMatchedEntries.some((item) => item.id === "yian"));
    assert.ok(!query.primaryMatchedEntries.some((item) => item.id === "eira"));
  });

  await runTest("knowledge retrieval prefers the exact relationship-target chunk", async () => {
    const { retrieveKnowledgeChunks, buildKnowledgeChunks } = createKnowledgeRetrievalTools({
      extractKeywords: require("../lib/memory-engine").extractKeywords,
    });

    const workspace = {
      characters: [
        {
          id: "bai",
          name: "Bai",
          relationships: {
            Ava: "trusted co-strategist during the archive campaign who quietly rewrites Bai's battle plans every dawn",
            Bea: "older rival who needles Bai in public and only offers help when nobody else is looking",
            Cid: "patient quartermaster who keeps Bai supplied with contraband maps and forged gate sigils",
            Dax: "tower watcher who reports every bell change before Bai ever hears the city alarms",
            Eira: "first senior sister whose rule-bound care leaves Bai both flustered and oddly comforted",
          },
        },
        { id: "ava", name: "Ava", core: { role: "strategist" } },
        { id: "bea", name: "Bea", core: { role: "rival" } },
        { id: "cid", name: "Cid", core: { role: "quartermaster" } },
        { id: "dax", name: "Dax", core: { role: "watcher" } },
        { id: "eira", name: "Eira", core: { role: "first senior sister" } },
      ],
      worldbooks: [],
      styles: [],
    };

    const relationshipChunks = buildKnowledgeChunks(workspace).filter(
      (item) => item.sourceId === "bai" && item.chunkType === "relationships"
    );
    assert.ok(relationshipChunks.length >= 2);
    assert.ok(relationshipChunks.some((item) => item.text.includes("Eira=")));
    assert.ok(
      relationshipChunks
        .filter((item) => !item.text.includes("Eira="))
        .every((item) => !(item.entities || []).includes("Eira"))
    );

    const result = await retrieveKnowledgeChunks({
      story: { id: "knowledge_exact_relationship" },
      workspace,
      userMessage: "How does Bai deal with Eira now?",
      messages: [{ role: "assistant", content: "Bai wakes in Eira's cave and tries to pretend the overnight stay meant nothing." }],
      embeddingOptions: { mode: "off" },
      maxItems: 1,
    });

    assert.equal(result.selectedChunks.length, 1);
    assert.ok(result.selectedChunks[0].text.includes("Eira="));
  });

  await runTest("knowledge retrieval favors the current-turn pair over stale history carryover", async () => {
    const { retrieveKnowledgeChunks } = createKnowledgeRetrievalTools({
      extractKeywords: require("../lib/memory-engine").extractKeywords,
    });

    const workspace = {
      characters: [
        {
          id: "yian",
          name: "Yian",
          relationships: {
            Eira: "treats Eira as someone important to Bai, stays polite around her, and watches her quietly for any shift in Bai's attention",
            Ava: "borrows herb notes from Ava and returns them without a crease",
            Cid: "thinks Cid smells like ink and lamp smoke",
            Dax: "waves at Dax whenever the watchtower bells ring",
            Bai: "clings to Bai with bright trust, waits on the path for her, and always asks whether Bai will still check tonight's lessons",
          },
        },
        { id: "bai", name: "Bai", core: { role: "Lead" } },
        { id: "eira", name: "Eira", core: { role: "First senior sister" } },
        { id: "ava", name: "Ava", core: { role: "Archivist" } },
        { id: "cid", name: "Cid", core: { role: "Quartermaster" } },
        { id: "dax", name: "Dax", core: { role: "Watcher" } },
      ],
      worldbooks: [],
      styles: [],
    };

    const result = await retrieveKnowledgeChunks({
      story: { id: "knowledge_current_pair_priority" },
      workspace,
      userMessage: "Continue with Bai meeting Yian on the path.",
      messages: [
        { role: "assistant", content: "Earlier, Bai woke in Eira's cave and saw Eira still studying the unfinished array map." },
        { role: "user", content: "What was Eira thinking back then?" },
      ],
      embeddingOptions: { mode: "off" },
      maxItems: 1,
    });

    assert.equal(result.selectedChunks.length, 1);
    assert.equal(result.selectedChunks[0].sourceId, "yian");
    assert.ok(result.selectedChunks[0].text.includes("Bai="));
  });

  await runTest("knowledge traits chunks keep compact entity labels instead of full prose", () => {
    const { buildKnowledgeChunks } = createKnowledgeRetrievalTools({
      extractKeywords: require("../lib/memory-engine").extractKeywords,
    });

    const chunks = buildKnowledgeChunks({
      characters: [
        {
          id: "xiao",
          name: "萧令仪",
          traits: [
            "表层性格：复古克己，端庄守礼，待人温和有度，礼数周全。",
            "真实性格：本性淡漠至极，无情道大成之后几乎不会产生喜怒哀乐。",
          ],
        },
      ],
      worldbooks: [],
      styles: [],
    }).filter((item) => item.chunkType === "traits");

    assert.ok(chunks.length > 0);
    assert.ok(chunks.every((item) => (item.entities || []).includes("萧令仪")));
    assert.ok(chunks.some((item) => (item.entities || []).includes("表层性格")));
    assert.ok(chunks.some((item) => (item.entities || []).includes("真实性格")));
    assert.ok(chunks.every((item) => !(item.entities || []).some((entity) => String(entity).includes("复古克己"))));
    assert.ok(chunks.every((item) => !(item.entities || []).some((entity) => String(entity).includes("无情道大成"))));
  });

  await runTest("context tools lean knowledge anchors in knowledge rag mode", async () => {
    const contextTools = createContextTools({
      DEFAULT_CONTEXT_BLOCKS,
      estimateTokens: (value) => Math.max(1, Math.ceil(String(value || "").length / 4)),
      selectRelevantMemoryRecords: () => ({
        selectedRecords: [],
        reasonsById: {},
        retrievalMeta: { mode: "lexical", activeMode: "lexical", vectorEnabled: false, vectorCandidateCount: 0, vectorSelectedCount: 0 },
      }),
      formatMemoryContext: () => "",
      getProviderContextWindow: () => 2000,
      buildQueryEmbedding: async () => [1, 0],
      retrieveKnowledgeChunks: async () => ({
        selectedChunks: [],
        retrievalMeta: {
          mode: "rag",
          activeMode: "rag",
          vectorEnabled: true,
          vectorCandidateCount: 0,
          vectorSelectedCount: 0,
          chunkCount: 0,
          fallbackReason: "",
        },
      }),
      formatKnowledgeContext: () => "",
    });

    const story = {
      promptConfig: {
        globalSystemPrompt: "Global prompt",
        storySystemPrompt: "Story prompt",
      },
      settings: { contextBlocks: 3 },
    };
    const workspace = {
      characters: [{ name: "Hero", core: { role: "lead" }, traits: ["brave"], arcState: { current: "chooses duty" } }],
      worldbooks: [{ title: "Nocturne City", category: "city", rules: ["Never cross the red bridge"], storyState: "Unrest is rising" }],
      styles: [{ name: "Velvet Gothic", tone: "lush", voice: "close third", pacing: "measured", dos: ["Use concrete imagery"], donts: ["Break canon"] }],
    };

    const result = await contextTools.buildContextBlocks(story, [], [], workspace, {
      currentUserInput: "Continue the scene.",
      embeddingOptions: { mode: "on" },
    });

    const characterBlock = result.blocks.find((item) => item.label === "characters");
    const worldbookBlock = result.blocks.find((item) => item.label === "worldbook");
    const styleBlock = result.blocks.find((item) => item.label === "style");

    assert.ok(characterBlock?.content.includes("Character: Hero / Role: lead / Arc: chooses duty"));
    assert.ok(!characterBlock?.content.includes("Traits:"));
    assert.ok(worldbookBlock?.content.includes("World: Nocturne City / Category: city / State: Unrest is rising"));
    assert.ok(!worldbookBlock?.content.includes("Rules:"));
    assert.ok(styleBlock?.content.includes("Style: Velvet Gothic / Tone: lush / Voice: close third"));
    assert.ok(!styleBlock?.content.includes("pacing="));
  });

  await runTest("context tools focus knowledge anchors around retrieved or hinted sources", async () => {
    const contextTools = createContextTools({
      DEFAULT_CONTEXT_BLOCKS,
      estimateTokens: (value) => Math.max(1, Math.ceil(String(value || "").length / 4)),
      selectRelevantMemoryRecords: () => ({
        selectedRecords: [],
        reasonsById: {},
        retrievalMeta: { mode: "rag", activeMode: "lexical", vectorEnabled: false, vectorCandidateCount: 0, vectorSelectedCount: 0 },
      }),
      formatMemoryContext: () => "",
      getProviderContextWindow: () => 2000,
      buildQueryEmbedding: async () => [1, 0],
      retrieveKnowledgeChunks: async () => ({
        selectedChunks: [
          {
            id: "knowledge_character_relationships_mira",
            sourceType: "character",
            sourceId: "mira",
            chunkType: "relationships",
            text: "Character: Mira\nRelationships: Hero=ally",
          },
          {
            id: "knowledge_world_rules_city",
            sourceType: "worldbook",
            sourceId: "city",
            chunkType: "rules",
            text: "World: Nocturne City\nRules: Never cross the red bridge",
          },
        ],
        retrievalMeta: {
          mode: "rag",
          activeMode: "rag",
          vectorEnabled: true,
          vectorCandidateCount: 2,
          vectorSelectedCount: 2,
          chunkCount: 6,
          fallbackReason: "",
        },
        anchorHints: {
          characterIds: ["mira"],
          worldbookIds: ["city"],
          styleIds: [],
        },
      }),
      formatKnowledgeContext: (chunks) => chunks.map((item) => item.text).join("\n\n"),
    });

    const result = await contextTools.buildContextBlocks(
      {
        promptConfig: { globalSystemPrompt: "Global prompt", storySystemPrompt: "Story prompt" },
        settings: { contextBlocks: 3 },
      },
      [{ role: "user", content: "How does Mira deal with the bridge rule now?" }],
      [],
      {
        characters: [
          { id: "mira", name: "Mira", core: { role: "Scout" }, traits: ["sharp"], arcState: { current: "tests the city limits" } },
          { id: "hero", name: "Hero", core: { role: "Lead" }, traits: ["brave"], arcState: { current: "holds the line" } },
        ],
        worldbooks: [
          { id: "city", title: "Nocturne City", category: "city", rules: ["Never cross the red bridge"], storyState: "Unrest is rising" },
          { id: "forest", title: "Moth Forest", category: "wilds", rules: ["Never answer the lanterns"], storyState: "Silent" },
        ],
        styles: [{ id: "style_gothic", name: "Velvet Gothic", tone: "lush", voice: "close third" }],
      },
      {
        currentUserInput: "How does Mira deal with the bridge rule now?",
        embeddingOptions: { mode: "on" },
      }
    );

    const characterBlock = result.blocks.find((item) => item.label === "characters");
    const worldbookBlock = result.blocks.find((item) => item.label === "worldbook");

    assert.ok(characterBlock?.content.includes("Character: Mira"));
    assert.ok(!characterBlock?.content.includes("Character: Hero"));
    assert.ok(worldbookBlock?.content.includes("World: Nocturne City"));
    assert.ok(!worldbookBlock?.content.includes("World: Moth Forest"));
  });

  await runTest("context tools route retrieval budgets toward memory-heavy turns", async () => {
    let memoryOptions = null;
    let knowledgeOptions = null;
    const contextTools = createContextTools({
      DEFAULT_CONTEXT_BLOCKS,
      estimateTokens: (value) => Math.max(1, Math.ceil(String(value || "").length / 4)),
      selectRelevantMemoryRecords: (_memoryRecords, options = {}) => {
        memoryOptions = options;
        return {
          selectedRecords: [],
          reasonsById: {},
          selectedEvidenceChunks: [],
          selectedEvidenceReasons: {},
          contestedRecords: [],
          contestedReasonsById: {},
          retrievalMeta: { mode: "rag", activeMode: "lexical", vectorEnabled: false, vectorCandidateCount: 0, vectorSelectedCount: 0 },
        };
      },
      formatMemoryContext: () => "",
      getProviderContextWindow: () => 32000,
      buildQueryEmbedding: async () => [1, 0],
      retrieveKnowledgeChunks: async (options = {}) => {
        knowledgeOptions = options;
        return {
          selectedChunks: [],
          retrievalMeta: {
            mode: "rag",
            activeMode: "lexical",
            vectorEnabled: false,
            vectorCandidateCount: 0,
            vectorSelectedCount: 0,
            chunkCount: 0,
          },
        };
      },
      formatKnowledgeContext: () => "",
    });

    const result = await contextTools.buildContextBlocks(
      {
        promptConfig: { globalSystemPrompt: "Global prompt", storySystemPrompt: "Story prompt" },
        settings: { contextBlocks: 3 },
      },
      [
        { role: "user", content: "Hero finally reached the archive." },
        { role: "assistant", content: "He presses the seal and waits for the mechanism to answer." },
      ],
      [{ id: "mem_1", summary: "Hero reached the archive." }],
      {
        characters: [{ id: "hero", name: "Hero", core: { role: "Lead" } }],
        worldbooks: [{ id: "archive", title: "Archive", category: "vault" }],
        styles: [],
      },
      {
        currentUserInput: "Continue the scene from that moment.",
        memoryChunks: [{ id: "chunk_1", text: "The seal hums under Hero's hand." }],
        embeddingOptions: { mode: "off" },
      }
    );

    assert.equal(result.retrievalPlan.route, "memory_heavy");
    assert.ok(result.retrievalPlan.budgets.memoryItems > result.retrievalPlan.budgets.knowledgeItems - 2);
    assert.ok(result.retrievalPlan.budgets.memoryEvidenceItems >= 3);
    assert.equal(memoryOptions.maxItems, result.retrievalPlan.budgets.memoryItems);
    assert.equal(memoryOptions.maxEvidenceItems, result.retrievalPlan.budgets.memoryEvidenceItems);
    assert.equal(knowledgeOptions.maxItems, result.retrievalPlan.budgets.knowledgeItems);
  });

  await runTest("context tools route retrieval budgets toward knowledge-heavy turns", async () => {
    let memoryOptions = null;
    let knowledgeOptions = null;
    const contextTools = createContextTools({
      DEFAULT_CONTEXT_BLOCKS,
      estimateTokens: (value) => Math.max(1, Math.ceil(String(value || "").length / 4)),
      selectRelevantMemoryRecords: (_memoryRecords, options = {}) => {
        memoryOptions = options;
        return {
          selectedRecords: [],
          reasonsById: {},
          selectedEvidenceChunks: [],
          selectedEvidenceReasons: {},
          contestedRecords: [],
          contestedReasonsById: {},
          retrievalMeta: { mode: "rag", activeMode: "lexical", vectorEnabled: false, vectorCandidateCount: 0, vectorSelectedCount: 0 },
        };
      },
      formatMemoryContext: () => "",
      getProviderContextWindow: () => 32000,
      buildQueryEmbedding: async () => [1, 0],
      retrieveKnowledgeChunks: async (options = {}) => {
        knowledgeOptions = options;
        return {
          selectedChunks: [],
          retrievalMeta: {
            mode: "rag",
            activeMode: "lexical",
            vectorEnabled: false,
            vectorCandidateCount: 0,
            vectorSelectedCount: 0,
            chunkCount: 0,
          },
        };
      },
      formatKnowledgeContext: () => "",
    });

    const result = await contextTools.buildContextBlocks(
      {
        promptConfig: { globalSystemPrompt: "Global prompt", storySystemPrompt: "Story prompt" },
        settings: { contextBlocks: 3 },
      },
      [{ role: "assistant", content: "Mira stops at the bridge gate." }],
      [{ id: "mem_1", summary: "Mira reached the bridge." }],
      {
        characters: [{ id: "mira", name: "Mira", core: { role: "Scout" } }],
        worldbooks: [{ id: "city", title: "Nocturne City", category: "city", rules: ["Never cross the red bridge"] }],
        styles: [{ id: "velvet", name: "Velvet Gothic", tone: "lush", voice: "close third" }],
      },
      {
        currentUserInput: "What are the rules of Nocturne City, and how should the bridge scene be described in this style?",
        memoryChunks: [{ id: "chunk_1", text: "Mira stops at the bridge gate." }],
        embeddingOptions: { mode: "off" },
      }
    );

    assert.equal(result.retrievalPlan.route, "knowledge_heavy");
    assert.ok(result.retrievalPlan.budgets.knowledgeItems > result.retrievalPlan.budgets.memoryItems);
    assert.ok(result.retrievalPlan.scores.knowledge > result.retrievalPlan.scores.memory);
    assert.ok((result.retrievalPlan.reasons || []).some((item) => /style|knowledge|lore/i.test(String(item))));
    assert.equal(memoryOptions.maxItems, result.retrievalPlan.budgets.memoryItems);
    assert.equal(knowledgeOptions.maxItems, result.retrievalPlan.budgets.knowledgeItems);
  });

  await runTest("context tools fuse memory and knowledge candidates into a final shared selection", async () => {
    const contextTools = createContextTools({
      DEFAULT_CONTEXT_BLOCKS,
      estimateTokens: (value) => Math.max(1, Math.ceil(String(value || "").length / 4)),
      selectRelevantMemoryRecords: () => ({
        selectedRecords: [
          { id: "mem_fact_1", tier: "long_term", stability: "stable", importance: "high", summary: "The red bridge can only be crossed during the toll bell.", canonKey: "world:red_bridge" },
          { id: "mem_fact_2", tier: "short_term", importance: "medium", summary: "Mira learned the bell schedule from the ferryman.", canonKey: "mira:bell" },
          { id: "mem_fact_3", tier: "short_term", importance: "low", summary: "The gate lantern flickered once.", canonKey: "scene:lantern" },
        ],
        reasonsById: {
          mem_fact_1: ["Matched keywords: red, bridge", "vector similarity (test-local)"],
          mem_fact_2: ["Matched keywords: bell, ferryman"],
          mem_fact_3: ["Matched keywords: lantern"],
        },
        selectedEvidenceChunks: [
          { id: "mem_evidence_1", linkedRecordId: "mem_fact_1", text: "The toll bell rang once and the bridge wardens stepped aside." },
          { id: "mem_evidence_2", linkedRecordId: "mem_fact_2", text: "The ferryman traced the bell marks into Mira's palm." },
          { id: "mem_evidence_3", linkedRecordId: "mem_fact_3", text: "A lantern snapped in the rain and left sparks on the stone." },
        ],
        selectedEvidenceReasons: {
          mem_evidence_1: ["Linked to a selected memory fact", "vector similarity (test-local)"],
          mem_evidence_2: ["Linked to a selected memory fact"],
          mem_evidence_3: ["Keyword match: lantern"],
        },
        contestedRecords: [],
        contestedReasonsById: {},
        retrievalMeta: {
          mode: "rag",
          activeMode: "rag",
          vectorEnabled: true,
          vectorCandidateCount: 6,
          vectorSelectedCount: 4,
          evidenceCandidateCount: 3,
          evidenceSelectedCount: 3,
        },
      }),
      formatMemoryContext: (records) => records.map((item) => item.summary).join("\n"),
      getProviderContextWindow: () => 16000,
      buildQueryEmbedding: async () => [1, 0],
      retrieveKnowledgeChunks: async () => ({
        selectedChunks: [
          { id: "knowledge_1", sourceType: "worldbook", sourceId: "city", title: "Nocturne City", chunkType: "rules", text: "World: Nocturne City\nRules: The red bridge only opens during the toll bell.", reasons: ["Entity match: Nocturne City", "Local vector similarity"] },
          { id: "knowledge_2", sourceType: "worldbook", sourceId: "city", title: "Nocturne City", chunkType: "content", text: "World: Nocturne City\nContent: Wardens mark the bridge with silver paint after each bell.", reasons: ["Keyword match: bridge"] },
          { id: "knowledge_3", sourceType: "character", sourceId: "mira", title: "Mira", chunkType: "relationships", text: "Character: Mira\nRelationships: Ferryman=secret tutor", reasons: ["Entity match: Mira"] },
          { id: "knowledge_4", sourceType: "style", sourceId: "velvet", title: "Velvet Gothic", chunkType: "style_profile", text: "Style: Velvet Gothic\nTone: lush\nVoice: close third", reasons: ["Entity match: Velvet Gothic"] },
          { id: "knowledge_5", sourceType: "worldbook", sourceId: "city", title: "Nocturne City", chunkType: "story_state", text: "World: Nocturne City\nStory State: The toll bell decides who may cross.", reasons: ["Keyword match: toll bell"] },
          { id: "knowledge_6", sourceType: "character", sourceId: "warden", title: "Bridge Warden", chunkType: "identity", text: "Character: Bridge Warden\nRole: gatekeeper", reasons: ["Keyword match: warden"] },
        ],
        retrievalMeta: {
          mode: "rag",
          activeMode: "rag",
          vectorEnabled: true,
          vectorCandidateCount: 6,
          vectorSelectedCount: 4,
          chunkCount: 12,
        },
        anchorHints: {
          characterIds: ["mira"],
          worldbookIds: ["city"],
          styleIds: ["velvet"],
        },
      }),
      formatKnowledgeContext: (chunks) => chunks.map((item) => item.text).join("\n\n"),
    });

    const result = await contextTools.buildContextBlocks(
      {
        promptConfig: { globalSystemPrompt: "Global prompt", storySystemPrompt: "Story prompt" },
        settings: { contextBlocks: 3 },
      },
      [{ role: "user", content: "What lets Mira cross the red bridge, and describe it in the established style?" }],
      [],
      {
        characters: [{ id: "mira", name: "Mira", core: { role: "Scout" } }],
        worldbooks: [{ id: "city", title: "Nocturne City", category: "city", rules: ["The red bridge only opens during the toll bell."] }],
        styles: [{ id: "velvet", name: "Velvet Gothic", tone: "lush", voice: "close third" }],
      },
      {
        currentUserInput: "What lets Mira cross the red bridge, and describe it in the established style?",
        embeddingOptions: { mode: "off" },
      }
    );

    assert.ok(result.retrievalFusionMeta);
    assert.equal(result.retrievalFusionMeta.totalBudget, 7);
    assert.equal(result.retrievalFusionMeta.totalSelectedCount, 7);
    assert.ok(result.selectedKnowledgeChunks.length < 6);
    assert.ok(result.selectedMemoryRecords.length + result.selectedMemoryEvidence.length < 6);
    assert.ok(result.retrievalFusionMeta.selectedCounts.knowledge >= 3);
    assert.ok((result.retrievalFusionMeta.topSources || []).length > 0);
    assert.ok(result.blocks.some((item) => item.label === "knowledge:retrieved"));
  });

  await runTest("context tools include retrieved memory evidence in memory rag mode", async () => {
    const contextTools = createContextTools({
      DEFAULT_CONTEXT_BLOCKS,
      estimateTokens: (value) => Math.max(1, Math.ceil(String(value || "").length / 4)),
      selectRelevantMemoryRecords: () => ({
        selectedRecords: [
          {
            id: "mem_truth",
            tier: "long_term",
            kind: "plot_checkpoint",
            summary: "The archive opens for Lyra's bloodline.",
            importance: "high",
            scope: "plot",
            subjectIds: ["lyra"],
            tags: ["archive", "bloodline"],
          },
        ],
        reasonsById: {
          mem_truth: ["Matched keywords: archive, bloodline"],
        },
        selectedEvidenceChunks: [
          {
            id: "chunk_truth",
            text: "Lyra presses her bloodline key into the seal and the archive opens.",
            sourceRole: "assistant",
            scope: "plot",
            subjectIds: ["lyra"],
            tags: ["archive", "bloodline"],
          },
        ],
        selectedEvidenceReasons: {
          chunk_truth: ["Linked to a selected memory fact", "vector similarity (test-local)"],
        },
        retrievalMeta: {
          mode: "rag",
          activeMode: "rag",
          vectorEnabled: true,
          vectorCandidateCount: 1,
          vectorSelectedCount: 1,
          evidenceCandidateCount: 1,
          evidenceSelectedCount: 1,
          fallbackReason: "",
        },
      }),
      formatMemoryContext: (records) => records.map((item) => item.summary).join("\n"),
      getProviderContextWindow: () => 2000,
      buildQueryEmbedding: async () => [1, 0],
      retrieveKnowledgeChunks: async () => ({
        selectedChunks: [],
        retrievalMeta: {
          mode: "rag",
          activeMode: "lexical",
          vectorEnabled: false,
          vectorCandidateCount: 0,
          vectorSelectedCount: 0,
          chunkCount: 0,
        },
      }),
      formatKnowledgeContext: () => "",
    });

    const result = await contextTools.buildContextBlocks(
      {
        promptConfig: { globalSystemPrompt: "Global prompt", storySystemPrompt: "Story prompt" },
        settings: { contextBlocks: 3 },
      },
      [],
      [],
      { characters: [], worldbooks: [], styles: [] },
      {
        currentUserInput: "How does Lyra open the archive?",
        embeddingOptions: { mode: "on" },
      }
    );

    const evidenceBlock = result.blocks.find((item) => item.label === "memory:evidence");
    const groundingBlock = result.blocks.find((item) => item.label === "memory:grounding");
    const retrievalPolicyBlock = result.blocks.find((item) => item.label === "system:retrieval_policy");
    assert.ok(evidenceBlock?.content.includes("Lyra presses her bloodline key"));
    assert.ok(groundingBlock?.content.includes("Memory grounding rules:"));
    assert.ok(groundingBlock?.content.includes("Selected memory facts: 1"));
    assert.ok(groundingBlock?.content.includes("Retrieved evidence chunks: 1"));
    assert.ok(groundingBlock?.content.includes("Contested candidates: 0."));
    assert.ok(retrievalPolicyBlock?.content.includes("Grounding policy for this response:"));
    assert.equal(result.memoryRetrievalMeta.mode, "rag");
    assert.equal(result.memoryRetrievalMeta.evidenceSelectedCount, 1);
  });

  await runTest("context tools keep long-term, critical, and recent memory blocks disjoint", async () => {
    const contextTools = createContextTools({
      DEFAULT_CONTEXT_BLOCKS,
      estimateTokens: (value) => Math.max(1, Math.ceil(String(value || "").length / 4)),
      selectRelevantMemoryRecords: () => ({
        selectedRecords: [
          {
            id: "mem_long",
            tier: "long_term",
            kind: "plot_checkpoint",
            summary: "Long-term canon anchor.",
            importance: "high",
            stability: "stable",
            scope: "plot",
          },
          {
            id: "mem_critical",
            tier: "short_term",
            kind: "plot_checkpoint",
            summary: "Critical short-term development.",
            importance: "high",
            scope: "plot",
          },
          {
            id: "mem_recent",
            tier: "short_term",
            kind: "plot_checkpoint",
            summary: "Recent low-priority detail.",
            importance: "low",
            scope: "plot",
          },
        ],
        reasonsById: {
          mem_long: ["Matched keywords: canon"],
          mem_critical: ["Matched keywords: development"],
          mem_recent: ["Matched keywords: detail"],
        },
        selectedEvidenceChunks: [],
        selectedEvidenceReasons: {},
        contestedRecords: [],
        contestedReasonsById: {},
        retrievalMeta: {
          mode: "rag",
          activeMode: "lexical",
          vectorEnabled: false,
          vectorCandidateCount: 0,
          vectorSelectedCount: 0,
          evidenceCandidateCount: 0,
          evidenceSelectedCount: 0,
          contestedCandidateCount: 0,
          fallbackReason: "",
        },
      }),
      formatMemoryContext: (records) => records.map((item) => item.summary).join("\n"),
      getProviderContextWindow: () => 2000,
      buildQueryEmbedding: async () => [1, 0],
      retrieveKnowledgeChunks: async () => ({
        selectedChunks: [],
        retrievalMeta: {
          mode: "rag",
          activeMode: "lexical",
          vectorEnabled: false,
          vectorCandidateCount: 0,
          vectorSelectedCount: 0,
          chunkCount: 0,
        },
      }),
      formatKnowledgeContext: () => "",
    });

    const result = await contextTools.buildContextBlocks(
      {
        promptConfig: { globalSystemPrompt: "Global prompt", storySystemPrompt: "Story prompt" },
        settings: { contextBlocks: 3 },
      },
      [],
      [],
      { characters: [], worldbooks: [], styles: [] },
      {
        currentUserInput: "What canon matters now?",
        embeddingOptions: { mode: "off" },
      }
    );

    assert.deepEqual(result.selectedMemoryGroups.longTerm.map((item) => item.id), ["mem_long"]);
    assert.deepEqual(result.selectedMemoryGroups.critical.map((item) => item.id), ["mem_critical"]);
    assert.deepEqual(result.selectedMemoryGroups.recent.map((item) => item.id), ["mem_recent"]);
    const longTermBlock = result.blocks.find((item) => item.label === "memory:long_term");
    const criticalBlock = result.blocks.find((item) => item.label === "memory:critical");
    const recentBlock = result.blocks.find((item) => item.label === "memory:recent");
    assert.ok(longTermBlock?.content.includes("Long-term canon anchor."));
    assert.ok(!criticalBlock?.content.includes("Long-term canon anchor."));
    assert.ok(!recentBlock?.content.includes("Long-term canon anchor."));
    assert.ok(criticalBlock?.content.includes("Critical short-term development."));
    assert.ok(!recentBlock?.content.includes("Critical short-term development."));
  });

  await runTest("context tools expose contested memory candidates in a separate uncertainty block", async () => {
    const contextTools = createContextTools({
      DEFAULT_CONTEXT_BLOCKS,
      estimateTokens: (value) => Math.max(1, Math.ceil(String(value || "").length / 4)),
      selectRelevantMemoryRecords: () => ({
        selectedRecords: [
          {
            id: "mem_truth",
            tier: "long_term",
            kind: "plot_checkpoint",
            summary: "Lyra's bloodline key opens the archive.",
            importance: "high",
            scope: "plot",
            subjectIds: ["lyra"],
            tags: ["archive", "bloodline"],
          },
        ],
        reasonsById: {
          mem_truth: ["Matched keywords: archive, bloodline"],
        },
        contestedRecords: [
          {
            id: "mem_alt",
            tier: "short_term",
            kind: "plot_checkpoint",
            summary: "A mirror sigil may also trigger the archive seal.",
            importance: "medium",
            scope: "plot",
            subjectIds: ["lyra"],
            tags: ["archive", "sigil"],
            confidence: 0.58,
          },
        ],
        contestedReasonsById: {
          mem_alt: ["Competes with a selected memory fact in the same canon slot"],
        },
        selectedEvidenceChunks: [],
        selectedEvidenceReasons: {},
        retrievalMeta: {
          mode: "rag",
          activeMode: "lexical",
          vectorEnabled: false,
          vectorCandidateCount: 0,
          vectorSelectedCount: 0,
          evidenceCandidateCount: 0,
          evidenceSelectedCount: 0,
          contestedCandidateCount: 1,
          fallbackReason: "",
        },
      }),
      formatMemoryContext: (records) => records.map((item) => item.summary).join("\n"),
      getProviderContextWindow: () => 2000,
      buildQueryEmbedding: async () => [1, 0],
      retrieveKnowledgeChunks: async () => ({
        selectedChunks: [],
        retrievalMeta: {
          mode: "rag",
          activeMode: "lexical",
          vectorEnabled: false,
          vectorCandidateCount: 0,
          vectorSelectedCount: 0,
          chunkCount: 0,
        },
      }),
      formatKnowledgeContext: () => "",
    });

    const result = await contextTools.buildContextBlocks(
      {
        promptConfig: { globalSystemPrompt: "Global prompt", storySystemPrompt: "Story prompt" },
        settings: { contextBlocks: 3 },
      },
      [],
      [],
      { characters: [], worldbooks: [], styles: [] },
      {
        currentUserInput: "How does the archive open now?",
        embeddingOptions: { mode: "off" },
      }
    );

    const uncertaintyBlock = result.blocks.find((item) => item.label === "memory:uncertainty");
    const retrievalPolicyBlock = result.blocks.find((item) => item.label === "system:retrieval_policy");
    assert.ok(uncertaintyBlock?.content.includes("[Contested memory 1]"));
    assert.ok(uncertaintyBlock?.content.includes("Competes with a selected memory fact in the same canon slot"));
    assert.ok(retrievalPolicyBlock?.content.includes("If contested memory candidates remain unresolved"));
    assert.equal(result.memoryRetrievalMeta.contestedCandidateCount, 1);
  });

  await runTest("memory query builder extracts retrieval focus cues for rag recall", () => {
    const query = buildMemoryQuery({
      userMessage: "How does Lyra open the archive now?",
      messages: [
        { role: "assistant", content: "Lyra's bloodline key is the only thing that breaks the seal." },
        { role: "user", content: "Does the key still matter after the reveal?" },
      ],
      workspace: {
        characters: [{ id: "lyra", name: "Lyra", core: { role: "Heir" }, traits: ["bloodline"] }],
        worldbooks: [{ id: "archive", title: "Archive", category: "vault", rules: ["Only bloodline keys can open it"] }],
        styles: [],
      },
    });

    assert.ok(query.focusClauses.length > 0);
    assert.ok(query.keywords.includes("archive"));
    assert.ok(query.matchedEntityIds.includes("lyra"));
    assert.ok(query.embeddingText.includes("Current ask:"));
    assert.ok(query.embeddingText.includes("Focus cues:"));
  });

  await runTest("grounding check flags unsupported and contested answer clauses", () => {
    const { evaluateAssistantGrounding } = createGroundingCheckTools({ summarizeText });
    const result = evaluateAssistantGrounding({
      assistantText:
        "Lyra opens the archive with her bloodline key. The mirror sigil still controls the seal. A hidden choir descends from the ceiling.",
      selectedKnowledgeChunks: [
        {
          text: "The archive opens only for Lyra's bloodline key.",
        },
      ],
      selectedMemoryRecords: [
        {
          summary: "Lyra's bloodline key is the true trigger for the archive seal.",
          subjectIds: ["lyra"],
          tags: ["archive", "bloodline", "key"],
        },
      ],
      selectedMemoryEvidence: [
        {
          text: "assistant: Lyra presses the bloodline key into the seal and the archive answers immediately.",
          subjectIds: ["lyra"],
          tags: ["archive", "bloodline", "key"],
        },
      ],
      contestedMemoryRecords: [
        {
          summary: "A mirror sigil may also trigger the archive seal.",
          subjectIds: ["lyra"],
          tags: ["archive", "sigil"],
        },
      ],
    });

    assert.equal(result.state, "caution");
    assert.ok(result.supportedClauseCount >= 1);
    assert.ok(result.contestedClauseCount >= 1);
    assert.ok(result.unsupportedClauseCount >= 1);
    assert.ok(result.supportedClauses[0]?.supportRefs?.length >= 1);
    assert.equal(result.supportedClauses[0]?.supportRefs?.[0]?.sourceType, "knowledge");
    assert.ok(result.contestedClauses[0]?.supportRefs?.some((item) => item.sourceType === "memory_fact"));
    assert.equal(result.contestedClauses[0]?.contestedSupportRefs?.[0]?.sourceType, "contested_memory");
    assert.ok(result.notes.some((item) => /under-grounded|contested/i.test(item)));
  });

  await runTest("grounding check accepts atmospheric clauses when retrieved evidence closely matches them", () => {
    const { evaluateAssistantGrounding } = createGroundingCheckTools({ summarizeText });
    const result = evaluateAssistantGrounding({
      assistantText:
        "晨光透过素色纱帘，落在白舟渡的眼睑上。她在萧令仪洞府的玉榻上醒来。",
      selectedKnowledgeChunks: [
        {
          text: "Character: 萧令仪\nTraits: 萧令仪习惯用规则和礼节照顾身边的人。",
        },
      ],
      selectedMemoryRecords: [],
      selectedMemoryEvidence: [
        {
          text:
            "assistant: 晨光透过洞府门口垂下的素色纱帘，落在白舟渡的眼睑上。她在萧令仪洞府的玉榻上醒来，意识缓慢上浮。",
          subjectIds: ["xiao"],
        },
      ],
      contestedMemoryRecords: [],
    });

    assert.ok(result.supportedClauseCount >= 1);
    assert.equal(result.unsupportedClauseCount, 0);
    assert.ok(
      result.supportedClauses.some((item) =>
        (item.reasons || []).some((reason) => /Atmospheric clause stayed close|close text overlap/i.test(String(reason)))
      )
    );
  });

  await runTest("memory tools compute schedules and create a non-transcript fallback summary", async () => {
    const memoryTools = buildMemoryTools();
    const story = {
      settings: { summaryInterval: 3 },
      providerId: "",
      model: "",
    };
    const fullMessages = [
      { role: "user", content: "Continue the story." },
      { role: "assistant", content: "Mira reveals she once mentored Ava, and their alliance begins to recover." },
      { role: "user", content: "What changes next?" },
      { role: "assistant", content: "Ava accepts the truth and the two decide to protect the archive together." },
    ];

    const schedule = memoryTools.getSummarySchedule(story, fullMessages);
    const update = await memoryTools.generateMemoryUpdate({
      story,
      fullMessages,
      memoryRecords: [],
      workspace: { characters: [], worldbooks: [], styles: [] },
      summaryTriggers: ["Manual smoke trigger"],
    });

    assert.equal(schedule.configuredRounds, 3);
    assert.equal(schedule.intervalMessages, 6);
    assert.equal(schedule.currentMessageCount, 4);
    assert.equal(update.summaryRecords.length, 1);
    assert.ok(update.summaryRecords[0].summary);
    assert.ok(!update.summaryRecords[0].summary.includes("user:"));
    assert.ok(!update.summaryRecords[0].summary.includes("assistant:"));
    assert.deepEqual(update.summaryRecords[0].triggeredBy, ["Manual smoke trigger"]);
  });

  await runTest("memory tools index episodic chunks even when no summary trigger fires", async () => {
    const memoryTools = buildMemoryTools();
    const story = {
      settings: { summaryInterval: 3 },
      providerId: "",
      model: "",
    };
    const fullMessages = [
      { role: "user", content: "How does Lyra prove the archive recognized her?" },
      {
        role: "assistant",
        content:
          "Lyra presses the bloodline key into the seal, the archive answers at once, and the chamber wakes around her.",
      },
    ];

    const update = await memoryTools.generateMemoryUpdate({
      story,
      fullMessages,
      memoryRecords: [],
      memoryChunks: [],
      workspace: { characters: [], worldbooks: [], styles: [] },
      summaryTriggers: [],
    });

    assert.equal(update.summaryRecords.length, 0);
    assert.ok(update.episodicChunks.length > 0);
    assert.ok(update.episodicChunks.every((item) => item.type === "memory_episode"));
    assert.ok(update.episodicChunks.every((item) => !item.linkedRecordId));
    assert.ok(update.episodicChunks.every((item) => !item.canonKey && !item.conflictGroup));
    assert.ok(update.episodicChunks.every((item) => item.kind === "plot_checkpoint"));
    assert.ok(update.episodicChunks.every((item) => item.stability === "volatile"));
    assert.ok(update.episodicChunks.every((item) => Array.isArray(item.entities) && item.entities.length === 0));
    assert.ok(update.episodicChunks.every((item) => Array.isArray(item.tags) && item.tags.length === 0));
    assert.ok(update.chunks.length >= update.episodicChunks.length);
  });

  await runTest("memory tools avoid near-duplicate episodic chunks from the same source range", async () => {
    const memoryTools = buildMemoryTools();
    const story = {
      settings: { summaryInterval: 3 },
      providerId: "",
      model: "",
    };
    const fullMessages = [
      { role: "user", content: "从大师姐的洞府醒来，昨晚白白和大师姐探讨修改探讨了很久。" },
      {
        role: "assistant",
        content:
          "从大师姐的洞府醒来，昨晚白白和大师姐探讨修改探讨了很久。晨光透过素色纱帘，落在白舟渡眼睑上。",
      },
    ];

    const update = await memoryTools.generateMemoryUpdate({
      story,
      fullMessages,
      memoryRecords: [],
      memoryChunks: [],
      workspace: { characters: [], worldbooks: [], styles: [] },
      summaryTriggers: [],
    });

    const firstTurnChunks = update.episodicChunks.filter(
      (item) => Array.isArray(item.sourceMessageRange) && item.sourceMessageRange.join("-") === "1-1"
    );
    assert.ok(firstTurnChunks.length <= 1);
  });

  await runTest("memory tools write windowed evidence chunks with tighter source ranges", async () => {
    const memoryTools = buildMemoryTools();
    const story = {
      settings: { summaryInterval: 3 },
      providerId: "",
      model: "",
    };
    const fullMessages = [
      { role: "user", content: "How does Lyra finally open the archive seal?" },
      {
        role: "assistant",
        content:
          "Lyra presses the bloodline key into the seal, the archive answers at once, and the chamber wakes around her.",
      },
      { role: "user", content: "What confirms the key mattered?" },
      {
        role: "assistant",
        content: "The seal only reacts once the key turns, proving the bloodline mechanism was real all along.",
      },
    ];

    const update = await memoryTools.generateMemoryUpdate({
      story,
      fullMessages,
      memoryRecords: [],
      workspace: { characters: [], worldbooks: [], styles: [] },
      summaryTriggers: ["Manual smoke trigger"],
    });

    assert.ok(update.summaryChunks.length > 0);
    assert.ok(update.summaryChunks.some((item) => Array.isArray(item.sourceMessageRange) && item.sourceMessageRange.length === 2));
    assert.ok(update.summaryChunks.some((item) => item.sourceRole === "mixed" || item.text.includes("assistant:")));
    assert.ok(update.summaryChunks.every((item) => item.sourceMessageRange[0] >= 1));
    assert.ok(update.summaryChunks.every((item) => item.sourceMessageRange[1] <= fullMessages.length));
  });

  await runTest("memory tools assign canon keys and conflict groups to new facts and evidence", async () => {
    const memoryTools = buildMemoryTools();
    const story = {
      settings: { summaryInterval: 3 },
      providerId: "",
      model: "",
    };
    const fullMessages = [
      { role: "user", content: "How does Lyra finally open the archive seal?" },
      {
        role: "assistant",
        content:
          "Lyra presses the bloodline key into the seal, the archive answers at once, and everyone realizes her lineage is the key.",
      },
    ];

    const update = await memoryTools.generateMemoryUpdate({
      story,
      fullMessages,
      memoryRecords: [],
      workspace: {
        characters: [{ id: "lyra", name: "Lyra", core: { role: "Heir" }, traits: ["bloodline"] }],
        worldbooks: [{ id: "archive", title: "Archive", category: "vault", rules: ["Only the bloodline key works"] }],
        styles: [],
      },
      summaryTriggers: ["Manual smoke trigger"],
    });

    assert.equal(update.summaryRecords.length, 1);
    assert.ok(update.summaryRecords[0].conflictGroup);
    assert.ok(update.summaryRecords[0].canonKey);
    assert.ok(update.summaryChunks.length > 0);
    assert.equal(update.summaryChunks[0].conflictGroup, update.summaryRecords[0].conflictGroup);
    assert.equal(update.summaryChunks[0].canonKey, update.summaryRecords[0].canonKey);
  });

  await runTest("memory consolidation carries canon keys and conflict groups into long-term records", () => {
    const now = "2026-03-25T00:00:00.000Z";
    const result = consolidateMemoryRecords(
      [
        {
          id: "mem_rel_1",
          tier: "short_term",
          kind: "relationship_update",
          scope: "relationship",
          summary: "Lyra and Mira reconcile after the archive breach.",
          subjectIds: ["lyra"],
          objectIds: ["mira"],
          entities: ["Lyra", "Mira"],
          tags: ["reconcile", "archive"],
          keywords: ["lyra", "mira", "reconcile", "archive"],
          importance: "high",
          confidence: 0.88,
          createdAt: "2026-03-24T00:00:00.000Z",
        },
        {
          id: "mem_rel_2",
          tier: "short_term",
          kind: "relationship_update",
          scope: "relationship",
          summary: "Lyra trusts Mira again as they protect the archive together.",
          subjectIds: ["lyra"],
          objectIds: ["mira"],
          entities: ["Lyra", "Mira"],
          tags: ["trust", "archive"],
          keywords: ["lyra", "mira", "trust", "archive"],
          importance: "high",
          confidence: 0.86,
          createdAt: "2026-03-24T00:02:00.000Z",
        },
      ],
      {
        now,
        makeId: safeId,
        shortTermThreshold: 2,
      }
    );

    assert.equal(result.addedRecords.length, 1);
    assert.equal(result.addedRecords[0].tier, "long_term");
    assert.ok(result.addedRecords[0].conflictGroup);
    assert.ok(result.addedRecords[0].canonKey);
  });

  await runTest("embedding config normalizes custom mirror hosts", () => {
    assert.equal(normalizeEmbeddingRemoteHost("https://hf-mirror.com"), "https://hf-mirror.com/");
    assert.equal(normalizeEmbeddingConfig({ remoteHost: "https://hf-mirror.com" }).remoteHost, "https://hf-mirror.com/");
    assert.equal(normalizeEmbeddingConfig({ remoteHost: "not-a-url" }).remoteHost, "https://huggingface.co/");
  });

  await runTest("memory tools store the actual fallback embedding provider when neural embedding fails", async () => {
    const { buildMemoryEmbeddingText } = createEmbeddingTools();
    const memoryTools = createMemoryTools({
      DEFAULT_SUMMARY_INTERVAL,
      MEMORY_SUMMARY_CHAR_LIMIT: 160,
      classifyPressure: (usedTokens, maxTokens) => {
        const ratio = maxTokens ? usedTokens / maxTokens : 0;
        if (ratio >= 0.82) {
          return "high";
        }
        if (ratio >= 0.6) {
          return "medium";
        }
        return "low";
      },
      summarizeText,
      safeId,
      getProviderForStory: () => null,
      decryptSecret: () => "",
      callOpenAICompatible: async () => {
        throw new Error("Provider should not be called in smoke tests");
      },
      tryParseJsonObject: (value) => {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      },
      embedTextDetailed: async () => ({
        vector: [0.6, 0.8],
        provider: "hash_v1",
        model: "hash_v1",
        requestedProvider: "transformers_local",
        requestedModel: "Xenova/all-MiniLM-L6-v2",
        fallbackUsed: true,
        error: "fetch failed",
      }),
      buildMemoryEmbeddingText,
      resolveEmbeddingOptions: () => ({
        mode: "on",
        provider: "transformers_local",
        model: "Xenova/all-MiniLM-L6-v2",
        dimensions: 384,
        allowFallback: true,
      }),
    });

    const update = await memoryTools.generateMemoryUpdate({
      story: {
        settings: { summaryInterval: 3 },
        providerId: "",
        model: "",
      },
      fullMessages: [
        { role: "user", content: "Continue the story." },
        { role: "assistant", content: "Lyra opens the submerged archive with her bloodline key." },
      ],
      memoryRecords: [],
      workspace: { characters: [], worldbooks: [], styles: [] },
      summaryTriggers: ["Manual smoke trigger"],
    });

    assert.equal(update.summaryRecords.length, 1);
    assert.deepEqual(update.summaryRecords[0].embedding, [0.6, 0.8]);
    assert.equal(update.summaryRecords[0].embeddingProvider, "hash_v1");
    assert.equal(update.summaryRecords[0].embeddingModel, "hash_v1");
    assert.equal(update.summaryRecords[0].embeddingRequestedProvider, "transformers_local");
    assert.equal(update.summaryRecords[0].embeddingFallbackUsed, true);
    assert.ok(update.summaryChunks.length > 0);
    assert.equal(update.summaryChunks[0].embeddingProvider, "hash_v1");
  });

  await runTest("server config prewarm fails when neural embeddings do not return a usable vector", async () => {
    const rootDir = createTempRoot();
    try {
      const appConfigFile = path.join(rootDir, "app.json");
      fs.writeFileSync(
        appConfigFile,
        JSON.stringify(
          {
            theme: "dark",
            localEmbedding: {
              mode: "on",
              provider: "transformers_local",
              model: "Xenova/all-MiniLM-L6-v2",
              dimensions: 384,
              cacheDir: path.join(rootDir, ".cache", "transformers"),
              remoteHost: "https://hf-mirror.com",
              allowFallback: true,
            },
          },
          null,
          2
        ),
        "utf8"
      );
      const serverConfigTools = createServerConfigTools({
        readJson: (filePath, fallback = {}) => {
          try {
            return JSON.parse(fs.readFileSync(filePath, "utf8"));
          } catch {
            return fallback;
          }
        },
        getAppConfigFile: () => appConfigFile,
        normalizeEmbeddingConfig,
        normalizeEmbeddingMode,
        embedText: async () => null,
        embedTextDetailed: async () => ({
          vector: null,
          provider: "transformers_local",
          model: "Xenova/all-MiniLM-L6-v2",
          requestedProvider: "transformers_local",
          requestedModel: "Xenova/all-MiniLM-L6-v2",
          fallbackUsed: false,
          error: "fetch failed",
        }),
        DEFAULT_GLOBAL_SYSTEM_PROMPT: "Global prompt",
      });

      const result = await serverConfigTools.prewarmLocalEmbeddingModel(serverConfigTools.getAppConfig());
      assert.equal(result.ok, false);
      assert.equal(result.warmed, false);
      assert.match(result.message, /fetch failed/);
      assert.equal(result.activeProvider, "transformers_local");
      assert.equal(result.runtime.remoteHost, "https://hf-mirror.com/");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  await runTest("server config drops legacy retrieval mode fields while keeping rag defaults internal", async () => {
    const rootDir = createTempRoot();
    try {
      const appConfigFile = path.join(rootDir, "app.json");
      fs.writeFileSync(
        appConfigFile,
        JSON.stringify(
          {
            theme: "dark",
            memoryRetrievalMode: "lexical",
            knowledgeRetrievalMode: "lexical",
            localEmbedding: {
              mode: "off",
              provider: "transformers_local",
              model: "Xenova/all-MiniLM-L6-v2",
              dimensions: 384,
            },
          },
          null,
          2
        ),
        "utf8"
      );
      const serverConfigTools = createServerConfigTools({
        readJson: (filePath, fallback = {}) => {
          try {
            return JSON.parse(fs.readFileSync(filePath, "utf8"));
          } catch {
            return fallback;
          }
        },
        getAppConfigFile: () => appConfigFile,
        normalizeEmbeddingConfig,
        normalizeEmbeddingMode,
        embedText: async () => null,
        embedTextDetailed: async () => null,
        DEFAULT_GLOBAL_SYSTEM_PROMPT: "Global prompt",
      });

      const appConfig = serverConfigTools.getAppConfig();
      const nextSettings = serverConfigTools.buildNextStorySettings(
        {
          settings: {
            memoryRetrievalMode: "lexical",
            knowledgeRetrievalMode: "lexical",
            localEmbeddingMode: "inherit",
          },
        },
        {
          knowledgeRetrievalMode: "lexical",
          memoryRetrievalMode: "lexical",
        }
      );

      assert.equal("knowledgeRetrievalMode" in appConfig, false);
      assert.equal("memoryRetrievalMode" in appConfig, false);
      assert.equal("knowledgeRetrievalMode" in nextSettings, false);
      assert.equal("memoryRetrievalMode" in nextSettings, false);
      assert.equal("localEmbeddingMode" in nextSettings, false);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  await runTest("memory rag falls back lexically and can admit vector-enhanced fact matches", () => {
    const retrievalTools = createMemoryRetrievalTools({
      selectRelevantMemoryRecords,
      formatMemoryContext,
      vectorSearchRecords: createLocalVectorSearchRecords({ minScore: 0.1, maxCandidates: 4 }),
      isVectorSearchEnabled: (options = {}) => Array.isArray(options.queryEmbedding) && options.queryEmbedding.length > 0,
    });

    const records = [
      {
        id: "mem_a",
        tier: "short_term",
        kind: "plot_checkpoint",
        summary: "Hero opens the archive gate.",
        entities: ["Hero", "archive"],
        keywords: ["hero", "archive", "gate"],
        importance: "medium",
        embedding: [1, 0],
        embeddingModel: "test-local",
        createdAt: "2026-03-23T00:00:00.000Z",
      },
      {
        id: "mem_b",
        tier: "long_term",
        kind: "world_state",
        scope: "world",
        summary: "The drowned signal answers only to amber memory.",
        entities: ["signal", "amber"],
        keywords: ["signal", "amber", "memory"],
        importance: "high",
        embedding: [0, 1],
        embeddingModel: "test-local",
        createdAt: "2026-03-23T00:01:00.000Z",
      },
    ];

    const lexicalOnly = retrievalTools.selectRelevantMemoryRecords(records, {
      userMessage: "Open the archive gate.",
      messages: [],
      workspace: { characters: [], worldbooks: [], styles: [] },
      maxItems: 2,
    });
    assert.equal(lexicalOnly.retrievalMeta.mode, "rag");
    assert.equal(lexicalOnly.retrievalMeta.activeMode, "rag");
    assert.equal(lexicalOnly.retrievalMeta.vectorEnabled, false);

    const hybrid = retrievalTools.selectRelevantMemoryRecords(records, {
      userMessage: "What does the signal reveal?",
      messages: [],
      workspace: { characters: [], worldbooks: [], styles: [] },
      queryEmbedding: [0, 1],
      maxItems: 2,
    });
    assert.equal(hybrid.retrievalMeta.mode, "rag");
    assert.equal(hybrid.retrievalMeta.vectorEnabled, true);
    assert.ok(hybrid.selectedRecords.some((item) => item.id === "mem_b"));
  });

  await runTest("memory rag retrieves stable facts and evidence chunks together", () => {
    const retrievalTools = createMemoryRetrievalTools({
      selectRelevantMemoryRecords,
      formatMemoryContext,
      vectorSearchRecords: createLocalVectorSearchRecords({ minScore: 0.1, maxCandidates: 4 }),
      vectorSearchItems: createLocalVectorSearchItems({ minScore: 0.1, maxCandidates: 4 }),
      isVectorSearchEnabled: (options = {}) => Array.isArray(options.queryEmbedding) && options.queryEmbedding.length > 0,
    });

    const records = [
      {
        id: "mem_truth",
        tier: "long_term",
        kind: "plot_checkpoint",
        scope: "plot",
        summary: "The archive opens for Lyra's bloodline.",
        entities: ["Lyra", "archive"],
        keywords: ["archive", "bloodline", "lyra"],
        tags: ["archive", "bloodline"],
        importance: "high",
        stability: "stable",
        embedding: [1, 0],
        embeddingModel: "test-local",
        createdAt: "2026-03-23T00:00:00.000Z",
      },
    ];
    const chunks = [
      {
        id: "chunk_truth",
        linkedRecordId: "mem_truth",
        text: "Lyra presses her bloodline key into the seal and the archive opens.",
        sourceRole: "assistant",
        scope: "plot",
        subjectIds: ["lyra"],
        entities: ["Lyra", "archive"],
        keywords: ["bloodline", "archive", "opens"],
        tags: ["archive", "bloodline"],
        importance: "high",
        stability: "stable",
        embedding: [1, 0],
        embeddingModel: "test-local",
        createdAt: "2026-03-23T00:00:30.000Z",
      },
    ];

    const result = retrievalTools.selectRelevantMemoryRecords(records, {
      userMessage: "How does Lyra open the archive?",
      messages: [],
      workspace: { characters: [], worldbooks: [], styles: [] },
      memoryChunks: chunks,
      queryEmbedding: [1, 0],
      maxItems: 2,
      maxEvidenceItems: 2,
    });

    assert.equal(result.retrievalMeta.mode, "rag");
    assert.equal(result.retrievalMeta.activeMode, "rag");
    assert.ok(result.selectedRecords.some((item) => item.id === "mem_truth"));
    assert.ok(result.selectedEvidenceChunks.some((item) => item.id === "chunk_truth"));
    assert.equal(result.retrievalMeta.evidenceSelectedCount, 1);
  });

  await runTest("memory rag can promote evidence-backed facts into the final fact set", () => {
    const retrievalTools = createMemoryRetrievalTools({
      selectRelevantMemoryRecords,
      formatMemoryContext,
      vectorSearchItems: createLocalVectorSearchItems({ minScore: 0.1, maxCandidates: 6 }),
      isVectorSearchEnabled: (options = {}) => Array.isArray(options.queryEmbedding) && options.queryEmbedding.length > 0,
    });

    const records = [
      {
        id: "mem_archive",
        tier: "short_term",
        kind: "plot_checkpoint",
        scope: "plot",
        summary: "Lyra opened the archive seal.",
        entities: ["Lyra", "archive"],
        keywords: ["lyra", "archive", "seal"],
        tags: ["archive"],
        importance: "medium",
        confidence: 0.62,
        createdAt: "2026-03-23T00:00:00.000Z",
      },
      {
        id: "mem_mirror",
        tier: "short_term",
        kind: "world_state",
        scope: "world",
        summary: "The mirror court is still asleep.",
        entities: ["mirror court"],
        keywords: ["mirror", "court", "asleep"],
        tags: ["mirror"],
        importance: "medium",
        confidence: 0.58,
        createdAt: "2026-03-23T00:01:00.000Z",
      },
      {
        id: "mem_key",
        tier: "long_term",
        kind: "plot_checkpoint",
        scope: "plot",
        summary: "Lyra's bloodline key is the true trigger for the archive seal.",
        entities: ["Lyra", "archive"],
        keywords: ["lyra", "bloodline", "key", "archive", "seal"],
        tags: ["archive", "bloodline", "key"],
        importance: "high",
        stability: "stable",
        confidence: 0.91,
        createdAt: "2026-03-23T00:02:00.000Z",
      },
    ];
    const chunks = [
      {
        id: "chunk_key",
        linkedRecordId: "mem_key",
        text: "assistant: Lyra presses the bloodline key into the archive seal and the gate answers immediately.",
        sourceRole: "mixed",
        scope: "plot",
        entities: ["Lyra", "archive"],
        subjectIds: ["lyra"],
        keywords: ["lyra", "bloodline", "key", "archive", "seal"],
        tags: ["archive", "bloodline", "key"],
        importance: "high",
        stability: "stable",
        confidence: 0.93,
        embedding: [1, 0],
        embeddingModel: "test-local",
        createdAt: "2026-03-23T00:02:30.000Z",
      },
    ];

    const result = retrievalTools.selectRelevantMemoryRecords(records, {
      userMessage: "Why did the archive answer Lyra at all?",
      messages: [],
      workspace: { characters: [], worldbooks: [], styles: [] },
      memoryChunks: chunks,
      queryEmbedding: [1, 0],
      maxItems: 2,
      maxEvidenceItems: 1,
    });

    assert.ok(result.selectedEvidenceChunks.some((item) => item.id === "chunk_key"));
    assert.ok(result.selectedRecords.some((item) => item.id === "mem_key"));
    assert.ok(result.reasonsById.mem_key.includes("Supported by retrieved memory evidence"));
  });

  await runTest("memory rag keeps nearby conflicting facts visible as contested candidates", () => {
    const retrievalTools = createMemoryRetrievalTools({
      selectRelevantMemoryRecords: (memoryRecords, options = {}) => ({
        selectedRecords: (memoryRecords || []).slice(0, Math.max(2, Number(options.maxItems) || 2)),
        reasonsById: Object.fromEntries((memoryRecords || []).map((item) => [item.id, ["Lexical candidate"]]))
      }),
      formatMemoryContext,
      isVectorSearchEnabled: () => false,
    });

    const records = [
      {
        id: "mem_key",
        tier: "long_term",
        kind: "plot_checkpoint",
        scope: "plot",
        summary: "Lyra's bloodline key opens the archive seal.",
        entities: ["Lyra", "archive"],
        keywords: ["lyra", "bloodline", "key", "archive", "seal"],
        tags: ["archive", "bloodline", "key"],
        importance: "high",
        stability: "stable",
        confidence: 0.92,
        createdAt: "2026-03-23T00:02:00.000Z",
      },
      {
        id: "mem_sigil",
        tier: "short_term",
        kind: "plot_checkpoint",
        scope: "plot",
        summary: "A mirror sigil may open the archive seal instead.",
        entities: ["Lyra", "archive"],
        keywords: ["lyra", "mirror", "sigil", "archive", "seal"],
        tags: ["archive", "sigil"],
        importance: "medium",
        confidence: 0.84,
        createdAt: "2026-03-23T00:01:30.000Z",
      },
    ];

    const result = retrievalTools.selectRelevantMemoryRecords(records, {
      userMessage: "Does Lyra's bloodline key or a mirror sigil open the archive seal?",
      messages: [],
      workspace: { characters: [], worldbooks: [], styles: [] },
      maxItems: 1,
      maxEvidenceItems: 0,
    });

    assert.ok(result.selectedRecords.some((item) => item.id === "mem_key"));
    assert.ok(result.contestedRecords.some((item) => item.id === "mem_sigil"));
    assert.ok(result.contestedReasonsById.mem_sigil.includes("Competes with a selected memory fact in the same canon slot"));
    assert.equal(result.retrievalMeta.contestedCandidateCount, 1);
  });

  await runTest("memory rag does not flag complementary same-subject facts as contested by default", () => {
    const retrievalTools = createMemoryRetrievalTools({
      selectRelevantMemoryRecords: (memoryRecords, options = {}) => ({
        selectedRecords: (memoryRecords || []).slice(0, Math.max(2, Number(options.maxItems) || 2)),
        reasonsById: Object.fromEntries((memoryRecords || []).map((item) => [item.id, ["Lexical candidate"]])),
      }),
      formatMemoryContext,
      isVectorSearchEnabled: () => false,
    });

    const records = [
      {
        id: "mem_key",
        tier: "long_term",
        kind: "plot_checkpoint",
        scope: "plot",
        subjectIds: ["lyra"],
        summary: "Lyra's bloodline key opens the archive seal.",
        entities: ["Lyra", "archive"],
        keywords: ["lyra", "bloodline", "key", "archive", "seal"],
        tags: ["archive", "bloodline", "key"],
        importance: "high",
        stability: "stable",
        confidence: 0.92,
        createdAt: "2026-03-23T00:02:00.000Z",
      },
      {
        id: "mem_lineage",
        tier: "short_term",
        kind: "character_update",
        scope: "plot",
        subjectIds: ["lyra"],
        summary: "Lyra learns the archive builders belonged to her family line.",
        entities: ["Lyra", "archive builders"],
        keywords: ["lyra", "family", "lineage", "builders"],
        tags: ["lineage", "family"],
        importance: "medium",
        confidence: 0.81,
        createdAt: "2026-03-23T00:01:30.000Z",
      },
    ];

    const result = retrievalTools.selectRelevantMemoryRecords(records, {
      userMessage: "What does Lyra know about the archive now?",
      messages: [],
      workspace: { characters: [], worldbooks: [], styles: [] },
      maxItems: 1,
      maxEvidenceItems: 0,
    });

    assert.ok(result.selectedRecords.some((item) => item.id === "mem_key"));
    assert.equal(result.contestedRecords.length, 0);
    assert.equal(result.retrievalMeta.contestedCandidateCount, 0);
  });

  await runTest("memory rag diversifies evidence across linked facts when multiple chunks compete", () => {
    const retrievalTools = createMemoryRetrievalTools({
      selectRelevantMemoryRecords,
      formatMemoryContext,
      vectorSearchItems: createLocalVectorSearchItems({ minScore: 0.1, maxCandidates: 6 }),
      isVectorSearchEnabled: () => false,
    });

    const records = [
      {
        id: "mem_key",
        tier: "long_term",
        kind: "plot_checkpoint",
        scope: "plot",
        summary: "Lyra's key opens the archive seal.",
        entities: ["Lyra", "archive"],
        keywords: ["lyra", "key", "archive", "seal"],
        tags: ["archive", "key"],
        importance: "high",
        stability: "stable",
        createdAt: "2026-03-23T00:00:00.000Z",
      },
      {
        id: "mem_song",
        tier: "long_term",
        kind: "plot_checkpoint",
        scope: "plot",
        summary: "The mirror door answers to a hidden song.",
        entities: ["mirror door"],
        keywords: ["mirror", "door", "song"],
        tags: ["mirror", "song"],
        importance: "high",
        stability: "stable",
        createdAt: "2026-03-23T00:01:00.000Z",
      },
    ];
    const chunks = [
      {
        id: "chunk_key_1",
        linkedRecordId: "mem_key",
        text: "Lyra presses the key into the seal and the archive groans open.",
        scope: "plot",
        entities: ["Lyra", "archive"],
        keywords: ["lyra", "key", "archive", "seal"],
        tags: ["archive", "key"],
        importance: "high",
        stability: "stable",
        createdAt: "2026-03-23T00:00:30.000Z",
      },
      {
        id: "chunk_key_2",
        linkedRecordId: "mem_key",
        text: "The seal only yields when Lyra's key turns fully in the lock.",
        scope: "plot",
        entities: ["Lyra", "seal"],
        keywords: ["lyra", "key", "seal", "lock"],
        tags: ["archive", "key"],
        importance: "high",
        stability: "stable",
        createdAt: "2026-03-23T00:00:40.000Z",
      },
      {
        id: "chunk_song",
        linkedRecordId: "mem_song",
        text: "The mirror door opens only after the hidden song is sung aloud.",
        scope: "plot",
        entities: ["mirror door"],
        keywords: ["mirror", "door", "song"],
        tags: ["mirror", "song"],
        importance: "high",
        stability: "stable",
        createdAt: "2026-03-23T00:01:30.000Z",
      },
    ];

    const result = retrievalTools.selectRelevantMemoryRecords(records, {
      userMessage: "How do Lyra's key and the mirror door work together?",
      messages: [],
      workspace: { characters: [], worldbooks: [], styles: [] },
      memoryChunks: chunks,
      maxItems: 2,
      maxEvidenceItems: 2,
    });

    const linkedIds = result.selectedEvidenceChunks.map((item) => item.linkedRecordId);
    assert.ok(linkedIds.includes("mem_key"));
    assert.ok(linkedIds.includes("mem_song"));
  });

  await runTest("memory rag keeps canon and recent fact budgets balanced when both layers are relevant", () => {
    const retrievalTools = createMemoryRetrievalTools({
      selectRelevantMemoryRecords: (memoryRecords) => ({
        selectedRecords: memoryRecords,
        reasonsById: Object.fromEntries((memoryRecords || []).map((item) => [item.id, ["Lexical candidate"]])),
        query: buildMemoryQuery({
          userMessage: "What changed tonight after Lyra opened the archive?",
          messages: [],
          workspace: { characters: [], worldbooks: [], styles: [] },
        }),
      }),
      formatMemoryContext,
      isVectorSearchEnabled: () => false,
    });

    const records = [
      {
        id: "mem_canon_1",
        tier: "long_term",
        kind: "plot_checkpoint",
        scope: "plot",
        summary: "Lyra's bloodline key opens the archive seal.",
        entities: ["Lyra", "archive"],
        keywords: ["lyra", "bloodline", "key", "archive", "seal"],
        tags: ["archive", "key"],
        importance: "high",
        stability: "stable",
        confidence: 0.94,
        createdAt: "2026-03-23T00:00:00.000Z",
      },
      {
        id: "mem_canon_2",
        tier: "long_term",
        kind: "world_state",
        scope: "world",
        summary: "The archive only answers true heirs of the atlas line.",
        entities: ["archive", "atlas line"],
        keywords: ["archive", "heirs", "atlas"],
        tags: ["archive", "heirs"],
        importance: "high",
        stability: "stable",
        confidence: 0.91,
        createdAt: "2026-03-23T00:01:00.000Z",
      },
      {
        id: "mem_recent",
        tier: "short_term",
        kind: "plot_checkpoint",
        scope: "plot",
        summary: "Tonight the opened archive chamber began to tremble around Lyra.",
        entities: ["Lyra", "archive chamber"],
        keywords: ["tonight", "archive", "chamber", "tremble", "lyra"],
        tags: ["archive", "tremble"],
        importance: "medium",
        stability: "volatile",
        confidence: 0.78,
        createdAt: "2026-03-23T00:02:00.000Z",
      },
    ];

    const result = retrievalTools.selectRelevantMemoryRecords(records, {
      userMessage: "What changed tonight after Lyra opened the archive?",
      messages: [],
      workspace: { characters: [], worldbooks: [], styles: [] },
      maxItems: 2,
      maxEvidenceItems: 0,
    });

    assert.equal(result.retrievalMeta.canonicalBudget, 1);
    assert.equal(result.retrievalMeta.recentBudget, 1);
    assert.equal(result.retrievalMeta.canonicalSelectedCount, 1);
    assert.equal(result.retrievalMeta.recentSelectedCount, 1);
    assert.equal(result.retrievalMeta.activeMode, "rag");
    assert.ok(result.selectedRecords.some((item) => item.id === "mem_recent"));
    assert.ok(result.selectedRecords.some((item) => item.id === "mem_canon_1" || item.id === "mem_canon_2"));
  });

  await runTest("memory rag keeps episodic and fact-support evidence on separate budgets", () => {
    const retrievalTools = createMemoryRetrievalTools({
      selectRelevantMemoryRecords,
      formatMemoryContext,
      isVectorSearchEnabled: () => false,
    });

    const records = [
      {
        id: "mem_truth",
        tier: "long_term",
        kind: "plot_checkpoint",
        scope: "plot",
        summary: "Lyra's bloodline key opens the archive seal.",
        entities: ["Lyra", "archive"],
        keywords: ["lyra", "bloodline", "key", "archive", "seal"],
        tags: ["archive", "key"],
        importance: "high",
        stability: "stable",
        confidence: 0.92,
        createdAt: "2026-03-23T00:00:00.000Z",
      },
    ];
    const chunks = [
      {
        id: "chunk_episode",
        type: "memory_episode",
        text: "Lyra steadies herself as the archive chamber trembles around her tonight.",
        sourceRole: "assistant",
        scope: "plot",
        subjectIds: ["lyra"],
        entities: ["Lyra", "archive chamber"],
        keywords: ["lyra", "archive", "chamber", "trembles", "tonight"],
        tags: ["archive", "tremble"],
        importance: "high",
        confidence: 0.82,
        createdAt: "2026-03-23T00:01:00.000Z",
      },
      {
        id: "chunk_support",
        linkedRecordId: "mem_truth",
        text: "Lyra presses the bloodline key into the seal and the archive answers immediately.",
        sourceRole: "assistant",
        scope: "plot",
        subjectIds: ["lyra"],
        entities: ["Lyra", "archive"],
        keywords: ["lyra", "bloodline", "key", "archive", "seal"],
        tags: ["archive", "key"],
        importance: "high",
        stability: "stable",
        confidence: 0.93,
        createdAt: "2026-03-23T00:00:30.000Z",
      },
      {
        id: "chunk_support_2",
        linkedRecordId: "mem_truth",
        text: "The seal yields only to Lyra's true bloodline key.",
        sourceRole: "assistant",
        scope: "plot",
        subjectIds: ["lyra"],
        entities: ["Lyra", "seal"],
        keywords: ["lyra", "bloodline", "key", "seal"],
        tags: ["archive", "key"],
        importance: "medium",
        stability: "stable",
        confidence: 0.74,
        createdAt: "2026-03-23T00:00:40.000Z",
      },
    ];

    const result = retrievalTools.selectRelevantMemoryRecords(records, {
      userMessage: "What happened tonight after Lyra used the key in the archive?",
      messages: [],
      workspace: { characters: [], worldbooks: [], styles: [] },
      memoryChunks: chunks,
      maxItems: 1,
      maxEvidenceItems: 2,
    });

    assert.equal(result.retrievalMeta.episodicBudget, 1);
    assert.equal(result.retrievalMeta.supportBudget, 1);
    assert.equal(result.retrievalMeta.episodicSelectedCount, 1);
    assert.equal(result.retrievalMeta.supportSelectedCount, 1);
    assert.ok(result.selectedEvidenceChunks.some((item) => item.id === "chunk_episode"));
    assert.ok(result.selectedEvidenceChunks.some((item) => item.id === "chunk_support"));
  });

  await runTest("knowledge retrieval records the actual vector backend when fallback vectors are used", async () => {
    let savedCache = null;
    const retrievalTools = createKnowledgeRetrievalTools({
      embedTextDetailed: async (text) => ({
        vector: text.includes("Continue the story")
          ? [1, 0]
          : text.includes("Archive")
            ? [1, 0]
            : [0, 1],
        provider: "hash_v1",
        model: "hash_v1",
        requestedProvider: "transformers_local",
        requestedModel: "Xenova/all-MiniLM-L6-v2",
        fallbackUsed: true,
        error: "fetch failed",
      }),
      extractKeywords: require("../lib/memory-engine").extractKeywords,
      loadKnowledgeEmbeddingCache: () => ({}),
      saveKnowledgeEmbeddingCache: (_storyId, value) => {
        savedCache = value;
      },
    });

    const result = await retrievalTools.retrieveKnowledgeChunks({
      story: { id: "story_test" },
      workspace: {
        characters: [
          {
            id: "char_ava",
            name: "Ava",
            core: { role: "Archivist" },
            traits: ["careful", "determined"],
            notes: "Archive access specialist.",
          },
        ],
        worldbooks: [],
        styles: [],
      },
      userMessage: "Continue the story. Ask Ava how the Archive opens.",
      messages: [{ role: "user", content: "Continue the story. Ask Ava how the Archive opens." }],
      embeddingOptions: {
        mode: "on",
        provider: "transformers_local",
        model: "Xenova/all-MiniLM-L6-v2",
      },
      maxItems: 2,
    });

    const cacheEntries = Object.values(savedCache?.entries || {});
    assert.ok(cacheEntries.length > 0);
    assert.ok(cacheEntries.every((item) => item.provider === "hash_v1"));
    assert.ok(cacheEntries.every((item) => item.fallbackUsed === true));
    assert.equal(result.retrievalMeta.mode, "rag");
    assert.equal(result.retrievalMeta.vectorEnabled, true);
    assert.equal(result.retrievalMeta.vectorProvider, "hash_v1");
    assert.equal(result.retrievalMeta.vectorFallbackUsed, true);
  });

  await runTest("knowledge rag persists and reuses a story-local chunk index", async () => {
    let savedChunks = [];
    let saveCount = 0;
    const retrievalTools = createKnowledgeRetrievalTools({
      extractKeywords: require("../lib/memory-engine").extractKeywords,
      loadKnowledgeChunkIndex: () => savedChunks,
      saveKnowledgeChunkIndex: (_storyId, value) => {
        saveCount += 1;
        savedChunks = value;
      },
      loadKnowledgeEmbeddingCache: () => ({}),
      saveKnowledgeEmbeddingCache: () => {},
    });

    const workspace = {
      characters: [
        {
          id: "char_ava",
          name: "Ava",
          core: { role: "Archivist" },
          traits: ["careful", "determined"],
          notes: "Ava memorized the archive's brass-key cadence and keeps the access sequence hidden in her field journal.",
        },
      ],
      worldbooks: [],
      styles: [],
    };

    const first = await retrievalTools.retrieveKnowledgeChunks({
      story: { id: "story_index" },
      workspace,
      userMessage: "How does Ava open the archive?",
      messages: [{ role: "user", content: "How does Ava open the archive?" }],
      embeddingOptions: { mode: "off" },
      maxItems: 2,
    });
    const second = await retrievalTools.retrieveKnowledgeChunks({
      story: { id: "story_index" },
      workspace,
      userMessage: "What does Ava remember about the archive?",
      messages: [{ role: "user", content: "What does Ava remember about the archive?" }],
      embeddingOptions: { mode: "off" },
      maxItems: 2,
    });

    assert.equal(saveCount, 1);
    assert.equal(first.retrievalMeta.indexSource, "created");
    assert.equal(first.retrievalMeta.indexRefreshed, true);
    assert.ok(savedChunks.length > 0);
    assert.ok(savedChunks.every((item) => item.workspaceHash));
    assert.equal(second.retrievalMeta.indexSource, "persisted");
    assert.equal(second.retrievalMeta.indexRefreshed, false);
    assert.ok(second.selectedChunks.length > 0);
  });

  await runTest("knowledge rag can admit semantic-only candidates", async () => {
    const retrievalTools = createKnowledgeRetrievalTools({
      embedTextDetailed: async (text) => {
        if (text.includes("Which clue opens the sealed lock")) {
          return {
            vector: [1, 0],
            provider: "transformers_local",
            model: "test-local",
            requestedProvider: "transformers_local",
            requestedModel: "test-local",
            fallbackUsed: false,
            error: "",
          };
        }
        if (text.includes("Notes: The hidden cadence opens the vault")) {
          return {
            vector: [1, 0],
            provider: "transformers_local",
            model: "test-local",
            requestedProvider: "transformers_local",
            requestedModel: "test-local",
            fallbackUsed: false,
            error: "",
          };
        }
        return {
          vector: [0, 1],
          provider: "transformers_local",
          model: "test-local",
          requestedProvider: "transformers_local",
          requestedModel: "test-local",
          fallbackUsed: false,
          error: "",
        };
      },
      extractKeywords: require("../lib/memory-engine").extractKeywords,
      loadKnowledgeEmbeddingCache: () => ({}),
      saveKnowledgeEmbeddingCache: () => {},
    });

    const result = await retrievalTools.retrieveKnowledgeChunks({
      story: { id: "story_semantic" },
      workspace: {
        characters: [
          {
            id: "char_keeper",
            name: "Keeper",
            core: { role: "Gate Warden" },
            traits: ["silent"],
            notes: "The hidden cadence opens the vault.",
          },
        ],
        worldbooks: [],
        styles: [],
      },
      userMessage: "Which clue opens the sealed lock?",
      messages: [{ role: "user", content: "Which clue opens the sealed lock?" }],
      embeddingOptions: {
        mode: "on",
        provider: "transformers_local",
        model: "test-local",
      },
      maxItems: 2,
    });

    assert.equal(result.retrievalMeta.mode, "rag");
    assert.equal(result.retrievalMeta.activeMode, "rag");
    assert.ok(result.retrievalMeta.vectorCandidateCount > 0);
    assert.ok(result.selectedChunks.some((item) => (item.reasons || []).includes("Local vector similarity")));
  });

  await runTest("proposal review accepts a create proposal into workspace and story enablement", () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      const proposalTools = createProposalTools({
        PROPOSAL_REASON_CHAR_LIMIT: 90,
        CHARACTER_ROLE_CHAR_LIMIT: 40,
        CHARACTER_TRAIT_CHAR_LIMIT: 24,
        CHARACTER_RELATIONSHIP_CHAR_LIMIT: 80,
        CHARACTER_ARC_CHAR_LIMIT: 140,
        CHARACTER_NOTES_CHAR_LIMIT: 120,
        safeId,
        slugify,
        summarizeText,
        getProviderForStory: () => null,
        decryptSecret: () => "",
        callOpenAICompatible: async () => {
          throw new Error("Provider should not be called in smoke tests");
        },
        tryParseJsonObject: (value) => {
          try {
            return JSON.parse(value);
          } catch {
            return null;
          }
        },
        readJson: harness.readJson,
        writeJson: harness.writeJson,
        readJsonLines: harness.readJsonLines,
        writeJsonLines: harness.writeJsonLines,
        getStory: harness.getStory,
        saveStory: harness.saveStory,
        getStoryProposalFile: harness.getStoryProposalFile,
        getStoryWorkspaceDir: harness.getStoryWorkspaceDir,
      });

      const story = harness.createDefaultStory({ title: "Proposal Smoke" });
      harness.writeJsonLines(harness.getStoryProposalFile(story.id), [
        {
          id: "proposal_1",
          action: "create",
          targetType: "character",
          targetId: "char_shade",
          reason: "New recurring character is now canon.",
          diff: {
            name: "Shade",
            core: { role: "dream guide" },
            traits: ["calm", "secretive"],
            relationships: { Ava: "mentor" },
            arcState: { current: "Steps out of rumor into reality." },
            notes: "Keeps appearing at the archive stairs.",
          },
          status: "pending",
          createdAt: "2026-03-23T00:00:00.000Z",
        },
      ]);

      const reviewed = proposalTools.reviewProposal(story.id, "proposal_1", "accept", "smoke");
      const updatedStory = harness.getStory(story.id);
      const workspaceCharacter = harness.readJson(
        path.join(harness.getStoryWorkspaceDir(story.id, "characters"), "char_shade.json")
      );
      const storedProposal = harness.readJsonLines(harness.getStoryProposalFile(story.id))[0];

      assert.equal(reviewed.status, "accepted");
      assert.equal(workspaceCharacter.name, "Shade");
      assert.ok(updatedStory.enabled.characters.includes("char_shade"));
      assert.equal(storedProposal.reviewNote, "smoke");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  await runTest("proposal generation dedupes duplicate create-character proposals in one turn", async () => {
    const proposalTools = createProposalTools({
      PROPOSAL_REASON_CHAR_LIMIT: 90,
      CHARACTER_ROLE_CHAR_LIMIT: 40,
      CHARACTER_TRAIT_CHAR_LIMIT: 24,
      CHARACTER_RELATIONSHIP_CHAR_LIMIT: 80,
      CHARACTER_ARC_CHAR_LIMIT: 140,
      CHARACTER_NOTES_CHAR_LIMIT: 120,
      safeId,
      slugify,
      summarizeText,
      getProviderForStory: () => ({
        id: "provider_1",
        baseUrl: "http://example.test",
        model: "test-model",
        encryptedApiKey: { mock: true },
      }),
      decryptSecret: () => "test-key",
      callOpenAICompatible: async ({ messages }) => {
        const systemPrompt = String(messages?.[0]?.content || "");
        if (systemPrompt.includes("shouldGenerateProposal")) {
          return {
            content: JSON.stringify({
              shouldGenerateProposal: true,
              triggers: ["Recurring character introduced"],
            }),
          };
        }
        return {
          content: JSON.stringify({
            proposals: [
              {
                action: "create",
                targetType: "character",
                targetId: "char_shade",
                reason: "Introduce Shade as a recurring figure.",
                patch: {
                  name: "Shade",
                  core: { role: "dream guide" },
                },
              },
              {
                action: "create",
                targetType: "character",
                targetId: "char_shade",
                reason: "Introduce Shade as a recurring figure.",
                patch: {
                  name: "Shade",
                  core: { role: "dream guide" },
                },
              },
            ],
          }),
        };
      },
      tryParseJsonObject: (value) => {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      },
      readJson: () => null,
      writeJson: () => {},
      readJsonLines: () => [],
      writeJsonLines: () => {},
      getStory: () => null,
      saveStory: () => {},
      getStoryProposalFile: () => "",
      getStoryWorkspaceDir: () => "",
    });

    const update = await proposalTools.generateProposalUpdate({
      story: { providerId: "provider_1", model: "test-model" },
      fullMessages: [
        { id: "msg_1", role: "user", content: "Create the dream girl as a real recurring character." },
        { id: "msg_2", role: "assistant", content: "Shade steps fully into the story." },
      ],
      workspace: { characters: [], worldbooks: [], styles: [] },
      assistantText: "Shade steps fully into the story as a recurring dream guide.",
    });

    assert.equal(update.proposalRecords.length, 1);
    assert.equal(update.proposalRecords[0].targetId, "char_shade");
  });

  await runTest("proposal review rejects create-character collisions with existing workspace ids", () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      harness.saveLibraryItem("characters", {
        id: "char_hero",
        name: "Hero",
        createdAt: "2026-03-23T00:00:00.000Z",
        updatedAt: "2026-03-23T00:00:00.000Z",
      });
      const story = harness.createDefaultStory({
        title: "Collision Smoke",
        enabled: { characters: ["char_hero"], worldbooks: [], styles: [] },
      });
      const proposalTools = createProposalTools({
        PROPOSAL_REASON_CHAR_LIMIT: 90,
        CHARACTER_ROLE_CHAR_LIMIT: 40,
        CHARACTER_TRAIT_CHAR_LIMIT: 24,
        CHARACTER_RELATIONSHIP_CHAR_LIMIT: 80,
        CHARACTER_ARC_CHAR_LIMIT: 140,
        CHARACTER_NOTES_CHAR_LIMIT: 120,
        safeId,
        slugify,
        summarizeText,
        getProviderForStory: () => null,
        decryptSecret: () => "",
        callOpenAICompatible: async () => {
          throw new Error("Provider should not be called in smoke tests");
        },
        tryParseJsonObject: (value) => {
          try {
            return JSON.parse(value);
          } catch {
            return null;
          }
        },
        readJson: harness.readJson,
        writeJson: harness.writeJson,
        readJsonLines: harness.readJsonLines,
        writeJsonLines: harness.writeJsonLines,
        getStory: harness.getStory,
        saveStory: harness.saveStory,
        getStoryProposalFile: harness.getStoryProposalFile,
        getStoryWorkspaceDir: harness.getStoryWorkspaceDir,
        syncStoryWorkspace: harness.workspaceTools.syncStoryWorkspace,
      });

      harness.writeJsonLines(harness.getStoryProposalFile(story.id), [
        {
          id: "proposal_collision",
          action: "create",
          targetType: "character",
          targetId: "char_hero",
          reason: "This should collide.",
          diff: {
            name: "Hero Copy",
            core: { role: "duplicate" },
          },
          status: "pending",
          createdAt: "2026-03-23T00:00:00.000Z",
        },
      ]);

      assert.throws(
        () => proposalTools.reviewProposal(story.id, "proposal_collision", "accept", "collision"),
        /Workspace character already exists/
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  await runTest("provider helpers send reasoning payloads for modern chat-completions endpoints", async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({
        url,
        payload: JSON.parse(options.body),
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "OK" } }],
        }),
      };
    };

    try {
      const providerTools = createProviderTools({
        CONFIG_DIR: path.join(createTempRoot(), "config"),
        readJson: () => null,
        writeJson: () => {},
        loadProviders: () => [],
        summarizeText,
      });

      const result = await providerTools.callOpenAICompatible({
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "gpt-5",
        messages: [{ role: "user", content: "hello" }],
        temperature: 1,
        topP: 1,
        max_tokens: 128,
        reasoningEffort: "medium",
      });

      assert.equal(result.content, "OK");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://api.example.com/v1/chat/completions");
      assert.equal(calls[0].payload.reasoning_effort, "medium");
      assert.equal(calls[0].payload.max_completion_tokens, 128);
      assert.equal(calls[0].payload.stream, false);
      assert.ok(!Object.prototype.hasOwnProperty.call(calls[0].payload, "max_tokens"));
    } finally {
      global.fetch = originalFetch;
    }
  });

  await runTest("provider helpers fall back to legacy chat payloads when reasoning params are rejected", async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
      const payload = JSON.parse(options.body);
      calls.push({ url, payload });
      if (calls.length === 1) {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: { message: "Unknown parameter: max_completion_tokens" },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "fallback-ok" } }],
        }),
      };
    };

    try {
      const providerTools = createProviderTools({
        CONFIG_DIR: path.join(createTempRoot(), "config"),
        readJson: () => null,
        writeJson: () => {},
        loadProviders: () => [],
        summarizeText,
      });

      const result = await providerTools.callOpenAICompatible({
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "legacy-chat-model",
        messages: [{ role: "user", content: "hello" }],
        temperature: 1,
        topP: 1,
        max_tokens: 64,
        reasoningEffort: "high",
      });

      assert.equal(result.content, "fallback-ok");
      assert.equal(calls.length, 2);
      assert.equal(calls[0].payload.reasoning_effort, "high");
      assert.equal(calls[0].payload.max_completion_tokens, 64);
      assert.equal(calls[1].payload.max_tokens, 64);
      assert.ok(!Object.prototype.hasOwnProperty.call(calls[1].payload, "max_completion_tokens"));
      assert.ok(!Object.prototype.hasOwnProperty.call(calls[1].payload, "reasoning_effort"));
    } finally {
      global.fetch = originalFetch;
    }
  });

  await runTest("chat diagnostics persist the post-response grounding check", async () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      const story = harness.createDefaultStory({
        title: "Grounding Smoke",
        providerId: "provider_1",
        model: "test-model",
        enabled: { characters: [], worldbooks: [], styles: [] },
      });

      const chatTools = createChatTools({
        safeId,
        summarizeText,
        jsonResponse: (status, data) => ({ status, data }),
        sendJson: () => {},
        getAppConfig: () => ({ globalSystemPrompt: "Global prompt", localEmbedding: { mode: "off" } }),
        getStory: harness.getStory,
        saveStory: harness.saveStory,
        getProviderForStory: () => ({
          id: "provider_1",
          name: "Smoke Provider",
          baseUrl: "http://example.test",
          model: "test-model",
          encryptedApiKey: { mock: true },
        }),
        decryptSecret: () => "test-key",
        syncStoryWorkspace: harness.workspaceTools.syncStoryWorkspace,
        loadActiveWorkspaceItems: harness.workspaceTools.loadActiveWorkspaceItems,
        readJsonLines: harness.readJsonLines,
        appendJsonLine: harness.appendJsonLine,
        writeJson: harness.writeJson,
        writeJsonLines: harness.writeJsonLines,
        getStoryMessagesFile: harness.getStoryMessagesFile,
        getStoryMemoryFile: harness.getStoryMemoryFile,
        getStoryMemoryChunkFile: harness.getStoryMemoryChunkFile,
        getStoryProposalFile: harness.getStoryProposalFile,
        getStorySnapshotFile: harness.getStorySnapshotFile,
        getStoryWorkspaceDir: harness.getStoryWorkspaceDir,
        getDefaultContextStatus: (storyValue) => storyValue.contextStatus,
        buildContextBlocks: async () => ({
          blocks: [
            { label: "system:global", content: "Global prompt", tokens: 3, priority: 100 },
            { label: "system:story", content: "Story prompt", tokens: 3, priority: 95 },
            { label: "system:retrieval_policy", content: "Grounding policy for this response:", tokens: 6, priority: 97 },
            { label: "memory:grounding", content: "Memory grounding rules:", tokens: 4, priority: 87 },
          ],
          usedTokens: 16,
          maxTokens: 100,
          usedBlocks: 0,
          maxBlocks: 6,
          memoryRetrievalMeta: {
            mode: "rag",
            activeMode: "rag",
            vectorEnabled: false,
            vectorCandidateCount: 0,
            vectorSelectedCount: 0,
            evidenceCandidateCount: 1,
            evidenceSelectedCount: 1,
            contestedCandidateCount: 0,
            fallbackReason: "",
          },
          knowledgeRetrievalMeta: {
            mode: "rag",
            activeMode: "lexical",
            vectorEnabled: false,
            vectorCandidateCount: 0,
            vectorSelectedCount: 0,
            chunkCount: 1,
            fallbackReason: "",
          },
          selectedKnowledgeChunks: [{ id: "kg_1", text: "The archive answers to Lyra's bloodline key." }],
          selectedMemoryRecords: [{ id: "mem_1", summary: "Lyra's bloodline key opens the archive." }],
          selectedMemoryReasons: { mem_1: ["Matched keywords: lyra, archive, key"] },
          selectedMemoryEvidence: [{ id: "chunk_1", text: "assistant: Lyra presses the bloodline key into the seal." }],
          selectedMemoryEvidenceReasons: { chunk_1: ["Supported by retrieved memory evidence"] },
          selectedContestedMemoryRecords: [],
          selectedContestedMemoryReasons: {},
        }),
        classifyPressure: () => "low",
        getSummaryTriggers: () => [],
        getSummarySchedule: () => ({ configuredRounds: 4, nextRound: 2, remainingRounds: 2 }),
        buildTransientMemoryCandidate: () => null,
        generateMemoryUpdate: async () => ({
          summarySchedule: { configuredRounds: 4, nextRound: 2, remainingRounds: 2 },
          summaryRecords: [],
          summaryChunks: [],
          consolidatedMemoryRecords: [],
          consolidatedMemorySourceIds: [],
          supersededLongTermIds: [],
          records: [],
          chunks: [],
        }),
        generateProposalUpdate: async () => ({
          proposalRecords: [],
          proposalTriggers: [],
          proposalPipeline: { stage: "not_triggered", triggerCount: 0, generatedCount: 0, triggers: [], error: "" },
        }),
        detectForgetfulness: () => ({
          pressureLevel: "low",
          forgetfulnessState: "normal",
          forgetfulnessReasons: [],
          forgetfulnessSignals: { pressure: [], omission: [], conflict: [] },
        }),
        evaluateAssistantGrounding: () => ({
          state: "caution",
          supportedClauseCount: 1,
          unsupportedClauseCount: 1,
          contestedClauseCount: 0,
          knowledgeSupportCount: 1,
          memoryFactSupportCount: 1,
          memoryEvidenceSupportCount: 1,
          supportedClauses: [
            {
              text: "Lyra opens the archive with the key.",
              reasons: ["Supported by selected memory facts"],
              supportRefs: [
                {
                  sourceType: "memory_fact",
                  preview: "Lyra's bloodline key opens the archive.",
                  matchedTerms: ["lyra", "archive", "key"],
                },
              ],
            },
          ],
          unsupportedClauses: [
            {
              text: "A hidden choir descends from the ceiling.",
              reasons: ["No strong memory or knowledge grounding matched this clause"],
              supportRefs: [],
            },
          ],
          contestedClauses: [],
          notes: ["Part of the answer may be under-grounded."],
        }),
        buildEndpointUrl: () => "http://example.test/chat/completions",
        callOpenAICompatible: async () => ({
          content: "Lyra opens the archive with the key. A hidden choir descends from the ceiling.",
          meta: { endpoint: "http://example.test/chat/completions", latencyMs: 1, promptMessages: 1 },
        }),
        streamOpenAICompatible: async () => {
          throw new Error("Streaming should not be called in smoke tests");
        },
      });

      const response = await chatTools.handleChat(story.id, { message: "Continue the scene." });
      assert.equal(response.status, 200);
      assert.equal(response.data.diagnostics.latestSnapshot.groundingCheck.state, "caution");
      assert.equal(response.data.diagnostics.groundingCheck.state, "caution");
      assert.equal(response.data.diagnostics.latestSnapshot.groundingCheck.unsupportedClauseCount, 1);
      assert.equal(
        response.data.diagnostics.latestSnapshot.groundingCheck.supportedClauses[0]?.supportRefs?.[0]?.sourceType,
        "memory_fact"
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  await runTest("chat writes episodic memory chunks even when no formal summary is generated", async () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      const story = harness.createDefaultStory({
        title: "Episodic Chunk Smoke",
        providerId: "provider_1",
        model: "test-model",
        enabled: { characters: [], worldbooks: [], styles: [] },
      });

      const episodicChunk = {
        id: "chunk_turn_1",
        type: "memory_episode",
        linkedRecordId: "",
        text: "assistant: Lyra presses the bloodline key into the seal.",
        sourceRole: "mixed",
        sourceMessageRange: [1, 2],
        scope: "plot",
        subjectIds: ["lyra"],
        tags: ["archive", "key"],
        confidence: 0.72,
      };

      const chatTools = createChatTools({
        safeId,
        summarizeText,
        jsonResponse: (status, data) => ({ status, data }),
        sendJson: () => {},
        getAppConfig: () => ({ globalSystemPrompt: "Global prompt", localEmbedding: { mode: "off" } }),
        getStory: harness.getStory,
        saveStory: harness.saveStory,
        getProviderForStory: () => ({
          id: "provider_1",
          name: "Smoke Provider",
          baseUrl: "http://example.test",
          model: "test-model",
          encryptedApiKey: { mock: true },
        }),
        decryptSecret: () => "test-key",
        syncStoryWorkspace: harness.workspaceTools.syncStoryWorkspace,
        loadActiveWorkspaceItems: harness.workspaceTools.loadActiveWorkspaceItems,
        readJsonLines: harness.readJsonLines,
        appendJsonLine: harness.appendJsonLine,
        writeJson: harness.writeJson,
        writeJsonLines: harness.writeJsonLines,
        getStoryMessagesFile: harness.getStoryMessagesFile,
        getStoryMemoryFile: harness.getStoryMemoryFile,
        getStoryMemoryChunkFile: harness.getStoryMemoryChunkFile,
        getStoryProposalFile: harness.getStoryProposalFile,
        getStorySnapshotFile: harness.getStorySnapshotFile,
        getStoryWorkspaceDir: harness.getStoryWorkspaceDir,
        getDefaultContextStatus: (storyValue) => storyValue.contextStatus,
        buildContextBlocks: async () => ({
          blocks: [
            { label: "system:global", content: "Global prompt", tokens: 3, priority: 100 },
            { label: "system:story", content: "Story prompt", tokens: 3, priority: 95 },
          ],
          usedTokens: 8,
          maxTokens: 100,
          usedBlocks: 0,
          maxBlocks: 6,
          memoryRetrievalMeta: null,
          knowledgeRetrievalMeta: null,
          selectedKnowledgeChunks: [],
          selectedMemoryRecords: [],
          selectedMemoryReasons: {},
          selectedMemoryEvidence: [],
          selectedMemoryEvidenceReasons: {},
          selectedContestedMemoryRecords: [],
          selectedContestedMemoryReasons: {},
        }),
        classifyPressure: () => "low",
        getSummaryTriggers: () => [],
        getSummarySchedule: () => ({ configuredRounds: 4, nextRound: 2, remainingRounds: 2 }),
        buildTransientMemoryCandidate: () => null,
        generateMemoryUpdate: async () => ({
          summarySchedule: { configuredRounds: 4, nextRound: 2, remainingRounds: 2 },
          summaryRecords: [],
          episodicChunks: [episodicChunk],
          summaryChunks: [],
          consolidatedMemoryRecords: [],
          consolidatedMemorySourceIds: [],
          supersededLongTermIds: [],
          records: [],
          chunks: [episodicChunk],
          transientMemoryCandidate: {
            summary: "Lyra uses the bloodline key to open the archive seal.",
            scope: "plot",
          },
        }),
        generateProposalUpdate: async () => ({
          proposalRecords: [],
          proposalTriggers: [],
          proposalPipeline: { stage: "not_triggered", triggerCount: 0, generatedCount: 0, triggers: [], error: "" },
        }),
        detectForgetfulness: () => ({
          pressureLevel: "low",
          forgetfulnessState: "normal",
          forgetfulnessReasons: [],
          forgetfulnessSignals: { pressure: [], omission: [], conflict: [] },
        }),
        evaluateAssistantGrounding: () => ({
          state: "grounded",
          supportedClauseCount: 0,
          unsupportedClauseCount: 0,
          contestedClauseCount: 0,
          knowledgeSupportCount: 0,
          memoryFactSupportCount: 0,
          memoryEvidenceSupportCount: 0,
          supportedClauses: [],
          unsupportedClauses: [],
          contestedClauses: [],
          notes: [],
        }),
        buildEndpointUrl: () => "http://example.test/chat/completions",
        callOpenAICompatible: async () => ({
          content: "Lyra opens the archive.",
          meta: { endpoint: "http://example.test/chat/completions", latencyMs: 1, promptMessages: 1 },
        }),
        streamOpenAICompatible: async () => {
          throw new Error("Streaming should not be called in smoke tests");
        },
      });

      const response = await chatTools.handleChat(story.id, { message: "Continue the scene." });
      const storedChunks = harness.readJsonLines(harness.getStoryMemoryChunkFile(story.id));

      assert.equal(response.status, 200);
      assert.equal(storedChunks.length, 1);
      assert.equal(storedChunks[0].type, "memory_episode");
      assert.equal(response.data.diagnostics.latestSnapshot.generatedSummaryCount, 0);
      assert.equal(response.data.diagnostics.latestSnapshot.generatedEpisodicChunkCount, 1);
      assert.equal(response.data.diagnostics.latestSnapshot.generatedChunkCount, 1);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  await runTest("chat auto-repairs risky grounded replies before finalizing", async () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      const story = harness.createDefaultStory({
        title: "Grounding Repair Smoke",
        providerId: "provider_1",
        model: "test-model",
        enabled: { characters: [], worldbooks: [], styles: [] },
      });
      const providerCalls = [];

      const chatTools = createChatTools({
        safeId,
        summarizeText,
        jsonResponse: (status, data) => ({ status, data }),
        sendJson: () => {},
        getAppConfig: () => ({ globalSystemPrompt: "Global prompt", localEmbedding: { mode: "off" } }),
        getStory: harness.getStory,
        saveStory: harness.saveStory,
        getProviderForStory: () => ({
          id: "provider_1",
          name: "Smoke Provider",
          baseUrl: "http://example.test",
          model: "test-model",
          encryptedApiKey: { mock: true },
        }),
        decryptSecret: () => "test-key",
        syncStoryWorkspace: harness.workspaceTools.syncStoryWorkspace,
        loadActiveWorkspaceItems: harness.workspaceTools.loadActiveWorkspaceItems,
        readJsonLines: harness.readJsonLines,
        appendJsonLine: harness.appendJsonLine,
        writeJson: harness.writeJson,
        writeJsonLines: harness.writeJsonLines,
        getStoryMessagesFile: harness.getStoryMessagesFile,
        getStoryMemoryFile: harness.getStoryMemoryFile,
        getStoryMemoryChunkFile: harness.getStoryMemoryChunkFile,
        getStoryProposalFile: harness.getStoryProposalFile,
        getStorySnapshotFile: harness.getStorySnapshotFile,
        getStoryWorkspaceDir: harness.getStoryWorkspaceDir,
        getDefaultContextStatus: (storyValue) => storyValue.contextStatus,
        buildContextBlocks: async () => ({
          blocks: [
            { label: "system:global", content: "Global prompt", tokens: 3, priority: 100 },
            { label: "system:story", content: "Story prompt", tokens: 3, priority: 95 },
            { label: "system:retrieval_policy", content: "Grounding policy for this response:", tokens: 6, priority: 97 },
            { label: "memory:grounding", content: "Memory grounding rules:", tokens: 4, priority: 87 },
          ],
          usedTokens: 16,
          maxTokens: 100,
          usedBlocks: 0,
          maxBlocks: 6,
          memoryRetrievalMeta: {
            mode: "rag",
            activeMode: "rag",
            vectorEnabled: false,
            vectorCandidateCount: 0,
            vectorSelectedCount: 0,
            evidenceCandidateCount: 1,
            evidenceSelectedCount: 1,
            contestedCandidateCount: 0,
            fallbackReason: "",
          },
          knowledgeRetrievalMeta: {
            mode: "rag",
            activeMode: "lexical",
            vectorEnabled: false,
            vectorCandidateCount: 0,
            vectorSelectedCount: 0,
            chunkCount: 1,
            fallbackReason: "",
          },
          selectedKnowledgeChunks: [{ id: "kg_1", text: "The archive answers to Lyra's bloodline key." }],
          selectedMemoryRecords: [{ id: "mem_1", summary: "Lyra's bloodline key opens the archive." }],
          selectedMemoryReasons: { mem_1: ["Matched keywords: lyra, archive, key"] },
          selectedMemoryEvidence: [{ id: "chunk_1", text: "assistant: Lyra presses the bloodline key into the seal." }],
          selectedMemoryEvidenceReasons: { chunk_1: ["Supported by retrieved memory evidence"] },
          selectedContestedMemoryRecords: [],
          selectedContestedMemoryReasons: {},
        }),
        classifyPressure: () => "low",
        getSummaryTriggers: () => [],
        getSummarySchedule: () => ({ configuredRounds: 4, nextRound: 2, remainingRounds: 2 }),
        buildTransientMemoryCandidate: () => null,
        generateMemoryUpdate: async () => ({
          summarySchedule: { configuredRounds: 4, nextRound: 2, remainingRounds: 2 },
          summaryRecords: [],
          summaryChunks: [],
          consolidatedMemoryRecords: [],
          consolidatedMemorySourceIds: [],
          supersededLongTermIds: [],
          records: [],
          chunks: [],
        }),
        generateProposalUpdate: async () => ({
          proposalRecords: [],
          proposalTriggers: [],
          proposalPipeline: { stage: "not_triggered", triggerCount: 0, generatedCount: 0, triggers: [], error: "" },
        }),
        detectForgetfulness: () => ({
          pressureLevel: "low",
          forgetfulnessState: "normal",
          forgetfulnessReasons: [],
          forgetfulnessSignals: { pressure: [], omission: [], conflict: [] },
        }),
        evaluateAssistantGrounding: ({ assistantText }) => {
          if (/hidden choir/i.test(assistantText)) {
            return {
              state: "risk",
              supportedClauseCount: 1,
              unsupportedClauseCount: 2,
              contestedClauseCount: 0,
              knowledgeSupportCount: 1,
              memoryFactSupportCount: 1,
              memoryEvidenceSupportCount: 1,
              supportedClauses: [
                {
                  text: "Lyra opens the archive with the key.",
                  reasons: ["Supported by selected memory facts"],
                  supportRefs: [
                    {
                      sourceType: "memory_fact",
                      preview: "Lyra's bloodline key opens the archive.",
                      matchedTerms: ["lyra", "archive", "key"],
                    },
                  ],
                },
              ],
              unsupportedClauses: [
                {
                  text: "A hidden choir descends from the ceiling.",
                  reasons: ["No strong memory or knowledge grounding matched this clause"],
                  supportRefs: [],
                },
                {
                  text: "The chamber floods with silver birds.",
                  reasons: ["No strong memory or knowledge grounding matched this clause"],
                  supportRefs: [],
                },
              ],
              contestedClauses: [],
              notes: ["Multiple answer clauses were not grounded in the retrieved memory or knowledge context."],
            };
          }
          return {
            state: "grounded",
            supportedClauseCount: 1,
            unsupportedClauseCount: 0,
            contestedClauseCount: 0,
            knowledgeSupportCount: 1,
            memoryFactSupportCount: 1,
            memoryEvidenceSupportCount: 1,
            supportedClauses: [
              {
                text: "Lyra opens the archive with the key.",
                reasons: ["Supported by selected memory facts"],
                supportRefs: [
                  {
                    sourceType: "memory_fact",
                    preview: "Lyra's bloodline key opens the archive.",
                    matchedTerms: ["lyra", "archive", "key"],
                  },
                ],
              },
            ],
            unsupportedClauses: [],
            contestedClauses: [],
            notes: ["The answer stayed aligned with the retrieved memory and knowledge context."],
          };
        },
        buildEndpointUrl: () => "http://example.test/chat/completions",
        callOpenAICompatible: async ({ messages }) => {
          providerCalls.push(messages);
          if (providerCalls.length === 1) {
            return {
              content: "Lyra opens the archive with the key. A hidden choir descends from the ceiling. The chamber floods with silver birds.",
              meta: { endpoint: "http://example.test/chat/completions", latencyMs: 5, promptMessages: messages.length },
            };
          }
          return {
            content: "Lyra opens the archive with the key.",
            meta: { endpoint: "http://example.test/chat/completions", latencyMs: 7, promptMessages: messages.length },
          };
        },
        streamOpenAICompatible: async () => {
          throw new Error("Streaming should not be called in smoke tests");
        },
      });

      const response = await chatTools.handleChat(story.id, { message: "Continue the scene." });
      assert.equal(response.status, 200);
      assert.equal(response.data.message.content, "Lyra opens the archive with the key.");
      assert.equal(providerCalls.length, 2);
      const repairPrompt = providerCalls[1][providerCalls[1].length - 1]?.content || "";
      assert.match(repairPrompt, /Grounded clauses to preserve if possible/i);
      assert.match(repairPrompt, /Canon support: memory fact: Lyra's bloodline key opens the archive/i);
      assert.equal(response.data.diagnostics.latestSnapshot.groundingCheck.state, "grounded");
      assert.equal(response.data.diagnostics.latestSnapshot.groundingRepair.attempted, true);
      assert.equal(response.data.diagnostics.latestSnapshot.groundingRepair.applied, true);
      assert.equal(response.data.diagnostics.latestSnapshot.requestMeta.latencyMs, 12);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  await runTest("streaming chat emits a replace event when grounding repair rewrites the final answer", async () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      const story = harness.createDefaultStory({
        title: "Streaming Grounding Repair Smoke",
        providerId: "provider_1",
        model: "test-model",
        enabled: { characters: [], worldbooks: [], styles: [] },
      });

      const chatTools = createChatTools({
        safeId,
        summarizeText,
        jsonResponse: (status, data) => ({ status, data }),
        sendJson: () => {},
        getAppConfig: () => ({ globalSystemPrompt: "Global prompt", localEmbedding: { mode: "off" } }),
        getStory: harness.getStory,
        saveStory: harness.saveStory,
        getProviderForStory: () => ({
          id: "provider_1",
          name: "Smoke Provider",
          baseUrl: "http://example.test",
          model: "test-model",
          encryptedApiKey: { mock: true },
        }),
        decryptSecret: () => "test-key",
        syncStoryWorkspace: harness.workspaceTools.syncStoryWorkspace,
        loadActiveWorkspaceItems: harness.workspaceTools.loadActiveWorkspaceItems,
        readJsonLines: harness.readJsonLines,
        appendJsonLine: harness.appendJsonLine,
        writeJson: harness.writeJson,
        writeJsonLines: harness.writeJsonLines,
        getStoryMessagesFile: harness.getStoryMessagesFile,
        getStoryMemoryFile: harness.getStoryMemoryFile,
        getStoryMemoryChunkFile: harness.getStoryMemoryChunkFile,
        getStoryProposalFile: harness.getStoryProposalFile,
        getStorySnapshotFile: harness.getStorySnapshotFile,
        getStoryWorkspaceDir: harness.getStoryWorkspaceDir,
        getDefaultContextStatus: (storyValue) => storyValue.contextStatus,
        buildContextBlocks: async () => ({
          blocks: [
            { label: "system:global", content: "Global prompt", tokens: 3, priority: 100 },
            { label: "system:story", content: "Story prompt", tokens: 3, priority: 95 },
            { label: "system:retrieval_policy", content: "Grounding policy for this response:", tokens: 6, priority: 97 },
            { label: "memory:grounding", content: "Memory grounding rules:", tokens: 4, priority: 87 },
          ],
          usedTokens: 16,
          maxTokens: 100,
          usedBlocks: 0,
          maxBlocks: 6,
          memoryRetrievalMeta: {
            mode: "rag",
            activeMode: "rag",
            vectorEnabled: false,
            vectorCandidateCount: 0,
            vectorSelectedCount: 0,
            evidenceCandidateCount: 1,
            evidenceSelectedCount: 1,
            contestedCandidateCount: 0,
            fallbackReason: "",
          },
          knowledgeRetrievalMeta: {
            mode: "rag",
            activeMode: "lexical",
            vectorEnabled: false,
            vectorCandidateCount: 0,
            vectorSelectedCount: 0,
            chunkCount: 1,
            fallbackReason: "",
          },
          selectedKnowledgeChunks: [{ id: "kg_1", text: "The archive answers to Lyra's bloodline key." }],
          selectedMemoryRecords: [{ id: "mem_1", summary: "Lyra's bloodline key opens the archive." }],
          selectedMemoryReasons: { mem_1: ["Matched keywords: lyra, archive, key"] },
          selectedMemoryEvidence: [{ id: "chunk_1", text: "assistant: Lyra presses the bloodline key into the seal." }],
          selectedMemoryEvidenceReasons: { chunk_1: ["Supported by retrieved memory evidence"] },
          selectedContestedMemoryRecords: [],
          selectedContestedMemoryReasons: {},
        }),
        classifyPressure: () => "low",
        getSummaryTriggers: () => [],
        getSummarySchedule: () => ({ configuredRounds: 4, nextRound: 2, remainingRounds: 2 }),
        buildTransientMemoryCandidate: () => null,
        generateMemoryUpdate: async () => ({
          summarySchedule: { configuredRounds: 4, nextRound: 2, remainingRounds: 2 },
          summaryRecords: [],
          summaryChunks: [],
          consolidatedMemoryRecords: [],
          consolidatedMemorySourceIds: [],
          supersededLongTermIds: [],
          records: [],
          chunks: [],
        }),
        generateProposalUpdate: async () => ({
          proposalRecords: [],
          proposalTriggers: [],
          proposalPipeline: { stage: "not_triggered", triggerCount: 0, generatedCount: 0, triggers: [], error: "" },
        }),
        detectForgetfulness: () => ({
          pressureLevel: "low",
          forgetfulnessState: "normal",
          forgetfulnessReasons: [],
          forgetfulnessSignals: { pressure: [], omission: [], conflict: [] },
        }),
        evaluateAssistantGrounding: ({ assistantText }) => {
          if (/hidden choir/i.test(assistantText)) {
            return {
              state: "risk",
              supportedClauseCount: 1,
              unsupportedClauseCount: 2,
              contestedClauseCount: 0,
              knowledgeSupportCount: 1,
              memoryFactSupportCount: 1,
              memoryEvidenceSupportCount: 1,
              supportedClauses: [{ text: "Lyra opens the archive with the key.", reasons: ["Supported by selected memory facts"] }],
              unsupportedClauses: [
                { text: "A hidden choir descends from the ceiling.", reasons: ["No strong memory or knowledge grounding matched this clause"] },
                { text: "The chamber floods with silver birds.", reasons: ["No strong memory or knowledge grounding matched this clause"] },
              ],
              contestedClauses: [],
              notes: ["Multiple answer clauses were not grounded in the retrieved memory or knowledge context."],
            };
          }
          return {
            state: "grounded",
            supportedClauseCount: 1,
            unsupportedClauseCount: 0,
            contestedClauseCount: 0,
            knowledgeSupportCount: 1,
            memoryFactSupportCount: 1,
            memoryEvidenceSupportCount: 1,
            supportedClauses: [{ text: "Lyra opens the archive with the key.", reasons: ["Supported by selected memory facts"] }],
            unsupportedClauses: [],
            contestedClauses: [],
            notes: ["The answer stayed aligned with the retrieved memory and knowledge context."],
          };
        },
        buildEndpointUrl: () => "http://example.test/chat/completions",
        callOpenAICompatible: async () => ({
          content: "Lyra opens the archive with the key.",
          meta: { endpoint: "http://example.test/chat/completions", latencyMs: 7, promptMessages: 6 },
        }),
        streamOpenAICompatible: async () => ({
          endpoint: "http://example.test/chat/completions",
          startedAt: Date.now() - 5,
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  [
                    'data: {"choices":[{"delta":{"content":"Lyra opens the archive with the key. "}}]}',
                    'data: {"choices":[{"delta":{"content":"A hidden choir descends from the ceiling. "}}]}',
                    'data: {"choices":[{"delta":{"content":"The chamber floods with silver birds."}}]}',
                    "data: [DONE]",
                    "",
                  ].join("\n")
                )
              );
              controller.close();
            },
          }),
        }),
      });

      const req = new EventEmitter();
      const chunks = [];
      const res = {
        writableEnded: false,
        writeHead() {},
        write(chunk) {
          chunks.push(String(chunk));
        },
        end() {
          this.writableEnded = true;
        },
      };

      await chatTools.handleChatStream(req, res, story.id, { message: "Continue the scene." });
      const events = chunks
        .join("")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const replaceEvent = events.find((item) => item.type === "replace");
      const doneEvent = events.find((item) => item.type === "done");

      assert.ok(replaceEvent);
      assert.equal(replaceEvent.text, "Lyra opens the archive with the key.");
      assert.equal(doneEvent.payload.message.content, "Lyra opens the archive with the key.");
      assert.equal(doneEvent.payload.diagnostics.latestSnapshot.groundingRepair.applied, true);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  await runTest("revising the latest exchange rolls back accepted proposals from that turn", async () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      harness.saveLibraryItem("characters", {
        id: "char_hero",
        name: "Hero",
        traits: ["brave"],
        createdAt: "2026-03-23T00:00:00.000Z",
        updatedAt: "2026-03-23T00:00:00.000Z",
      });

      const story = harness.createDefaultStory({
        title: "Revision Smoke",
        providerId: "provider_1",
        model: "test-model",
        enabled: { characters: ["char_hero"], worldbooks: [], styles: [] },
      });
      const workspacePath = path.join(harness.getStoryWorkspaceDir(story.id, "characters"), "char_hero.json");
      const beforeAccept = harness.readJson(workspacePath);

      const proposalTools = createProposalTools({
        PROPOSAL_REASON_CHAR_LIMIT: 90,
        CHARACTER_ROLE_CHAR_LIMIT: 40,
        CHARACTER_TRAIT_CHAR_LIMIT: 24,
        CHARACTER_RELATIONSHIP_CHAR_LIMIT: 80,
        CHARACTER_ARC_CHAR_LIMIT: 140,
        CHARACTER_NOTES_CHAR_LIMIT: 120,
        safeId,
        slugify,
        summarizeText,
        getProviderForStory: () => null,
        decryptSecret: () => "",
        callOpenAICompatible: async () => {
          throw new Error("Provider should not be called in smoke tests");
        },
        tryParseJsonObject: (value) => {
          try {
            return JSON.parse(value);
          } catch {
            return null;
          }
        },
        readJson: harness.readJson,
        writeJson: harness.writeJson,
        readJsonLines: harness.readJsonLines,
        writeJsonLines: harness.writeJsonLines,
        getStory: harness.getStory,
        saveStory: harness.saveStory,
        getStoryProposalFile: harness.getStoryProposalFile,
        getStoryWorkspaceDir: harness.getStoryWorkspaceDir,
        syncStoryWorkspace: harness.workspaceTools.syncStoryWorkspace,
      });

      harness.appendJsonLine(harness.getStoryMessagesFile(story.id), {
        id: "msg_1",
        role: "user",
        content: "The hero uncovers the truth.",
        createdAt: "2026-03-23T00:00:00.000Z",
      });
      harness.appendJsonLine(harness.getStoryMessagesFile(story.id), {
        id: "msg_2",
        role: "assistant",
        content: "The hero's origin mystery is resolved.",
        createdAt: "2026-03-23T00:01:00.000Z",
      });
      harness.writeJsonLines(harness.getStoryProposalFile(story.id), [
        {
          id: "proposal_turn_1",
          action: "update",
          targetType: "character",
          targetId: "char_hero",
          reason: "Update the hero after the reveal.",
          diff: {
            notes: "Origin mystery resolved.",
          },
          status: "pending",
          createdAt: "2026-03-23T00:01:30.000Z",
        },
      ]);
      harness.appendJsonLine(harness.getStorySnapshotFile(story.id), {
        at: "2026-03-23T00:02:00.000Z",
        contextStatus: harness.getStory(story.id).contextStatus,
        generatedSummaryIds: [],
        consolidatedMemorySourceIds: [],
        supersededLongTermIds: [],
        generatedProposalIds: ["proposal_turn_1"],
      });

      proposalTools.reviewProposal(story.id, "proposal_turn_1", "accept", "accept for smoke");
      const afterAccept = harness.readJson(workspacePath);
      assert.equal(afterAccept.notes, "Origin mystery resolved.");

      const chatTools = createChatTools({
        safeId,
        summarizeText,
        jsonResponse: (status, data) => ({ status, data }),
        sendJson: () => {},
        getAppConfig: () => ({ globalSystemPrompt: "Global prompt", localEmbedding: { mode: "off" } }),
        getStory: harness.getStory,
        saveStory: harness.saveStory,
        getProviderForStory: () => ({
          id: "provider_1",
          name: "Smoke Provider",
          baseUrl: "http://example.test",
          model: "test-model",
          encryptedApiKey: { mock: true },
        }),
        decryptSecret: () => "test-key",
        syncStoryWorkspace: harness.workspaceTools.syncStoryWorkspace,
        loadActiveWorkspaceItems: harness.workspaceTools.loadActiveWorkspaceItems,
        readJsonLines: harness.readJsonLines,
        appendJsonLine: harness.appendJsonLine,
        writeJson: harness.writeJson,
        writeJsonLines: harness.writeJsonLines,
        getStoryMessagesFile: harness.getStoryMessagesFile,
        getStoryMemoryFile: harness.getStoryMemoryFile,
        getStoryMemoryChunkFile: harness.getStoryMemoryChunkFile,
        getStoryProposalFile: harness.getStoryProposalFile,
        getStorySnapshotFile: harness.getStorySnapshotFile,
        getStoryWorkspaceDir: harness.getStoryWorkspaceDir,
        getDefaultContextStatus: (storyValue) => storyValue.contextStatus,
        buildContextBlocks: async () => ({
          blocks: [],
          usedTokens: 10,
          maxTokens: 100,
          usedBlocks: 0,
          maxBlocks: 6,
          memoryRetrievalMeta: null,
          knowledgeRetrievalMeta: null,
          selectedKnowledgeChunks: [],
          selectedMemoryRecords: [],
          selectedMemoryReasons: {},
        }),
        classifyPressure: () => "low",
        getSummaryTriggers: () => [],
        getSummarySchedule: () => ({ configuredRounds: 4, nextRound: 2, remainingRounds: 2 }),
        buildTransientMemoryCandidate: () => null,
        generateMemoryUpdate: async () => ({
          summarySchedule: { configuredRounds: 4, nextRound: 2, remainingRounds: 2 },
          summaryRecords: [],
          consolidatedMemoryRecords: [],
          consolidatedMemorySourceIds: [],
          supersededLongTermIds: [],
          records: [],
        }),
        generateProposalUpdate: async () => ({
          proposalRecords: [],
          proposalTriggers: [],
          proposalPipeline: { stage: "not_triggered", triggerCount: 0, generatedCount: 0, triggers: [], error: "" },
        }),
        detectForgetfulness: () => ({
          pressureLevel: "low",
          forgetfulnessState: "normal",
          forgetfulnessReasons: [],
          forgetfulnessSignals: { pressure: [], omission: [], conflict: [] },
        }),
        buildEndpointUrl: () => "http://example.test/chat/completions",
        callOpenAICompatible: async () => ({
          content: "Rewritten assistant reply.",
          meta: { endpoint: "http://example.test/chat/completions", latencyMs: 1, promptMessages: 1 },
        }),
        streamOpenAICompatible: async () => {
          throw new Error("Streaming should not be called in smoke tests");
        },
      });

      const revised = await chatTools.reviseLastExchange(story.id, "Rewrite the turn");
      const afterRevise = harness.readJson(workspacePath);
      const storedProposals = harness.readJsonLines(harness.getStoryProposalFile(story.id));

      assert.equal(revised.status, 200);
      assert.deepEqual(afterRevise.notes, beforeAccept.notes);
      assert.equal(storedProposals.length, 0);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  await runTest("revising the latest exchange restores the previous turn when regeneration fails", async () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      harness.saveLibraryItem("characters", {
        id: "char_hero",
        name: "Hero",
        traits: ["brave"],
        createdAt: "2026-03-23T00:00:00.000Z",
        updatedAt: "2026-03-23T00:00:00.000Z",
      });

      const story = harness.createDefaultStory({
        title: "Revision Failure Smoke",
        providerId: "provider_1",
        model: "test-model",
        enabled: { characters: ["char_hero"], worldbooks: [], styles: [] },
      });
      const workspacePath = path.join(harness.getStoryWorkspaceDir(story.id, "characters"), "char_hero.json");

      const proposalTools = createProposalTools({
        PROPOSAL_REASON_CHAR_LIMIT: 90,
        CHARACTER_ROLE_CHAR_LIMIT: 40,
        CHARACTER_TRAIT_CHAR_LIMIT: 24,
        CHARACTER_RELATIONSHIP_CHAR_LIMIT: 80,
        CHARACTER_ARC_CHAR_LIMIT: 140,
        CHARACTER_NOTES_CHAR_LIMIT: 120,
        safeId,
        slugify,
        summarizeText,
        getProviderForStory: () => null,
        decryptSecret: () => "",
        callOpenAICompatible: async () => {
          throw new Error("Provider should not be called in smoke tests");
        },
        tryParseJsonObject: (value) => {
          try {
            return JSON.parse(value);
          } catch {
            return null;
          }
        },
        readJson: harness.readJson,
        writeJson: harness.writeJson,
        readJsonLines: harness.readJsonLines,
        writeJsonLines: harness.writeJsonLines,
        getStory: harness.getStory,
        saveStory: harness.saveStory,
        getStoryProposalFile: harness.getStoryProposalFile,
        getStoryWorkspaceDir: harness.getStoryWorkspaceDir,
        syncStoryWorkspace: harness.workspaceTools.syncStoryWorkspace,
      });

      harness.appendJsonLine(harness.getStoryMessagesFile(story.id), {
        id: "msg_fail_1",
        role: "user",
        content: "The hero finds the answer.",
        createdAt: "2026-03-23T00:00:00.000Z",
      });
      harness.appendJsonLine(harness.getStoryMessagesFile(story.id), {
        id: "msg_fail_2",
        role: "assistant",
        content: "The answer changes the hero forever.",
        createdAt: "2026-03-23T00:01:00.000Z",
      });
      harness.writeJsonLines(harness.getStoryProposalFile(story.id), [
        {
          id: "proposal_fail_turn",
          action: "update",
          targetType: "character",
          targetId: "char_hero",
          reason: "Record the reveal.",
          diff: {
            notes: "The answer changed everything.",
          },
          status: "pending",
          createdAt: "2026-03-23T00:01:30.000Z",
        },
      ]);
      harness.appendJsonLine(harness.getStorySnapshotFile(story.id), {
        at: "2026-03-23T00:02:00.000Z",
        contextStatus: harness.getStory(story.id).contextStatus,
        generatedSummaryIds: [],
        consolidatedMemorySourceIds: [],
        supersededLongTermIds: [],
        generatedProposalIds: ["proposal_fail_turn"],
      });

      proposalTools.reviewProposal(story.id, "proposal_fail_turn", "accept", "accept before failed revise");

      const messagesBeforeRevise = harness.readJsonLines(harness.getStoryMessagesFile(story.id));
      const proposalsBeforeRevise = harness.readJsonLines(harness.getStoryProposalFile(story.id));
      const snapshotsBeforeRevise = harness.readJsonLines(harness.getStorySnapshotFile(story.id));
      const storyBeforeRevise = harness.getStory(story.id);
      const workspaceBeforeRevise = harness.readJson(workspacePath);

      const chatTools = createChatTools({
        safeId,
        summarizeText,
        jsonResponse: (status, data) => ({ status, data }),
        sendJson: () => {},
        getAppConfig: () => ({ globalSystemPrompt: "Global prompt", localEmbedding: { mode: "off" } }),
        getStory: harness.getStory,
        saveStory: harness.saveStory,
        getProviderForStory: () => ({
          id: "provider_1",
          name: "Smoke Provider",
          baseUrl: "http://example.test",
          model: "test-model",
          encryptedApiKey: { mock: true },
        }),
        decryptSecret: () => "test-key",
        syncStoryWorkspace: harness.workspaceTools.syncStoryWorkspace,
        loadActiveWorkspaceItems: harness.workspaceTools.loadActiveWorkspaceItems,
        readJsonLines: harness.readJsonLines,
        appendJsonLine: harness.appendJsonLine,
        writeJson: harness.writeJson,
        writeJsonLines: harness.writeJsonLines,
        getStoryMessagesFile: harness.getStoryMessagesFile,
        getStoryMemoryFile: harness.getStoryMemoryFile,
        getStoryMemoryChunkFile: harness.getStoryMemoryChunkFile,
        getStoryProposalFile: harness.getStoryProposalFile,
        getStorySnapshotFile: harness.getStorySnapshotFile,
        getStoryWorkspaceDir: harness.getStoryWorkspaceDir,
        getDefaultContextStatus: (storyValue) => storyValue.contextStatus,
        buildContextBlocks: async () => ({
          blocks: [],
          usedTokens: 10,
          maxTokens: 100,
          usedBlocks: 0,
          maxBlocks: 6,
          memoryRetrievalMeta: null,
          knowledgeRetrievalMeta: null,
          selectedKnowledgeChunks: [],
          selectedMemoryRecords: [],
          selectedMemoryReasons: {},
        }),
        classifyPressure: () => "low",
        getSummaryTriggers: () => [],
        getSummarySchedule: () => ({ configuredRounds: 4, nextRound: 2, remainingRounds: 2 }),
        buildTransientMemoryCandidate: () => null,
        generateMemoryUpdate: async () => ({
          summarySchedule: { configuredRounds: 4, nextRound: 2, remainingRounds: 2 },
          summaryRecords: [],
          consolidatedMemoryRecords: [],
          consolidatedMemorySourceIds: [],
          supersededLongTermIds: [],
          records: [],
        }),
        generateProposalUpdate: async () => ({
          proposalRecords: [],
          proposalTriggers: [],
          proposalPipeline: { stage: "not_triggered", triggerCount: 0, generatedCount: 0, triggers: [], error: "" },
        }),
        detectForgetfulness: () => ({
          pressureLevel: "low",
          forgetfulnessState: "normal",
          forgetfulnessReasons: [],
          forgetfulnessSignals: { pressure: [], omission: [], conflict: [] },
        }),
        buildEndpointUrl: () => "http://example.test/chat/completions",
        callOpenAICompatible: async () => {
          throw new Error("Simulated provider failure");
        },
        streamOpenAICompatible: async () => {
          throw new Error("Streaming should not be called in smoke tests");
        },
      });

      const revised = await chatTools.reviseLastExchange(story.id, "Try to rewrite and fail");

      assert.equal(revised.status, 502);
      assert.deepEqual(harness.readJsonLines(harness.getStoryMessagesFile(story.id)), messagesBeforeRevise);
      assert.deepEqual(harness.readJsonLines(harness.getStoryProposalFile(story.id)), proposalsBeforeRevise);
      assert.deepEqual(harness.readJsonLines(harness.getStorySnapshotFile(story.id)), snapshotsBeforeRevise);
      assert.deepEqual(harness.getStory(story.id), storyBeforeRevise);
      assert.deepEqual(harness.readJson(workspacePath), workspaceBeforeRevise);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  if (!process.exitCode) {
    console.log("Smoke tests completed successfully.");
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
