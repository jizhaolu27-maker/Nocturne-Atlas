const fs = require("fs");
const path = require("path");

function createServerConfigTools({
  readJson,
  getAppConfigFile,
  normalizeEmbeddingConfig,
  normalizeEmbeddingMode,
  embedText,
  embedTextDetailed,
  DEFAULT_GLOBAL_SYSTEM_PROMPT,
}) {
  function normalizeTheme(theme) {
    return theme === "light" ? "light" : "dark";
  }

  function normalizeAppConfig(config = {}) {
    const localEmbedding = normalizeEmbeddingConfig(config.localEmbedding || {});
    return {
      theme: normalizeTheme(config.theme),
      lastOpenedStoryId: String(config.lastOpenedStoryId || ""),
      globalSystemPrompt: String(config.globalSystemPrompt || DEFAULT_GLOBAL_SYSTEM_PROMPT),
      memoryRetrievalMode: "rag",
      knowledgeRetrievalMode: "rag",
      localEmbedding,
    };
  }

  function getAppConfig() {
    return normalizeAppConfig(readJson(getAppConfigFile(), {}));
  }

  function isSafeStorageId(value) {
    const normalized = String(value || "").trim();
    return Boolean(
      normalized &&
        normalized !== "." &&
        normalized !== ".." &&
        !/[\\/:*?"<>|\x00-\x1f]/.test(normalized)
    );
  }

  function isSupportedLibraryType(type) {
    return ["characters", "worldbooks", "styles"].includes(String(type || ""));
  }

  function normalizeIdArray(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    return Array.from(
      new Set(
        value
          .map((item) => String(item || "").trim())
          .filter((item) => isSafeStorageId(item))
      )
    );
  }

  function buildNextStorySettings(story, settings = {}) {
    const next = { ...(story.settings || {}) };
    if (settings.contextBlocks != null && Number.isFinite(Number(settings.contextBlocks))) {
      next.contextBlocks = Number(settings.contextBlocks);
    }
    if (settings.summaryInterval != null && Number.isFinite(Number(settings.summaryInterval))) {
      next.summaryInterval = Number(settings.summaryInterval);
    }
    if (settings.maxCompletionTokens != null && Number.isFinite(Number(settings.maxCompletionTokens))) {
      next.maxCompletionTokens = Number(settings.maxCompletionTokens);
    }
    if (settings.temperature != null && Number.isFinite(Number(settings.temperature))) {
      next.temperature = Number(settings.temperature);
    }
    if (settings.topP != null && Number.isFinite(Number(settings.topP))) {
      next.topP = Number(settings.topP);
    }
    if (["inherit", "minimal", "low", "medium", "high"].includes(String(settings.reasoningEffort || ""))) {
      next.reasoningEffort = String(settings.reasoningEffort);
    }
    next.memoryRetrievalMode = "rag";
    next.knowledgeRetrievalMode = "rag";
    if (["inherit", "on", "off"].includes(String(settings.localEmbeddingMode || ""))) {
      next.localEmbeddingMode = String(settings.localEmbeddingMode);
    }
    return next;
  }

  function buildNextStoryEnabled(story, enabled = {}) {
    const current = story.enabled || {};
    const next = {
      characters: Array.isArray(current.characters) ? [...current.characters] : [],
      worldbooks: Array.isArray(current.worldbooks) ? [...current.worldbooks] : [],
      styles: Array.isArray(current.styles) ? [...current.styles] : [],
    };
    if (Object.prototype.hasOwnProperty.call(enabled, "characters")) {
      next.characters = normalizeIdArray(enabled.characters);
    }
    if (Object.prototype.hasOwnProperty.call(enabled, "worldbooks")) {
      next.worldbooks = normalizeIdArray(enabled.worldbooks);
    }
    if (Object.prototype.hasOwnProperty.call(enabled, "styles")) {
      next.styles = normalizeIdArray(enabled.styles);
    }
    return next;
  }

  function buildNextStoryPromptConfig(story, promptConfig = {}) {
    const next = {
      ...(story.promptConfig || {}),
    };
    if (promptConfig.storySystemPrompt != null) {
      next.storySystemPrompt = String(promptConfig.storySystemPrompt);
    }
    if (promptConfig.userPromptTemplate != null) {
      next.userPromptTemplate = String(promptConfig.userPromptTemplate);
    }
    delete next.globalSystemPrompt;
    return next;
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
    const neuralConfigured = normalized.mode === "on" && normalized.provider === "transformers_local";
    return {
      mode: normalized.mode,
      configuredProvider: normalized.provider,
      configuredModel: normalized.provider === "hash_v1" ? "hash_v1" : normalized.model,
      remoteHost: normalized.remoteHost || "",
      dependencyInstalled,
      cacheDir: normalized.cacheDir,
      cacheExists: cacheStats.exists,
      cacheFileCount: cacheStats.fileCount,
      cacheSizeMB: Number((cacheStats.totalBytes / (1024 * 1024)).toFixed(2)),
      neuralReady: neuralConfigured && dependencyInstalled && cacheStats.exists,
      note:
        normalized.mode === "on" && !dependencyInstalled
          ? "Local embedding is enabled but the transformers package is unavailable."
          : normalized.mode === "on" && normalized.provider === "hash_v1"
            ? "Local embedding is enabled in deterministic hash mode only."
          : normalized.mode === "on" && !cacheStats.exists
            ? "Local embedding is enabled, but the neural model cache is not ready yet. If model loading fails, the app may fall back to hash vectors."
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
      const result =
        typeof embedTextDetailed === "function"
          ? await embedTextDetailed("Local embedding warmup for Nocturne Atlas.", {
              ...normalized,
              mode: "on",
              allowFallback: false,
            })
          : {
              vector: await embedText("Local embedding warmup for Nocturne Atlas.", {
                ...normalized,
                mode: "on",
                allowFallback: false,
              }),
              provider: normalized.provider,
              model: normalized.model,
              fallbackUsed: false,
              error: "",
            };
      if (!Array.isArray(result?.vector) || !result.vector.length || result.provider !== "transformers_local") {
        return {
          ok: false,
          warmed: false,
          message:
            result?.error ||
            "The local neural embedding model did not return a usable vector. The app will keep using fallback vectors when allowed.",
          runtime: getLocalEmbeddingRuntimeStatus(normalized),
          activeProvider: result?.provider || normalized.provider,
          activeModel: result?.model || normalized.model,
          fallbackUsed: Boolean(result?.fallbackUsed),
        };
      }
      return {
        ok: true,
        warmed: true,
        message: "Local embedding model prewarmed. Neural embeddings are ready for hybrid retrieval and local RAG.",
        runtime: getLocalEmbeddingRuntimeStatus(normalized),
        activeProvider: result.provider,
        activeModel: result.model,
        fallbackUsed: Boolean(result.fallbackUsed),
      };
    } catch (error) {
      return {
        ok: false,
        warmed: false,
        message: error?.message || "Failed to prewarm the local embedding model.",
        runtime: getLocalEmbeddingRuntimeStatus(normalized),
        activeProvider: normalized.provider,
        activeModel: normalized.provider === "hash_v1" ? "hash_v1" : normalized.model,
        fallbackUsed: false,
      };
    }
  }

  function resolveStoryEmbeddingConfig(story) {
    const appConfig = getAppConfig();
    const storyMode = normalizeEmbeddingMode(story?.settings?.localEmbeddingMode || "inherit", "inherit");
    const appMode = normalizeEmbeddingMode(appConfig.localEmbedding?.mode || "off", "off");
    return normalizeEmbeddingConfig({
      ...(appConfig.localEmbedding || {}),
      mode: storyMode === "inherit" ? appMode : storyMode,
    });
  }

  function mergeAppConfigPatch(current, patch = {}) {
    return normalizeAppConfig({
      ...current,
      ...patch,
      localEmbedding:
        patch.localEmbedding == null
          ? current.localEmbedding
          : {
              ...(current.localEmbedding || {}),
              ...(patch.localEmbedding || {}),
            },
    });
  }

  return {
    buildNextStoryEnabled,
    buildNextStoryPromptConfig,
    buildNextStorySettings,
    getAppConfig,
    getLocalEmbeddingRuntimeStatus,
    isSafeStorageId,
    isSupportedLibraryType,
    mergeAppConfigPatch,
    normalizeAppConfig,
    prewarmLocalEmbeddingModel,
    resolveStoryEmbeddingConfig,
  };
}

module.exports = {
  createServerConfigTools,
};
