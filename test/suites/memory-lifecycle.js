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

module.exports = async function runMemoryLifecycleTests(runTest) {
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
  
  await runTest("memory lifecycle archives only old merged short-term checkpoints", async () => {
    const archivedLines = [];
    const memoryTools = buildMemoryTools({
      appendJsonLine: (file, item) => archivedLines.push({ file, item }),
      getStoryMemoryArchiveFile: (storyId) => path.join(os.tmpdir(), `memory-archive-${storyId}.jsonl`),
    });
    const records = Array.from({ length: 160 }, (_, index) => ({
      id: `record_${index}`,
      tier: "short_term",
      kind: "plot_checkpoint",
      importance: "medium",
      stability: "volatile",
      createdAt: `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
    }));
    records.unshift({
      id: "archive_candidate",
      tier: "short_term",
      kind: "plot_checkpoint",
      importance: "medium",
      stability: "volatile",
      mergedInto: "long_term_1",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    records.push(
      { id: "high_keep", tier: "short_term", kind: "plot_checkpoint", importance: "high", stability: "volatile", mergedInto: "long_term_1" },
      { id: "stable_keep", tier: "short_term", kind: "plot_checkpoint", importance: "medium", stability: "stable", mergedInto: "long_term_1" },
      { id: "unmerged_keep", tier: "short_term", kind: "plot_checkpoint", importance: "medium", stability: "volatile" }
    );
    const update = await memoryTools.generateMemoryUpdate({
      storyId: "lifecycle-test",
      story: { settings: { summaryInterval: 1000 }, providerId: "", model: "" },
      fullMessages: [],
      memoryRecords: records,
      memoryChunks: [],
      workspace: { characters: [], worldbooks: [], styles: [] },
      summaryTriggers: [],
    });
    assert.equal(update.archivedRecords.length, 1);
    assert.equal(update.archivedRecords[0].id, "archive_candidate");
    assert.equal(archivedLines.length, 1);
    assert.equal(archivedLines[0].item.archiveReason, "Old merged short-term plot checkpoint");
    assert.ok(!update.records.some((item) => item.id === "archive_candidate"));
    assert.ok(update.records.some((item) => item.id === "high_keep"));
    assert.ok(update.records.some((item) => item.id === "stable_keep"));
    assert.ok(update.records.some((item) => item.id === "unmerged_keep"));
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
  
  await runTest("memory tools compact oversized episodic chunk history to a recent working set", async () => {
    const memoryTools = buildMemoryTools();
    const story = {
      settings: { summaryInterval: 99 },
      providerId: "",
      model: "",
    };
    const existingChunks = Array.from({ length: 30 }, (_, index) => ({
      id: `chunk_old_${index + 1}`,
      type: "memory_episode",
      text: `Episode beat ${index + 1}`,
      sourceRole: "assistant",
      sourceMessageRange: [index + 1, index + 1],
      kind: "plot_checkpoint",
      scope: "plot",
      importance: "medium",
      stability: "volatile",
      confidence: 0.6,
      createdAt: `2026-03-23T00:${String(index).padStart(2, "0")}:00.000Z`,
    }));
  
    const update = await memoryTools.generateMemoryUpdate({
      story,
      fullMessages: [
        { role: "user", content: "Continue." },
        { role: "assistant", content: "A fresh scene beat lands in the archive chamber." },
      ],
      memoryRecords: [],
      memoryChunks: existingChunks,
      workspace: { characters: [], worldbooks: [], styles: [] },
      summaryTriggers: [],
    });
  
    assert.ok(update.chunks.length <= 24);
    assert.ok(update.chunks.some((item) => item.id === update.episodicChunks[0].id));
    assert.ok(!update.chunks.some((item) => item.id === "chunk_old_1"));
  });
  
  await runTest("memory chunk tools fold overlapping mixed and assistant evidence windows from the same beat", async () => {
    const { extractKeywords } = require("../../lib/memory-engine");
    const chunkTools = createMemoryChunkTools({
      summarizeText,
      safeId,
      extractKeywords,
      resolveEmbeddingOptions: () => ({ mode: "off" }),
      buildMemoryEmbeddingText: () => "",
      stripLeadingDialogueMarker: (value) => String(value || "").replace(/^[^:]+:\s*/, ""),
      isProbablyDialogueClause: () => false,
      looksLikeSummaryFact: (value) => /archive|bloodline|seal|key/i.test(String(value || "")),
      looksLikeUserIntentClause: (value) => /\?$/.test(String(value || "").trim()),
    });
  
    const assistantText =
      "Lyra presses the bloodline key into the archive seal and feels the chamber answer around her at once. " +
      "Dust wakes in the rafters, the iron rings along the vault begin to hum, and a hidden light rolls across the floor " +
      "like water finding an old channel. The seal only yields after the key turns fully, and the whole chamber seems to " +
      "remember her name the moment the lock gives way.";
    const chunks = await chunkTools.buildMemoryEvidenceChunks({
      story: {},
      messages: [
        { role: "user", content: "How does Lyra finally open the archive seal?" },
        { role: "assistant", content: assistantText },
      ],
      record: {
        id: "mem_archive",
        summary: "Lyra opens the archive with her bloodline key.",
        scope: "plot",
        kind: "plot_checkpoint",
        importance: "high",
        confidence: 0.84,
        entities: ["Lyra", "archive"],
        tags: ["archive", "bloodline", "key"],
        subjectIds: ["lyra"],
      },
      maxItems: 4,
    });
  
    const sealOpeningChunks = chunks.filter((item) => /bloodline key into the archive seal/i.test(item.text));
  
    assert.equal(sealOpeningChunks.length, 1);
    assert.equal(sealOpeningChunks[0].sourceMessageRange.join("-"), "1-2");
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
    assert.ok(update.summaryRecords[0].stateSlot);
    assert.ok(update.summaryRecords[0].stateFacet);
    assert.ok(update.summaryChunks.length > 0);
    assert.equal(update.summaryChunks[0].conflictGroup, update.summaryRecords[0].conflictGroup);
    assert.equal(update.summaryChunks[0].canonKey, update.summaryRecords[0].canonKey);
    assert.equal(update.summaryChunks[0].stateSlot, update.summaryRecords[0].stateSlot);
    assert.equal(update.summaryChunks[0].stateFacet, update.summaryRecords[0].stateFacet);
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
    assert.equal(result.addedRecords[0].stateSlot, "relationship:lyra|mira");
    assert.ok(result.addedRecords[0].stateFacet);
  });
  
  await runTest("memory consolidation keeps unrelated canon facts in separate slots", () => {
    const now = "2026-03-25T00:00:00.000Z";
    const result = consolidateMemoryRecords(
      [
        {
          id: "mem_char_1",
          tier: "short_term",
          kind: "character_update",
          scope: "character",
          summary: "Lyra starts trusting Cael.",
          subjectIds: ["lyra"],
          tags: ["trust"],
          keywords: ["lyra", "trust", "cael"],
          importance: "medium",
          confidence: 0.82,
          createdAt: "2026-03-24T00:00:00.000Z",
        },
        {
          id: "mem_char_2",
          tier: "short_term",
          kind: "character_update",
          scope: "character",
          summary: "Lyra learns her bloodline can open the archive.",
          subjectIds: ["lyra"],
          tags: ["bloodline", "archive"],
          keywords: ["lyra", "bloodline", "archive"],
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
  
    assert.equal(result.addedRecords.length, 0);
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
  
  await runTest("memory tools embed consolidated long-term records after summary consolidation", async () => {
    const { buildMemoryEmbeddingText } = createEmbeddingTools();
    const memoryTools = createMemoryTools({
      DEFAULT_SUMMARY_INTERVAL,
      MEMORY_SUMMARY_CHAR_LIMIT: 160,
      classifyPressure: () => "low",
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
        vector: [0.4, 0.9],
        provider: "hash_v1",
        model: "hash_v1",
        requestedProvider: "transformers_local",
        requestedModel: "Xenova/all-MiniLM-L6-v2",
        fallbackUsed: true,
        error: "fetch failed",
      }),
      buildMemoryEmbeddingText,
      buildEmbeddingSignature: require("../../lib/embeddings").buildEmbeddingSignature,
      resolveEmbeddingOptions: () => ({
        mode: "on",
        provider: "transformers_local",
        model: "Xenova/all-MiniLM-L6-v2",
        dimensions: 384,
        allowFallback: true,
      }),
    });
  
    const existingRecords = Array.from({ length: 7 }, (_, index) => ({
      id: `mem_rel_${index + 1}`,
      tier: "short_term",
      kind: "relationship_update",
      scope: "relationship",
      summary: `Lyra and Mira rebuild trust after the archive breach ${index + 1}.`,
      subjectIds: ["lyra"],
      objectIds: ["mira"],
      entities: ["Lyra", "Mira"],
      tags: ["trust", "archive"],
      keywords: ["lyra", "mira", "trust", "archive"],
      importance: "high",
      confidence: 0.8,
      createdAt: `2026-03-24T00:0${index}:00.000Z`,
      canonKey: "relationship:lyra|mira:trust|archive",
      conflictGroup: "relationship:lyra|mira",
      stateSlot: "relationship:lyra|mira",
      stateFacet: "trust|archive",
    }));
  
    const update = await memoryTools.generateMemoryUpdate({
      story: {
        settings: { summaryInterval: 3 },
        providerId: "",
        model: "",
      },
      fullMessages: [
        { role: "user", content: "How do Lyra and Mira change after the archive breach?" },
        { role: "assistant", content: "Lyra trusts Mira again, and the two reconcile while protecting the archive together." },
      ],
      memoryRecords: existingRecords,
      memoryChunks: [],
      workspace: {
        characters: [
          { id: "lyra", name: "Lyra" },
          { id: "mira", name: "Mira" },
        ],
        worldbooks: [{ id: "archive", title: "Archive" }],
        styles: [],
      },
      summaryTriggers: ["Manual smoke trigger"],
    });
  
    assert.equal(update.consolidatedMemoryRecords.length, 1);
    assert.deepEqual(update.consolidatedMemoryRecords[0].embedding, [0.4, 0.9]);
    assert.equal(update.consolidatedMemoryRecords[0].embeddingProvider, "hash_v1");
    assert.equal(update.consolidatedMemoryRecords[0].embeddingSignature, "hash_v1:hash_v1");
  });
  
  await runTest("story-store writes JSON and JSONL files through atomic replacement", () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      const jsonFile = path.join(rootDir, "nested", "state.json");
      const linesFile = path.join(rootDir, "nested", "events.jsonl");
      harness.writeJson(jsonFile, { version: 1 });
      harness.writeJson(jsonFile, { version: 2 });
      harness.writeJsonLines(linesFile, [{ id: "one" }, { id: "two" }]);
      assert.deepEqual(harness.readJson(jsonFile), { version: 2 });
      assert.deepEqual(harness.readJsonLines(linesFile), [{ id: "one" }, { id: "two" }]);
      assert.deepEqual(
        fs.readdirSync(path.dirname(jsonFile)).filter((name) => name.endsWith(".tmp")),
        []
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
  
};
