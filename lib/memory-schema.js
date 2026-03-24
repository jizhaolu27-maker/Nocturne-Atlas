function unique(values = []) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

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

function extractFallbackTerms(text) {
  return unique(String(text || "").match(/[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,6}/g) || []).map(normalizeText);
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
  return unique((Array.isArray(values) ? values : []).map(normalizeText).filter(Boolean)).slice(0, maxItems);
}

function getNormalizedEntities(record = {}, maxItems = 6) {
  return unique((Array.isArray(record.entities) ? record.entities : []).map(normalizeText).filter(Boolean)).slice(0, maxItems);
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
      .filter((term) => term && !excluded.has(term) && !GENERIC_TERMS.has(term))
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
  normalizeText,
  unique,
};
