"use strict";

const DEFAULT_LIST_SPLIT_PATTERN = /[;,\uFF0C\u3001]/;
const DEFAULT_CLAUSE_SPLIT_PATTERN = /[\n.!?;:\u3002\uFF01\uFF1F\uFF1B\uFF1A]+/;
const LATIN_TERM_PATTERN = /[A-Za-z][A-Za-z0-9_-]{2,}/g;
const CJK_CHAR_PATTERN = /[\u4e00-\u9fff]/;
const PURE_CJK_PATTERN = /^[\u4e00-\u9fff]+$/;
const CJK_LEADING_TRIM_PATTERN = /^(?:\u7684|\u4e86|\u5728|\u548c|\u4e0e|\u88ab|\u628a|\u7ed9|\u8ba9|\u4ece|\u5411|\u5bf9|\u4e8e|\u8fd8|\u53c8|\u5c31|\u90fd|\u4e5f|\u5f88|\u592a|\u66f4|\u6700|\u8fd9|\u90a3|\u54ea|\u67d0|\u6bcf|\u5404)+/;
const CJK_TRAILING_TRIM_PATTERN = /(?:\u7684|\u4e86|\u7740|\u8fc7|\u5730|\u5f97|\u662f|\u5728|\u5417|\u5462|\u554a|\u5427|\u5440|\u54e6|\u561b)+$/;
const CJK_INTERNAL_WEAK_PATTERN = /[\u7684\u4e86\u662f\u5728\u548c\u4e0e\u88ab\u628a\u7ed9\u8ba9\u4ece\u5411\u5bf9\u4e8e\u800c\u5c31\u90fd\u4e5f\u8fd8\u53c8]/;

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
]);

const CJK_WEAK_TERMS = new Set([
  "\u4e00\u4e2a",
  "\u4e00\u4e9b",
  "\u4e00\u79cd",
  "\u4e00\u4f4d",
  "\u4e00\u540d",
  "\u4e00\u4e2a\u4eba",
  "\u4e00\u4e9b\u4eba",
  "\u8fd9\u4e2a",
  "\u90a3\u4e2a",
  "\u8fd9\u79cd",
  "\u90a3\u79cd",
  "\u8fd9\u4e9b",
  "\u90a3\u4e9b",
  "\u4ec0\u4e48",
  "\u600e\u4e48",
  "\u4e3a\u4ec0\u4e48",
  "\u65f6\u5019",
  "\u5730\u65b9",
  "\u4e1c\u897f",
  "\u4eba",
  "\u5973\u5b69",
  "\u7537\u5b69",
  "\u5973\u4eba",
  "\u7537\u4eba",
  "\u7fa4\u4f53",
  "\u90a3\u4f4d",
  "\u8fd9\u4f4d",
  "\u90a3\u79cd\u4eba",
  "\u8fd9\u79cd\u4eba",
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

function containsWeakInternalCjkMarker(term) {
  if (!isPureCjkTerm(term) || term.length <= 3) {
    return false;
  }
  const middle = term.slice(1, -1);
  return CJK_INTERNAL_WEAK_PATTERN.test(middle);
}

function mergeSingleCharCjkTerms(terms = []) {
  const merged = [];
  let buffer = "";
  for (const value of Array.isArray(terms) ? terms : []) {
    const term = normalizeText(value);
    if (term && isPureCjkTerm(term) && term.length === 1 && !CJK_WEAK_TERMS.has(term)) {
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
  if (!term || SEARCH_STOP_WORDS.has(term) || CJK_WEAK_TERMS.has(term)) {
    return false;
  }
  if (/^\d+$/.test(term) || /^[a-z]{1,2}$/.test(term)) {
    return false;
  }
  if (isPureCjkTerm(term)) {
    if (term.length < 2 || term.length > 12) {
      return false;
    }
    if (containsWeakInternalCjkMarker(term)) {
      return false;
    }
  }
  return true;
}

function isHighSignalSearchTerm(value) {
  const term = trimCjkFragmentEdges(value);
  if (!isMeaningfulSearchTerm(term)) {
    return false;
  }
  if (!isPureCjkTerm(term)) {
    return term.length >= 3;
  }
  return !CJK_WEAK_TERMS.has(term);
}

function selectDiagnosticTerms(values = [], maxItems = 3) {
  return unique(
    (Array.isArray(values) ? values : [])
      .map((item) => trimCjkFragmentEdges(item))
      .filter(isHighSignalSearchTerm)
  ).slice(0, Math.max(1, Number(maxItems) || 3));
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
  return unique(
    mergeSingleCharCjkTerms([...terms, ...latinTerms])
      .map(trimCjkFragmentEdges)
      .filter(isMeaningfulSearchTerm)
  ).slice(0, maxItems);
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
  selectDiagnosticTerms,
  splitNaturalClauses,
  trimCjkFragmentEdges,
  truncateWithEllipsis,
  unique,
};
