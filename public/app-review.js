window.createReviewTools = function createReviewTools({ state, els, escapeHtml }) {
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
      const generationMessages = {
        reply_generating: "正在生成回复…",
        finalizing: "正在整理本轮结果…",
        memory_generating: "正在整理本轮记忆…",
        proposal_checking: "正在检查是否需要更新故事设定…",
        proposal_generating: "正在生成待审核提案…",
      };
      els.chatStatus.className = "chat-status busy";
      els.chatStatus.textContent = generationMessages[state.chatGenerationStage] || "正在生成回复…";
      return;
    }
    if (state.isWatchingRemoteChat) {
      els.chatStatus.className = "chat-status busy";
      els.chatStatus.textContent = "Another signed-in device is generating this story.";
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


  return {
    buildProposalPipelineMessage,
    renderChatStatus,
    renderStatusCurrent,
  };
};
