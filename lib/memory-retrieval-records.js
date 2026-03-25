const { buildMemoryCanonKey, buildMemoryConflictGroup } = require("./memory-schema");
const {
  buildFallbackMeta,
  buildRecordLayerBudgets,
  clampScore,
  computeOverlapRatio,
  computeRecencyScore,
  computeSharedTermCount,
  extendNovelRankedItems,
  getPrimaryRecordSubject,
  getRecordConflictTerms,
  getRecordDiversityKey,
  getRecordTerms,
  isCanonicalMemoryRecord,
  normalizeVectorMatches,
  selectNovelRankedItems,
} = require("./memory-retrieval-helpers");
const { unique } = require("./text-utils");

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

function createMemoryRecordSelectionTools({ vectorSearchRecords }) {
  function mergeRecordSelections(memoryRecords, lexicalSelection, options = {}) {
    const maxItems = Math.max(1, Number(options.maxItems) || 4);
    const vectorEnabled = Boolean(options.vectorEnabled) && typeof vectorSearchRecords === "function";
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
      vectorSearchRecords({
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

  function finalizeRecordSelection(recordSelection, evidenceSelection, maxItems) {
    const rankedItems = Array.isArray(recordSelection?.rankedItems) ? recordSelection.rankedItems : [];
    if (!rankedItems.length) {
      return {
        selectedRecords: recordSelection?.selectedRecords || [],
        reasonsById: recordSelection?.reasonsById || {},
        contestedRecords: [],
        contestedReasonsById: {},
        layerMeta: {
          canonicalCandidateCount: 0,
          canonicalSelectedCount: 0,
          recentCandidateCount: 0,
          recentSelectedCount: 0,
          canonicalBudget: 0,
          recentBudget: 0,
        },
      };
    }

    const supportByRecord = buildEvidenceSupportMap(evidenceSelection?.selectedItems || []);
    const boosted = rankedItems.map((item) => {
      const support = clampScore(supportByRecord.get(String(item.record?.id || "")) || 0);
      return {
        ...item,
        adjustedScore: item.finalScore + support,
        reasons:
          support > 0 ? unique([...(item.reasons || []), "Supported by retrieved memory evidence"]) : unique(item.reasons || []),
      };
    });

    const layerBudgets = buildRecordLayerBudgets(boosted, maxItems);
    let selected = [];
    if (maxItems <= 1) {
      selected = selectNovelRankedItems(
        boosted,
        maxItems,
        (item) => getRecordDiversityKey(item.record),
        (item) => getRecordTerms(item.record)
      );
    } else {
      const canonicalRanked = boosted.filter((item) => isCanonicalMemoryRecord(item.record));
      const recentRanked = boosted.filter((item) => !isCanonicalMemoryRecord(item.record));
      selected = extendNovelRankedItems(
        selected,
        canonicalRanked,
        layerBudgets.canonicalBudget,
        (item) => getRecordDiversityKey(item.record),
        (item) => getRecordTerms(item.record)
      );
      selected = extendNovelRankedItems(
        selected,
        recentRanked,
        Math.min(maxItems, selected.length + layerBudgets.recentBudget),
        (item) => getRecordDiversityKey(item.record),
        (item) => getRecordTerms(item.record)
      );
      selected = extendNovelRankedItems(
        selected,
        boosted,
        maxItems,
        (item) => getRecordDiversityKey(item.record),
        (item) => getRecordTerms(item.record)
      );
    }
    const contested = buildContestedMemoryCandidates(boosted, selected, Math.min(3, maxItems));
    const canonicalSelectedCount = selected.filter((item) => isCanonicalMemoryRecord(item.record)).length;
    const recentSelectedCount = selected.length - canonicalSelectedCount;
    return {
      selectedRecords: selected.map((item) => item.record),
      reasonsById: Object.fromEntries(selected.map((item) => [item.record.id, unique(item.reasons)])),
      contestedRecords: contested.contestedRecords,
      contestedReasonsById: contested.reasonsById,
      layerMeta: {
        canonicalCandidateCount: layerBudgets.canonicalCandidateCount,
        canonicalSelectedCount,
        recentCandidateCount: layerBudgets.recentCandidateCount,
        recentSelectedCount,
        canonicalBudget: layerBudgets.canonicalBudget,
        recentBudget: layerBudgets.recentBudget,
      },
    };
  }

  return {
    finalizeRecordSelection,
    mergeRecordSelections,
  };
}

module.exports = {
  createMemoryRecordSelectionTools,
};
