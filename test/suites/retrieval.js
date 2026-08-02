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

module.exports = async function runRetrievalTests(runTest) {
  await runTest("memory rag falls back lexically, ignores incompatible vector spaces, and can admit vector-enhanced fact matches", () => {
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
        embeddingProvider: "hash_v1",
        embeddingModel: "test-local",
        embeddingSignature: "hash_v1:hash_v1",
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
        embeddingProvider: "transformers_local",
        embeddingModel: "test-local",
        embeddingSignature: "transformers_local:test-local",
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
    assert.equal(lexicalOnly.retrievalMeta.activeMode, "lexical");
    assert.equal(lexicalOnly.retrievalMeta.vectorEnabled, false);
    assert.deepEqual(
      lexicalOnly.selectedRecords.map((item) => item.id),
      ["mem_a"]
    );
  
    const hybrid = retrievalTools.selectRelevantMemoryRecords(records, {
      userMessage: "What does the signal reveal?",
      messages: [],
      workspace: { characters: [], worldbooks: [], styles: [] },
      queryEmbedding: [0, 1],
      queryEmbeddingProvider: "transformers_local",
      queryEmbeddingModel: "test-local",
      queryEmbeddingSignature: "transformers_local:test-local",
      maxItems: 2,
    });
    assert.equal(hybrid.retrievalMeta.mode, "rag");
    assert.equal(hybrid.retrievalMeta.vectorEnabled, true);
    assert.ok(hybrid.selectedRecords.some((item) => item.id === "mem_b"));
    assert.ok(!hybrid.selectedRecords.some((item) => item.id === "mem_a"));
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
  
  await runTest("memory lexical recall ignores self-derived keyword matches on unrelated records", () => {
    const result = selectRelevantMemoryRecords(
      [
        {
          id: "mem_archive",
          tier: "long_term",
          kind: "plot_checkpoint",
          scope: "plot",
          summary: "Lyra opens the archive with her bloodline key.",
          entities: ["Lyra", "archive"],
          keywords: ["lyra", "archive", "bloodline", "key"],
          tags: ["archive", "bloodline"],
          importance: "high",
          stability: "stable",
          confidence: 0.92,
          createdAt: "2026-03-23T00:00:00.000Z",
        },
        {
          id: "mem_rain",
          tier: "short_term",
          kind: "plot_checkpoint",
          scope: "plot",
          summary: "Rain runs down the market awnings while a nameless girl waits alone.",
          entities: ["nameless girl"],
          keywords: ["rain", "market", "awnings"],
          tags: ["rain"],
          importance: "medium",
          confidence: 0.61,
          createdAt: "2026-03-23T00:01:00.000Z",
        },
      ],
      {
        userMessage: "How does Lyra open the archive?",
        messages: [],
        workspace: { characters: [], worldbooks: [], styles: [] },
        maxItems: 2,
      }
    );
  
    assert.deepEqual(
      result.selectedRecords.map((item) => item.id),
      ["mem_archive"]
    );
    assert.ok(result.reasonsById.mem_archive.some((reason) => reason.includes("Matched keywords")));
    assert.equal(result.reasonsById.mem_rain, undefined);
  });
  
  await runTest("memory evidence diagnostics only report keywords that overlap the query", () => {
    const retrievalTools = createMemoryRetrievalTools({
      selectRelevantMemoryRecords,
      formatMemoryContext,
      isVectorSearchEnabled: () => false,
    });
  
    const result = retrievalTools.selectRelevantMemoryRecords([], {
      userMessage: "陆知绒现在怎么样？",
      messages: [],
      workspace: {
        characters: [{ id: "lu_zhirong_001", name: "陆知绒" }],
        worldbooks: [],
        styles: [],
      },
      memoryChunks: [
        {
          id: "chunk_luzhirong",
          type: "memory_episode",
          text: "雨下得像是要把整个东京都浇进地底，但陆知绒还是停下来看向街角的少女。",
          scope: "character",
          subjectIds: ["lu_zhirong_001"],
          entities: ["陆知绒"],
          keywords: ["雨下", "像是", "要把"],
          importance: "medium",
          confidence: 0.68,
          createdAt: "2026-03-23T00:00:00.000Z",
        },
      ],
      maxItems: 1,
      maxEvidenceItems: 1,
    });
  
    assert.deepEqual(
      result.selectedEvidenceChunks.map((item) => item.id),
      ["chunk_luzhirong"]
    );
    assert.ok(
      result.selectedEvidenceReasons.chunk_luzhirong.some(
        (reason) => reason.includes("Primary subjects") || reason.includes("Context subjects")
      )
    );
    assert.ok(!result.selectedEvidenceReasons.chunk_luzhirong.some((reason) => reason.includes("Matched keywords")));
  });
  
  await runTest("memory evidence diagnostics hide weak keyword fragments even when better keyword hits exist", () => {
    const retrievalTools = createMemoryRetrievalTools({
      selectRelevantMemoryRecords,
      formatMemoryContext,
      isVectorSearchEnabled: () => false,
    });
  
    const result = retrievalTools.selectRelevantMemoryRecords([], {
      userMessage: "\u4e1c\u4eac\u65b0\u5bbf\u7684\u9646\u77e5\u7ed2\u600e\u4e48\u4e86\uff1f",
      messages: [],
      workspace: {
        characters: [{ id: "lu_zhirong_001", name: "\u9646\u77e5\u7ed2" }],
        worldbooks: [],
        styles: [],
      },
      memoryChunks: [
        {
          id: "chunk_luzhirong_keywords",
          type: "memory_episode",
          text: "\u4e1c\u4eac\u65b0\u5bbf\u533a\u7684\u96e8\uff0c\u662f\u90a3\u79cd\u4f1a\u628a\u4e00\u5207\u989c\u8272\u90fd\u6d17\u6210\u7070\u84dd\u7684\u96e8\u3002\u9646\u77e5\u7ed2\u6491\u7740\u4e00\u628a\u900f\u660e\u5851\u6599\u4f1e\uff0c\u7ad9\u5728\u5deb\u53e3\u7684\u5c3d\u5934\u3002",
          scope: "character",
          subjectIds: ["lu_zhirong_001"],
          entities: ["\u9646\u77e5\u7ed2"],
          keywords: ["\u4e1c\u4eac", "\u65b0\u5bbf", "\u533a\u7684\u96e8\u662f", "\u90a3\u79cd", "\u6761\u8857\u53bb"],
          importance: "medium",
          confidence: 0.68,
          createdAt: "2026-03-23T00:00:00.000Z",
        },
      ],
      maxItems: 1,
      maxEvidenceItems: 1,
    });
  
    const reasonText = (result.selectedEvidenceReasons.chunk_luzhirong_keywords || []).join(" | ");
    assert.ok(reasonText.includes("Matched keywords: \u4e1c\u4eac, \u65b0\u5bbf"));
    assert.ok(!reasonText.includes("\u533a\u7684\u96e8\u662f"));
    assert.ok(!reasonText.includes("\u90a3\u79cd"));
    assert.ok(!reasonText.includes("\u6761\u8857\u53bb"));
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
      extractKeywords: require("../../lib/memory-engine").extractKeywords,
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
      extractKeywords: require("../../lib/memory-engine").extractKeywords,
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
    assert.equal(first.retrievalMeta.indexVersion, retrievalTools.indexVersion);
    assert.ok(savedChunks.length > 0);
    assert.ok(savedChunks.every((item) => item.workspaceHash));
    assert.ok(savedChunks.every((item) => item.indexVersion === retrievalTools.indexVersion));
    assert.equal(second.retrievalMeta.indexSource, "persisted");
    assert.equal(second.retrievalMeta.indexRefreshed, false);
    assert.equal(second.retrievalMeta.indexVersion, retrievalTools.indexVersion);
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
      extractKeywords: require("../../lib/memory-engine").extractKeywords,
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
  
      harness.writeJson(path.join(harness.getStoryWorkspaceDir(story.id, "characters"), "legacy-character-id.json"), {
        id: "legacy-character-id",
        name: "Minase Nagi",
        relationships: { "Asama Kiri": "partner" },
        arcState: { current: "Before" },
      });
      harness.writeJsonLines(harness.getStoryProposalFile(story.id), [
        ...harness.readJsonLines(harness.getStoryProposalFile(story.id)),
        {
          id: "proposal_stale_target",
          action: "update",
          targetType: "character",
          targetId: "invented-minase-id",
          reason: "Update an existing character with a legacy id.",
          diff: {
            relationships: { "Asama Kiri": "wife" },
            arcState: { current: "After" },
          },
          status: "pending",
        },
      ]);
      proposalTools.reviewProposal(story.id, "proposal_stale_target", "accept");
      const legacyCharacter = harness.readJson(
        path.join(harness.getStoryWorkspaceDir(story.id, "characters"), "legacy-character-id.json")
      );
      assert.equal(legacyCharacter.arcState.current, "After");
      assert.equal(legacyCharacter.relationships["Asama Kiri"], "wife");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
  
};
