const {
  assert,
  EventEmitter,
  fs,
  os,
  path,
  createStoryStore,
  createWorkspaceTools,
  createContextTools,
  createMemoryTools,
  createMemoryChunkTools,
  consolidateMemoryRecords,
  createEmbeddingTools,
  normalizeEmbeddingConfig,
  normalizeEmbeddingMode,
  normalizeEmbeddingRemoteHost,
  createKnowledgeRetrievalTools,
  buildMemoryQuery,
  selectRelevantMemoryRecords,
  formatMemoryContext,
  createMemoryRetrievalTools,
  createLocalVectorSearchItems,
  createLocalVectorSearchRecords,
  createProposalTools,
  createChatTools,
  createProviderTools,
  createServerConfigTools,
  createGroundingCheckTools,
  createKeyedSerialExecutor,
  createAuthTools,
  MEMORY_KEYWORD_VERSION,
  MEMORY_SCHEMA_VERSION,
  normalizeRuntimeMemoryState,
  DEFAULT_CONTEXT_BLOCKS,
  DEFAULT_SUMMARY_INTERVAL,
  DEFAULT_MAX_COMPLETION_TOKENS,
  summarizeText,
  slugify,
  safeId,
  createTempRoot,
  createStoreHarness,
  buildMemoryTools,
} = require("../helpers/harness");

module.exports = async function runContextKnowledgeTests(runTest) {
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
      extractKeywords: require("../../lib/memory-engine").extractKeywords,
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
      extractKeywords: require("../../lib/memory-engine").extractKeywords,
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
  
  await runTest("memory keyword extraction keeps readable Chinese terms instead of raw sentence slices", () => {
    const extractKeywords = require("../../lib/memory-engine").extractKeywords;
    const keywords = extractKeywords(
      "\u9646\u77e5\u7ed2\u5c0f\u59d0\u5728\u65e5\u672c\u7684\u66b4\u96e8\u8857\u5934\u6361\u5230\u4e86\u4e00\u4f4d\u5f88\u6f02\u4eae\u7684\u795e\u4f8d\u5c11\u5973\uff0c\u800c\u4e14\u662f\u7b2c\u4e00\u6b21\u51fa\u6765\u63a5\u5ba2"
    );
  
    assert.ok(
      keywords.includes("\u9646\u77e5\u7ed2") || keywords.includes("\u9646\u77e5\u7ed2\u5c0f\u59d0")
    );
    assert.ok(keywords.includes("\u65e5\u672c"));
    assert.ok(keywords.includes("\u66b4\u96e8"));
    assert.ok(keywords.includes("\u8857\u5934"));
    assert.ok(
      keywords.includes("\u795e\u4f8d\u5c11\u5973") ||
        (keywords.includes("\u795e\u4f8d") && keywords.includes("\u5c11\u5973"))
    );
    assert.ok(!keywords.includes("\u9646\u77e5\u7ed2\u5c0f\u59d0\u5728"));
    assert.ok(!keywords.includes("\u65e5\u672c\u7684\u66b4\u96e8\u8857"));
    assert.ok(!keywords.includes("\u5934\u6361\u5230\u4e86\u4e00\u4f4d"));
  });
  
  await runTest("memory keyword extraction filters weak Chinese filler terms and broken fragments", () => {
    const extractKeywords = require("../../lib/memory-engine").extractKeywords;
    const keywords = extractKeywords(
      "\u9646\u77e5\u7ed2\u662f\u90a3\u79cd\u8ba9\u4eba\u4e00\u773c\u671b\u53bb\u5c31\u4f1a\u5fc3\u751f\u601c\u60dc\u7684\u5973\u5b69\uff0c\u4e1c\u4eac\u65b0\u5bbf\u533a\u7684\u96e8\u662f\u7070\u84dd\u8272\u7684\u96e8"
    );
  
    assert.ok(keywords.includes("\u9646\u77e5\u7ed2"));
    assert.ok(keywords.includes("\u4e1c\u4eac"));
    assert.ok(keywords.includes("\u65b0\u5bbf"));
    assert.ok(!keywords.includes("\u90a3\u79cd"));
    assert.ok(!keywords.includes("\u5973\u5b69"));
    assert.ok(!keywords.includes("\u533a\u7684\u96e8\u662f"));
  });
  
  await runTest("diagnostic term selection rejects weak two-character Chinese fragments", () => {
    const { selectDiagnosticTerms } = require("../../lib/text-utils");
    const shown = selectDiagnosticTerms(
      [
        "\u9646\u77e5\u7ed2",
        "\u53bb\u5c31",
        "\u5979\u4e0d",
        "\u5c0f\u591c",
        "\u5c0f\u59d0",
        "\u4e0d\u4f1a",
        "\u65e5\u672c",
        "\u65b0\u5bbf",
        "\u795e\u660e",
        "\u96e8\u591c",
      ],
      10
    );
  
    assert.ok(shown.includes("\u9646\u77e5\u7ed2"));
    assert.ok(shown.includes("\u65e5\u672c"));
    assert.ok(shown.includes("\u65b0\u5bbf"));
    assert.ok(shown.includes("\u795e\u660e"));
    assert.ok(shown.includes("\u96e8\u591c"));
    assert.ok(!shown.includes("\u53bb\u5c31"));
    assert.ok(!shown.includes("\u5979\u4e0d"));
    assert.ok(!shown.includes("\u5c0f\u591c"));
    assert.ok(!shown.includes("\u5c0f\u59d0"));
    assert.ok(!shown.includes("\u4e0d\u4f1a"));
  });
  
  await runTest("diagnostic term selection rejects weak three-character Chinese fragments", () => {
    const { selectDiagnosticTerms } = require("../../lib/text-utils");
    const shown = selectDiagnosticTerms(
      [
        "\u6761\u8857\u53bb",
        "\u5979\u4e0d\u7231",
        "\u4fbf\u5229\u5e97",
        "\u6b4c\u821e\u4f0e",
        "\u5c0f\u591c\u706f",
      ],
      10
    );
  
    assert.ok(!shown.includes("\u6761\u8857\u53bb"));
    assert.ok(!shown.includes("\u5979\u4e0d\u7231"));
    assert.ok(shown.includes("\u4fbf\u5229\u5e97"));
    assert.ok(shown.includes("\u6b4c\u821e\u4f0e"));
    assert.ok(shown.includes("\u5c0f\u591c\u706f"));
  });
  
  await runTest("runtime memory normalization refreshes legacy keyword slices lazily", () => {
    const normalized = normalizeRuntimeMemoryState({
      memoryRecords: [
        {
          id: "mem_legacy",
          summary:
            "\u9646\u77e5\u7ed2\u5728\u65e5\u672c\u7684\u66b4\u96e8\u8857\u5934\u6361\u5230\u4e86\u4e00\u4f4d\u795e\u4f8d\u5c11\u5973",
          keywords: ["\u9646\u77e5\u7ed2\u5728", "\u65e5\u672c\u7684\u66b4\u96e8\u8857"],
          embedding: [0.6, 0.8],
          embeddingProvider: "hash_v1",
          embeddingModel: "hash_v1",
        },
      ],
      memoryChunks: [
        {
          id: "chunk_legacy",
          text:
            "\u9646\u77e5\u7ed2\u5c0f\u59d0\u5728\u65e5\u672c\u7684\u66b4\u96e8\u8857\u5934\u6361\u5230\u4e86\u4e00\u4f4d\u5f88\u6f02\u4eae\u7684\u795e\u4f8d\u5c11\u5973",
          keywords: ["\u9646\u77e5\u7ed2\u5c0f\u59d0\u5728", "\u65e5\u672c\u7684\u66b4\u96e8\u8857"],
          embedding: [0.6, 0.8],
          embeddingProvider: "hash_v1",
          embeddingModel: "hash_v1",
        },
      ],
    });
  
    assert.equal(normalized.changed, true);
    assert.equal(normalized.memoryRecords[0].schemaVersion, MEMORY_SCHEMA_VERSION);
    assert.equal(normalized.memoryChunks[0].schemaVersion, MEMORY_SCHEMA_VERSION);
    assert.equal(normalized.memoryRecords[0].keywordVersion, MEMORY_KEYWORD_VERSION);
    assert.equal(normalized.memoryChunks[0].keywordVersion, MEMORY_KEYWORD_VERSION);
    assert.ok(normalized.memoryRecords[0].keywords.includes("\u9646\u77e5\u7ed2"));
    assert.ok(normalized.memoryChunks[0].keywords.includes("\u795e\u4f8d") || normalized.memoryChunks[0].keywords.includes("\u795e\u4f8d\u5c11\u5973"));
    assert.ok(!normalized.memoryRecords[0].keywords.includes("\u9646\u77e5\u7ed2\u5728"));
    assert.ok(!normalized.memoryChunks[0].keywords.includes("\u65e5\u672c\u7684\u66b4\u96e8\u8857"));
    assert.equal(normalized.memoryRecords[0].embeddingSignature, "hash_v1:hash_v1");
    assert.equal(normalized.memoryChunks[0].embeddingSignature, "hash_v1:hash_v1");
  });
  
  await runTest("knowledge query keeps primary focus on the current ask over stale recent history", async () => {
    const { buildKnowledgeQuery } = createKnowledgeRetrievalTools({
      extractKeywords: require("../../lib/memory-engine").extractKeywords,
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
  
  await runTest("knowledge query treats Chinese question-like asks as the primary focus", async () => {
    const { buildKnowledgeQuery } = createKnowledgeRetrievalTools({
      extractKeywords: require("../../lib/memory-engine").extractKeywords,
    });
  
    const query = buildKnowledgeQuery({
      userMessage: "继续写陆知绒和神侍少女回公寓之后会聊什么？",
      messages: [
        { role: "assistant", content: "Earlier, Lu Zhirong saw the shrine maiden in the rain outside the alley." },
        { role: "user", content: "Why was the alley so quiet?" },
      ],
      workspace: {
        characters: [
          { id: "lu_zhirong_001", name: "陆知绒", core: { role: "Lead" } },
          { id: "shrine_maiden_001", name: "神侍少女", core: { role: "Stray shrine maiden" } },
          { id: "rain_guard_001", name: "雨巷保安", core: { role: "Minor NPC" } },
        ],
        worldbooks: [],
        styles: [],
      },
    });
  
    assert.ok(query.primaryFocusClauses.some((item) => item.includes("陆知绒")));
    assert.ok(query.primaryMatchedEntries.some((item) => item.id === "lu_zhirong_001"));
    assert.ok(query.primaryMatchedEntries.some((item) => item.id === "shrine_maiden_001"));
    assert.ok(!query.primaryMatchedEntries.some((item) => item.id === "rain_guard_001"));
  });
  
  await runTest("knowledge retrieval prefers the exact relationship-target chunk", async () => {
    const { retrieveKnowledgeChunks, buildKnowledgeChunks } = createKnowledgeRetrievalTools({
      extractKeywords: require("../../lib/memory-engine").extractKeywords,
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
      extractKeywords: require("../../lib/memory-engine").extractKeywords,
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
  
  await runTest("knowledge diagnostics hide weak keyword fillers in reason text", async () => {
    const { retrieveKnowledgeChunks } = createKnowledgeRetrievalTools({
      extractKeywords: require("../../lib/memory-engine").extractKeywords,
    });
  
    const workspace = {
      characters: [
        {
          id: "lu_zhirong_001",
          name: "\u9646\u77e5\u7ed2",
          notes:
            "\u9646\u77e5\u7ed2\u662f\u90a3\u79cd\u8ba9\u4eba\u4e00\u773c\u671b\u53bb\u5c31\u4f1a\u5fc3\u751f\u601c\u60dc\u7684\u5973\u5b69\uff0c\u5979\u4f4f\u5728\u5b66\u6821\u9644\u8fd1\u4e00\u95f4\u8001\u65e7\u516c\u5bd3\u7684\u4e8c\u697c\uff0c\u7a97\u53f0\u4e0a\u517b\u7740\u4e00\u76c6\u603b\u4e5f\u517b\u4e0d\u6d3b\u7684\u7ee3\u7403\u82b1\u3002",
        },
      ],
      worldbooks: [],
      styles: [],
    };
  
    const result = await retrieveKnowledgeChunks({
      story: { id: "knowledge_reason_terms_clean" },
      workspace,
      userMessage: "\u9646\u77e5\u7ed2\u73b0\u5728\u662f\u4ec0\u4e48\u72b6\u6001\uff1f",
      messages: [],
      embeddingOptions: { mode: "off" },
      maxItems: 1,
    });
  
    assert.equal(result.selectedChunks.length, 1);
    const reasonText = (result.selectedChunks[0].reasons || []).join(" | ");
    assert.ok(reasonText.includes("\u9646\u77e5\u7ed2"));
    assert.ok(!reasonText.includes("\u90a3\u79cd"));
    assert.ok(!reasonText.includes("\u5973\u5b69"));
  });
  
  await runTest("knowledge traits chunks keep compact entity labels instead of full prose", () => {
    const { buildKnowledgeChunks } = createKnowledgeRetrievalTools({
      extractKeywords: require("../../lib/memory-engine").extractKeywords,
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
    assert.ok(query.primaryFocusClauses.length > 0);
    assert.ok(query.keywords.includes("archive"));
    assert.ok(query.matchedEntityIds.includes("lyra"));
    assert.ok(query.primaryMatchedEntityIds.includes("lyra"));
    assert.ok(query.embeddingText.includes("Current ask:"));
    assert.ok(query.embeddingText.includes("Primary focus:"));
    assert.ok(query.embeddingText.includes("Focus cues:"));
  });
  
  await runTest("memory query keeps primary entity focus on the current ask over stale nearby history", () => {
    const query = buildMemoryQuery({
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
  
    assert.ok(query.matchedEntityIds.includes("eira"));
    assert.ok(query.primaryMatchedEntityIds.includes("bai"));
    assert.ok(query.primaryMatchedEntityIds.includes("yian"));
    assert.ok(!query.primaryMatchedEntityIds.includes("eira"));
  });
  
  await runTest("memory query carries recent scene entities into continuation asks", () => {
    const query = buildMemoryQuery({
      userMessage: "继续写下去。",
      messages: [
        { role: "user", content: "让 Lyra 和 Jun Ash 进入档案馆。" },
        { role: "assistant", content: "Lyra and Jun Ash step into the archive together." },
      ],
      workspace: {
        characters: [
          { id: "lyra", name: "Lyra", core: { role: "Courier" } },
          { id: "jun", name: "Jun Ash", core: { role: "Rival-ally" } },
          { id: "eira", name: "Eira", core: { role: "Archivist" } },
        ],
        worldbooks: [{ id: "archive", title: "Archive", category: "vault" }],
        styles: [],
      },
    });
    assert.deepEqual(query.inheritedEntityIds.sort(), ["archive", "jun", "lyra"]);
    assert.ok(query.matchedEntityIds.includes("lyra"));
    assert.ok(query.matchedEntityIds.includes("jun"));
  });
  
  await runTest("memory lexical recall favors current-turn entities over stale history carryover", () => {
    const result = selectRelevantMemoryRecords(
      [
        {
          id: "mem_bai",
          tier: "short_term",
          kind: "plot_checkpoint",
          scope: "plot",
          subjectIds: ["bai", "yian"],
          entities: ["Bai", "Yian"],
          keywords: ["bai", "yian", "path"],
          tags: ["path"],
          summary: "Bai meets Yian on the mountain path.",
          importance: "medium",
          confidence: 0.8,
          createdAt: "2026-03-23T00:01:00.000Z",
        },
        {
          id: "mem_eira",
          tier: "short_term",
          kind: "plot_checkpoint",
          scope: "plot",
          subjectIds: ["eira"],
          entities: ["Eira"],
          keywords: ["eira", "array", "map", "cave"],
          tags: ["array"],
          summary: "Eira studies the array map in her cave.",
          importance: "medium",
          confidence: 0.8,
          createdAt: "2026-03-23T00:02:00.000Z",
        },
      ],
      {
        userMessage: "Continue with Bai meeting Yian on the path.",
        messages: [
          { role: "assistant", content: "Earlier, Bai woke in Eira's cave and noticed Eira still studying the array map." },
          { role: "user", content: "What was Eira doing with the array map?" },
        ],
        workspace: {
          characters: [
            { id: "bai", name: "Bai" },
            { id: "yian", name: "Yian" },
            { id: "eira", name: "Eira" },
          ],
          worldbooks: [],
          styles: [],
        },
        maxItems: 1,
      }
    );
  
    assert.deepEqual(
      result.selectedRecords.map((item) => item.id),
      ["mem_bai"]
    );
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
    assert.equal(result.supportedClauses[0]?.supportType, "knowledge");
    assert.equal(result.supportedClauses[0]?.primarySupportRef?.sourceType, "knowledge");
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
  
  await runTest("forgetfulness diagnostics focus on query-relevant facts instead of every active workspace detail", () => {
    const memoryTools = buildMemoryTools();
    const result = memoryTools.detectForgetfulness({
      workspace: {
        characters: [
          { id: "lyra", name: "Lyra", traits: ["heir"], arcState: { current: "opening the archive" } },
          { id: "mira", name: "Mira", traits: ["scout"], arcState: { current: "watching the bridge" } },
        ],
        worldbooks: [{ id: "archive", title: "Archive", rules: ["Only heirs may enter"] }],
      },
      memoryRecords: [
        {
          id: "mem_archive",
          tier: "long_term",
          stability: "stable",
          summary: "Lyra's bloodline key opens the archive seal.",
          subjectIds: ["lyra"],
          entities: ["Lyra", "archive"],
          tags: ["archive", "bloodline", "key"],
        },
      ],
      assistantText: "Lyra steadies the bloodline key and the archive answers her at once.",
      userInput: "How does Lyra open the archive now?",
      contextInfo: {
        usedTokens: 1200,
        maxTokens: 8000,
        selectedMemoryRecords: [
          {
            id: "mem_archive",
            summary: "Lyra's bloodline key opens the archive seal.",
            subjectIds: ["lyra"],
            entities: ["Lyra", "archive"],
            tags: ["archive", "bloodline", "key"],
          },
        ],
      },
    });
  
    assert.equal(result.forgetfulnessState, "normal");
    assert.equal(result.forgetfulnessSignals.omission.length, 0);
  });
  
};
