"use strict";

const { extractSearchTerms, normalizeText, splitNaturalClauses, unique } = require("./text-utils");

const STOP_WORDS = new Set([
  "about",
  "also",
  "and",
  "are",
  "assistant",
  "but",
  "continue",
  "for",
  "from",
  "into",
  "only",
  "scene",
  "story",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "with",
  "your",
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

function extractGroundingTerms(text) {
  return unique(
    extractSearchTerms(text, { maxItems: 60 }).map((item) => normalizeText(item)).filter((item) => item && !STOP_WORDS.has(item))
  );
}

function splitAnswerClauses(text) {
  return splitNaturalClauses(text).filter((item) => item.length >= 10);
}

function getSupportTerms(item = {}, summaryField = "summary") {
  return unique(
    [
      ...(Array.isArray(item.subjectIds) ? item.subjectIds : []),
      ...(Array.isArray(item.objectIds) ? item.objectIds : []),
      ...(Array.isArray(item.entities) ? item.entities : []),
      ...(Array.isArray(item.tags) ? item.tags : []),
      ...(Array.isArray(item.keywords) ? item.keywords : []),
      item.scope,
      item.kind,
      item[summaryField],
      item.text,
      item.title,
    ].flatMap((value) => extractGroundingTerms(String(value || "")))
  );
}

function scoreClauseAgainstTerms(clauseTerms = [], sourceTerms = []) {
  if (!clauseTerms.length || !sourceTerms.length) {
    return 0;
  }
  const source = new Set(sourceTerms);
  return clauseTerms.filter((term) => source.has(term)).length;
}

function summarizeClause(value, summarizeText) {
  return typeof summarizeText === "function" ? summarizeText(value, 120) : String(value || "").slice(0, 120);
}

function formatSupportSourceType(sourceType) {
  const labels = {
    knowledge: "Knowledge",
    memory_fact: "Memory fact",
    memory_evidence: "Memory evidence",
    contested_memory: "Contested memory",
  };
  return labels[String(sourceType || "").trim()] || "Support";
}

function buildSupportSourceLabel(item = {}, sourceType, summaryField, summarizeText) {
  const preferred =
    item.title ||
    item.name ||
    item.sourceId ||
    item.id ||
    item.linkedRecordId ||
    item[summaryField] ||
    item.text ||
    item.summary;
  return summarizeClause(preferred || `${formatSupportSourceType(sourceType)} source`, summarizeText);
}

function buildSupportSourcePreview(item = {}, sourceType, summaryField, summarizeText) {
  const preferred = item[summaryField] || item.text || item.summary || item.title || item.name || "";
  return summarizeClause(preferred || buildSupportSourceLabel(item, sourceType, summaryField, summarizeText), summarizeText);
}

function buildSupportSourceEntries(items = [], { sourceType, summaryField = "summary", summarizeText } = {}) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => ({
      id: String(item?.id || `${sourceType}_${index + 1}`),
      sourceType,
      label: buildSupportSourceLabel(item, sourceType, summaryField, summarizeText),
      preview: buildSupportSourcePreview(item, sourceType, summaryField, summarizeText),
      rawText: String(item?.[summaryField] || item?.text || item?.summary || item?.title || item?.name || ""),
      terms: getSupportTerms(item, summaryField),
    }))
    .filter((item) => item.terms.length);
}

function computeTermOverlapRatio(leftTerms = [], rightTerms = []) {
  const left = unique(leftTerms).filter(Boolean);
  const right = new Set(unique(rightTerms).filter(Boolean));
  if (!left.length || !right.size) {
    return 0;
  }
  const overlap = left.filter((term) => right.has(term)).length;
  return overlap / Math.max(left.length, right.size);
}

function computeTextSupportBonus(clauseText, entryText, clauseTerms = [], sourceTerms = []) {
  const normalizedClause = normalizeText(clauseText);
  const normalizedEntry = normalizeText(entryText);
  if (!normalizedClause || !normalizedEntry) {
    return 0;
  }
  if (normalizedEntry.includes(normalizedClause) || normalizedClause.includes(normalizedEntry)) {
    return 3;
  }
  const overlapRatio = computeTermOverlapRatio(clauseTerms, sourceTerms);
  if (overlapRatio >= 0.82) {
    return 2;
  }
  if (overlapRatio >= 0.58) {
    return 1;
  }
  return 0;
}

function isAtmosphericClause(clause) {
  const text = String(clause || "").trim();
  if (!text) {
    return false;
  }
  const descriptiveCue =
    /[光影雨风霜雪雾月夜晨暮白黑纱冷暖温气味眼呼吸意识沉眠玉榻洞府]/.test(text) ||
    /\b(light|shadow|rain|wind|cold|warm|breath|dawn|night|mist|curtain|stone|bed|eye|sleep)\b/i.test(text);
  const factualCue =
    /[得知发现确认知道决定成为揭示原来关系记忆身份规则必须因为]/.test(text) ||
    /\b(reveal|discover|confirm|decide|remember|because|must|rule|identity|relationship)\b/i.test(text);
  return descriptiveCue && !factualCue;
}

function matchClauseAgainstSources(clauseText = "", clauseTerms = [], sourceEntries = []) {
  return (Array.isArray(sourceEntries) ? sourceEntries : [])
    .map((entry) => {
      const termSet = new Set(entry.terms);
      const matchedTerms = unique(clauseTerms.filter((term) => termSet.has(term)));
      const textSupportBonus = computeTextSupportBonus(clauseText, entry.rawText || entry.preview || entry.label, clauseTerms, entry.terms);
      return {
        entry,
        score: matchedTerms.length + textSupportBonus,
        matchedTerms,
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.label.localeCompare(right.entry.label));
}

function toSupportRefs(matches = [], limit = 2) {
  return (Array.isArray(matches) ? matches : []).slice(0, limit).map((item) => ({
    id: item.entry.id,
    sourceType: item.entry.sourceType,
    label: item.entry.label,
    preview: item.entry.preview,
    score: item.score,
    matchedTerms: (item.matchedTerms || []).slice(0, 4),
  }));
}

function createGroundingCheckTools({ summarizeText } = {}) {
  function evaluateAssistantGrounding({
    assistantText = "",
    selectedKnowledgeChunks = [],
    selectedMemoryRecords = [],
    selectedMemoryEvidence = [],
    contestedMemoryRecords = [],
  } = {}) {
    const clauses = splitAnswerClauses(assistantText);
    const knowledgeEntries = buildSupportSourceEntries(selectedKnowledgeChunks, {
      sourceType: "knowledge",
      summaryField: "text",
      summarizeText,
    });
    const memoryFactEntries = buildSupportSourceEntries(selectedMemoryRecords, {
      sourceType: "memory_fact",
      summaryField: "summary",
      summarizeText,
    });
    const memoryEvidenceEntries = buildSupportSourceEntries(selectedMemoryEvidence, {
      sourceType: "memory_evidence",
      summaryField: "text",
      summarizeText,
    });
    const contestedEntries = buildSupportSourceEntries(contestedMemoryRecords, {
      sourceType: "contested_memory",
      summaryField: "summary",
      summarizeText,
    });
    const knowledgeTerms = getSupportTerms({ text: selectedKnowledgeChunks.map((item) => item.text).join(" ") }, "text");
    const memoryFactTerms = getSupportTerms({ summary: selectedMemoryRecords.map((item) => item.summary).join(" ") });
    const memoryEvidenceTerms = getSupportTerms({ text: selectedMemoryEvidence.map((item) => item.text).join(" ") }, "text");
    const contestedTerms = getSupportTerms({ summary: contestedMemoryRecords.map((item) => item.summary).join(" ") });
    const selectedSupportTerms = new Set(unique([...knowledgeTerms, ...memoryFactTerms, ...memoryEvidenceTerms]));
    const contestedUniqueTerms = contestedTerms.filter((term) => !selectedSupportTerms.has(term));

    const supportedClauses = [];
    const unsupportedClauses = [];
    const contestedClauses = [];
    let knowledgeSupportCount = 0;
    let memoryFactSupportCount = 0;
    let memoryEvidenceSupportCount = 0;

    for (const clause of clauses) {
      const clauseTerms = extractGroundingTerms(clause);
      const atmosphericClause = isAtmosphericClause(clause);
      const knowledgeHits = scoreClauseAgainstTerms(clauseTerms, knowledgeTerms);
      const memoryFactHits = scoreClauseAgainstTerms(clauseTerms, memoryFactTerms);
      const memoryEvidenceHits = scoreClauseAgainstTerms(clauseTerms, memoryEvidenceTerms);
      const contestedHits = scoreClauseAgainstTerms(clauseTerms, contestedTerms);
      const contestedUniqueHits = scoreClauseAgainstTerms(clauseTerms, contestedUniqueTerms);
      const supportHits = knowledgeHits + memoryFactHits + memoryEvidenceHits;
      const knowledgeMatches = matchClauseAgainstSources(clause, clauseTerms, knowledgeEntries);
      const memoryFactMatches = matchClauseAgainstSources(clause, clauseTerms, memoryFactEntries);
      const memoryEvidenceMatches = matchClauseAgainstSources(clause, clauseTerms, memoryEvidenceEntries);
      const contestedMatches = matchClauseAgainstSources(clause, clauseTerms, contestedEntries);
      const supportRefs = toSupportRefs(
        [...knowledgeMatches, ...memoryFactMatches, ...memoryEvidenceMatches].sort(
          (left, right) => right.score - left.score || left.entry.label.localeCompare(right.entry.label)
        )
      );
      const contestedSupportRefs = toSupportRefs(contestedMatches);
      const strongestSupportScore = supportRefs[0]?.score || 0;
      const strongestContestedScore = contestedSupportRefs[0]?.score || 0;

      if (knowledgeHits >= 2 || knowledgeMatches[0]?.score >= 2) {
        knowledgeSupportCount += 1;
      }
      if (memoryFactHits >= 1 || memoryFactMatches[0]?.score >= 1) {
        memoryFactSupportCount += 1;
      }
      if (memoryEvidenceHits >= 1 || memoryEvidenceMatches[0]?.score >= 1) {
        memoryEvidenceSupportCount += 1;
      }

      if (
        (contestedHits >= 2 && contestedUniqueHits >= 1) ||
        (contestedHits >= 2 && contestedHits >= supportHits) ||
        (strongestContestedScore >= 2 && strongestContestedScore > strongestSupportScore)
      ) {
        contestedClauses.push({
          text: summarizeClause(clause, summarizeText),
          reasons: [
            contestedUniqueHits >= 1
              ? "Clause mentions details that appear only in contested memory"
              : "Clause overlaps more with contested memory than with selected canon support",
          ],
          supportRefs,
          contestedSupportRefs,
        });
        continue;
      }

      if (
        supportHits >= 2 ||
        memoryFactHits >= 1 ||
        memoryEvidenceHits >= 1 ||
        strongestSupportScore >= 2 ||
        (atmosphericClause && strongestSupportScore >= 1 && (memoryEvidenceMatches.length || knowledgeMatches.length))
      ) {
        supportedClauses.push({
          text: summarizeClause(clause, summarizeText),
          reasons: unique([
            knowledgeHits >= 2 ? "Supported by retrieved knowledge" : "",
            memoryFactHits >= 1 ? "Supported by selected memory facts" : "",
            memoryEvidenceHits >= 1 ? "Supported by retrieved memory evidence" : "",
            strongestSupportScore >= 2 && !(knowledgeHits >= 2 || memoryFactHits >= 1 || memoryEvidenceHits >= 1)
              ? "Supported by close text overlap with retrieved canon"
              : "",
            atmosphericClause && strongestSupportScore >= 1 && (memoryEvidenceMatches.length || knowledgeMatches.length)
              ? "Atmospheric clause stayed close to retrieved scene support"
              : "",
          ]),
          supportRefs,
          contestedSupportRefs: [],
        });
        continue;
      }

      unsupportedClauses.push({
        text: summarizeClause(clause, summarizeText),
        reasons: ["No strong memory or knowledge grounding matched this clause"],
        supportRefs,
        contestedSupportRefs,
      });
    }

    let state = "grounded";
    const notes = [];
    if (!clauses.length) {
      state = "insufficient_context";
      notes.push("The reply was too short to run a useful grounding check.");
    } else if (unsupportedClauses.length >= 2) {
      state = "risk";
      notes.push("Multiple answer clauses were not grounded in the retrieved memory or knowledge context.");
    } else if (unsupportedClauses.length >= 1 || contestedClauses.length >= 1) {
      state = "caution";
      if (unsupportedClauses.length) {
        notes.push("Part of the answer may be under-grounded.");
      }
      if (contestedClauses.length) {
        notes.push("Part of the answer may rely on contested memory.");
      }
    } else if (!supportedClauses.length && (selectedKnowledgeChunks.length || selectedMemoryRecords.length || selectedMemoryEvidence.length)) {
      state = "caution";
      notes.push("Retrieved support existed, but the answer did not clearly anchor itself to it.");
    } else {
      notes.push("The answer stayed aligned with the retrieved memory and knowledge context.");
    }

    return {
      state,
      supportedClauseCount: supportedClauses.length,
      unsupportedClauseCount: unsupportedClauses.length,
      contestedClauseCount: contestedClauses.length,
      knowledgeSupportCount,
      memoryFactSupportCount,
      memoryEvidenceSupportCount,
      supportedClauses: supportedClauses.slice(0, 3),
      unsupportedClauses: unsupportedClauses.slice(0, 3),
      contestedClauses: contestedClauses.slice(0, 3),
      notes,
    };
  }

  return {
    evaluateAssistantGrounding,
  };
}

module.exports = {
  createGroundingCheckTools,
};
