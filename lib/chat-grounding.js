function createChatGroundingTools({
  evaluateAssistantGrounding = () => null,
  buildEndpointUrl,
  callOpenAICompatible,
}) {
  function formatGroundingSupportRefs(refs = []) {
    return (Array.isArray(refs) ? refs : [])
      .slice(0, 2)
      .map((item) => {
        const sourceType = String(item?.sourceType || "")
          .replace(/_/g, " ")
          .trim();
        const matchedTerms = Array.isArray(item?.matchedTerms) ? item.matchedTerms.filter(Boolean) : [];
        const base = `${sourceType || "support"}: ${item?.preview || item?.label || item?.id || "source"}`;
        return matchedTerms.length ? `${base} [matched: ${matchedTerms.join(", ")}]` : base;
      })
      .join(" | ");
  }

  function formatGroundingClauses(clauses = [], options = {}) {
    const includeSupport = Boolean(options.includeSupport);
    return (Array.isArray(clauses) ? clauses : [])
      .slice(0, 3)
      .map((item) => {
        const reasons = Array.isArray(item?.reasons) ? item.reasons.filter(Boolean) : [];
        const rows = [reasons.length ? `- ${item.text} (${reasons.join("; ")})` : `- ${item.text}`];
        if (includeSupport && Array.isArray(item?.supportRefs) && item.supportRefs.length) {
          rows.push(`  Canon support: ${formatGroundingSupportRefs(item.supportRefs)}`);
        }
        if (includeSupport && Array.isArray(item?.contestedSupportRefs) && item.contestedSupportRefs.length) {
          rows.push(`  Contested support: ${formatGroundingSupportRefs(item.contestedSupportRefs)}`);
        }
        return rows.join("\n");
      })
      .join("\n");
  }

  function getGroundingStateRank(state) {
    const ranks = {
      grounded: 0,
      caution: 1,
      insufficient_context: 2,
      risk: 3,
    };
    return ranks[String(state || "").trim()] ?? 2;
  }

  function shouldAttemptGroundingRepair(groundingCheck) {
    if (!groundingCheck || groundingCheck.state !== "risk") {
      return false;
    }
    return (
      Number(groundingCheck.unsupportedClauseCount || 0) > 0 || Number(groundingCheck.contestedClauseCount || 0) > 0
    );
  }

  function didGroundingImprove(previousCheck, nextCheck) {
    if (!nextCheck) {
      return false;
    }
    const previousRank = getGroundingStateRank(previousCheck?.state);
    const nextRank = getGroundingStateRank(nextCheck?.state);
    if (nextRank < previousRank) {
      return true;
    }
    if (Number(nextCheck.unsupportedClauseCount || 0) < Number(previousCheck?.unsupportedClauseCount || 0)) {
      return true;
    }
    if (Number(nextCheck.contestedClauseCount || 0) < Number(previousCheck?.contestedClauseCount || 0)) {
      return true;
    }
    if (Number(nextCheck.supportedClauseCount || 0) > Number(previousCheck?.supportedClauseCount || 0)) {
      return true;
    }
    return false;
  }

  function buildGroundingRepairMessages(promptMessages, assistantText, groundingCheck) {
    const supportedSection = formatGroundingClauses(groundingCheck?.supportedClauses, { includeSupport: true });
    const unsupportedSection = formatGroundingClauses(groundingCheck?.unsupportedClauses, { includeSupport: true });
    const contestedSection = formatGroundingClauses(groundingCheck?.contestedClauses, { includeSupport: true });
    return [
      ...promptMessages,
      { role: "assistant", content: assistantText },
      {
        role: "system",
        content: [
          "Revise the previous assistant answer so every claim stays grounded in the retrieved canon.",
          "Keep the same scene intent and tone.",
          "Preserve clauses that are already grounded whenever possible.",
          "Only revise unsupported or contested clauses unless a tiny wording adjustment is needed for flow.",
          "Remove unsupported claims, and soften disputed claims into uncertainty instead of stating them as settled fact.",
          "If support is thin, prefer omission over invention.",
          "Prefer the smallest rewrite that fixes grounding.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          "Rewrite the previous assistant answer conservatively using the grounding report below.",
          supportedSection ? `Grounded clauses to preserve if possible:\n${supportedSection}` : "",
          unsupportedSection ? `Unsupported clauses to remove or rewrite:\n${unsupportedSection}` : "",
          contestedSection ? `Contested clauses to soften into uncertainty:\n${contestedSection}` : "",
          "Keep already grounded chronology, cause-and-effect, and character intent whenever support exists.",
          "Return only the corrected in-story answer.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ];
  }

  function buildGroundingInputs(contextInfo, assistantText) {
    return {
      assistantText,
      selectedKnowledgeChunks: contextInfo.selectedKnowledgeChunks || [],
      selectedMemoryRecords: contextInfo.selectedMemoryRecords || [],
      selectedMemoryEvidence: contextInfo.selectedMemoryEvidence || [],
      contestedMemoryRecords: contextInfo.selectedContestedMemoryRecords || [],
    };
  }

  async function maybeRepairGrounding({
    story,
    provider,
    apiKey,
    promptMessages,
    contextInfo,
    assistantText,
    completionMeta,
  }) {
    if (typeof evaluateAssistantGrounding !== "function") {
      return {
        assistantText,
        completionMeta,
        groundingCheck: null,
        groundingRepair: null,
      };
    }

    const initialGroundingCheck = evaluateAssistantGrounding(buildGroundingInputs(contextInfo, assistantText));
    const groundingRepair = {
      attempted: false,
      applied: false,
      initialState: initialGroundingCheck?.state || "not_checked",
      finalState: initialGroundingCheck?.state || "not_checked",
      retryPromptMessages: 0,
      retryLatencyMs: 0,
      notes: [],
    };

    if (!shouldAttemptGroundingRepair(initialGroundingCheck)) {
      groundingRepair.notes.push("Auto-repair was not needed for this reply.");
      return {
        assistantText,
        completionMeta,
        groundingCheck: initialGroundingCheck,
        groundingRepair,
      };
    }

    groundingRepair.attempted = true;
    groundingRepair.notes.push("Triggered one conservative rewrite pass because the first reply failed the grounding check.");
    const repairMessages = buildGroundingRepairMessages(promptMessages, assistantText, initialGroundingCheck);
    groundingRepair.retryPromptMessages = repairMessages.length;

    try {
      const repairedCompletion = await callOpenAICompatible({
        baseUrl: provider.baseUrl,
        apiKey,
        model: story.model || provider.model,
        messages: repairMessages,
        temperature: story.settings.temperature,
        topP: story.settings.topP,
        max_tokens: story.settings.maxCompletionTokens,
        reasoningEffort: story.settings.reasoningEffort,
      });
      const repairedText = String(repairedCompletion?.content || "").trim();
      groundingRepair.retryLatencyMs = Number(repairedCompletion?.meta?.latencyMs || 0);
      if (!repairedText) {
        groundingRepair.notes.push("Auto-repair returned empty content, so the original reply was kept.");
        return {
          assistantText,
          completionMeta,
          groundingCheck: initialGroundingCheck,
          groundingRepair,
        };
      }

      const repairedGroundingCheck = evaluateAssistantGrounding(buildGroundingInputs(contextInfo, repairedText));
      groundingRepair.finalState = repairedGroundingCheck?.state || groundingRepair.initialState;

      if (!didGroundingImprove(initialGroundingCheck, repairedGroundingCheck)) {
        groundingRepair.notes.push("Auto-repair did not improve grounding enough, so the original reply was kept.");
        return {
          assistantText,
          completionMeta: {
            ...completionMeta,
            latencyMs: Number(completionMeta?.latencyMs || 0) + groundingRepair.retryLatencyMs,
          },
          groundingCheck: initialGroundingCheck,
          groundingRepair,
        };
      }

      groundingRepair.applied = true;
      groundingRepair.notes.push("Applied the grounded rewrite because it reduced unsupported or contested claims.");
      return {
        assistantText: repairedText,
        completionMeta: {
          ...completionMeta,
          latencyMs: Number(completionMeta?.latencyMs || 0) + groundingRepair.retryLatencyMs,
        },
        groundingCheck: repairedGroundingCheck,
        groundingRepair,
      };
    } catch (error) {
      groundingRepair.notes.push(`Auto-repair failed and the original reply was kept: ${error.message || "Unknown error"}`);
      return {
        assistantText,
        completionMeta,
        groundingCheck: initialGroundingCheck,
        groundingRepair,
      };
    }
  }

  return {
    buildGroundingInputs,
    maybeRepairGrounding,
  };
}

module.exports = {
  createChatGroundingTools,
};
