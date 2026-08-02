const assert = require("node:assert/strict");

module.exports = async function runFrontendTests(runTest) {
  await runTest("frontend panel factories render empty states after modular split", () => {
    const previousWindow = global.window;
    const previousDocument = global.document;
    global.window = {};
    global.document = { querySelectorAll: () => [] };
    try {
      for (const file of [
        "../../public/app-review",
        "../../public/app-memory",
        "../../public/app-proposals",
        "../../public/app-diagnostics",
        "../../public/app-story-map",
      ]) {
        delete require.cache[require.resolve(file)];
        require(file);
      }

      const element = () => ({
        className: "",
        innerHTML: "",
        textContent: "",
        classList: { toggle() {} },
        closest: () => null,
        querySelectorAll: () => [],
      });
      const els = {
        chatStatus: element(),
        memoryList: element(),
        proposalList: element(),
        statusBlocks: element(),
        statusTokens: element(),
        statusPressure: element(),
        statusForgetfulness: element(),
        statusReasons: element(),
        diagnosticHighlights: element(),
        diagnosticWarnings: element(),
        diagnosticTriggers: element(),
        diagnosticContextBlocks: element(),
        diagnosticPromptPreview: element(),
        storyMapContent: element(),
        storyMapStatus: element(),
      };
      const state = {
        activeStoryData: {
          workspace: { characters: [{ id: "lyra", name: "Lyra" }, { id: "mira", name: "Mira" }] },
          storyState: {
            currentOutline: { id: "chapter-2", type: "chapter", title: "Below the rails", status: "active", summary: "Follow the signal." },
            activePlotThreads: [{ id: "thread-1", kind: "main", title: "Find the archive", status: "active", currentGoal: "Reach the vault" }],
            timelineEvents: [{ id: "event-1", title: "The station opens", status: "canon", sortKey: 1 }],
            currentRelationships: [{ id: "rel-1", sourceId: "lyra", targetId: "mira", type: "ally", label: "Trusted allies", status: "canon", direction: "mutual", strength: 0.8 }],
            counts: { activeOutline: 1, openPlotThreads: 1, canonTimelineEvents: 1, relationships: 1 },
          },
        },
        currentProposalTriggers: [],
        pendingProposalPipeline: null,
      };
      const escapeHtml = (value) => String(value || "");
      const review = window.createReviewTools({ state, els, escapeHtml });
      const memory = window.createMemoryUiTools({ els, escapeHtml });
      const proposals = window.createProposalUiTools({ state, els, escapeHtml });
      const diagnostics = window.createDiagnosticsTools({
        state,
        els,
        escapeHtml,
        buildProposalPipelineMessage: review.buildProposalPipelineMessage,
      });
      const storyMap = window.createStoryMapTools({ state, els, escapeHtml, api: async () => ({}) });

      review.renderChatStatus();
      review.renderStatusCurrent({});
      memory.renderMemory([]);
      proposals.renderProposals([]);
      diagnostics.renderDiagnosticsCurrent({});
      storyMap.renderStoryMap();

      assert.match(els.memoryList.innerHTML, /No memory summaries/);
      assert.match(els.proposalList.innerHTML, /no proposals/i);
      assert.match(els.diagnosticHighlights.innerHTML, /Retrieved context/);
      assert.match(els.diagnosticPromptPreview.innerHTML, /no final prompt preview/i);
      assert.match(els.storyMapContent.innerHTML, /Below the rails/);
      assert.match(els.storyMapContent.innerHTML, /Find the archive/);
      storyMap.renderStoryMap("relationships");
      assert.match(els.storyMapContent.innerHTML, /<svg/);
      assert.match(els.storyMapContent.innerHTML, /Trusted allies/);
    } finally {
      global.window = previousWindow;
      global.document = previousDocument;
    }
  });
};
