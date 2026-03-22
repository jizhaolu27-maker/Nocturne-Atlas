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
const {
  selectRelevantMemoryRecords,
  formatMemoryContext,
} = require("./lib/memory-engine");
const { createProposalTools } = require("./lib/proposals");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");
const CONFIG_DIR = path.join(DATA_DIR, "config");
const LIBRARY_DIR = path.join(DATA_DIR, "library");
const STORIES_DIR = path.join(DATA_DIR, "stories");

const DEFAULT_CONTEXT_BLOCKS = 30;
const DEFAULT_SUMMARY_INTERVAL = 8;
const MEMORY_SUMMARY_CHAR_LIMIT = 160;
const PROPOSAL_REASON_CHAR_LIMIT = 90;
const CHARACTER_ROLE_CHAR_LIMIT = 40;
const CHARACTER_TRAIT_CHAR_LIMIT = 24;
const CHARACTER_RELATIONSHIP_CHAR_LIMIT = 80;
const CHARACTER_ARC_CHAR_LIMIT = 140;
const CHARACTER_NOTES_CHAR_LIMIT = 120;
const DEFAULT_MAX_COMPLETION_TOKENS = 900;

let workspaceTools = null;

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
  buildContextBlocks,
  classifyPressure,
  getDefaultContextStatus,
} = createContextTools({
  DEFAULT_CONTEXT_BLOCKS,
  estimateTokens,
  selectRelevantMemoryRecords,
  formatMemoryContext,
  getProviderContextWindow,
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
});

const {
  detectForgetfulness,
  getSummaryTriggers,
  getSummarySchedule,
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
  const punctuationIndexes = ["。", "！", "？", "；", ".", "!", "?", ";", "，", ",", "、", "：", ":"]
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
  getStory,
  saveStory,
  getProviderForStory,
  decryptSecret,
  syncStoryWorkspace,
  loadActiveWorkspaceItems,
  readJsonLines,
  appendJsonLine,
  writeJsonLines,
  getStoryMessagesFile,
  getStoryMemoryFile,
  getStoryProposalFile,
  getStorySnapshotFile,
  getDefaultContextStatus,
  buildContextBlocks,
  classifyPressure,
  getSummaryTriggers,
  getSummarySchedule,
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
  ensureFile(getAppConfigFile(), JSON.stringify({ theme: "dark", lastOpenedStoryId: "" }, null, 2));
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
        appConfig: readJson(getAppConfigFile(), {}),
        providers,
        stories,
        libraries,
      });
    }

    if (req.method === "POST" && segments[1] === "app-config") {
      const body = await parseBody(req);
      const current = readJson(getAppConfigFile(), {});
      const next = {
        ...current,
        ...body,
        theme: normalizeTheme(body.theme ?? current.theme),
      };
      writeJson(getAppConfigFile(), next);
      return sendJson(res, 200, next);
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
            return sendJson(res, 200, buildStoryPreview(storyId));
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
          const next = {
            ...story,
            ...body,
            promptConfig: { ...story.promptConfig, ...(body.promptConfig || {}) },
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
