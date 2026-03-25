const { buildQueryLexicalTermSet } = require("./memory-retrieval-helpers");
const { normalizeStringList, normalizeText, selectDiagnosticTerms, unique } = require("./text-utils");
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
  const primaryEntityIds = new Set((query?.primaryMatchedEntityIds || []).map((item) => normalizeText(item)).filter(Boolean));
  const matchedEntityIds = new Set((query?.matchedEntityIds || []).map((item) => normalizeText(item)).filter(Boolean));

  records.forEach((record, index) => {
    const subjectIds = getSubjectIds(record).map((item) => normalizeText(item));
    const keywordPool = getMemoryKeywords(record);
    const hasPrimaryEntityMatch = subjectIds.some((item) => primaryEntityIds.has(item));
    const hasEntityMatch = hasPrimaryEntityMatch || subjectIds.some((item) => matchedEntityIds.has(item));
    const hasKeywordMatch = keywordPool.some((term) => queryTerms.has(term));
    const hasScopeMatch =
      (query?.primaryMatchedEntityScopes || []).includes(record?.scope) ||
      (query?.matchedEntityScopes || []).includes(record?.scope);
    const ageFromNewest = records.length - 1 - index;

    if (hasPrimaryEntityMatch) {
      direct.push(record);
      return;
    }
    if (hasEntityMatch || hasKeywordMatch || hasScopeMatch) {
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
  const primaryEntityIds = new Set((query?.primaryMatchedEntityIds || []).map((item) => normalizeText(item)).filter(Boolean));
  const matchedEntityIds = new Set((query?.matchedEntityIds || []).map((item) => normalizeText(item)).filter(Boolean));
  const primaryWorkspaceTerms = new Set(
    (query?.primaryMatchedWorkspaceTerms || []).map((item) => normalizeText(item)).filter(Boolean)
  );
  let score = 0;
  const reasons = [];

  const primarySubjectHits = unique(subjectIds.filter((term) => term && primaryEntityIds.has(term)));
  const secondarySubjectHits = unique(
    subjectIds.filter((term) => term && !primaryEntityIds.has(term) && matchedEntityIds.has(term))
  );
  if (primarySubjectHits.length) {
    score += primarySubjectHits.length * 10;
    reasons.push(`Primary subjects: ${primarySubjectHits.slice(0, 2).join(", ")}`);
  }
  if (secondarySubjectHits.length) {
    score += secondarySubjectHits.length * 4;
    reasons.push(`Context subjects: ${secondarySubjectHits.slice(0, 2).join(", ")}`);
  }

  const primaryEntityHits = unique(
    (record?.entities || [])
      .map((item) => normalizeText(item))
      .filter((term) => term && (query.rawText.includes(term) || primaryWorkspaceTerms.has(term)))
  );
  const secondaryEntityHits = unique(
    (record?.entities || [])
      .map((item) => normalizeText(item))
      .filter(
        (term) =>
          term &&
          !primaryWorkspaceTerms.has(term) &&
          (query.rawText.includes(term) || (query?.matchedWorkspaceTerms || []).includes(term))
      )
  );
  if (primaryEntityHits.length) {
    score += primaryEntityHits.length * 6;
    reasons.push(`Primary entities: ${primaryEntityHits.slice(0, 2).join(", ")}`);
  }
  if (secondaryEntityHits.length) {
    score += secondaryEntityHits.length * 3;
    reasons.push(`Context entities: ${secondaryEntityHits.slice(0, 2).join(", ")}`);
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
  const readableKeywordHits = selectDiagnosticTerms(keywordHits, 3);
  if (keywordHits.length) {
    score += keywordHits.length * 3;
  }
  if (readableKeywordHits.length) {
    reasons.push(`Matched keywords: ${readableKeywordHits.join(", ")}`);
  }

  if ((query?.primaryMatchedEntityScopes || []).includes(record?.scope)) {
    score += 3;
    reasons.push("Primary-scope aligned");
  } else if ((query?.matchedEntityScopes || []).includes(record?.scope)) {
    score += 2;
    reasons.push("Scope-aligned");
  }

  const hasQuerySignal =
    primarySubjectHits.length > 0 ||
    secondarySubjectHits.length > 0 ||
    primaryEntityHits.length > 0 ||
    secondaryEntityHits.length > 0 ||
    tagHits.length > 0 ||
    keywordHits.length > 0 ||
    (query?.primaryMatchedEntityScopes || []).includes(record?.scope) ||
    (query?.matchedEntityScopes || []).includes(record?.scope);
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

  if (kind === "relationship_update" && (primarySubjectHits.length || secondarySubjectHits.length || primaryEntityHits.length)) {
    score += 3;
    reasons.push("Relationship-change memory");
  } else if (
    kind === "world_state" &&
    (((query?.primaryMatchedEntityScopes || []).includes("world") || (query?.matchedEntityScopes || []).includes("world")) ||
      primarySubjectHits.length ||
      secondarySubjectHits.length)
  ) {
    score += 3;
    reasons.push("World-state related");
  } else if (
    kind === "character_update" &&
    (((query?.primaryMatchedEntityScopes || []).includes("character") ||
      (query?.matchedEntityScopes || []).includes("character")) ||
      primarySubjectHits.length ||
      secondarySubjectHits.length)
  ) {
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
