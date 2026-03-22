function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function summarizeMergedRecords(records, maxLength = 420) {
  const text = records
    .map((item) => String(item.summary || "").trim())
    .filter(Boolean)
    .join(" ");
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
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
  return unique(records.flatMap((item) => item.keywords || []).map((item) => normalizeText(item))).slice(0, 16);
}

function buildEntities(records) {
  return unique(records.flatMap((item) => item.entities || [])).slice(0, 16);
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
  const unmerged = shortTermRecords.filter((item) => !item.mergedInto && eligibleKinds.has(item.kind));
  if (!unmerged.length) {
    return { records, addedRecords: [] };
  }

  const grouped = new Map();
  for (const record of unmerged) {
    const group = grouped.get(record.kind) || [];
    group.push(record);
    grouped.set(record.kind, group);
  }

  const addedRecords = [];
  for (const [kind, group] of grouped.entries()) {
    if (group.length < 2) {
      continue;
    }
    const summary = buildConsolidatedSummary(kind, group);
    if (!summary) {
      continue;
    }

    const consolidated = {
      id: options.makeId ? options.makeId("memory") : `memory_${Date.now()}`,
      type: "consolidated",
      tier: "long_term",
      kind,
      summary,
      entities: buildEntities(group),
      keywords: buildKeywords(group),
      importance: classifyImportance(group),
      mergedFrom: group.map((item) => item.id),
      supersedes: [],
      stability: inferStability(kind),
      lastValidatedAt: now,
      createdAt: now,
    };

    const supersededLongTerm = records.filter(
      (item) =>
        item.tier === "long_term" &&
        item.kind === kind &&
        item.id !== consolidated.id &&
        !item.supersededBy
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
