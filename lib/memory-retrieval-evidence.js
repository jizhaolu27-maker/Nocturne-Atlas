const {
  buildEvidenceLayerBudgets,
  buildQueryLexicalTermSet,
  clampScore,
  computeRecencyScore,
  extendNovelRankedItems,
  flattenTerms,
  getEvidenceDiversityKey,
  isEpisodicEvidenceChunk,
  normalizeVectorMatches,
  selectNovelRankedItems,
} = require("./memory-retrieval-helpers");
const { normalizeText, selectDiagnosticTerms, unique } = require("./text-utils");

function getChunkTerms(chunk) {
  return {
    subjects: unique([...(chunk?.subjectIds || []), ...(chunk?.objectIds || [])].map(normalizeText)).filter(Boolean),
    entities: unique((chunk?.entities || []).map(normalizeText)).filter(Boolean),
    tags: unique((chunk?.tags || []).map(normalizeText)).filter(Boolean),
    keywords: unique((chunk?.keywords || []).map(normalizeText)).filter(Boolean),
  };
}

function scoreEvidenceChunk(chunk, query, selectedRecordIds = new Set()) {
  const terms = getChunkTerms(chunk);
  const queryTerms = buildQueryLexicalTermSet(query);
  const primaryEntityIds = new Set((query?.primaryMatchedEntityIds || []).map((item) => normalizeText(item)).filter(Boolean));
  const matchedEntityIds = new Set((query?.matchedEntityIds || []).map((item) => normalizeText(item)).filter(Boolean));
  const primaryWorkspaceTerms = new Set(
    (query?.primaryMatchedWorkspaceTerms || []).map((item) => normalizeText(item)).filter(Boolean)
  );
  let score = 0;
  const reasons = [];

  const primarySubjectHits = unique(terms.subjects.filter((term) => primaryEntityIds.has(term)));
  const secondarySubjectHits = unique(
    terms.subjects.filter((term) => !primaryEntityIds.has(term) && matchedEntityIds.has(term))
  );
  if (primarySubjectHits.length) {
    score += primarySubjectHits.length * 10;
    reasons.push(`Primary subjects: ${primarySubjectHits.slice(0, 2).join(", ")}`);
  }
  if (secondarySubjectHits.length) {
    score += secondarySubjectHits.length * 4;
    reasons.push(`Context subjects: ${secondarySubjectHits.slice(0, 2).join(", ")}`);
  }

  const primaryEntityHits = unique(
    terms.entities.filter((term) => term && (query.rawText?.includes(term) || primaryWorkspaceTerms.has(term)))
  );
  const secondaryEntityHits = unique(
    terms.entities.filter(
      (term) =>
        term &&
        !primaryWorkspaceTerms.has(term) &&
        (query.rawText?.includes(term) || (query.matchedWorkspaceTerms || []).includes(term))
    )
  );
  if (primaryEntityHits.length) {
    score += primaryEntityHits.length * 6;
    reasons.push(`Primary entities: ${primaryEntityHits.slice(0, 2).join(", ")}`);
  }
  if (secondaryEntityHits.length) {
    score += secondaryEntityHits.length * 3;
    reasons.push(`Context entities: ${secondaryEntityHits.slice(0, 2).join(", ")}`);
  }

  const tagHits = unique(terms.tags.filter((term) => queryTerms.has(term)));
  if (tagHits.length) {
    score += tagHits.length * 4;
    reasons.push(`Matched tags: ${tagHits.slice(0, 2).join(", ")}`);
  }

  const keywordHits = unique(terms.keywords.filter((term) => queryTerms.has(term)));
  const readableKeywordHits = selectDiagnosticTerms(keywordHits, 3);
  if (keywordHits.length) {
    score += keywordHits.length * 3;
  }
  if (readableKeywordHits.length) {
    reasons.push(`Matched keywords: ${readableKeywordHits.join(", ")}`);
  }

  if (selectedRecordIds.has(String(chunk?.linkedRecordId || ""))) {
    score += 3;
    reasons.push("Linked to a selected memory fact");
  }

  if ((query?.primaryMatchedEntityScopes || []).includes(chunk?.scope)) {
    score += 3;
    reasons.push("Primary-scope aligned");
  } else if (query.matchedEntityScopes?.includes(chunk?.scope)) {
    score += 2;
    reasons.push("Scope-aligned");
  }

  if (chunk?.importance === "high") {
    score += 2;
    reasons.push("High importance");
  }

  if (chunk?.stability === "stable") {
    score += 1;
    reasons.push("Stable canon");
  }

  if (chunk?.sourceRole === "assistant") {
    score += 1;
    reasons.push("Assistant-side evidence");
  }

  return {
    chunk,
    score,
    reasons: unique(reasons),
  };
}

function createMemoryEvidenceSelectionTools({ vectorSearchItems }) {
  function selectEvidenceChunks(memoryChunks, options = {}) {
    const chunks = Array.isArray(memoryChunks) ? memoryChunks : [];
    const requestedMaxItems = Number(options.maxItems);
    const maxItems = Number.isFinite(requestedMaxItems) ? Math.max(0, requestedMaxItems) : 3;
    if (maxItems <= 0) {
      return {
        selectedEvidenceChunks: [],
        reasonsById: {},
        selectedItems: [],
        retrievalMeta: {
          evidenceCandidateCount: 0,
          evidenceSelectedCount: 0,
          vectorCandidateCount: 0,
          vectorSelectedCount: 0,
          episodicCandidateCount: 0,
          episodicSelectedCount: 0,
          supportCandidateCount: 0,
          supportSelectedCount: 0,
          episodicBudget: 0,
          supportBudget: 0,
        },
      };
    }
    if (!chunks.length) {
      return {
        selectedEvidenceChunks: [],
        reasonsById: {},
        selectedItems: [],
        retrievalMeta: {
          evidenceCandidateCount: 0,
          evidenceSelectedCount: 0,
          vectorCandidateCount: 0,
          vectorSelectedCount: 0,
          episodicCandidateCount: 0,
          episodicSelectedCount: 0,
          supportCandidateCount: 0,
          supportSelectedCount: 0,
          episodicBudget: 0,
          supportBudget: 0,
        },
      };
    }

    const query = options.query || {};
    const selectedRecordIds = new Set((options.selectedRecords || []).map((item) => String(item?.id || "")));
    const lexicalCandidates = chunks.map((chunk) => scoreEvidenceChunk(chunk, query, selectedRecordIds)).filter((item) => item.score > 0);

    const vectorEnabled = Boolean(options.vectorEnabled) && typeof vectorSearchItems === "function";
    const vectorMatches = vectorEnabled
      ? normalizeVectorMatches(
          vectorSearchItems({
            items: chunks,
            options: options.searchOptions || {},
          }),
          "itemId"
        )
      : [];

    const merged = new Map();
    for (const item of lexicalCandidates) {
      merged.set(item.chunk.id, {
        chunk: item.chunk,
        lexicalScore: item.score,
        vectorScore: 0,
        reasons: [...item.reasons],
      });
    }

    for (const match of vectorMatches) {
      const chunk = chunks.find((item) => item.id === match.id);
      if (!chunk) {
        continue;
      }
      const existing = merged.get(match.id) || {
        chunk,
        lexicalScore: 0,
        vectorScore: 0,
        reasons: [],
      };
      existing.vectorScore = Math.max(existing.vectorScore, match.score);
      if (!existing.reasons.includes(match.reason)) {
        existing.reasons.push(match.reason);
      }
      if (existing.lexicalScore === 0 && match.score >= 0.45) {
        existing.reasons.push("Semantic-only retrieval candidate");
      }
      merged.set(match.id, existing);
    }

    const timestamps = Array.from(merged.values())
      .map((item) => Date.parse(item.chunk?.createdAt || ""))
      .filter(Number.isFinite);
    const newestTimestamp = timestamps.length ? Math.max(...timestamps) : NaN;
    const oldestTimestamp = timestamps.length ? Math.min(...timestamps) : NaN;
    const maxLexicalScore = Math.max(1, ...Array.from(merged.values()).map((item) => Number(item.lexicalScore) || 0));

    const ranked = Array.from(merged.values())
      .filter((item) => item.lexicalScore > 0 || item.vectorScore >= 0.45)
      .map((item) => ({
        ...item,
        lexicalScoreNormalized: clampScore((Number(item.lexicalScore) || 0) / maxLexicalScore),
        confidenceScore: clampScore(item.chunk?.confidence ?? 0.6),
        stabilityScore: item.chunk?.stability === "stable" || item.chunk?.importance === "high" ? 1 : 0,
        recencyScore: computeRecencyScore(item.chunk?.createdAt, newestTimestamp, oldestTimestamp),
        linkedFactScore: selectedRecordIds.has(String(item.chunk?.linkedRecordId || "")) ? 1 : 0,
        finalScore:
          clampScore((Number(item.lexicalScore) || 0) / maxLexicalScore) * 0.38 +
          item.vectorScore * 0.3 +
          clampScore(item.chunk?.confidence ?? 0.6) * 0.14 +
          (item.chunk?.stability === "stable" || item.chunk?.importance === "high" ? 1 : 0) * 0.06 +
          computeRecencyScore(item.chunk?.createdAt, newestTimestamp, oldestTimestamp) * 0.04 +
          (selectedRecordIds.has(String(item.chunk?.linkedRecordId || "")) ? 1 : 0) * 0.08,
      }))
      .sort((a, b) => b.finalScore - a.finalScore || String(b.chunk.createdAt || "").localeCompare(String(a.chunk.createdAt || "")));

    const layerBudgets = buildEvidenceLayerBudgets(ranked, maxItems);
    let selected = [];
    if (maxItems <= 1) {
      selected = selectNovelRankedItems(
        ranked,
        maxItems,
        (item) => getEvidenceDiversityKey(item.chunk),
        (item) => flattenTerms(getChunkTerms(item.chunk))
      );
    } else {
      const episodicRanked = ranked.filter((item) => isEpisodicEvidenceChunk(item.chunk));
      const supportRanked = ranked.filter((item) => !isEpisodicEvidenceChunk(item.chunk));
      selected = extendNovelRankedItems(
        selected,
        episodicRanked,
        layerBudgets.episodicBudget,
        (item) => getEvidenceDiversityKey(item.chunk),
        (item) => flattenTerms(getChunkTerms(item.chunk))
      );
      selected = extendNovelRankedItems(
        selected,
        supportRanked,
        Math.min(maxItems, selected.length + layerBudgets.supportBudget),
        (item) => getEvidenceDiversityKey(item.chunk),
        (item) => flattenTerms(getChunkTerms(item.chunk))
      );
      selected = extendNovelRankedItems(
        selected,
        ranked,
        maxItems,
        (item) => getEvidenceDiversityKey(item.chunk),
        (item) => flattenTerms(getChunkTerms(item.chunk))
      );
    }
    const episodicSelectedCount = selected.filter((item) => isEpisodicEvidenceChunk(item.chunk)).length;
    const supportSelectedCount = selected.length - episodicSelectedCount;
    return {
      selectedEvidenceChunks: selected.map((item) => item.chunk),
      reasonsById: Object.fromEntries(selected.map((item) => [item.chunk.id, unique(item.reasons)])),
      selectedItems: selected,
      retrievalMeta: {
        evidenceCandidateCount: merged.size,
        evidenceSelectedCount: selected.length,
        vectorCandidateCount: vectorMatches.length,
        vectorSelectedCount: selected.filter((item) => item.vectorScore > 0).length,
        episodicCandidateCount: layerBudgets.episodicCandidateCount,
        episodicSelectedCount,
        supportCandidateCount: layerBudgets.supportCandidateCount,
        supportSelectedCount,
        episodicBudget: layerBudgets.episodicBudget,
        supportBudget: layerBudgets.supportBudget,
      },
    };
  }

  return {
    selectEvidenceChunks,
  };
}

module.exports = {
  createMemoryEvidenceSelectionTools,
};
