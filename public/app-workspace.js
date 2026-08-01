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
    const injectionModes = workspace.injectionModes || {};
    return [
      ...(workspace.characters || []).map((item) => ({
        key: `character:${item.id}`,
        type: "character",
        id: item.id,
        title: getWorkspaceAssetTitle("character", item),
        body: item.arcState?.current || item.notes || "",
        injectionMode: injectionModes.characters?.[item.id] || "keyword",
        item,
      })),
      ...(workspace.worldbooks || []).map((item) => ({
        key: `worldbook:${item.id}`,
        type: "worldbook",
        id: item.id,
        title: getWorkspaceAssetTitle("worldbook", item),
        body: item.storyState || item.content || "",
        injectionMode: injectionModes.worldbooks?.[item.id] || "keyword",
        item,
      })),
      ...(workspace.styles || []).map((item) => ({
        key: `style:${item.id}`,
        type: "style",
        id: item.id,
        title: getWorkspaceAssetTitle("style", item),
        body: `${item.tone || ""} / ${item.voice || ""}`,
        injectionMode: injectionModes.styles?.[item.id] || "keyword",
        item,
      })),
    ];
  }

  function renderWorkspaceDetail(card) {
    const fields = Object.entries(card.item || {})
      .filter(([key]) => !["workspaceUpdatedAt", "changeLog", "sourceId", "sourceUpdatedAt", "createdAt", "updatedAt"].includes(key))
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
                <summary><span>${escapeHtml(formatWorkspaceAssetType(item.type))}</span>${["character", "worldbook"].includes(item.type) ? `<button type="button" class="compress-asset-btn" data-asset-type="${escapeHtml(item.type)}" data-asset-id="${escapeHtml(item.id)}">${uiText(item.type === "character" ? "Compress character card" : "Compress worldbook", item.type === "character" ? "压缩角色卡" : "压缩世界书")}</button><span class="workspace-compress-status" data-compress-status></span>` : ""}<strong>${escapeHtml(item.title)}</strong><button type="button" class="canon-injection-toggle" data-asset-type="${escapeHtml(item.type)}" data-asset-id="${escapeHtml(item.id)}" data-injection-mode="${escapeHtml(item.injectionMode)}">${escapeHtml(item.injectionMode === "always" ? "Always" : "Keyword")}</button></summary>
                <div class="workspace-card-preview">${escapeHtml(item.body || "No current summary")}</div>
                ${renderWorkspaceDetail(item)}
              </details>
            `
          )
          .join("")}
      </div>
    `;
    els.workspaceView.querySelectorAll(".canon-injection-toggle").forEach((button) => button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const type = `${button.dataset.assetType}s`;
      const current = state.activeStoryData?.story?.enabled || {};
      const modes = {
        characters: { ...(current.injectionModes?.characters || {}) },
        worldbooks: { ...(current.injectionModes?.worldbooks || {}) },
        styles: { ...(current.injectionModes?.styles || {}) },
      };
      const nextMode = button.dataset.injectionMode === "always" ? "keyword" : "always";
      modes[type][button.dataset.assetId] = nextMode;
      button.dataset.injectionMode = nextMode;
      button.textContent = nextMode === "always" ? "Always" : "Keyword";
      try {
        await api(`/api/stories/${state.activeStoryId}/config`, {
          method: "POST",
            body: JSON.stringify({ enabled: { ...current, injectionModes: modes } }),
        });
        if (state.activeStoryData?.story) {
          state.activeStoryData.story.enabled = {
            ...state.activeStoryData.story.enabled,
            injectionModes: modes,
          };
        }
        await loadStory(state.activeStoryId);
      } catch (error) {
        button.dataset.injectionMode = nextMode === "always" ? "keyword" : "always";
        button.textContent = button.dataset.injectionMode === "always" ? "Always" : "Keyword";
        console.error("Failed to update asset injection mode", error);
      }
    }));
    els.workspaceView.querySelectorAll(".compress-asset-btn").forEach((button) => button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const button = event.currentTarget;
      const cardRoot = button.closest(".workspace-card");
      const status = cardRoot?.querySelector("[data-compress-status]");
      button.disabled = true;
      if (status) status.textContent = uiText("Generating a review draft...", "正在生成审核草稿……");
      try {
        const assetType = button.dataset.assetType;
        const assetPath = assetType === "character" ? "characters" : "worldbooks";
        const draft = await api(`/api/stories/${state.activeStoryId}/workspace/${assetPath}/${encodeURIComponent(button.dataset.assetId)}/compress`, { method: "POST" });
        const approved = confirm(
          uiText(assetType === "character" ? "Review this character-card compression draft:\n\n" : "Review this worldbook compression draft:\n\n", assetType === "character" ? "请审核角色卡压缩草稿：\n\n" : "请审核世界书压缩草稿：\n\n") +
            `${JSON.stringify(draft.runtimeSummary, null, 2)}\n\n` +
            uiText("Accept it?", "接受这份草稿吗？")
        );
        if (approved) {
          await api(`/api/stories/${state.activeStoryId}/workspace/${assetPath}/${encodeURIComponent(button.dataset.assetId)}/compress`, {
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
