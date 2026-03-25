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

function buildKnowledgeFocusClauses({ userMessage = "", messages = [], workspaceTerms = [] }) {
  const normalizedUserMessage = normalizeText(userMessage);
  const candidates = [
    ...splitNaturalClauses(userMessage).map((clause, index) => ({ role: "user", clause, index })),
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
      score: scoreFocusClause(item.clause, item.role, normalizedUserMessage, workspaceTerms),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .map((item) => item.clause)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 5);
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
    const focusClauses = buildKnowledgeFocusClauses({
      userMessage,
      messages,
      workspaceTerms,
    });
    const keywords = unique([...extractKeywords(rawText), ...extractKeywords(focusClauses.join("\n"))]).slice(0, 40);
    const matchedWorkspaceTerms = workspaceTerms.filter(
      (term) =>
        term &&
        (normalizedRawText.includes(term) || keywords.some((keyword) => term.includes(keyword) || keyword.includes(term)))
    );
    const matchedEntries = workspaceEntries.filter((entry) =>
      entry.terms.some(
        (term) =>
          term &&
          (normalizedRawText.includes(term) ||
            matchedWorkspaceTerms.includes(term) ||
            keywords.some((keyword) => term.includes(keyword) || keyword.includes(term)))
      )
    );
    return {
      rawText: normalizedRawText,
      keywords,
      focusClauses,
      matchedWorkspaceTerms: matchedWorkspaceTerms.slice(0, 24),
      matchedEntries,
      embeddingText: [
        userMessage ? `Current ask: ${userMessage}` : "",
        focusClauses.length ? `Focus cues: ${focusClauses.join(" | ")}` : "",
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
        characterIds: matchedEntries.filter((item) => item.sourceType === "character").map((item) => item.id).slice(0, 6),
        worldbookIds: matchedEntries.filter((item) => item.sourceType === "worldbook").map((item) => item.id).slice(0, 6),
        styleIds: matchedEntries.filter((item) => item.sourceType === "style").map((item) => item.id).slice(0, 4),
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
