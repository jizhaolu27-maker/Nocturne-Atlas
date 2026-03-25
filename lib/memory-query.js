const { normalizeStringList, normalizeText, splitNaturalClauses, unique } = require("./text-utils");

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
  if (/\?$|[吗呢呀]/.test(clause)) score += 2;
  if (normalizedUserMessage && text === normalizedUserMessage) score += 3;
  const workspaceHits = workspaceTerms.filter((term) => term && (text.includes(term) || term.includes(text)));
  if (workspaceHits.length) {
    score += Math.min(3, unique(workspaceHits).length);
  }
  if (/^(continue|what|how|why|who|where|when|remember|reveal|ask|tell|show)/i.test(clause)) {
    score += 1;
  }
  if (/^(继续|揭示|告诉|记起|问|怎么|为什么|是谁)/.test(clause)) {
    score += 1;
  }
  return score;
}

function buildFocusClauses({ userMessage = "", messages = [], workspaceTerms = [] }) {
  const normalizedUserMessage = normalizeText(userMessage);
  const candidates = [
    ...splitNaturalClauses(userMessage).map((clause, index) => ({
      role: "user",
      clause,
      index,
    })),
    ...messages.slice(-6).flatMap((item, messageIndex) =>
      splitNaturalClauses(item.content).map((clause, clauseIndex) => ({
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
  const keywords = unique([...extractKeywords(rawText), ...extractKeywords(focusClauses.join("\n"))]).slice(0, 36);
  const matchedWorkspaceTerms = workspaceTerms.filter(
    (term) =>
      term &&
      (normalizedRawText.includes(term) || keywords.some((keyword) => term.includes(keyword) || keyword.includes(term)))
  );
  const matchedEntities = workspaceEntities.filter((entity) =>
    entity.terms.some(
      (term) =>
        term &&
        (normalizedRawText.includes(term) ||
          matchedWorkspaceTerms.includes(term) ||
          keywords.some((keyword) => term.includes(keyword)))
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

module.exports = {
  buildMemoryQuery,
  extractKeywords,
  getWorkspaceEntityMap,
  getWorkspaceTerms,
};
