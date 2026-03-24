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
  function unique(values) {
    return Array.from(new Set((values || []).filter(Boolean)));
  }

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

  function selectFocusedAnchors(items = [], focusIds = [], fallbackCount = 1) {
    const source = Array.isArray(items) ? items : [];
    if (!source.length) {
      return [];
    }
    const ids = new Set((Array.isArray(focusIds) ? focusIds : []).map((item) => String(item || "").trim()).filter(Boolean));
    if (ids.size) {
      const selected = source.filter((item) => ids.has(String(item.id || item.name || item.title || "").trim()));
      if (selected.length) {
        return selected;
      }
    }
    return source.slice(0, Math.max(1, fallbackCount));
  }

  function formatMemoryEvidenceContext(chunks = []) {
    return (Array.isArray(chunks) ? chunks : [])
      .map((item, index) => {
        const meta = [];
        if (item?.linkedRecordId) {
          meta.push(`linked fact: ${item.linkedRecordId}`);
        }
        if (item?.sourceRole) {
          meta.push(`source: ${item.sourceRole}`);
        }
        if (Array.isArray(item?.sourceMessageRange) && item.sourceMessageRange.length === 2) {
          meta.push(`source turns: ${item.sourceMessageRange[0]}-${item.sourceMessageRange[1]}`);
        }
        if (Array.isArray(item?.subjectIds) && item.subjectIds.length) {
          meta.push(`subjects: ${item.subjectIds.join(", ")}`);
        }
        if (Array.isArray(item?.tags) && item.tags.length) {
          meta.push(`tags: ${item.tags.join(", ")}`);
        }
        if (Number.isFinite(Number(item?.confidence))) {
          meta.push(`confidence: ${Number(item.confidence).toFixed(2)}`);
        }
        return [`[Evidence ${index + 1}]`, item?.text || "", ...meta].filter(Boolean).join("\n");
      })
      .join("\n\n");
  }

  function buildMemoryGroundingText(memorySelection = {}) {
    const factCount = Array.isArray(memorySelection.selectedRecords) ? memorySelection.selectedRecords.length : 0;
    const evidenceCount = Array.isArray(memorySelection.selectedEvidenceChunks) ? memorySelection.selectedEvidenceChunks.length : 0;
    const contestedCount = Array.isArray(memorySelection.contestedRecords) ? memorySelection.contestedRecords.length : 0;
    if (!factCount && !evidenceCount) {
      return "";
    }
    return [
      "Memory grounding rules:",
      "- Treat stable and long-term memory facts as canon anchors.",
      "- Use retrieved memory evidence for scene-level detail, chronology, and cause-effect support.",
      "- When multiple memory cues differ, prefer the newer higher-confidence evidence only if it does not break stable canon.",
      contestedCount ? "- Some nearby memory candidates remain contested. Do not lock in disputed details unless the selected facts or evidence clearly resolve them." : "",
      "- If memory support is partial, stay conservative instead of inventing missing facts.",
      `Selected memory facts: ${factCount}. Retrieved evidence chunks: ${evidenceCount}. Contested candidates: ${contestedCount}.`,
    ].join("\n");
  }

  function formatMemoryUncertaintyContext(records = [], reasonsById = {}) {
    return (Array.isArray(records) ? records : [])
      .map((item, index) => {
        const meta = [];
        if (item?.scope) {
          meta.push(`scope: ${item.scope}`);
        }
        if (Array.isArray(item?.subjectIds) && item.subjectIds.length) {
          meta.push(`subjects: ${item.subjectIds.join(", ")}`);
        }
        if (Array.isArray(item?.sourceMessageRange) && item.sourceMessageRange.length === 2) {
          meta.push(`source turns: ${item.sourceMessageRange[0]}-${item.sourceMessageRange[1]}`);
        }
        if (Number.isFinite(Number(item?.confidence))) {
          meta.push(`confidence: ${Number(item.confidence).toFixed(2)}`);
        }
        return [
          `[Contested memory ${index + 1}]`,
          item?.summary || "",
          ...meta,
          ...(reasonsById?.[item.id] || []),
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");
  }

  function buildResponseGroundingPolicy({ memorySelection = {}, knowledgeSelection = {} } = {}) {
    const memoryFactCount = Array.isArray(memorySelection.selectedRecords) ? memorySelection.selectedRecords.length : 0;
    const memoryEvidenceCount = Array.isArray(memorySelection.selectedEvidenceChunks)
      ? memorySelection.selectedEvidenceChunks.length
      : 0;
    const contestedCount = Array.isArray(memorySelection.contestedRecords) ? memorySelection.contestedRecords.length : 0;
    const knowledgeCount = Array.isArray(knowledgeSelection.selectedChunks) ? knowledgeSelection.selectedChunks.length : 0;
    if (!memoryFactCount && !memoryEvidenceCount && !knowledgeCount) {
      return "";
    }
    return [
      "Grounding policy for this response:",
      "- Follow retrieved knowledge chunks and stable memory facts before improvising new canon.",
      "- Use retrieved memory evidence to support scene detail, chronology, and causal claims.",
      contestedCount
        ? "- If contested memory candidates remain unresolved, avoid stating the disputed detail as settled fact."
        : "- If support is thin, keep the answer minimal rather than inventing new canon.",
      "- Never mention source ids, block labels, retrieval, or diagnostics inside the in-story answer.",
      `Retrieved knowledge chunks: ${knowledgeCount}. Memory facts: ${memoryFactCount}. Memory evidence: ${memoryEvidenceCount}. Contested memory candidates: ${contestedCount}.`,
    ].join("\n");
  }

  async function buildContextBlocks(story, messages, memoryRecords, workspace, options = {}) {
    const blocks = [];
    const embeddingOptions = options.embeddingOptions || { mode: "off" };
    const memoryRetrievalMode = "rag";
    const knowledgeRetrievalMode = "rag";
    const useKnowledgeRag = true;
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
    const anchorHints = knowledgeSelection.anchorHints || {
      characterIds: [],
      worldbookIds: [],
      styleIds: [],
    };
    const focusedCharacters = selectFocusedAnchors(
      workspace.characters,
      unique([
        ...(anchorHints.characterIds || []),
        ...(knowledgeSelection.selectedChunks || [])
          .filter((item) => item.sourceType === "character")
          .map((item) => item.sourceId),
      ]),
      1
    );
    const focusedWorldbooks = selectFocusedAnchors(
      workspace.worldbooks,
      unique([
        ...(anchorHints.worldbookIds || []),
        ...(knowledgeSelection.selectedChunks || [])
          .filter((item) => item.sourceType === "worldbook")
          .map((item) => item.sourceId),
      ]),
      1
    );
    const focusedStyles = selectFocusedAnchors(
      workspace.styles,
      unique([
        ...(anchorHints.styleIds || []),
        ...(knowledgeSelection.selectedChunks || [])
          .filter((item) => item.sourceType === "style")
          .map((item) => item.sourceId),
      ]),
      1
    );

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
    pushBlock("style", buildStyleAnchorText(focusedStyles, { compact: useKnowledgeRag }), useKnowledgeRag ? 76 : 82);
    pushBlock(
      "characters",
      buildCharacterAnchorText(focusedCharacters, { compact: useKnowledgeRag }),
      useKnowledgeRag ? 80 : 90
    );
    pushBlock(
      "worldbook",
      buildWorldbookAnchorText(focusedWorldbooks, { compact: useKnowledgeRag }),
      useKnowledgeRag ? 78 : 88
    );

    const selectedLongTermMemory = memorySelection.selectedRecords.filter((item) => item.tier === "long_term");
    const selectedLongTermIds = new Set(selectedLongTermMemory.map((item) => item.id));
    const selectedCriticalMemory = memorySelection.selectedRecords.filter(
      (item) =>
        !selectedLongTermIds.has(item.id) && (item.importance === "high" || item.stability === "stable")
    );
    const selectedCriticalIds = new Set(selectedCriticalMemory.map((item) => item.id));
    const selectedRecentMemory = memorySelection.selectedRecords.filter(
      (item) => !selectedLongTermIds.has(item.id) && !selectedCriticalIds.has(item.id)
    );
    const selectedMemoryEvidence = memorySelection.selectedEvidenceChunks || [];
    const contestedMemoryRecords = memorySelection.contestedRecords || [];

    pushBlock("memory:grounding", buildMemoryGroundingText(memorySelection), 87);
    pushBlock(
      "system:retrieval_policy",
      buildResponseGroundingPolicy({ memorySelection, knowledgeSelection }),
      97
    );
    pushBlock("memory:long_term", formatMemoryContext(selectedLongTermMemory), 86);
    pushBlock("memory:critical", formatMemoryContext(selectedCriticalMemory.slice(0, 3)), 85);
    pushBlock("memory:recent", formatMemoryContext(selectedRecentMemory), 84);
    pushBlock("memory:evidence", formatMemoryEvidenceContext(selectedMemoryEvidence), 83);
    pushBlock(
      "memory:uncertainty",
      formatMemoryUncertaintyContext(contestedMemoryRecords, memorySelection.contestedReasonsById || {}),
      82
    );

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
      selectedContestedMemoryRecords: contestedMemoryRecords,
      selectedContestedMemoryReasons: memorySelection.contestedReasonsById || {},
      memoryRetrievalMeta: memorySelection.retrievalMeta || {
        mode: "rag",
        activeMode: "lexical",
        vectorEnabled: false,
        vectorCandidateCount: 0,
        vectorSelectedCount: 0,
        evidenceCandidateCount: 0,
        evidenceSelectedCount: 0,
        contestedCandidateCount: 0,
      },
      selectedMemoryGroups: {
        longTerm: selectedLongTermMemory,
        critical: selectedCriticalMemory.slice(0, 3),
        recent: selectedRecentMemory,
      },
      selectedKnowledgeChunks: knowledgeSelection.selectedChunks || [],
      knowledgeRetrievalMeta: knowledgeSelection.retrievalMeta || {
        mode: "rag",
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
