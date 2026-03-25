const { extractKeywords } = require("./memory-engine");
const { MEMORY_KEYWORD_VERSION } = require("./memory-runtime");
const { buildMemoryCanonKey, buildMemoryConflictGroup } = require("./memory-schema");
const {
  normalizeLongText,
  normalizeStringList,
  normalizeText,
  splitNaturalClauses,
  unique,
} = require("./text-utils");

function createMemorySummaryTools({
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
  buildWorkspaceEntityIndex,
}) {
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
    return normalizeLongText(value)
      .replace(/^(user|assistant|system)\s*:\s*/gim, "")
      .replace(/^\s*(thought|thinking|analysis|inner monologue|\u601d\u7eea)[:\uFF1A][^\n]*$/gim, "")
      .replace(/\u601d\u7eea[:\uff1a][^\n]*/g, "")
      .replace(/---[\s\S]*?$/g, "")
      .replace(/["\u201c\u201d'\u2018\u2019`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function splitSummaryClauses(text) {
    return splitNaturalClauses(text)
      .flatMap((item) => item.split(/[,\uFF0C\u3001]/))
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function stripLeadingDialogueMarker(text) {
    return String(text || "")
      .replace(/^[\-*#>~\s]+/, "")
      .replace(/^[A-Za-z0-9_\u4e00-\u9fff]{1,12}[:\uFF1A]\s*/, "")
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
    if (/["\u201c\u201d'\u2018\u2019]/.test(text) && text.length <= 40) {
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
      keywordVersion: MEMORY_KEYWORD_VERSION,
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
    record.conflictGroup = buildMemoryConflictGroup(record);
    record.canonKey = buildMemoryCanonKey(record);
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

  async function makeHeuristicSummary(messages, workspace, story) {
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

    let summary = topClauses.join("; ");
    summary = summary
      .replace(/\s+/g, " ")
      .replace(/^[,;:\uFF0C\uFF1B\uFF1A\s]+/, "")
      .replace(/[,;:\uFF0C\uFF1B\uFF1A\s]+$/, "");
    if (!summary) {
      return null;
    }

    const entities = extractKeywords(recent.map((item) => item.content).join("\n")).slice(0, 10);

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

  async function makeFallbackSummary(messages, workspace, story) {
    const recent = messages.slice(-8);
    const summary = recent
      .map((item) => `${item.role}: ${summarizeText(item.content, 90)}`)
      .join(" | ");
    const entities = extractKeywords(recent.map((item) => item.content).join("\n")).slice(0, 10);
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

  async function buildMemoryCandidateFromMessages(story, messages, workspace) {
    return (await makeHeuristicSummary(messages, workspace, story)) || (await makeFallbackSummary(messages, workspace, story)) || null;
  }

  async function buildTransientMemoryCandidate(story, messages, workspace) {
    return buildMemoryCandidateFromMessages(story, messages, workspace);
  }

  function getRecentTurnMessages(messages = [], maxMessages = 2) {
    return (Array.isArray(messages) ? messages : [])
      .filter((item) => item && item.role !== "system")
      .slice(-Math.max(1, Number(maxMessages) || 2));
  }

  async function buildEpisodicMemoryCandidate(story, messages, workspace) {
    const recentTurnMessages = getRecentTurnMessages(messages, 2);
    if (!recentTurnMessages.length) {
      return null;
    }
    const candidate = await buildMemoryCandidateFromMessages(story, recentTurnMessages, workspace);
    if (!candidate) {
      return null;
    }
    const totalMessageCount = (Array.isArray(messages) ? messages : []).filter((item) => item && item.role !== "system").length;
    candidate.sourceMessageRange = [Math.max(1, totalMessageCount - recentTurnMessages.length + 1), totalMessageCount];
    return candidate;
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

  return {
    buildMemoryCandidateFromMessages,
    buildTransientMemoryCandidate,
    buildEpisodicMemoryCandidate,
    getSummarySchedule,
    getSummaryTriggers,
    isProbablyDialogueClause,
    looksLikeSummaryFact,
    looksLikeUserIntentClause,
    stripLeadingDialogueMarker,
    tryModelSummary,
  };
}

module.exports = {
  createMemorySummaryTools,
};
