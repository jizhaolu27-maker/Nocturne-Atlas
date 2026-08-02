window.createMemoryUiTools = function createMemoryUiTools({ els, escapeHtml }) {
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
                ${buildCanonMetaLines(item)
                  .map((line) => `<div class="memory-trigger">${escapeHtml(line)}</div>`)
                  .join("")}
              </article>
            `
          )
          .join("")
      : `<article class="memory-item">No memory summaries have been generated yet.</article>`;
  }

  return { renderMemory };
};
