const { createMemoryEvidenceSelectionTools } = require("./memory-retrieval-evidence");
const { createMemoryRecordSelectionTools } = require("./memory-retrieval-records");

function createMemoryRetrievalTools({
  selectRelevantMemoryRecords,
  formatMemoryContext,
  vectorSearchRecords,
  vectorSearchItems,
  isVectorSearchEnabled = () => false,
}) {
  const recordTools = createMemoryRecordSelectionTools({
    vectorSearchRecords,
  });
  const evidenceTools = createMemoryEvidenceSelectionTools({
    vectorSearchItems,
  });

  function selectMemoryRecords(memoryRecords, options = {}) {
    const vectorEnhancementEnabled = Boolean(isVectorSearchEnabled(options));
    const maxItems = Math.max(1, Number(options.maxItems) || 4);
    const lexicalCandidateLimit = Math.max(maxItems + 2, maxItems * 2);
    const lexicalSelection = selectRelevantMemoryRecords(memoryRecords, {
      ...options,
      maxItems: lexicalCandidateLimit,
    });

    const recordSelection = recordTools.mergeRecordSelections(memoryRecords, lexicalSelection, {
      vectorEnabled: vectorEnhancementEnabled,
      maxItems,
      searchOptions: options,
    });
    const evidenceSelection = evidenceTools.selectEvidenceChunks(options.memoryChunks || [], {
      query: recordSelection.query,
      selectedRecords: recordSelection.selectedRecords,
      vectorEnabled: vectorEnhancementEnabled,
      maxItems: options.maxEvidenceItems,
      searchOptions: options,
    });
    const finalizedRecordSelection = recordTools.finalizeRecordSelection(recordSelection, evidenceSelection, maxItems);

    const evidenceSelected = evidenceSelection.selectedEvidenceChunks.length;
    const layeredFactSelection =
      Number(finalizedRecordSelection.layerMeta?.canonicalSelectedCount || 0) > 0 &&
      Number(finalizedRecordSelection.layerMeta?.recentSelectedCount || 0) > 0;
    const usedEmbedding =
      Number(recordSelection.retrievalMeta.vectorSelectedCount || 0) > 0 ||
      Number(evidenceSelection.retrievalMeta.vectorSelectedCount || 0) > 0;

    let fallbackReason = "";
    if (evidenceSelected) {
      if (!vectorEnhancementEnabled) {
        fallbackReason = "Memory RAG is active, but embedding enhancement was unavailable for this turn";
      } else if (!usedEmbedding) {
        fallbackReason = "Memory RAG stayed lexical for this turn even though embeddings were available";
      }
    } else if (layeredFactSelection) {
      fallbackReason = "Memory RAG used canon and recent fact budgets this turn, but no evidence chunk cleared the injection threshold";
    } else {
      fallbackReason = recordSelection.retrievalMeta.fallbackReason || "No memory evidence chunks were strong enough to inject this turn";
    }

    return {
      selectedRecords: finalizedRecordSelection.selectedRecords,
      reasonsById: finalizedRecordSelection.reasonsById,
      contestedRecords: finalizedRecordSelection.contestedRecords,
      contestedReasonsById: finalizedRecordSelection.contestedReasonsById,
      query: recordSelection.query,
      selectedEvidenceChunks: evidenceSelection.selectedEvidenceChunks,
      selectedEvidenceReasons: evidenceSelection.reasonsById,
      retrievalMeta: {
        mode: "rag",
        activeMode:
          evidenceSelected ||
          (Number(finalizedRecordSelection.layerMeta?.canonicalSelectedCount || 0) > 0 &&
            Number(finalizedRecordSelection.layerMeta?.recentSelectedCount || 0) > 0)
            ? "rag"
            : usedEmbedding
              ? "hybrid"
              : "lexical",
        vectorEnabled: vectorEnhancementEnabled,
        vectorCandidateCount:
          Number(recordSelection.retrievalMeta.vectorCandidateCount || 0) +
          Number(evidenceSelection.retrievalMeta.vectorCandidateCount || 0),
        vectorSelectedCount:
          Number(recordSelection.retrievalMeta.vectorSelectedCount || 0) +
          Number(evidenceSelection.retrievalMeta.vectorSelectedCount || 0),
        evidenceCandidateCount: evidenceSelection.retrievalMeta.evidenceCandidateCount || 0,
        evidenceSelectedCount: evidenceSelection.retrievalMeta.evidenceSelectedCount || 0,
        contestedCandidateCount: (finalizedRecordSelection.contestedRecords || []).length,
        canonicalCandidateCount: finalizedRecordSelection.layerMeta?.canonicalCandidateCount || 0,
        canonicalSelectedCount: finalizedRecordSelection.layerMeta?.canonicalSelectedCount || 0,
        recentCandidateCount: finalizedRecordSelection.layerMeta?.recentCandidateCount || 0,
        recentSelectedCount: finalizedRecordSelection.layerMeta?.recentSelectedCount || 0,
        canonicalBudget: finalizedRecordSelection.layerMeta?.canonicalBudget || 0,
        recentBudget: finalizedRecordSelection.layerMeta?.recentBudget || 0,
        episodicCandidateCount: evidenceSelection.retrievalMeta.episodicCandidateCount || 0,
        episodicSelectedCount: evidenceSelection.retrievalMeta.episodicSelectedCount || 0,
        supportCandidateCount: evidenceSelection.retrievalMeta.supportCandidateCount || 0,
        supportSelectedCount: evidenceSelection.retrievalMeta.supportSelectedCount || 0,
        episodicBudget: evidenceSelection.retrievalMeta.episodicBudget || 0,
        supportBudget: evidenceSelection.retrievalMeta.supportBudget || 0,
        fallbackReason,
      },
    };
  }

  return {
    formatMemoryContext,
    selectRelevantMemoryRecords: selectMemoryRecords,
  };
}

module.exports = {
  createMemoryRetrievalTools,
};
