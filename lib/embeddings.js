const path = require("path");

const DEFAULT_EMBEDDING_REMOTE_HOST = "https://huggingface.co/";

function normalizeEmbeddingMode(value, fallback = "off") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "on" || normalized === "off" || normalized === "inherit") {
    return normalized;
  }
  return fallback;
}

function normalizeEmbeddingProvider(value, fallback = "transformers_local") {
  const normalized = String(value || "").trim().toLowerCase();
  if (["transformers_local", "hash_v1"].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeEmbeddingRemoteHost(value, fallback = DEFAULT_EMBEDDING_REMOTE_HOST) {
  const raw = String(value || "").trim();
  if (!raw) {
    return fallback;
  }
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return fallback;
    }
    const normalized = parsed.toString();
    return normalized.endsWith("/") ? normalized : `${normalized}/`;
  } catch {
    return fallback;
  }
}

function normalizeEmbeddingConfig(config = {}) {
  return {
    mode: normalizeEmbeddingMode(config.mode, "off"),
    provider: normalizeEmbeddingProvider(config.provider, "transformers_local"),
    model: String(config.model || "Xenova/all-MiniLM-L6-v2"),
    dimensions: Math.max(32, Number(config.dimensions) || 384),
    cacheDir: String(config.cacheDir || path.join(process.cwd(), ".cache", "transformers")),
    remoteHost: normalizeEmbeddingRemoteHost(config.remoteHost),
    allowFallback: config.allowFallback !== false,
  };
}

function tokenizeText(text) {
  const source = String(text || "").toLowerCase();
  const wordTokens = source.match(/[a-z0-9_-]{2,}|[\u4e00-\u9fff]{1,3}/g) || [];
  const trigrams = [];
  for (let index = 0; index < source.length - 2; index += 1) {
    const slice = source.slice(index, index + 3).trim();
    if (slice && !/\s/.test(slice)) {
      trigrams.push(slice);
    }
  }
  return [...wordTokens, ...trigrams];
}

function hashToken(token, dimensions) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % dimensions;
}

function normalizeVector(vector) {
  const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  if (!magnitude) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}

function createHashEmbedding(text, config = {}) {
  const dimensions = Math.max(32, Number(config.dimensions) || 128);
  const vector = new Array(dimensions).fill(0);
  for (const token of tokenizeText(text)) {
    const bucket = hashToken(token, dimensions);
    vector[bucket] += 1;
  }
  return normalizeVector(vector);
}

function createEmbeddingTools() {
  const extractorCache = new Map();
  const embeddingCache = new Map();
  const EMBEDDING_CACHE_LIMIT = 256;

  function buildEmbeddingCacheKey(text, config) {
    return JSON.stringify({
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
      cacheDir: config.cacheDir,
      remoteHost: config.remoteHost,
      text: String(text || ""),
    });
  }

  function setCachedEmbedding(key, value) {
    if (!key) {
      return;
    }
    if (embeddingCache.has(key)) {
      embeddingCache.delete(key);
    }
    embeddingCache.set(key, value);
    if (embeddingCache.size > EMBEDDING_CACHE_LIMIT) {
      const oldestKey = embeddingCache.keys().next().value;
      if (oldestKey) {
        embeddingCache.delete(oldestKey);
      }
    }
  }

  function buildEmbeddingResult({
    vector = null,
    provider = "",
    model = "",
    requestedProvider = "",
    requestedModel = "",
    fallbackUsed = false,
    disabled = false,
    error = "",
    errorName = "",
    cacheable = false,
  } = {}) {
    return {
      vector: Array.isArray(vector) && vector.length ? vector : null,
      ok: Array.isArray(vector) && vector.length > 0,
      provider: String(provider || ""),
      model: String(model || ""),
      requestedProvider: String(requestedProvider || provider || ""),
      requestedModel: String(requestedModel || model || ""),
      fallbackUsed: Boolean(fallbackUsed),
      disabled: Boolean(disabled),
      error: String(error || ""),
      errorName: String(errorName || ""),
      cacheable: Boolean(cacheable),
    };
  }

  function buildHashEmbeddingResult(text, config, extra = {}) {
    return buildEmbeddingResult({
      vector: createHashEmbedding(text, {
        ...config,
        provider: "hash_v1",
        dimensions: Math.max(128, Number(config.dimensions) || 384),
      }),
      provider: "hash_v1",
      model: "hash_v1",
      requestedProvider: config.provider,
      requestedModel: config.model,
      fallbackUsed: Boolean(extra.fallbackUsed),
      error: extra.error || "",
      errorName: extra.errorName || "",
      cacheable: config.provider === "hash_v1",
    });
  }

  async function getTransformersExtractor(config) {
    const cacheKey = JSON.stringify({
      provider: config.provider,
      model: config.model,
      cacheDir: config.cacheDir,
      remoteHost: config.remoteHost,
    });
    if (extractorCache.has(cacheKey)) {
      return extractorCache.get(cacheKey);
    }
    const pending = (async () => {
      const transformers = await import("@xenova/transformers");
      const { pipeline, env } = transformers;
      env.allowRemoteModels = true;
      env.allowLocalModels = true;
      env.useBrowserCache = false;
      env.remoteHost = normalizeEmbeddingRemoteHost(config.remoteHost);
      if (config.cacheDir) {
        env.cacheDir = config.cacheDir;
      }
      return pipeline("feature-extraction", config.model);
    })();
    extractorCache.set(cacheKey, pending);
    try {
      return await pending;
    } catch (error) {
      extractorCache.delete(cacheKey);
      throw error;
    }
  }

  async function embedTextDetailed(text, options = {}) {
    const config = normalizeEmbeddingConfig(options);
    if (config.mode !== "on") {
      return buildEmbeddingResult({
        provider: config.provider,
        model: config.provider === "hash_v1" ? "hash_v1" : config.model,
        requestedProvider: config.provider,
        requestedModel: config.model,
        disabled: true,
      });
    }
    const cacheKey = buildEmbeddingCacheKey(text, config);
    if (embeddingCache.has(cacheKey)) {
      return embeddingCache.get(cacheKey);
    }
    if (config.provider === "hash_v1") {
      const result = buildHashEmbeddingResult(text, config, { fallbackUsed: false });
      if (result.cacheable) {
        setCachedEmbedding(cacheKey, result);
      }
      return result;
    }
    try {
      const extractor = await getTransformersExtractor(config);
      const output = await extractor(String(text || ""), {
        pooling: "mean",
        normalize: true,
      });
      let vector = null;
      if (Array.isArray(output)) {
        vector = normalizeVector(output.map((value) => Number(value || 0)));
      }
      if (!vector && output?.data) {
        vector = normalizeVector(Array.from(output.data, (value) => Number(value || 0)));
      }
      const result = buildEmbeddingResult({
        vector,
        provider: "transformers_local",
        model: config.model,
        requestedProvider: config.provider,
        requestedModel: config.model,
        cacheable: Array.isArray(vector) && vector.length > 0,
        error: Array.isArray(vector) && vector.length > 0 ? "" : "The transformers pipeline returned an empty embedding.",
      });
      if (result.cacheable) {
        setCachedEmbedding(cacheKey, result);
      }
      return result;
    } catch (error) {
      if (!config.allowFallback) {
        return buildEmbeddingResult({
          provider: config.provider,
          model: config.model,
          requestedProvider: config.provider,
          requestedModel: config.model,
          error: error?.message || "Failed to create a local neural embedding.",
          errorName: error?.name || "",
        });
      }
      return buildHashEmbeddingResult(text, config, {
        fallbackUsed: true,
        error: error?.message || "Failed to create a local neural embedding.",
        errorName: error?.name || "",
      });
    }
  }

  async function embedText(text, options = {}) {
    const result = await embedTextDetailed(text, options);
    if (result.cacheable) {
      return result.vector;
    }
    return Array.isArray(result.vector) && result.vector.length ? result.vector : null;
  }

  function buildMemoryEmbeddingText(record) {
    return [
      record?.summary || "",
      ...(record?.entities || []),
      ...(record?.tags || []),
      ...(record?.keywords || []),
      ...(record?.subjectIds || []),
      ...(record?.objectIds || []),
    ]
      .filter(Boolean)
      .join(" ");
  }

  function buildQueryEmbeddingText({ userMessage = "", messages = [], workspace = {} }) {
    const recent = messages
      .slice(-4)
      .map((item) => `${item.role}: ${item.content}`)
      .join("\n");
    const workspaceText = [
      ...(workspace.characters || []).flatMap((item) => [item.name, ...(item.traits || [])]),
      ...(workspace.worldbooks || []).flatMap((item) => [item.title, ...(item.rules || [])]),
      ...(workspace.styles || []).flatMap((item) => [item.name, item.tone, item.voice]),
    ]
      .filter(Boolean)
      .join(" ");
    return [userMessage, recent, workspaceText].filter(Boolean).join("\n");
  }

  return {
    normalizeEmbeddingConfig,
    normalizeEmbeddingMode,
    embedText,
    embedTextDetailed,
    buildMemoryEmbeddingText,
    buildQueryEmbeddingText,
  };
}

module.exports = {
  DEFAULT_EMBEDDING_REMOTE_HOST,
  createEmbeddingTools,
  normalizeEmbeddingConfig,
  normalizeEmbeddingMode,
  normalizeEmbeddingRemoteHost,
};
