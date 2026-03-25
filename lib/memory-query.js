const { extractSearchTerms, normalizeStringList, normalizeText, splitNaturalClauses, unique } = require("./text-utils");

function extractKeywords(text) {
  return extractSearchTerms(text, { maxItems: 36 });
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
  if (/\?$|[\u5417\u5462]/.test(clause)) score += 2;
  if (normalizedUserMessage && text === normalizedUserMessage) score += 3;
  const workspaceHits = workspaceTerms.filter((term) => term && (text.includes(term) || term.includes(text)));
  if (workspaceHits.length) {
    score += Math.min(3, unique(workspaceHits).length);
  }
  if (/^(continue|what|how|why|who|where|when|remember|reveal|ask|tell|show)/i.test(clause)) {
    score += 1;
  }
  if (/^(\u7ee7\u7eed|\u600e\u4e48|\u4e3a\u4ec0\u4e48|\u662f\u8c01|\u54ea\u91cc|\u4ec0\u4e48|\u8bb0\u5f97|\u63ed\u793a|\u544a\u8bc9|\u5c55\u793a)/.test(clause)) {
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
  const primaryNormalizedText = normalizeText(userMessage);
  const primaryKeywords = extractKeywords(userMessage);
  const primaryMatchedWorkspaceTerms = workspaceTerms.filter(
    (term) =>
      term &&
      (primaryNormalizedText.includes(term) ||
        primaryKeywords.some((keyword) => term.includes(keyword) || keyword.includes(term)))
  );
  const primaryMatchedEntities = workspaceEntities.filter((entity) =>
    entity.terms.some(
      (term) =>
        term &&
        (primaryNormalizedText.includes(term) ||
          primaryMatchedWorkspaceTerms.includes(term) ||
          primaryKeywords.some((keyword) => term.includes(keyword)))
    )
  );
  const focusClauses = buildFocusClauses({
    userMessage,
    messages,
    workspaceTerms,
  });
  const primaryFocusClauses = buildFocusClauses({
    userMessage,
    messages: [],
    workspaceTerms,
  }).slice(0, 3);
  const keywordPool = [...extractKeywords(rawText), ...extractKeywords(focusClauses.join("\n"))];
  const entityTerms = workspaceEntities
    .flatMap((item) => item.terms)
    .filter((term) => term && normalizedRawText.includes(term))
    .slice(0, 12);
  const keywords = unique([...entityTerms, ...keywordPool]).slice(0, 36);
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
    primaryFocusClauses,
    matchedWorkspaceTerms: matchedWorkspaceTerms.slice(0, 20),
    primaryMatchedWorkspaceTerms: primaryMatchedWorkspaceTerms.slice(0, 16),
    matchedEntityIds: matchedEntities.map((item) => item.id).slice(0, 12),
    primaryMatchedEntityIds: primaryMatchedEntities.map((item) => item.id).slice(0, 8),
    matchedEntityScopes: unique(matchedEntities.map((item) => item.scope)).slice(0, 6),
    primaryMatchedEntityScopes: unique(primaryMatchedEntities.map((item) => item.scope)).slice(0, 4),
    embeddingText: [
      userMessage ? `Current ask: ${userMessage}` : "",
      primaryFocusClauses.length ? `Primary focus: ${primaryFocusClauses.join(" | ")}` : "",
      focusClauses.length ? `Focus cues: ${focusClauses.join(" | ")}` : "",
      matchedEntities.length
        ? `Entity focus: ${matchedEntities
            .slice(0, 6)
            .map((item) => item.terms[0] || item.id)
            .filter(Boolean)
            .join(", ")}`
        : "",
      primaryMatchedEntities.length
        ? `Primary entities: ${primaryMatchedEntities
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
