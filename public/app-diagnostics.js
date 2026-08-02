window.createDiagnosticsTools = function createDiagnosticsTools({
  state,
  els,
  escapeHtml,
  buildProposalPipelineMessage,
}) {
  function formatContextLabel(label) {
    const value = String(label || "");
    if (value === "system:global") return "Global system prompt";
    if (value === "system:story") return "Story system prompt";
    if (value === "system:retrieval_policy") return "Retrieval grounding policy";
    if (value === "knowledge:retrieved") return "Retrieved knowledge chunks";
    if (value === "style") return "Style anchors";
    if (value === "characters") return "Character anchors";
    if (value === "worldbook") return "Worldbook anchors";
    if (value === "story:direction") return "Reviewed story direction";
    if (value === "memory") return "Story memory summary";
    if (value === "memory:grounding") return "Memory grounding rules";
    if (value === "memory:long_term") return "Long-term memory";
    if (value === "memory:critical") return "Critical memory";
    if (value === "memory:recent") return "Recent memory";
    if (value === "memory:evidence") return "Retrieved memory evidence";
    if (value === "memory:uncertainty") return "Contested memory candidates";
    const historyTurn = value.match(/^history_turn:(\d+)$/);
    if (historyTurn) {
      return `Recent conversation turn ${Number(historyTurn[1]) + 1}`;
    }
    return value;
  }

  function summarizeContextSources(blocks) {
    const labels = (blocks || []).map((item) => String(item.label || ""));
    const basicSources = [];
    if (labels.includes("system:global")) basicSources.push("Global system prompt");
    if (labels.includes("system:story")) basicSources.push("Story system prompt");
    if (labels.includes("system:retrieval_policy")) basicSources.push("Retrieval grounding policy");
    if (labels.includes("knowledge:retrieved")) basicSources.push("Retrieved knowledge");
    if (labels.includes("characters")) basicSources.push("Character anchors");
    if (labels.includes("worldbook")) basicSources.push("Worldbook anchors");
    if (labels.includes("style")) basicSources.push("Style anchors");
    if (labels.includes("story:direction")) basicSources.push("Reviewed story direction");
    if (labels.includes("memory")) basicSources.push("Story memory");
    if (labels.includes("memory:grounding")) basicSources.push("Memory grounding rules");
    if (labels.includes("memory:long_term")) basicSources.push("Long-term memory");
    if (labels.includes("memory:critical")) basicSources.push("Critical memory");
    if (labels.includes("memory:recent")) basicSources.push("Recent memory");
    if (labels.includes("memory:evidence")) basicSources.push("Retrieved memory evidence");
    if (labels.includes("memory:uncertainty")) basicSources.push("Contested memory candidates");
    const historyTurns = labels.filter((item) => item.startsWith("history_turn:")).length;
    if (!basicSources.length && historyTurns === 0) {
      return "There are no context sources to display for this preview yet.";
    }
    return `Included in this run: ${basicSources.length ? basicSources.join(", ") : "no base sources"}; history turns: ${historyTurns}.`;
  }

  function formatMemoryKind(kind) {
    const labels = {
      relationship_update: "Relationship change",
      world_state: "World state",
      character_update: "Character change",
      plot_checkpoint: "Plot checkpoint",
    };
    return labels[kind] || kind || "Uncategorized";
  }

  function formatMemoryTier(tier) {
    return tier === "long_term" ? "Long-term Memory" : "Short-term Memory";
  }

  function formatMemoryScope(scope) {
    const labels = {
      character: "Character",
      relationship: "Relationship",
      world: "World",
      plot: "Plot",
    };
    return labels[scope] || scope || "Uncategorized";
  }

  function buildCanonMetaLines(item) {
    const lines = [];
    if (item?.conflictGroup) {
      lines.push(`Conflict group: ${item.conflictGroup}`);
    }
    if (item?.canonKey) {
      lines.push(`Canon key: ${item.canonKey}`);
    }
    return lines;
  }

  function formatGroundingSupportSourceType(sourceType) {
    const labels = {
      knowledge: "Knowledge",
      memory_fact: "Memory fact",
      memory_evidence: "Memory evidence",
      contested_memory: "Contested memory",
    };
    return labels[String(sourceType || "").trim()] || "Support";
  }

  function renderGroundingSupportRefs(label, refs) {
    const rows = Array.isArray(refs) ? refs.filter(Boolean) : [];
    if (!rows.length) {
      return "";
    }
    return `<div>${escapeHtml(
      `${label} ${rows
        .slice(0, 2)
        .map((item) => {
          const base = `${formatGroundingSupportSourceType(item.sourceType)}: ${item.preview || item.label || item.id || "source"}`;
          return Array.isArray(item.matchedTerms) && item.matchedTerms.length
            ? `${base} [${item.matchedTerms.join(", ")}]`
            : base;
        })
        .join(" / ")}`
    )}</div>`;
  }

  function formatSummaryTrigger(trigger) {
    const value = String(trigger || "");
    if (value.startsWith("Turn interval reached")) return "Configured turn interval reached";
    if (value === "Context pressure exceeded high threshold") return "Context pressure exceeded the high threshold";
    if (value === "Major event keywords detected in recent turns") return "Major event keywords were detected in recent turns";
    if (value === "Memory consolidation threshold reached") return "Short-term memory reached the consolidation threshold";
    return value || "Unknown trigger reason";
  }

  function formatSummarySchedule(schedule) {
    if (!schedule?.configuredRounds) {
      return "";
    }
    const nextRound = Number(schedule.nextRound);
    const remainingRounds = Number(schedule.remainingRounds);
    if (!Number.isFinite(nextRound) || !Number.isFinite(remainingRounds)) {
      return "";
    }
    return `Configured to summarize every ${schedule.configuredRounds} turns. If nothing triggers early, the next summary is on turn ${nextRound}, in ${remainingRounds} more turns.`;
  }

  function formatKnowledgeRetrievalMode(mode) {
    const normalized = String(mode || "").trim().toLowerCase();
    if (normalized === "rag") {
      return "knowledge RAG";
    }
    if (normalized === "hybrid") {
      return "semantic + lexical";
    }
    return "lexical fallback";
  }

  function formatMemoryRetrievalMode(mode) {
    const normalized = String(mode || "").trim().toLowerCase();
    if (normalized === "rag") {
      return "memory RAG";
    }
    if (normalized === "hybrid") {
      return "semantic + lexical";
    }
    return "lexical fallback";
  }

  function formatRetrievalRoute(route) {
    const normalized = String(route || "").trim().toLowerCase();
    if (normalized === "memory_heavy") {
      return "memory-heavy";
    }
    if (normalized === "knowledge_heavy") {
      return "knowledge-heavy";
    }
    if (normalized === "balanced") {
      return "balanced";
    }
    return normalized || "unknown";
  }

  function formatRetrievalFocusSource(source) {
    const normalized = String(source || "").trim().toLowerCase();
    if (normalized === "current_input") {
      return "current user input";
    }
    if (normalized === "recent_turns") {
      return "recent turns";
    }
    return "no explicit focus";
  }

  function getRetrievalSourceMeta(reasons) {
    const rows = Array.isArray(reasons) ? reasons.filter(Boolean) : [];
    const hasVector = rows.some((item) => /vector|\u5411\u91cf/i.test(String(item)));
    const hasLexical = rows.some((item) => /keyword|entity|\u5173\u952e\u8bcd|\u5b9e\u4f53/i.test(String(item)));
    if (hasVector && hasLexical) {
      return { label: "lexical + embedding", tone: "hybrid" };
    }
    if (hasVector) {
      return { label: "embedding", tone: "vector" };
    }
    return { label: "lexical", tone: "lexical" };
  }

  function getSemanticCandidateMeta(reasons) {
    const rows = Array.isArray(reasons) ? reasons.filter(Boolean) : [];
    return rows.some((item) => /semantic-only/i.test(String(item)))
      ? { label: "semantic-only rescue", tone: "vector" }
      : null;
  }

  function renderDiagnosticBadges(items) {
    const rows = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!rows.length) {
      return "";
    }
    return `<div class="diagnostic-badges">${rows
      .map((item) => `<span class="diagnostic-badge ${item.tone ? `diagnostic-badge-${item.tone}` : ""}">${escapeHtml(item.label || item)}</span>`)
      .join("")}</div>`;
  }

  function renderDiagnosticsCurrent(diagnostics) {
    const snapshot = diagnostics.latestSnapshot || null;
    const requestMeta = snapshot?.requestMeta || diagnostics.requestMeta || null;
    const preview = diagnostics.currentContextPreview || null;
    const retrievalPlan = preview?.retrievalPlan || diagnostics.retrievalPlan || snapshot?.retrievalPlan || null;
    const retrievalFusionMeta =
      preview?.retrievalFusionMeta || diagnostics.retrievalFusionMeta || snapshot?.retrievalFusionMeta || null;
    const retrievalMeta = preview?.memoryRetrievalMeta || diagnostics.memoryRetrievalMeta || snapshot?.memoryRetrievalMeta || null;
    const knowledgeRetrievalMeta =
      preview?.knowledgeRetrievalMeta || diagnostics.knowledgeRetrievalMeta || snapshot?.knowledgeRetrievalMeta || null;
    const blocks = preview?.contextBlocks || snapshot?.contextBlocks || [];
    const promptMessages = preview?.promptMessages || snapshot?.promptMessages || [];
    const summarySchedule = snapshot?.summarySchedule || diagnostics.summarySchedule || null;
    const groundingCheck = snapshot?.groundingCheck || diagnostics.groundingCheck || null;
    const groundingRepair = snapshot?.groundingRepair || diagnostics.groundingRepair || null;
    const highlightRows = [];
    const warningRows = [];
    const technicalRows = [];

    if (blocks.length) {
      technicalRows.push(`
        <article class="diagnostic-item diagnostic-summary">
          <strong>Context Summary</strong>
          <span>${escapeHtml(summarizeContextSources(blocks))}</span>
        </article>
      `);
    }
    if (requestMeta) {
      technicalRows.push(`
        <article class="diagnostic-item">
          <strong>Request Info</strong>
          <span>${escapeHtml(requestMeta.endpoint || "")}</span>
          <div>Latency: ${escapeHtml(String(requestMeta.latencyMs || "n/a"))} ms</div>
          <div>Prompt messages: ${escapeHtml(String(requestMeta.promptMessages || 0))}</div>
          <div>Output chars: ${escapeHtml(String(requestMeta.completionChars || 0))}</div>
          <div>Summaries: ${escapeHtml(String(snapshot?.generatedSummaryCount || diagnostics.generatedSummaryCount || 0))} / Proposals: ${escapeHtml(String(snapshot?.generatedProposalCount || diagnostics.generatedProposalCount || 0))}</div>
        </article>
      `);
    }
    if (retrievalPlan) {
      const routeTone =
        retrievalPlan.route === "knowledge_heavy"
          ? "hybrid"
          : retrievalPlan.route === "memory_heavy"
            ? "neutral"
            : "neutral";
      technicalRows.push(`
        <article class="diagnostic-item">
          <strong>Retrieval Routing</strong>
          ${renderDiagnosticBadges([
            { label: `route: ${formatRetrievalRoute(retrievalPlan.route)}`, tone: routeTone },
            { label: `focus: ${formatRetrievalFocusSource(retrievalPlan.focusSource)}`, tone: "neutral" },
          ])}
          <span>${escapeHtml(`Memory score ${retrievalPlan.scores?.memory || 0} / knowledge score ${retrievalPlan.scores?.knowledge || 0} / scene score ${retrievalPlan.scores?.scene || 0}`)}</span>
          <div>${escapeHtml(`Budgets -> memory facts ${retrievalPlan.budgets?.memoryItems || 0} / memory evidence ${retrievalPlan.budgets?.memoryEvidenceItems || 0} / knowledge chunks ${retrievalPlan.budgets?.knowledgeItems || 0}`)}</div>
          <div>${escapeHtml(`Entity focus ${retrievalPlan.scores?.entityFocus || 0} / world focus ${retrievalPlan.scores?.worldFocus || 0} / style focus ${retrievalPlan.scores?.styleFocus || 0}`)}</div>
          ${(retrievalPlan.reasons || []).map((item) => `<div>${escapeHtml(item)}</div>`).join("")}
        </article>
      `);
    }
    if (retrievalFusionMeta) {
      technicalRows.push(`
        <article class="diagnostic-item">
          <strong>Retrieval Fusion</strong>
          ${renderDiagnosticBadges([
            { label: `route: ${formatRetrievalRoute(retrievalFusionMeta.route)}`, tone: retrievalFusionMeta.route === "knowledge_heavy" ? "hybrid" : "neutral" },
            { label: `budget ${retrievalFusionMeta.totalBudget || 0}`, tone: "neutral" },
          ])}
          <span>${escapeHtml(`Candidates ${retrievalFusionMeta.totalCandidateCount || 0} / selected ${retrievalFusionMeta.totalSelectedCount || 0}`)}</span>
          <div>${escapeHtml(`Family budgets -> facts ${retrievalFusionMeta.familyBudgets?.factBudget || 0} / evidence ${retrievalFusionMeta.familyBudgets?.evidenceBudget || 0} / knowledge ${retrievalFusionMeta.familyBudgets?.knowledgeBudget || 0}`)}</div>
          <div>${escapeHtml(`Selected -> facts ${retrievalFusionMeta.selectedCounts?.memoryFacts || 0} / evidence ${retrievalFusionMeta.selectedCounts?.memoryEvidence || 0} / knowledge ${retrievalFusionMeta.selectedCounts?.knowledge || 0}`)}</div>
          ${
            Array.isArray(retrievalFusionMeta.topSources) && retrievalFusionMeta.topSources.length
              ? `<div>${escapeHtml(`Top fused sources: ${retrievalFusionMeta.topSources.map((item) => `${item.family}:${item.id} (${item.score})`).join(" / ")}`)}</div>`
              : ""
          }
        </article>
      `);
    }
    if (groundingCheck) {
      const stateTone =
        groundingCheck.state === "grounded"
          ? "hybrid"
          : groundingCheck.state === "risk"
            ? "lexical"
            : "neutral";
      const groundingSummary = `
        <article class="diagnostic-item">
          <strong>Grounding Check</strong>
          ${renderDiagnosticBadges([{ label: groundingCheck.state || "unknown", tone: stateTone }])}
          <span>${escapeHtml(`Supported clauses ${groundingCheck.supportedClauseCount || 0} / unsupported ${groundingCheck.unsupportedClauseCount || 0} / contested ${groundingCheck.contestedClauseCount || 0}`)}</span>
          <div>${escapeHtml(`Knowledge-backed ${groundingCheck.knowledgeSupportCount || 0} / memory-fact-backed ${groundingCheck.memoryFactSupportCount || 0} / memory-evidence-backed ${groundingCheck.memoryEvidenceSupportCount || 0}`)}</div>
          ${(groundingCheck.notes || []).map((item) => `<div>${escapeHtml(item)}</div>`).join("")}
        </article>
      `;
      if (groundingCheck.state === "grounded") {
        technicalRows.push(groundingSummary);
      } else {
        warningRows.push(groundingSummary);
      }
    }
    if (groundingRepair?.attempted || groundingRepair?.applied) {
      const repairBadges = [
        {
          label: groundingRepair.applied ? "applied" : "kept original",
          tone: groundingRepair.applied ? "hybrid" : "neutral",
        },
        {
          label: `${groundingRepair.initialState || "unknown"} -> ${groundingRepair.finalState || groundingRepair.initialState || "unknown"}`,
          tone: groundingRepair.applied ? "vector" : "neutral",
        },
      ];
      warningRows.push(`
        <article class="diagnostic-item">
          <strong>Grounding Repair</strong>
          ${renderDiagnosticBadges(repairBadges)}
          <span>${escapeHtml(`Retry prompt messages ${groundingRepair.retryPromptMessages || 0} / retry latency ${groundingRepair.retryLatencyMs || 0} ms`)}</span>
          ${(groundingRepair.notes || []).map((item) => `<div>${escapeHtml(item)}</div>`).join("")}
        </article>
      `);
    }
    if (preview?.contextStatus) {
      technicalRows.push(`
        <article class="diagnostic-item">
          <strong>Current Preview</strong>
          <span>${escapeHtml(`${preview.contextStatus.usedBlocks || 0}/${preview.contextStatus.maxBlocks || 0} context turns`)}</span>
          <div>${escapeHtml(`${preview.contextStatus.usedTokens || 0}/${preview.contextStatus.maxTokens || 0} estimated tokens`)}</div>
          <div>${escapeHtml(`Risk state: ${preview.contextStatus.forgetfulnessState || "normal"}`)}</div>
        </article>
      `);
    }
    const activeSignals = preview?.contextStatus?.forgetfulnessSignals || snapshot?.contextStatus?.forgetfulnessSignals || null;
    if (activeSignals && ((activeSignals.pressure || []).length || (activeSignals.omission || []).length || (activeSignals.conflict || []).length)) {
      const rows = [];
      rows.push(...(activeSignals.pressure || []).map((item) => `System pressure: ${item}`));
      rows.push(...(activeSignals.omission || []).map((item) => `Omission risk: ${item}`));
      rows.push(...(activeSignals.conflict || []).map((item) => `Conflict risk: ${item}`));
      warningRows.push(`
        <article class="diagnostic-item">
          <strong>Memory Risk Breakdown</strong>
          <span>${escapeHtml(rows.join(" / "))}</span>
        </article>
      `);
    }
    if (summarySchedule?.configuredRounds) {
      technicalRows.push(`
        <article class="diagnostic-item">
          <strong>Summary Schedule</strong>
          <span>${escapeHtml(formatSummarySchedule(summarySchedule))}</span>
        </article>
      `);
    }
    const transientMemoryCandidate =
      snapshot?.transientMemoryCandidate || diagnostics.transientMemoryCandidate || null;
    const generatedSummaryCount = snapshot?.generatedSummaryCount || diagnostics.generatedSummaryCount || 0;
    const generatedEpisodicChunkCount =
      snapshot?.generatedEpisodicChunkCount || diagnostics.generatedEpisodicChunkCount || 0;
    const generatedSummaryChunkCount =
      snapshot?.generatedSummaryChunkCount || diagnostics.generatedSummaryChunkCount || 0;
    if (generatedSummaryCount > 0 || generatedEpisodicChunkCount > 0 || generatedSummaryChunkCount > 0) {
      highlightRows.push(`
        <article class="diagnostic-item">
          <strong>Memory Writes</strong>
          ${renderDiagnosticBadges([{ label: "written to memory", tone: "hybrid" }])}
          ${
            generatedSummaryCount
              ? `<span>${escapeHtml(`${generatedSummaryCount} formal memory record(s) were written this turn`)}</span>`
              : `<span>${escapeHtml("No formal summary record was written this turn.")}</span>`
          }
          ${
            generatedEpisodicChunkCount
              ? `<div>${escapeHtml(`${generatedEpisodicChunkCount} episodic memory chunk(s) were indexed from the latest turn`)}</div>`
              : ""
          }
          ${
            generatedSummaryChunkCount
              ? `<div>${escapeHtml(`${generatedSummaryChunkCount} summary-linked evidence chunk(s) were also indexed`)}</div>`
              : ""
          }
        </article>
      `);
    } else if (transientMemoryCandidate?.summary) {
      technicalRows.push(`
        <article class="diagnostic-item">
          <strong>Memory Writes</strong>
          ${renderDiagnosticBadges([
            { label: "diagnostic-only candidate", tone: "neutral" },
            { label: formatMemoryScope(transientMemoryCandidate.scope), tone: "neutral" },
          ])}
          <span>${escapeHtml("No formal memory was written this turn. This temporary summary is only used for forgetfulness diagnostics.")}</span>
          <div>${escapeHtml(transientMemoryCandidate.summary)}</div>
        </article>
      `);
    }
    if (retrievalMeta) {
      const retrievalBadges = [
        { label: `configured: ${formatMemoryRetrievalMode(retrievalMeta.mode)}`, tone: "neutral" },
        {
          label: `active: ${formatMemoryRetrievalMode(retrievalMeta.activeMode)}`,
          tone: retrievalMeta.activeMode === "hybrid" || retrievalMeta.activeMode === "rag" ? "hybrid" : "lexical",
        },
        { label: retrievalMeta.vectorEnabled ? "embedding on" : "embedding off", tone: retrievalMeta.vectorEnabled ? "vector" : "neutral" },
      ];
      technicalRows.push(`
        <article class="diagnostic-item">
          <strong>Memory Retrieval</strong>
          ${renderDiagnosticBadges(retrievalBadges)}
          <span>${escapeHtml(`Embedding candidates ${retrievalMeta.vectorCandidateCount || 0} / selected ${retrievalMeta.vectorSelectedCount || 0}`)}</span>
          ${
            typeof retrievalMeta.canonicalCandidateCount === "number" || typeof retrievalMeta.canonicalSelectedCount === "number"
              ? `<div>${escapeHtml(`Canon facts ${retrievalMeta.canonicalCandidateCount || 0} / selected ${retrievalMeta.canonicalSelectedCount || 0} / budget ${retrievalMeta.canonicalBudget || 0}`)}</div>`
              : ""
          }
          ${
            typeof retrievalMeta.recentCandidateCount === "number" || typeof retrievalMeta.recentSelectedCount === "number"
              ? `<div>${escapeHtml(`Recent facts ${retrievalMeta.recentCandidateCount || 0} / selected ${retrievalMeta.recentSelectedCount || 0} / budget ${retrievalMeta.recentBudget || 0}`)}</div>`
              : ""
          }
          ${
            typeof retrievalMeta.evidenceCandidateCount === "number" || typeof retrievalMeta.evidenceSelectedCount === "number"
              ? `<div>${escapeHtml(`Evidence candidates ${retrievalMeta.evidenceCandidateCount || 0} / selected ${retrievalMeta.evidenceSelectedCount || 0}`)}</div>`
              : ""
          }
          ${
            typeof retrievalMeta.episodicCandidateCount === "number" || typeof retrievalMeta.episodicSelectedCount === "number"
              ? `<div>${escapeHtml(`Episodic evidence ${retrievalMeta.episodicCandidateCount || 0} / selected ${retrievalMeta.episodicSelectedCount || 0} / budget ${retrievalMeta.episodicBudget || 0}`)}</div>`
              : ""
          }
          ${
            typeof retrievalMeta.supportCandidateCount === "number" || typeof retrievalMeta.supportSelectedCount === "number"
              ? `<div>${escapeHtml(`Fact-support evidence ${retrievalMeta.supportCandidateCount || 0} / selected ${retrievalMeta.supportSelectedCount || 0} / budget ${retrievalMeta.supportBudget || 0}`)}</div>`
              : ""
          }
          ${
            typeof retrievalMeta.contestedCandidateCount === "number"
              ? `<div>${escapeHtml(`Contested memory candidates ${retrievalMeta.contestedCandidateCount || 0}`)}</div>`
              : ""
          }
          ${retrievalMeta.mode === "rag" ? `<div>${escapeHtml("Memory RAG now budgets canon facts, recent facts, and episodic evidence separately so recall stays balanced instead of collapsing into one memory tier.")}</div>` : ""}
          ${retrievalMeta.fallbackReason ? `<div>${escapeHtml(`Fallback: ${retrievalMeta.fallbackReason}`)}</div>` : ""}
        </article>
      `);
    }
    if (knowledgeRetrievalMeta) {
      const knowledgeBadges = [
        { label: `configured: ${formatKnowledgeRetrievalMode(knowledgeRetrievalMeta.mode)}`, tone: "neutral" },
        { label: `active: ${formatKnowledgeRetrievalMode(knowledgeRetrievalMeta.activeMode)}`, tone: knowledgeRetrievalMeta.activeMode === "rag" || knowledgeRetrievalMeta.activeMode === "hybrid" ? "hybrid" : "lexical" },
        { label: knowledgeRetrievalMeta.vectorEnabled ? "embedding on" : "embedding off", tone: knowledgeRetrievalMeta.vectorEnabled ? "vector" : "neutral" },
      ];
      if (knowledgeRetrievalMeta.vectorProvider) {
        knowledgeBadges.push({
          label: `embedding backend ${knowledgeRetrievalMeta.vectorProvider}`,
          tone: knowledgeRetrievalMeta.vectorProvider === "hash_v1" ? "neutral" : "vector",
        });
      }
      if (typeof knowledgeRetrievalMeta.cachedVectorCount === "number") {
        knowledgeBadges.push({
          label: `embedding cache ${knowledgeRetrievalMeta.cachedVectorCount}`,
          tone: knowledgeRetrievalMeta.cachedVectorCount ? "vector" : "neutral",
        });
      }
      if (knowledgeRetrievalMeta.indexSource) {
        knowledgeBadges.push({
          label: `index ${knowledgeRetrievalMeta.indexSource}`,
          tone: knowledgeRetrievalMeta.indexSource === "persisted" ? "hybrid" : "neutral",
        });
      }
      technicalRows.push(`
        <article class="diagnostic-item">
          <strong>Knowledge Retrieval</strong>
          ${renderDiagnosticBadges(knowledgeBadges)}
          <span>${escapeHtml(`Knowledge chunks ${knowledgeRetrievalMeta.chunkCount || 0} / embedding candidates ${knowledgeRetrievalMeta.vectorCandidateCount || 0} / selected ${knowledgeRetrievalMeta.vectorSelectedCount || 0}`)}</span>
          ${knowledgeRetrievalMeta.vectorFailure ? `<div>${escapeHtml(`Embedding note: ${knowledgeRetrievalMeta.vectorFailure}`)}</div>` : ""}
          ${knowledgeRetrievalMeta.mode === "rag" ? `<div>${escapeHtml("Knowledge RAG keeps only light anchors in prompt and lets retrieved knowledge chunks carry the detail.")}</div>` : ""}
          ${knowledgeRetrievalMeta.indexSource ? `<div>${escapeHtml(`Knowledge index source: ${knowledgeRetrievalMeta.indexSource}${knowledgeRetrievalMeta.indexRefreshed ? " (refreshed this turn)" : ""}`)}</div>` : ""}
          ${knowledgeRetrievalMeta.fallbackReason ? `<div>${escapeHtml(`Fallback: ${knowledgeRetrievalMeta.fallbackReason}`)}</div>` : ""}
        </article>
      `);
    }
    if (preview?.selectedKnowledgeChunks?.length) {
      highlightRows.push(
        ...preview.selectedKnowledgeChunks.map(
          (item) => `
            <article class="diagnostic-item">
              <strong>Retrieved Knowledge / ${escapeHtml(item.sourceType || "unknown")} / ${escapeHtml(item.title || item.sourceId || "")}</strong>
              ${renderDiagnosticBadges([
                item.chunkType ? { label: item.chunkType.replaceAll("_", " "), tone: "neutral" } : null,
                getRetrievalSourceMeta(item.reasons || []),
                getSemanticCandidateMeta(item.reasons || []),
              ])}
              <span>${escapeHtml(String(item.text || "").slice(0, 220))}</span>
              <div>${escapeHtml((item.reasons || []).join(" / ") || "Selected this turn")}</div>
            </article>
          `
        )
      );
    }
    if (preview?.selectedMemoryRecords?.length) {
      highlightRows.push(
        ...preview.selectedMemoryRecords.map(
          (item) => `
            <article class="diagnostic-item">
              <strong>Retrieved Memory / ${escapeHtml(formatMemoryTier(item.tier))} / ${escapeHtml(formatMemoryKind(item.kind))} / ${escapeHtml(item.importance || "medium")}</strong>
              ${renderDiagnosticBadges([
                { label: formatMemoryScope(item.scope), tone: "neutral" },
                getRetrievalSourceMeta(item.reasons || []),
              ])}
              <span>${escapeHtml(item.summary || "")}</span>
              <div>${escapeHtml(`Scope: ${formatMemoryScope(item.scope)}${item.subjectIds?.length ? ` / Subjects: ${item.subjectIds.join(", ")}` : ""}${item.tags?.length ? ` / Tags: ${item.tags.join(", ")}` : ""}`)}</div>
              ${
                Array.isArray(item.sourceMessageRange) && item.sourceMessageRange.length === 2
                  ? `<div>${escapeHtml(`Source turns: ${item.sourceMessageRange[0]}-${item.sourceMessageRange[1]}`)}</div>`
                  : ""
              }
              ${
                Number.isFinite(Number(item.confidence))
                  ? `<div>${escapeHtml(`Confidence: ${Number(item.confidence).toFixed(2)}`)}</div>`
                  : ""
              }
              ${buildCanonMetaLines(item).map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
              <div>${escapeHtml((item.reasons || []).join(" / ") || "Selected this turn")}</div>
            </article>
          `
        )
      );
    }
    if (preview?.selectedMemoryEvidence?.length) {
      highlightRows.push(
        ...preview.selectedMemoryEvidence.map(
          (item) => `
            <article class="diagnostic-item">
              <strong>Retrieved Memory Evidence / ${escapeHtml(item.type === "memory_episode" ? "episodic chunk" : item.sourceRole || "unknown source")}</strong>
              ${renderDiagnosticBadges([
                { label: formatMemoryScope(item.scope), tone: "neutral" },
                item.type === "memory_episode" ? { label: "turn-level memory", tone: "hybrid" } : null,
                getRetrievalSourceMeta(item.reasons || []),
                getSemanticCandidateMeta(item.reasons || []),
              ])}
              <span>${escapeHtml(item.text || "")}</span>
              <div>${escapeHtml(`Scope: ${formatMemoryScope(item.scope)}${item.subjectIds?.length ? ` / Subjects: ${item.subjectIds.join(", ")}` : ""}${item.tags?.length ? ` / Tags: ${item.tags.join(", ")}` : ""}`)}</div>
              ${item.linkedRecordId ? `<div>${escapeHtml(`Linked fact: ${item.linkedRecordId}`)}</div>` : ""}
              ${
                Array.isArray(item.sourceMessageRange) && item.sourceMessageRange.length === 2
                  ? `<div>${escapeHtml(`Source turns: ${item.sourceMessageRange[0]}-${item.sourceMessageRange[1]}`)}</div>`
                  : ""
              }
              ${
                Number.isFinite(Number(item.confidence))
                  ? `<div>${escapeHtml(`Confidence: ${Number(item.confidence).toFixed(2)}`)}</div>`
                  : ""
              }
              ${buildCanonMetaLines(item).map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
              <div>${escapeHtml((item.reasons || []).join(" / ") || "Selected this turn")}</div>
            </article>
          `
        )
      );
    }
    if (preview?.selectedContestedMemoryRecords?.length) {
      warningRows.push(
        ...preview.selectedContestedMemoryRecords.map(
          (item) => `
            <article class="diagnostic-item">
              <strong>Contested Memory Candidate / ${escapeHtml(formatMemoryTier(item.tier))} / ${escapeHtml(formatMemoryKind(item.kind))}</strong>
              ${renderDiagnosticBadges([
                { label: formatMemoryScope(item.scope), tone: "neutral" },
                { label: "contested", tone: "hybrid" },
              ])}
              <span>${escapeHtml(item.summary || "")}</span>
              <div>${escapeHtml(`Scope: ${formatMemoryScope(item.scope)}${item.subjectIds?.length ? ` / Subjects: ${item.subjectIds.join(", ")}` : ""}${item.tags?.length ? ` / Tags: ${item.tags.join(", ")}` : ""}`)}</div>
              ${
                Array.isArray(item.sourceMessageRange) && item.sourceMessageRange.length === 2
                  ? `<div>${escapeHtml(`Source turns: ${item.sourceMessageRange[0]}-${item.sourceMessageRange[1]}`)}</div>`
                  : ""
              }
              ${
                Number.isFinite(Number(item.confidence))
                  ? `<div>${escapeHtml(`Confidence: ${Number(item.confidence).toFixed(2)}`)}</div>`
                  : ""
              }
              ${buildCanonMetaLines(item).map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
              <div>${escapeHtml((item.reasons || []).join(" / ") || "Contested this turn")}</div>
            </article>
          `
        )
      );
    }
    if (groundingCheck?.unsupportedClauses?.length) {
      warningRows.push(
        ...groundingCheck.unsupportedClauses.map(
          (item) => `
            <article class="diagnostic-item">
              <strong>Grounding Warning / Ungrounded clause</strong>
              ${renderDiagnosticBadges([{ label: "unsupported", tone: "lexical" }])}
              <span>${escapeHtml(item.text || "")}</span>
              <div>${escapeHtml((item.reasons || []).join(" / ") || "No strong support matched this clause")}</div>
              ${renderGroundingSupportRefs("Closest canon support:", item.supportRefs)}
              ${renderGroundingSupportRefs("Nearby contested support:", item.contestedSupportRefs)}
            </article>
          `
        )
      );
    }
    if (groundingCheck?.contestedClauses?.length) {
      warningRows.push(
        ...groundingCheck.contestedClauses.map(
          (item) => `
            <article class="diagnostic-item">
              <strong>Grounding Warning / Contested clause</strong>
              ${renderDiagnosticBadges([{ label: "contested", tone: "hybrid" }])}
              <span>${escapeHtml(item.text || "")}</span>
              <div>${escapeHtml((item.reasons || []).join(" / ") || "This clause leaned on contested memory")}</div>
              ${renderGroundingSupportRefs("Canon support:", item.supportRefs)}
              ${renderGroundingSupportRefs("Contested support:", item.contestedSupportRefs)}
            </article>
          `
        )
      );
    }
    if (groundingCheck?.supportedClauses?.length) {
      technicalRows.push(
        ...groundingCheck.supportedClauses.map(
          (item) => `
            <article class="diagnostic-item">
              <strong>Grounded Answer Clause</strong>
              ${renderDiagnosticBadges([{ label: "supported", tone: "hybrid" }])}
              <span>${escapeHtml(item.text || "")}</span>
              <div>${escapeHtml((item.reasons || []).join(" / ") || "This clause stayed grounded")}</div>
              ${renderGroundingSupportRefs("Supported by:", item.supportRefs)}
            </article>
          `
        )
      );
    }
    const triggers = snapshot?.summaryTriggers || [];
    if (triggers.length) {
      technicalRows.push(
        ...triggers.map(
          (item) => `
            <article class="diagnostic-item">
              <strong>Trigger</strong>
              <span>${escapeHtml(formatSummaryTrigger(item))}</span>
            </article>
          `
        )
      );
    }
    const proposalTriggers = state.currentProposalTriggers || [];
    if (proposalTriggers.length) {
      technicalRows.push(
        ...proposalTriggers.map(
          (item) => `
            <article class="diagnostic-item">
              <strong>Proposal Trigger</strong>
              <span>${escapeHtml(item)}</span>
            </article>
          `
        )
      );
    }
    const proposalPipeline = state.pendingProposalPipeline || null;
    if (proposalPipeline) {
      technicalRows.push(`
        <article class="diagnostic-item">
          <strong>Proposal Pipeline</strong>
          <span>${escapeHtml(buildProposalPipelineMessage(proposalPipeline))}</span>
        </article>
      `);
    }
    els.diagnosticHighlights.innerHTML =
      highlightRows.join("") ||
      `<article class="diagnostic-item"><strong>Retrieved context</strong><span>This turn did not surface any recalled memory or knowledge details yet.</span></article>`;
    els.diagnosticWarnings.innerHTML =
      warningRows.join("") ||
      `<article class="diagnostic-item"><strong>Warnings</strong><span>Nothing urgent stands out for this turn.</span></article>`;
    els.diagnosticTriggers.innerHTML =
      technicalRows.join("") ||
      `<article class="diagnostic-item"><strong>Technical details</strong><span>There are no extra pipeline details to display yet.</span></article>`;

    els.diagnosticContextBlocks.innerHTML = blocks.length
      ? blocks
          .map(
            (item) => `
              <article class="diagnostic-item">
                <strong>${escapeHtml(formatContextLabel(item.label))}</strong>
                <div>${escapeHtml(item.preview || "")}</div>
              </article>
            `
          )
          .join("")
      : `<article class="diagnostic-item"><strong>Context</strong><span>There are no context blocks to display yet.</span></article>`;

    els.diagnosticPromptPreview.innerHTML = promptMessages.length
      ? promptMessages
          .map(
            (item) => `
              <article class="diagnostic-item">
                <strong>${escapeHtml(item.role)}</strong>
                <div>${escapeHtml(String(item.content || "").slice(0, 800))}</div>
              </article>
            `
          )
          .join("")
      : `<article class="diagnostic-item"><strong>Prompt</strong><span>There is no final prompt preview to display yet.</span></article>`;
  }

  return { renderDiagnosticsCurrent };
};
