const { normalizeText, splitNaturalClauses, unique } = require("./text-utils");

function createMemoryChunkTools({
  summarizeText,
  safeId,
  extractKeywords,
  embedText,
  embedTextDetailed,
  buildMemoryEmbeddingText,
  resolveEmbeddingOptions,
  stripLeadingDialogueMarker,
  isProbablyDialogueClause,
  looksLikeSummaryFact,
  looksLikeUserIntentClause,
}) {
  function splitEvidenceClauses(text) {
    return splitNaturalClauses(text)
      .map((item) => stripLeadingDialogueMarker(item))
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function scoreEvidenceClause(clause, role, recordTerms = []) {
    const text = String(clause || "").trim();
    if (!text) {
      return -Infinity;
    }
    let score = 0;
    if (text.length >= 12) score += 1;
    if (text.length >= 24 && text.length <= 160) score += 2;
    if (role === "assistant") score += 2;
    if (looksLikeSummaryFact(text)) score += 3;
    if (isProbablyDialogueClause(text)) score -= 4;
    if (looksLikeUserIntentClause(text)) score -= 4;

    const normalizedClause = normalizeText(text);
    const termHits = unique(recordTerms.filter((term) => term && normalizedClause.includes(term)));
    if (termHits.length) {
      score += termHits.length * 2;
    }
    return score;
  }

  function buildEvidenceWindowText(messages = [], startIndex, endIndex) {
    const safeStart = Math.max(0, Number(startIndex) || 0);
    const safeEnd = Math.min(messages.length - 1, Number(endIndex) || 0);
    const slice = messages.slice(safeStart, safeEnd + 1);
    if (!slice.length) {
      return "";
    }
    const includeRolePrefix = slice.length > 1;
    return slice
      .map((message) => {
        const text = summarizeText(
          String(message?.content || "")
            .replace(/\s+/g, " ")
            .trim(),
          includeRolePrefix ? 180 : 240
        );
        if (!text) {
          return "";
        }
        return includeRolePrefix ? `${message.role}: ${text}` : text;
      })
      .filter(Boolean)
      .join("\n");
  }

  function buildEvidenceWindowCandidates(recentMessages, rankedClauses, totalMessageCount) {
    const candidates = [];
    const baseIndex = Math.max(1, totalMessageCount - recentMessages.length + 1);
    for (const item of rankedClauses) {
      const message = recentMessages[item.messageIndex];
      if (!message) {
        continue;
      }
      const absoluteIndex = baseIndex + item.messageIndex;
      candidates.push({
        text: item.text,
        sourceRole: message.role,
        sourceMessageRange: [absoluteIndex, absoluteIndex],
        score: item.score + (message.role === "assistant" ? 0.9 : 0.2),
      });

      const singleWindowText = buildEvidenceWindowText(recentMessages, item.messageIndex, item.messageIndex);
      if (singleWindowText && normalizeText(singleWindowText) !== normalizeText(item.text)) {
        candidates.push({
          text: singleWindowText,
          sourceRole: message.role,
          sourceMessageRange: [absoluteIndex, absoluteIndex],
          score: item.score + 0.8,
        });
      }

      const previousMessage = recentMessages[item.messageIndex - 1];
      if (message.role === "assistant" && previousMessage?.role === "user") {
        const pairedText = buildEvidenceWindowText(recentMessages, item.messageIndex - 1, item.messageIndex);
        if (pairedText) {
          candidates.push({
            text: pairedText,
            sourceRole: "mixed",
            sourceMessageRange: [absoluteIndex - 1, absoluteIndex],
            score: item.score + 1.6,
          });
        }
      }

      const nextMessage = recentMessages[item.messageIndex + 1];
      if (message.role === "user" && nextMessage?.role === "assistant") {
        const pairedText = buildEvidenceWindowText(recentMessages, item.messageIndex, item.messageIndex + 1);
        if (pairedText) {
          candidates.push({
            text: pairedText,
            sourceRole: "mixed",
            sourceMessageRange: [absoluteIndex, absoluteIndex + 1],
            score: item.score + 1.2,
          });
        }
      }
    }
    return candidates;
  }

  function buildChunkDedupeKey(chunk = {}) {
    const rangeKey = Array.isArray(chunk.sourceMessageRange) ? chunk.sourceMessageRange.join("-") : "";
    return [
      String(chunk.type || "").trim(),
      String(chunk.sourceRole || "").trim(),
      String(chunk.linkedRecordId || "").trim(),
      rangeKey,
      normalizeText(chunk.text),
    ].join("|");
  }

  function mergeMemoryChunks(existingChunks = [], addedChunks = []) {
    const merged = Array.isArray(existingChunks) ? existingChunks.slice() : [];
    const seenKeys = new Set(merged.map((item) => buildChunkDedupeKey(item)).filter(Boolean));
    const appended = [];
    for (const chunk of Array.isArray(addedChunks) ? addedChunks : []) {
      const dedupeKey = buildChunkDedupeKey(chunk);
      if (!dedupeKey || seenKeys.has(dedupeKey)) {
        continue;
      }
      seenKeys.add(dedupeKey);
      merged.push(chunk);
      appended.push(chunk);
    }
    return {
      chunks: merged,
      addedChunks: appended,
    };
  }

  async function buildMemoryEvidenceChunks({
    story,
    messages,
    record,
    messageLimit = 6,
    maxItems = 4,
    linkedRecordId,
    allowUnlinked = false,
    chunkType = "memory_evidence",
  }) {
    const recentMessages = (Array.isArray(messages) ? messages : []).slice(-Math.max(1, Number(messageLimit) || 6));
    if ((!record?.id && !allowUnlinked) || !recentMessages.length) {
      return [];
    }

    const recordTerms = unique([
      ...(record.entities || []),
      ...(record.tags || []),
      ...(record.subjectIds || []),
      ...(record.objectIds || []),
      ...extractKeywords(record.summary || ""),
    ])
      .map((item) => normalizeText(item))
      .filter(Boolean);

    const rankedClauses = recentMessages
      .flatMap((message, messageIndex) =>
        splitEvidenceClauses(message.content).map((clause, clauseIndex) => ({
          role: message.role,
          text: summarizeText(clause, 220),
          messageIndex,
          clauseIndex,
          score: scoreEvidenceClause(clause, message.role, recordTerms),
        }))
      )
      .filter((item) => item.score > 1 && item.text)
      .sort((a, b) => b.score - a.score || b.messageIndex - a.messageIndex || a.clauseIndex - b.clauseIndex);

    const rankedCandidates = buildEvidenceWindowCandidates(
      recentMessages,
      rankedClauses,
      Array.isArray(messages) ? messages.length : 0
    )
      .filter((item) => item.text)
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.sourceMessageRange?.[1] || 0) - (a.sourceMessageRange?.[1] || 0) ||
          (a.sourceMessageRange?.[0] || 0) - (b.sourceMessageRange?.[0] || 0)
      );

    const selected = [];
    const seenKeys = new Set();
    for (const item of rankedCandidates) {
      const rangeKey = Array.isArray(item.sourceMessageRange) ? item.sourceMessageRange.join("-") : "";
      const dedupeKey = `${rangeKey}:${normalizeText(item.text)}`;
      if (!normalizeText(item.text) || seenKeys.has(dedupeKey)) {
        continue;
      }
      seenKeys.add(dedupeKey);
      selected.push(item);
      if (selected.length >= Math.max(1, Number(maxItems) || 4)) {
        break;
      }
    }

    if (!selected.length) {
      return [];
    }

    const embeddingOptions = typeof resolveEmbeddingOptions === "function" ? resolveEmbeddingOptions(story) : { mode: "off" };
    const resolvedLinkedRecordId =
      linkedRecordId !== undefined ? String(linkedRecordId || "").trim() : String(record?.id || "").trim();
    const chunks = [];
    for (const [index, item] of selected.entries()) {
      const chunk = {
        id: safeId("memchunk"),
        type: chunkType || "memory_evidence",
        linkedRecordId: resolvedLinkedRecordId,
        conflictGroup: record.conflictGroup || "",
        canonKey: record.canonKey || "",
        text: item.text,
        sourceRole: item.sourceRole,
        sourceMessageRange: Array.isArray(item.sourceMessageRange)
          ? [...item.sourceMessageRange]
          : Array.isArray(record.sourceMessageRange)
            ? [...record.sourceMessageRange]
            : [],
        kind: record.kind,
        importance: record.importance,
        scope: record.scope || "plot",
        subjectIds: Array.isArray(record.subjectIds) ? [...record.subjectIds] : [],
        objectIds: Array.isArray(record.objectIds) ? [...record.objectIds] : [],
        entities: Array.isArray(record.entities) ? [...record.entities] : [],
        tags: Array.isArray(record.tags) ? [...record.tags] : [],
        keywords: extractKeywords(item.text).slice(0, 12),
        stability: record.stability || "volatile",
        confidence: Math.max(0.5, Number(record.confidence || 0.6) - index * 0.04),
        createdAt: new Date().toISOString(),
      };
      if (
        embeddingOptions?.mode === "on" &&
        (typeof embedTextDetailed === "function" || typeof embedText === "function") &&
        typeof buildMemoryEmbeddingText === "function"
      ) {
        const embeddingResult =
          typeof embedTextDetailed === "function"
            ? await embedTextDetailed(
                buildMemoryEmbeddingText({
                  summary: chunk.text,
                  entities: chunk.entities,
                  tags: chunk.tags,
                  keywords: chunk.keywords,
                  subjectIds: chunk.subjectIds,
                  objectIds: chunk.objectIds,
                }),
                embeddingOptions
              )
            : {
                vector: await embedText(
                  buildMemoryEmbeddingText({
                    summary: chunk.text,
                    entities: chunk.entities,
                    tags: chunk.tags,
                    keywords: chunk.keywords,
                    subjectIds: chunk.subjectIds,
                    objectIds: chunk.objectIds,
                  }),
                  embeddingOptions
                ),
                provider: embeddingOptions.provider || "hash_v1",
                model: embeddingOptions.provider === "hash_v1" ? "hash_v1" : embeddingOptions.model || "",
                fallbackUsed: false,
                error: "",
              };
        if (Array.isArray(embeddingResult?.vector) && embeddingResult.vector.length) {
          chunk.embedding = embeddingResult.vector;
          chunk.embeddingProvider = embeddingResult.provider || embeddingOptions.provider || "hash_v1";
          chunk.embeddingModel =
            embeddingResult.model || (embeddingResult.provider === "hash_v1" ? "hash_v1" : embeddingOptions.model || "");
          chunk.embeddingFallbackUsed = Boolean(embeddingResult.fallbackUsed);
          if (embeddingResult.requestedProvider && embeddingResult.requestedProvider !== chunk.embeddingProvider) {
            chunk.embeddingRequestedProvider = embeddingResult.requestedProvider;
          }
          chunk.embeddedAt = new Date().toISOString();
        }
      }
      chunks.push(chunk);
    }
    return chunks;
  }

  return {
    buildMemoryEvidenceChunks,
    mergeMemoryChunks,
  };
}

module.exports = {
  createMemoryChunkTools,
};
