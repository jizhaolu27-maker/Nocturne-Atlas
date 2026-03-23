window.createReviewTools = function createReviewTools({
  state,
  els,
  escapeHtml,
  formatContextLabel,
  summarizeContextSources,
  api,
  loadStory,
}) {
  function formatProposalPipelineStage(stage) {
    const labels = {
      idle: "等待中",
      not_triggered: "本轮未触发提案",
      triggered: "已命中提案触发器",
      generating: "正在生成提案",
      queued: "提案已推送到接受区",
      empty: "已触发，但没有生成可入队提案",
      failed: "提案生成失败",
    };
    return labels[stage] || stage || "未知状态";
  }

  function buildProposalPipelineMessage(pipeline) {
    if (!pipeline) {
      return "";
    }
    const triggerCount = Number(pipeline.triggerCount || 0);
    const generatedCount = Number(pipeline.generatedCount || 0);
    const triggerText = triggerCount > 0 ? `，命中 ${triggerCount} 条触发器` : "";
    const generatedText = generatedCount > 0 ? `，已入队 ${generatedCount} 条提案` : "";
    const errorText = pipeline.error ? `：${pipeline.error}` : "";
    return `提案状态：${formatProposalPipelineStage(pipeline.stage)}${triggerText}${generatedText}${errorText}`;
  }

  function renderChatStatus() {
    if (state.isStreamingChat) {
      els.chatStatus.className = "chat-status busy";
      els.chatStatus.textContent = "AI 已收到请求，正在整理上下文并准备回答。";
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
      character: "角色卡",
      worldbook: "世界书",
      style: "文风",
    };
    return labels[targetType] || targetType || "未知类型";
  }

  function formatProposalAction(action) {
    return action === "create" ? "新建" : "更新";
  }

  function formatMemoryKind(kind) {
    const labels = {
      relationship_update: "关系变化",
      world_state: "世界状态",
      character_update: "角色变化",
      plot_checkpoint: "剧情节点",
    };
    return labels[kind] || kind || "未分类";
  }

  function formatMemoryTier(tier) {
    return tier === "long_term" ? "长期记忆" : "短期记忆";
  }

  function formatMemoryScope(scope) {
    const labels = {
      character: "角色",
      relationship: "关系",
      world: "世界",
      plot: "剧情",
    };
    return labels[scope] || scope || "未分类";
  }

  function formatSummaryTrigger(trigger) {
    const value = String(trigger || "");
    if (value.startsWith("Turn interval reached")) return "已达到设定轮数";
    if (value === "Context pressure exceeded high threshold") return "上下文压力过高，提前触发";
    if (value === "Major event keywords detected in recent turns") return "最近剧情出现重大变化，提前触发";
    if (value === "Memory consolidation threshold reached") return "短期记忆达到整合阈值";
    return value || "未知触发原因";
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
    return `设定每 ${schedule.configuredRounds} 轮摘要一次；若无提前触发，下一次在第 ${nextRound} 轮，还差 ${remainingRounds} 轮。`;
  }

  function getRetrievalSourceMeta(reasons) {
    const rows = Array.isArray(reasons) ? reasons.filter(Boolean) : [];
    const hasVector = rows.some((item) => /vector|向量/i.test(String(item)));
    const hasLexical = rows.some((item) => /keyword|entity|关键词|实体/i.test(String(item)));
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
                    ? `<div class="memory-trigger">范围：${escapeHtml(formatMemoryScope(item.scope))}${item.subjectIds?.length ? ` / 主体：${escapeHtml(item.subjectIds.join("、"))}` : ""}${item.tags?.length ? ` / 标签：${escapeHtml(item.tags.join("、"))}` : ""}</div>`
                    : ""
                }
                ${
                  item.triggeredBy?.length
                    ? `<div class="memory-trigger">触发原因：${escapeHtml(item.triggeredBy.map(formatSummaryTrigger).join(" / "))}</div>`
                    : ""
                }
                ${
                  item.triggeredAt?.round
                    ? `<div class="memory-trigger">生成时机：第 ${escapeHtml(String(item.triggeredAt.round))} 轮对话</div>`
                    : ""
                }
              </article>
            `
          )
          .join("")
      : `<article class="memory-item">还没有生成记忆摘要。</article>`;
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
      return "未设置";
    }
    if (value === null) {
      return "null";
    }
    if (typeof value === "string") {
      return value || "空字符串";
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
        return `<article class="proposal-diff-empty">这个新建提案没有可展示的字段内容。</article>`;
      }
      return changes
        .map(
          (change) => `
            <article class="proposal-diff-row">
              <strong>${escapeHtml(change.path)}</strong>
              <div class="proposal-diff-values proposal-diff-values-create">
                <div class="proposal-diff-after">
                  <span>新建值</span>
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
      return `<article class="proposal-diff-empty">这个提案没有可展示的字段变更。</article>`;
    }
    return changes
      .map((change) => {
        const prevValue = readValueAtPath(target, change.path);
        return `
          <article class="proposal-diff-row">
            <strong>${escapeHtml(change.path)}</strong>
            <div class="proposal-diff-values">
              <div class="proposal-diff-before">
                <span>旧值</span>
                <code>${escapeHtml(formatDiffValue(prevValue))}</code>
              </div>
              <div class="proposal-diff-arrow">→</div>
              <div class="proposal-diff-after">
                <span>新值</span>
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
    els.proposalList.innerHTML = pendingRecords.length
      ? pendingRecords
          .slice()
          .reverse()
          .map(
            (item) => `
              <article class="proposal-item workspace-detail" data-proposal-id="${item.id}">
                <div class="workspace-detail-head">
                  <strong>${escapeHtml(formatProposalAction(item.action || "update"))}${escapeHtml(formatProposalTargetType(item.targetType))} / ${escapeHtml(item.diff?.name || item.targetId)}</strong>
                </div>
                <div class="proposal-meta-line">目标 ID：${escapeHtml(item.targetId)}</div>
                <div style="margin-top:4px;">${escapeHtml(item.reason || "没有附加说明")}</div>
                <div class="proposal-diff-list">${renderProposalDiff(item)}</div>
                <div style="margin-top:6px; color:var(--muted); font-size:11px;">状态：pending</div>
                <div class="actions-row">
                  <button data-action="accept">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    接受
                  </button>
                  <button data-action="reject" class="ghost danger">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    拒绝
                  </button>
                </div>
              </article>
            `
          )
          .join("")
      : `<article class="proposal-item workspace-detail" style="text-align:center; color:var(--muted);">还没有可处理的提案。</article>`;

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
            button.innerHTML = action === "accept" ? "处理中..." : "拒绝中...";
            await api(`/api/stories/${state.activeStoryId}/proposals/${article.dataset.proposalId}`, {
              method: "POST",
              body: JSON.stringify({ action }),
            });
            await loadStory(state.activeStoryId);
          } catch (error) {
            await loadStory(state.activeStoryId).catch(() => {});
            alert(`提案${action === "accept" ? "接受" : "拒绝"}失败：${error.message}`);
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
    els.statusBlocks.textContent = `${contextStatus.usedBlocks || 0}/${contextStatus.maxBlocks || 30} 轮`;
    els.statusTokens.textContent = `${contextStatus.usedTokens || 0}/${contextStatus.maxTokens || 0}`;
    els.statusPressure.textContent = contextStatus.pressureLevel || "low";
    const stateValue = contextStatus.forgetfulnessState || "normal";
    els.statusForgetfulness.textContent = stateValue;
    els.statusForgetfulness.className = `state-${stateValue}`;
    const signals = contextStatus.forgetfulnessSignals || {};
    const reasons = contextStatus.forgetfulnessReasons || [];
    const groupedRows = [];
    if ((signals.pressure || []).length) {
      groupedRows.push(...signals.pressure.map((reason) => `<li><strong>系统压力</strong>：${escapeHtml(reason)}</li>`));
    }
    if ((signals.omission || []).length) {
      groupedRows.push(...signals.omission.map((reason) => `<li><strong>遗漏风险</strong>：${escapeHtml(reason)}</li>`));
    }
    if ((signals.conflict || []).length) {
      groupedRows.push(...signals.conflict.map((reason) => `<li><strong>冲突风险</strong>：${escapeHtml(reason)}</li>`));
    }
    els.statusReasons.innerHTML = reasons.length
      ? (groupedRows.length ? groupedRows : reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`)).join("")
      : "<li>当前没有明显的记忆风险。</li>";
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
          <strong>上下文摘要</strong>
          <span>${escapeHtml(summarizeContextSources(blocks))}</span>
        </article>
      `);
    }
    if (requestMeta) {
      triggerRows.push(`
        <article class="diagnostic-item">
          <strong>请求信息</strong>
          <span>${escapeHtml(requestMeta.endpoint || "")}</span>
          <div>延迟：${escapeHtml(String(requestMeta.latencyMs || "n/a"))} ms</div>
          <div>Prompt 条目：${escapeHtml(String(requestMeta.promptMessages || 0))}</div>
          <div>输出字符：${escapeHtml(String(requestMeta.completionChars || 0))}</div>
          <div>摘要：${escapeHtml(String(snapshot?.generatedSummaryCount || diagnostics.generatedSummaryCount || 0))} / 提案：${escapeHtml(String(snapshot?.generatedProposalCount || diagnostics.generatedProposalCount || 0))}</div>
        </article>
      `);
    }
    if (preview?.contextStatus) {
      triggerRows.push(`
        <article class="diagnostic-item">
          <strong>当前预览</strong>
          <span>${escapeHtml(`${preview.contextStatus.usedBlocks || 0}/${preview.contextStatus.maxBlocks || 0} 轮上下文`)}</span>
          <div>${escapeHtml(`${preview.contextStatus.usedTokens || 0}/${preview.contextStatus.maxTokens || 0} 估算 tokens`)}</div>
          <div>${escapeHtml(`风险状态：${preview.contextStatus.forgetfulnessState || "normal"}`)}</div>
        </article>
      `);
    }
    const activeSignals = preview?.contextStatus?.forgetfulnessSignals || snapshot?.contextStatus?.forgetfulnessSignals || null;
    if (activeSignals && ((activeSignals.pressure || []).length || (activeSignals.omission || []).length || (activeSignals.conflict || []).length)) {
      const rows = [];
      rows.push(...(activeSignals.pressure || []).map((item) => `系统压力：${item}`));
      rows.push(...(activeSignals.omission || []).map((item) => `遗漏风险：${item}`));
      rows.push(...(activeSignals.conflict || []).map((item) => `冲突风险：${item}`));
      triggerRows.push(`
        <article class="diagnostic-item">
          <strong>记忆风险细分</strong>
          <span>${escapeHtml(rows.join(" / "))}</span>
        </article>
      `);
    }
    if (summarySchedule?.configuredRounds) {
      triggerRows.push(`
        <article class="diagnostic-item">
          <strong>摘要计划</strong>
          <span>${escapeHtml(formatSummarySchedule(summarySchedule))}</span>
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
          <strong>记忆检索</strong>
          ${renderDiagnosticBadges(retrievalBadges)}
          <span>${escapeHtml(`向量候选 ${retrievalMeta.vectorCandidateCount || 0} / 向量入选 ${retrievalMeta.vectorSelectedCount || 0}`)}</span>
          ${retrievalMeta.fallbackReason ? `<div>${escapeHtml(`回退说明：${retrievalMeta.fallbackReason}`)}</div>` : ""}
        </article>
      `);
    }
    if (knowledgeRetrievalMeta) {
      const knowledgeBadges = [
        { label: `active: ${knowledgeRetrievalMeta.activeMode || "lexical"}`, tone: knowledgeRetrievalMeta.activeMode === "hybrid" ? "hybrid" : "lexical" },
      ];
      if (typeof knowledgeRetrievalMeta.cachedVectorCount === "number") {
        knowledgeBadges.push({
          label: `vector cache ${knowledgeRetrievalMeta.cachedVectorCount}`,
          tone: knowledgeRetrievalMeta.cachedVectorCount ? "vector" : "neutral",
        });
      }
      triggerRows.push(`
        <article class="diagnostic-item">
          <strong>知识检索</strong>
          ${renderDiagnosticBadges(knowledgeBadges)}
          <span>${escapeHtml(`候选块 ${knowledgeRetrievalMeta.chunkCount || 0} / 向量候选 ${knowledgeRetrievalMeta.vectorCandidateCount || 0}`)}</span>
        </article>
      `);
    }
    if (preview?.selectedKnowledgeChunks?.length) {
      triggerRows.push(
        ...preview.selectedKnowledgeChunks.map(
          (item) => `
            <article class="diagnostic-item">
              <strong>召回知识 / ${escapeHtml(item.sourceType || "unknown")} / ${escapeHtml(item.title || item.sourceId || "")}</strong>
              ${renderDiagnosticBadges([
                item.chunkType ? { label: item.chunkType.replaceAll("_", " "), tone: "neutral" } : null,
                getRetrievalSourceMeta(item.reasons || []),
              ])}
              <span>${escapeHtml(String(item.text || "").slice(0, 220))}</span>
              <div>${escapeHtml((item.reasons || []).join(" / ") || "本轮被选中")}</div>
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
              <strong>召回记忆 / ${escapeHtml(formatMemoryTier(item.tier))} / ${escapeHtml(formatMemoryKind(item.kind))} / ${escapeHtml(item.importance || "medium")}</strong>
              ${renderDiagnosticBadges([
                { label: formatMemoryScope(item.scope), tone: "neutral" },
                getRetrievalSourceMeta(item.reasons || []),
              ])}
              <span>${escapeHtml(item.summary || "")}</span>
              <div>${escapeHtml(`范围：${formatMemoryScope(item.scope)}${item.subjectIds?.length ? ` / 主体：${item.subjectIds.join("、")}` : ""}${item.tags?.length ? ` / 标签：${item.tags.join("、")}` : ""}`)}</div>
              <div>${escapeHtml((item.reasons || []).join(" / ") || "本轮被选中")}</div>
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
              <strong>触发器</strong>
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
              <strong>提案触发器</strong>
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
          <strong>提案流水状态</strong>
          <span>${escapeHtml(buildProposalPipelineMessage(proposalPipeline))}</span>
        </article>
      `);
    }
    els.diagnosticTriggers.innerHTML =
      triggerRows.join("") ||
      `<article class="diagnostic-item"><strong>触发器</strong><span>还没有可展示的诊断触发信息。</span></article>`;

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
      : `<article class="diagnostic-item"><strong>上下文</strong><span>还没有上下文块内容。</span></article>`;

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
      : `<article class="diagnostic-item"><strong>Prompt</strong><span>还没有可展示的最终 Prompt 预览。</span></article>`;
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
