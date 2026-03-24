function createContextTools({
  DEFAULT_CONTEXT_BLOCKS,
  estimateTokens,
  selectRelevantMemoryRecords,
  formatMemoryContext,
  getProviderContextWindow,
  buildQueryEmbedding,
  retrieveKnowledgeChunks,
  formatKnowledgeContext,
}) {
  function normalizeStringList(value) {
    if (Array.isArray(value)) {
      return value.filter((item) => item != null && item !== "").map((item) => String(item));
    }
    if (typeof value === "string") {
      return value
        .split(/[;,\uFF0C\u3001]/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
    if (value && typeof value === "object") {
      return Object.values(value)
        .map((item) => String(item || "").trim())
        .filter(Boolean);
    }
    return [];
  }

  function buildHistoryTurnBlocks(messages, maxTurns = DEFAULT_CONTEXT_BLOCKS) {
    const turns = [];
    for (const message of messages) {
      if (message.role === "user") {
        turns.push({ user: message, assistant: null });
        continue;
      }
      if (message.role === "assistant" && turns.length > 0 && !turns[turns.length - 1].assistant) {
        turns[turns.length - 1].assistant = message;
        continue;
      }
      turns.push({ user: null, assistant: message });
    }
    const recentTurns = turns.slice(-Math.max(0, maxTurns));
    return recentTurns.map((turn, index) => ({
      label: `history_turn:${index}`,
      content: [turn.user ? `user: ${turn.user.content}` : "", turn.assistant ? `assistant: ${turn.assistant.content}` : ""]
        .filter(Boolean)
        .join("\n"),
      priority: 70 + index,
    }));
  }

  function buildCharacterAnchorText(characters = [], options = {}) {
    const compact = Boolean(options.compact);
    return characters
      .map((item) =>
        compact
          ? [
              `Character: ${item.name}`,
              item.core?.role ? `Role: ${item.core.role}` : "",
              item.arcState?.current ? `Arc: ${item.arcState.current}` : "",
            ]
              .filter(Boolean)
              .join(" / ")
          : [
              `Character: ${item.name}`,
              `Role: ${item.core?.role || ""}`,
              `Traits: ${normalizeStringList(item.traits).slice(0, 3).join(", ")}`,
              `Arc: ${item.arcState?.current || ""}`,
            ]
              .filter(Boolean)
              .join("\n")
      )
      .join(compact ? "\n" : "\n\n");
  }

  function buildWorldbookAnchorText(worldbooks = [], options = {}) {
    const compact = Boolean(options.compact);
    return worldbooks
      .map((item) =>
        compact
          ? [
              `World: ${item.title}`,
              item.category ? `Category: ${item.category}` : "",
              item.storyState ? `State: ${item.storyState}` : "",
            ]
              .filter(Boolean)
              .join(" / ")
          : [
              `World: ${item.title}`,
              `Rules: ${normalizeStringList(item.rules).slice(0, 3).join("; ")}`,
              `Story State: ${item.storyState || ""}`,
            ]
              .filter(Boolean)
              .join("\n")
      )
      .join(compact ? "\n" : "\n\n");
  }

  function buildStyleAnchorText(styles = [], options = {}) {
    const compact = Boolean(options.compact);
    return styles
      .map((item) =>
        compact
          ? [
              `Style: ${item.name}`,
              item.tone ? `Tone: ${item.tone}` : "",
              item.voice ? `Voice: ${item.voice}` : "",
            ]
              .filter(Boolean)
              .join(" / ")
          : `${item.name}: tone=${item.tone || ""}; voice=${item.voice || ""}; pacing=${item.pacing || ""}; dos=${normalizeStringList(item.dos).join(", ")}; donts=${normalizeStringList(item.donts).join(", ")}`
      )
      .join("\n");
  }

  function formatMemoryEvidenceContext(chunks = []) {
    return (Array.isArray(chunks) ? chunks : [])
      .map((item, index) => {
        const meta = [];
        if (item?.sourceRole) {
          meta.push(`source: ${item.sourceRole}`);
        }
        if (Array.isArray(item?.subjectIds) && item.subjectIds.length) {
          meta.push(`subjects: ${item.subjectIds.join(", ")}`);
        }
        if (Array.isArray(item?.tags) && item.tags.length) {
          meta.push(`tags: ${item.tags.join(", ")}`);
        }
        return [`[Evidence ${index + 1}]`, item?.text || "", ...meta].filter(Boolean).join("\n");
      })
      .join("\n\n");
  }

  async function buildContextBlocks(story, messages, memoryRecords, workspace, options = {}) {
    const blocks = [];
    const embeddingOptions = options.embeddingOptions || { mode: "off" };
    const memoryRetrievalMode = options.memoryRetrievalMode || options.retrievalMode || "lexical";
    const knowledgeRetrievalMode = options.knowledgeRetrievalMode || "lexical";
    const useKnowledgeRag = knowledgeRetrievalMode === "hybrid" && embeddingOptions.mode === "on";
    const queryEmbedding =
      options.queryEmbedding ||
      (embeddingOptions.mode === "on" && typeof buildQueryEmbedding === "function"
        ? await buildQueryEmbedding({
            story,
            userMessage: options.currentUserInput || "",
            messages,
            workspace,
            embeddingOptions,
          })
        : null);
    const memorySelection = selectRelevantMemoryRecords(memoryRecords, {
      story,
      userMessage: options.currentUserInput || "",
      messages,
      workspace,
      memoryChunks: options.memoryChunks || [],
      retrievalMode: memoryRetrievalMode,
      embeddingOptions,
      queryEmbedding,
      maxItems: options.maxMemoryItems || 4,
      maxEvidenceItems: options.maxMemoryEvidenceItems || 3,
    });
    const knowledgeSelection =
      typeof retrieveKnowledgeChunks === "function"
        ? await retrieveKnowledgeChunks({
            story,
            workspace,
            messages,
            userMessage: options.currentUserInput || "",
            retrievalMode: knowledgeRetrievalMode,
            embeddingOptions,
            maxItems: options.maxKnowledgeItems || (useKnowledgeRag ? 6 : 4),
          })
        : {
            selectedChunks: [],
            retrievalMeta: {
              mode: knowledgeRetrievalMode,
              activeMode: "lexical",
              vectorEnabled: false,
              vectorCandidateCount: 0,
              vectorSelectedCount: 0,
              chunkCount: 0,
            },
          };
    const pushBlock = (label, content, priority) => {
      if (!content) {
        return;
      }
      blocks.push({
        label,
        priority,
        content,
        tokens: estimateTokens(content),
      });
    };

    pushBlock("system:global", story.promptConfig.globalSystemPrompt, 100);
    pushBlock("system:story", story.promptConfig.storySystemPrompt, 95);
    pushBlock(
      "knowledge:retrieved",
      formatKnowledgeContext ? formatKnowledgeContext(knowledgeSelection.selectedChunks) : "",
      useKnowledgeRag ? 93 : 92
    );
    pushBlock("style", buildStyleAnchorText(workspace.styles, { compact: useKnowledgeRag }), useKnowledgeRag ? 76 : 82);
    pushBlock(
      "characters",
      buildCharacterAnchorText(workspace.characters, { compact: useKnowledgeRag }),
      useKnowledgeRag ? 80 : 90
    );
    pushBlock(
      "worldbook",
      buildWorldbookAnchorText(workspace.worldbooks, { compact: useKnowledgeRag }),
      useKnowledgeRag ? 78 : 88
    );

    const selectedLongTermMemory = memorySelection.selectedRecords.filter((item) => item.tier === "long_term");
    const selectedCriticalMemory = memorySelection.selectedRecords.filter(
      (item) => item.importance === "high" || item.stability === "stable"
    );
    const selectedRecentMemory = memorySelection.selectedRecords.filter((item) => item.tier !== "long_term");
    const selectedMemoryEvidence = memorySelection.selectedEvidenceChunks || [];

    pushBlock("memory:long_term", formatMemoryContext(selectedLongTermMemory), 86);
    pushBlock("memory:critical", formatMemoryContext(selectedCriticalMemory.slice(0, 3)), 85);
    pushBlock("memory:recent", formatMemoryContext(selectedRecentMemory), 84);
    pushBlock("memory:evidence", formatMemoryEvidenceContext(selectedMemoryEvidence), 83);

    const maxBlocks = story.settings.contextBlocks ?? DEFAULT_CONTEXT_BLOCKS;
    buildHistoryTurnBlocks(messages, maxBlocks).forEach((block) => {
      pushBlock(block.label, block.content, block.priority);
    });

    const maxTokens = getProviderContextWindow(story);
    const selected = [];
    let usedTokens = 0;
    let usedHistoryTurns = 0;
    const sorted = blocks.sort((a, b) => b.priority - a.priority);
    for (const block of sorted) {
      const isHistoryTurn = block.label.startsWith("history_turn:");
      if (isHistoryTurn && usedHistoryTurns >= maxBlocks) {
        continue;
      }
      if (usedTokens + block.tokens > Math.floor(maxTokens * 0.82) && selected.length > 4) {
        continue;
      }
      selected.push(block);
      usedTokens += block.tokens;
      if (isHistoryTurn) {
        usedHistoryTurns += 1;
      }
    }
    return {
      blocks: selected.sort((a, b) => a.priority - b.priority),
      usedTokens,
      maxTokens,
      usedBlocks: usedHistoryTurns,
      maxBlocks,
      selectedMemoryRecords: memorySelection.selectedRecords,
      selectedMemoryReasons: memorySelection.reasonsById,
      selectedMemoryEvidence,
      selectedMemoryEvidenceReasons: memorySelection.selectedEvidenceReasons || {},
      memoryRetrievalMeta: memorySelection.retrievalMeta || {
        mode: "lexical",
        vectorEnabled: false,
        vectorCandidateCount: 0,
        vectorSelectedCount: 0,
        evidenceCandidateCount: 0,
        evidenceSelectedCount: 0,
      },
      selectedMemoryGroups: {
        longTerm: selectedLongTermMemory,
        critical: selectedCriticalMemory.slice(0, 3),
        recent: selectedRecentMemory,
      },
      selectedKnowledgeChunks: knowledgeSelection.selectedChunks || [],
      knowledgeRetrievalMeta: knowledgeSelection.retrievalMeta || {
        mode: knowledgeRetrievalMode,
        chunkCount: 0,
        activeMode: "lexical",
      },
    };
  }

  function classifyPressure(usedTokens, maxTokens) {
    const ratio = maxTokens ? usedTokens / maxTokens : 0;
    if (ratio >= 0.82) {
      return "high";
    }
    if (ratio >= 0.6) {
      return "medium";
    }
    return "low";
  }

  function getDefaultContextStatus(story) {
    return {
      usedTokens: 0,
      maxTokens: getProviderContextWindow(story),
      usedBlocks: 0,
      maxBlocks: story.settings?.contextBlocks ?? DEFAULT_CONTEXT_BLOCKS,
      pressureLevel: "low",
      forgetfulnessState: "normal",
      forgetfulnessReasons: [],
      forgetfulnessSignals: {
        pressure: [],
        omission: [],
        conflict: [],
      },
    };
  }

  return {
    buildHistoryTurnBlocks,
    buildContextBlocks,
    classifyPressure,
    getDefaultContextStatus,
  };
}

module.exports = {
  createContextTools,
};
