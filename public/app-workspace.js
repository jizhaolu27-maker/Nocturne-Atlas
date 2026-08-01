window.createWorkspaceTools = function createWorkspaceTools({
  state,
  els,
  escapeHtml,
  api,
  loadStory,
}) {
  function uiText(en, zh) {
    return window.NocturneI18n?.getLanguage?.() === "zh" ? zh : en;
  }
  function formatWorkspaceAssetType(type) {
    const labels = {
      character: "Character Card",
      worldbook: "Worldbook",
      style: "Style",
    };
    return labels[type] || type || "Workspace Asset";
  }

  function getWorkspaceAssetTitle(type, item) {
    if (type === "worldbook") {
      return item.title || item.name || item.id;
    }
    return item.name || item.title || item.id;
  }

  function formatWorkspaceDetailValue(value) {
    if (value == null) {
      return "Not set";
    }
    if (typeof value === "string") {
      return value || "Empty string";
    }
    return JSON.stringify(value, null, 2);
  }

  function buildWorkspaceCards(workspace) {
    return [
      ...(workspace.characters || []).map((item) => ({
        key: `character:${item.id}`,
        type: "character",
        id: item.id,
        title: getWorkspaceAssetTitle("character", item),
        body: item.arcState?.current || item.notes || "",
        item,
      })),
      ...(workspace.worldbooks || []).map((item) => ({
        key: `worldbook:${item.id}`,
        type: "worldbook",
        id: item.id,
        title: getWorkspaceAssetTitle("worldbook", item),
        body: item.storyState || item.content || "",
        item,
      })),
      ...(workspace.styles || []).map((item) => ({
        key: `style:${item.id}`,
        type: "style",
        id: item.id,
        title: getWorkspaceAssetTitle("style", item),
        body: `${item.tone || ""} / ${item.voice || ""}`,
        item,
      })),
    ];
  }

  function renderWorkspaceDetail(card) {
    const fields = Object.entries(card.item || {})
      .filter(([key]) => !["workspaceUpdatedAt", "changeLog", "sourceId", "sourceUpdatedAt"].includes(key))
      .map(
        ([key, value]) => `
          <article class="workspace-detail-row">
            <strong>${escapeHtml(key)}</strong>
            <pre>${escapeHtml(formatWorkspaceDetailValue(value))}</pre>
          </article>
        `
      )
      .join("");
    return `
      <div class="workspace-detail">
        ${card.type === "character" ? `<button type="button" class="ghost compress-character-btn" data-character-id="${escapeHtml(card.id)}">${uiText("Compress character card", "压缩角色卡")}</button><p class="workspace-compress-status" data-compress-status></p>` : ""}
        <div class="workspace-detail-grid">
          ${fields || '<article class="workspace-detail-row"><strong>Content</strong><pre>There are no fields to display.</pre></article>'}
        </div>
      </div>
    `;
  }

  function renderWorkspace(workspace) {
    const cards = buildWorkspaceCards(workspace);
    if (!cards.length) {
      state.selectedWorkspaceAssetKey = null;
      els.workspaceView.innerHTML = `<article class="workspace-card">This story does not have any active workspace asset copies yet.</article>`;
      return;
    }
    els.workspaceView.innerHTML = `
      <div class="workspace-card-list">
        ${cards
          .map(
            (item) => `
              <details class="workspace-card" data-workspace-key="${escapeHtml(item.key)}">
                <summary><span>${escapeHtml(formatWorkspaceAssetType(item.type))}</span><strong>${escapeHtml(item.title)}</strong></summary>
                <div class="workspace-card-preview">${escapeHtml(item.body || "No current summary")}</div>
                ${renderWorkspaceDetail(item)}
              </details>
            `
          )
          .join("")}
      </div>
    `;
    els.workspaceView.querySelectorAll(".compress-character-btn").forEach((button) => button.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const cardRoot = button.closest(".workspace-card");
      const status = cardRoot?.querySelector("[data-compress-status]");
      button.disabled = true;
      if (status) status.textContent = uiText("Generating a review draft...", "正在生成审核草稿……");
      try {
        const draft = await api(`/api/stories/${state.activeStoryId}/workspace/characters/${encodeURIComponent(button.dataset.characterId)}/compress`, { method: "POST" });
        const approved = confirm(
          uiText("Review this character-card compression draft:\n\n", "请审核角色卡压缩草稿：\n\n") +
            `${JSON.stringify(draft.runtimeSummary, null, 2)}\n\n` +
            uiText("Accept it?", "接受这份草稿吗？")
        );
        if (approved) {
          await api(`/api/stories/${state.activeStoryId}/workspace/characters/${encodeURIComponent(button.dataset.characterId)}/compress`, {
            method: "POST",
            body: JSON.stringify({ accept: true, runtimeSummary: draft.runtimeSummary }),
          });
          if (status) status.textContent = uiText("Compression accepted.", "压缩结果已接受。");
          await loadStory(state.activeStoryId);
        } else if (status) {
          status.textContent = uiText("Draft discarded.", "已放弃草稿。");
        }
      } catch (error) {
        if (status) status.textContent = `${uiText("Compression failed", "压缩失败")}：${error.message}`;
      } finally {
        button.disabled = false;
      }
    }));
  }

  return {
    formatWorkspaceAssetType,
    getWorkspaceAssetTitle,
    formatWorkspaceDetailValue,
    buildWorkspaceCards,
    renderWorkspaceDetail,
    renderWorkspace,
  };
};
