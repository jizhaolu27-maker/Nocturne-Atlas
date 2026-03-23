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

function getWorkspaceTerms(workspace) {
  const items = [
    ...(workspace.characters || []).flatMap((item) => [item.id, item.name, item.core?.role, ...normalizeStringList(item.traits)]),
    ...(workspace.worldbooks || []).flatMap((item) => [item.id, item.title, item.category, ...normalizeStringList(item.rules)]),
    ...(workspace.styles || []).flatMap((item) => [item.id, item.name, item.tone, item.voice]),
  ];
  return unique(items.map((item) => normalizeText(item)).filter(Boolean));
}

function buildMemoryQuery({ userMessage = "", messages = [], workspace = {} }) {
  const recentText = messages
    .slice(-4)
    .map((item) => `${item.role}: ${item.content}`)
    .join("\n");
  const rawText = [userMessage, recentText].filter(Boolean).join("\n");
  const keywords = extractKeywords(rawText);
  const workspaceTerms = getWorkspaceTerms(workspace);
  const matchedWorkspaceTerms = workspaceTerms.filter(
    (term) => term && (rawText.toLowerCase().includes(term) || keywords.some((keyword) => term.includes(keyword) || keyword.includes(term)))
  );
  return {
    rawText: normalizeText(rawText),
    keywords,
    matchedWorkspaceTerms: matchedWorkspaceTerms.slice(0, 16),
  };
}

function getMemoryKeywords(record) {
  const explicit = Array.isArray(record?.keywords) ? record.keywords : [];
  return unique([
    ...explicit.map((item) => normalizeText(item)),
    ...extractKeywords(record?.summary || ""),
    ...((record?.entities || []).map((item) => normalizeText(item))),
  ]).slice(0, 24);
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

function scoreMemoryRecord(record, query, indexFromNewest) {
  const summaryText = normalizeText(record?.summary || "");
  const memoryKeywords = getMemoryKeywords(record);
  const kind = String(record?.kind || "plot_checkpoint");
  let score = 0;
  const reasons = [];

  const entityHits = unique(
    (record?.entities || [])
      .map((item) => normalizeText(item))
      .filter((term) => term && (query.rawText.includes(term) || query.matchedWorkspaceTerms.includes(term)))
  );
  if (entityHits.length) {
    score += entityHits.length * 6;
    reasons.push(`命中实体 ${entityHits.slice(0, 2).join("、")}`);
  }

  const keywordHits = memoryKeywords.filter(
    (term) => query.keywords.includes(term) || query.matchedWorkspaceTerms.includes(term) || summaryText.includes(term)
  );
  if (keywordHits.length) {
    score += unique(keywordHits).length * 3;
    reasons.push(`命中关键词 ${unique(keywordHits).slice(0, 3).join("、")}`);
  }

  const textOverlapHits = query.keywords.filter((term) => term && summaryText.includes(term));
  if (textOverlapHits.length) {
    score += unique(textOverlapHits).length;
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

  const recencyScore = scoreRecency(indexFromNewest);
  score += recencyScore;
  if (recencyScore >= 2) {
    reasons.push("较新的记忆");
  }

  if (kind === "relationship_update" && entityHits.length) {
    score += 3;
    reasons.push("关系变化记忆");
  } else if (kind === "world_state") {
    const worldHit = query.matchedWorkspaceTerms.some((term) => summaryText.includes(term));
    if (worldHit) {
      score += 3;
      reasons.push("世界状态相关");
    }
  } else if (kind === "character_update" && entityHits.length) {
    score += 2;
    reasons.push("角色变化相关");
  }

  return {
    record,
    score,
    reasons: unique(reasons),
  };
}

function formatMemoryContext(records) {
  return (records || [])
    .map(
      (item, index) =>
        `[Memory ${index + 1}][tier=${item.tier || "short_term"}][importance=${item.importance || "medium"}][type=${item.type || "checkpoint"}][kind=${item.kind || "plot_checkpoint"}]\n${item.summary || ""}`
    )
    .join("\n\n");
}

function selectRelevantMemoryRecords(memoryRecords, options = {}) {
  const records = Array.isArray(memoryRecords) ? memoryRecords : [];
  if (!records.length) {
    return { selectedRecords: [], reasonsById: {}, query: buildMemoryQuery(options) };
  }

  const query = buildMemoryQuery(options);
  const candidateRecords = records.filter(
    (item) =>
      (!item.mergedInto || (item.tier || "short_term") === "long_term") &&
      !(item.tier === "long_term" && item.supersededBy)
  );
  const pool = candidateRecords.length ? candidateRecords : records;
  const scored = pool
    .map((record, index) => scoreMemoryRecord(record, query, pool.length - 1 - index))
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

  const selectedRecords = selected.map((item) => item.record);
  const reasonsById = Object.fromEntries(selected.map((item) => [item.record.id, item.reasons]));

  return { selectedRecords, reasonsById, query };
}

module.exports = {
  buildMemoryQuery,
  extractKeywords,
  formatMemoryContext,
  selectRelevantMemoryRecords,
};
