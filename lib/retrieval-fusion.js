const { extractSearchTerms } = require("./text-utils");

function extractFusionTerms(text) {
  return extractSearchTerms(text, { maxItems: 48 });
}

function computeOverlapCount(queryTerms = [], sourceTerms = []) {
  if (!queryTerms.length || !sourceTerms.length) {
    return 0;
  }
  const sourceSet = new Set(sourceTerms);
  return queryTerms.filter((term) => sourceSet.has(term)).length;
}

function getFusionBudget(maxTokens) {
  const limit = Number(maxTokens) || 0;
  if (limit <= 6000) {
    return 5;
  }
  if (limit <= 16000) {
    return 7;
  }
  if (limit <= 40000) {
    return 9;
  }
  return 11;
}

function buildFamilyBudgets(route, totalBudget, counts) {
  let knowledgeBudget = 0;
  let memoryBudget = 0;

  if (route === "knowledge_heavy") {
    knowledgeBudget = Math.min(counts.knowledge, Math.max(3, Math.ceil(totalBudget * 0.65)));
    memoryBudget = Math.min(counts.memory, Math.max(0, totalBudget - knowledgeBudget));
  } else if (route === "memory_heavy") {
    memoryBudget = Math.min(counts.memory, Math.max(3, Math.ceil(totalBudget * 0.65)));
    knowledgeBudget = Math.min(counts.knowledge, Math.max(0, totalBudget - memoryBudget));
  } else {
    knowledgeBudget = Math.min(counts.knowledge, Math.ceil(totalBudget / 2));
    memoryBudget = Math.min(counts.memory, Math.max(0, totalBudget - knowledgeBudget));
  }

  let remaining = totalBudget - knowledgeBudget - memoryBudget;
  if (remaining > 0 && counts.knowledge > knowledgeBudget) {
    const extraKnowledge = Math.min(remaining, counts.knowledge - knowledgeBudget);
    knowledgeBudget += extraKnowledge;
    remaining -= extraKnowledge;
  }
  if (remaining > 0 && counts.memory > memoryBudget) {
    memoryBudget += Math.min(remaining, counts.memory - memoryBudget);
  }

  let factBudget = counts.memoryFacts ? Math.min(counts.memoryFacts, Math.max(1, Math.ceil(memoryBudget * 0.6))) : 0;
  let evidenceBudget = counts.memoryEvidence
    ? Math.min(counts.memoryEvidence, Math.max(0, memoryBudget - factBudget))
    : 0;
  let memoryRemaining = memoryBudget - factBudget - evidenceBudget;
  if (memoryRemaining > 0 && counts.memoryFacts > factBudget) {
    const extraFacts = Math.min(memoryRemaining, counts.memoryFacts - factBudget);
    factBudget += extraFacts;
    memoryRemaining -= extraFacts;
  }
  if (memoryRemaining > 0 && counts.memoryEvidence > evidenceBudget) {
    evidenceBudget += Math.min(memoryRemaining, counts.memoryEvidence - evidenceBudget);
  }

  return {
    totalBudget,
    knowledgeBudget,
    memoryBudget,
    factBudget,
    evidenceBudget,
  };
}

function computeReasonBoost(reasons = []) {
  const rows = Array.isArray(reasons) ? reasons.map((item) => String(item || "").toLowerCase()) : [];
  let boost = 0;
  if (rows.some((item) => item.includes("entity match") || item.includes("primary turn focus"))) {
    boost += 1.2;
  }
  if (rows.some((item) => item.includes("keyword match") || item.includes("focus match"))) {
    boost += 0.7;
  }
  if (rows.some((item) => item.includes("vector") || item.includes("semantic"))) {
    boost += 0.9;
  }
  if (rows.some((item) => item.includes("linked to"))) {
    boost += 0.5;
  }
  return boost;
}

function buildMemoryFactCandidate(item, reasons, routeBoost, index) {
  const importanceBoost = item.importance === "high" ? 1.2 : item.importance === "medium" ? 0.6 : 0;
  const stabilityBoost = item.tier === "long_term" || item.stability === "stable" ? 1.4 : 0.4;
  return {
    family: "memory_fact",
    type: "memory_fact",
    id: item.id,
    item,
    reasons,
    terms: extractFusionTerms(
      [
        item.summary,
        ...(item.subjectIds || []),
        ...(item.tags || []),
        ...(item.keywords || []),
        ...(item.entities || []),
      ].join(" ")
    ),
    diversityKey: String(item.canonKey || item.conflictGroup || item.id),
    baseScore: 3.6 + importanceBoost + stabilityBoost + (Number(item.confidence) || 0.6) + routeBoost - index * 0.04,
  };
}

function buildMemoryEvidenceCandidate(item, reasons, routeBoost, index) {
  const linkedBoost = item.linkedRecordId ? 1.1 : 0.4;
  return {
    family: "memory_evidence",
    type: "memory_evidence",
    id: item.id,
    item,
    reasons,
    terms: extractFusionTerms(
      [
        item.text,
        ...(item.subjectIds || []),
        ...(item.tags || []),
        ...(item.keywords || []),
        ...(item.entities || []),
      ].join(" ")
    ),
    diversityKey: String(item.linkedRecordId || item.conflictGroup || item.id),
    baseScore: 3.1 + linkedBoost + (Number(item.confidence) || 0.55) + routeBoost - index * 0.04,
  };
}

function buildKnowledgeCandidate(item, reasons, routeBoost, index) {
  const chunkBoost =
    item.chunkType === "rules" || item.chunkType === "story_state" || item.chunkType === "relationships"
      ? 1.3
      : item.chunkType === "content" || item.chunkType === "notes"
        ? 0.8
        : 0.5;
  const sourceBoost = item.sourceType === "worldbook" ? 1.0 : item.sourceType === "character" ? 0.8 : 0.4;
  return {
    family: "knowledge",
    type: "knowledge",
    id: item.id,
    item,
    reasons,
    terms: extractFusionTerms(
      [item.text, item.title, item.sourceId, ...(item.entities || []), ...(item.keywords || [])].join(" ")
    ),
    diversityKey: String(item.sourceId || item.id),
    baseScore: 2.8 + chunkBoost + sourceBoost + routeBoost - index * 0.04,
  };
}

function scoreCandidate(candidate, queryTerms) {
  const overlap = computeOverlapCount(queryTerms, candidate.terms);
  const reasonBoost = computeReasonBoost(candidate.reasons);
  return {
    ...candidate,
    overlap,
    score: candidate.baseScore + overlap * 1.7 + reasonBoost,
  };
}

function selectDiverseCandidates(candidates, limit, initialSeenKeys = []) {
  const selected = [];
  const seenKeys = new Set((Array.isArray(initialSeenKeys) ? initialSeenKeys : []).map((item) => String(item)));
  for (const candidate of candidates) {
    if (selected.length >= limit) {
      break;
    }
    const diversityKey = String(candidate.diversityKey || candidate.id);
    if (seenKeys.has(diversityKey)) {
      continue;
    }
    seenKeys.add(diversityKey);
    selected.push(candidate);
  }
  return selected;
}

function buildJointRetrievalFusion({
  queryText = "",
  retrievalPlan = {},
  maxTokens = 0,
  memoryRecords = [],
  memoryReasonsById = {},
  memoryEvidence = [],
  memoryEvidenceReasonsById = {},
  knowledgeChunks = [],
}) {
  const route = retrievalPlan.route || "balanced";
  const queryTerms = extractFusionTerms(queryText);
  const routeBoostByFamily = {
    memory_fact: route === "memory_heavy" ? 1.0 : route === "knowledge_heavy" ? -0.1 : 0.4,
    memory_evidence: route === "memory_heavy" ? 1.1 : route === "knowledge_heavy" ? -0.2 : 0.5,
    knowledge: route === "knowledge_heavy" ? 1.0 : route === "memory_heavy" ? -0.2 : 0.5,
  };

  const factCandidates = (Array.isArray(memoryRecords) ? memoryRecords : [])
    .map((item, index) =>
      buildMemoryFactCandidate(item, memoryReasonsById?.[item.id] || [], routeBoostByFamily.memory_fact, index)
    )
    .map((item) => scoreCandidate(item, queryTerms))
    .sort((a, b) => b.score - a.score);

  const evidenceCandidates = (Array.isArray(memoryEvidence) ? memoryEvidence : [])
    .map((item, index) =>
      buildMemoryEvidenceCandidate(
        item,
        memoryEvidenceReasonsById?.[item.id] || [],
        routeBoostByFamily.memory_evidence,
        index
      )
    )
    .map((item) => scoreCandidate(item, queryTerms))
    .sort((a, b) => b.score - a.score);

  const knowledgeCandidates = (Array.isArray(knowledgeChunks) ? knowledgeChunks : [])
    .map((item, index) => buildKnowledgeCandidate(item, item.reasons || [], routeBoostByFamily.knowledge, index))
    .map((item) => scoreCandidate(item, queryTerms))
    .sort((a, b) => b.score - a.score);

  const counts = {
    memoryFacts: factCandidates.length,
    memoryEvidence: evidenceCandidates.length,
    memory: factCandidates.length + evidenceCandidates.length,
    knowledge: knowledgeCandidates.length,
  };
  const totalCandidateCount = counts.memory + counts.knowledge;
  const totalBudget = Math.min(totalCandidateCount, getFusionBudget(maxTokens));
  const familyBudgets = buildFamilyBudgets(route, totalBudget, counts);

  const selectedFacts = selectDiverseCandidates(factCandidates, familyBudgets.factBudget);
  const selectedEvidence = selectDiverseCandidates(evidenceCandidates, familyBudgets.evidenceBudget);
  const selectedKnowledge = selectDiverseCandidates(knowledgeCandidates, familyBudgets.knowledgeBudget);
  const selectedIds = new Set([
    ...selectedFacts.map((item) => item.id),
    ...selectedEvidence.map((item) => item.id),
    ...selectedKnowledge.map((item) => item.id),
  ]);

  const remainingBudget =
    familyBudgets.totalBudget - selectedFacts.length - selectedEvidence.length - selectedKnowledge.length;
  const remainingCandidates = [...factCandidates, ...evidenceCandidates, ...knowledgeCandidates]
    .filter((item) => !selectedIds.has(item.id))
    .sort((a, b) => b.score - a.score);
  const fillCandidates = selectDiverseCandidates(
    remainingCandidates,
    Math.max(0, remainingBudget),
    [...selectedFacts, ...selectedEvidence, ...selectedKnowledge].map((item) => item.diversityKey)
  );

  const finalCandidates = [...selectedFacts, ...selectedEvidence, ...selectedKnowledge, ...fillCandidates].sort(
    (a, b) => b.score - a.score
  );

  const annotateItem = (candidate) => ({
    ...candidate.item,
    fusionScore: Number(candidate.score.toFixed(3)),
    fusionOverlap: candidate.overlap,
    fusionFamily: candidate.family,
  });

  return {
    selectedMemoryRecords: finalCandidates.filter((item) => item.family === "memory_fact").map(annotateItem),
    selectedMemoryEvidence: finalCandidates.filter((item) => item.family === "memory_evidence").map(annotateItem),
    selectedKnowledgeChunks: finalCandidates.filter((item) => item.family === "knowledge").map(annotateItem),
    fusionMeta: {
      route,
      totalBudget: familyBudgets.totalBudget,
      totalCandidateCount,
      totalSelectedCount: finalCandidates.length,
      candidateCounts: {
        memoryFacts: counts.memoryFacts,
        memoryEvidence: counts.memoryEvidence,
        knowledge: counts.knowledge,
      },
      selectedCounts: {
        memoryFacts: finalCandidates.filter((item) => item.family === "memory_fact").length,
        memoryEvidence: finalCandidates.filter((item) => item.family === "memory_evidence").length,
        knowledge: finalCandidates.filter((item) => item.family === "knowledge").length,
      },
      familyBudgets,
      topSources: finalCandidates.slice(0, 6).map((item) => ({
        id: item.id,
        family: item.family,
        score: Number(item.score.toFixed(3)),
        overlap: item.overlap,
      })),
    },
  };
}

module.exports = {
  buildJointRetrievalFusion,
};
