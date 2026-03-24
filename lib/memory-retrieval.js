const { buildMemoryCanonKey, buildMemoryConflictGroup } = require("./memory-schema");

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

function buildFallbackMeta(vectorEnabled, message) {
  return {
    mode: "rag",
    activeMode: "lexical",
    vectorEnabled: Boolean(vectorEnabled),
    vectorCandidateCount: 0,
    vectorSelectedCount: 0,
    evidenceCandidateCount: 0,
    evidenceSelectedCount: 0,
    fallbackReason: message || "",
  };
}

function getRecordDiversityKey(record) {
  const scope = String(record?.scope || "plot");
  const primarySubject = String(record?.subjectIds?.[0] || record?.objectIds?.[0] || "").trim();
  const firstEntity = String(record?.entities?.[0] || "").trim().toLowerCase();
  return primarySubject ? `${scope}:${primarySubject}` : firstEntity ? `${scope}:${firstEntity}` : String(record?.id || "");
}

function getEvidenceDiversityKey(chunk) {
  const linkedRecordId = String(chunk?.linkedRecordId || "").trim();
  if (linkedRecordId) {
    return `record:${linkedRecordId}`;
  }
  const primarySubject = String(chunk?.subjectIds?.[0] || chunk?.objectIds?.[0] || "").trim();
  if (primarySubject) {
    return `subject:${primarySubject}`;
  }
  const sourceRange = Array.isArray(chunk?.sourceMessageRange) ? chunk.sourceMessageRange.join("-") : "";
  return sourceRange ? `range:${sourceRange}` : String(chunk?.id || "");
}

function getRecordTerms(record) {
  return unique(
    [
      ...(record?.subjectIds || []),
      ...(record?.objectIds || []),
      ...(record?.entities || []),
      ...(record?.tags || []),
      ...(record?.keywords || []),
      record?.scope,
      record?.kind,
      record?.summary,
    ].map(normalizeText)
  ).filter(Boolean);
}

function getRecordConflictTerms(record) {
  const excluded = new Set(
    unique([...(record?.subjectIds || []), ...(record?.objectIds || []), record?.scope, record?.kind].map(normalizeText)).filter(
      Boolean
    )
  );
  return getRecordTerms(record).filter((term) => !excluded.has(term));
}

function getPrimaryRecordSubject(record) {
  return String(record?.subjectIds?.[0] || record?.objectIds?.[0] || "")
    .trim()
    .toLowerCase();
}

function computeSharedTermCount(leftTerms = [], rightTerms = []) {
  const left = new Set(unique(leftTerms).filter(Boolean));
  const right = new Set(unique(rightTerms).filter(Boolean));
  let count = 0;
  for (const term of left) {
    if (right.has(term)) {
      count += 1;
    }
  }
  return count;
}

function flattenTerms(groups = {}) {
  return unique([...(groups.subjects || []), ...(groups.entities || []), ...(groups.tags || []), ...(groups.keywords || [])]);
}

function computeOverlapRatio(candidateTerms = [], existingTerms = []) {
  const candidate = unique(candidateTerms).filter(Boolean);
  const existing = new Set(unique(existingTerms).filter(Boolean));
  if (!candidate.length || !existing.size) {
    return 0;
  }
  const overlap = candidate.filter((term) => existing.has(term)).length;
  return overlap / Math.max(candidate.length, existing.size);
}

function computeRecencyScore(createdAt, newestTimestamp, oldestTimestamp) {
  const timestamp = Date.parse(createdAt || "");
  if (!Number.isFinite(timestamp)) {
    return 0.5;
  }
  if (!Number.isFinite(newestTimestamp) || !Number.isFinite(oldestTimestamp) || newestTimestamp === oldestTimestamp) {
    return 0.5;
  }
  return clampScore((timestamp - oldestTimestamp) / Math.max(1, newestTimestamp - oldestTimestamp));
}

function selectNovelRankedItems(rankedItems, maxItems, getKey, getTerms) {
  const ranked = Array.isArray(rankedItems) ? rankedItems : [];
  const selected = [];
  const seenKeys = new Set();

  while (selected.length < maxItems && selected.length < ranked.length) {
    let best = null;
    for (const item of ranked) {
      if (selected.includes(item)) {
        continue;
      }
      const key = String(getKey(item) || "");
      const candidateTerms = Array.isArray(getTerms(item)) ? getTerms(item) : [];
      const overlapPenalty = selected.reduce(
        (maxPenalty, chosen) => Math.max(maxPenalty, computeOverlapRatio(candidateTerms, getTerms(chosen))),
        0
      );
      const keyPenalty = key && seenKeys.has(key) ? 0.2 : 0;
      const adjustedScore = Number(item.adjustedScore ?? item.finalScore ?? 0) - overlapPenalty * 0.18 - keyPenalty;
      if (!best || adjustedScore > best.adjustedScore) {
        best = { item, key, adjustedScore };
      }
    }
    if (!best) {
      break;
    }
    if (best.key) {
      seenKeys.add(best.key);
    }
    selected.push(best.item);
  }

  return selected;
}

function mergeRecordSelections(memoryRecords, lexicalSelection, options = {}) {
  const maxItems = Math.max(1, Number(options.maxItems) || 4);
  const vectorEnabled = Boolean(options.vectorEnabled) && typeof options.vectorSearchRecords === "function";
  const lexicalCandidateCount = Math.max(1, (lexicalSelection.selectedRecords || []).length);
  const lexicalRankedItems = (lexicalSelection.selectedRecords || []).map((record, index) => ({
    record,
    lexicalRank: index,
    lexicalScore: Math.max(0, 1 - index / lexicalCandidateCount),
    vectorScore: 0,
    confidenceScore: clampScore(record?.confidence ?? 0.6),
    stabilityScore: record?.stability === "stable" || record?.tier === "long_term" || record?.importance === "high" ? 1 : 0,
    recencyScore: 0.5,
    reasons: [...(lexicalSelection.reasonsById?.[record.id] || [])],
    finalScore: Math.max(0, 1 - index / lexicalCandidateCount),
  }));

  if (!vectorEnabled) {
    return {
      selectedRecords: lexicalSelection.selectedRecords || [],
      reasonsById: lexicalSelection.reasonsById || {},
      query: lexicalSelection.query,
      rankedItems: lexicalRankedItems,
      retrievalMeta: buildFallbackMeta(false, "Memory RAG is active, but embedding enhancement was unavailable for this turn"),
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
      rankedItems: lexicalRankedItems,
      retrievalMeta: buildFallbackMeta(true, "No memory-fact embedding candidates passed the similarity threshold"),
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
      lexicalScore: Math.max(0, 1 - info.lexicalRank / lexicalCandidateCount),
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

  const timestamps = Array.from(merged.values())
    .map((item) => Date.parse(item.record?.createdAt || ""))
    .filter(Number.isFinite);
  const newestTimestamp = timestamps.length ? Math.max(...timestamps) : NaN;
  const oldestTimestamp = timestamps.length ? Math.min(...timestamps) : NaN;

  const ranked = Array.from(merged.values())
    .map((item) => ({
      ...item,
      confidenceScore: clampScore(item.record?.confidence ?? 0.6),
      stabilityScore:
        item.record?.stability === "stable" || item.record?.tier === "long_term" || item.record?.importance === "high" ? 1 : 0,
      recencyScore: computeRecencyScore(item.record?.createdAt, newestTimestamp, oldestTimestamp),
      finalScore:
        item.lexicalScore * 0.5 +
        item.vectorScore * 0.22 +
        clampScore(item.record?.confidence ?? 0.6) * 0.14 +
        (item.record?.stability === "stable" || item.record?.tier === "long_term" || item.record?.importance === "high" ? 1 : 0) * 0.08 +
        computeRecencyScore(item.record?.createdAt, newestTimestamp, oldestTimestamp) * 0.06,
    }))
    .sort((a, b) => b.finalScore - a.finalScore || String(b.record.createdAt || "").localeCompare(String(a.record.createdAt || "")));

  const selected = selectNovelRankedItems(
    ranked,
    maxItems,
    (item) => getRecordDiversityKey(item.record),
    (item) => getRecordTerms(item.record)
  );
  return {
    selectedRecords: selected.map((item) => item.record),
    reasonsById: Object.fromEntries(selected.map((item) => [item.record.id, unique(item.reasons)])),
    query: lexicalSelection.query,
    rankedItems: ranked,
    retrievalMeta: {
      mode: "rag",
      activeMode: selected.some((item) => item.vectorScore > 0) ? "hybrid" : "lexical",
      vectorEnabled: true,
      vectorCandidateCount: vectorMatches.length,
      vectorSelectedCount: selected.filter((item) => item.vectorScore > 0).length,
      evidenceCandidateCount: 0,
      evidenceSelectedCount: 0,
      fallbackReason: selected.some((item) => item.vectorScore > 0) ? "" : "Embedding matches did not alter memory-fact selection",
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

function buildEvidenceSupportMap(selectedItems = []) {
  const support = new Map();
  for (const item of Array.isArray(selectedItems) ? selectedItems : []) {
    const recordId = String(item?.chunk?.linkedRecordId || "").trim();
    if (!recordId) {
      continue;
    }
    const nextValue = Math.min(
      0.28,
      (support.get(recordId) || 0) + 0.06 + clampScore(item.vectorScore) * 0.08 + clampScore(item.finalScore) * 0.14
    );
    support.set(recordId, nextValue);
  }
  return support;
}

function buildContestedMemoryCandidates(rankedItems = [], selectedItems = [], maxItems = 2) {
  const selectedIds = new Set((selectedItems || []).map((item) => String(item?.record?.id || "")));
  const selectedDescriptors = (selectedItems || []).map((item) => ({
    id: String(item?.record?.id || ""),
    key: getRecordDiversityKey(item?.record),
    canonKey: buildMemoryCanonKey(item?.record),
    conflictGroup: buildMemoryConflictGroup(item?.record),
    terms: getRecordTerms(item?.record),
    conflictTerms: getRecordConflictTerms(item?.record),
    scope: String(item?.record?.scope || "plot").trim().toLowerCase(),
    primarySubject: getPrimaryRecordSubject(item?.record),
    kind: String(item?.record?.kind || "").trim().toLowerCase(),
    score: Number(item?.adjustedScore ?? item?.finalScore ?? 0),
  }));
  const contested = [];

  for (const item of Array.isArray(rankedItems) ? rankedItems : []) {
    const recordId = String(item?.record?.id || "");
    if (!recordId || selectedIds.has(recordId)) {
      continue;
    }

    const itemTerms = getRecordTerms(item.record);
    const itemConflictTerms = getRecordConflictTerms(item.record);
    const itemKey = getRecordDiversityKey(item.record);
    const itemCanonKey = buildMemoryCanonKey(item.record);
    const itemConflictGroup = buildMemoryConflictGroup(item.record);
    const itemScore = Number(item.adjustedScore ?? item.finalScore ?? 0);
    const itemScope = String(item.record?.scope || "plot").trim().toLowerCase();
    const itemPrimarySubject = getPrimaryRecordSubject(item.record);
    const itemKind = String(item.record?.kind || "").trim().toLowerCase();
    const competing = selectedDescriptors
      .map((selected) => ({
        ...selected,
        sameKey: selected.key && itemKey && selected.key === itemKey,
        sameCanonKey: selected.canonKey && itemCanonKey && selected.canonKey === itemCanonKey,
        sameConflictGroup:
          selected.conflictGroup && itemConflictGroup && selected.conflictGroup === itemConflictGroup,
        sameScope: selected.scope && itemScope && selected.scope === itemScope,
        samePrimarySubject: selected.primarySubject && itemPrimarySubject && selected.primarySubject === itemPrimarySubject,
        sameKind: selected.kind && itemKind && selected.kind === itemKind,
        overlap: computeOverlapRatio(itemTerms, selected.terms),
        detailOverlap: computeOverlapRatio(itemConflictTerms, selected.conflictTerms),
        sharedDetailCount: computeSharedTermCount(itemConflictTerms, selected.conflictTerms),
        scoreGap: Math.abs(selected.score - itemScore),
      }))
      .sort(
        (a, b) =>
          Number(b.sameCanonKey) - Number(a.sameCanonKey) ||
          Number(b.sameConflictGroup) - Number(a.sameConflictGroup) ||
          Number((b.samePrimarySubject && b.sameScope) || b.sameKey) - Number((a.samePrimarySubject && a.sameScope) || a.sameKey) ||
          Number(b.sameKind) - Number(a.sameKind) ||
          b.sharedDetailCount - a.sharedDetailCount ||
          b.detailOverlap - a.detailOverlap ||
          b.overlap - a.overlap ||
          a.scoreGap - b.scoreGap
      )[0];

    if (!competing) {
      continue;
    }

    const sameSubjectSlot = Boolean(competing.samePrimarySubject && competing.sameScope);
    const sameEntitySlot = Boolean(competing.sameKey && competing.sameKind);
    const sameStructuredSlot = Boolean(competing.sameConflictGroup || competing.sameCanonKey);
    const sameCanonSlot =
      (sameStructuredSlot || sameSubjectSlot || sameEntitySlot) &&
      (Boolean(competing.sameCanonKey) ||
        Boolean(competing.sameKind) ||
        competing.sharedDetailCount >= 2 ||
        competing.detailOverlap >= 0.32);
    const highOverlap = competing.detailOverlap >= 0.58 && competing.scoreGap <= 0.22;
    const strongCanonConflict = sameCanonSlot && (competing.sharedDetailCount >= 2 || competing.detailOverlap >= 0.4);
    if (!strongCanonConflict && !highOverlap) {
      continue;
    }

    const reasons = unique([
      ...(item.reasons || []),
      sameCanonSlot ? "Competes with a selected memory fact in the same canon slot" : "",
      competing.sameKind ? "Tracks the same kind of canon change" : "",
      highOverlap ? "Overlaps heavily with another selected canon candidate" : "",
    ]);
    contested.push({
      record: item.record,
      reasons,
    });
    if (contested.length >= maxItems) {
      break;
    }
  }

  return {
    contestedRecords: contested.map((item) => item.record),
    reasonsById: Object.fromEntries(contested.map((item) => [item.record.id, item.reasons])),
  };
}

function finalizeRecordSelection(recordSelection, evidenceSelection, maxItems) {
  const rankedItems = Array.isArray(recordSelection?.rankedItems) ? recordSelection.rankedItems : [];
  if (!rankedItems.length) {
    return {
      selectedRecords: recordSelection?.selectedRecords || [],
      reasonsById: recordSelection?.reasonsById || {},
      contestedRecords: [],
      contestedReasonsById: {},
    };
  }

  const supportByRecord = buildEvidenceSupportMap(evidenceSelection?.selectedItems || []);
  const boosted = rankedItems.map((item) => {
    const support = clampScore(supportByRecord.get(String(item.record?.id || "")) || 0);
    return {
      ...item,
      adjustedScore: item.finalScore + support,
      reasons: support > 0 ? unique([...(item.reasons || []), "Supported by retrieved memory evidence"]) : unique(item.reasons || []),
    };
  });

  const selected = selectNovelRankedItems(
    boosted,
    maxItems,
    (item) => getRecordDiversityKey(item.record),
    (item) => getRecordTerms(item.record)
  );
  const contested = buildContestedMemoryCandidates(boosted, selected, Math.min(3, maxItems));
  return {
    selectedRecords: selected.map((item) => item.record),
    reasonsById: Object.fromEntries(selected.map((item) => [item.record.id, unique(item.reasons)])),
    contestedRecords: contested.contestedRecords,
    contestedReasonsById: contested.reasonsById,
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
  const chunks = Array.isArray(memoryChunks) ? memoryChunks : [];
  if (!chunks.length) {
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

  const query = options.query || {};
  const selectedRecordIds = new Set((options.selectedRecords || []).map((item) => String(item?.id || "")));
  const lexicalCandidates = chunks
    .map((chunk) => scoreEvidenceChunk(chunk, query, selectedRecordIds))
    .filter((item) => item.score > 0);

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

  const timestamps = Array.from(merged.values())
    .map((item) => Date.parse(item.chunk?.createdAt || ""))
    .filter(Number.isFinite);
  const newestTimestamp = timestamps.length ? Math.max(...timestamps) : NaN;
  const oldestTimestamp = timestamps.length ? Math.min(...timestamps) : NaN;
  const maxLexicalScore = Math.max(1, ...Array.from(merged.values()).map((item) => Number(item.lexicalScore) || 0));

  const ranked = Array.from(merged.values())
    .filter((item) => item.lexicalScore > 0 || item.vectorScore >= 0.45)
    .map((item) => ({
      ...item,
      lexicalScoreNormalized: clampScore((Number(item.lexicalScore) || 0) / maxLexicalScore),
      confidenceScore: clampScore(item.chunk?.confidence ?? 0.6),
      stabilityScore: item.chunk?.stability === "stable" || item.chunk?.importance === "high" ? 1 : 0,
      recencyScore: computeRecencyScore(item.chunk?.createdAt, newestTimestamp, oldestTimestamp),
      linkedFactScore: selectedRecordIds.has(String(item.chunk?.linkedRecordId || "")) ? 1 : 0,
      finalScore:
        clampScore((Number(item.lexicalScore) || 0) / maxLexicalScore) * 0.38 +
        item.vectorScore * 0.3 +
        clampScore(item.chunk?.confidence ?? 0.6) * 0.14 +
        (item.chunk?.stability === "stable" || item.chunk?.importance === "high" ? 1 : 0) * 0.06 +
        computeRecencyScore(item.chunk?.createdAt, newestTimestamp, oldestTimestamp) * 0.04 +
        (selectedRecordIds.has(String(item.chunk?.linkedRecordId || "")) ? 1 : 0) * 0.08,
    }))
    .sort(
      (a, b) =>
        b.finalScore - a.finalScore || String(b.chunk.createdAt || "").localeCompare(String(a.chunk.createdAt || ""))
    );

  const maxItems = Math.max(1, Number(options.maxItems) || 3);
  const selected = selectNovelRankedItems(
    ranked,
    maxItems,
    (item) => getEvidenceDiversityKey(item.chunk),
    (item) => flattenTerms(getChunkTerms(item.chunk))
  );
  return {
    selectedEvidenceChunks: selected.map((item) => item.chunk),
    reasonsById: Object.fromEntries(selected.map((item) => [item.chunk.id, unique(item.reasons)])),
    selectedItems: selected,
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
    const vectorEnhancementEnabled = Boolean(isVectorSearchEnabled(options));
    const maxItems = Math.max(1, Number(options.maxItems) || 4);
    const lexicalCandidateLimit = Math.max(maxItems + 2, maxItems * 2);
    const lexicalSelection = selectRelevantMemoryRecords(memoryRecords, {
      ...options,
      maxItems: lexicalCandidateLimit,
    });

    const recordSelection = mergeRecordSelections(memoryRecords, lexicalSelection, {
      vectorEnabled: vectorEnhancementEnabled,
      vectorSearchRecords,
      maxItems,
      searchOptions: options,
    });
    const evidenceSelection = selectEvidenceChunks(options.memoryChunks || [], {
      query: recordSelection.query,
      selectedRecords: recordSelection.selectedRecords,
      vectorEnabled: vectorEnhancementEnabled,
      vectorSearchItems,
      maxItems: options.maxEvidenceItems,
      searchOptions: options,
    });
    const finalizedRecordSelection = finalizeRecordSelection(recordSelection, evidenceSelection, maxItems);

    const evidenceSelected = evidenceSelection.selectedEvidenceChunks.length;
    const usedEmbedding =
      Number(recordSelection.retrievalMeta.vectorSelectedCount || 0) > 0 ||
      Number(evidenceSelection.retrievalMeta.vectorSelectedCount || 0) > 0;

    let fallbackReason = "";
    if (evidenceSelected) {
      if (!vectorEnhancementEnabled) {
        fallbackReason = "Memory RAG is active, but embedding enhancement was unavailable for this turn";
      } else if (!usedEmbedding) {
        fallbackReason = "Memory RAG stayed lexical for this turn even though embeddings were available";
      }
    } else {
      fallbackReason = recordSelection.retrievalMeta.fallbackReason || "No memory evidence chunks were strong enough to inject this turn";
    }

    return {
      selectedRecords: finalizedRecordSelection.selectedRecords,
      reasonsById: finalizedRecordSelection.reasonsById,
      contestedRecords: finalizedRecordSelection.contestedRecords,
      contestedReasonsById: finalizedRecordSelection.contestedReasonsById,
      query: recordSelection.query,
      selectedEvidenceChunks: evidenceSelection.selectedEvidenceChunks,
      selectedEvidenceReasons: evidenceSelection.reasonsById,
      retrievalMeta: {
        mode: "rag",
        activeMode: evidenceSelected ? "rag" : usedEmbedding ? "hybrid" : "lexical",
        vectorEnabled: vectorEnhancementEnabled,
        vectorCandidateCount:
          Number(recordSelection.retrievalMeta.vectorCandidateCount || 0) +
          Number(evidenceSelection.retrievalMeta.vectorCandidateCount || 0),
        vectorSelectedCount:
          Number(recordSelection.retrievalMeta.vectorSelectedCount || 0) +
          Number(evidenceSelection.retrievalMeta.vectorSelectedCount || 0),
        evidenceCandidateCount: evidenceSelection.retrievalMeta.evidenceCandidateCount || 0,
        evidenceSelectedCount: evidenceSelection.retrievalMeta.evidenceSelectedCount || 0,
        contestedCandidateCount: (finalizedRecordSelection.contestedRecords || []).length,
        fallbackReason,
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
