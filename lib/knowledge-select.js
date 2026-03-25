const { normalizeText, unique } = require("./text-utils");

const VECTOR_CANDIDATE_LIMIT = 12;
const VECTOR_REASON_THRESHOLD = 0.22;
const PURE_VECTOR_THRESHOLD = 0.28;

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) {
    return 0;
  }
  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  const limit = Math.min(a.length, b.length);
  for (let index = 0; index < limit; index += 1) {
    const left = Number(a[index] || 0);
    const right = Number(b[index] || 0);
    dot += left * right;
    magnitudeA += left * left;
    magnitudeB += right * right;
  }
  if (!magnitudeA || !magnitudeB) {
    return 0;
  }
  return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

function selectUniqueKnowledgeChunks(items, maxItems) {
  const selectedChunks = [];
  const seenChunkKeys = new Set();
  for (const item of items) {
    const seenKey = String(item.id || `${item.sourceId}:${item.chunkType}:${item.sequence || 1}`);
    if (seenChunkKeys.has(seenKey)) {
      continue;
    }
    seenChunkKeys.add(seenKey);
    selectedChunks.push(item);
    if (selectedChunks.length >= Math.max(1, maxItems)) {
      break;
    }
  }
  return selectedChunks;
}

function buildLexicalSelectedChunks(lexicalScored, maxItems) {
  const sortedLexical = [...lexicalScored].sort((a, b) => b.score - a.score || a.sourceType.localeCompare(b.sourceType));
  return selectUniqueKnowledgeChunks(
    sortedLexical
      .filter((item) => item.score > 0)
      .map((item) => ({
        ...item,
        reasons: unique([
          item.entityHits.length ? `Entity match: ${item.entityHits.slice(0, 2).join(", ")}` : "",
          item.keywordHits.length ? `Keyword match: ${unique(item.keywordHits).slice(0, 3).join(", ")}` : "",
        ]),
      })),
    maxItems
  );
}

function createKnowledgeSelectionTools({
  embedText,
  embedTextDetailed,
  extractKeywords,
  loadKnowledgeEmbeddingCache,
  saveKnowledgeEmbeddingCache,
  ensureKnowledgeChunkIndex,
  buildKnowledgeQuery,
  buildKnowledgeQueryText,
}) {
  async function resolveEmbeddingResult(text, embeddingOptions = {}) {
    if (embeddingOptions.mode !== "on") {
      return {
        vector: null,
        provider: embeddingOptions.provider || "",
        model: embeddingOptions.provider === "hash_v1" ? "hash_v1" : embeddingOptions.model || "",
        fallbackUsed: false,
        error: "",
      };
    }
    if (typeof embedTextDetailed === "function") {
      return embedTextDetailed(text, embeddingOptions);
    }
    if (typeof embedText === "function") {
      return {
        vector: await embedText(text, embeddingOptions),
        provider: embeddingOptions.provider || "",
        model: embeddingOptions.provider === "hash_v1" ? "hash_v1" : embeddingOptions.model || "",
        fallbackUsed: false,
        error: "",
      };
    }
    return {
      vector: null,
      provider: embeddingOptions.provider || "",
      model: embeddingOptions.provider === "hash_v1" ? "hash_v1" : embeddingOptions.model || "",
      fallbackUsed: false,
      error: "",
    };
  }

  async function retrieveKnowledgeChunks({
    story,
    workspace,
    userMessage = "",
    messages = [],
    retrievalMode = "rag",
    embeddingOptions = {},
    maxItems = 4,
  }) {
    void retrievalMode;
    const indexState = ensureKnowledgeChunkIndex({ story, workspace });
    const chunks = indexState.chunks;
    if (!chunks.length) {
      return {
        selectedChunks: [],
        retrievalMeta: {
          mode: "rag",
          activeMode: "lexical",
          vectorEnabled: false,
          vectorCandidateCount: 0,
          vectorSelectedCount: 0,
          chunkCount: 0,
          vectorProvider: "",
          vectorFallbackUsed: false,
          vectorFailure: "",
          cachedVectorCount: 0,
          fallbackReason: "",
          indexSource: indexState.indexSource,
          indexRefreshed: indexState.indexRefreshed,
          indexVersion: indexState.indexVersion,
        },
      };
    }

    const query = buildKnowledgeQuery({ userMessage, messages, workspace });
    const queryText = buildKnowledgeQueryText(query);
    const normalizedQuery = normalizeText(queryText);
    const queryKeywords = unique([...(query.keywords || []), ...extractKeywords(queryText)]);
    const queryTerms = unique([
      ...queryKeywords,
      ...(queryText.match(/[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}/g) || []).map((item) => String(item).toLowerCase()),
    ]);
    const queryEmbeddingResult =
      embeddingOptions.mode === "on"
        ? await resolveEmbeddingResult(queryText, embeddingOptions)
        : {
            vector: null,
            provider: "",
            model: "",
            fallbackUsed: false,
            error: "",
          };
    const queryEmbedding =
      embeddingOptions.mode === "on" && Array.isArray(queryEmbeddingResult?.vector) ? queryEmbeddingResult.vector : null;
    const storyId = story?.id ? String(story.id) : "";
    const cacheDoc =
      storyId && typeof loadKnowledgeEmbeddingCache === "function" ? loadKnowledgeEmbeddingCache(storyId) || {} : {};
    const cacheEntries = cacheDoc.entries && typeof cacheDoc.entries === "object" ? cacheDoc.entries : {};
    const currentChunkMap = Object.fromEntries(chunks.map((item) => [item.id, item]));
    let cacheDirty = false;

    for (const [cacheKey, entry] of Object.entries(cacheEntries)) {
      const matchingChunk = currentChunkMap[String(entry?.chunkId || "")];
      if (!matchingChunk || String(entry?.textHash || "") !== String(matchingChunk.textHash || "")) {
        delete cacheEntries[cacheKey];
        cacheDirty = true;
      }
    }

    const lexicalScored = chunks.map((item) => {
      const keywordHits = item.keywords.filter(
        (keyword) => queryKeywords.includes(keyword) || normalizedQuery.includes(normalizeText(keyword))
      );
      const entityHits = unique(
        (item.entities || []).filter((entity) => {
          const normalizedEntity = normalizeText(entity);
          return normalizedEntity && queryTerms.some((term) => normalizedEntity.includes(term) || term.includes(normalizedEntity));
        })
      );
      const normalizedTitle = normalizeText(item.title);
      const lexicalScore =
        unique(keywordHits).length * 2.5 +
        entityHits.length * 3.5 +
        (normalizedTitle && normalizedQuery.includes(normalizedTitle) ? 2 : 0) +
        ((query.anchorHints?.characterIds || []).includes(item.sourceId) ? 1.2 : 0) +
        ((query.anchorHints?.worldbookIds || []).includes(item.sourceId) ? 1.2 : 0) +
        ((query.anchorHints?.styleIds || []).includes(item.sourceId) ? 0.8 : 0) +
        (item.chunkType === "relationships" || item.chunkType === "rules" || item.chunkType === "story_state" ? 0.8 : 0) +
        (item.sourceType === "style" ? 0.15 : 0.35);
      return {
        ...item,
        lexicalScore,
        score: lexicalScore,
        keywordHits,
        entityHits,
      };
    });

    if (!queryEmbedding) {
      if (cacheDirty && storyId && typeof saveKnowledgeEmbeddingCache === "function") {
        saveKnowledgeEmbeddingCache(storyId, {
          updatedAt: new Date().toISOString(),
          entries: cacheEntries,
        });
      }
      const selectedChunks = buildLexicalSelectedChunks(lexicalScored, maxItems);
      return {
        selectedChunks,
        retrievalMeta: {
          mode: "rag",
          activeMode: "lexical",
          vectorEnabled: false,
          vectorCandidateCount: 0,
          vectorSelectedCount: 0,
          chunkCount: chunks.length,
          vectorProvider: queryEmbeddingResult?.provider || "",
          vectorFallbackUsed: Boolean(queryEmbeddingResult?.fallbackUsed),
          vectorFailure: embeddingOptions.mode === "on" && !queryEmbedding ? queryEmbeddingResult?.error || "" : "",
          cachedVectorCount: 0,
          queryFocusCount: (query.focusClauses || []).length,
          fallbackReason:
            embeddingOptions.mode === "on"
              ? queryEmbeddingResult?.error || "Knowledge RAG embedding enhancer was unavailable for this query"
              : "Knowledge RAG fell back to lexical retrieval because local embeddings are off",
          indexSource: indexState.indexSource,
          indexRefreshed: indexState.indexRefreshed,
          indexVersion: indexState.indexVersion,
        },
        anchorHints: query.anchorHints,
      };
    }

    const scored = await Promise.all(
      lexicalScored.map(async (item) => {
        const cacheKey = `${item.id}:${embeddingOptions.provider || "transformers_local"}:${embeddingOptions.model || ""}:${item.textHash}`;
        const cachedEntry = cacheEntries[cacheKey] || null;
        const cachedEmbedding = cachedEntry?.embedding || null;
        const itemEmbeddingResult =
          queryEmbedding && !(Array.isArray(cachedEmbedding) && cachedEmbedding.length)
            ? await resolveEmbeddingResult(item.text, embeddingOptions)
            : null;
        const itemEmbedding =
          Array.isArray(cachedEmbedding) && cachedEmbedding.length
            ? cachedEmbedding
            : queryEmbedding
              ? itemEmbeddingResult?.vector
              : item.embedding;

        if (
          queryEmbedding &&
          Array.isArray(itemEmbedding) &&
          itemEmbedding.length &&
          !(Array.isArray(cachedEmbedding) && cachedEmbedding.length)
        ) {
          cacheEntries[cacheKey] = {
            chunkId: item.id,
            sourceId: item.sourceId,
            sourceType: item.sourceType,
            chunkType: item.chunkType,
            model:
              itemEmbeddingResult?.model ||
              (itemEmbeddingResult?.provider === "hash_v1" ? "hash_v1" : embeddingOptions.model || ""),
            provider: itemEmbeddingResult?.provider || embeddingOptions.provider || "transformers_local",
            requestedProvider: itemEmbeddingResult?.requestedProvider || embeddingOptions.provider || "transformers_local",
            requestedModel: itemEmbeddingResult?.requestedModel || embeddingOptions.model || "",
            fallbackUsed: Boolean(itemEmbeddingResult?.fallbackUsed),
            textHash: item.textHash,
            updatedAt: new Date().toISOString(),
            embedding: itemEmbedding,
          };
          cacheDirty = true;
        }

        const vectorScore =
          queryEmbedding && Array.isArray(itemEmbedding) && itemEmbedding.length
            ? cosineSimilarity(queryEmbedding, itemEmbedding)
            : 0;
        const hasVectorReason = vectorScore >= VECTOR_REASON_THRESHOLD;
        const isSemanticOnlyCandidate = item.lexicalScore <= 0 && vectorScore >= PURE_VECTOR_THRESHOLD;
        return {
          ...item,
          embedding: itemEmbedding || item.embedding || null,
          embeddingProvider:
            cachedEntry?.provider ||
            itemEmbeddingResult?.provider ||
            item.embeddingProvider ||
            item.embeddingModel ||
            "",
          vectorScore,
          score: vectorScore * 5 + item.lexicalScore * 0.18 + (isSemanticOnlyCandidate ? 0.35 : 0),
          reasons: unique([
            item.entityHits.length ? `Entity match: ${item.entityHits.slice(0, 2).join(", ")}` : "",
            item.keywordHits.length ? `Keyword match: ${unique(item.keywordHits).slice(0, 3).join(", ")}` : "",
            hasVectorReason ? "Local vector similarity" : "",
            isSemanticOnlyCandidate ? "Semantic-only retrieval candidate" : "",
          ]),
        };
      })
    );

    if (cacheDirty && storyId && typeof saveKnowledgeEmbeddingCache === "function") {
      saveKnowledgeEmbeddingCache(storyId, {
        updatedAt: new Date().toISOString(),
        entries: cacheEntries,
      });
    }

    const vectorCandidates = scored
      .filter((item) => item.vectorScore >= VECTOR_REASON_THRESHOLD)
      .sort((a, b) => b.vectorScore - a.vectorScore)
      .slice(0, Math.max(maxItems * 3, VECTOR_CANDIDATE_LIMIT));
    const semanticSelectedChunks = selectUniqueKnowledgeChunks(
      [...scored]
        .filter((item) => item.vectorScore >= PURE_VECTOR_THRESHOLD)
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.vectorScore - a.vectorScore ||
            b.lexicalScore - a.lexicalScore ||
            a.sourceType.localeCompare(b.sourceType)
        ),
      maxItems
    );
    const lexicalFallbackChunks =
      semanticSelectedChunks.length < Math.max(1, maxItems)
        ? buildLexicalSelectedChunks(lexicalScored, maxItems * 2).filter(
            (item) => !semanticSelectedChunks.some((selected) => selected.id === item.id)
          )
        : [];
    const selectedChunks = [
      ...semanticSelectedChunks,
      ...lexicalFallbackChunks.slice(0, Math.max(0, maxItems - semanticSelectedChunks.length)),
    ].slice(0, Math.max(1, maxItems));

    return {
      selectedChunks,
      retrievalMeta: {
        mode: "rag",
        chunkCount: chunks.length,
        activeMode: semanticSelectedChunks.length ? "rag" : "lexical",
        vectorEnabled: true,
        vectorCandidateCount: vectorCandidates.length,
        vectorSelectedCount: semanticSelectedChunks.length,
        vectorProvider: queryEmbeddingResult?.provider || "",
        vectorFallbackUsed: Boolean(queryEmbeddingResult?.fallbackUsed),
        vectorFailure: "",
        cachedVectorCount: vectorCandidates.filter((item) => {
          const cacheKey = `${item.id}:${embeddingOptions.provider || "transformers_local"}:${embeddingOptions.model || ""}:${item.textHash}`;
          return Array.isArray(cacheEntries[cacheKey]?.embedding) && cacheEntries[cacheKey].embedding.length > 0;
        }).length,
        queryFocusCount: (query.focusClauses || []).length,
        fallbackReason:
          semanticSelectedChunks.length
            ? lexicalFallbackChunks.length
              ? "Lexical fallback filled the remaining knowledge slots after semantic retrieval"
              : ""
            : "Knowledge RAG fell back to lexical retrieval for this turn",
        indexSource: indexState.indexSource,
        indexRefreshed: indexState.indexRefreshed,
        indexVersion: indexState.indexVersion,
      },
      anchorHints: {
        characterIds: unique([
          ...(query.anchorHints?.characterIds || []),
          ...selectedChunks.filter((item) => item.sourceType === "character").map((item) => item.sourceId),
        ]).slice(0, 6),
        worldbookIds: unique([
          ...(query.anchorHints?.worldbookIds || []),
          ...selectedChunks.filter((item) => item.sourceType === "worldbook").map((item) => item.sourceId),
        ]).slice(0, 6),
        styleIds: unique([
          ...(query.anchorHints?.styleIds || []),
          ...selectedChunks.filter((item) => item.sourceType === "style").map((item) => item.sourceId),
        ]).slice(0, 4),
      },
    };
  }

  return {
    retrieveKnowledgeChunks,
  };
}

module.exports = {
  createKnowledgeSelectionTools,
};
