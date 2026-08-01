window.createWorkspaceTools = function createWorkspaceTools({
  state,
  els,
  escapeHtml,
  api,
  loadStory,
}) {
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
      <section class="workspace-detail">
        <div class="workspace-detail-head">
          <strong>${escapeHtml(formatWorkspaceAssetType(card.type))} / ${escapeHtml(card.title)}</strong>
          <span>ID: ${escapeHtml(card.id)}</span>
        </div>
        ${card.type === "character" ? `<button type="button" class="ghost compress-character-btn" data-character-id="${escapeHtml(card.id)}">Compress character card</button><p class="workspace-compress-status" data-compress-status></p>` : ""}
        <div class="workspace-detail-grid">
          ${fields || '<article class="workspace-detail-row"><strong>Content</strong><pre>There are no fields to display.</pre></article>'}
        </div>
      </section>
    `;
  }

  function renderWorkspace(workspace) {
    const cards = buildWorkspaceCards(workspace);
    if (!cards.length) {
      state.selectedWorkspaceAssetKey = null;
      els.workspaceView.innerHTML = `<article class="workspace-card">This story does not have any active workspace asset copies yet.</article>`;
      return;
    }
    const selectedKey = cards.some((item) => item.key === state.selectedWorkspaceAssetKey)
      ? state.selectedWorkspaceAssetKey
      : cards[0].key;
    state.selectedWorkspaceAssetKey = selectedKey;
    const selectedCard = cards.find((item) => item.key === selectedKey) || cards[0];
    els.workspaceView.innerHTML = `
      <div class="workspace-card-list">
        ${cards
          .map(
            (item) => `
              <article class="workspace-card ${item.key === selectedKey ? "active" : ""}" data-workspace-key="${escapeHtml(item.key)}">
                <strong>${escapeHtml(formatWorkspaceAssetType(item.type))} / ${escapeHtml(item.title)}</strong>
                <div>${escapeHtml(item.body || "Click to inspect all fields")}</div>
              </article>
            `
          )
          .join("")}
      </div>
      ${renderWorkspaceDetail(selectedCard)}
    `;
    for (const node of els.workspaceView.querySelectorAll("[data-workspace-key]")) {
      node.addEventListener("click", () => {
        state.selectedWorkspaceAssetKey = node.dataset.workspaceKey;
        renderWorkspace(state.activeStoryData?.workspace || {});
      });
    }
    els.workspaceView.querySelector(".compress-character-btn")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const status = els.workspaceView.querySelector("[data-compress-status]");
      button.disabled = true;
      if (status) status.textContent = "Generating a review draft...";
      try {
        const draft = await api(`/api/stories/${state.activeStoryId}/workspace/characters/${encodeURIComponent(button.dataset.characterId)}/compress`, { method: "POST" });
        const approved = confirm(`Review this character-card compression draft:\n\n${JSON.stringify(draft.runtimeSummary, null, 2)}\n\nAccept it?`);
        if (approved) {
          await api(`/api/stories/${state.activeStoryId}/workspace/characters/${encodeURIComponent(button.dataset.characterId)}/compress`, {
            method: "POST",
            body: JSON.stringify({ accept: true, runtimeSummary: draft.runtimeSummary }),
          });
          if (status) status.textContent = "Compression accepted.";
          await loadStory(state.activeStoryId);
        } else if (status) {
          status.textContent = "Draft discarded.";
        }
      } catch (error) {
        if (status) status.textContent = `Compression failed: ${error.message}`;
      } finally {
        button.disabled = false;
      }
    });
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
