const { buildQueryLexicalTermSet } = require("./memory-retrieval-helpers");
const { normalizeStringList, normalizeText, unique } = require("./text-utils");
const { buildMemoryQuery, extractKeywords } = require("./memory-query");

function getMemoryKeywords(record) {
  const explicit = Array.isArray(record?.keywords) ? record.keywords : [];
  const tags = Array.isArray(record?.tags) ? record.tags : [];
  return unique([
    ...explicit.map((item) => normalizeText(item)),
    ...tags.map((item) => normalizeText(item)),
    ...extractKeywords(record?.summary || ""),
    ...((record?.entities || []).map((item) => normalizeText(item))),
  ]).slice(0, 32);
}

function getSubjectIds(record) {
  return unique([...(record?.subjectIds || []), ...(record?.objectIds || [])].map((item) => String(item || "").trim())).filter(Boolean);
}

function isRecordActive(record) {
  return (
    (!record?.mergedInto || (record?.tier || "short_term") === "long_term") &&
    !(record?.tier === "long_term" && record?.supersededBy)
  );
}

function scoreImportance(importance) {
  if (importance === "high") {
    return 4;
  }
  if (importance === "medium") {
    return 2;
  }
  return 1;
}

function scoreRecency(indexFromNewest) {
  if (indexFromNewest <= 2) {
    return 3;
  }
  if (indexFromNewest <= 5) {
    return 2;
  }
  if (indexFromNewest <= 10) {
    return 1;
  }
  return 0;
}

function scoreTier(tier) {
  return tier === "long_term" ? 2 : 0;
}

function scoreStability(stability) {
  return stability === "stable" ? 1 : 0;
}

function recallCandidateRecords(records, query, maxCandidates = 14) {
  const direct = [];
  const indirect = [];
  const recentFallback = [];
  const queryTerms = buildQueryLexicalTermSet(query);

  records.forEach((record, index) => {
    const subjectIds = getSubjectIds(record).map((item) => normalizeText(item));
    const keywordPool = getMemoryKeywords(record);
    const hasEntityMatch = subjectIds.some((item) => query.matchedEntityIds.includes(item));
    const hasKeywordMatch = keywordPool.some((term) => queryTerms.has(term));
    const hasScopeMatch = query.matchedEntityScopes.includes(record?.scope);
    const ageFromNewest = records.length - 1 - index;

    if (hasEntityMatch) {
      direct.push(record);
      return;
    }
    if (hasKeywordMatch || hasScopeMatch) {
      indirect.push(record);
      return;
    }
    if (ageFromNewest <= 4 || record?.importance === "high") {
      recentFallback.push(record);
    }
  });

  return unique([...direct, ...indirect, ...recentFallback]).slice(0, Math.max(4, maxCandidates));
}

function scoreMemoryRecord(record, query, indexFromNewest) {
  const memoryKeywords = getMemoryKeywords(record);
  const subjectIds = getSubjectIds(record).map((item) => normalizeText(item));
  const kind = String(record?.kind || "plot_checkpoint");
  const queryTerms = buildQueryLexicalTermSet(query);
  let score = 0;
  const reasons = [];

  const subjectHits = subjectIds.filter((term) => term && query.matchedEntityIds.includes(term));
  if (subjectHits.length) {
    score += unique(subjectHits).length * 8;
    reasons.push(`Matched subjects: ${unique(subjectHits).slice(0, 2).join(", ")}`);
  }

  const entityHits = unique(
    (record?.entities || [])
      .map((item) => normalizeText(item))
      .filter((term) => term && (query.rawText.includes(term) || query.matchedWorkspaceTerms.includes(term)))
  );
  if (entityHits.length) {
    score += entityHits.length * 5;
    reasons.push(`Matched entities: ${entityHits.slice(0, 2).join(", ")}`);
  }

  const tagHits = unique(
    normalizeStringList(record?.tags).filter(
      (term) => query.keywords.includes(normalizeText(term)) || query.matchedWorkspaceTerms.includes(normalizeText(term))
    )
  );
  if (tagHits.length) {
    score += tagHits.length * 4;
    reasons.push(`Matched tags: ${tagHits.slice(0, 2).join(", ")}`);
  }

  const keywordHits = unique(memoryKeywords.filter((term) => queryTerms.has(term)));
  if (keywordHits.length) {
    score += keywordHits.length * 3;
    reasons.push(`Matched keywords: ${keywordHits.slice(0, 3).join(", ")}`);
  }

  if (query.matchedEntityScopes.includes(record?.scope)) {
    score += 2;
    reasons.push("Scope-aligned");
  }

  const hasQuerySignal =
    subjectHits.length > 0 ||
    entityHits.length > 0 ||
    tagHits.length > 0 ||
    keywordHits.length > 0 ||
    query.matchedEntityScopes.includes(record?.scope);
  if (!hasQuerySignal) {
    return {
      record,
      score: 0,
      reasons: [],
    };
  }

  const importanceScore = scoreImportance(record?.importance);
  score += importanceScore;
  if (importanceScore >= 4) {
    reasons.push("High importance");
  }

  const tierScore = scoreTier(record?.tier);
  score += tierScore;
  if (tierScore > 0) {
    reasons.push("Long-term memory");
  }

  const stabilityScore = scoreStability(record?.stability);
  score += stabilityScore;
  if (stabilityScore > 0) {
    reasons.push("Stable canon");
  }

  const recencyScore = scoreRecency(indexFromNewest);
  score += recencyScore;
  if (recencyScore >= 2) {
    reasons.push("Recent memory");
  }

  if (kind === "relationship_update" && (subjectHits.length || entityHits.length)) {
    score += 3;
    reasons.push("Relationship-change memory");
  } else if (kind === "world_state" && (query.matchedEntityScopes.includes("world") || subjectHits.length)) {
    score += 3;
    reasons.push("World-state related");
  } else if (kind === "character_update" && (query.matchedEntityScopes.includes("character") || subjectHits.length)) {
    score += 2;
    reasons.push("Character-change related");
  }

  if (record?.tier === "short_term" && record?.importance === "high") {
    score += 1;
  }

  return {
    record,
    score,
    reasons: unique(reasons),
  };
}

function formatMemoryRecordHeader(item, index) {
  const attributes = [
    `tier=${item.tier || "short_term"}`,
    `importance=${item.importance || "medium"}`,
    `type=${item.type || "checkpoint"}`,
    `kind=${item.kind || "plot_checkpoint"}`,
  ];
  if (item.scope) {
    attributes.push(`scope=${item.scope}`);
  }
  if (item.stability) {
    attributes.push(`stability=${item.stability}`);
  }
  return `[Memory ${index + 1}][${attributes.join("][")}]`;
}

function formatMemoryContext(records) {
  return (records || [])
    .map((item, index) => {
      const meta = [];
      if (Array.isArray(item.subjectIds) && item.subjectIds.length) {
        meta.push(`subjects: ${item.subjectIds.join(", ")}`);
      }
      if (Array.isArray(item.tags) && item.tags.length) {
        meta.push(`tags: ${item.tags.join(", ")}`);
      }
      if (Array.isArray(item.sourceMessageRange) && item.sourceMessageRange.length === 2) {
        meta.push(`source turns: ${item.sourceMessageRange[0]}-${item.sourceMessageRange[1]}`);
      }
      if (Number.isFinite(Number(item.confidence))) {
        meta.push(`confidence: ${Number(item.confidence).toFixed(2)}`);
      }
      return [formatMemoryRecordHeader(item, index), item.summary || "", ...meta].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function selectRelevantMemoryRecords(memoryRecords, options = {}) {
  const records = (Array.isArray(memoryRecords) ? memoryRecords : []).filter(Boolean);
  const query = buildMemoryQuery(options);
  if (!records.length) {
    return { selectedRecords: [], reasonsById: {}, query };
  }

  const activeRecords = records.filter(isRecordActive);
  const pool = activeRecords.length ? activeRecords : records;
  const candidates = recallCandidateRecords(pool, query, Math.max(12, Number(options.maxItems) * 3 || 12));
  const candidatePool = candidates.length ? candidates : pool;
  const scored = candidatePool
    .map((record) => {
      const originalIndex = pool.findIndex((item) => item.id === record.id);
      const indexFromNewest = originalIndex >= 0 ? pool.length - 1 - originalIndex : pool.length;
      return scoreMemoryRecord(record, query, indexFromNewest);
    })
    .sort((a, b) => b.score - a.score || String(b.record.createdAt || "").localeCompare(String(a.record.createdAt || "")));

  const maxItems = Math.max(1, Number(options.maxItems) || 4);
  let selected = scored.filter((item) => item.score > 0).slice(0, maxItems);
  if (!selected.length) {
    selected = pool.slice(-Math.min(3, maxItems)).reverse().map((record) => ({
      record,
      score: 0,
      reasons: ["Fell back to recent memory"],
    }));
  }

  const selectedRecords = selected.map((item) => ({
    ...item.record,
    scope: item.record.scope || "plot",
    stability: item.record.stability || (item.record.tier === "long_term" ? "stable" : "volatile"),
    confidence: Number.isFinite(Number(item.record.confidence)) ? Number(item.record.confidence) : 0.6,
    subjectIds: Array.isArray(item.record.subjectIds) ? item.record.subjectIds : [],
    objectIds: Array.isArray(item.record.objectIds) ? item.record.objectIds : [],
    tags: Array.isArray(item.record.tags) ? item.record.tags : [],
  }));
  const reasonsById = Object.fromEntries(selected.map((item) => [item.record.id, item.reasons]));

  return { selectedRecords, reasonsById, query };
}

module.exports = {
  formatMemoryContext,
  selectRelevantMemoryRecords,
};
