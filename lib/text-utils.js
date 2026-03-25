"use strict";

const DEFAULT_LIST_SPLIT_PATTERN = /[;,\uFF0C\u3001]/;
const DEFAULT_CLAUSE_SPLIT_PATTERN = /[\n.!?;:\u3002\uff01\uff1f\uff1b\uff1a]+/;

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
  normalizeLongText,
  normalizeStringList,
  normalizeText,
  splitNaturalClauses,
  truncateWithEllipsis,
  unique,
};
