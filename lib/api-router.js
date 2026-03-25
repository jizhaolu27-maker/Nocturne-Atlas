const { URL } = require("url");

function createApiRouter({
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
}) {
  function decodePathSegment(value) {
    try {
      return decodeURIComponent(String(value || ""));
    } catch {
      return String(value || "");
    }
  }

  function getSegments(req) {
    const url = new URL(req.url, "http://localhost");
    return url.pathname
      .split("/")
      .filter(Boolean)
      .map((segment, index) => (index === 0 ? segment : decodePathSegment(segment)));
  }

  function maskProvider(provider) {
    return {
      ...provider,
      encryptedApiKey: provider.encryptedApiKey
        ? { masked: true, decryptable: canDecryptSecret(provider.encryptedApiKey) }
        : null,
    };
  }

  function listStories() {
    return loadStoriesIndex().map((entry) => getStory(entry.id)).filter(Boolean);
  }

  function listProvidersForClient() {
    return loadProviders().map(maskProvider);
  }

  function listLibraries() {
    return {
      characters: listJsonFiles(getLibraryTypeDir("characters")),
      worldbooks: listJsonFiles(getLibraryTypeDir("worldbooks")),
      styles: listJsonFiles(getLibraryTypeDir("styles")),
    };
  }

  async function handleBootstrapRoute(req, res, segments) {
    if (!(req.method === "GET" && segments[1] === "bootstrap")) {
      return false;
    }
    const appConfig = getAppConfig();
    sendJson(res, 200, {
      appConfig: {
        ...appConfig,
        localEmbeddingRuntime: getLocalEmbeddingRuntimeStatus(appConfig),
      },
      providers: listProvidersForClient(),
      stories: listStories(),
      libraries: listLibraries(),
    });
    return true;
  }

  async function handleAppConfigRoute(req, res, segments) {
    if (!(req.method === "POST" && segments[1] === "app-config")) {
      return false;
    }
    const body = await parseBody(req);
    const next = mergeAppConfigPatch(getAppConfig(), body);
    writeJson(getAppConfigFile(), next);
    sendJson(res, 200, {
      ...next,
      localEmbeddingRuntime: getLocalEmbeddingRuntimeStatus(next),
    });
    return true;
  }

  async function handleLocalEmbeddingRoute(req, res, segments) {
    if (!(req.method === "POST" && segments[1] === "local-embedding" && segments[2] === "prewarm")) {
      return false;
    }
    const result = await prewarmLocalEmbeddingModel(getAppConfig());
    sendJson(res, result.ok ? 200 : 500, result);
    return true;
  }

  async function handleProvidersRoute(req, res, segments) {
    if (segments[1] !== "providers") {
      return false;
    }
    if (req.method === "GET") {
      sendJson(res, 200, listProvidersForClient());
      return true;
    }
    if (req.method === "POST" && segments[2] === "test") {
      const body = await parseBody(req);
      const provider = loadProviders().find((item) => item.id === body.id);
      if (!provider) {
        notFound(res);
        return true;
      }
      const result = await testProviderConnection(provider, body.model);
      sendJson(res, result.ok ? 200 : 400, result);
      return true;
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
      saveProviders([...providers.filter((item) => item.id !== payload.id), payload]);
      sendJson(res, 200, maskProvider(payload));
      return true;
    }
    return false;
  }

  async function handleLibraryRoute(req, res, segments) {
    const type = segments[2];
    if (segments[1] !== "library" || !type) {
      return false;
    }
    if (!isSupportedLibraryType(type)) {
      sendJson(res, 400, { error: "Unsupported library type" });
      return true;
    }
    if (req.method === "GET") {
      sendJson(res, 200, listJsonFiles(getLibraryTypeDir(type)));
      return true;
    }
    if (req.method === "POST") {
      const item = saveLibraryItem(type, await parseBody(req));
      sendJson(res, 200, item);
      return true;
    }
    if (req.method === "DELETE" && segments[3]) {
      try {
        deleteLibraryItem(type, segments[3]);
      } catch (error) {
        if (error.message === "Library item not found") {
          notFound(res);
          return true;
        }
        throw error;
      }
      sendJson(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  async function handleStoriesRoute(req, res, segments) {
    if (segments[1] !== "stories") {
      return false;
    }
    if (req.method === "GET" && segments.length === 2) {
      sendJson(res, 200, listStories());
      return true;
    }
    if (req.method === "POST" && segments.length === 2) {
      sendJson(res, 200, createDefaultStory(await parseBody(req)));
      return true;
    }
    const storyId = segments[2];
    if (!storyId) {
      return false;
    }
    if (req.method === "DELETE" && segments.length === 3) {
      const story = getStory(storyId);
      if (!story) {
        notFound(res);
        return true;
      }
      deleteStory(storyId);
      sendJson(res, 200, { ok: true, deletedId: storyId });
      return true;
    }
    if (req.method === "GET" && segments.length === 3) {
      try {
        sendJson(res, 200, await buildStoryPreview(storyId));
      } catch (error) {
        if (error.message === "Story not found") {
          notFound(res);
          return true;
        }
        throw error;
      }
      return true;
    }
    if (req.method === "POST" && segments[3] === "config") {
      const body = await parseBody(req);
      const story = getStory(storyId);
      if (!story) {
        notFound(res);
        return true;
      }
      const next = {
        ...story,
        title: body.title != null ? String(body.title).trim() || story.title : story.title,
        summary: body.summary != null ? String(body.summary).trim() : story.summary,
        providerId: body.providerId != null ? String(body.providerId).trim() : story.providerId,
        model: body.model != null ? String(body.model).trim() : story.model,
        promptConfig: buildNextStoryPromptConfig(story, body.promptConfig || {}),
        settings: buildNextStorySettings(story, body.settings || {}),
        enabled: buildNextStoryEnabled(story, body.enabled || {}),
        updatedAt: new Date().toISOString(),
      };
      saveStory(next);
      syncStoryWorkspace(storyId);
      sendJson(res, 200, next);
      return true;
    }
    if (req.method === "POST" && segments[3] === "chat" && segments[4] === "revise-last" && segments[5] === "prepare") {
      prepareReviseLastExchange(storyId);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (req.method === "POST" && segments[3] === "chat" && segments[4] === "revise-last") {
      const result = await reviseLastExchange(storyId, (await parseBody(req)).message);
      sendJson(res, result.status, result.data);
      return true;
    }
    if (req.method === "POST" && segments[3] === "chat" && segments[4] === "stream") {
      await handleChatStream(req, res, storyId, await parseBody(req));
      return true;
    }
    if (req.method === "POST" && segments[3] === "chat" && segments.length === 4) {
      const result = await handleChat(storyId, await parseBody(req));
      sendJson(res, result.status, result.data);
      return true;
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
        sendJson(res, status, { error: error.message });
        return true;
      }
      sendJson(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  function getErrorStatus(message) {
    return /contains invalid filename characters| is invalid| is required$/.test(message) ||
      message === "Workspace character already exists"
      ? 400
      : 500;
  }

  async function routeApi(req, res) {
    const segments = getSegments(req);
    if (segments[0] !== "api") {
      return false;
    }
    try {
      if (await handleBootstrapRoute(req, res, segments)) return true;
      if (await handleAppConfigRoute(req, res, segments)) return true;
      if (await handleLocalEmbeddingRoute(req, res, segments)) return true;
      if (await handleProvidersRoute(req, res, segments)) return true;
      if (await handleLibraryRoute(req, res, segments)) return true;
      if (await handleStoriesRoute(req, res, segments)) return true;
      notFound(res);
      return true;
    } catch (error) {
      const message = error.message || "Internal server error";
      sendJson(res, getErrorStatus(message), { error: message });
      return true;
    }
  }

  return {
    routeApi,
  };
}

module.exports = {
  createApiRouter,
};
