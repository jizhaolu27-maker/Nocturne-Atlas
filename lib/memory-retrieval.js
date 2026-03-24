function clampScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(1, numeric));
}

function unique(values = []) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeVectorMatches(matches = [], idKey = "recordId") {
  return (Array.isArray(matches) ? matches : [])
    .map((item) => ({
      id: String(item?.[idKey] || item?.itemId || ""),
      score: clampScore(item?.score),
      reason: String(item?.reason || "vector match"),
    }))
    .filter((item) => item.id);
}

function buildFallbackMeta(mode, vectorEnabled, message) {
  return {
    mode,
    activeMode: "lexical",
    vectorEnabled: mode === "lexical" ? false : vectorEnabled,
    vectorCandidateCount: 0,
    vectorSelectedCount: 0,
    evidenceCandidateCount: 0,
    evidenceSelectedCount: 0,
    fallbackReason: message || "",
  };
}

function mergeRecordSelections(memoryRecords, lexicalSelection, options = {}) {
  const maxItems = Math.max(1, Number(options.maxItems) || 4);
  const requestedMode = options.mode === "rag" ? "rag" : "hybrid";
  const vectorEnabled = Boolean(options.vectorEnabled) && typeof options.vectorSearchRecords === "function";

  if (!vectorEnabled) {
    return {
      selectedRecords: lexicalSelection.selectedRecords || [],
      reasonsById: lexicalSelection.reasonsById || {},
      query: lexicalSelection.query,
      retrievalMeta: buildFallbackMeta(
        requestedMode,
        false,
        requestedMode === "hybrid"
          ? "Vector enhancer unavailable for this query"
          : "Embedding enhancer unavailable; memory facts stayed lexical",
      ),
    };
  }

  const vectorMatches = normalizeVectorMatches(
    options.vectorSearchRecords({
      memoryRecords,
      query: lexicalSelection.query,
      options: options.searchOptions || {},
    }),
    "recordId"
  );
  if (!vectorMatches.length) {
    return {
      selectedRecords: lexicalSelection.selectedRecords || [],
      reasonsById: lexicalSelection.reasonsById || {},
      query: lexicalSelection.query,
      retrievalMeta: buildFallbackMeta(
        requestedMode,
        true,
        requestedMode === "hybrid"
          ? "No vector candidates passed the similarity threshold"
          : "No memory-fact embedding candidates passed the similarity threshold",
      ),
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
    const record = recordById.get(match.id);
    if (!record) {
      continue;
    }
    const existing = merged.get(match.id) || {
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
    merged.set(match.id, existing);
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
      mode: requestedMode,
      activeMode: selected.some((item) => item.vectorScore > 0) ? "hybrid" : "lexical",
      vectorEnabled: true,
      vectorCandidateCount: vectorMatches.length,
      vectorSelectedCount: selected.filter((item) => item.vectorScore > 0).length,
      evidenceCandidateCount: 0,
      evidenceSelectedCount: 0,
      fallbackReason: selected.some((item) => item.vectorScore > 0)
        ? ""
        : requestedMode === "hybrid"
          ? "Vector matches did not alter final selection"
          : "Embedding matches did not alter memory-fact selection",
    },
  };
}

function getChunkTerms(chunk) {
  return {
    subjects: unique([...(chunk?.subjectIds || []), ...(chunk?.objectIds || [])].map(normalizeText)).filter(Boolean),
    entities: unique((chunk?.entities || []).map(normalizeText)).filter(Boolean),
    tags: unique((chunk?.tags || []).map(normalizeText)).filter(Boolean),
    keywords: unique((chunk?.keywords || []).map(normalizeText)).filter(Boolean),
  };
}

function scoreEvidenceChunk(chunk, query, selectedRecordIds = new Set()) {
  const text = normalizeText(chunk?.text || "");
  const terms = getChunkTerms(chunk);
  let score = 0;
  const reasons = [];

  const subjectHits = terms.subjects.filter((term) => query.matchedEntityIds?.includes(term));
  if (subjectHits.length) {
    score += unique(subjectHits).length * 8;
    reasons.push(`Matched subjects: ${unique(subjectHits).slice(0, 2).join(", ")}`);
  }

  const entityHits = unique(
    terms.entities.filter((term) => term && (query.rawText?.includes(term) || query.matchedWorkspaceTerms?.includes(term)))
  );
  if (entityHits.length) {
    score += entityHits.length * 5;
    reasons.push(`Matched entities: ${entityHits.slice(0, 2).join(", ")}`);
  }

  const tagHits = unique(
    terms.tags.filter((term) => query.keywords?.includes(term) || query.matchedWorkspaceTerms?.includes(term))
  );
  if (tagHits.length) {
    score += tagHits.length * 4;
    reasons.push(`Matched tags: ${tagHits.slice(0, 2).join(", ")}`);
  }

  const keywordHits = unique(
    terms.keywords.filter(
      (term) => query.keywords?.includes(term) || query.matchedWorkspaceTerms?.includes(term) || text.includes(term)
    )
  );
  if (keywordHits.length) {
    score += keywordHits.length * 3;
    reasons.push(`Matched keywords: ${keywordHits.slice(0, 3).join(", ")}`);
  }

  if (selectedRecordIds.has(String(chunk?.linkedRecordId || ""))) {
    score += 3;
    reasons.push("Linked to a selected memory fact");
  }

  if (query.matchedEntityScopes?.includes(chunk?.scope)) {
    score += 2;
    reasons.push("Scope-aligned");
  }

  if (chunk?.importance === "high") {
    score += 2;
    reasons.push("High importance");
  }

  if (chunk?.stability === "stable") {
    score += 1;
    reasons.push("Stable canon");
  }

  if (chunk?.sourceRole === "assistant") {
    score += 1;
    reasons.push("Assistant-side evidence");
  }

  return {
    chunk,
    score,
    reasons: unique(reasons),
  };
}

function selectEvidenceChunks(memoryChunks, options = {}) {
  const requestedMode = options.mode === "rag" ? "rag" : "lexical";
  if (requestedMode !== "rag") {
    return {
      selectedEvidenceChunks: [],
      reasonsById: {},
      retrievalMeta: {
        evidenceCandidateCount: 0,
        evidenceSelectedCount: 0,
        vectorCandidateCount: 0,
        vectorSelectedCount: 0,
      },
    };
  }

  const chunks = Array.isArray(memoryChunks) ? memoryChunks : [];
  const query = options.query || {};
  const selectedRecordIds = new Set((options.selectedRecords || []).map((item) => String(item?.id || "")));
  const lexicalCandidates = chunks
    .map((chunk) => scoreEvidenceChunk(chunk, query, selectedRecordIds))
    .filter((item) => item.score > 0);

  const lexicalById = new Map();
  for (const item of lexicalCandidates) {
    lexicalById.set(item.chunk.id, item);
  }

  const vectorEnabled = Boolean(options.vectorEnabled) && typeof options.vectorSearchItems === "function";
  const vectorMatches = vectorEnabled
    ? normalizeVectorMatches(
        options.vectorSearchItems({
          items: chunks,
          options: options.searchOptions || {},
        }),
        "itemId"
      )
    : [];
  const vectorById = new Map(vectorMatches.map((item) => [item.id, item]));

  const merged = new Map();
  for (const item of lexicalCandidates) {
    merged.set(item.chunk.id, {
      chunk: item.chunk,
      lexicalScore: item.score,
      vectorScore: 0,
      reasons: [...item.reasons],
    });
  }

  for (const match of vectorMatches) {
    const chunk = chunks.find((item) => item.id === match.id);
    if (!chunk) {
      continue;
    }
    const existing = merged.get(match.id) || {
      chunk,
      lexicalScore: 0,
      vectorScore: 0,
      reasons: [],
    };
    existing.vectorScore = Math.max(existing.vectorScore, match.score);
    if (!existing.reasons.includes(match.reason)) {
      existing.reasons.push(match.reason);
    }
    if (existing.lexicalScore === 0 && match.score >= 0.45) {
      existing.reasons.push("Semantic-only retrieval candidate");
    }
    merged.set(match.id, existing);
  }

  const ranked = Array.from(merged.values())
    .filter((item) => item.lexicalScore > 0 || item.vectorScore >= 0.45)
    .map((item) => ({
      ...item,
      finalScore: item.lexicalScore * 0.65 + item.vectorScore * 0.35,
    }))
    .sort(
      (a, b) =>
        b.finalScore - a.finalScore || String(b.chunk.createdAt || "").localeCompare(String(a.chunk.createdAt || ""))
    );

  const maxItems = Math.max(1, Number(options.maxItems) || 3);
  const selected = ranked.slice(0, maxItems);
  return {
    selectedEvidenceChunks: selected.map((item) => item.chunk),
    reasonsById: Object.fromEntries(selected.map((item) => [item.chunk.id, unique(item.reasons)])),
    retrievalMeta: {
      evidenceCandidateCount: merged.size,
      evidenceSelectedCount: selected.length,
      vectorCandidateCount: vectorMatches.length,
      vectorSelectedCount: selected.filter((item) => item.vectorScore > 0).length,
    },
  };
}

function createMemoryRetrievalTools({
  selectRelevantMemoryRecords,
  formatMemoryContext,
  vectorSearchRecords,
  vectorSearchItems,
  isVectorSearchEnabled = () => false,
}) {
  function selectMemoryRecords(memoryRecords, options = {}) {
    const requestedMode =
      options.retrievalMode === "rag" ? "rag" : options.retrievalMode === "hybrid" ? "hybrid" : "lexical";
    const lexicalSelection = selectRelevantMemoryRecords(memoryRecords, options);

    if (requestedMode === "lexical") {
      return {
        ...lexicalSelection,
        selectedEvidenceChunks: [],
        selectedEvidenceReasons: {},
        retrievalMeta: buildFallbackMeta("lexical", false, ""),
      };
    }

    if (requestedMode === "hybrid") {
      const hybridSelection = mergeRecordSelections(memoryRecords, lexicalSelection, {
        mode: "hybrid",
        vectorEnabled: Boolean(isVectorSearchEnabled(options)),
        vectorSearchRecords,
        maxItems: options.maxItems,
        searchOptions: options,
      });
      return {
        ...hybridSelection,
        selectedEvidenceChunks: [],
        selectedEvidenceReasons: {},
      };
    }

    const recordSelection = mergeRecordSelections(memoryRecords, lexicalSelection, {
      mode: "rag",
      vectorEnabled: Boolean(isVectorSearchEnabled(options)),
      vectorSearchRecords,
      maxItems: options.maxItems,
      searchOptions: options,
    });
    const evidenceSelection = selectEvidenceChunks(options.memoryChunks || [], {
      mode: "rag",
      query: recordSelection.query,
      selectedRecords: recordSelection.selectedRecords,
      vectorEnabled: Boolean(isVectorSearchEnabled(options)),
      vectorSearchItems,
      maxItems: options.maxEvidenceItems,
      searchOptions: options,
    });

    const evidenceSelected = evidenceSelection.selectedEvidenceChunks.length;
    const vectorEnhancementEnabled = Boolean(isVectorSearchEnabled(options));
    const usedEmbedding =
      Number(recordSelection.retrievalMeta.vectorSelectedCount || 0) > 0 ||
      Number(evidenceSelection.retrievalMeta.vectorSelectedCount || 0) > 0;
    return {
      selectedRecords: recordSelection.selectedRecords,
      reasonsById: recordSelection.reasonsById,
      query: recordSelection.query,
      selectedEvidenceChunks: evidenceSelection.selectedEvidenceChunks,
      selectedEvidenceReasons: evidenceSelection.reasonsById,
      retrievalMeta: {
        mode: "rag",
        activeMode: evidenceSelected > 0 ? "rag" : usedEmbedding ? "hybrid" : "lexical",
        vectorEnabled: Boolean(isVectorSearchEnabled(options)),
        vectorCandidateCount:
          Number(recordSelection.retrievalMeta.vectorCandidateCount || 0) +
          Number(evidenceSelection.retrievalMeta.vectorCandidateCount || 0),
        vectorSelectedCount:
          Number(recordSelection.retrievalMeta.vectorSelectedCount || 0) +
          Number(evidenceSelection.retrievalMeta.vectorSelectedCount || 0),
        evidenceCandidateCount: evidenceSelection.retrievalMeta.evidenceCandidateCount || 0,
        evidenceSelectedCount: evidenceSelection.retrievalMeta.evidenceSelectedCount || 0,
        fallbackReason: evidenceSelected
          ? vectorEnhancementEnabled
            ? usedEmbedding
              ? ""
              : "Memory RAG stayed lexical for this turn even though embeddings were available"
            : "Memory RAG is active, but embedding enhancement was unavailable for this turn"
          : recordSelection.retrievalMeta.fallbackReason || "No memory evidence chunks were strong enough to inject this turn",
      },
    };
  }

  return {
    formatMemoryContext,
    selectRelevantMemoryRecords: selectMemoryRecords,
  };
}

module.exports = {
  createMemoryRetrievalTools,
};
