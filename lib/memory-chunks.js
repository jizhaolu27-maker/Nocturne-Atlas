const { normalizeText, splitNaturalClauses, unique } = require("./text-utils");
const { MEMORY_KEYWORD_VERSION } = require("./memory-runtime");
const { isStableSchemaTerm } = require("./memory-schema");

function createMemoryChunkTools({
  summarizeText,
  safeId,
  extractKeywords,
  embedText,
  embedTextDetailed,
  buildMemoryEmbeddingText,
  buildEmbeddingSignature,
  resolveEmbeddingOptions,
  stripLeadingDialogueMarker,
  isProbablyDialogueClause,
  looksLikeSummaryFact,
  looksLikeUserIntentClause,
}) {
  function selectStableValues(values = [], maxItems = 6, options = {}) {
    const selected = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const raw = String(value || "").trim();
      const normalized = normalizeText(raw);
      if (!raw || !normalized || seen.has(normalized) || !isStableSchemaTerm(raw, options)) {
        continue;
      }
      seen.add(normalized);
      selected.push(raw);
      if (selected.length >= Math.max(1, Number(maxItems) || 1)) {
        break;
      }
    }
    return selected;
  }

  function buildEpisodicChunkMetadata(record = {}) {
    const subjectIds = selectStableValues(record.subjectIds, 2, { allowId: true });
    const objectIds = selectStableValues(record.objectIds, 2, { allowId: true });
    const hasStructuredAnchor = subjectIds.length > 0 || objectIds.length > 0;
    const scope =
      hasStructuredAnchor && ["character", "relationship", "world", "plot"].includes(String(record.scope || ""))
        ? String(record.scope || "")
        : "plot";
    return {
      linkedRecordId: "",
      conflictGroup: "",
      canonKey: "",
      stateSlot: "",
      stateFacet: "",
      kind: "plot_checkpoint",
      importance: record.importance || "medium",
      scope,
      subjectIds,
      objectIds,
      entities: [],
      tags: [],
      stability: "volatile",
      confidence: Math.min(0.68, Math.max(0.45, Number(record.confidence || 0.6))),
    };
  }

  function computeKeywordOverlapRatio(leftText, rightText) {
    const leftTerms = unique(extractKeywords(leftText).map((item) => normalizeText(item)).filter(Boolean));
    const rightTerms = new Set(unique(extractKeywords(rightText).map((item) => normalizeText(item)).filter(Boolean)));
    if (!leftTerms.length || !rightTerms.size) {
      return 0;
    }
    const overlap = leftTerms.filter((term) => rightTerms.has(term)).length;
    return overlap / Math.max(leftTerms.length, rightTerms.size);
  }

  function getRangeBounds(range) {
    if (!Array.isArray(range) || range.length !== 2) {
      return null;
    }
    const start = Number(range[0]);
    const end = Number(range[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return null;
    }
    return {
      start: Math.min(start, end),
      end: Math.max(start, end),
    };
  }

  function rangesOverlap(leftRange, rightRange) {
    const left = getRangeBounds(leftRange);
    const right = getRangeBounds(rightRange);
    if (!left || !right) {
      return false;
    }
    return left.start <= right.end && right.start <= left.end;
  }

  function isNearDuplicateCandidate(left, right) {
    const leftText = normalizeText(left?.text || "");
    const rightText = normalizeText(right?.text || "");
    if (!leftText || !rightText) {
      return false;
    }
    if (leftText === rightText || leftText.includes(rightText) || rightText.includes(leftText)) {
      return true;
    }
    const overlapRatio = computeKeywordOverlapRatio(leftText, rightText);
    const leftRange = Array.isArray(left?.sourceMessageRange) ? left.sourceMessageRange.join("-") : "";
    const rightRange = Array.isArray(right?.sourceMessageRange) ? right.sourceMessageRange.join("-") : "";
    if (leftRange && rightRange && leftRange === rightRange && overlapRatio >= 0.72) {
      return true;
    }
    if (rangesOverlap(left?.sourceMessageRange, right?.sourceMessageRange) && overlapRatio >= 0.68) {
      return true;
    }
    return false;
  }

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

  function getChunkSortTimestamp(chunk = {}) {
    const timestamp = Date.parse(String(chunk?.createdAt || ""));
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
    if (Array.isArray(chunk?.sourceMessageRange) && chunk.sourceMessageRange.length === 2) {
      return Number(chunk.sourceMessageRange[1] || chunk.sourceMessageRange[0] || 0);
    }
    return 0;
  }

  function isActiveLinkedRecord(record = {}) {
    if (!record || typeof record !== "object") {
      return false;
    }
    if ((record?.tier || "short_term") === "long_term") {
      return !record.supersededBy;
    }
    return !record.mergedInto;
  }

  function relinkChunkToRecord(chunk, record) {
    if (!chunk || !record) {
      return chunk;
    }
    chunk.linkedRecordId = String(record.id || "").trim();
    chunk.conflictGroup = record.conflictGroup || "";
    chunk.canonKey = record.canonKey || "";
    chunk.stateSlot = record.stateSlot || "";
    chunk.stateFacet = record.stateFacet || "";
    chunk.scope = record.scope || chunk.scope || "plot";
    chunk.kind = record.kind || chunk.kind || "plot_checkpoint";
    chunk.importance = record.importance || chunk.importance || "medium";
    chunk.stability = record.stability || chunk.stability || "volatile";
    if (!Array.isArray(chunk.subjectIds) || !chunk.subjectIds.length) {
      chunk.subjectIds = Array.isArray(record.subjectIds) ? [...record.subjectIds] : [];
    }
    if (!Array.isArray(chunk.objectIds) || !chunk.objectIds.length) {
      chunk.objectIds = Array.isArray(record.objectIds) ? [...record.objectIds] : [];
    }
    if (!Array.isArray(chunk.tags) || !chunk.tags.length) {
      chunk.tags = Array.isArray(record.tags) ? [...record.tags] : [];
    }
    if (!Array.isArray(chunk.entities) || !chunk.entities.length) {
      chunk.entities = Array.isArray(record.entities) ? [...record.entities] : [];
    }
    return chunk;
  }

  function resolveActiveLinkedRecord(chunk, recordById) {
    const linkedRecordId = String(chunk?.linkedRecordId || "").trim();
    if (!linkedRecordId) {
      return null;
    }
    const linkedRecord = recordById.get(linkedRecordId) || null;
    if (isActiveLinkedRecord(linkedRecord)) {
      return linkedRecord;
    }
    const successorId = String(linkedRecord?.mergedInto || linkedRecord?.supersededBy || "").trim();
    const successorRecord = successorId ? recordById.get(successorId) || null : null;
    if (isActiveLinkedRecord(successorRecord)) {
      relinkChunkToRecord(chunk, successorRecord);
      return successorRecord;
    }
    return null;
  }

  function rankChunkRetention(chunk, recordById) {
    const linkedRecord = recordById.get(String(chunk?.linkedRecordId || "").trim()) || null;
    const confidence = Number(chunk?.confidence || 0);
    const importanceBoost =
      chunk?.importance === "high" ? 3 : chunk?.importance === "medium" ? 1.5 : 0;
    const stabilityBoost =
      chunk?.stability === "stable" || linkedRecord?.tier === "long_term" || linkedRecord?.stability === "stable"
        ? 2
        : 0;
    return (
      getChunkSortTimestamp(chunk) +
      confidence * 1000 +
      importanceBoost * 100 +
      stabilityBoost * 100
    );
  }

  function compactMemoryChunks(chunks = [], memoryRecords = [], options = {}) {
    const source = Array.isArray(chunks) ? chunks : [];
    if (!source.length) {
      return [];
    }
    const maxEpisodicChunks = Math.max(4, Number(options.maxEpisodicChunks) || 24);
    const maxUnlinkedSupportChunks = Math.max(2, Number(options.maxUnlinkedSupportChunks) || 8);
    const recordById = new Map((Array.isArray(memoryRecords) ? memoryRecords : []).map((item) => [String(item?.id || ""), item]));
    const keepIds = new Set();
    const episodicLike = [];
    const unlinkedSupport = [];
    const linkedGroups = new Map();

    for (const chunk of source) {
      const linkedRecordId = String(chunk?.linkedRecordId || "").trim();
      if (!linkedRecordId) {
        if (String(chunk?.type || "").trim().toLowerCase() === "memory_evidence") {
          unlinkedSupport.push(chunk);
        } else {
          episodicLike.push(chunk);
        }
        continue;
      }
      const linkedRecord = resolveActiveLinkedRecord(chunk, recordById);
      if (!isActiveLinkedRecord(linkedRecord)) {
        continue;
      }
      const resolvedLinkedRecordId = String(chunk?.linkedRecordId || "").trim();
      const group = linkedGroups.get(resolvedLinkedRecordId) || [];
      group.push(chunk);
      linkedGroups.set(resolvedLinkedRecordId, group);
    }

    const selectTopChunks = (items, limit) =>
      items
        .slice()
        .sort((left, right) => rankChunkRetention(right, recordById) - rankChunkRetention(left, recordById))
        .slice(0, Math.max(0, limit));

    for (const [linkedRecordId, items] of linkedGroups.entries()) {
      const linkedRecord = recordById.get(linkedRecordId);
      const limit =
        linkedRecord?.tier === "long_term" || linkedRecord?.stability === "stable" || linkedRecord?.importance === "high"
          ? 3
          : 2;
      for (const chunk of selectTopChunks(items, limit)) {
        keepIds.add(chunk.id);
      }
    }

    for (const chunk of selectTopChunks(episodicLike, maxEpisodicChunks)) {
      keepIds.add(chunk.id);
    }
    for (const chunk of selectTopChunks(unlinkedSupport, maxUnlinkedSupportChunks)) {
      keepIds.add(chunk.id);
    }

    return source.filter((chunk) => keepIds.has(chunk.id));
  }

  async function applyChunkEmbedding(chunk, story) {
    const target = chunk && typeof chunk === "object" ? chunk : null;
    if (!target) {
      return target;
    }
    const embeddingOptions = typeof resolveEmbeddingOptions === "function" ? resolveEmbeddingOptions(story) : { mode: "off" };
    if (
      embeddingOptions?.mode !== "on" ||
      !(typeof embedTextDetailed === "function" || typeof embedText === "function") ||
      typeof buildMemoryEmbeddingText !== "function"
    ) {
      return target;
    }
    const embeddingInput = buildMemoryEmbeddingText({
      summary: target.text,
      entities: target.entities,
      tags: target.tags,
      keywords: target.keywords,
      subjectIds: target.subjectIds,
      objectIds: target.objectIds,
    });
    const embeddingResult =
      typeof embedTextDetailed === "function"
        ? await embedTextDetailed(embeddingInput, embeddingOptions)
        : {
            vector: await embedText(embeddingInput, embeddingOptions),
            provider: embeddingOptions.provider || "hash_v1",
            model: embeddingOptions.provider === "hash_v1" ? "hash_v1" : embeddingOptions.model || "",
            fallbackUsed: false,
            error: "",
          };
    if (Array.isArray(embeddingResult?.vector) && embeddingResult.vector.length) {
      target.embedding = embeddingResult.vector;
      target.embeddingProvider = embeddingResult.provider || embeddingOptions.provider || "hash_v1";
      target.embeddingModel =
        embeddingResult.model || (embeddingResult.provider === "hash_v1" ? "hash_v1" : embeddingOptions.model || "");
      target.embeddingSignature =
        typeof buildEmbeddingSignature === "function"
          ? buildEmbeddingSignature(target.embeddingProvider, target.embeddingModel)
          : "";
      target.embeddingFallbackUsed = Boolean(embeddingResult.fallbackUsed);
      if (embeddingResult.requestedProvider && embeddingResult.requestedProvider !== target.embeddingProvider) {
        target.embeddingRequestedProvider = embeddingResult.requestedProvider;
      }
      if (embeddingResult.requestedModel && embeddingResult.requestedModel !== target.embeddingModel) {
        target.embeddingRequestedModel = embeddingResult.requestedModel;
      }
      target.embeddedAt = new Date().toISOString();
    }
    return target;
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
      if (!normalizeText(item.text) || seenKeys.has(dedupeKey) || selected.some((chosen) => isNearDuplicateCandidate(chosen, item))) {
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

    const resolvedLinkedRecordId =
      linkedRecordId !== undefined ? String(linkedRecordId || "").trim() : String(record?.id || "").trim();
    const chunks = [];
    const isEpisodicChunk = String(chunkType || "").trim().toLowerCase() === "memory_episode";
    for (const [index, item] of selected.entries()) {
      const episodicMetadata = isEpisodicChunk ? buildEpisodicChunkMetadata(record) : null;
      const chunk = {
        id: safeId("memchunk"),
        type: chunkType || "memory_evidence",
        linkedRecordId: episodicMetadata ? "" : resolvedLinkedRecordId,
        conflictGroup: episodicMetadata ? "" : record.conflictGroup || "",
        canonKey: episodicMetadata ? "" : record.canonKey || "",
        stateSlot: episodicMetadata ? "" : record.stateSlot || "",
        stateFacet: episodicMetadata ? "" : record.stateFacet || "",
        text: item.text,
        sourceRole: item.sourceRole,
        sourceMessageRange: Array.isArray(item.sourceMessageRange)
          ? [...item.sourceMessageRange]
          : Array.isArray(record.sourceMessageRange)
            ? [...record.sourceMessageRange]
            : [],
        kind: episodicMetadata ? episodicMetadata.kind : record.kind,
        importance: episodicMetadata ? episodicMetadata.importance : record.importance,
        scope: episodicMetadata ? episodicMetadata.scope : record.scope || "plot",
        subjectIds: episodicMetadata ? episodicMetadata.subjectIds : Array.isArray(record.subjectIds) ? [...record.subjectIds] : [],
        objectIds: episodicMetadata ? episodicMetadata.objectIds : Array.isArray(record.objectIds) ? [...record.objectIds] : [],
        entities: episodicMetadata ? episodicMetadata.entities : Array.isArray(record.entities) ? [...record.entities] : [],
        tags: episodicMetadata ? episodicMetadata.tags : Array.isArray(record.tags) ? [...record.tags] : [],
        keywords: extractKeywords(item.text).slice(0, 12),
        keywordVersion: MEMORY_KEYWORD_VERSION,
        stability: episodicMetadata ? episodicMetadata.stability : record.stability || "volatile",
        confidence: episodicMetadata
          ? Math.max(0.45, Number(episodicMetadata.confidence || 0.6) - index * 0.03)
          : Math.max(0.5, Number(record.confidence || 0.6) - index * 0.04),
        createdAt: new Date().toISOString(),
      };
      await applyChunkEmbedding(chunk, story);
      chunks.push(chunk);
    }
    return chunks;
  }

  return {
    buildMemoryEvidenceChunks,
    compactMemoryChunks,
    mergeMemoryChunks,
  };
}

module.exports = {
  createMemoryChunkTools,
};
