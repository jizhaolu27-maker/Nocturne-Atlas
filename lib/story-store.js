const fs = require("fs");
const path = require("path");

function createStoryStore({
  DATA_DIR,
  CONFIG_DIR,
  LIBRARY_DIR,
  STORIES_DIR,
  DEFAULT_CONTEXT_BLOCKS,
  DEFAULT_SUMMARY_INTERVAL,
  DEFAULT_MAX_COMPLETION_TOKENS,
  safeId,
  slugify,
  getSyncStoryWorkspace,
}) {
  function normalizeStorageId(value, label = "Storage id") {
    const normalized = String(value || "").trim();
    if (!normalized) {
      throw new Error(`${label} is required`);
    }
    if (normalized === "." || normalized === "..") {
      throw new Error(`${label} is invalid`);
    }
    if (/[\\/:*?"<>|\x00-\x1f]/.test(normalized)) {
      throw new Error(`${label} contains invalid filename characters`);
    }
    return normalized;
  }

  function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
  }

  function ensureFile(filePath, fallback) {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, fallback);
    }
  }

  function readJson(filePath, fallback = null) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return fallback;
    }
  }

  function writeJson(filePath, value) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
  }

  function readJsonLines(filePath) {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      return [];
    }
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  function appendJsonLine(filePath, value) {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
  }

  function writeJsonLines(filePath, values) {
    ensureDir(path.dirname(filePath));
    const body = values.length ? `${values.map((item) => JSON.stringify(item)).join("\n")}\n` : "";
    fs.writeFileSync(filePath, body, "utf8");
  }

  function getProvidersFile() {
    return path.join(CONFIG_DIR, "providers.json");
  }

  function getAppConfigFile() {
    return path.join(CONFIG_DIR, "app.json");
  }

  function getStoriesIndexFile() {
    return path.join(STORIES_DIR, "index.json");
  }

  function getLibraryTypeDir(type) {
    const map = {
      characters: path.join(LIBRARY_DIR, "characters"),
      worldbooks: path.join(LIBRARY_DIR, "worldbooks"),
      styles: path.join(LIBRARY_DIR, "styles"),
    };
    return map[type];
  }

  function getStoryDir(storyId) {
    return path.join(STORIES_DIR, normalizeStorageId(storyId, "Story id"));
  }

  function getStoryFile(storyId) {
    return path.join(getStoryDir(storyId), "story.json");
  }

  function getStoryMessagesFile(storyId) {
    return path.join(getStoryDir(storyId), "messages.jsonl");
  }

  function getStoryWorkspaceDir(storyId, kind) {
    return path.join(getStoryDir(storyId), "workspace", kind);
  }

  function getStoryMemoryFile(storyId) {
    return path.join(getStoryDir(storyId), "memory", "records.jsonl");
  }

  function getStoryMemoryChunkFile(storyId) {
    return path.join(getStoryDir(storyId), "memory", "chunks.jsonl");
  }

  function getStoryKnowledgeEmbeddingFile(storyId) {
    return path.join(getStoryDir(storyId), "knowledge", "embeddings.json");
  }

  function getStoryProposalFile(storyId) {
    return path.join(getStoryDir(storyId), "proposals", "records.jsonl");
  }

  function getStorySnapshotFile(storyId) {
    return path.join(getStoryDir(storyId), "snapshots", "context.jsonl");
  }

  function listJsonFiles(dir) {
    ensureDir(dir);
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson(path.join(dir, entry.name)))
      .filter(Boolean)
      .sort((a, b) => String(a.name || a.title || "").localeCompare(String(b.name || b.title || "")));
  }

  function saveLibraryItem(type, item) {
    const dir = getLibraryTypeDir(type);
    if (!dir) {
      throw new Error(`Unsupported library type: ${type}`);
    }
    const nextId = item.id ? normalizeStorageId(item.id, "Library item id") : safeId(type.slice(0, -1));
    const payload = {
      ...item,
      id: nextId,
      updatedAt: new Date().toISOString(),
    };
    if (!payload.createdAt) {
      payload.createdAt = payload.updatedAt;
    }
    const filePath = path.join(dir, `${payload.id}.json`);
    writeJson(filePath, payload);
    return payload;
  }

  function deleteLibraryItem(type, id) {
    const dir = getLibraryTypeDir(type);
    if (!dir) {
      throw new Error(`Unsupported library type: ${type}`);
    }
    const filePath = path.join(dir, `${normalizeStorageId(id, "Library item id")}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error("Library item not found");
    }
    fs.unlinkSync(filePath);
  }

  function loadProviders() {
    return readJson(getProvidersFile(), []);
  }

  function saveProviders(providers) {
    writeJson(getProvidersFile(), providers);
  }

  function loadStoriesIndex() {
    return readJson(getStoriesIndexFile(), []);
  }

  function saveStoriesIndex(entries) {
    writeJson(getStoriesIndexFile(), entries);
  }

  function getStory(storyId) {
    return readJson(getStoryFile(storyId));
  }

  function saveStory(story) {
    writeJson(getStoryFile(story.id), story);
    const index = loadStoriesIndex();
    const next = [
      ...index.filter((entry) => entry.id !== story.id),
      {
        id: story.id,
        title: story.title,
        updatedAt: story.updatedAt,
        createdAt: story.createdAt,
      },
    ].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    saveStoriesIndex(next);
  }

  function deleteStory(storyId) {
    const storyDir = getStoryDir(storyId);
    if (fs.existsSync(storyDir)) {
      fs.rmSync(storyDir, { recursive: true, force: true });
    }
    const next = loadStoriesIndex().filter((entry) => entry.id !== storyId);
    saveStoriesIndex(next);
  }

  function createDefaultStory(payload = {}) {
    const storyId = `${slugify(payload.title || "new-story")}-${Date.now()}`;
    const now = new Date().toISOString();
    const story = {
      id: storyId,
      title: payload.title || "New Story",
      summary: payload.summary || "",
      providerId: payload.providerId || "",
      model: payload.model || "",
      promptConfig: {
        storySystemPrompt:
          payload.storySystemPrompt ||
          "Stay inside the active story canon. Use enabled character cards, worldbook entries, and style profile as authoritative references. If a new recurring character with stable traits, relationships, or clear future story importance is introduced, treat that as a candidate for a story-local workspace character card proposal rather than leaving the character only implicit in prose.",
        userPromptTemplate:
          payload.userPromptTemplate ||
          "User request:\n{{user_input}}\n\nRespond with the next story turn and keep continuity with the supplied memory.",
      },
      settings: {
        contextBlocks: payload.contextBlocks ?? DEFAULT_CONTEXT_BLOCKS,
        summaryInterval: payload.summaryInterval ?? DEFAULT_SUMMARY_INTERVAL,
        maxCompletionTokens: payload.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
        temperature: payload.temperature ?? 1,
        topP: payload.topP ?? 1,
        reasoningEffort: payload.reasoningEffort || "inherit",
        memoryRetrievalMode: "rag",
        knowledgeRetrievalMode: "rag",
        localEmbeddingMode: payload.localEmbeddingMode || "inherit",
      },
      enabled: {
        characters: payload.enabled?.characters || [],
        worldbooks: payload.enabled?.worldbooks || [],
        styles: payload.enabled?.styles || [],
      },
      contextStatus: {
        usedTokens: 0,
        maxTokens: 32000,
        usedBlocks: 0,
        maxBlocks: payload.contextBlocks ?? DEFAULT_CONTEXT_BLOCKS,
        pressureLevel: "low",
        forgetfulnessState: "normal",
        forgetfulnessReasons: [],
        forgetfulnessSignals: {
          pressure: [],
          omission: [],
          conflict: [],
        },
      },
      createdAt: now,
      updatedAt: now,
    };

    ensureDir(getStoryDir(storyId));
    ensureDir(path.join(getStoryDir(storyId), "memory"));
    ensureDir(path.join(getStoryDir(storyId), "knowledge"));
    ensureDir(path.join(getStoryDir(storyId), "proposals"));
    ensureDir(path.join(getStoryDir(storyId), "snapshots"));
    ensureDir(getStoryWorkspaceDir(storyId, "characters"));
    ensureDir(getStoryWorkspaceDir(storyId, "worldbooks"));
    ensureDir(getStoryWorkspaceDir(storyId, "styles"));
    saveStory(story);
    ensureFile(getStoryMessagesFile(storyId), "");
    ensureFile(getStoryMemoryFile(storyId), "");
    ensureFile(getStoryMemoryChunkFile(storyId), "");
    ensureFile(getStoryKnowledgeEmbeddingFile(storyId), "{}");
    ensureFile(getStoryProposalFile(storyId), "");
    ensureFile(getStorySnapshotFile(storyId), "");
    getSyncStoryWorkspace?.()?.syncStoryWorkspace(storyId);
    return story;
  }

  return {
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
    getStoryMemoryChunkFile,
    getStoryKnowledgeEmbeddingFile,
    getStoryProposalFile,
    getStorySnapshotFile,
    normalizeStorageId,
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
  };
}

module.exports = {
  createStoryStore,
};
