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
    "\u7136\u540e",
    "\u73b0\u5728",
    "\u8fd9\u4e2a",
    "\u90a3\u4e2a",
    "\u6211\u4eec",
    "\u4ed6\u4eec",
    "\u7ee7\u7eed",
    "\u6545\u4e8b",
    "\u89d2\u8272",
    "\u573a\u666f",
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

function splitQueryClauses(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split(/[\n.!?;:\u3002\uff01\uff1f\uff1b\uff1a]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function scoreQueryClause(clause, role, normalizedUserMessage, workspaceTerms) {
  const text = normalizeText(clause);
  if (!text) {
    return -Infinity;
  }
  let score = 0;
  if (text.length >= 10) score += 1;
  if (text.length >= 20 && text.length <= 120) score += 2;
  if (role === "user") score += 2;
  if (role === "assistant") score += 1;
  if (/\?$|[\u5417\u5462\u5417]/.test(clause)) score += 2;
  if (normalizedUserMessage && text === normalizedUserMessage) score += 3;
  const workspaceHits = workspaceTerms.filter(
    (term) => term && (text.includes(term) || term.includes(text))
  );
  if (workspaceHits.length) {
    score += Math.min(3, unique(workspaceHits).length);
  }
  if (/^(continue|what|how|why|who|where|when|remember|reveal|ask|tell|show)/i.test(clause)) {
    score += 1;
  }
  if (/^(\u7ee7\u7eed|\u63ed\u793a|\u544a\u8bc9|\u8bb0\u8d77|\u95ee|\u600e\u4e48|\u4e3a\u4ec0\u4e48|\u662f\u8c01)/.test(clause)) {
    score += 1;
  }
  return score;
}

function buildFocusClauses({ userMessage = "", messages = [], workspaceTerms = [] }) {
  const normalizedUserMessage = normalizeText(userMessage);
  const candidates = [
    ...splitQueryClauses(userMessage).map((clause, index) => ({
      role: "user",
      clause,
      index,
    })),
    ...messages.slice(-6).flatMap((item, messageIndex) =>
      splitQueryClauses(item.content).map((clause, clauseIndex) => ({
        role: item.role,
        clause,
        index: messageIndex * 10 + clauseIndex,
      }))
    ),
  ];

  return candidates
    .map((item) => ({
      ...item,
      score: scoreQueryClause(item.clause, item.role, normalizedUserMessage, workspaceTerms),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .map((item) => item.clause)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 4);
}

function buildMemoryQuery({ userMessage = "", messages = [], workspace = {} }) {
  const recentText = messages
    .slice(-4)
    .map((item) => `${item.role}: ${item.content}`)
    .join("\n");
  const rawText = [userMessage, recentText].filter(Boolean).join("\n");
  const normalizedRawText = normalizeText(rawText);
  const workspaceEntities = getWorkspaceEntityMap(workspace);
  const workspaceTerms = getWorkspaceTerms(workspace);
  const focusClauses = buildFocusClauses({
    userMessage,
    messages,
    workspaceTerms,
  });
  const keywords = unique([
    ...extractKeywords(rawText),
    ...extractKeywords(focusClauses.join("\n")),
  ]).slice(0, 36);
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
    focusClauses,
    matchedWorkspaceTerms: matchedWorkspaceTerms.slice(0, 20),
    matchedEntityIds: matchedEntities.map((item) => item.id).slice(0, 12),
    matchedEntityScopes: unique(matchedEntities.map((item) => item.scope)).slice(0, 6),
    embeddingText: [
      userMessage ? `Current ask: ${userMessage}` : "",
      focusClauses.length ? `Focus cues: ${focusClauses.join(" | ")}` : "",
      matchedEntities.length
        ? `Entity focus: ${matchedEntities
            .slice(0, 6)
            .map((item) => item.terms[0] || item.id)
            .filter(Boolean)
            .join(", ")}`
        : "",
      matchedWorkspaceTerms.length ? `Matched terms: ${matchedWorkspaceTerms.slice(0, 12).join(", ")}` : "",
      recentText ? `Recent turns:\n${recentText}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
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

  const keywordHits = unique(
    memoryKeywords.filter(
      (term) => query.keywords.includes(term) || query.matchedWorkspaceTerms.includes(term) || summaryText.includes(term)
    )
  );
  if (keywordHits.length) {
    score += keywordHits.length * 3;
    reasons.push(`Matched keywords: ${keywordHits.slice(0, 3).join(", ")}`);
  }

  if (query.matchedEntityScopes.includes(record?.scope)) {
    score += 2;
    reasons.push("Scope-aligned");
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
  buildMemoryQuery,
  extractKeywords,
  formatMemoryContext,
  getWorkspaceEntityMap,
  selectRelevantMemoryRecords,
};
