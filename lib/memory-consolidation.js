const {
  buildMemoryCanonKey,
  buildMemoryConflictGroup,
  buildMemoryStateFacet,
  buildMemoryStateSlot,
  getRecordKind,
  getRecordScope,
} = require("./memory-schema");
const { normalizeText, truncateWithEllipsis, unique } = require("./text-utils");

function summarizeMergedRecords(records, maxLength = 420) {
  const text = unique((Array.isArray(records) ? records : []).map((item) => String(item.summary || "").trim()).filter(Boolean)).join(" ");
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }
  return truncateWithEllipsis(cleaned, maxLength);
}

function classifyImportance(records) {
  if (records.some((item) => item.importance === "high")) {
    return "high";
  }
  if (records.some((item) => item.importance === "medium")) {
    return "medium";
  }
  return "low";
}

function inferStability(kind) {
  if (kind === "relationship_update" || kind === "world_state" || kind === "character_update") {
    return "stable";
  }
  return "volatile";
}

function buildConsolidatedSummary(kind, records) {
  const summary = summarizeMergedRecords(records);
  if (!summary) {
    return "";
  }
  if (kind === "relationship_update") {
    return `Relationship state: ${summary}`;
  }
  if (kind === "world_state") {
    return `World state: ${summary}`;
  }
  if (kind === "character_update") {
    return `Character state: ${summary}`;
  }
  return summary;
}

function buildKeywords(records) {
  return unique(records.flatMap((item) => [...(item.keywords || []), ...(item.tags || [])]).map((item) => normalizeText(item))).slice(0, 20);
}

function buildEntities(records) {
  return unique(records.flatMap((item) => item.entities || [])).slice(0, 20);
}

function buildSubjectIds(records) {
  return unique(records.flatMap((item) => item.subjectIds || [])).slice(0, 8);
}

function buildObjectIds(records) {
  return unique(records.flatMap((item) => item.objectIds || [])).slice(0, 8);
}

function buildTags(records) {
  return unique(records.flatMap((item) => item.tags || [])).slice(0, 12);
}

function buildStateFacet(records) {
  return (
    unique(records.map((item) => buildMemoryStateFacet(item)).map((item) => normalizeText(item)).filter((item) => item && item !== "generic"))
      .slice(0, 2)
      .join("|") || "generic"
  );
}

function getConsolidationKey(record) {
  return buildMemoryStateSlot(record);
}

function shouldConsolidateRecord(record, eligibleKinds) {
  return !record.mergedInto && eligibleKinds.has(record.kind);
}

function consolidateMemoryRecords(memoryRecords, options = {}) {
  const records = Array.isArray(memoryRecords) ? memoryRecords.slice() : [];
  const now = options.now || new Date().toISOString();
  const shortTermThreshold = Math.max(1, Number(options.shortTermThreshold) || 8);
  const shortTermRecords = records.filter((item) => (item.tier || "short_term") === "short_term");
  if (shortTermRecords.length < shortTermThreshold) {
    return { records, addedRecords: [] };
  }

  const eligibleKinds = new Set(["relationship_update", "world_state", "character_update"]);
  const unmerged = shortTermRecords.filter((item) => shouldConsolidateRecord(item, eligibleKinds));
  if (!unmerged.length) {
    return { records, addedRecords: [] };
  }

  const grouped = new Map();
  for (const record of unmerged) {
    const key = getConsolidationKey(record);
    const group = grouped.get(key) || [];
    group.push(record);
    grouped.set(key, group);
  }

  const addedRecords = [];
  for (const [, group] of grouped.entries()) {
    if (group.length < 2) {
      continue;
    }

    const kind = group[0].kind;
    const summary = buildConsolidatedSummary(kind, group);
    if (!summary) {
      continue;
    }

    const subjectIds = buildSubjectIds(group);
    const objectIds = buildObjectIds(group);
    const consolidated = {
      id: options.makeId ? options.makeId("memory") : `memory_${Date.now()}`,
      type: "consolidated",
      tier: "long_term",
      kind,
      scope: group[0].scope || getRecordScope(group[0]),
      summary,
      entities: buildEntities(group),
      keywords: buildKeywords(group),
      tags: buildTags(group),
      subjectIds,
      objectIds,
      importance: classifyImportance(group),
      mergedFrom: group.map((item) => item.id),
      supersedes: [],
      stability: inferStability(kind),
      confidence: Math.max(...group.map((item) => Number(item.confidence) || 0.6), 0.6),
      lastValidatedAt: now,
      createdAt: now,
    };
    consolidated.stateSlot = buildMemoryStateSlot(consolidated);
    consolidated.stateFacet = buildStateFacet(group);
    consolidated.conflictGroup = buildMemoryConflictGroup(consolidated);
    consolidated.canonKey = buildMemoryCanonKey({
      ...consolidated,
      kind: getRecordKind(consolidated),
    });

    const supersededLongTerm = records.filter(
      (item) =>
        item.tier === "long_term" &&
        item.kind === kind &&
        !item.supersededBy &&
        getConsolidationKey(item) === getConsolidationKey(consolidated)
    );
    if (supersededLongTerm.length) {
      consolidated.supersedes = supersededLongTerm.map((item) => item.id);
    }
    addedRecords.push(consolidated);

    for (const record of records) {
      if (consolidated.mergedFrom.includes(record.id)) {
        record.mergedInto = consolidated.id;
        record.mergedAt = now;
      }
      if (consolidated.supersedes.includes(record.id)) {
        record.supersededBy = consolidated.id;
        record.supersededAt = now;
      }
    }
  }

  if (!addedRecords.length) {
    return { records, addedRecords: [] };
  }

  return {
    records: [...records, ...addedRecords],
    addedRecords,
  };
}

module.exports = {
  consolidateMemoryRecords,
};
