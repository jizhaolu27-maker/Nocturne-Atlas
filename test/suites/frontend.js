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
            currentRelationships: [{ id: "rel-1", sourceId: "lyra", targetId: "mira", type: "attitude", label: "Trusted", status: "canon", direction: "directed", strength: 0.8 }],
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
      assert.match(els.storyMapContent.innerHTML, /<marker id="story-map-arrow"[^>]+><path d="M1,1 L11,6"><\/path>/);
      assert.match(els.storyMapContent.innerHTML, /Trusted/);
      const singleArrow = els.storyMapContent.innerHTML.match(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"[^>]+marker-end/);
      assert.ok(singleArrow);
      const targetNode = { x: 320, y: 268.8 };
      assert.ok(Math.hypot(Number(singleArrow[3]) - targetNode.x, Number(singleArrow[4]) - targetNode.y) >= 35);
      state.activeStoryData.storyState.currentRelationships.push({
        id: "rel-2", sourceId: "mira", targetId: "lyra", type: "tension", label: "Old debt", status: "canon", direction: "directed", strength: 0.4,
      });
      storyMap.renderStoryMap("relationships");
      const labelCoordinates = [...els.storyMapContent.innerHTML.matchAll(/<text x="([^"]+)" y="([^"]+)" transform="rotate\(([-\d.]+) [^"]+\)">(?:Trusted|Old debt)<\/text>/g)]
        .map((match) => `${match[1]},${match[2]}`);
      assert.equal(new Set(labelCoordinates).size, 2);
      const labelAngles = [...els.storyMapContent.innerHTML.matchAll(/<text x="[^"]+" y="[^"]+" transform="rotate\(([-\d.]+) [^"]+\)">(?:Trusted|Old debt)<\/text>/g)]
        .map((match) => Math.abs(Number(match[1])));
      assert.deepEqual(labelAngles, [90, 90]);
      const edgeLines = [...els.storyMapContent.innerHTML.matchAll(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/g)]
        .map((match) => match.slice(1).join(","));
      assert.equal(new Set(edgeLines).size, 2);
    } finally {
      global.window = previousWindow;
      global.document = previousDocument;
    }
  });
};
