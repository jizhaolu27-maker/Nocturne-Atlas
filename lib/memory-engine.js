function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item != null && item !== "").map((item) => String(item));
  }
  if (typeof value === "string") {
    return value
      .split(/[;,，、]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (value && typeof value === "object") {
    return Object.values(value)
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }
  return [];
}

function extractKeywords(text) {
  const source = String(text || "");
  const tokens = source.match(/[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,6}/g) || [];
  const stopwords = new Set([
    "the",
    "and",
    "that",
    "with",
    "this",
    "from",
    "into",
    "have",
    "will",
    "your",
    "about",
    "there",
    "what",
    "when",
    "where",
    "which",
    "continue",
    "story",
    "scene",
    "assistant",
    "user",
    "然后",
    "现在",
    "这个",
    "那个",
    "我们",
    "他们",
    "继续",
    "故事",
    "角色",
    "场景",
  ]);
  return unique(tokens.map((item) => normalizeText(item)).filter((item) => !stopwords.has(item))).slice(0, 36);
}

function getWorkspaceEntityMap(workspace = {}) {
  const entries = [];
  for (const item of workspace.characters || []) {
    entries.push({
      id: item.id,
      scope: "character",
      terms: [item.id, item.name, item.core?.role, ...normalizeStringList(item.traits)],
    });
  }
  for (const item of workspace.worldbooks || []) {
    entries.push({
      id: item.id,
      scope: "world",
      terms: [item.id, item.title, item.category, ...normalizeStringList(item.rules), item.storyState],
    });
  }
  for (const item of workspace.styles || []) {
    entries.push({
      id: item.id,
      scope: "style",
      terms: [item.id, item.name, item.tone, item.voice],
    });
  }
  return entries.map((entry) => ({
    ...entry,
    terms: unique(entry.terms.map((item) => normalizeText(item)).filter(Boolean)),
  }));
}

function getWorkspaceTerms(workspace) {
  return unique(getWorkspaceEntityMap(workspace).flatMap((item) => item.terms));
}

function buildMemoryQuery({ userMessage = "", messages = [], workspace = {} }) {
  const recentText = messages
    .slice(-4)
    .map((item) => `${item.role}: ${item.content}`)
    .join("\n");
  const rawText = [userMessage, recentText].filter(Boolean).join("\n");
  const normalizedRawText = normalizeText(rawText);
  const keywords = extractKeywords(rawText);
  const workspaceEntities = getWorkspaceEntityMap(workspace);
  const workspaceTerms = getWorkspaceTerms(workspace);
  const matchedWorkspaceTerms = workspaceTerms.filter(
    (term) =>
      term &&
      (normalizedRawText.includes(term) || keywords.some((keyword) => term.includes(keyword) || keyword.includes(term)))
  );
  const matchedEntities = workspaceEntities.filter((entity) =>
    entity.terms.some(
      (term) =>
        term &&
        (normalizedRawText.includes(term) || matchedWorkspaceTerms.includes(term) || keywords.some((keyword) => term.includes(keyword)))
    )
  );
  return {
    rawText: normalizedRawText,
    keywords,
    matchedWorkspaceTerms: matchedWorkspaceTerms.slice(0, 20),
    matchedEntityIds: matchedEntities.map((item) => item.id).slice(0, 12),
    matchedEntityScopes: unique(matchedEntities.map((item) => item.scope)).slice(0, 6),
  };
}

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
  if (tier === "long_term") {
    return 2;
  }
  return 0;
}

function scoreStability(stability) {
  return stability === "stable" ? 1 : 0;
}

function recallCandidateRecords(records, query, maxCandidates = 14) {
  const direct = [];
  const indirect = [];
  const recentFallback = [];

  records.forEach((record, index) => {
    const summaryText = normalizeText(record?.summary || "");
    const subjectIds = getSubjectIds(record).map((item) => normalizeText(item));
    const keywordPool = getMemoryKeywords(record);
    const hasEntityMatch = subjectIds.some((item) => query.matchedEntityIds.includes(item));
    const hasKeywordMatch = keywordPool.some(
      (term) => query.keywords.includes(term) || query.matchedWorkspaceTerms.includes(term) || summaryText.includes(term)
    );
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
  const summaryText = normalizeText(record?.summary || "");
  const memoryKeywords = getMemoryKeywords(record);
  const subjectIds = getSubjectIds(record).map((item) => normalizeText(item));
  const kind = String(record?.kind || "plot_checkpoint");
  let score = 0;
  const reasons = [];

  const subjectHits = subjectIds.filter((term) => term && query.matchedEntityIds.includes(term));
  if (subjectHits.length) {
    score += unique(subjectHits).length * 8;
    reasons.push(`命中主体 ${unique(subjectHits).slice(0, 2).join("、")}`);
  }

  const entityHits = unique(
    (record?.entities || [])
      .map((item) => normalizeText(item))
      .filter((term) => term && (query.rawText.includes(term) || query.matchedWorkspaceTerms.includes(term)))
  );
  if (entityHits.length) {
    score += entityHits.length * 5;
    reasons.push(`命中实体 ${entityHits.slice(0, 2).join("、")}`);
  }

  const tagHits = unique(
    normalizeStringList(record?.tags).filter(
      (term) => query.keywords.includes(normalizeText(term)) || query.matchedWorkspaceTerms.includes(normalizeText(term))
    )
  );
  if (tagHits.length) {
    score += tagHits.length * 4;
    reasons.push(`命中主题 ${tagHits.slice(0, 2).join("、")}`);
  }

  const keywordHits = unique(
    memoryKeywords.filter(
      (term) => query.keywords.includes(term) || query.matchedWorkspaceTerms.includes(term) || summaryText.includes(term)
    )
  );
  if (keywordHits.length) {
    score += keywordHits.length * 3;
    reasons.push(`命中关键词 ${keywordHits.slice(0, 3).join("、")}`);
  }

  if (query.matchedEntityScopes.includes(record?.scope)) {
    score += 2;
    reasons.push("主题范围相关");
  }

  const importanceScore = scoreImportance(record?.importance);
  score += importanceScore;
  if (importanceScore >= 4) {
    reasons.push("高重要度");
  }

  const tierScore = scoreTier(record?.tier);
  score += tierScore;
  if (tierScore > 0) {
    reasons.push("长期记忆");
  }

  const stabilityScore = scoreStability(record?.stability);
  score += stabilityScore;
  if (stabilityScore > 0) {
    reasons.push("稳定设定");
  }

  const recencyScore = scoreRecency(indexFromNewest);
  score += recencyScore;
  if (recencyScore >= 2) {
    reasons.push("较新的记忆");
  }

  if (kind === "relationship_update" && (subjectHits.length || entityHits.length)) {
    score += 3;
    reasons.push("关系变化记忆");
  } else if (kind === "world_state" && (query.matchedEntityScopes.includes("world") || subjectHits.length)) {
    score += 3;
    reasons.push("世界状态相关");
  } else if (kind === "character_update" && (query.matchedEntityScopes.includes("character") || subjectHits.length)) {
    score += 2;
    reasons.push("角色变化相关");
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
      reasons: ["回退到最近记忆"],
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
  buildMemoryQuery,
  extractKeywords,
  formatMemoryContext,
  getWorkspaceEntityMap,
  selectRelevantMemoryRecords,
};
