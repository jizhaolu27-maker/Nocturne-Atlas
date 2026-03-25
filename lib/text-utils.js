"use strict";

const DEFAULT_LIST_SPLIT_PATTERN = /[;,\uFF0C\u3001]/;
const DEFAULT_CLAUSE_SPLIT_PATTERN = /[\n.!?;:\u3002\uff01\uff1f\uff1b\uff1a]+/;
const LATIN_TERM_PATTERN = /[A-Za-z][A-Za-z0-9_-]{2,}/g;
const CJK_CHAR_PATTERN = /[\u4e00-\u9fff]/;
const PURE_CJK_PATTERN = /^[\u4e00-\u9fff]+$/;
const CJK_LEADING_TRIM_PATTERN = /^(?:的|了|着|过|在|和|与|把|被|让|给|向|对|跟|替|因|将|就|又|再|还|都|也)+/;
const CJK_TRAILING_TRIM_PATTERN = /(?:的|了|着|过|们|吧|啊|呀|嘛|呢|吗|啦|在|和|与)+$/;
const SEARCH_STOP_WORDS = new Set([
  "about",
  "also",
  "and",
  "are",
  "assistant",
  "but",
  "continue",
  "for",
  "from",
  "have",
  "her",
  "his",
  "into",
  "only",
  "our",
  "out",
  "scene",
  "still",
  "story",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "true",
  "user",
  "what",
  "when",
  "where",
  "which",
  "with",
  "your",
  "一个",
  "一些",
  "一位",
  "一名",
  "不是",
  "不过",
  "之后",
  "他们",
  "你们",
  "其实",
  "出来",
  "现在",
  "故事",
  "场景",
  "她们",
  "小姐",
  "后来",
  "而且",
  "然后",
  "第一次",
  "这个",
  "那个",
  "我们",
  "继续",
  "角色",
]);

let cachedZhWordSegmenter = null;

function unique(values = []) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeStringList(value, splitPattern = DEFAULT_LIST_SPLIT_PATTERN) {
  if (Array.isArray(value)) {
    return value.filter((item) => item != null && item !== "").map((item) => String(item));
  }
  if (typeof value === "string") {
    return value
      .split(splitPattern)
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

function splitNaturalClauses(text, splitPattern = DEFAULT_CLAUSE_SPLIT_PATTERN) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split(splitPattern)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeLongText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isPureCjkTerm(value) {
  return PURE_CJK_PATTERN.test(String(value || ""));
}

function trimCjkFragmentEdges(value) {
  const term = normalizeText(value);
  if (!isPureCjkTerm(term)) {
    return term;
  }
  return term.replace(CJK_LEADING_TRIM_PATTERN, "").replace(CJK_TRAILING_TRIM_PATTERN, "");
}

function mergeSingleCharCjkTerms(terms = []) {
  const merged = [];
  let buffer = "";
  for (const value of Array.isArray(terms) ? terms : []) {
    const term = normalizeText(value);
    if (term && isPureCjkTerm(term) && term.length === 1 && !SEARCH_STOP_WORDS.has(term)) {
      buffer += term;
      if (buffer.length >= 4) {
        merged.push(buffer);
        buffer = "";
      }
      continue;
    }
    if (buffer.length >= 2) {
      merged.push(buffer);
    } else if (buffer.length === 1) {
      merged.push(buffer);
    }
    buffer = "";
    if (term) {
      merged.push(term);
    }
  }
  if (buffer.length >= 2) {
    merged.push(buffer);
  } else if (buffer.length === 1) {
    merged.push(buffer);
  }
  return merged;
}

function isMeaningfulSearchTerm(value) {
  const term = trimCjkFragmentEdges(value);
  if (!term || SEARCH_STOP_WORDS.has(term)) {
    return false;
  }
  if (/^\d+$/.test(term) || /^[a-z]{1,2}$/.test(term)) {
    return false;
  }
  if (isPureCjkTerm(term) && (term.length < 2 || term.length > 12)) {
    return false;
  }
  return true;
}

function getZhWordSegmenter() {
  if (cachedZhWordSegmenter !== null) {
    return cachedZhWordSegmenter;
  }
  if (typeof Intl === "object" && typeof Intl.Segmenter === "function") {
    cachedZhWordSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
    return cachedZhWordSegmenter;
  }
  cachedZhWordSegmenter = false;
  return cachedZhWordSegmenter;
}

function extractSearchTerms(text, options = {}) {
  const source = String(text || "");
  const maxItems = Math.max(1, Number(options.maxItems) || 40);
  const terms = [];
  const segmenter = getZhWordSegmenter();

  if (segmenter) {
    for (const segment of segmenter.segment(source)) {
      const raw = String(segment?.segment || "").trim();
      if (!raw) {
        continue;
      }
      const normalized = normalizeText(raw);
      if (!normalized) {
        continue;
      }
      const looksWordLike =
        segment?.isWordLike !== false ||
        LATIN_TERM_PATTERN.test(raw) ||
        CJK_CHAR_PATTERN.test(raw);
      LATIN_TERM_PATTERN.lastIndex = 0;
      if (!looksWordLike) {
        continue;
      }
      if (/[A-Za-z]/.test(raw) || CJK_CHAR_PATTERN.test(raw)) {
        terms.push(normalized);
      }
    }
  } else {
    const fallbackTerms = source.match(/[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,12}/g) || [];
    terms.push(...fallbackTerms.map((item) => normalizeText(item)));
  }

  const latinTerms = normalizeText(source).match(LATIN_TERM_PATTERN) || [];
  return unique(mergeSingleCharCjkTerms([...terms, ...latinTerms]).map(trimCjkFragmentEdges).filter(isMeaningfulSearchTerm)).slice(
    0,
    maxItems
  );
}

function truncateWithEllipsis(value, maxLength) {
  const text = String(value || "").trim();
  const limit = Number(maxLength);
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1))}...`;
}

module.exports = {
  DEFAULT_CLAUSE_SPLIT_PATTERN,
  DEFAULT_LIST_SPLIT_PATTERN,
  extractSearchTerms,
  isMeaningfulSearchTerm,
  normalizeLongText,
  normalizeStringList,
  normalizeText,
  splitNaturalClauses,
  trimCjkFragmentEdges,
  truncateWithEllipsis,
  unique,
};
