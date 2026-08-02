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

module.exports = async function runChatTests(runTest) {
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
  
  await runTest("streaming chat exposes transient pending generation without persisting partial messages", async () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      const story = harness.createDefaultStory({
        title: "Pending Generation Smoke",
        providerId: "provider_1",
        model: "test-model",
        enabled: { characters: [], worldbooks: [], styles: [] },
      });
      let releaseStream;
      const streamReady = new Promise((resolve) => {
        releaseStream = resolve;
      });
      const chatTools = createChatTools({
        safeId,
        summarizeText,
        jsonResponse: (status, data) => ({ status, data }),
        sendJson: () => {},
        getAppConfig: () => ({ localEmbedding: { mode: "off" } }),
        getStory: harness.getStory,
        saveStory: harness.saveStory,
        getProviderForStory: () => ({ id: "provider_1", name: "Smoke Provider", baseUrl: "http://example.test", model: "test-model", encryptedApiKey: { mock: true } }),
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
        getDefaultContextStatus: () => ({}),
        buildContextBlocks: async () => ({ blocks: [], usedTokens: 0, maxTokens: 100, usedBlocks: 0, maxBlocks: 6, selectedKnowledgeChunks: [], selectedMemoryRecords: [], selectedMemoryReasons: {}, selectedMemoryEvidence: [], selectedMemoryEvidenceReasons: {}, selectedContestedMemoryRecords: [], selectedContestedMemoryReasons: {}, memoryRetrievalMeta: {}, knowledgeRetrievalMeta: {} }),
        classifyPressure: () => "low",
        getSummaryTriggers: () => [],
        getSummarySchedule: () => ({}),
        buildTransientMemoryCandidate: async () => null,
        generateMemoryUpdate: async ({ memoryRecords, memoryChunks }) => ({ records: memoryRecords, chunks: memoryChunks, summaryRecords: [], episodicChunks: [], summaryChunks: [], consolidatedMemoryRecords: [], consolidatedMemorySourceIds: [], supersededLongTermIds: [], summarySchedule: {} }),
        generateProposalUpdate: async () => ({ proposalRecords: [], proposalTriggers: [], proposalPipeline: null }),
        detectForgetfulness: () => ({ pressureLevel: "low", forgetfulnessState: "ok", forgetfulnessReasons: [], forgetfulnessSignals: [] }),
        buildEndpointUrl: () => "http://example.test/chat/completions",
        callOpenAICompatible: async () => ({ content: "unused", meta: {} }),
        streamOpenAICompatible: async () => ({ endpoint: "http://example.test/chat/completions", startedAt: Date.now(), stream: new ReadableStream({ async start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Partial text"}}]}\n')); await streamReady; controller.enqueue(new TextEncoder().encode('data: [DONE]\n')); controller.close(); } }) }),
      });
      const req = new EventEmitter();
      const chunks = [];
      const res = { writableEnded: false, writeHead() {}, write(chunk) { chunks.push(String(chunk)); }, end() { this.writableEnded = true; } };
      const streamPromise = chatTools.handleChatStream(req, res, story.id, { message: "A pending request" });
      for (let attempt = 0; attempt < 20 && !chatTools.getPendingGeneration(story.id); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const pending = chatTools.getPendingGeneration(story.id);
      assert.equal(pending.userMessage.content, "A pending request");
      assert.equal(pending.assistantText, "Partial text");
      assert.deepEqual(harness.readJsonLines(harness.getStoryMessagesFile(story.id)), []);
      releaseStream();
      await streamPromise;
      assert.equal(chatTools.getPendingGeneration(story.id), null);
      assert.ok(chunks.some((chunk) => chunk.includes('\"done\"')));
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
  
  await runTest("preparing revise-last rolls story state back to the previous turn before regeneration", async () => {
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
        title: "Prepare Revision Smoke",
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
  
      const previousContextStatus = {
        ...harness.getStory(story.id).contextStatus,
        usedTokens: 14,
        maxTokens: 100,
        usedBlocks: 3,
        maxBlocks: 20,
        pressureLevel: "low",
      };
      const latestContextStatus = {
        ...previousContextStatus,
        usedTokens: 62,
        usedBlocks: 7,
        pressureLevel: "medium",
      };
  
      harness.appendJsonLine(harness.getStoryMessagesFile(story.id), {
        id: "msg_prepare_1",
        role: "user",
        content: "First turn request.",
        createdAt: "2026-03-23T00:00:00.000Z",
      });
      harness.appendJsonLine(harness.getStoryMessagesFile(story.id), {
        id: "msg_prepare_2",
        role: "assistant",
        content: "First turn reply.",
        createdAt: "2026-03-23T00:01:00.000Z",
      });
      harness.appendJsonLine(harness.getStoryMessagesFile(story.id), {
        id: "msg_prepare_3",
        role: "user",
        content: "Second turn request.",
        createdAt: "2026-03-23T00:02:00.000Z",
      });
      harness.appendJsonLine(harness.getStoryMessagesFile(story.id), {
        id: "msg_prepare_4",
        role: "assistant",
        content: "Second turn reply.",
        createdAt: "2026-03-23T00:03:00.000Z",
      });
  
      harness.writeJsonLines(harness.getStoryMemoryFile(story.id), [
        {
          id: "mem_prepare_prev",
          summary: "A previous memory survives the rollback.",
        },
        {
          id: "mem_prepare_turn",
          summary: "A latest-turn memory should be removed.",
        },
      ]);
      harness.writeJsonLines(harness.getStoryMemoryChunkFile(story.id), [
        {
          id: "chunk_prepare_prev",
          text: "Previous evidence survives.",
        },
        {
          id: "chunk_prepare_turn",
          text: "Latest-turn evidence should be removed.",
        },
      ]);
      harness.writeJsonLines(harness.getStoryProposalFile(story.id), [
        {
          id: "proposal_prepare_turn",
          action: "update",
          targetType: "character",
          targetId: "char_hero",
          reason: "Update the hero after the latest turn.",
          diff: {
            notes: "Latest turn proposal note.",
          },
          status: "pending",
          createdAt: "2026-03-23T00:03:30.000Z",
        },
      ]);
      harness.writeJsonLines(harness.getStorySnapshotFile(story.id), [
        {
          at: "2026-03-23T00:01:30.000Z",
          contextStatus: previousContextStatus,
          generatedSummaryIds: [],
          generatedChunkIds: [],
          consolidatedMemorySourceIds: [],
          supersededLongTermIds: [],
          generatedProposalIds: [],
        },
        {
          at: "2026-03-23T00:04:00.000Z",
          contextStatus: latestContextStatus,
          generatedSummaryIds: ["mem_prepare_turn"],
          generatedChunkIds: ["chunk_prepare_turn"],
          consolidatedMemorySourceIds: [],
          supersededLongTermIds: [],
          generatedProposalIds: ["proposal_prepare_turn"],
        },
      ]);
  
      proposalTools.reviewProposal(story.id, "proposal_prepare_turn", "accept", "accept for prepare smoke");
      assert.equal(harness.readJson(workspacePath).notes, "Latest turn proposal note.");
  
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
          content: "Unused in prepare smoke.",
          meta: { endpoint: "http://example.test/chat/completions", latencyMs: 1, promptMessages: 1 },
        }),
        streamOpenAICompatible: async () => {
          throw new Error("Streaming should not be called in smoke tests");
        },
      });
  
      const prepared = chatTools.prepareReviseLastExchange(story.id);
  
      assert.equal(prepared.removedExchange.user.id, "msg_prepare_3");
      assert.equal(prepared.removedExchange.assistant.id, "msg_prepare_4");
      assert.deepEqual(
        harness.readJsonLines(harness.getStoryMessagesFile(story.id)).map((item) => item.id),
        ["msg_prepare_1", "msg_prepare_2"]
      );
      assert.deepEqual(
        harness.readJsonLines(harness.getStoryMemoryFile(story.id)).map((item) => item.id),
        ["mem_prepare_prev"]
      );
      assert.deepEqual(
        harness.readJsonLines(harness.getStoryMemoryChunkFile(story.id)).map((item) => item.id),
        ["chunk_prepare_prev"]
      );
      assert.equal(harness.readJsonLines(harness.getStoryProposalFile(story.id)).length, 0);
      assert.deepEqual(
        harness.readJsonLines(harness.getStorySnapshotFile(story.id)).map((item) => item.at),
        ["2026-03-23T00:01:30.000Z"]
      );
      assert.deepEqual(harness.getStory(story.id).contextStatus, previousContextStatus);
      assert.deepEqual(harness.readJson(workspacePath), beforeAccept);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
  
  await runTest("prepare revise followed by chat regenerates from the rolled-back turn like a fresh request", async () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      const story = harness.createDefaultStory({
        title: "Prepare Then Chat Smoke",
        providerId: "provider_1",
        model: "test-model",
        enabled: { characters: [], worldbooks: [], styles: [] },
      });
  
      let contextMessages = [];
      harness.writeJsonLines(harness.getStoryMessagesFile(story.id), [
        {
          id: "msg_fresh_1",
          role: "user",
          content: "Original setup.",
          createdAt: "2026-03-23T00:00:00.000Z",
        },
        {
          id: "msg_fresh_2",
          role: "assistant",
          content: "Original reply.",
          createdAt: "2026-03-23T00:01:00.000Z",
        },
        {
          id: "msg_fresh_3",
          role: "user",
          content: "Turn to replace.",
          createdAt: "2026-03-23T00:02:00.000Z",
        },
        {
          id: "msg_fresh_4",
          role: "assistant",
          content: "Reply to replace.",
          createdAt: "2026-03-23T00:03:00.000Z",
        },
      ]);
      harness.writeJsonLines(harness.getStorySnapshotFile(story.id), [
        {
          at: "2026-03-23T00:01:30.000Z",
          contextStatus: harness.getStory(story.id).contextStatus,
          generatedSummaryIds: [],
          generatedChunkIds: [],
          consolidatedMemorySourceIds: [],
          supersededLongTermIds: [],
          generatedProposalIds: [],
        },
        {
          at: "2026-03-23T00:03:30.000Z",
          contextStatus: {
            ...harness.getStory(story.id).contextStatus,
            usedTokens: 48,
            maxTokens: 100,
            usedBlocks: 6,
            maxBlocks: 20,
            pressureLevel: "medium",
          },
          generatedSummaryIds: [],
          generatedChunkIds: [],
          consolidatedMemorySourceIds: [],
          supersededLongTermIds: [],
          generatedProposalIds: [],
        },
      ]);
  
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
        buildContextBlocks: async (storyValue, messages) => {
          contextMessages = messages.map((item) => item.content);
          return {
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
          };
        },
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
          content: "Fresh regeneration.",
          meta: { endpoint: "http://example.test/chat/completions", latencyMs: 1, promptMessages: 1 },
        }),
        streamOpenAICompatible: async () => {
          throw new Error("Streaming should not be called in smoke tests");
        },
      });
  
      chatTools.prepareReviseLastExchange(story.id);
      const regenerated = await chatTools.handleChat(story.id, { message: "Replacement request." });
  
      assert.equal(regenerated.status, 200);
      assert.deepEqual(contextMessages, ["Original setup.", "Original reply.", "Replacement request."]);
      assert.deepEqual(
        harness.readJsonLines(harness.getStoryMessagesFile(story.id)).map((item) => item.content),
        ["Original setup.", "Original reply.", "Replacement request.", "Fresh regeneration."]
      );
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
  
};
