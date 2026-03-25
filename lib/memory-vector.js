const { buildEmbeddingSignature } = require("./embeddings");

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

function createLocalVectorSearchItems(options = {}) {
  const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : 0.2;
  const maxCandidates = Number.isFinite(Number(options.maxCandidates)) ? Number(options.maxCandidates) : 6;

  function getQueryEmbeddingState(searchOptions = {}) {
    const explicitVector = Array.isArray(searchOptions?.queryEmbedding) ? searchOptions.queryEmbedding : null;
    const objectVector =
      !explicitVector && Array.isArray(searchOptions?.queryEmbedding?.vector) ? searchOptions.queryEmbedding.vector : null;
    const provider = String(
      searchOptions?.queryEmbeddingProvider || searchOptions?.queryEmbedding?.provider || ""
    );
    const model = String(searchOptions?.queryEmbeddingModel || searchOptions?.queryEmbedding?.model || "");
    const signature =
      String(searchOptions?.queryEmbeddingSignature || searchOptions?.queryEmbedding?.signature || "") ||
      buildEmbeddingSignature(provider, model);
    return {
      vector: explicitVector || objectVector || null,
      provider,
      model,
      signature,
    };
  }

  function getItemEmbeddingSignature(item = {}) {
    return String(item?.embeddingSignature || "") || buildEmbeddingSignature(item?.embeddingProvider, item?.embeddingModel);
  }

  function areEmbeddingsComparable(queryState, item = {}) {
    const querySignature = String(queryState?.signature || "");
    if (!querySignature) {
      return true;
    }
    const itemSignature = getItemEmbeddingSignature(item);
    return Boolean(itemSignature) && itemSignature === querySignature;
  }

  return function vectorSearchItems({ items, options: searchOptions = {} }) {
    const queryState = getQueryEmbeddingState(searchOptions);
    const queryEmbedding = Array.isArray(queryState.vector) ? queryState.vector : null;
    if (!queryEmbedding || !queryEmbedding.length) {
      return [];
    }

    return (Array.isArray(items) ? items : [])
      .map((item) => ({
        itemId: item.id,
        embedding: Array.isArray(item?.embedding) && item.embedding.length > 0 ? item.embedding : null,
        reason:
          Array.isArray(item?.embedding) && item.embedding.length > 0 && areEmbeddingsComparable(queryState, item)
            ? `vector similarity (${String(item.embeddingModel || item.embeddingProvider || "local")})`
            : "",
      }))
      .filter((item, index) => {
        const sourceItem = Array.isArray(items) ? items[index] : null;
        return Array.isArray(item.embedding) && item.embedding.length > 0 && areEmbeddingsComparable(queryState, sourceItem);
      })
      .map((item) => ({
        itemId: item.itemId,
        score: cosineSimilarity(queryEmbedding, item.embedding),
        reason: item.reason,
      }))
      .filter((item) => item.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxCandidates);
  };
}

function createLocalVectorSearchRecords(options = {}) {
  const vectorSearchItems = createLocalVectorSearchItems(options);
  return function vectorSearchRecords({ memoryRecords, options: searchOptions = {} }) {
    return vectorSearchItems({
      items: memoryRecords,
      options: searchOptions,
    }).map((item) => ({
      recordId: item.itemId,
      score: item.score,
      reason: item.reason,
    }));
  };
}

module.exports = {
  createLocalVectorSearchItems,
  createLocalVectorSearchRecords,
};
