const { normalizeText, unique } = require("./text-utils");

const GENERIC_TERMS = new Set([
  "plot",
  "character",
  "world",
  "relationship",
  "memory",
  "state",
  "update",
  "checkpoint",
  "story",
  "\u6545\u4e8b",
  "\u89d2\u8272",
  "\u4e16\u754c",
  "\u5173\u7cfb",
  "\u8bb0\u5fc6",
  "\u72b6\u6001",
]);

const WEAK_SCHEMA_TERMS = new Set([
  "generic",
  "continue",
  "scene",
  "moment",
  "later",
  "suddenly",
  "\u4ece",
  "\u7684",
  "\u8bb0\u5fc6",
  "\u788e\u7247",
  "\u56de\u6d41",
  "\u6d1e\u5e9c",
  "\u9192\u6765",
  "\u5f00\u59cb",
  "\u7ee7\u7eed",
  "\u540e\u6765",
  "\u5e73\u9759",
  "\u5fd9\u788c",
  "\u6628\u665a",
  "\u4e00\u5929",
]);

const WEAK_SCHEMA_PREFIXES = [
  /^(from|with|after|before|during|while|when|where|into|onto|around|about|continue|scene|story)/,
  /^(\u4ece|\u7684|\u5728|\u4e8e|\u548c|\u4e0e|\u628a|\u88ab|\u5411|\u8ba9|\u7ed9|\u5bf9|\u8ddf|\u66ff|\u56e0|\u5c06|\u518d|\u53c8|\u5c31)/,
];

function extractFallbackTerms(text) {
  return unique(String(text || "").match(/[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,6}/g) || []).map(normalizeText);
}

function isStableSchemaTerm(value, options = {}) {
  const raw = String(value || "").trim();
  const term = normalizeText(raw);
  if (!term) {
    return false;
  }
  if (options.allowId && /^[A-Za-z0-9_:-]{3,}$/.test(raw)) {
    return true;
  }
  if (GENERIC_TERMS.has(term) || WEAK_SCHEMA_TERMS.has(term)) {
    return false;
  }
  if (term.length < 2 || term.length > 32) {
    return false;
  }
  if (/^\d+$/.test(term) || /^[a-z]{1,2}$/.test(term)) {
    return false;
  }
  if (WEAK_SCHEMA_PREFIXES.some((pattern) => pattern.test(term))) {
    return false;
  }
  return true;
}

function getRecordScope(record = {}) {
  const scope = normalizeText(record.scope);
  if (scope) {
    return scope;
  }
  const kind = normalizeText(record.kind);
  if (kind === "relationship_update") return "relationship";
  if (kind === "world_state") return "world";
  if (kind === "character_update") return "character";
  return "plot";
}

function getRecordKind(record = {}) {
  return normalizeText(record.kind) || "plot_checkpoint";
}

function getNormalizedIds(values = [], maxItems = 4) {
  return unique((Array.isArray(values) ? values : []).map(normalizeText).filter((term) => isStableSchemaTerm(term, { allowId: true }))).slice(
    0,
    maxItems
  );
}

function getNormalizedEntities(record = {}, maxItems = 6) {
  return unique((Array.isArray(record.entities) ? record.entities : []).map(normalizeText).filter((term) => isStableSchemaTerm(term))).slice(
    0,
    maxItems
  );
}

function getRecordFocusTerms(record = {}, maxItems = 6) {
  const excluded = new Set([
    ...getNormalizedIds(record.subjectIds),
    ...getNormalizedIds(record.objectIds),
    getRecordScope(record),
    getRecordKind(record),
  ]);
  const sourceTerms = [
    ...(Array.isArray(record.tags) ? record.tags : []),
    ...(Array.isArray(record.keywords) ? record.keywords : []),
    ...(Array.isArray(record.entities) ? record.entities : []),
    ...extractFallbackTerms(record.summary),
  ];
  return unique(
    sourceTerms
      .map(normalizeText)
      .filter((term) => term && !excluded.has(term) && !GENERIC_TERMS.has(term) && isStableSchemaTerm(term))
  ).slice(0, maxItems);
}

function getRecordAnchor(record = {}) {
  return (
    getNormalizedIds(record.subjectIds, 1)[0] ||
    getNormalizedIds(record.objectIds, 1)[0] ||
    getNormalizedEntities(record, 1)[0] ||
    getRecordFocusTerms(record, 1)[0] ||
    "generic"
  );
}

function buildMemoryConflictGroup(record = {}) {
  if (String(record.conflictGroup || "").trim()) {
    return normalizeText(record.conflictGroup);
  }
  const kind = getRecordKind(record);
  if (kind === "relationship_update") {
    const participants = unique([
      ...getNormalizedIds(record.subjectIds),
      ...getNormalizedIds(record.objectIds),
      ...getNormalizedEntities(record, 2),
    ]).sort();
    return `${kind}:${participants.join("|") || getRecordAnchor(record)}`;
  }
  if (kind === "character_update") {
    return `${kind}:${getRecordAnchor(record)}`;
  }
  if (kind === "world_state") {
    return `${kind}:${getRecordAnchor(record)}`;
  }
  return `${getRecordScope(record)}:${getRecordAnchor(record)}`;
}

function buildMemoryCanonKey(record = {}) {
  if (String(record.canonKey || "").trim()) {
    return normalizeText(record.canonKey);
  }
  const baseGroup = buildMemoryConflictGroup(record);
  const anchor = getRecordAnchor(record);
  const detailTerms = getRecordFocusTerms(record, 6).filter((term) => term !== anchor).slice(0, 2);
  return `${baseGroup}:${detailTerms.join("|") || "generic"}`;
}

module.exports = {
  buildMemoryCanonKey,
  buildMemoryConflictGroup,
  getRecordAnchor,
  getRecordFocusTerms,
  getRecordKind,
  getRecordScope,
  isStableSchemaTerm,
  normalizeText,
  unique,
};
