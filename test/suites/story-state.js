const {
  assert,
  fs,
  createTempRoot,
  createStoreHarness,
  createStoryStateTools,
  STORY_STATE_SCHEMA_VERSION,
  safeId,
  createContextTools,
  createApiRouter,
} = require("../helpers/harness");

module.exports = async function runStoryStateTests(runTest) {
  await runTest("story state API reads projections and rejects invalid reviewed payloads", async () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      const story = harness.createDefaultStory({ title: "API Story" });
      const stateTools = createStoryStateTools({
        readJson: harness.readJson,
        writeJson: harness.writeJson,
        getStoryStateFile: harness.getStoryStateFile,
        getStory: harness.getStory,
        safeId,
      });
      const responses = [];
      const { routeApi } = createApiRouter({
        parseBody: async (req) => req.body || {},
        sendJson: (_res, status, data) => responses.push({ status, data }),
        notFound: () => responses.push({ status: 404, data: null }),
        loadStoriesIndex: harness.loadStoriesIndex,
        getStory: harness.getStory,
        loadProviders: () => [],
        saveProviders: () => {},
        canDecryptSecret: () => false,
        decryptSecret: () => "",
        callOpenAICompatible: async () => ({}),
        encryptSecret: () => null,
        testProviderConnection: async () => ({}),
        listJsonFiles: () => [],
        readJson: harness.readJson,
        getLibraryTypeDir: harness.getLibraryTypeDir,
        saveLibraryItem: harness.saveLibraryItem,
        deleteLibraryItem: harness.deleteLibraryItem,
        createDefaultStory: harness.createDefaultStory,
        saveStory: harness.saveStory,
        deleteStory: harness.deleteStory,
        syncStoryWorkspace: harness.workspaceTools.syncStoryWorkspace,
        handleChat: async () => ({ status: 200, data: {} }),
        handleChatStream: async () => {},
        prepareReviseLastExchange: () => {},
        reviseLastExchange: async () => ({ status: 200, data: {} }),
        buildStoryPreview: async () => ({}),
        getStoryStateView: stateTools.getStoryStateView,
        saveStoryState: stateTools.saveStoryState,
        reviewProposal: () => {},
        safeId,
        getAppConfig: () => ({}),
        getStoryWorkspaceDir: harness.getStoryWorkspaceDir,
        mergeAppConfigPatch: (_current, patch) => patch,
        getLocalEmbeddingRuntimeStatus: () => ({}),
        prewarmLocalEmbeddingModel: async () => ({}),
        buildNextStoryPromptConfig: (current) => current.promptConfig,
        buildNextStorySettings: (current) => current.settings,
        buildNextStoryEnabled: (current) => current.enabled,
        isSupportedLibraryType: () => true,
        writeJson: harness.writeJson,
        getAppConfigFile: harness.getAppConfigFile,
        DEFAULT_MAX_COMPLETION_TOKENS: 900,
      });

      await routeApi({ method: "PUT", url: `/api/stories/${story.id}/story-state`, body: {
        outlineNodes: [{ id: "chapter-1", title: "Opening", status: "active" }],
      } }, {});
      assert.equal(responses.at(-1).status, 200);
      assert.equal(responses.at(-1).data.currentOutline.id, "chapter-1");

      await routeApi({ method: "GET", url: `/api/stories/${story.id}/story-state` }, {});
      assert.equal(responses.at(-1).status, 200);
      assert.equal(responses.at(-1).data.counts.activeOutline, 1);

      await routeApi({ method: "PUT", url: `/api/stories/${story.id}/story-state`, body: {
        outlineNodes: [{ id: "chapter-1", parentId: "missing", title: "Broken" }],
      } }, {});
      assert.equal(responses.at(-1).status, 400);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  await runTest("reviewed story direction formats active outline and threads without claiming planned events happened", () => {
    const contextTools = createContextTools({
      DEFAULT_CONTEXT_BLOCKS: 6,
      estimateTokens: (value) => String(value || "").length,
      getProviderContextWindow: () => 32000,
      selectRelevantMemoryRecords: () => ({ selectedRecords: [], reasonsById: {} }),
    });
    const direction = contextTools.buildStoryDirectionText({
      currentOutline: { type: "chapter", title: "Below the rails", status: "active", summary: "Lyra follows the signal." },
      activePlotThreads: [{ title: "Find the archive", status: "active", currentGoal: "Reach the vault", nextStep: "Cross the drowned station" }],
    });
    assert.match(direction, /Below the rails/);
    assert.match(direction, /Cross the drowned station/);
    assert.match(direction, /not proof that planned events have already happened/);
    assert.equal(contextTools.buildStoryDirectionText({}), "");
    const mapContext = contextTools.buildStoryMapRetrievalText(
      {
        timelineEvents: [{ id: "event-1", title: "The drowned station opens", status: "canon", summary: "Lyra finds the archive." }],
        relationshipEvents: [{ id: "rel-1", sourceId: "lyra", targetId: "mira", type: "trust", label: "Uneasy allies", status: "canon" }],
      },
      { characters: [{ id: "lyra", name: "Lyra" }, { id: "mira", name: "Mira" }] },
      "What happened when Lyra found the archive?"
    );
    assert.match(mapContext, /drowned station/);
    assert.match(mapContext, /relevant to the current request/);
    assert.equal(contextTools.buildStoryMapRetrievalText({}, {}, "A completely unrelated question"), "");
  });

  await runTest("story state lazily supports old stories and persists reviewed structure", () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      const story = harness.createDefaultStory({ title: "Long Story" });
      fs.unlinkSync(harness.getStoryStateFile(story.id));
      const tools = createStoryStateTools({
        readJson: harness.readJson,
        writeJson: harness.writeJson,
        getStoryStateFile: harness.getStoryStateFile,
        getStory: harness.getStory,
        safeId,
      });

      const empty = tools.getStoryStateView(story.id);
      assert.equal(empty.schemaVersion, STORY_STATE_SCHEMA_VERSION);
      assert.deepEqual(empty.outlineNodes, []);
      assert.equal(fs.existsSync(harness.getStoryStateFile(story.id)), false);

      const saved = tools.saveStoryState(story.id, {
        plotThreads: [
          { id: "main-thread", kind: "main", title: "Find the archive", status: "active", currentGoal: "Reach the vault" },
        ],
        outlineNodes: [
          { id: "chapter-1", type: "chapter", title: "The sealed station", status: "completed", order: 1, plotThreadIds: ["main-thread"] },
          { id: "chapter-2", type: "chapter", title: "Below the rails", status: "active", order: 2, plotThreadIds: ["main-thread"] },
        ],
        timelineEvents: [
          { id: "event-1", title: "Lyra meets Mira", status: "canon", sortKey: 1, outlineNodeId: "chapter-1", characterIds: ["lyra", "mira"] },
        ],
        relationshipEvents: [
          { id: "rel-1", sourceId: "lyra", targetId: "mira", type: "trust", label: "Uneasy allies", status: "canon", sortKey: 1, timelineEventId: "event-1" },
          { id: "rel-2", sourceId: "lyra", targetId: "mira", type: "trust", label: "Trusted partners", status: "canon", sortKey: 2 },
        ],
      });

      assert.equal(saved.currentOutline.id, "chapter-2");
      assert.equal(saved.activePlotThreads[0].id, "main-thread");
      assert.equal(saved.currentRelationships.length, 1);
      assert.equal(saved.currentRelationships[0].label, "Trusted partners");
      assert.equal(saved.counts.canonTimelineEvents, 1);
      assert.equal(harness.readJson(harness.getStoryStateFile(story.id)).schemaVersion, STORY_STATE_SCHEMA_VERSION);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  await runTest("story state rejects broken references and invalid relationship endpoints", () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      const story = harness.createDefaultStory({ title: "Validation" });
      const tools = createStoryStateTools({
        readJson: harness.readJson,
        writeJson: harness.writeJson,
        getStoryStateFile: harness.getStoryStateFile,
        getStory: harness.getStory,
        safeId,
      });
      assert.throws(
        () => tools.saveStoryState(story.id, { outlineNodes: [{ id: "chapter-1", parentId: "missing", title: "Broken" }] }),
        /Unknown outline parent id/
      );
      assert.throws(
        () => tools.saveStoryState(story.id, { relationshipEvents: [{ id: "rel-1", sourceId: "lyra", targetId: "lyra" }] }),
        /two different character ids/
      );
      assert.throws(
        () => tools.saveStoryState(story.id, { outlineNodes: [
          { id: "chapter-1", parentId: "chapter-2", title: "One" },
          { id: "chapter-2", parentId: "chapter-1", title: "Two" },
        ] }),
        /parent cycle detected/
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
};
