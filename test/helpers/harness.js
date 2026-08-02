const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createStoryStore } = require("../../lib/story-store");
const { createWorkspaceTools } = require("../../lib/workspace");
const { createContextTools } = require("../../lib/context");
const { createMemoryTools } = require("../../lib/memory");
const { createMemoryChunkTools } = require("../../lib/memory-chunks");
const { consolidateMemoryRecords } = require("../../lib/memory-consolidation");
const {
  createEmbeddingTools,
  normalizeEmbeddingConfig,
  normalizeEmbeddingMode,
  normalizeEmbeddingRemoteHost,
} = require("../../lib/embeddings");
const { createKnowledgeRetrievalTools } = require("../../lib/knowledge-retrieval");
const { buildMemoryQuery, selectRelevantMemoryRecords, formatMemoryContext } = require("../../lib/memory-engine");
const { createMemoryRetrievalTools } = require("../../lib/memory-retrieval");
const { createLocalVectorSearchItems, createLocalVectorSearchRecords } = require("../../lib/memory-vector");
const { createProposalTools } = require("../../lib/proposals");
const { createChatTools } = require("../../lib/chat");
const { createProviderTools } = require("../../lib/providers");
const { createServerConfigTools } = require("../../lib/server-config");
const { createGroundingCheckTools } = require("../../lib/grounding-check");
const { createKeyedSerialExecutor } = require("../../lib/keyed-serial");
const { createAuthTools } = require("../../lib/auth");
const { MEMORY_KEYWORD_VERSION, MEMORY_SCHEMA_VERSION, normalizeRuntimeMemoryState } = require("../../lib/memory-runtime");
const { STORY_STATE_SCHEMA_VERSION, createStoryStateTools } = require("../../lib/story-state");
const { createApiRouter } = require("../../lib/api-router");

const DEFAULT_CONTEXT_BLOCKS = 6;
const DEFAULT_SUMMARY_INTERVAL = 4;
const DEFAULT_MAX_COMPLETION_TOKENS = 900;

function summarizeText(value, maxLength) {
  const text = String(value || "").trim();
  if (!maxLength || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || `story-${Date.now()}`;
}

let idCounter = 0;
function safeId(prefix) {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-atlas-test-"));
}

function createStoreHarness(rootDir) {
  const DATA_DIR = path.join(rootDir, "data");
  const CONFIG_DIR = path.join(DATA_DIR, "config");
  const LIBRARY_DIR = path.join(DATA_DIR, "library");
  const STORIES_DIR = path.join(DATA_DIR, "stories");

  let workspaceTools = null;
  const storyStore = createStoryStore({
    DATA_DIR,
    CONFIG_DIR,
    LIBRARY_DIR,
    STORIES_DIR,
    DEFAULT_CONTEXT_BLOCKS,
    DEFAULT_SUMMARY_INTERVAL,
    DEFAULT_MAX_COMPLETION_TOKENS,
    safeId,
    slugify,
    getSyncStoryWorkspace: () => workspaceTools,
  });

  workspaceTools = createWorkspaceTools({
    getLibraryTypeDir: storyStore.getLibraryTypeDir,
    getStoryWorkspaceDir: storyStore.getStoryWorkspaceDir,
    getStory: storyStore.getStory,
    readJson: storyStore.readJson,
    writeJson: storyStore.writeJson,
    listJsonFiles: storyStore.listJsonFiles,
  });

  return {
    ...storyStore,
    workspaceTools,
  };
}

function buildMemoryTools(overrides = {}) {
  return createMemoryTools({
    DEFAULT_SUMMARY_INTERVAL,
    MEMORY_SUMMARY_CHAR_LIMIT: 160,
    classifyPressure: (usedTokens, maxTokens) => {
      const ratio = maxTokens ? usedTokens / maxTokens : 0;
      if (ratio >= 0.82) {
        return "high";
      }
      if (ratio >= 0.6) {
        return "medium";
      }
      return "low";
    },
    summarizeText,
    safeId,
    getProviderForStory: () => null,
    decryptSecret: () => "",
    callOpenAICompatible: async () => {
      throw new Error("Provider should not be called in smoke tests");
    },
    tryParseJsonObject: (value) => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    },
    ...overrides,
  });
}


module.exports = {
  assert,
  EventEmitter,
  fs,
  os,
  path,
  createStoryStore,
  createWorkspaceTools,
  createContextTools,
  createMemoryTools,
  createMemoryChunkTools,
  consolidateMemoryRecords,
  createEmbeddingTools,
  normalizeEmbeddingConfig,
  normalizeEmbeddingMode,
  normalizeEmbeddingRemoteHost,
  createKnowledgeRetrievalTools,
  buildMemoryQuery,
  selectRelevantMemoryRecords,
  formatMemoryContext,
  createMemoryRetrievalTools,
  createLocalVectorSearchItems,
  createLocalVectorSearchRecords,
  createProposalTools,
  createChatTools,
  createProviderTools,
  createServerConfigTools,
  createGroundingCheckTools,
  createKeyedSerialExecutor,
  createAuthTools,
  MEMORY_KEYWORD_VERSION,
  MEMORY_SCHEMA_VERSION,
  normalizeRuntimeMemoryState,
  STORY_STATE_SCHEMA_VERSION,
  createStoryStateTools,
  createApiRouter,
  DEFAULT_CONTEXT_BLOCKS,
  DEFAULT_SUMMARY_INTERVAL,
  DEFAULT_MAX_COMPLETION_TOKENS,
  summarizeText,
  slugify,
  safeId,
  createTempRoot,
  createStoreHarness,
  buildMemoryTools,
};
