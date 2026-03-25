const { normalizeStringList, normalizeText, splitNaturalClauses, unique } = require("./text-utils");

function getWorkspaceEntityEntries(workspace = {}) {
  const entries = [];
  for (const item of workspace.characters || []) {
    entries.push({
      id: item.id || item.name || "",
      sourceType: "character",
      title: item.name || item.id || "",
      terms: [item.id, item.name, item.core?.role, ...normalizeStringList(item.traits), item.arcState?.current],
    });
  }
  for (const item of workspace.worldbooks || []) {
    entries.push({
      id: item.id || item.title || "",
      sourceType: "worldbook",
      title: item.title || item.id || "",
      terms: [item.id, item.title, item.category, ...normalizeStringList(item.rules), item.storyState, item.content],
    });
  }
  for (const item of workspace.styles || []) {
    entries.push({
      id: item.id || item.name || "",
      sourceType: "style",
      title: item.name || item.id || "",
      terms: [item.id, item.name, item.tone, item.voice, item.pacing],
    });
  }
  return entries.map((entry) => ({
    ...entry,
    terms: unique(entry.terms.map((item) => normalizeText(item)).filter(Boolean)),
  }));
}

function scoreFocusClause(clause, role, normalizedUserMessage, workspaceTerms) {
  const text = normalizeText(clause);
  if (!text) {
    return -Infinity;
  }
  let score = 0;
  if (text.length >= 8) score += 1;
  if (text.length >= 18 && text.length <= 120) score += 2;
  if (role === "user") score += 2;
  if (role === "assistant") score += 1;
  if (normalizedUserMessage && text === normalizedUserMessage) score += 3;
  if (/\?$|[吗呢]/.test(clause)) score += 2;
  const workspaceHits = workspaceTerms.filter((term) => term && (text.includes(term) || term.includes(text)));
  if (workspaceHits.length) {
    score += Math.min(3, unique(workspaceHits).length);
  }
  if (/^(continue|what|how|why|who|where|when|remember|reveal|show|tell|which)/i.test(clause)) {
    score += 1;
  }
  if (/^(继续|揭示|记起|怎么|为什么|是谁|哪里|哪个)/.test(clause)) {
    score += 1;
  }
  return score;
}

function rankKnowledgeFocusClauses({ userMessage = "", messages = [], workspaceTerms = [] }) {
  const normalizedUserMessage = normalizeText(userMessage);
  const candidates = [
    ...splitNaturalClauses(userMessage).map((clause, index) => ({
      role: "user",
      clause,
      index,
      source: "current_user",
    })),
    ...messages.slice(-6).flatMap((item, messageIndex) =>
      splitNaturalClauses(item.content).map((clause, clauseIndex) => ({
        role: item.role,
        clause,
        index: messageIndex * 10 + clauseIndex,
        source: "recent_history",
      }))
    ),
  ];
  return candidates
    .map((item) => ({
      ...item,
      score: scoreFocusClause(item.clause, item.role, normalizedUserMessage, workspaceTerms),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.source === "current_user") - Number(a.source === "current_user") || b.index - a.index)
    .filter((item, index, list) => list.findIndex((entry) => entry.clause === item.clause) === index);
}

function buildKnowledgeFocusClauses({ userMessage = "", messages = [], workspaceTerms = [] }) {
  return rankKnowledgeFocusClauses({ userMessage, messages, workspaceTerms })
    .map((item) => item.clause)
    .slice(0, 5);
}

function buildMatchedEntriesForText({ workspaceEntries = [], normalizedText = "", keywords = [] }) {
  return (Array.isArray(workspaceEntries) ? workspaceEntries : []).filter((entry) =>
    entry.terms.some(
      (term) =>
        term &&
        (normalizedText.includes(term) ||
          (Array.isArray(keywords) ? keywords : []).some((keyword) => term.includes(keyword) || keyword.includes(term)))
    )
  );
}

function createKnowledgeQueryTools({ extractKeywords }) {
  function buildKnowledgeQuery({ userMessage = "", messages = [], workspace = {} }) {
    const recentText = messages
      .slice(-4)
      .map((item) => `${item.role}: ${item.content}`)
      .join("\n");
    const rawText = [userMessage, recentText].filter(Boolean).join("\n");
    const normalizedRawText = normalizeText(rawText);
    const workspaceEntries = getWorkspaceEntityEntries(workspace);
    const workspaceTerms = unique(workspaceEntries.flatMap((item) => item.terms));
    const rankedFocusClauses = rankKnowledgeFocusClauses({
      userMessage,
      messages,
      workspaceTerms,
    });
    const focusClauses = rankedFocusClauses.map((item) => item.clause).slice(0, 5);
    const primaryFocusClauses = rankedFocusClauses
      .filter((item) => item.source === "current_user")
      .map((item) => item.clause)
      .slice(0, 3);
    const keywords = unique([...extractKeywords(rawText), ...extractKeywords(focusClauses.join("\n"))]).slice(0, 40);
    const matchedWorkspaceTerms = workspaceTerms.filter(
      (term) =>
        term &&
        (normalizedRawText.includes(term) || keywords.some((keyword) => term.includes(keyword) || keyword.includes(term)))
    );
    const matchedEntries = buildMatchedEntriesForText({
      workspaceEntries,
      normalizedText: normalizedRawText,
      keywords: unique([...matchedWorkspaceTerms, ...keywords]),
    });
    const primaryFocusText = [userMessage, primaryFocusClauses.join("\n")].filter(Boolean).join("\n");
    const fallbackFocusText = rankedFocusClauses
      .slice(0, 2)
      .map((item) => item.clause)
      .join("\n");
    const resolvedPrimaryFocusText = primaryFocusText || fallbackFocusText;
    const primaryKeywords = unique([...extractKeywords(resolvedPrimaryFocusText), ...extractKeywords(userMessage)]).slice(0, 24);
    const primaryMatchedEntries = buildMatchedEntriesForText({
      workspaceEntries,
      normalizedText: normalizeText(resolvedPrimaryFocusText),
      keywords: primaryKeywords,
    });
    const prioritizedCharacterIds = unique([
      ...primaryMatchedEntries.filter((item) => item.sourceType === "character").map((item) => item.id),
      ...matchedEntries.filter((item) => item.sourceType === "character").map((item) => item.id),
    ]).slice(0, 6);
    const prioritizedWorldbookIds = unique([
      ...primaryMatchedEntries.filter((item) => item.sourceType === "worldbook").map((item) => item.id),
      ...matchedEntries.filter((item) => item.sourceType === "worldbook").map((item) => item.id),
    ]).slice(0, 6);
    const prioritizedStyleIds = unique([
      ...primaryMatchedEntries.filter((item) => item.sourceType === "style").map((item) => item.id),
      ...matchedEntries.filter((item) => item.sourceType === "style").map((item) => item.id),
    ]).slice(0, 4);
    return {
      rawText: normalizedRawText,
      keywords,
      focusClauses,
      primaryFocusClauses,
      primaryMatchedEntries,
      matchedWorkspaceTerms: matchedWorkspaceTerms.slice(0, 24),
      matchedEntries,
      embeddingText: [
        userMessage ? `Current ask: ${userMessage}` : "",
        focusClauses.length ? `Focus cues: ${focusClauses.join(" | ")}` : "",
        primaryMatchedEntries.length
          ? `Primary focus: ${primaryMatchedEntries
              .slice(0, 6)
              .map((item) => item.title || item.id)
              .filter(Boolean)
              .join(", ")}`
          : "",
        matchedEntries.length
          ? `Entity focus: ${matchedEntries
              .slice(0, 8)
              .map((item) => item.title || item.id)
              .filter(Boolean)
              .join(", ")}`
          : "",
        matchedWorkspaceTerms.length ? `Matched terms: ${matchedWorkspaceTerms.slice(0, 16).join(", ")}` : "",
        recentText ? `Recent turns:\n${recentText}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      anchorHints: {
        characterIds: prioritizedCharacterIds,
        worldbookIds: prioritizedWorldbookIds,
        styleIds: prioritizedStyleIds,
      },
    };
  }

  function buildKnowledgeQueryText(query = {}) {
    return String(query.embeddingText || query.rawText || "").trim();
  }

  return {
    buildKnowledgeQuery,
    buildKnowledgeQueryText,
  };
}

module.exports = {
  createKnowledgeQueryTools,
};
