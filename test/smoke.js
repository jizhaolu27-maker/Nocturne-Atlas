const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createStoryStore } = require("../lib/story-store");
const { createWorkspaceTools } = require("../lib/workspace");
const { createContextTools } = require("../lib/context");
const { createMemoryTools } = require("../lib/memory");
const {
  createEmbeddingTools,
  normalizeEmbeddingConfig,
  normalizeEmbeddingMode,
  normalizeEmbeddingRemoteHost,
} = require("../lib/embeddings");
const { createKnowledgeRetrievalTools } = require("../lib/knowledge-retrieval");
const { selectRelevantMemoryRecords, formatMemoryContext } = require("../lib/memory-engine");
const { createMemoryRetrievalTools } = require("../lib/memory-retrieval");
const { createLocalVectorSearchRecords } = require("../lib/memory-vector");
const { createProposalTools } = require("../lib/proposals");
const { createChatTools } = require("../lib/chat");
const { createProviderTools } = require("../lib/providers");
const { createServerConfigTools } = require("../lib/server-config");

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
    assert.ok(labels.includes("characters"));
    assert.ok(labels.includes("worldbook"));
    assert.ok(labels.includes("style"));
    assert.ok(labels.includes("knowledge:retrieved"));
    assert.ok(labels.includes("memory:critical") || labels.includes("memory:recent") || labels.includes("memory:long_term"));
    assert.ok(labels.some((label) => label.startsWith("history_turn:")));
    assert.equal(result.selectedMemoryRecords[0].id, "mem_1");
    assert.ok(result.selectedKnowledgeChunks.length > 0);
    assert.ok(result.selectedKnowledgeChunks.some((item) => item.chunkType));
    assert.ok(Number.isFinite(result.knowledgeRetrievalMeta.vectorCandidateCount || 0));
    const characterBlock = result.blocks.find((item) => item.label === "characters");
    const worldbookBlock = result.blocks.find((item) => item.label === "worldbook");
    assert.ok(characterBlock?.content.includes("Character: Hero"));
    assert.ok(!characterBlock?.content.includes("Relationships:"));
    assert.ok(worldbookBlock?.content.includes("World: Nocturne City"));
    assert.ok(!worldbookBlock?.content.includes("Content: A rain-soaked city."));
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
        settings: { summaryInterval: 3, localEmbeddingMode: "inherit" },
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

  await runTest("hybrid retrieval stays lexical by default and can admit vector matches when enabled", () => {
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
    assert.equal(lexicalOnly.retrievalMeta.mode, "lexical");
    assert.equal(lexicalOnly.retrievalMeta.vectorEnabled, false);

    const hybrid = retrievalTools.selectRelevantMemoryRecords(records, {
      retrievalMode: "hybrid",
      userMessage: "What does the signal reveal?",
      messages: [],
      workspace: { characters: [], worldbooks: [], styles: [] },
      queryEmbedding: [0, 1],
      maxItems: 2,
    });
    assert.equal(hybrid.retrievalMeta.mode, "hybrid");
    assert.equal(hybrid.retrievalMeta.vectorEnabled, true);
    assert.ok(hybrid.selectedRecords.some((item) => item.id === "mem_b"));
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
    assert.equal(result.retrievalMeta.vectorProvider, "hash_v1");
    assert.equal(result.retrievalMeta.vectorFallbackUsed, true);
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
