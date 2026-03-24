function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item != null && item !== "").map((item) => String(item));
  }
  if (typeof value === "string") {
    return value
      .split(/[;,\uFF0C\u3001]/)
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

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) {
    return 0;
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const limit = Math.min(a.length, b.length);
  for (let index = 0; index < limit; index += 1) {
    const left = Number(a[index] || 0);
    const right = Number(b[index] || 0);
    dot += left * right;
    magA += left * left;
    magB += right * right;
  }
  if (!magA || !magB) {
    return 0;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function createKnowledgeChunk({ id, sourceType, sourceId, title, chunkType, text, extractKeywords, entities = [] }) {
  const normalizedText = String(text || "").trim();
  return {
    id,
    sourceType,
    sourceId,
    title,
    chunkType,
    text: normalizedText,
    keywords: unique(extractKeywords(normalizedText)),
    entities: unique([title, sourceId, ...entities]),
    embedding: null,
  };
}

const crypto = require("crypto");

function hashText(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex");
}

function createKnowledgeRetrievalTools({
  embedText,
  embedTextDetailed,
  extractKeywords,
  loadKnowledgeEmbeddingCache,
  saveKnowledgeEmbeddingCache,
}) {
  const VECTOR_CANDIDATE_LIMIT = 12;
  const VECTOR_REASON_THRESHOLD = 0.22;
  const PURE_VECTOR_THRESHOLD = 0.28;

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

  function buildKnowledgeChunks(workspace = {}) {
    const chunks = [];

    for (const item of workspace.characters || []) {
      const sourceId = item.id || item.name || `character_${chunks.length}`;
      const title = item.name || item.id || "Character";
      const traits = normalizeStringList(item.traits);
      const relationshipEntries = Object.entries(item.relationships || {});
      const relationshipNames = relationshipEntries.map(([name]) => name);

      chunks.push(
        createKnowledgeChunk({
          id: `knowledge_character_identity_${sourceId}`,
          sourceType: "character",
          sourceId,
          title,
          chunkType: "identity",
          text: [
            `Character: ${title}`,
            `Role: ${item.core?.role || ""}`,
            `Background: ${item.core?.background || ""}`,
          ]
            .filter(Boolean)
            .join("\n"),
          extractKeywords,
          entities: [title, ...traits],
        })
      );

      if (traits.length) {
        chunks.push(
          createKnowledgeChunk({
            id: `knowledge_character_traits_${sourceId}`,
            sourceType: "character",
            sourceId,
            title,
            chunkType: "traits",
            text: [`Character: ${title}`, `Traits: ${traits.join(", ")}`].join("\n"),
            extractKeywords,
            entities: [title, ...traits],
          })
        );
      }

      if (item.arcState?.current) {
        chunks.push(
          createKnowledgeChunk({
            id: `knowledge_character_arc_${sourceId}`,
            sourceType: "character",
            sourceId,
            title,
            chunkType: "arc",
            text: [`Character: ${title}`, `Arc: ${item.arcState.current}`].join("\n"),
            extractKeywords,
            entities: [title],
          })
        );
      }

      if (relationshipEntries.length) {
        chunks.push(
          createKnowledgeChunk({
            id: `knowledge_character_relationships_${sourceId}`,
            sourceType: "character",
            sourceId,
            title,
            chunkType: "relationships",
            text: [
              `Character: ${title}`,
              `Relationships: ${relationshipEntries.map(([name, value]) => `${name}=${value}`).join(", ")}`,
            ].join("\n"),
            extractKeywords,
            entities: [title, ...relationshipNames],
          })
        );
      }

      if (item.notes) {
        chunks.push(
          createKnowledgeChunk({
            id: `knowledge_character_notes_${sourceId}`,
            sourceType: "character",
            sourceId,
            title,
            chunkType: "notes",
            text: [`Character: ${title}`, `Notes: ${item.notes}`].join("\n"),
            extractKeywords,
            entities: [title],
          })
        );
      }
    }

    for (const item of workspace.worldbooks || []) {
      const sourceId = item.id || item.title || `world_${chunks.length}`;
      const title = item.title || item.id || "Worldbook";
      const rules = normalizeStringList(item.rules);
      const revealedFacts = normalizeStringList(item.revealedFacts);

      chunks.push(
        createKnowledgeChunk({
          id: `knowledge_world_identity_${sourceId}`,
          sourceType: "worldbook",
          sourceId,
          title,
          chunkType: "identity",
          text: [`World: ${title}`, `Category: ${item.category || ""}`].filter(Boolean).join("\n"),
          extractKeywords,
          entities: [title, item.category].filter(Boolean),
        })
      );

      if (rules.length) {
        chunks.push(
          createKnowledgeChunk({
            id: `knowledge_world_rules_${sourceId}`,
            sourceType: "worldbook",
            sourceId,
            title,
            chunkType: "rules",
            text: [`World: ${title}`, `Rules: ${rules.join("; ")}`].join("\n"),
            extractKeywords,
            entities: [title],
          })
        );
      }

      if (item.storyState) {
        chunks.push(
          createKnowledgeChunk({
            id: `knowledge_world_state_${sourceId}`,
            sourceType: "worldbook",
            sourceId,
            title,
            chunkType: "story_state",
            text: [`World: ${title}`, `Story State: ${item.storyState}`].join("\n"),
            extractKeywords,
            entities: [title],
          })
        );
      }

      if (item.content) {
        chunks.push(
          createKnowledgeChunk({
            id: `knowledge_world_content_${sourceId}`,
            sourceType: "worldbook",
            sourceId,
            title,
            chunkType: "content",
            text: [`World: ${title}`, `Content: ${item.content}`].join("\n"),
            extractKeywords,
            entities: [title],
          })
        );
      }

      if (revealedFacts.length) {
        chunks.push(
          createKnowledgeChunk({
            id: `knowledge_world_revealed_${sourceId}`,
            sourceType: "worldbook",
            sourceId,
            title,
            chunkType: "revealed",
            text: [`World: ${title}`, `Revealed: ${revealedFacts.join("; ")}`].join("\n"),
            extractKeywords,
            entities: [title],
          })
        );
      }
    }

    for (const item of workspace.styles || []) {
      const sourceId = item.id || item.name || `style_${chunks.length}`;
      const title = item.name || item.id || "Style";
      chunks.push(
        createKnowledgeChunk({
          id: `knowledge_style_${sourceId}`,
          sourceType: "style",
          sourceId,
          title,
          chunkType: "style_profile",
          text: [
            `Style: ${title}`,
            `Tone: ${item.tone || ""}`,
            `Voice: ${item.voice || ""}`,
            `Pacing: ${item.pacing || ""}`,
            `Dos: ${normalizeStringList(item.dos).join(", ")}`,
            `Donts: ${normalizeStringList(item.donts).join(", ")}`,
          ]
            .filter(Boolean)
            .join("\n"),
          extractKeywords,
          entities: [title, item.tone, item.voice].filter(Boolean),
        })
      );
    }

    return chunks;
  }

  function buildKnowledgeQueryText({ userMessage = "", messages = [] }) {
    const history = messages
      .slice(-4)
      .map((item) => `${item.role}: ${item.content}`)
      .join("\n");
    return [userMessage, history].filter(Boolean).join("\n");
  }

  async function retrieveKnowledgeChunks({
    story,
    workspace,
    userMessage = "",
    messages = [],
    retrievalMode = "lexical",
    embeddingOptions = {},
    maxItems = 4,
  }) {
    const chunks = buildKnowledgeChunks(workspace);
    const requestedMode = retrievalMode === "hybrid" ? "hybrid" : "lexical";
    if (!chunks.length) {
      return {
        selectedChunks: [],
        retrievalMeta: {
          mode: requestedMode,
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
        },
      };
    }

    const queryText = buildKnowledgeQueryText({ userMessage, messages });
    const normalizedQuery = normalizeText(queryText);
    const queryKeywords = extractKeywords(queryText);
    const queryTerms = unique([
      ...queryKeywords,
      ...(queryText.match(/[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}/g) || []).map((item) => String(item).toLowerCase()),
    ]);
    const queryEmbeddingResult =
      requestedMode === "hybrid"
        ? await resolveEmbeddingResult(queryText, embeddingOptions)
        : {
            vector: null,
            provider: "",
            model: "",
            fallbackUsed: false,
            error: "",
          };
    const queryEmbedding = requestedMode === "hybrid" && Array.isArray(queryEmbeddingResult?.vector) ? queryEmbeddingResult.vector : null;
    const storyId = story?.id ? String(story.id) : "";
    const cacheDoc =
      storyId && typeof loadKnowledgeEmbeddingCache === "function"
        ? loadKnowledgeEmbeddingCache(storyId) || {}
        : {};
    const cacheEntries = cacheDoc.entries && typeof cacheDoc.entries === "object" ? cacheDoc.entries : {};
    let cacheDirty = false;

    const lexicalScored = chunks.map((item) => {
      const keywordHits = item.keywords.filter(
        (keyword) => queryKeywords.includes(keyword) || normalizedQuery.includes(normalizeText(keyword))
      );
      const entityHits = unique(
        (item.entities || []).filter((entity) => {
          const normalizedEntity = normalizeText(entity);
          return queryTerms.some((term) => normalizedEntity.includes(term) || term.includes(normalizedEntity));
        })
      );
      const lexicalScore =
        unique(keywordHits).length * 2.5 +
        entityHits.length * 3.5 +
        (normalizedQuery.includes(normalizeText(item.title)) ? 2 : 0) +
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

    if (requestedMode !== "hybrid" || !queryEmbedding) {
      const sortedLexical = lexicalScored.sort((a, b) => b.score - a.score || a.sourceType.localeCompare(b.sourceType));
      const selectedChunks = [];
      const seenChunkKeys = new Set();
      for (const item of sortedLexical) {
        if (item.score <= 0) {
          continue;
        }
        const seenKey = `${item.sourceId}:${item.chunkType}`;
        if (seenChunkKeys.has(seenKey)) {
          continue;
        }
        seenChunkKeys.add(seenKey);
        selectedChunks.push({
          ...item,
          reasons: unique([
            item.entityHits.length ? `Entity match: ${item.entityHits.slice(0, 2).join(", ")}` : "",
            item.keywordHits.length ? `Keyword match: ${unique(item.keywordHits).slice(0, 3).join(", ")}` : "",
          ]),
        });
        if (selectedChunks.length >= Math.max(1, maxItems)) {
          break;
        }
      }
      return {
        selectedChunks,
        retrievalMeta: {
          mode: requestedMode,
          activeMode: "lexical",
          vectorEnabled: false,
          vectorCandidateCount: 0,
          vectorSelectedCount: 0,
          chunkCount: chunks.length,
          vectorProvider: requestedMode === "hybrid" ? queryEmbeddingResult?.provider || "" : "",
          vectorFallbackUsed: Boolean(queryEmbeddingResult?.fallbackUsed),
          vectorFailure: requestedMode === "hybrid" && !queryEmbedding ? queryEmbeddingResult?.error || "" : "",
          cachedVectorCount: 0,
          fallbackReason:
            requestedMode === "hybrid" && !queryEmbedding
              ? queryEmbeddingResult?.error || "Vector enhancer unavailable for this query"
              : "",
        },
      };
    }

    const scored = await Promise.all(
      lexicalScored.map(async (item) => {
        const cacheKey = `${item.id}:${embeddingOptions.provider || "transformers_local"}:${embeddingOptions.model || ""}:${hashText(item.text)}`;
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
            textHash: hashText(item.text),
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
          score: item.lexicalScore + vectorScore * 4.5 + (isSemanticOnlyCandidate ? 0.35 : 0),
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

    const sorted = scored.sort((a, b) => b.score - a.score || a.sourceType.localeCompare(b.sourceType));
    const selectedChunks = [];
    const seenChunkKeys = new Set();
    for (const item of sorted) {
      const qualifiesLexically = item.lexicalScore > 0;
      const qualifiesSemantically = item.vectorScore >= PURE_VECTOR_THRESHOLD;
      if (item.score <= 0 || (!qualifiesLexically && !qualifiesSemantically)) {
        continue;
      }
      const seenKey = `${item.sourceId}:${item.chunkType}`;
      if (seenChunkKeys.has(seenKey)) {
        continue;
      }
      seenChunkKeys.add(seenKey);
      selectedChunks.push(item);
      if (selectedChunks.length >= Math.max(1, maxItems)) {
        break;
      }
    }

    return {
      selectedChunks,
      retrievalMeta: {
        mode: requestedMode,
        chunkCount: chunks.length,
        activeMode: selectedChunks.some((item) => item.vectorScore >= VECTOR_REASON_THRESHOLD) ? "hybrid" : "lexical",
        vectorEnabled: true,
        vectorCandidateCount: vectorCandidates.length,
        vectorSelectedCount: selectedChunks.filter((item) => item.vectorScore >= VECTOR_REASON_THRESHOLD).length,
        vectorProvider: queryEmbeddingResult?.provider || "",
        vectorFallbackUsed: Boolean(queryEmbeddingResult?.fallbackUsed),
        vectorFailure: "",
        cachedVectorCount: vectorCandidates.filter((item) => {
          const cacheKey = `${item.id}:${embeddingOptions.provider || "transformers_local"}:${embeddingOptions.model || ""}:${hashText(item.text)}`;
          return Array.isArray(cacheEntries[cacheKey]?.embedding) && cacheEntries[cacheKey].embedding.length > 0;
        }).length,
        fallbackReason:
          selectedChunks.some((item) => item.vectorScore >= VECTOR_REASON_THRESHOLD)
            ? ""
            : "Vector similarity did not materially change the final knowledge selection",
      },
    };
  }

  function formatKnowledgeContext(chunks) {
    return (chunks || [])
      .map(
        (item, index) =>
          `[Knowledge ${index + 1}][type=${item.sourceType}][chunk=${item.chunkType}][source=${item.sourceId}]\n${item.text}`
      )
      .join("\n\n");
  }

  return {
    buildKnowledgeChunks,
    retrieveKnowledgeChunks,
    formatKnowledgeContext,
  };
}

module.exports = {
  createKnowledgeRetrievalTools,
};
