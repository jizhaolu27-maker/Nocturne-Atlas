function clampScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(1, numeric));
}

function createMemoryRetrievalTools({
  selectRelevantMemoryRecords,
  formatMemoryContext,
  vectorSearchRecords,
  isVectorSearchEnabled = () => false,
}) {
  function normalizeVectorMatches(matches) {
    return (Array.isArray(matches) ? matches : [])
      .map((item) => ({
        recordId: String(item?.recordId || ""),
        score: clampScore(item?.score),
        reason: String(item?.reason || "vector match"),
      }))
      .filter((item) => item.recordId);
  }

  function selectHybridMemoryRecords(memoryRecords, options = {}) {
    const lexicalSelection = selectRelevantMemoryRecords(memoryRecords, options);
    const maxItems = Math.max(1, Number(options.maxItems) || 4);
    const requestedMode = options.retrievalMode === "hybrid" ? "hybrid" : "lexical";
    const vectorEnabled = Boolean(isVectorSearchEnabled(options)) && typeof vectorSearchRecords === "function";

    if (requestedMode !== "hybrid" || !vectorEnabled) {
      return {
        ...lexicalSelection,
        retrievalMeta: {
          mode: requestedMode,
          activeMode: "lexical",
          vectorEnabled: requestedMode === "hybrid" ? vectorEnabled : false,
          vectorCandidateCount: 0,
          vectorSelectedCount: 0,
          fallbackReason: requestedMode === "hybrid" && !vectorEnabled ? "Vector enhancer unavailable for this query" : "",
        },
      };
    }

    const vectorMatches = normalizeVectorMatches(
      vectorSearchRecords({
        memoryRecords,
        query: lexicalSelection.query,
        options,
      })
    );
    if (!vectorMatches.length) {
      return {
        ...lexicalSelection,
        retrievalMeta: {
          mode: "hybrid",
          activeMode: "lexical",
          vectorEnabled: true,
          vectorCandidateCount: 0,
          vectorSelectedCount: 0,
          fallbackReason: "No vector candidates passed the similarity threshold",
        },
      };
    }

    const recordById = new Map((Array.isArray(memoryRecords) ? memoryRecords : []).map((item) => [item.id, item]));
    const lexicalById = new Map(
      (lexicalSelection.selectedRecords || []).map((item, index) => [item.id, { record: item, lexicalRank: index }])
    );
    const merged = new Map();

    for (const [recordId, info] of lexicalById.entries()) {
      merged.set(recordId, {
        record: info.record,
        lexicalRank: info.lexicalRank,
        lexicalScore: Math.max(0, 1 - info.lexicalRank / Math.max(1, maxItems)),
        vectorScore: 0,
        reasons: [...(lexicalSelection.reasonsById?.[recordId] || [])],
      });
    }

    for (const match of vectorMatches) {
      const record = recordById.get(match.recordId);
      if (!record) {
        continue;
      }
      const existing = merged.get(match.recordId) || {
        record,
        lexicalRank: null,
        lexicalScore: 0,
        vectorScore: 0,
        reasons: [],
      };
      existing.vectorScore = Math.max(existing.vectorScore, match.score);
      if (!existing.reasons.includes(match.reason)) {
        existing.reasons.push(match.reason);
      }
      merged.set(match.recordId, existing);
    }

    const ranked = Array.from(merged.values())
      .map((item) => ({
        ...item,
        finalScore: item.lexicalScore * 0.75 + item.vectorScore * 0.25,
      }))
      .sort((a, b) => b.finalScore - a.finalScore || String(b.record.createdAt || "").localeCompare(String(a.record.createdAt || "")));

    const selected = ranked.slice(0, maxItems);
    return {
      selectedRecords: selected.map((item) => item.record),
      reasonsById: Object.fromEntries(selected.map((item) => [item.record.id, item.reasons])),
      query: lexicalSelection.query,
      retrievalMeta: {
        mode: "hybrid",
        activeMode: selected.some((item) => item.vectorScore > 0) ? "hybrid" : "lexical",
        vectorEnabled: true,
        vectorCandidateCount: vectorMatches.length,
        vectorSelectedCount: selected.filter((item) => item.vectorScore > 0).length,
        fallbackReason: selected.some((item) => item.vectorScore > 0) ? "" : "Vector matches did not alter final selection",
      },
    };
  }

  return {
    formatMemoryContext,
    selectRelevantMemoryRecords: selectHybridMemoryRecords,
  };
}

module.exports = {
  createMemoryRetrievalTools,
};
