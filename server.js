const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createProviderTools } = require("./lib/providers");
const { createStoryStore } = require("./lib/story-store");
const { createWorkspaceTools } = require("./lib/workspace");
const { createContextTools } = require("./lib/context");
const { createMemoryTools } = require("./lib/memory");
const { createChatTools } = require("./lib/chat");
const { createGroundingCheckTools } = require("./lib/grounding-check");
const { buildEmbeddingSignature, createEmbeddingTools, normalizeEmbeddingConfig, normalizeEmbeddingMode } = require("./lib/embeddings");
const { createKnowledgeRetrievalTools } = require("./lib/knowledge-retrieval");
const {
  extractKeywords,
  selectRelevantMemoryRecords,
  formatMemoryContext,
} = require("./lib/memory-engine");
const { createMemoryRetrievalTools } = require("./lib/memory-retrieval");
const { createLocalVectorSearchItems, createLocalVectorSearchRecords } = require("./lib/memory-vector");
const { createProposalTools } = require("./lib/proposals");
const { createStaticHandler, jsonResponse, notFound, parseBody, sendJson } = require("./lib/http");
const { createServerConfigTools } = require("./lib/server-config");
const { createApiRouter } = require("./lib/api-router");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");
const CONFIG_DIR = path.join(DATA_DIR, "config");
const LIBRARY_DIR = path.join(DATA_DIR, "library");
const STORIES_DIR = path.join(DATA_DIR, "stories");

const DEFAULT_CONTEXT_BLOCKS = 20;
const DEFAULT_SUMMARY_INTERVAL = 20;
const MEMORY_SUMMARY_CHAR_LIMIT = 160;
const PROPOSAL_REASON_CHAR_LIMIT = 90;
const CHARACTER_ROLE_CHAR_LIMIT = 40;
const CHARACTER_TRAIT_CHAR_LIMIT = 24;
const CHARACTER_RELATIONSHIP_CHAR_LIMIT = 80;
const CHARACTER_ARC_CHAR_LIMIT = 140;
const CHARACTER_NOTES_CHAR_LIMIT = 120;
const DEFAULT_MAX_COMPLETION_TOKENS = 120000;
const DEFAULT_GLOBAL_SYSTEM_PROMPT =
  "You are a collaborative fiction engine. Continue the story with consistency, emotional continuity, and scene-level specificity.";

let workspaceTools = null;
const {
  embedText,
  embedTextDetailed,
  buildMemoryEmbeddingText,
  buildQueryEmbeddingText,
} = createEmbeddingTools();

const {
  ensureDir,
  ensureFile,
  readJson,
  writeJson,
  readJsonLines,
  appendJsonLine,
  writeJsonLines,
  getProvidersFile,
  getAppConfigFile,
  getStoriesIndexFile,
  getLibraryTypeDir,
  getStoryMessagesFile,
  getStoryWorkspaceDir,
  getStoryMemoryFile,
  getStoryMemoryChunkFile,
  getStoryKnowledgeChunkFile,
  getStoryKnowledgeEmbeddingFile,
  getStoryProposalFile,
  getStorySnapshotFile,
  listJsonFiles,
  saveLibraryItem,
  deleteLibraryItem,
  loadProviders,
  saveProviders,
  loadStoriesIndex,
  getStory,
  saveStory,
  deleteStory,
  createDefaultStory,
} = createStoryStore({
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

const {
  buildNextStoryEnabled,
  buildNextStoryPromptConfig,
  buildNextStorySettings,
  getAppConfig,
  getLocalEmbeddingRuntimeStatus,
  isSupportedLibraryType,
  mergeAppConfigPatch,
  prewarmLocalEmbeddingModel,
  resolveStoryEmbeddingConfig,
} = createServerConfigTools({
  readJson,
  getAppConfigFile,
  normalizeEmbeddingConfig,
  normalizeEmbeddingMode,
  embedText,
  embedTextDetailed,
  DEFAULT_GLOBAL_SYSTEM_PROMPT,
});

const {
  serveStatic,
} = createStaticHandler({
  publicDir: PUBLIC_DIR,
});

const {
  retrieveKnowledgeChunks,
  formatKnowledgeContext,
} = createKnowledgeRetrievalTools({
  embedText,
  embedTextDetailed,
  extractKeywords,
  loadKnowledgeChunkIndex: (storyId) => readJsonLines(getStoryKnowledgeChunkFile(storyId)),
  saveKnowledgeChunkIndex: (storyId, value) => writeJsonLines(getStoryKnowledgeChunkFile(storyId), value),
  loadKnowledgeEmbeddingCache: (storyId) => readJson(getStoryKnowledgeEmbeddingFile(storyId), {}),
  saveKnowledgeEmbeddingCache: (storyId, value) => writeJson(getStoryKnowledgeEmbeddingFile(storyId), value),
});

workspaceTools = createWorkspaceTools({
  getLibraryTypeDir,
  getStoryWorkspaceDir,
  getStory,
  readJson,
  writeJson,
  listJsonFiles,
});

const {
  syncStoryWorkspace,
  loadActiveWorkspaceItems,
} = workspaceTools;

const {
  formatMemoryContext: formatRetrievedMemoryContext,
  selectRelevantMemoryRecords: selectMemoryRecords,
} = createMemoryRetrievalTools({
  selectRelevantMemoryRecords,
  formatMemoryContext,
  vectorSearchRecords: createLocalVectorSearchRecords(),
  vectorSearchItems: createLocalVectorSearchItems(),
  isVectorSearchEnabled: (options = {}) =>
    options.embeddingOptions?.mode === "on" &&
    Array.isArray(options.queryEmbedding) &&
    options.queryEmbedding.length > 0,
});

const {
  buildContextBlocks,
  classifyPressure,
  getDefaultContextStatus,
} = createContextTools({
  DEFAULT_CONTEXT_BLOCKS,
  estimateTokens,
  selectRelevantMemoryRecords: selectMemoryRecords,
  formatMemoryContext: formatRetrievedMemoryContext,
  getProviderContextWindow,
  buildQueryEmbedding: async ({ userMessage, messages, workspace, embeddingOptions }) => {
    const result = await embedTextDetailed(buildQueryEmbeddingText({ userMessage, messages, workspace }), embeddingOptions);
    return {
      ...result,
      signature: buildEmbeddingSignature(result?.provider, result?.model),
    };
  },
  retrieveKnowledgeChunks,
  formatKnowledgeContext,
});

const {
  encryptSecret,
  decryptSecret,
  canDecryptSecret,
  getProviderForStory,
  buildEndpointUrl,
  callOpenAICompatible,
  streamOpenAICompatible,
  testProviderConnection,
} = createProviderTools({
  CONFIG_DIR,
  readJson,
  writeJson,
  loadProviders,
  summarizeText,
});

const {
  detectForgetfulness,
  getSummaryTriggers,
  getSummarySchedule,
  buildTransientMemoryCandidate,
  generateMemoryUpdate,
} = createMemoryTools({
  DEFAULT_SUMMARY_INTERVAL,
  MEMORY_SUMMARY_CHAR_LIMIT,
  classifyPressure,
  summarizeText,
  safeId,
  getProviderForStory,
  decryptSecret,
  callOpenAICompatible,
  tryParseJsonObject,
  embedText,
  embedTextDetailed,
  buildMemoryEmbeddingText,
  buildEmbeddingSignature,
  resolveEmbeddingOptions: resolveStoryEmbeddingConfig,
});

const {
  evaluateAssistantGrounding,
} = createGroundingCheckTools({
  summarizeText,
});

const {
  generateProposalUpdate,
  reviewProposal,
} = createProposalTools({
  PROPOSAL_REASON_CHAR_LIMIT,
  CHARACTER_ROLE_CHAR_LIMIT,
  CHARACTER_TRAIT_CHAR_LIMIT,
  CHARACTER_RELATIONSHIP_CHAR_LIMIT,
  CHARACTER_ARC_CHAR_LIMIT,
  CHARACTER_NOTES_CHAR_LIMIT,
  safeId,
  slugify,
  summarizeText,
  getProviderForStory,
  decryptSecret,
  callOpenAICompatible,
  tryParseJsonObject,
  readJson,
  writeJson,
  readJsonLines,
  writeJsonLines,
  getStory,
  saveStory,
  getStoryProposalFile,
  getStoryWorkspaceDir,
  syncStoryWorkspace,
});

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || `story-${Date.now()}`;
}

function safeId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function summarizeText(text, maxLength = 180) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  if (maxLength <= 3) {
    return cleaned.slice(0, maxLength);
  }
  const softLimit = maxLength - 3;
  const head = cleaned.slice(0, softLimit);
  const punctuationIndexes = ["\u3002", "\uff01", "\uff1f", "\uff1b", ".", "!", "?", ";", "\uff0c", ",", "\u3001", "\uff1a", ":"]
    .map((mark) => head.lastIndexOf(mark))
    .filter((index) => index >= 0);
  const bestPunctuationIndex = punctuationIndexes.length ? Math.max(...punctuationIndexes) : -1;
  if (bestPunctuationIndex >= Math.floor(softLimit * 0.6)) {
    return `${head.slice(0, bestPunctuationIndex + 1).trim()}...`;
  }
  const lastSpaceIndex = head.lastIndexOf(" ");
  if (lastSpaceIndex >= Math.floor(softLimit * 0.6)) {
    return `${head.slice(0, lastSpaceIndex).trim()}...`;
  }
  return `${head.trim()}...`;
}

function tryParseJsonObject(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function getProviderContextWindow(story) {
  const provider = getProviderForStory(story);
  return provider?.contextWindow || 32000;
}

const {
  handleChat,
  handleChatStream,
  prepareReviseLastExchange,
  reviseLastExchange,
  buildStoryPreview,
} = createChatTools({
  safeId,
  summarizeText,
  jsonResponse,
  sendJson,
  getAppConfig,
  getStory,
  saveStory,
  getProviderForStory,
  decryptSecret,
  syncStoryWorkspace,
  loadActiveWorkspaceItems,
  readJsonLines,
  appendJsonLine,
  writeJson,
  writeJsonLines,
  getStoryMessagesFile,
  getStoryMemoryFile,
  getStoryMemoryChunkFile,
  getStoryProposalFile,
  getStorySnapshotFile,
  getStoryWorkspaceDir,
  getDefaultContextStatus,
  buildContextBlocks,
  classifyPressure,
  getSummaryTriggers,
  getSummarySchedule,
  buildTransientMemoryCandidate,
  generateMemoryUpdate,
  generateProposalUpdate,
  detectForgetfulness,
  evaluateAssistantGrounding,
  buildEndpointUrl,
  callOpenAICompatible,
  streamOpenAICompatible,
});

function initializeData() {
  ensureDir(DATA_DIR);
  ensureDir(CONFIG_DIR);
  ensureDir(LIBRARY_DIR);
  ensureDir(STORIES_DIR);
  ensureDir(path.join(LIBRARY_DIR, "characters"));
  ensureDir(path.join(LIBRARY_DIR, "worldbooks"));
  ensureDir(path.join(LIBRARY_DIR, "styles"));

  ensureFile(getProvidersFile(), "[]");
  ensureFile(
    getAppConfigFile(),
    JSON.stringify(
      {
        theme: "dark",
        lastOpenedStoryId: "",
        globalSystemPrompt: DEFAULT_GLOBAL_SYSTEM_PROMPT,
        localEmbedding: {
          mode: "off",
          provider: "transformers_local",
          model: "Xenova/all-MiniLM-L6-v2",
          dimensions: 384,
        },
      },
      null,
      2
    )
  );
  ensureFile(getStoriesIndexFile(), "[]");

  const seedCharacter = path.join(LIBRARY_DIR, "characters", "hero_lyra.json");
  const seedWorld = path.join(LIBRARY_DIR, "worldbooks", "world_skyrail.json");
  const seedStyle = path.join(LIBRARY_DIR, "styles", "style_luminous.json");

  if (!fs.existsSync(seedCharacter)) {
    writeJson(seedCharacter, {
      id: "hero_lyra",
      name: "Lyra Wen",
      version: 1,
      core: { role: "Protagonist courier mage", age: 19, background: "Raised in the rain markets under the Skyrail." },
      traits: ["curious", "reckless", "soft-hearted"],
      relationships: { "Master Qiao": "mentor", "Jun Ash": "rival-ally" },
      arcState: { current: "Still doubts whether she deserves the map-key inheritance." },
      notes: "A silver compass warms when lost memories surface.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  if (!fs.existsSync(seedWorld)) {
    writeJson(seedWorld, {
      id: "world_skyrail",
      title: "Skyrail Commonwealth",
      category: "setting",
      rules: ["Memory can be distilled into amber", "Never cross an unlicensed sky-bridge during red storm alerts"],
      content: "A chain of market-cities hanging from ancient rails above a drowned continent.",
      revealedFacts: ["The drowned continent still sends up radio signals at night."],
      storyState: "Peace is brittle after the Archive Fire.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  if (!fs.existsSync(seedStyle)) {
    writeJson(seedStyle, {
      id: "style_luminous",
      name: "Luminous Adventure",
      tone: "wistful yet vivid",
      voice: "close third person with sensory detail",
      pacing: "scene-forward with emotional pauses",
      dos: ["Use concrete imagery", "Keep dialogue emotionally loaded"],
      donts: ["Avoid meta commentary", "Do not flatten tension too early"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
}

const {
  routeApi,
} = createApiRouter({
  parseBody,
  sendJson,
  notFound,
  loadStoriesIndex,
  getStory,
  loadProviders,
  saveProviders,
  canDecryptSecret,
  encryptSecret,
  testProviderConnection,
  listJsonFiles,
  getLibraryTypeDir,
  saveLibraryItem,
  deleteLibraryItem,
  createDefaultStory,
  saveStory,
  deleteStory,
  syncStoryWorkspace,
  handleChat,
  handleChatStream,
  prepareReviseLastExchange,
  reviseLastExchange,
  buildStoryPreview,
  reviewProposal,
  safeId,
  getAppConfig,
  mergeAppConfigPatch,
  getLocalEmbeddingRuntimeStatus,
  prewarmLocalEmbeddingModel,
  buildNextStoryPromptConfig,
  buildNextStorySettings,
  buildNextStoryEnabled,
  isSupportedLibraryType,
  writeJson,
  getAppConfigFile,
  DEFAULT_MAX_COMPLETION_TOKENS,
});

initializeData();

const server = http.createServer(async (req, res) => {
  if (await routeApi(req, res)) {
    return;
  }
  if (serveStatic(req, res)) {
    return;
  }
  notFound(res);
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`Story generator running at http://localhost:${port}`);
});
