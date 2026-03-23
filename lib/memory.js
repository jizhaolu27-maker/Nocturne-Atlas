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
}) {
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
        keywords: (record.entities || []).slice(0, 3),
      });
    }
    return facts.filter((item) => item.keywords.length > 0);
  }

  function detectForgetfulness({ workspace, memoryRecords, assistantText, contextInfo }) {
    const reasons = [];
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
      reasons.push("Context pressure is high");
    }
    if (ratio >= 0.7 && facts.length >= 4) {
      reasons.push("Assistant reply missed many active facts");
    } else if (ratio >= 0.45 && facts.length >= 4) {
      reasons.push("Assistant reply missed several active facts");
    }
    const content = String(assistantText || "");
    for (const item of workspace.worldbooks) {
      for (const rule of item.rules || []) {
        if (
          rule.toLowerCase().includes("never") &&
          content.toLowerCase().includes(rule.toLowerCase().replace("never", "").trim())
        ) {
          reasons.push(`Potential world rule conflict: ${rule}`);
          break;
        }
      }
    }
    let state = "normal";
    if (reasons.length >= 2 || (pressure === "high" && ratio >= 0.45)) {
      state = "risk";
    }
    if (reasons.length >= 3 || ratio >= 0.7) {
      state = "suspected_forgetfulness";
    }
    return {
      forgetfulnessState: state,
      forgetfulnessReasons: reasons,
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
      "关系",
      "背叛",
      "真相",
      "记忆",
      "死亡",
      "成长",
      "告白",
    ];
    return keywords.some((item) => text.includes(item));
  }

  function needsSummary(story, messages, contextInfo) {
    const turns = messages.filter((item) => item.role !== "system").length;
    if (turns > 0 && turns % ((story.settings.summaryInterval || DEFAULT_SUMMARY_INTERVAL) * 2) === 0) {
      return true;
    }
    if (classifyPressure(contextInfo.usedTokens, contextInfo.maxTokens) === "high") {
      return true;
    }
    return detectMajorEvent(messages.slice(-4));
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
      "关系",
      "恋人",
      "伴侣",
      "学姐",
      "背叛",
      "信任",
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
      "世界",
      "规则",
      "城市",
      "学院",
      "风暴",
      "王国",
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
      "角色",
      "记忆",
      "成长",
      "决定",
      "意识到",
      "发现",
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
      .replace(/思绪[:：][^\n]*/g, "")
      .replace(/---[\s\S]*?$/g, "")
      .replace(/[“”"'"'`]/g, "")
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
    if (/^(好的|是的|嗯|啊|哈|继续|后来|然后|明白了|收到|当然|可以|没问题)/.test(text)) {
      return true;
    }
    if (/我会|让我|我们继续|接下来|继续故事|继续剧情/.test(text)) {
      return true;
    }
    if (/["“”『』「」]/.test(text) && text.length <= 40) {
      return true;
    }
    if (/^(别怕|放心|听我说|看着我|告诉你)/.test(text)) {
      return true;
    }
    return false;
  }

  function looksLikeSummaryFact(clause) {
    const text = String(clause || "");
    return /得知|发现|确认|知道|意识到|开始|决定|自称|其实|原来|成为|出现|梦见|死亡|复活|关系|恋人|伴侣|学姐|身份|记忆|加深|揭示/.test(
      text
    );
  }

  function looksLikeUserIntentClause(clause) {
    const text = String(clause || "").trim();
    if (!text) {
      return false;
    }
    return /^(继续|后来|然后|接着|再来|我想|我要|希望|请|让|能不能|可不可以)/.test(text) || /创建新角色|继续故事|继续剧情|后面|接下来/.test(text);
  }

  function scoreSummaryClause(clause) {
    const text = String(clause || "");
    let score = 0;
    if (text.length >= 10) score += 1;
    if (text.length >= 20 && text.length <= 90) score += 1;
    if (/[得知|发现|确认|知道|意识到|开始|决定|自称|其实|原来|成为|出现|梦见|死亡|复活|关系|恋人|伴侣|学姐|身份|记忆|加深|揭示]/.test(text)) {
      score += 3;
    }
    if (/[是|为|与|有]/.test(text)) {
      score += 1;
    }
    if (/^(继续|后来|然后|于是|哈哈|嘻嘻|嗯|好的|是的)/.test(text)) {
      score -= 2;
    }
    if (text.includes("我的主人")) {
      score -= 2;
    }
    if (looksLikeSummaryFact(text)) {
      score += 3;
    }
    if (isProbablyDialogueClause(text)) {
      score -= 4;
    }
    if (/^(第|\d+[天日周月年后])/.test(text)) {
      score -= 1;
    }
    if (text.length > 120) {
      score -= 1;
    }
    return score;
  }

  function makeHeuristicSummary(messages) {
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

    return {
      id: safeId("memory"),
      type: "checkpoint",
      tier: "short_term",
      kind: inferMemoryKindFromSummary(summary, entities),
      summary: summarizeText(summary, MEMORY_SUMMARY_CHAR_LIMIT),
      entities,
      keywords: extractKeywords(summary).slice(0, 12),
      importance: detectMajorEvent(recent) ? "high" : "medium",
      sourceMessageRange: [Math.max(1, messages.length - 7), messages.length],
      createdAt: new Date().toISOString(),
    };
  }

  function makeFallbackSummary(messages) {
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
    return {
      id: safeId("memory"),
      type: "checkpoint",
      tier: "short_term",
      kind: inferMemoryKindFromSummary(summary, entities),
      summary: summarizeText(summary, MEMORY_SUMMARY_CHAR_LIMIT),
      entities,
      keywords: extractKeywords(summary).slice(0, 12),
      importance: detectMajorEvent(recent) ? "high" : "medium",
      sourceMessageRange: [Math.max(1, messages.length - 7), messages.length],
      createdAt: new Date().toISOString(),
    };
  }

  async function tryModelSummary(story, messages) {
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
          "Summarize recent story developments into compact JSON with keys: summary, entities, importance, kind. kind must be one of relationship_update, world_state, character_update, plot_checkpoint. Write summary as one terse factual sentence, ideally 30-90 Chinese characters or under 25 English words. Keep only the most durable change, avoid scene prose, avoid metaphors, avoid dialogue fragments, and avoid hedging. Keep entities as a short string array of at most 4 items.",
      },
      {
        role: "user",
        content: messages
          .slice(-8)
          .map((item) => `${item.role}: ${item.content}`)
          .join("\n"),
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
        responseFormat: { type: "json_object" },
      });
      const parsed = tryParseJsonObject(result.content);
      if (!parsed?.summary) {
        return null;
      }
      return {
        id: safeId("memory"),
        type: "checkpoint",
        tier: "short_term",
        kind: ["relationship_update", "world_state", "character_update", "plot_checkpoint"].includes(parsed.kind)
          ? parsed.kind
          : inferMemoryKindFromSummary(parsed.summary, parsed.entities),
        summary: summarizeText(parsed.summary, MEMORY_SUMMARY_CHAR_LIMIT),
        entities: Array.isArray(parsed.entities)
          ? parsed.entities
              .slice(0, 4)
              .map((item) => summarizeText(String(item || "").trim(), 24))
              .filter(Boolean)
          : [],
        keywords: extractKeywords(parsed.summary).slice(0, 12),
        importance: normalizeMemoryImportance(parsed.importance),
        sourceMessageRange: [Math.max(1, messages.length - 7), messages.length],
        createdAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  async function generateMemoryUpdate({ story, fullMessages, memoryRecords, workspace, summaryTriggers }) {
    const summarySchedule = getSummarySchedule(story, fullMessages);
    const summaryRecords = [];
    const consolidatedMemoryRecords = [];
    const consolidatedMemorySourceIds = [];
    const supersededLongTermIds = [];

    if (summaryTriggers.length > 0) {
      const summary =
        (await tryModelSummary(story, fullMessages)) ||
        makeHeuristicSummary(fullMessages) ||
        makeFallbackSummary(fullMessages);
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
        consolidatedMemoryRecords,
        consolidatedMemorySourceIds: Array.from(new Set(consolidatedMemorySourceIds)),
        supersededLongTermIds: Array.from(new Set(supersededLongTermIds)),
        records: consolidation.records,
      };
    }

    return {
      summarySchedule,
      summaryRecords,
      consolidatedMemoryRecords,
      consolidatedMemorySourceIds: [],
      supersededLongTermIds: [],
      records: memoryRecords,
    };
  }

  return {
    extractKeywords,
    formatMemoryContext,
    selectRelevantMemoryRecords,
    detectForgetfulness,
    needsSummary,
    getSummaryTriggers,
    getSummarySchedule,
    tryModelSummary,
    generateMemoryUpdate,
  };
}

module.exports = {
  createMemoryTools,
};
