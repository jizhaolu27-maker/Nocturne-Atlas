const STORY_STATE_SCHEMA_VERSION = 1;

const OUTLINE_STATUSES = new Set(["planned", "active", "completed", "paused", "abandoned"]);
const OUTLINE_TYPES = new Set(["volume", "arc", "chapter", "scene", "beat"]);
const THREAD_STATUSES = new Set(["planned", "active", "blocked", "resolved", "abandoned"]);
const THREAD_KINDS = new Set(["main", "subplot", "character", "mystery", "romance", "world"]);
const EVENT_STATUSES = new Set(["planned", "canon", "superseded", "discarded"]);

function createStoryStateTools({ readJson, writeJson, getStoryStateFile, getStory, safeId }) {
  function text(value, maxLength = 240) {
    return String(value || "").trim().slice(0, maxLength);
  }

  function stringList(value, maxItems = 12, maxLength = 80) {
    const source = Array.isArray(value) ? value : [];
    return Array.from(new Set(source.map((item) => text(item, maxLength)).filter(Boolean))).slice(0, maxItems);
  }

  function enumValue(value, allowed, fallback) {
    const normalized = text(value, 40).toLowerCase();
    return allowed.has(normalized) ? normalized : fallback;
  }

  function numberValue(value, fallback = 0, min = 0, max = 1000000) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  }

  function itemId(value, prefix) {
    const normalized = text(value, 96);
    if (normalized && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(normalized)) {
      return normalized;
    }
    return safeId(prefix);
  }

  function normalizeOutlineNode(item = {}, index = 0) {
    return {
      id: itemId(item.id, "outline"),
      parentId: text(item.parentId, 96),
      type: enumValue(item.type, OUTLINE_TYPES, "chapter"),
      title: text(item.title, 160) || `Untitled node ${index + 1}`,
      summary: text(item.summary, 1200),
      status: enumValue(item.status, OUTLINE_STATUSES, "planned"),
      order: numberValue(item.order, index, 0),
      characterIds: stringList(item.characterIds, 24, 96),
      plotThreadIds: stringList(item.plotThreadIds, 24, 96),
      storyTime: text(item.storyTime, 120),
      locationId: text(item.locationId, 96),
      updatedAt: text(item.updatedAt, 40),
    };
  }

  function normalizePlotThread(item = {}, index = 0) {
    return {
      id: itemId(item.id, "thread"),
      kind: enumValue(item.kind, THREAD_KINDS, index === 0 ? "main" : "subplot"),
      title: text(item.title, 160) || `Untitled thread ${index + 1}`,
      summary: text(item.summary, 1200),
      status: enumValue(item.status, THREAD_STATUSES, "planned"),
      currentGoal: text(item.currentGoal, 500),
      nextStep: text(item.nextStep, 500),
      stakes: text(item.stakes, 500),
      characterIds: stringList(item.characterIds, 24, 96),
      outlineNodeIds: stringList(item.outlineNodeIds, 40, 96),
      updatedAt: text(item.updatedAt, 40),
    };
  }

  function normalizeTimelineEvent(item = {}, index = 0) {
    return {
      id: itemId(item.id, "event"),
      title: text(item.title, 160) || `Untitled event ${index + 1}`,
      summary: text(item.summary, 1200),
      status: enumValue(item.status, EVENT_STATUSES, "planned"),
      storyTime: text(item.storyTime, 120),
      sortKey: numberValue(item.sortKey, index, 0),
      outlineNodeId: text(item.outlineNodeId, 96),
      plotThreadIds: stringList(item.plotThreadIds, 24, 96),
      characterIds: stringList(item.characterIds, 32, 96),
      locationId: text(item.locationId, 96),
      sourceMessageRange: Array.isArray(item.sourceMessageRange)
        ? item.sourceMessageRange.slice(0, 2).map((value) => numberValue(value, 0, 0))
        : [],
      updatedAt: text(item.updatedAt, 40),
    };
  }

  function normalizeRelationshipEvent(item = {}, index = 0) {
    const sourceId = text(item.sourceId, 96);
    const targetId = text(item.targetId, 96);
    return {
      id: itemId(item.id, "relationship"),
      sourceId,
      targetId,
      type: text(item.type, 80) || "related",
      label: text(item.label, 160),
      direction: ["directed", "mutual"].includes(text(item.direction, 20).toLowerCase())
        ? text(item.direction, 20).toLowerCase()
        : "mutual",
      strength: numberValue(item.strength, 0.5, -1, 1),
      status: enumValue(item.status, EVENT_STATUSES, "canon"),
      storyTime: text(item.storyTime, 120),
      sortKey: numberValue(item.sortKey, index, 0),
      outlineNodeId: text(item.outlineNodeId, 96),
      timelineEventId: text(item.timelineEventId, 96),
      sourceMessageRange: Array.isArray(item.sourceMessageRange)
        ? item.sourceMessageRange.slice(0, 2).map((value) => numberValue(value, 0, 0))
        : [],
      note: text(item.note, 800),
      updatedAt: text(item.updatedAt, 40),
    };
  }

  function ensureUniqueIds(items, label) {
    const ids = new Set();
    for (const item of items) {
      if (ids.has(item.id)) {
        throw new Error(`Duplicate ${label} id: ${item.id}`);
      }
      ids.add(item.id);
    }
  }

  function validateReferences(state) {
    const outlineIds = new Set(state.outlineNodes.map((item) => item.id));
    const threadIds = new Set(state.plotThreads.map((item) => item.id));
    const eventIds = new Set(state.timelineEvents.map((item) => item.id));
    for (const node of state.outlineNodes) {
      if (node.parentId && !outlineIds.has(node.parentId)) throw new Error(`Unknown outline parent id: ${node.parentId}`);
      if (node.parentId === node.id) throw new Error(`Outline node cannot parent itself: ${node.id}`);
      if (node.plotThreadIds.some((id) => !threadIds.has(id))) throw new Error(`Unknown plot thread id on outline node: ${node.id}`);
    }
    for (const node of state.outlineNodes) {
      const seen = new Set([node.id]);
      let cursor = node;
      while (cursor.parentId) {
        if (seen.has(cursor.parentId)) throw new Error(`Outline parent cycle detected at: ${node.id}`);
        seen.add(cursor.parentId);
        cursor = state.outlineNodes.find((item) => item.id === cursor.parentId);
        if (!cursor) break;
      }
    }
    for (const thread of state.plotThreads) {
      if (thread.outlineNodeIds.some((id) => !outlineIds.has(id))) throw new Error(`Unknown outline node id on plot thread: ${thread.id}`);
    }
    for (const event of state.timelineEvents) {
      if (event.outlineNodeId && !outlineIds.has(event.outlineNodeId)) throw new Error(`Unknown outline node id on timeline event: ${event.id}`);
      if (event.plotThreadIds.some((id) => !threadIds.has(id))) throw new Error(`Unknown plot thread id on timeline event: ${event.id}`);
    }
    for (const event of state.relationshipEvents) {
      if (!event.sourceId || !event.targetId || event.sourceId === event.targetId) throw new Error(`Relationship event requires two different character ids: ${event.id}`);
      if (event.outlineNodeId && !outlineIds.has(event.outlineNodeId)) throw new Error(`Unknown outline node id on relationship event: ${event.id}`);
      if (event.timelineEventId && !eventIds.has(event.timelineEventId)) throw new Error(`Unknown timeline event id on relationship event: ${event.id}`);
    }
  }

  function normalizeStoryState(value = {}, options = {}) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const state = {
      schemaVersion: STORY_STATE_SCHEMA_VERSION,
      outlineNodes: (Array.isArray(source.outlineNodes) ? source.outlineNodes : []).slice(0, 600).map(normalizeOutlineNode),
      plotThreads: (Array.isArray(source.plotThreads) ? source.plotThreads : []).slice(0, 200).map(normalizePlotThread),
      timelineEvents: (Array.isArray(source.timelineEvents) ? source.timelineEvents : []).slice(0, 2000).map(normalizeTimelineEvent),
      relationshipEvents: (Array.isArray(source.relationshipEvents) ? source.relationshipEvents : []).slice(0, 3000).map(normalizeRelationshipEvent),
      updatedAt: text(source.updatedAt, 40),
    };
    ensureUniqueIds(state.outlineNodes, "outline node");
    ensureUniqueIds(state.plotThreads, "plot thread");
    ensureUniqueIds(state.timelineEvents, "timeline event");
    ensureUniqueIds(state.relationshipEvents, "relationship event");
    if (options.validateReferences !== false) validateReferences(state);
    return state;
  }

  function relationshipKey(item) {
    return item.direction === "directed"
      ? `${item.sourceId}>${item.targetId}:${item.type}`
      : `${[item.sourceId, item.targetId].sort().join("|")}:${item.type}`;
  }

  function buildStoryStateProjection(stateValue) {
    const state = normalizeStoryState(stateValue, { validateReferences: false });
    const outlineNodes = state.outlineNodes.slice().sort((left, right) => left.order - right.order || left.title.localeCompare(right.title));
    const currentOutline = outlineNodes.find((item) => item.status === "active") ||
      outlineNodes.find((item) => item.status === "planned") ||
      outlineNodes.at(-1) || null;
    const currentRelationships = new Map();
    for (const event of state.relationshipEvents
      .slice()
      .sort((left, right) => left.sortKey - right.sortKey || String(left.updatedAt).localeCompare(String(right.updatedAt)))) {
      const key = relationshipKey(event);
      if (event.status === "canon") currentRelationships.set(key, event);
      if (event.status === "superseded" || event.status === "discarded") currentRelationships.delete(key);
    }
    return {
      ...state,
      currentOutline,
      activePlotThreads: state.plotThreads.filter((item) => item.status === "active" || item.status === "blocked"),
      currentRelationships: Array.from(currentRelationships.values()),
      counts: {
        outline: state.outlineNodes.length,
        activeOutline: state.outlineNodes.filter((item) => item.status === "active").length,
        plotThreads: state.plotThreads.length,
        openPlotThreads: state.plotThreads.filter((item) => !["resolved", "abandoned"].includes(item.status)).length,
        timelineEvents: state.timelineEvents.length,
        canonTimelineEvents: state.timelineEvents.filter((item) => item.status === "canon").length,
        relationships: currentRelationships.size,
      },
    };
  }

  function getStoryState(storyId) {
    if (!getStory(storyId)) throw new Error("Story not found");
    return normalizeStoryState(readJson(getStoryStateFile(storyId), {}), { validateReferences: false });
  }

  function getStoryStateView(storyId) {
    return buildStoryStateProjection(getStoryState(storyId));
  }

  function saveStoryState(storyId, value) {
    if (!getStory(storyId)) throw new Error("Story not found");
    const next = normalizeStoryState(value);
    next.updatedAt = new Date().toISOString();
    writeJson(getStoryStateFile(storyId), next);
    return buildStoryStateProjection(next);
  }

  return {
    buildStoryStateProjection,
    getStoryState,
    getStoryStateView,
    normalizeStoryState,
    saveStoryState,
  };
}

module.exports = {
  STORY_STATE_SCHEMA_VERSION,
  createStoryStateTools,
};
