const { extractKeywords } = require("./memory-engine");
const { normalizeText, unique } = require("./text-utils");

const MEMORY_KEYWORD_VERSION = 2;

function normalizeKeywordList(values = []) {
  return unique((Array.isArray(values) ? values : []).map((item) => normalizeText(item)).filter(Boolean));
}

function haveSameKeywords(left = [], right = []) {
  const normalizedLeft = normalizeKeywordList(left);
  const normalizedRight = normalizeKeywordList(right);
  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }
  return normalizedLeft.every((term, index) => term === normalizedRight[index]);
}

function refreshKeywords(item = {}, sourceText = "", maxItems = 12) {
  const nextKeywords = extractKeywords(sourceText).slice(0, maxItems);
  const changed =
    Number(item.keywordVersion || 0) !== MEMORY_KEYWORD_VERSION || !haveSameKeywords(item.keywords, nextKeywords);
  return {
    item: changed
      ? {
          ...item,
          keywords: nextKeywords,
          keywordVersion: MEMORY_KEYWORD_VERSION,
        }
      : item,
    changed,
  };
}

function normalizeStoredMemoryRecord(record = {}) {
  if (!record || typeof record !== "object") {
    return { item: null, changed: false };
  }
  const summary = String(record.summary || "").trim();
  if (!summary) {
    return { item: record, changed: false };
  }
  return refreshKeywords(record, summary, 12);
}

function normalizeStoredMemoryChunk(chunk = {}) {
  if (!chunk || typeof chunk !== "object") {
    return { item: null, changed: false };
  }
  const text = String(chunk.text || "").trim();
  if (!text) {
    return { item: chunk, changed: false };
  }
  return refreshKeywords(chunk, text, 12);
}

function normalizeRuntimeMemoryState({ memoryRecords = [], memoryChunks = [] } = {}) {
  let recordsChanged = false;
  let chunksChanged = false;

  const nextRecords = (Array.isArray(memoryRecords) ? memoryRecords : [])
    .map((item) => {
      const normalized = normalizeStoredMemoryRecord(item);
      if (normalized.changed) {
        recordsChanged = true;
      }
      return normalized.item;
    })
    .filter(Boolean);

  const nextChunks = (Array.isArray(memoryChunks) ? memoryChunks : [])
    .map((item) => {
      const normalized = normalizeStoredMemoryChunk(item);
      if (normalized.changed) {
        chunksChanged = true;
      }
      return normalized.item;
    })
    .filter(Boolean);

  return {
    memoryRecords: nextRecords,
    memoryChunks: nextChunks,
    recordsChanged,
    chunksChanged,
    changed: recordsChanged || chunksChanged,
  };
}

module.exports = {
  MEMORY_KEYWORD_VERSION,
  normalizeRuntimeMemoryState,
  normalizeStoredMemoryChunk,
  normalizeStoredMemoryRecord,
};
