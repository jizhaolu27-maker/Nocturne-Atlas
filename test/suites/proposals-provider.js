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

module.exports = async function runProposalsProviderTests(runTest) {
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
        assert.match(systemPrompt, /only sourceId's current attitude toward targetId/);
        assert.match(systemPrompt, /two relationship proposals with reversed sourceId and targetId/);
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
              {
                action: "update",
                targetType: "story_state",
                targetId: "story-map",
                reason: "Lyra now cares about Mira.",
                patch: { kind: "relationship", item: { id: "rel-lyra-mira", sourceId: "lyra", targetId: "mira", type: "attitude", label: "在意", direction: "directed", status: "canon" } },
              },
              {
                action: "update",
                targetType: "story_state",
                targetId: "story-map",
                reason: "Mira sees Lyra as her light.",
                patch: { kind: "relationship", item: { id: "rel-mira-lyra", sourceId: "mira", targetId: "lyra", type: "attitude", label: "光", direction: "directed", status: "canon" } },
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
      workspace: { characters: [{ id: "lyra", name: "Lyra" }, { id: "mira", name: "Mira" }], worldbooks: [], styles: [] },
      assistantText: "Shade steps fully into the story as a recurring dream guide.",
    });
  
    assert.equal(update.proposalRecords.length, 3);
    assert.equal(update.proposalRecords[0].targetId, "char_shade");
    assert.deepEqual(update.proposalRecords.slice(1).map((item) => [item.diff.item.sourceId, item.diff.item.targetId, item.diff.item.label]), [
      ["lyra", "mira", "在意"],
      ["mira", "lyra", "光"],
    ]);
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
  
};
