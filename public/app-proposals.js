window.createProposalUiTools = function createProposalUiTools({ state, els, escapeHtml, api, loadStory }) {
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
              <div class="proposal-diff-arrow" aria-hidden="true">↓</div>
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


  return { renderProposals };
};
