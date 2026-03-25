const { normalizeStringList, normalizeText, unique } = require("./text-utils");

function createMemoryForgetfulnessTools({ classifyPressure }) {
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

  return {
    buildWorkspaceEntityIndex,
    detectForgetfulness,
  };
}

module.exports = {
  createMemoryForgetfulnessTools,
};
