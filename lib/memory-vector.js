function dotProduct(a, b) {
  let total = 0;
  const limit = Math.min(a.length, b.length);
  for (let index = 0; index < limit; index += 1) {
    total += Number(a[index] || 0) * Number(b[index] || 0);
  }
  return total;
}

function magnitude(values) {
  return Math.sqrt(values.reduce((total, value) => total + Number(value || 0) * Number(value || 0), 0));
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) {
    return 0;
  }
  const denominator = magnitude(a) * magnitude(b);
  if (!denominator) {
    return 0;
  }
  return dotProduct(a, b) / denominator;
}

function createLocalVectorSearchRecords(options = {}) {
  const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : 0.2;
  const maxCandidates = Number.isFinite(Number(options.maxCandidates)) ? Number(options.maxCandidates) : 6;

  return function vectorSearchRecords({ memoryRecords, options: searchOptions = {} }) {
    const queryEmbedding = Array.isArray(searchOptions.queryEmbedding) ? searchOptions.queryEmbedding : null;
    if (!queryEmbedding || !queryEmbedding.length) {
      return [];
    }

    return (Array.isArray(memoryRecords) ? memoryRecords : [])
      .map((item) => ({
        recordId: item.id,
        embedding: Array.isArray(item?.embedding) && item.embedding.length > 0 ? item.embedding : null,
        reason:
          Array.isArray(item?.embedding) && item.embedding.length > 0
            ? `vector similarity (${String(item.embeddingModel || "local")})`
            : "",
      }))
      .filter((item) => Array.isArray(item.embedding) && item.embedding.length > 0)
      .map((item) => ({
        recordId: item.recordId,
        score: cosineSimilarity(queryEmbedding, item.embedding),
        reason: item.reason,
      }))
      .filter((item) => item.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxCandidates);
  };
}

module.exports = {
  createLocalVectorSearchRecords,
};
