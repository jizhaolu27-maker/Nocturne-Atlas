window.createReviewTools = function createReviewTools({
  state,
  els,
  escapeHtml,
  api,
  loadStory,
}) {
  function formatContextLabel(label) {
    const value = String(label || "");
    if (value === "system:global") return "Global system prompt";
    if (value === "system:story") return "Story system prompt";
    if (value === "knowledge:retrieved") return "Retrieved knowledge blocks";
    if (value === "style") return "Enabled style";
    if (value === "characters") return "Enabled character cards";
    if (value === "worldbook") return "Enabled worldbooks";
    if (value === "memory") return "Story memory summary";
    if (value === "memory:long_term") return "Long-term memory";
    if (value === "memory:critical") return "Critical memory";
    if (value === "memory:recent") return "Recent memory";
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
    if (labels.includes("knowledge:retrieved")) basicSources.push("Retrieved knowledge");
    if (labels.includes("characters")) basicSources.push("Character cards");
    if (labels.includes("worldbook")) basicSources.push("Worldbooks");
    if (labels.includes("style")) basicSources.push("Style");
    if (labels.includes("memory")) basicSources.push("Story memory");
    if (labels.includes("memory:long_term")) basicSources.push("Long-term memory");
    if (labels.includes("memory:critical")) basicSources.push("Critical memory");
    if (labels.includes("memory:recent")) basicSources.push("Recent memory");
    const historyTurns = labels.filter((item) => item.startsWith("history_turn:")).length;
    if (!basicSources.length && historyTurns === 0) {
      return "There are no context sources to display for this preview yet.";
    }
    return `Included in this run: ${basicSources.length ? basicSources.join(", ") : "no base sources"}; history turns: ${historyTurns}.`;
  }

  function formatProposalPipelineStage(stage) {
    const labels = {
      idle: "Idle",
      not_triggered: "No proposal trigger this turn",
      triggered: "Proposal trigger matched",
      generating: "Generating proposals",
      queued: "Proposals queued for review",
      empty: "Triggered, but nothing was queued",
      failed: "Proposal generation failed",
    };
    return labels[stage] || stage || "Unknown status";
  }

  function buildProposalPipelineMessage(pipeline) {
    if (!pipeline) {
      return "";
    }
    const triggerCount = Number(pipeline.triggerCount || 0);
    const generatedCount = Number(pipeline.generatedCount || 0);
    const triggerText = triggerCount > 0 ? `, matched ${triggerCount} trigger(s)` : "";
    const generatedText = generatedCount > 0 ? `, queued ${generatedCount} proposal(s)` : "";
    const errorText = pipeline.error ? `: ${pipeline.error}` : "";
    return `Proposal pipeline: ${formatProposalPipelineStage(pipeline.stage)}${triggerText}${generatedText}${errorText}`;
  }

  function renderChatStatus() {
    if (state.isStreamingChat) {
      els.chatStatus.className = "chat-status busy";
      els.chatStatus.textContent = "AI received the request and is preparing the reply.";
      return;
    }
    const message = buildProposalPipelineMessage(state.pendingProposalPipeline);
    const tone =
      state.pendingProposalPipeline?.stage === "failed"
        ? "error"
        : state.pendingProposalPipeline?.stage === "queued"
          ? "ok"
          : state.pendingProposalPipeline
            ? "info"
            : "";
    els.chatStatus.className = `chat-status ${tone}`.trim();
    els.chatStatus.textContent = message;
  }

  function formatProposalTargetType(targetType) {
    const labels = {
      character: "Character Card",
      worldbook: "Worldbook",
      style: "Style",
    };
    return labels[targetType] || targetType || "Unknown type";
  }

  function formatProposalAction(action) {
    return action === "create" ? "Create" : "Update";
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

  function renderDiagnosticBadges(items) {
    const rows = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!rows.length) {
      return "";
    }
    return `<div class="diagnostic-badges">${rows
      .map((item) => `<span class="diagnostic-badge ${item.tone ? `diagnostic-badge-${item.tone}` : ""}">${escapeHtml(item.label || item)}</span>`)
      .join("")}</div>`;
  }

  function renderMemory(records) {
    els.memoryList.innerHTML = records.length
      ? records
          .slice()
          .reverse()
          .map(
            (item) => `
              <article class="memory-item">
                <div class="memory-meta">${escapeHtml(item.type)} / ${escapeHtml(formatMemoryTier(item.tier))} / ${escapeHtml(formatMemoryKind(item.kind))} / ${escapeHtml(item.importance || "")}</div>
                <div>${escapeHtml(item.summary)}</div>
                ${
                  item.scope || item.subjectIds?.length || item.tags?.length
                    ? `<div class="memory-trigger">Scope: ${escapeHtml(formatMemoryScope(item.scope))}${item.subjectIds?.length ? ` / Subjects: ${escapeHtml(item.subjectIds.join(", "))}` : ""}${item.tags?.length ? ` / Tags: ${escapeHtml(item.tags.join(", "))}` : ""}</div>`
                    : ""
                }
                ${
                  item.triggeredBy?.length
                    ? `<div class="memory-trigger">Triggered by: ${escapeHtml(item.triggeredBy.map(formatSummaryTrigger).join(" / "))}</div>`
                    : ""
                }
                ${
                  item.triggeredAt?.round
                    ? `<div class="memory-trigger">Created on conversation turn ${escapeHtml(String(item.triggeredAt.round))}</div>`
                    : ""
                }
              </article>
            `
          )
          .join("")
      : `<article class="memory-item">No memory summaries have been generated yet.</article>`;
  }

  function getProposalWorkspaceItem(targetType, targetId) {
    const workspace = state.activeStoryData?.workspace || {};
    const map = {
      character: workspace.characters || [],
      worldbook: workspace.worldbooks || [],
      style: workspace.styles || [],
    };
    return (map[targetType] || []).find((item) => item.id === targetId) || null;
  }

  function flattenProposalPatch(patch, prefix = "") {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return [];
    }
    const rows = [];
    for (const [key, value] of Object.entries(patch)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        rows.push(...flattenProposalPatch(value, path));
        continue;
      }
      rows.push({ path, nextValue: value });
    }
    return rows;
  }

  function readValueAtPath(source, path) {
    return String(path || "")
      .split(".")
      .filter(Boolean)
      .reduce((current, key) => {
        if (current == null) {
          return undefined;
        }
        return current[key];
      }, source);
  }

  function formatDiffValue(value) {
    if (value === undefined) {
      return "Not set";
    }
    if (value === null) {
      return "null";
    }
    if (typeof value === "string") {
      return value || "Empty string";
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return JSON.stringify(value);
  }

  function renderProposalDiff(item) {
    if (item.action === "create") {
      const changes = flattenProposalPatch(item.diff);
      if (!changes.length) {
        return `<article class="proposal-diff-empty">This create proposal has no fields to display.</article>`;
      }
      return changes
        .map(
          (change) => `
            <article class="proposal-diff-row">
              <strong>${escapeHtml(change.path)}</strong>
              <div class="proposal-diff-values proposal-diff-values-create">
                <div class="proposal-diff-after">
                  <span>Created value</span>
                  <code>${escapeHtml(formatDiffValue(change.nextValue))}</code>
                </div>
              </div>
            </article>
          `
        )
        .join("");
    }
    const target = getProposalWorkspaceItem(item.targetType, item.targetId);
    const changes = flattenProposalPatch(item.diff);
    if (!changes.length) {
      return `<article class="proposal-diff-empty">This proposal has no field changes to display.</article>`;
    }
    return changes
      .map((change) => {
        const prevValue = readValueAtPath(target, change.path);
        return `
          <article class="proposal-diff-row">
            <strong>${escapeHtml(change.path)}</strong>
            <div class="proposal-diff-values">
              <div class="proposal-diff-before">
                <span>Previous value</span>
                <code>${escapeHtml(formatDiffValue(prevValue))}</code>
              </div>
              <div class="proposal-diff-arrow">→</div>
              <div class="proposal-diff-after">
                <span>New value</span>
                <code>${escapeHtml(formatDiffValue(change.nextValue))}</code>
              </div>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderProposals(records) {
    const pendingRecords = records.filter((item) => !item.status || item.status === "pending");
    const hasItems = pendingRecords.length > 0;
    els.proposalList.innerHTML = pendingRecords.length
      ? pendingRecords
          .slice()
          .reverse()
          .map(
            (item) => `
              <article class="proposal-item proposal-card workspace-detail" data-proposal-id="${item.id}">
                <div class="workspace-detail-head">
                  <strong>${escapeHtml(formatProposalAction(item.action || "update"))}${escapeHtml(formatProposalTargetType(item.targetType))} / ${escapeHtml(item.diff?.name || item.targetId)}</strong>
                </div>
                <div class="proposal-meta">
                  <div class="proposal-meta-line">Target ID: ${escapeHtml(item.targetId)}</div>
                  <div class="proposal-note">${escapeHtml(item.reason || "No additional note")}</div>
                  <div class="proposal-status">Status: pending</div>
                </div>
                <div class="proposal-diff-list">${renderProposalDiff(item)}</div>
                <div class="actions-row">
                  <button data-action="accept">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    Accept
                  </button>
                  <button data-action="reject" class="ghost danger">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    Reject
                  </button>
                </div>
              </article>
            `
          )
          .join("")
      : `<article class="proposal-item proposal-empty">There are no proposals to review yet.</article>`;

    els.proposalList.classList.toggle("has-items", hasItems);
    els.proposalList.classList.toggle("is-empty", !hasItems);
    els.proposalList.closest(".proposal-fold")?.classList.toggle("is-empty", !hasItems);

    for (const article of els.proposalList.querySelectorAll("[data-proposal-id]")) {
      for (const button of article.querySelectorAll("[data-action]")) {
        button.addEventListener("click", async () => {
          const action = button.dataset.action === "accept" ? "accept" : "reject";
          const buttons = Array.from(article.querySelectorAll("[data-action]"));
          const originalLabel = button.innerHTML;
          try {
            buttons.forEach((node) => {
              node.disabled = true;
            });
            button.innerHTML = action === "accept" ? "Processing..." : "Rejecting...";
            await api(`/api/stories/${state.activeStoryId}/proposals/${article.dataset.proposalId}`, {
              method: "POST",
              body: JSON.stringify({ action }),
            });
            await loadStory(state.activeStoryId);
          } catch (error) {
            await loadStory(state.activeStoryId).catch(() => {});
            alert(`Failed to ${action === "accept" ? "accept" : "reject"} proposal: ${error.message}`);
          } finally {
            buttons.forEach((node) => {
              node.disabled = false;
            });
            button.innerHTML = originalLabel;
          }
        });
      }
    }
  }

  function renderStatusCurrent(contextStatus) {
    els.statusBlocks.textContent = `${contextStatus.usedBlocks || 0}/${contextStatus.maxBlocks || 30} turns`;
    els.statusTokens.textContent = `${contextStatus.usedTokens || 0}/${contextStatus.maxTokens || 0}`;
    els.statusPressure.textContent = contextStatus.pressureLevel || "low";
    const stateValue = contextStatus.forgetfulnessState || "normal";
    els.statusForgetfulness.textContent = stateValue;
    els.statusForgetfulness.className = `state-${stateValue}`;
    const signals = contextStatus.forgetfulnessSignals || {};
    const reasons = contextStatus.forgetfulnessReasons || [];
    const groupedRows = [];
    if ((signals.pressure || []).length) {
      groupedRows.push(...signals.pressure.map((reason) => `<li><strong>System pressure</strong>: ${escapeHtml(reason)}</li>`));
    }
    if ((signals.omission || []).length) {
      groupedRows.push(...signals.omission.map((reason) => `<li><strong>Omission risk</strong>: ${escapeHtml(reason)}</li>`));
    }
    if ((signals.conflict || []).length) {
      groupedRows.push(...signals.conflict.map((reason) => `<li><strong>Conflict risk</strong>: ${escapeHtml(reason)}</li>`));
    }
    els.statusReasons.innerHTML = reasons.length
      ? (groupedRows.length ? groupedRows : reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`)).join("")
      : "<li>There is no obvious memory risk right now.</li>";
  }

  function renderDiagnosticsCurrent(diagnostics) {
    const snapshot = diagnostics.latestSnapshot || null;
    const requestMeta = snapshot?.requestMeta || diagnostics.requestMeta || null;
    const preview = diagnostics.currentContextPreview || null;
    const retrievalMeta = preview?.memoryRetrievalMeta || diagnostics.memoryRetrievalMeta || snapshot?.memoryRetrievalMeta || null;
    const knowledgeRetrievalMeta =
      preview?.knowledgeRetrievalMeta || diagnostics.knowledgeRetrievalMeta || snapshot?.knowledgeRetrievalMeta || null;
    const blocks = preview?.contextBlocks || snapshot?.contextBlocks || [];
    const promptMessages = preview?.promptMessages || snapshot?.promptMessages || [];
    const summarySchedule = snapshot?.summarySchedule || diagnostics.summarySchedule || null;
    const triggerRows = [];

    if (blocks.length) {
      triggerRows.push(`
        <article class="diagnostic-item diagnostic-summary">
          <strong>Context Summary</strong>
          <span>${escapeHtml(summarizeContextSources(blocks))}</span>
        </article>
      `);
    }
    if (requestMeta) {
      triggerRows.push(`
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
    if (preview?.contextStatus) {
      triggerRows.push(`
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
      triggerRows.push(`
        <article class="diagnostic-item">
          <strong>Memory Risk Breakdown</strong>
          <span>${escapeHtml(rows.join(" / "))}</span>
        </article>
      `);
    }
    if (summarySchedule?.configuredRounds) {
      triggerRows.push(`
        <article class="diagnostic-item">
          <strong>Summary Schedule</strong>
          <span>${escapeHtml(formatSummarySchedule(summarySchedule))}</span>
        </article>
      `);
    }
    const transientMemoryCandidate =
      snapshot?.transientMemoryCandidate || diagnostics.transientMemoryCandidate || null;
    if ((snapshot?.generatedSummaryCount || diagnostics.generatedSummaryCount || 0) > 0) {
      triggerRows.push(`
        <article class="diagnostic-item">
          <strong>Memory Writes</strong>
          ${renderDiagnosticBadges([{ label: "written to memory", tone: "hybrid" }])}
          <span>${escapeHtml(`${snapshot?.generatedSummaryCount || diagnostics.generatedSummaryCount || 0} formal memory record(s) were written this turn`)}</span>
        </article>
      `);
    } else if (transientMemoryCandidate?.summary) {
      triggerRows.push(`
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
        { label: `configured: ${retrievalMeta.mode || "lexical"}`, tone: "neutral" },
        { label: `active: ${retrievalMeta.activeMode || "lexical"}`, tone: retrievalMeta.activeMode === "hybrid" ? "hybrid" : "lexical" },
        { label: retrievalMeta.vectorEnabled ? "vector on" : "vector off", tone: retrievalMeta.vectorEnabled ? "vector" : "neutral" },
      ];
      triggerRows.push(`
        <article class="diagnostic-item">
          <strong>Memory Retrieval</strong>
          ${renderDiagnosticBadges(retrievalBadges)}
          <span>${escapeHtml(`Vector candidates ${retrievalMeta.vectorCandidateCount || 0} / selected ${retrievalMeta.vectorSelectedCount || 0}`)}</span>
          ${retrievalMeta.fallbackReason ? `<div>${escapeHtml(`Fallback: ${retrievalMeta.fallbackReason}`)}</div>` : ""}
        </article>
      `);
    }
    if (knowledgeRetrievalMeta) {
      const knowledgeBadges = [
        { label: `active: ${knowledgeRetrievalMeta.activeMode || "lexical"}`, tone: knowledgeRetrievalMeta.activeMode === "hybrid" ? "hybrid" : "lexical" },
      ];
      if (knowledgeRetrievalMeta.vectorProvider) {
        knowledgeBadges.push({
          label: `vector backend ${knowledgeRetrievalMeta.vectorProvider}`,
          tone: knowledgeRetrievalMeta.vectorProvider === "hash_v1" ? "neutral" : "vector",
        });
      }
      if (typeof knowledgeRetrievalMeta.cachedVectorCount === "number") {
        knowledgeBadges.push({
          label: `vector cache ${knowledgeRetrievalMeta.cachedVectorCount}`,
          tone: knowledgeRetrievalMeta.cachedVectorCount ? "vector" : "neutral",
        });
      }
      triggerRows.push(`
        <article class="diagnostic-item">
          <strong>Knowledge Retrieval</strong>
          ${renderDiagnosticBadges(knowledgeBadges)}
          <span>${escapeHtml(`Candidate chunks ${knowledgeRetrievalMeta.chunkCount || 0} / vector candidates ${knowledgeRetrievalMeta.vectorCandidateCount || 0}`)}</span>
          ${knowledgeRetrievalMeta.vectorFailure ? `<div>${escapeHtml(`Vector note: ${knowledgeRetrievalMeta.vectorFailure}`)}</div>` : ""}
        </article>
      `);
    }
    if (preview?.selectedKnowledgeChunks?.length) {
      triggerRows.push(
        ...preview.selectedKnowledgeChunks.map(
          (item) => `
            <article class="diagnostic-item">
              <strong>Retrieved Knowledge / ${escapeHtml(item.sourceType || "unknown")} / ${escapeHtml(item.title || item.sourceId || "")}</strong>
              ${renderDiagnosticBadges([
                item.chunkType ? { label: item.chunkType.replaceAll("_", " "), tone: "neutral" } : null,
                getRetrievalSourceMeta(item.reasons || []),
              ])}
              <span>${escapeHtml(String(item.text || "").slice(0, 220))}</span>
              <div>${escapeHtml((item.reasons || []).join(" / ") || "Selected this turn")}</div>
            </article>
          `
        )
      );
    }
    if (preview?.selectedMemoryRecords?.length) {
      triggerRows.push(
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
              <div>${escapeHtml((item.reasons || []).join(" / ") || "Selected this turn")}</div>
            </article>
          `
        )
      );
    }
    const triggers = snapshot?.summaryTriggers || [];
    if (triggers.length) {
      triggerRows.push(
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
      triggerRows.push(
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
      triggerRows.push(`
        <article class="diagnostic-item">
          <strong>Proposal Pipeline</strong>
          <span>${escapeHtml(buildProposalPipelineMessage(proposalPipeline))}</span>
        </article>
      `);
    }
    els.diagnosticTriggers.innerHTML =
      triggerRows.join("") ||
      `<article class="diagnostic-item"><strong>Trigger</strong><span>There is no diagnostic trigger info to display yet.</span></article>`;

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

  return {
    buildProposalPipelineMessage,
    renderChatStatus,
    renderMemory,
    renderProposals,
    renderStatusCurrent,
    renderDiagnosticsCurrent,
  };
};
