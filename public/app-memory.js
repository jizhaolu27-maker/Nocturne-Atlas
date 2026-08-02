window.createMemoryUiTools = function createMemoryUiTools({ els, escapeHtml, state, api, loadStory, reviewCompressionDraft }) {
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

  function formatSummaryTrigger(trigger) {
    const value = String(trigger || "");
    if (value.startsWith("Turn interval reached")) return "Configured turn interval reached";
    if (value === "Context pressure exceeded high threshold") return "Context pressure exceeded the high threshold";
    if (value === "Major event keywords detected in recent turns") return "Major event keywords were detected in recent turns";
    if (value === "Memory consolidation threshold reached") return "Short-term memory reached the consolidation threshold";
    return value || "Unknown trigger reason";
  }

  function renderMemory(records) {
    els.memoryList.innerHTML = records.length
      ? records
          .slice()
          .reverse()
          .map(
            (item) => `
              <article class="memory-item">
                <div class="memory-meta"><span>${escapeHtml(formatMemoryKind(item.kind))}</span><span>${escapeHtml(formatMemoryTier(item.tier))}</span></div>
                <div class="memory-summary">${escapeHtml(item.summary)}</div>
                <button class="memory-delete-btn ghost" type="button" data-memory-delete="${escapeHtml(item.id)}" title="Delete memory" aria-label="Delete memory">×</button>
              </article>
            `
          )
          .join("")
      : `<article class="memory-item">No memory summaries have been generated yet.</article>`;
    for (const button of els.memoryList.querySelectorAll("[data-memory-delete]")) {
      button.addEventListener("click", async () => {
        if (!confirm("Delete this memory?")) return;
        button.disabled = true;
        try {
          await api(`/api/stories/${state.activeStoryId}/memory/${button.dataset.memoryDelete}`, { method: "DELETE" });
          await loadStory(state.activeStoryId);
        } catch (error) {
          button.disabled = false;
          alert(`Unable to delete memory: ${error.message}`);
        }
      });
    }
  }

  els.memoryCompressBtn?.addEventListener("click", async () => {
    if (!state.activeStoryId) return;
    els.memoryCompressBtn.disabled = true;
    try {
      const draft = await api(`/api/stories/${state.activeStoryId}/memory/compress`, { method: "POST" });
      const reviewed = await reviewCompressionDraft({ records: draft.records || [] });
      if (reviewed?.records) {
        await api(`/api/stories/${state.activeStoryId}/memory/compress`, { method: "POST", body: JSON.stringify({ accept: true, records: reviewed.records }) });
        await loadStory(state.activeStoryId);
      }
    } catch (error) {
      alert(`Memory compression failed: ${error.message}`);
    } finally {
      els.memoryCompressBtn.disabled = false;
    }
  });

  return { renderMemory };
};
