const { extractSearchTerms, normalizeText, unique } = require("./text-utils");

const MEMORY_CUE_PATTERNS = [
  /\b(continue|go on|next|again|still|remember|recall|earlier|previous|before|after|scene|moment|what happened)\b/i,
  /(继续|接着|然后|后面|上一段|刚才|还记得|回想|之前|之后|场景|剧情|发生了什么)/,
];

const KNOWLEDGE_CUE_PATTERNS = [
  /\b(who is|what is|where is|explain|describe|lore|rule|rules|world|setting|background|trait|traits|relationship|relationships|canon|profile|category)\b/i,
  /(谁是|是什么|在哪里|解释|设定|世界观|规则|背景|性格|特征|关系|资料|档案|人设|类别)/,
];

const STYLE_CUE_PATTERNS = [
  /\b(style|tone|voice|pacing|narration|narrative|write it)\b/i,
  /(风格|语气|文风|叙述|叙事|节奏|描写|怎么写|按这个风格|这种风格)/,
];

const SCENE_CUE_PATTERNS = [
  /\b(now|still|again|just|before|after|then|here|there|continue)\b/i,
  /(现在|此刻|眼下|这时|继续|接着|然后|之后|刚刚|刚才|这里|那里)/,
];

const QUESTION_PATTERNS = [/[?？]/, /(吗|呢|么|什么|谁|哪|如何|为什么|怎么|是否)/];

function countPatternHits(text, patterns) {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function countSharedTerms(left = [], right = []) {
  if (!left.length || !right.length) {
    return 0;
  }
  const rightSet = new Set(right);
  return left.filter((term) => rightSet.has(term)).length;
}

function collectWorkspaceTerms(workspace = {}) {
  const characterTerms = unique(
    (workspace.characters || []).flatMap((item) =>
      extractSearchTerms([item.id, item.name, item.core?.role, ...(item.traits || []), item.arcState?.current].join(" "), {
        maxItems: 24,
      })
    )
  );
  const worldTerms = unique(
    (workspace.worldbooks || []).flatMap((item) =>
      extractSearchTerms([item.id, item.title, item.category, ...(item.rules || []), item.storyState].join(" "), {
        maxItems: 24,
      })
    )
  );
  const styleTerms = unique(
    (workspace.styles || []).flatMap((item) =>
      extractSearchTerms([item.id, item.name, item.tone, item.voice, item.pacing].join(" "), { maxItems: 20 })
    )
  );
  return {
    characterTerms,
    worldTerms,
    styleTerms,
  };
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
  const recentTurnText = latestMessages.map((item) => String(item?.content || "")).join("\n");
  const normalizedFocusText = normalizeText(focusText);
  const focusTerms = extractSearchTerms(focusText, { maxItems: 24 });
  const recentTerms = extractSearchTerms(recentTurnText, { maxItems: 40 });
  const combinedTerms = unique([...focusTerms, ...recentTerms]);
  const workspaceTerms = collectWorkspaceTerms(workspace);
  const focusCharacterMatches = countSharedTerms(focusTerms, workspaceTerms.characterTerms);
  const focusWorldMatches = countSharedTerms(focusTerms, workspaceTerms.worldTerms);
  const focusStyleMatches = countSharedTerms(focusTerms, workspaceTerms.styleTerms);
  const combinedCharacterMatches = countSharedTerms(combinedTerms, workspaceTerms.characterTerms);
  const combinedWorldMatches = countSharedTerms(combinedTerms, workspaceTerms.worldTerms);
  const combinedStyleMatches = countSharedTerms(combinedTerms, workspaceTerms.styleTerms);
  const memoryCueHits = countPatternHits(focusText, MEMORY_CUE_PATTERNS);
  const knowledgeCueHits = countPatternHits(focusText, KNOWLEDGE_CUE_PATTERNS);
  const styleCueHits = countPatternHits(focusText, STYLE_CUE_PATTERNS);
  const sceneCueHits = countPatternHits(focusText, SCENE_CUE_PATTERNS);
  const questionHits = countPatternHits(focusText, QUESTION_PATTERNS);
  const directContinuation = /^(continue|go on|next|keep going|继续|接着|然后|后面)/i.test(focusText);
  const styleHeavyAsk = styleCueHits > 0 || focusStyleMatches > 0;
  const knowledgeHeavyAsk = knowledgeCueHits > 0 || focusWorldMatches > 0 || styleHeavyAsk;

  let memoryScore = 2;
  let knowledgeScore = 2;

  memoryScore += memoryCueHits * 2;
  memoryScore += sceneCueHits;
  memoryScore += directContinuation ? 3 : 0;
  memoryScore += latestMessages.length >= 2 ? 1 : 0;
  memoryScore += memoryRecords.length ? 1 : 0;
  memoryScore += memoryChunks.length ? 1 : 0;
  memoryScore += Math.min(2, focusCharacterMatches);
  memoryScore += combinedCharacterMatches > focusCharacterMatches ? 1 : 0;

  knowledgeScore += knowledgeCueHits * 3;
  knowledgeScore += styleCueHits * 2;
  knowledgeScore += questionHits;
  knowledgeScore += Math.min(4, focusWorldMatches * 2 + Math.min(1, combinedWorldMatches - focusWorldMatches));
  knowledgeScore += Math.min(3, focusStyleMatches * 2 + Math.min(1, combinedStyleMatches - focusStyleMatches));
  knowledgeScore += knowledgeHeavyAsk && focusCharacterMatches ? 1 : 0;

  const delta = knowledgeScore - memoryScore;
  const route = delta >= 3 ? "knowledge_heavy" : delta <= -3 ? "memory_heavy" : "balanced";
  const maxTokens = Number(getProviderContextWindow(story) || 0);
  const baseBudgets = getBaseBudgets(maxTokens);
  const budgets = { ...baseBudgets };
  const reasons = [];

  if (directContinuation) {
    reasons.push("Continuation wording pulled the route toward recent scene memory.");
  }
  if (memoryCueHits || sceneCueHits) {
    reasons.push("Scene-detail cues increased memory recall weight.");
  }
  if (knowledgeCueHits || focusWorldMatches || focusStyleMatches) {
    reasons.push("Lore or workspace-entity wording increased knowledge recall weight.");
  }
  if (styleHeavyAsk) {
    reasons.push("Style-focused wording preserved budget for style knowledge.");
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
    reasons.push("Strong scene-detail cues expanded the episodic evidence budget.");
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
      entityFocus: combinedCharacterMatches + combinedWorldMatches + combinedStyleMatches,
      worldFocus: combinedWorldMatches,
      styleFocus: combinedStyleMatches,
    },
    budgets,
    reasons,
  };
}

module.exports = {
  buildRetrievalPlan,
};
