const { normalizeText, unique } = require("./text-utils");

const MEMORY_CUE_PATTERNS = [
  /\b(continue|continue the scene|go on|next|then|again|still|remember|recall|earlier|previous|before|after|just|scene|moment|what happened|why did|how did)\b/i,
  /(继续|接着|然后|再来|继续写|继续这个场景|还记得|回想|之前|先前|刚才|刚刚|上一轮|上次|之后|发生了什么|为什么|怎么会|此刻|现在)/,
];

const KNOWLEDGE_CUE_PATTERNS = [
  /\b(who is|what is|where is|explain|describe|lore|rule|rules|world|setting|background|trait|traits|relationship|relationships|style|tone|voice|canon|profile|category)\b/i,
  /(是谁|是什么|在哪里|解释|描述|设定|规则|世界|背景|特征|关系|文风|语气|口吻|风格|档案|资料|类别)/,
];

const STYLE_CUE_PATTERNS = [
  /\b(style|tone|voice|pacing|write it|narration|narrative)\b/i,
  /(文风|语气|口吻|节奏|叙述|叙事|怎么写)/,
];

const SCENE_DETAIL_PATTERNS = [
  /\b(now|still|again|just|before|after|then|here|there|this|that|why|how)\b/i,
  /(现在|仍然|依然|再次|刚才|之前|之后|这里|那里|这个|那个|为什么|怎么)/,
];

const QUESTION_PATTERNS = [/\?/, /[？吗呢]/];

function countPatternHits(text, patterns) {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function collectWorkspaceTerms(workspace = {}) {
  const characterTerms = unique(
    (workspace.characters || [])
      .flatMap((item) => [item.id, item.name, item.core?.role])
      .map((item) => normalizeText(item))
      .filter((item) => item && item.length >= 2)
  );
  const worldTerms = unique(
    (workspace.worldbooks || [])
      .flatMap((item) => [item.id, item.title, item.category])
      .map((item) => normalizeText(item))
      .filter((item) => item && item.length >= 2)
  );
  const styleTerms = unique(
    (workspace.styles || [])
      .flatMap((item) => [item.id, item.name, item.tone, item.voice])
      .map((item) => normalizeText(item))
      .filter((item) => item && item.length >= 2)
  );
  return {
    characterTerms,
    worldTerms,
    styleTerms,
  };
}

function countTermMatches(text, terms = []) {
  if (!text) {
    return 0;
  }
  return terms.filter((term) => text.includes(term)).length;
}

function getBaseBudgets(maxTokens) {
  if (maxTokens <= 6000) {
    return { memoryItems: 3, memoryEvidenceItems: 2, knowledgeItems: 4 };
  }
  if (maxTokens <= 16000) {
    return { memoryItems: 4, memoryEvidenceItems: 2, knowledgeItems: 5 };
  }
  if (maxTokens <= 40000) {
    return { memoryItems: 4, memoryEvidenceItems: 3, knowledgeItems: 6 };
  }
  return { memoryItems: 5, memoryEvidenceItems: 3, knowledgeItems: 7 };
}

function applyExplicitOverride(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : fallback;
}

function buildRetrievalPlan({
  story,
  messages = [],
  memoryRecords = [],
  memoryChunks = [],
  workspace = {},
  currentUserInput = "",
  getProviderContextWindow = () => 0,
  overrides = {},
}) {
  const latestMessages = Array.isArray(messages) ? messages.slice(-6) : [];
  const latestUserMessage = [...latestMessages].reverse().find((item) => item?.role === "user")?.content || "";
  const focusText = String(currentUserInput || latestUserMessage || "").trim();
  const normalizedFocusText = normalizeText(focusText);
  const recentTurnText = latestMessages.map((item) => String(item?.content || "")).join("\n");
  const normalizedRecentTurnText = normalizeText(recentTurnText);
  const combinedText = [normalizedFocusText, normalizedRecentTurnText].filter(Boolean).join("\n");
  const workspaceTerms = collectWorkspaceTerms(workspace);
  const characterMatches = countTermMatches(combinedText, workspaceTerms.characterTerms);
  const worldMatches = countTermMatches(combinedText, workspaceTerms.worldTerms);
  const styleMatches = countTermMatches(combinedText, workspaceTerms.styleTerms);
  const memoryCueHits = countPatternHits(focusText, MEMORY_CUE_PATTERNS);
  const knowledgeCueHits = countPatternHits(focusText, KNOWLEDGE_CUE_PATTERNS);
  const styleCueHits = countPatternHits(focusText, STYLE_CUE_PATTERNS);
  const sceneCueHits = countPatternHits(focusText, SCENE_DETAIL_PATTERNS);
  const questionHits = countPatternHits(focusText, QUESTION_PATTERNS);
  const directContinuation = /^(continue|go on|next|keep going|继续|接着|然后|继续写)/i.test(focusText);

  let memoryScore = 2;
  let knowledgeScore = 2;

  memoryScore += memoryCueHits * 2;
  memoryScore += sceneCueHits;
  memoryScore += directContinuation ? 3 : 0;
  memoryScore += latestMessages.length >= 2 ? 1 : 0;
  memoryScore += memoryRecords.length ? 1 : 0;
  memoryScore += memoryChunks.length ? 1 : 0;
  memoryScore += characterMatches ? 1 : 0;

  knowledgeScore += knowledgeCueHits * 3;
  knowledgeScore += styleCueHits * 2;
  knowledgeScore += questionHits;
  knowledgeScore += Math.min(4, worldMatches * 2);
  knowledgeScore += Math.min(3, styleMatches * 2);
  knowledgeScore += knowledgeCueHits && characterMatches ? 1 : 0;

  const delta = knowledgeScore - memoryScore;
  const route = delta >= 3 ? "knowledge_heavy" : delta <= -3 ? "memory_heavy" : "balanced";
  const maxTokens = Number(getProviderContextWindow(story) || 0);
  const baseBudgets = getBaseBudgets(maxTokens);
  const budgets = { ...baseBudgets };
  const reasons = [];

  if (directContinuation) {
    reasons.push("Continuation phrasing pulled the route toward scene memory.");
  }
  if (memoryCueHits) {
    reasons.push("Recent-scene wording increased memory recall weight.");
  }
  if (knowledgeCueHits || worldMatches || styleMatches) {
    reasons.push("Lore or workspace-entity wording increased knowledge recall weight.");
  }
  if (styleCueHits) {
    reasons.push("Style-related wording kept some budget available for style knowledge.");
  }

  if (route === "memory_heavy") {
    budgets.memoryItems += 1;
    budgets.memoryEvidenceItems += 1;
    budgets.knowledgeItems = Math.max(3, budgets.knowledgeItems - 2);
  } else if (route === "knowledge_heavy") {
    budgets.memoryItems = Math.max(2, budgets.memoryItems - 1);
    budgets.memoryEvidenceItems = Math.max(1, budgets.memoryEvidenceItems - 1);
    budgets.knowledgeItems += 2;
  }

  if (route !== "knowledge_heavy" && sceneCueHits >= 2) {
    budgets.memoryEvidenceItems += 1;
    reasons.push("Scene-detail cues expanded episodic evidence budget.");
  }

  budgets.memoryItems = applyExplicitOverride(overrides.maxMemoryItems, budgets.memoryItems);
  budgets.memoryEvidenceItems = applyExplicitOverride(overrides.maxMemoryEvidenceItems, budgets.memoryEvidenceItems);
  budgets.knowledgeItems = applyExplicitOverride(overrides.maxKnowledgeItems, budgets.knowledgeItems);

  return {
    focusSource: currentUserInput ? "current_input" : latestUserMessage ? "recent_turns" : "none",
    route,
    scores: {
      memory: memoryScore,
      knowledge: knowledgeScore,
      scene: sceneCueHits,
      entityFocus: characterMatches + worldMatches + styleMatches,
      worldFocus: worldMatches,
      styleFocus: styleMatches,
    },
    budgets,
    reasons,
  };
}

module.exports = {
  buildRetrievalPlan,
};
