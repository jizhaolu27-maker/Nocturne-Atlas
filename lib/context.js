function createContextTools({
  DEFAULT_CONTEXT_BLOCKS,
  estimateTokens,
  selectRelevantMemoryRecords,
  formatMemoryContext,
  getProviderContextWindow,
}) {
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

  function buildContextBlocks(story, messages, memoryRecords, workspace, options = {}) {
    const blocks = [];
    const memorySelection = selectRelevantMemoryRecords(memoryRecords, {
      userMessage: options.currentUserInput || "",
      messages,
      workspace,
      maxItems: options.maxMemoryItems || 4,
    });
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

    const styleText = workspace.styles
      .map(
        (item) =>
          `${item.name}: tone=${item.tone || ""}; voice=${item.voice || ""}; pacing=${item.pacing || ""}; dos=${(item.dos || []).join(", ")}; donts=${(item.donts || []).join(", ")}`
      )
      .join("\n");
    pushBlock("style", styleText, 82);

    const characterText = workspace.characters
      .map((item) =>
        [
          `Character: ${item.name}`,
          `Role: ${item.core?.role || ""}`,
          `Traits: ${(item.traits || []).join(", ")}`,
          `Arc: ${item.arcState?.current || ""}`,
          `Relationships: ${Object.entries(item.relationships || {})
            .map(([name, relation]) => `${name}=${relation}`)
            .join(", ")}`,
          `Notes: ${item.notes || ""}`,
        ]
          .filter(Boolean)
          .join("\n")
      )
      .join("\n\n");
    pushBlock("characters", characterText, 90);

    const worldbookText = workspace.worldbooks
      .map((item) =>
        [
          `World: ${item.title}`,
          `Category: ${item.category || ""}`,
          `Rules: ${(item.rules || []).join("; ")}`,
          `Content: ${item.content || ""}`,
          `Revealed: ${(item.revealedFacts || []).join("; ")}`,
          `Story State: ${item.storyState || ""}`,
        ]
          .filter(Boolean)
          .join("\n")
      )
      .join("\n\n");
    pushBlock("worldbook", worldbookText, 88);

    const memoryText = formatMemoryContext(memorySelection.selectedRecords);
    pushBlock("memory", memoryText, 84);

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
