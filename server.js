const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { createProviderTools } = require("./lib/providers");
const { createStoryStore } = require("./lib/story-store");
const { createWorkspaceTools } = require("./lib/workspace");
const { createContextTools } = require("./lib/context");
const { createMemoryTools } = require("./lib/memory");
const { createChatTools } = require("./lib/chat");
const { createEmbeddingTools, normalizeEmbeddingConfig, normalizeEmbeddingMode } = require("./lib/embeddings");
const { createKnowledgeRetrievalTools } = require("./lib/knowledge-retrieval");
const {
  extractKeywords,
  selectRelevantMemoryRecords,
  formatMemoryContext,
} = require("./lib/memory-engine");
const { createMemoryRetrievalTools } = require("./lib/memory-retrieval");
const { createLocalVectorSearchRecords } = require("./lib/memory-vector");
const { createProposalTools } = require("./lib/proposals");

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
  getStoryDir,
  getStoryFile,
  getStoryMessagesFile,
  getStoryWorkspaceDir,
  getStoryMemoryFile,
  getStoryKnowledgeEmbeddingFile,
  getStoryProposalFile,
  getStorySnapshotFile,
  listJsonFiles,
  saveLibraryItem,
  deleteLibraryItem,
  loadProviders,
  saveProviders,
  loadStoriesIndex,
  saveStoriesIndex,
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
  retrieveKnowledgeChunks,
  formatKnowledgeContext,
} = createKnowledgeRetrievalTools({
  embedText,
  extractKeywords,
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
  isVectorSearchEnabled: (options = {}) =>
    options.retrievalMode === "hybrid" &&
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
  buildQueryEmbedding: ({ userMessage, messages, workspace, embeddingOptions }) =>
    embedText(buildQueryEmbeddingText({ userMessage, messages, workspace }), embeddingOptions),
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
  buildMemoryEmbeddingText,
  resolveEmbeddingOptions: resolveStoryEmbeddingConfig,
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

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, data, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function notFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

function jsonResponse(status, data) {
  return { status, data };
}

function normalizeTheme(theme) {
  return theme === "light" ? "light" : "dark";
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function getProviderContextWindow(story) {
  const provider = getProviderForStory(story);
  return provider?.contextWindow || 32000;
}

function normalizeAppConfig(config = {}) {
  const memoryRetrievalMode = config.memoryRetrievalMode === "hybrid" ? "hybrid" : "lexical";
  const localEmbedding = normalizeEmbeddingConfig(config.localEmbedding || {});
  return {
    theme: normalizeTheme(config.theme),
    lastOpenedStoryId: String(config.lastOpenedStoryId || ""),
    globalSystemPrompt: String(config.globalSystemPrompt || DEFAULT_GLOBAL_SYSTEM_PROMPT),
    memoryRetrievalMode,
    localEmbedding,
  };
}

function collectDirStats(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    return { exists: false, fileCount: 0, totalBytes: 0 };
  }
  let fileCount = 0;
  let totalBytes = 0;
  const stack = [dirPath];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        fileCount += 1;
        totalBytes += fs.statSync(fullPath).size;
      }
    }
  }
  return { exists: true, fileCount, totalBytes };
}

function getLocalEmbeddingRuntimeStatus(config = {}) {
  const normalized = normalizeEmbeddingConfig(config.localEmbedding || config || {});
  let dependencyInstalled = false;
  try {
    require.resolve("@xenova/transformers");
    dependencyInstalled = true;
  } catch {
    dependencyInstalled = false;
  }
  const cacheStats = collectDirStats(normalized.cacheDir);
  return {
    dependencyInstalled,
    cacheDir: normalized.cacheDir,
    cacheExists: cacheStats.exists,
    cacheFileCount: cacheStats.fileCount,
    cacheSizeMB: Number((cacheStats.totalBytes / (1024 * 1024)).toFixed(2)),
    note:
      normalized.mode === "on" && !dependencyInstalled
        ? "Local embedding is enabled but the transformers package is unavailable."
        : normalized.mode === "on" && !cacheStats.exists
          ? "Local embedding is enabled. The model cache will populate on first neural embedding run."
          : normalized.mode === "off"
            ? "Local embedding is currently disabled."
            : "",
  };
}

async function prewarmLocalEmbeddingModel(config = {}) {
  const normalized = normalizeEmbeddingConfig(config.localEmbedding || config || {});
  const runtimeBefore = getLocalEmbeddingRuntimeStatus(normalized);
  if (!runtimeBefore.dependencyInstalled) {
    return {
      ok: false,
      warmed: false,
      message: "The local transformers dependency is not installed.",
      runtime: runtimeBefore,
    };
  }
  if (normalized.provider === "hash_v1") {
    return {
      ok: true,
      warmed: false,
      message: "The current local embedding provider is hash_v1, so there is no neural model cache to prewarm.",
      runtime: runtimeBefore,
    };
  }

  try {
    await embedText("Local embedding warmup for Nocturne Atlas.", {
      ...normalized,
      mode: "on",
      allowFallback: false,
    });
    return {
      ok: true,
      warmed: true,
      message: "Local embedding model prewarmed. The cache should now be ready for hybrid retrieval and local RAG.",
      runtime: getLocalEmbeddingRuntimeStatus(normalized),
    };
  } catch (error) {
    return {
      ok: false,
      warmed: false,
      message: error?.message || "Failed to prewarm the local embedding model.",
      runtime: getLocalEmbeddingRuntimeStatus(normalized),
    };
  }
}

function resolveStoryEmbeddingConfig(story) {
  const appConfig = normalizeAppConfig(readJson(getAppConfigFile(), {}));
  const storyMode = normalizeEmbeddingMode(story?.settings?.localEmbeddingMode || "inherit", "inherit");
  const appMode = normalizeEmbeddingMode(appConfig.localEmbedding?.mode || "off", "off");
  return normalizeEmbeddingConfig({
    ...(appConfig.localEmbedding || {}),
    mode: storyMode === "inherit" ? appMode : storyMode,
  });
}

const {
  handleChat,
  handleChatStream,
  reviseLastExchange,
  buildStoryPreview,
} = createChatTools({
  safeId,
  summarizeText,
  jsonResponse,
  sendJson,
  getAppConfig: () => normalizeAppConfig(readJson(getAppConfigFile(), {})),
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
        memoryRetrievalMode: "lexical",
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

function getStaticFile(filePath) {
  const fullPath = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    return null;
  }
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    return fullPath;
  }
  return null;
}

function serveStatic(req, res) {
  let pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/") {
    pathname = "/index.html";
  }
  const filePath = getStaticFile(pathname);
  if (!filePath) {
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentTypeMap = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };
  sendText(res, 200, fs.readFileSync(filePath, "utf8"), contentTypeMap[ext] || "text/plain; charset=utf-8");
  return true;
}

async function routeApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment, index) => (index === 0 ? segment : decodePathSegment(segment)));
  if (segments[0] !== "api") {
    return false;
  }

  try {
    if (req.method === "GET" && segments[1] === "bootstrap") {
      const stories = loadStoriesIndex().map((entry) => getStory(entry.id)).filter(Boolean);
      const providers = loadProviders().map((provider) => ({
        ...provider,
        encryptedApiKey: provider.encryptedApiKey ? { masked: true, decryptable: canDecryptSecret(provider.encryptedApiKey) } : null,
      }));
      const libraries = {
        characters: listJsonFiles(getLibraryTypeDir("characters")),
        worldbooks: listJsonFiles(getLibraryTypeDir("worldbooks")),
        styles: listJsonFiles(getLibraryTypeDir("styles")),
      };
      return sendJson(res, 200, {
        appConfig: {
          ...normalizeAppConfig(readJson(getAppConfigFile(), {})),
          localEmbeddingRuntime: getLocalEmbeddingRuntimeStatus(readJson(getAppConfigFile(), {})),
        },
        providers,
        stories,
        libraries,
      });
    }

    if (req.method === "POST" && segments[1] === "app-config") {
      const body = await parseBody(req);
      const current = normalizeAppConfig(readJson(getAppConfigFile(), {}));
      const next = normalizeAppConfig({
        ...current,
        ...body,
      });
      writeJson(getAppConfigFile(), next);
      return sendJson(res, 200, {
        ...next,
        localEmbeddingRuntime: getLocalEmbeddingRuntimeStatus(next),
      });
    }

    if (req.method === "POST" && segments[1] === "local-embedding" && segments[2] === "prewarm") {
      const appConfig = normalizeAppConfig(readJson(getAppConfigFile(), {}));
      const result = await prewarmLocalEmbeddingModel(appConfig);
      return sendJson(res, result.ok ? 200 : 500, result);
    }

    if (segments[1] === "providers") {
      if (req.method === "GET") {
        const providers = loadProviders().map((provider) => ({
          ...provider,
          encryptedApiKey: provider.encryptedApiKey ? { masked: true, decryptable: canDecryptSecret(provider.encryptedApiKey) } : null,
        }));
        return sendJson(res, 200, providers);
      }
      if (req.method === "POST" && segments[2] === "test") {
        const body = await parseBody(req);
        const providers = loadProviders();
        const provider = providers.find((item) => item.id === body.id);
        if (!provider) {
          return notFound(res);
        }
        const result = await testProviderConnection(provider, body.model);
        return sendJson(res, result.ok ? 200 : 400, result);
      }
      if (req.method === "POST") {
        const body = await parseBody(req);
        const providers = loadProviders();
        const existing = providers.find((item) => item.id === body.id);
        const payload = {
          id: body.id || safeId("provider"),
          name: body.name || "Custom Provider",
          baseUrl: body.baseUrl || "",
          model: body.model || "",
          contextWindow: Number.isFinite(Number(body.contextWindow)) ? Number(body.contextWindow) : 32000,
          params: {
            temperature: body.params?.temperature ?? 0.85,
            topP: body.params?.topP ?? 1,
            maxCompletionTokens: body.params?.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
          },
          encryptedApiKey: body.apiKey ? encryptSecret(body.apiKey) : existing?.encryptedApiKey || null,
          updatedAt: new Date().toISOString(),
          createdAt: existing?.createdAt || new Date().toISOString(),
        };
        const next = [...providers.filter((item) => item.id !== payload.id), payload];
        saveProviders(next);
        return sendJson(res, 200, {
          ...payload,
          encryptedApiKey: payload.encryptedApiKey
            ? { masked: true, decryptable: canDecryptSecret(payload.encryptedApiKey) }
            : null,
        });
      }
    }

    if (segments[1] === "library" && segments[2]) {
      const type = segments[2];
      if (!isSupportedLibraryType(type)) {
        return sendJson(res, 400, { error: "Unsupported library type" });
      }
      if (req.method === "GET") {
        return sendJson(res, 200, listJsonFiles(getLibraryTypeDir(type)));
      }
      if (req.method === "POST") {
        const body = await parseBody(req);
        const item = saveLibraryItem(type, body);
        return sendJson(res, 200, item);
      }
      if (req.method === "DELETE" && segments[3]) {
        try {
          deleteLibraryItem(type, segments[3]);
        } catch (error) {
          if (error.message === "Library item not found") {
            return notFound(res);
          }
          throw error;
        }
        return sendJson(res, 200, { ok: true });
      }
    }

    if (segments[1] === "stories") {
      if (req.method === "GET" && segments.length === 2) {
        const stories = loadStoriesIndex().map((entry) => getStory(entry.id)).filter(Boolean);
        return sendJson(res, 200, stories);
      }
      if (req.method === "POST" && segments.length === 2) {
        const body = await parseBody(req);
        const story = createDefaultStory(body);
        return sendJson(res, 200, story);
      }
      if (segments[2]) {
        const storyId = segments[2];
        if (req.method === "DELETE" && segments.length === 3) {
          const story = getStory(storyId);
          if (!story) {
            return notFound(res);
          }
          deleteStory(storyId);
          return sendJson(res, 200, { ok: true, deletedId: storyId });
        }
        if (req.method === "GET" && segments.length === 3) {
          try {
            return sendJson(res, 200, await buildStoryPreview(storyId));
          } catch (error) {
            if (error.message === "Story not found") {
              return notFound(res);
            }
            throw error;
          }
        }
        if (req.method === "POST" && segments[3] === "config") {
          const body = await parseBody(req);
          const story = getStory(storyId);
          if (!story) {
            return notFound(res);
          }
          const nextPromptConfig = {
            ...story.promptConfig,
            ...((body.promptConfig || {})),
          };
          delete nextPromptConfig.globalSystemPrompt;
          const next = {
            ...story,
            ...body,
            promptConfig: nextPromptConfig,
            settings: { ...story.settings, ...(body.settings || {}) },
            enabled: { ...story.enabled, ...(body.enabled || {}) },
            updatedAt: new Date().toISOString(),
          };
          saveStory(next);
          syncStoryWorkspace(storyId);
          return sendJson(res, 200, next);
        }
        if (req.method === "POST" && segments[3] === "chat" && segments[4] === "revise-last") {
          const result = await reviseLastExchange(storyId, (await parseBody(req)).message);
          return sendJson(res, result.status, result.data);
        }
        if (req.method === "POST" && segments[3] === "chat" && segments[4] === "stream") {
          await handleChatStream(req, res, storyId, await parseBody(req));
          return true;
        }
        if (req.method === "POST" && segments[3] === "chat" && segments.length === 4) {
          const result = await handleChat(storyId, await parseBody(req));
          return sendJson(res, result.status, result.data);
        }
        if (req.method === "POST" && segments[3] === "proposals" && segments[4]) {
          const body = await parseBody(req);
          try {
            reviewProposal(storyId, segments[4], body.action, body.note || "");
          } catch (error) {
            const status =
              error.message === "Proposal not found"
                ? 404
                : error.message === "Proposal has already been reviewed"
                  ? 409
                  : 400;
            return sendJson(res, status, { error: error.message });
          }
          return sendJson(res, 200, { ok: true });
        }
      }
    }

    return notFound(res);
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Internal server error" });
  }
}

initializeData();

const server = http.createServer(async (req, res) => {
  const handledApi = await routeApi(req, res);
  if (handledApi !== false) {
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
