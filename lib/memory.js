const { consolidateMemoryRecords } = require("./memory-consolidation");
const { extractKeywords, formatMemoryContext, selectRelevantMemoryRecords } = require("./memory-engine");

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

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function createMemoryTools({
  DEFAULT_SUMMARY_INTERVAL,
  MEMORY_SUMMARY_CHAR_LIMIT,
  classifyPressure,
  summarizeText,
  safeId,
  getProviderForStory,
  decryptSecret,
  callOpenAICompatible,
  tryParseJsonObject,
  embedText,
  embedTextDetailed,
  buildMemoryEmbeddingText,
  resolveEmbeddingOptions,
}) {
  function buildWorkspaceEntityIndex(workspace = {}) {
    const index = new Map();
    for (const item of workspace.characters || []) {
      const terms = [item.id, item.name, item.core?.role, ...normalizeStringList(item.traits)].filter(Boolean);
      index.set(item.id, {
        id: item.id,
        scope: "character",
        terms: terms.map((term) => normalizeText(term)),
      });
    }
    for (const item of workspace.worldbooks || []) {
      const terms = [item.id, item.title, item.category, ...normalizeStringList(item.rules), item.storyState].filter(Boolean);
      index.set(item.id, {
        id: item.id,
        scope: "world",
        terms: terms.map((term) => normalizeText(term)),
      });
    }
    return index;
  }

  function extractFacts(workspace, memoryRecords) {
    const facts = [];
    for (const item of workspace.characters) {
      if (item.name) {
        facts.push({
          kind: "character",
          label: item.name,
          keywords: [item.name, ...normalizeStringList(item.traits).slice(0, 2)].filter(Boolean),
        });
      }
      if (item.arcState?.current) {
        facts.push({
          kind: "character_arc",
          label: `${item.name} ${item.arcState.current}`,
          keywords: [item.name, item.arcState.current].filter(Boolean),
        });
      }
    }
    for (const item of workspace.worldbooks) {
      if (item.title) {
        facts.push({
          kind: "world",
          label: item.title,
          keywords: [item.title, ...normalizeStringList(item.rules).slice(0, 2)].filter(Boolean),
        });
      }
    }
    for (const record of memoryRecords.slice(-3)) {
      facts.push({
        kind: "memory",
        label: record.summary,
        keywords: [...(record.entities || []), ...(record.subjectIds || [])].slice(0, 3),
      });
    }
    return facts.filter((item) => item.keywords.length > 0);
  }

  function detectRelevantStableMemories(memoryRecords, assistantText) {
    const text = normalizeText(assistantText);
    return memoryRecords.filter((item) => {
      if (item.tier !== "long_term" || item.supersededBy || item.stability !== "stable") {
        return false;
      }
      const terms = unique([
        ...(item.subjectIds || []),
        ...(item.objectIds || []),
        ...(item.entities || []),
        ...(item.tags || []),
      ])
        .map((term) => normalizeText(term))
        .filter(Boolean);
      return terms.some((term) => text.includes(term));
    });
  }

  function detectRuleConflicts(workspace, assistantText) {
    const reasons = [];
    const content = String(assistantText || "");
    for (const item of workspace.worldbooks) {
      for (const rule of normalizeStringList(item.rules)) {
        if (
          rule.toLowerCase().includes("never") &&
          content.toLowerCase().includes(rule.toLowerCase().replace("never", "").trim())
        ) {
          reasons.push(`Potential world rule conflict: ${rule}`);
          break;
        }
      }
    }
    return reasons;
  }

  function detectStableMemoryConflicts(memoryRecords, assistantText) {
    const text = normalizeText(assistantText);
    const reasons = [];
    const positiveSignals = {
      trust: ["trust", "ally", "friend", "lover", "mentor", "\u4fe1\u4efb", "\u540c\u76df", "\u670b\u53cb", "\u604b\u4eba", "\u5bfc\u5e08"],
      memory: ["remember", "recall", "know", "\u8bb0\u5f97", "\u60f3\u8d77", "\u77e5\u9053"],
      life: ["alive", "living", "survived", "\u6d3b\u7740", "\u5e78\u5b58"],
    };
    const negativeSignals = {
      trust: ["betray", "enemy", "stranger", "hate", "mistrust", "\u80cc\u53db", "\u654c\u4eba", "\u964c\u751f", "\u618e\u6068", "\u4e0d\u4fe1\u4efb"],
      memory: ["forget", "forgot", "unknown", "\u5fd8\u8bb0", "\u4e0d\u8bb0\u5f97", "\u4e0d\u8ba4\u8bc6"],
      life: ["dead", "died", "corpse", "\u6b7b\u4ea1", "\u6b7b\u53bb", "\u5c38\u4f53"],
    };

    for (const record of detectRelevantStableMemories(memoryRecords, assistantText).slice(0, 4)) {
      const summary = normalizeText(record.summary);
      const hasPositiveTrust = positiveSignals.trust.some((term) => summary.includes(term));
      const hasPositiveMemory = positiveSignals.memory.some((term) => summary.includes(term));
      const hasPositiveLife = positiveSignals.life.some((term) => summary.includes(term));

      if (hasPositiveTrust && negativeSignals.trust.some((term) => text.includes(term))) {
        reasons.push(`Potential stable relationship conflict: ${record.summary}`);
      }
      if (hasPositiveMemory && negativeSignals.memory.some((term) => text.includes(term))) {
        reasons.push(`Potential memory-state conflict: ${record.summary}`);
      }
      if (hasPositiveLife && negativeSignals.life.some((term) => text.includes(term))) {
        reasons.push(`Potential life-state conflict: ${record.summary}`);
      }

      if (
        record.kind === "relationship_update" &&
        (record.subjectIds || []).length > 0 &&
        (record.objectIds || []).length > 0 &&
        /(\u7b2c\u4e00\u6b21\u89c1|\u521d\u6b21\u89c1\u9762|\u4e0d\u8ba4\u8bc6|\u7d20\u672a\u8c0b\u9762|\u964c\u751f\u4eba)/.test(text)
      ) {
        reasons.push(`Potential relationship reset conflict: ${record.summary}`);
      }

      if (record.kind === "world_state" && /(\u89c4\u5219\u5931\u6548|\u7981\u4ee4\u89e3\u9664|\u4ece\u4e0d\u9700\u8981\u9075\u5b88|\u65e0\u89c6\u6cd5\u5219)/.test(text)) {
        reasons.push(`Potential world-state drift: ${record.summary}`);
      }
    }

    return unique(reasons);
  }

  function detectSubjectMentionWithoutSupport(memoryRecords, assistantText) {
    const text = normalizeText(assistantText);
    const reasons = [];
    const relevant = detectRelevantStableMemories(memoryRecords, assistantText);
    for (const record of relevant.slice(0, 4)) {
      const subjectMentions = unique([...(record.subjectIds || []), ...(record.objectIds || [])])
        .map((item) => normalizeText(item))
        .filter(Boolean);
      const mentionedSubjects = subjectMentions.filter((term) => text.includes(term));
      const supportTerms = unique([...(record.tags || []), ...(record.entities || [])])
        .map((item) => normalizeText(item))
        .filter(Boolean);
      if (
        mentionedSubjects.length > 0 &&
        supportTerms.length >= 2 &&
        supportTerms.every((term) => !text.includes(term))
      ) {
        reasons.push(`Subject mentioned without stable-memory support: ${record.summary}`);
      }
    }
    return unique(reasons);
  }

  function detectForgetfulness({ workspace, memoryRecords, assistantText, contextInfo }) {
    const reasons = [];
    const omissionReasons = [];
    const conflictReasons = [];
    const pressureReasons = [];
    const lower = String(assistantText || "").toLowerCase();
    const facts = extractFacts(workspace, memoryRecords).slice(0, 8);
    let missed = 0;
    for (const fact of facts) {
      const hit = fact.keywords.some((keyword) => lower.includes(String(keyword).toLowerCase()));
      if (!hit) {
        missed += 1;
      }
    }
    const ratio = facts.length ? missed / facts.length : 0;
    const pressure = classifyPressure(contextInfo.usedTokens, contextInfo.maxTokens);
    if (pressure === "high") {
      pressureReasons.push("Context pressure is high");
    }
    if (ratio >= 0.7 && facts.length >= 4) {
      omissionReasons.push("Assistant reply missed many active facts");
    } else if (ratio >= 0.45 && facts.length >= 4) {
      omissionReasons.push("Assistant reply missed several active facts");
    }

    omissionReasons.push(...detectSubjectMentionWithoutSupport(memoryRecords, assistantText));
    conflictReasons.push(...detectStableMemoryConflicts(memoryRecords, assistantText));
    conflictReasons.push(...detectRuleConflicts(workspace, assistantText));

    reasons.push(...pressureReasons, ...omissionReasons, ...conflictReasons);

    let state = "normal";
    if (reasons.length >= 2 || (pressure === "high" && ratio >= 0.45)) {
      state = "risk";
    }
    if (reasons.length >= 3 || ratio >= 0.7) {
      state = "suspected_forgetfulness";
    }
    return {
      forgetfulnessState: state,
      forgetfulnessReasons: unique(reasons).slice(0, 5),
      forgetfulnessSignals: {
        pressure: unique(pressureReasons).slice(0, 3),
        omission: unique(omissionReasons).slice(0, 4),
        conflict: unique(conflictReasons).slice(0, 4),
      },
      pressureLevel: pressure,
    };
  }

  function detectMajorEvent(messages) {
    const text = messages.map((item) => item.content).join("\n").toLowerCase();
    const keywords = [
      "confess",
      "betray",
      "reveal",
      "secret",
      "love",
      "hate",
      "kill",
      "death",
      "remember",
      "growth",
      "forgive",
      "alliance",
      "\u5173\u7cfb",
      "\u80cc\u53db",
      "\u771f\u76f8",
      "\u8bb0\u5fc6",
      "\u6b7b\u4ea1",
      "\u6210\u957f",
      "\u544a\u767d",
    ];
    return keywords.some((item) => text.includes(item));
  }

  function getSummaryTriggers(story, messages, contextInfo) {
    const triggers = [];
    const turns = messages.filter((item) => item.role !== "system").length;
    const interval = (story.settings.summaryInterval || DEFAULT_SUMMARY_INTERVAL) * 2;
    if (turns > 0 && turns % interval === 0) {
      triggers.push(`Turn interval reached (${turns}/${interval})`);
    }
    if (classifyPressure(contextInfo.usedTokens, contextInfo.maxTokens) === "high") {
      triggers.push("Context pressure exceeded high threshold");
    }
    if (detectMajorEvent(messages.slice(-4))) {
      triggers.push("Major event keywords detected in recent turns");
    }
    return triggers;
  }

  function buildTransientMemoryCandidate(story, messages, workspace) {
    return makeHeuristicSummary(messages, workspace, story) || makeFallbackSummary(messages, workspace, story) || null;
  }

  function getSummarySchedule(story, messages) {
    const messageCount = messages.filter((item) => item.role !== "system").length;
    const configuredRounds = Math.max(1, Number(story.settings.summaryInterval) || DEFAULT_SUMMARY_INTERVAL);
    const intervalMessages = configuredRounds * 2;
    const remainder = messageCount % intervalMessages;
    const remainingMessages =
      messageCount === 0 ? intervalMessages : remainder === 0 ? intervalMessages : intervalMessages - remainder;
    const nextMessageCount = messageCount + remainingMessages;
    return {
      configuredRounds,
      intervalMessages,
      currentMessageCount: messageCount,
      currentRounds: Math.floor(messageCount / 2),
      remainingMessages,
      remainingRounds: remainingMessages / 2,
      nextMessageCount,
      nextRound: nextMessageCount / 2,
    };
  }

  function inferMemoryKindFromSummary(summary, entities = []) {
    const text = String(summary || "").toLowerCase();
    const entityCount = Array.isArray(entities) ? entities.length : 0;
    const relationshipHints = [
      "relationship",
      "bond",
      "alliance",
      "rival",
      "trust",
      "mentor",
      "friend",
      "lover",
      "betray",
      "conflict",
      "\u5173\u7cfb",
      "\u604b\u4eba",
      "\u4f34\u4fa3",
      "\u80cc\u53db",
      "\u4fe1\u4efb",
    ];
    const worldHints = [
      "world",
      "city",
      "kingdom",
      "archive",
      "storm",
      "law",
      "rule",
      "setting",
      "commonwealth",
      "\u4e16\u754c",
      "\u89c4\u5219",
      "\u57ce\u5e02",
      "\u98ce\u66b4",
      "\u738b\u56fd",
    ];
    const characterHints = [
      "realize",
      "decide",
      "growth",
      "fear",
      "resolve",
      "hesitate",
      "remember",
      "choose",
      "character",
      "\u89d2\u8272",
      "\u8bb0\u5fc6",
      "\u6210\u957f",
      "\u51b3\u5b9a",
      "\u610f\u8bc6\u5230",
      "\u53d1\u73b0",
    ];
    if (relationshipHints.some((item) => text.includes(item))) {
      return "relationship_update";
    }
    if (worldHints.some((item) => text.includes(item))) {
      return "world_state";
    }
    if (characterHints.some((item) => text.includes(item)) || entityCount > 0) {
      return "character_update";
    }
    return "plot_checkpoint";
  }

  function normalizeMemoryImportance(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (["low", "medium", "high"].includes(normalized)) {
      return normalized;
    }
    return "medium";
  }

  function sanitizeSummarySourceText(value) {
    return String(value || "")
      .replace(/\r\n/g, "\n")
      .replace(/^(user|assistant|system)\s*:\s*/gim, "")
      .replace(/Orizum[^。\n]*[。!！?？]?/g, "")
      .replace(/\u601d\u7eea[:\uff1a][^\n]*/g, "")
      .replace(/---[\s\S]*?$/g, "")
      .replace(/[“”"'`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function splitSummaryClauses(text) {
    return String(text || "")
      .split(/[。！？!?；;\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function stripLeadingDialogueMarker(text) {
    return String(text || "")
      .replace(/^[\-*#>~\s]+/, "")
      .replace(/^[A-Za-z0-9_\u4e00-\u9fff]{1,12}[：:]\s*/, "")
      .trim();
  }

  function isProbablyDialogueClause(clause) {
    const text = String(clause || "").trim();
    if (!text) {
      return false;
    }
    if (/^(\u597d\u7684|\u662f\u7684|\u55ef|\u554a|\u54c8|\u7ee7\u7eed|\u540e\u6765|\u7136\u540e|\u660e\u767d\u4e86|\u6536\u5230|\u5f53\u7136|\u53ef\u4ee5|\u6ca1\u95ee\u9898)/.test(text)) {
      return true;
    }
    if (/\u6211\u4f1a|\u8ba9\u6211|\u6211\u4eec\u7ee7\u7eed|\u63a5\u4e0b\u6765|\u7ee7\u7eed\u6545\u4e8b|\u7ee7\u7eed\u5267\u60c5/.test(text)) {
      return true;
    }
    if (/["“”『』「」]/.test(text) && text.length <= 40) {
      return true;
    }
    if (/^(\u522b\u6015|\u653e\u5fc3|\u542c\u6211\u8bf4|\u770b\u7740\u6211|\u544a\u8bc9\u4f60)/.test(text)) {
      return true;
    }
    return false;
  }

  function looksLikeSummaryFact(clause) {
    const text = String(clause || "");
    return /\u5f97\u77e5|\u53d1\u73b0|\u786e\u8ba4|\u77e5\u9053|\u610f\u8bc6\u5230|\u5f00\u59cb|\u51b3\u5b9a|\u81ea\u79f0|\u5176\u5b9e|\u539f\u6765|\u6210\u4e3a|\u51fa\u73b0|\u68a6\u89c1|\u6b7b\u4ea1|\u590d\u6d3b|\u5173\u7cfb|\u604b\u4eba|\u4f34\u4fa3|\u8eab\u4efd|\u8bb0\u5fc6|\u52a0\u6df1|\u63ed\u793a/.test(
      text
    );
  }

  function looksLikeUserIntentClause(clause) {
    const text = String(clause || "").trim();
    if (!text) {
      return false;
    }
    return /^(\u7ee7\u7eed|\u540e\u6765|\u7136\u540e|\u63a5\u7740|\u518d\u6765|\u6211\u60f3|\u6211\u8981|\u5e0c\u671b|\u8bf7|\u8ba9|\u80fd\u4e0d\u80fd|\u53ef\u4e0d\u53ef\u4ee5)/.test(text) || /\u521b\u5efa\u65b0\u89d2\u8272|\u7ee7\u7eed\u6545\u4e8b|\u7ee7\u7eed\u5267\u60c5|\u540e\u9762|\u63a5\u4e0b\u6765/.test(text);
  }

  function scoreSummaryClause(clause) {
    const text = String(clause || "");
    let score = 0;
    if (text.length >= 10) score += 1;
    if (text.length >= 20 && text.length <= 90) score += 1;
    if (/(\u5f97\u77e5|\u53d1\u73b0|\u786e\u8ba4|\u77e5\u9053|\u610f\u8bc6\u5230|\u5f00\u59cb|\u51b3\u5b9a|\u81ea\u79f0|\u5176\u5b9e|\u539f\u6765|\u6210\u4e3a|\u51fa\u73b0|\u68a6\u89c1|\u6b7b\u4ea1|\u590d\u6d3b|\u5173\u7cfb|\u604b\u4eba|\u4f34\u4fa3|\u8eab\u4efd|\u8bb0\u5fc6|\u52a0\u6df1|\u63ed\u793a)/.test(text)) {
      score += 3;
    }
    if (/[\u662f\u4e3a\u4e0e\u6709]/.test(text)) {
      score += 1;
    }
    if (/^(\u7ee7\u7eed|\u540e\u6765|\u7136\u540e|\u4e8e\u662f|\u54c8\u54c8|\u563b\u563b|\u55ef|\u597d\u7684|\u662f\u7684)/.test(text)) {
      score -= 2;
    }
    if (text.includes("\u6211\u7684\u4e3b\u4eba")) {
      score -= 2;
    }
    if (looksLikeSummaryFact(text)) {
      score += 3;
    }
    if (isProbablyDialogueClause(text)) {
      score -= 4;
    }
    if (/^(\u7b2c|\d+[\u5929\u65e5\u5468\u6708\u5e74\u540e])/.test(text)) {
      score -= 1;
    }
    if (text.length > 120) {
      score -= 1;
    }
    return score;
  }

  function inferSubjectMetadata(summary, workspace, entities = [], kind = "plot_checkpoint") {
    const text = normalizeText(summary);
    const entityIndex = buildWorkspaceEntityIndex(workspace);
    const matched = [];
    for (const item of entityIndex.values()) {
      if (
        item.terms.some((term) => term && (text.includes(term) || entities.some((entity) => normalizeText(entity) === term)))
      ) {
        matched.push(item);
      }
    }

    const uniqueMatched = matched.filter((item, index, list) => list.findIndex((entry) => entry.id === item.id) === index);
    const characterIds = uniqueMatched.filter((item) => item.scope === "character").map((item) => item.id);
    const worldIds = uniqueMatched.filter((item) => item.scope === "world").map((item) => item.id);

    if (kind === "world_state") {
      return { scope: "world", subjectIds: worldIds.slice(0, 2), objectIds: [] };
    }
    if (kind === "relationship_update") {
      return { scope: "relationship", subjectIds: characterIds.slice(0, 1), objectIds: characterIds.slice(1, 2) };
    }
    if (kind === "character_update") {
      return { scope: "character", subjectIds: characterIds.slice(0, 2), objectIds: [] };
    }
    return {
      scope: characterIds.length ? "character" : worldIds.length ? "world" : "plot",
      subjectIds: [...characterIds, ...worldIds].slice(0, 2),
      objectIds: characterIds.slice(1, 2),
    };
  }

  function buildMemoryTags(summary, entities = []) {
    return unique([...extractKeywords(summary), ...entities.map((item) => normalizeText(item))]).slice(0, 8);
  }

  async function createStructuredMemoryRecord({
    summary,
    entities,
    importance,
    kind,
    story,
    workspace,
    sourceMessageRange,
    extra = {},
  }) {
    const normalizedEntities = Array.isArray(entities)
      ? entities
          .slice(0, 6)
          .map((item) => summarizeText(String(item || "").trim(), 24))
          .filter(Boolean)
      : [];
    const resolvedKind = ["relationship_update", "world_state", "character_update", "plot_checkpoint"].includes(kind)
      ? kind
      : inferMemoryKindFromSummary(summary, normalizedEntities);
    const inferred = inferSubjectMetadata(summary, workspace, normalizedEntities, resolvedKind);
    const normalizedImportance = normalizeMemoryImportance(importance);
    const record = {
      id: safeId("memory"),
      type: "checkpoint",
      tier: "short_term",
      kind: resolvedKind,
      summary: summarizeText(summary, MEMORY_SUMMARY_CHAR_LIMIT),
      entities: normalizedEntities,
      keywords: extractKeywords(summary).slice(0, 12),
      importance: normalizedImportance,
      scope: extra.scope || inferred.scope,
      subjectIds: Array.isArray(extra.subjectIds) ? extra.subjectIds.slice(0, 2) : inferred.subjectIds,
      objectIds: Array.isArray(extra.objectIds) ? extra.objectIds.slice(0, 2) : inferred.objectIds,
      tags: Array.isArray(extra.tags) ? unique(extra.tags).slice(0, 8) : buildMemoryTags(summary, normalizedEntities),
      stability:
        extra.stability ||
        (resolvedKind === "world_state" || resolvedKind === "relationship_update" || resolvedKind === "character_update"
          ? "stable"
          : normalizedImportance === "high"
            ? "stable"
            : "volatile"),
      confidence: Number.isFinite(Number(extra.confidence)) ? Number(extra.confidence) : 0.72,
      sourceMessageRange,
      createdAt: new Date().toISOString(),
    };
    const embeddingOptions = typeof resolveEmbeddingOptions === "function" ? resolveEmbeddingOptions(story) : { mode: "off" };
    if (
      embeddingOptions?.mode === "on" &&
      (typeof embedTextDetailed === "function" || typeof embedText === "function") &&
      typeof buildMemoryEmbeddingText === "function"
    ) {
      const embeddingResult =
        typeof embedTextDetailed === "function"
          ? await embedTextDetailed(buildMemoryEmbeddingText(record), embeddingOptions)
          : {
              vector: await embedText(buildMemoryEmbeddingText(record), embeddingOptions),
              provider: embeddingOptions.provider || "hash_v1",
              model: embeddingOptions.provider === "hash_v1" ? "hash_v1" : embeddingOptions.model || "",
              fallbackUsed: false,
              error: "",
            };
      if (Array.isArray(embeddingResult?.vector) && embeddingResult.vector.length) {
        record.embedding = embeddingResult.vector;
        record.embeddingProvider = embeddingResult.provider || embeddingOptions.provider || "hash_v1";
        record.embeddingModel =
          embeddingResult.model || (embeddingResult.provider === "hash_v1" ? "hash_v1" : embeddingOptions.model || "");
        record.embeddingFallbackUsed = Boolean(embeddingResult.fallbackUsed);
        if (embeddingResult.requestedProvider && embeddingResult.requestedProvider !== record.embeddingProvider) {
          record.embeddingRequestedProvider = embeddingResult.requestedProvider;
        }
        record.embeddedAt = new Date().toISOString();
      }
    }
    return record;
  }

  function splitEvidenceClauses(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .split(/[\n.!?;:\u3002\uff01\uff1f\uff1b\uff1a]+/)
      .map((item) => stripLeadingDialogueMarker(item))
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function scoreEvidenceClause(clause, role, recordTerms = []) {
    const text = String(clause || "").trim();
    if (!text) {
      return -Infinity;
    }
    let score = 0;
    if (text.length >= 12) score += 1;
    if (text.length >= 24 && text.length <= 160) score += 2;
    if (role === "assistant") score += 2;
    if (looksLikeSummaryFact(text)) score += 3;
    if (isProbablyDialogueClause(text)) score -= 4;
    if (looksLikeUserIntentClause(text)) score -= 4;

    const normalizedText = normalizeText(text);
    const termHits = unique(recordTerms.filter((term) => term && normalizedText.includes(term)));
    if (termHits.length) {
      score += termHits.length * 2;
    }
    return score;
  }

  async function buildMemoryEvidenceChunks({ story, messages, record }) {
    const recentMessages = (Array.isArray(messages) ? messages : []).slice(-4);
    if (!record?.id || !recentMessages.length) {
      return [];
    }

    const recordTerms = unique([
      ...(record.entities || []),
      ...(record.tags || []),
      ...(record.subjectIds || []),
      ...(record.objectIds || []),
      ...extractKeywords(record.summary || ""),
    ])
      .map((item) => normalizeText(item))
      .filter(Boolean);

    const rankedClauses = recentMessages
      .flatMap((message, messageIndex) =>
        splitEvidenceClauses(message.content).map((clause, clauseIndex) => ({
          role: message.role,
          text: summarizeText(clause, 220),
          messageIndex,
          clauseIndex,
          score: scoreEvidenceClause(clause, message.role, recordTerms),
        }))
      )
      .filter((item) => item.score > 1 && item.text)
      .sort((a, b) => b.score - a.score || b.messageIndex - a.messageIndex || a.clauseIndex - b.clauseIndex);

    const selected = [];
    const seenText = new Set();
    for (const item of rankedClauses) {
      const dedupeKey = normalizeText(item.text);
      if (!dedupeKey || seenText.has(dedupeKey)) {
        continue;
      }
      seenText.add(dedupeKey);
      selected.push(item);
      if (selected.length >= 3) {
        break;
      }
    }

    if (!selected.length) {
      return [];
    }

    const embeddingOptions = typeof resolveEmbeddingOptions === "function" ? resolveEmbeddingOptions(story) : { mode: "off" };
    const chunks = [];
    for (const [index, item] of selected.entries()) {
      const chunk = {
        id: safeId("memchunk"),
        type: "memory_evidence",
        linkedRecordId: record.id,
        text: item.text,
        sourceRole: item.role,
        sourceMessageRange: Array.isArray(record.sourceMessageRange) ? [...record.sourceMessageRange] : [],
        kind: record.kind,
        importance: record.importance,
        scope: record.scope || "plot",
        subjectIds: Array.isArray(record.subjectIds) ? [...record.subjectIds] : [],
        objectIds: Array.isArray(record.objectIds) ? [...record.objectIds] : [],
        entities: Array.isArray(record.entities) ? [...record.entities] : [],
        tags: Array.isArray(record.tags) ? [...record.tags] : [],
        keywords: extractKeywords(item.text).slice(0, 12),
        stability: record.stability || "volatile",
        confidence: Math.max(0.5, Number(record.confidence || 0.6) - index * 0.04),
        createdAt: new Date().toISOString(),
      };
      if (
        embeddingOptions?.mode === "on" &&
        (typeof embedTextDetailed === "function" || typeof embedText === "function") &&
        typeof buildMemoryEmbeddingText === "function"
      ) {
        const embeddingResult =
          typeof embedTextDetailed === "function"
            ? await embedTextDetailed(
                buildMemoryEmbeddingText({
                  summary: chunk.text,
                  entities: chunk.entities,
                  tags: chunk.tags,
                  keywords: chunk.keywords,
                  subjectIds: chunk.subjectIds,
                  objectIds: chunk.objectIds,
                }),
                embeddingOptions
              )
            : {
                vector: await embedText(
                  buildMemoryEmbeddingText({
                    summary: chunk.text,
                    entities: chunk.entities,
                    tags: chunk.tags,
                    keywords: chunk.keywords,
                    subjectIds: chunk.subjectIds,
                    objectIds: chunk.objectIds,
                  }),
                  embeddingOptions
                ),
                provider: embeddingOptions.provider || "hash_v1",
                model: embeddingOptions.provider === "hash_v1" ? "hash_v1" : embeddingOptions.model || "",
                fallbackUsed: false,
                error: "",
              };
        if (Array.isArray(embeddingResult?.vector) && embeddingResult.vector.length) {
          chunk.embedding = embeddingResult.vector;
          chunk.embeddingProvider = embeddingResult.provider || embeddingOptions.provider || "hash_v1";
          chunk.embeddingModel =
            embeddingResult.model || (embeddingResult.provider === "hash_v1" ? "hash_v1" : embeddingOptions.model || "");
          chunk.embeddingFallbackUsed = Boolean(embeddingResult.fallbackUsed);
          if (embeddingResult.requestedProvider && embeddingResult.requestedProvider !== chunk.embeddingProvider) {
            chunk.embeddingRequestedProvider = embeddingResult.requestedProvider;
          }
          chunk.embeddedAt = new Date().toISOString();
        }
      }
      chunks.push(chunk);
    }
    return chunks;
  }

  function makeHeuristicSummary(messages, workspace, story) {
    const recent = messages.slice(-8);
    const assistantClauses = recent
      .filter((item) => item.role === "assistant")
      .map((item) => sanitizeSummarySourceText(item.content));
    const userClauses = recent
      .filter((item) => item.role === "user")
      .map((item) => sanitizeSummarySourceText(item.content));

    const assistantCandidates = assistantClauses
      .flatMap(splitSummaryClauses)
      .map((item) => stripLeadingDialogueMarker(item))
      .filter((item) => item.length >= 8)
      .filter((item, index, list) => list.indexOf(item) === index);
    const userCandidates = userClauses
      .flatMap(splitSummaryClauses)
      .map((item) => stripLeadingDialogueMarker(item))
      .filter((item) => item.length >= 8)
      .filter((item, index, list) => list.indexOf(item) === index)
      .filter((item) => looksLikeSummaryFact(item) && !looksLikeUserIntentClause(item));

    const candidateClauses = assistantCandidates.length ? [...assistantCandidates, ...userCandidates] : userCandidates;
    if (!candidateClauses.length) {
      return null;
    }

    const ranked = candidateClauses
      .map((clause) => {
        const fromAssistant = assistantCandidates.includes(clause);
        const fromUser = userCandidates.includes(clause) && !fromAssistant;
        let score = scoreSummaryClause(clause);
        if (fromAssistant) {
          score += 2;
        }
        if (fromUser) {
          score -= 1;
        }
        return { clause, score, fromAssistant };
      })
      .sort((a, b) => b.score - a.score || b.clause.length - a.clause.length);

    const factualClauses = ranked.filter((item) => item.score > 0 && looksLikeSummaryFact(item.clause));
    const assistantFallbackClauses = ranked.filter(
      (item) => item.fromAssistant && item.score > 1 && !isProbablyDialogueClause(item.clause)
    );
    const fallbackClauses = ranked.filter((item) => item.score > 1 && !isProbablyDialogueClause(item.clause));
    const selectedPool = factualClauses.length
      ? factualClauses
      : assistantFallbackClauses.length
        ? assistantFallbackClauses
        : fallbackClauses;
    const topClauses = selectedPool.slice(0, 2).map((item) => item.clause);
    if (!topClauses.length) {
      return null;
    }

    let summary = topClauses.join("；");
    summary = summary
      .replace(/\s+/g, " ")
      .replace(/^[，。；、\s]+/, "")
      .replace(/[，。；、\s]+$/, "");
    if (!summary) {
      return null;
    }

    const entities = Array.from(
      new Set(
        recent.flatMap((item) => String(item.content).match(/[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,4}/g) || [])
      )
    ).slice(0, 10);

    return createStructuredMemoryRecord({
      summary,
      entities,
      importance: detectMajorEvent(recent) ? "high" : "medium",
      kind: inferMemoryKindFromSummary(summary, entities),
      story,
      workspace,
      sourceMessageRange: [Math.max(1, messages.length - 7), messages.length],
      extra: { confidence: 0.68 },
    });
  }

  function makeFallbackSummary(messages, workspace, story) {
    const recent = messages.slice(-8);
    const summary = recent
      .map((item) => `${item.role}: ${summarizeText(item.content, 90)}`)
      .join(" | ");
    const entities = Array.from(
      new Set(
        recent
          .flatMap((item) => String(item.content).match(/[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,4}/g) || [])
          .slice(0, 10)
      )
    );
    return createStructuredMemoryRecord({
      summary,
      entities,
      importance: detectMajorEvent(recent) ? "high" : "medium",
      kind: inferMemoryKindFromSummary(summary, entities),
      story,
      workspace,
      sourceMessageRange: [Math.max(1, messages.length - 7), messages.length],
      extra: { confidence: 0.5 },
    });
  }

  async function tryModelSummary(story, messages, workspace) {
    const provider = getProviderForStory(story);
    if (!provider || !provider.encryptedApiKey || !story.model) {
      return null;
    }
    const apiKey = decryptSecret(provider.encryptedApiKey);
    if (!apiKey) {
      return null;
    }
    const prompt = [
      {
        role: "system",
        content:
          "Summarize recent story developments into compact JSON with keys: summary, entities, importance, kind, scope, subjectIds, objectIds, tags, stability, confidence. kind must be one of relationship_update, world_state, character_update, plot_checkpoint. scope must be one of character, relationship, world, plot. stability must be stable or volatile. Write summary as one terse factual sentence, ideally 30-90 Chinese characters or under 25 English words. Keep only the most durable change, avoid scene prose, avoid metaphors, avoid dialogue fragments, and avoid hedging. Keep entities and tags short. subjectIds/objectIds should use known workspace ids when obvious, otherwise empty arrays.",
      },
      {
        role: "user",
        content: [
          "Workspace entities:",
          JSON.stringify(
            {
              characters: (workspace.characters || []).map((item) => ({ id: item.id, name: item.name })),
              worldbooks: (workspace.worldbooks || []).map((item) => ({ id: item.id, title: item.title })),
            },
            null,
            2
          ),
          "",
          "Recent messages:",
          messages
            .slice(-8)
            .map((item) => `${item.role}: ${item.content}`)
            .join("\n"),
        ].join("\n"),
      },
    ];
    try {
      const result = await callOpenAICompatible({
        baseUrl: provider.baseUrl,
        apiKey,
        model: story.model || provider.model,
        messages: prompt,
        temperature: 0.2,
        topP: 1,
        max_tokens: 300,
        reasoningEffort: story.settings?.reasoningEffort,
        responseFormat: { type: "json_object" },
      });
      const parsed = tryParseJsonObject(result.content);
      if (!parsed?.summary) {
        return null;
      }
      return await createStructuredMemoryRecord({
        summary: parsed.summary,
        entities: parsed.entities,
        importance: parsed.importance,
        kind: parsed.kind,
        story,
        workspace,
        sourceMessageRange: [Math.max(1, messages.length - 7), messages.length],
        extra: {
          scope: ["character", "relationship", "world", "plot"].includes(parsed.scope) ? parsed.scope : undefined,
          subjectIds: Array.isArray(parsed.subjectIds) ? parsed.subjectIds.slice(0, 2).map(String) : undefined,
          objectIds: Array.isArray(parsed.objectIds) ? parsed.objectIds.slice(0, 2).map(String) : undefined,
          tags: Array.isArray(parsed.tags)
            ? parsed.tags.slice(0, 8).map((item) => summarizeText(String(item || "").trim(), 24)).filter(Boolean)
            : undefined,
          stability: ["stable", "volatile"].includes(parsed.stability) ? parsed.stability : undefined,
          confidence: parsed.confidence,
        },
      });
    } catch {
      return null;
    }
  }

  async function generateMemoryUpdate({ story, fullMessages, memoryRecords, memoryChunks = [], workspace, summaryTriggers }) {
    const summarySchedule = getSummarySchedule(story, fullMessages);
    const summaryRecords = [];
    const summaryChunks = [];
    const consolidatedMemoryRecords = [];
    const consolidatedMemorySourceIds = [];
    const supersededLongTermIds = [];

    if (summaryTriggers.length > 0) {
      const summary =
        (await tryModelSummary(story, fullMessages, workspace)) ||
        (await makeHeuristicSummary(fullMessages, workspace, story)) ||
        (await makeFallbackSummary(fullMessages, workspace, story));
      summary.triggeredBy = summaryTriggers.slice();
      summary.triggeredAt = {
        messageCount: summarySchedule.currentMessageCount,
        round: summarySchedule.currentRounds,
      };
      summary.schedule = {
        configuredRounds: summarySchedule.configuredRounds,
        intervalMessages: summarySchedule.intervalMessages,
      };
      summaryRecords.push(summary);
      summaryChunks.push(
        ...(await buildMemoryEvidenceChunks({
          story,
          messages: fullMessages,
          record: summary,
        }))
      );

      const consolidation = consolidateMemoryRecords([...memoryRecords, ...summaryRecords], {
        now: new Date().toISOString(),
        makeId: safeId,
        shortTermThreshold: 8,
      });
      if (consolidation.addedRecords.length > 0) {
        for (const item of consolidation.addedRecords) {
          item.triggeredBy = ["Memory consolidation threshold reached"];
          item.triggeredAt = {
            messageCount: summarySchedule.currentMessageCount,
            round: summarySchedule.currentRounds,
          };
          item.schedule = {
            configuredRounds: summarySchedule.configuredRounds,
            intervalMessages: summarySchedule.intervalMessages,
          };
        }
        consolidatedMemoryRecords.push(...consolidation.addedRecords);
        for (const item of consolidation.records) {
          if (item.mergedInto && consolidation.addedRecords.some((added) => added.id === item.mergedInto)) {
            consolidatedMemorySourceIds.push(item.id);
          }
          if (item.supersededBy && consolidation.addedRecords.some((added) => added.id === item.supersededBy)) {
            supersededLongTermIds.push(item.id);
          }
        }
      }
      return {
        summarySchedule,
        summaryRecords,
        summaryChunks,
        consolidatedMemoryRecords,
        consolidatedMemorySourceIds: Array.from(new Set(consolidatedMemorySourceIds)),
        supersededLongTermIds: Array.from(new Set(supersededLongTermIds)),
        records: consolidation.records,
        chunks: [...memoryChunks, ...summaryChunks],
      };
    }

    return {
      summarySchedule,
      summaryRecords,
      summaryChunks,
      consolidatedMemoryRecords,
      consolidatedMemorySourceIds: [],
      supersededLongTermIds: [],
      records: memoryRecords,
      chunks: memoryChunks,
    };
  }

  return {
    extractKeywords,
    formatMemoryContext,
    selectRelevantMemoryRecords,
    detectForgetfulness,
    getSummaryTriggers,
    getSummarySchedule,
    tryModelSummary,
    buildTransientMemoryCandidate,
    generateMemoryUpdate,
  };
}

module.exports = {
  createMemoryTools,
};
