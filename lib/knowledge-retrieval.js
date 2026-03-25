const { createKnowledgeIndexTools } = require("./knowledge-index");
const { createKnowledgeQueryTools } = require("./knowledge-query");
const { createKnowledgeSelectionTools } = require("./knowledge-select");

function createKnowledgeRetrievalTools({
  embedText,
  embedTextDetailed,
  extractKeywords,
  loadKnowledgeChunkIndex,
  saveKnowledgeChunkIndex,
  loadKnowledgeEmbeddingCache,
  saveKnowledgeEmbeddingCache,
}) {
  const indexTools = createKnowledgeIndexTools({
    extractKeywords,
    loadKnowledgeChunkIndex,
    saveKnowledgeChunkIndex,
  });
  const queryTools = createKnowledgeQueryTools({
    extractKeywords,
  });
  const selectionTools = createKnowledgeSelectionTools({
    embedText,
    embedTextDetailed,
    extractKeywords,
    loadKnowledgeEmbeddingCache,
    saveKnowledgeEmbeddingCache,
    ensureKnowledgeChunkIndex: indexTools.ensureKnowledgeChunkIndex,
    buildKnowledgeQuery: queryTools.buildKnowledgeQuery,
    buildKnowledgeQueryText: queryTools.buildKnowledgeQueryText,
  });

  function formatKnowledgeContext(chunks) {
    return (chunks || [])
      .map(
        (item, index) =>
          `[Knowledge ${index + 1}][type=${item.sourceType}][chunk=${item.chunkType}][source=${item.sourceId}]\n${item.text}`
      )
      .join("\n\n");
  }

  return {
    ...indexTools,
    ...queryTools,
    retrieveKnowledgeChunks: selectionTools.retrieveKnowledgeChunks,
    formatKnowledgeContext,
  };
}

module.exports = {
  createKnowledgeRetrievalTools,
};
