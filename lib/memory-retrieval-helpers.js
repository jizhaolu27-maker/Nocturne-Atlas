const { normalizeText, unique } = require("./text-utils");

function clampScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(1, numeric));
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

function isCanonicalMemoryRecord(record) {
  return record?.tier === "long_term" || record?.stability === "stable";
}

function isEpisodicEvidenceChunk(chunk) {
  const type = String(chunk?.type || "").trim().toLowerCase();
  if (type === "memory_episode") {
    return true;
  }
  return !String(chunk?.linkedRecordId || "").trim() && type !== "memory_evidence";
}

function buildRecordLayerBudgets(rankedItems = [], maxItems = 4) {
  const canonicalCandidates = rankedItems.filter((item) => isCanonicalMemoryRecord(item?.record));
  const recentCandidates = rankedItems.filter((item) => !isCanonicalMemoryRecord(item?.record));
  if (maxItems <= 1) {
    return {
      canonicalBudget: canonicalCandidates.length ? 1 : 0,
      recentBudget: canonicalCandidates.length ? 0 : Math.min(1, recentCandidates.length),
      canonicalCandidateCount: canonicalCandidates.length,
      recentCandidateCount: recentCandidates.length,
    };
  }

  let canonicalBudget = canonicalCandidates.length ? Math.min(canonicalCandidates.length, Math.max(1, Math.ceil(maxItems / 2))) : 0;
  let recentBudget = recentCandidates.length ? Math.min(recentCandidates.length, Math.max(1, maxItems - canonicalBudget)) : 0;
  let remaining = maxItems - canonicalBudget - recentBudget;

  while (remaining > 0) {
    const canonicalRemaining = canonicalCandidates.length - canonicalBudget;
    const recentRemaining = recentCandidates.length - recentBudget;
    if (canonicalRemaining <= 0 && recentRemaining <= 0) {
      break;
    }
    if (canonicalRemaining >= recentRemaining && canonicalRemaining > 0) {
      canonicalBudget += 1;
    } else if (recentRemaining > 0) {
      recentBudget += 1;
    } else {
      canonicalBudget += 1;
    }
    remaining -= 1;
  }

  return {
    canonicalBudget,
    recentBudget,
    canonicalCandidateCount: canonicalCandidates.length,
    recentCandidateCount: recentCandidates.length,
  };
}

function buildEvidenceLayerBudgets(rankedItems = [], maxItems = 3) {
  const episodicCandidates = rankedItems.filter((item) => isEpisodicEvidenceChunk(item?.chunk));
  const supportCandidates = rankedItems.filter((item) => !isEpisodicEvidenceChunk(item?.chunk));
  if (maxItems <= 1) {
    return {
      episodicBudget: episodicCandidates.length ? 1 : 0,
      supportBudget: episodicCandidates.length ? 0 : Math.min(1, supportCandidates.length),
      episodicCandidateCount: episodicCandidates.length,
      supportCandidateCount: supportCandidates.length,
    };
  }

  let episodicBudget = episodicCandidates.length ? 1 : 0;
  let supportBudget = supportCandidates.length ? Math.min(supportCandidates.length, maxItems - episodicBudget) : 0;
  let remaining = maxItems - episodicBudget - supportBudget;

  while (remaining > 0) {
    const episodicRemaining = episodicCandidates.length - episodicBudget;
    const supportRemaining = supportCandidates.length - supportBudget;
    if (episodicRemaining <= 0 && supportRemaining <= 0) {
      break;
    }
    if (supportRemaining >= episodicRemaining && supportRemaining > 0) {
      supportBudget += 1;
    } else if (episodicRemaining > 0) {
      episodicBudget += 1;
    } else {
      supportBudget += 1;
    }
    remaining -= 1;
  }

  return {
    episodicBudget,
    supportBudget,
    episodicCandidateCount: episodicCandidates.length,
    supportCandidateCount: supportCandidates.length,
  };
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

function extendNovelRankedItems(existingItems = [], rankedItems, maxItems, getKey, getTerms) {
  const ranked = Array.isArray(rankedItems) ? rankedItems : [];
  const selected = Array.isArray(existingItems) ? existingItems.slice() : [];
  const selectedSet = new Set(selected);
  const seenKeys = new Set(selected.map((item) => String(getKey(item) || "")).filter(Boolean));

  while (selected.length < maxItems) {
    let best = null;
    for (const item of ranked) {
      if (selectedSet.has(item)) {
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
    selectedSet.add(best.item);
  }

  return selected;
}

function selectNovelRankedItems(rankedItems, maxItems, getKey, getTerms) {
  return extendNovelRankedItems([], rankedItems, maxItems, getKey, getTerms);
}

module.exports = {
  buildEvidenceLayerBudgets,
  buildFallbackMeta,
  buildRecordLayerBudgets,
  clampScore,
  computeOverlapRatio,
  computeRecencyScore,
  computeSharedTermCount,
  extendNovelRankedItems,
  flattenTerms,
  getEvidenceDiversityKey,
  getPrimaryRecordSubject,
  getRecordConflictTerms,
  getRecordDiversityKey,
  getRecordTerms,
  isCanonicalMemoryRecord,
  isEpisodicEvidenceChunk,
  normalizeVectorMatches,
  selectNovelRankedItems,
};
