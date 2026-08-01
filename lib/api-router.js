const { URL } = require("url");
const path = require("path");

function createApiRouter({
  parseBody,
  sendJson,
  notFound,
  loadStoriesIndex,
  getStory,
  loadProviders,
  saveProviders,
  canDecryptSecret,
  decryptSecret,
  callOpenAICompatible,
  encryptSecret,
  testProviderConnection,
  listJsonFiles,
  readJson,
  getLibraryTypeDir,
  saveLibraryItem,
  deleteLibraryItem,
  createDefaultStory,
  saveStory,
  deleteStory,
  syncStoryWorkspace,
  handleChat,
  handleChatStream,
  getPendingGeneration = () => null,
  prepareReviseLastExchange,
  reviseLastExchange,
  buildStoryPreview,
  reviewProposal,
  safeId,
  getAppConfig,
  getStoryWorkspaceDir,
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
  runStoryTask = (_storyId, task) => task(),
}) {
  function parseGeneratedJson(content) {
    const text = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
      return JSON.parse(text);
    } catch {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
      throw new Error("Provider returned invalid JSON");
    }
  }

  async function handleLibraryGenerateRoute(req, res, segments) {
    if (!(req.method === "POST" && segments[1] === "library" && segments[2] === "generate")) return false;
    const body = await parseBody(req);
    const type = String(body.type || "").trim();
    const description = String(body.description || "").trim().slice(0, 4000);
    if (!isSupportedLibraryType(type) || !description) {
      sendJson(res, 400, { error: "A supported library type and description are required" });
      return true;
    }
    const providers = loadProviders();
    const provider = providers.find((item) => item.id === body.providerId) || providers[0];
    if (!provider) {
      sendJson(res, 400, { error: "Configure a provider before generating a library draft" });
      return true;
    }
    const apiKey = decryptSecret(provider.encryptedApiKey);
    if (!apiKey) {
      sendJson(res, 400, { error: "The selected provider has no usable API key" });
      return true;
    }
    const schemas = {
      characters: '{"id":"short-kebab-id","name":"","core":{"role":""},"traits":[],"relationships":{},"arcState":{"current":""},"notes":""}',
      worldbooks: '{"id":"short-kebab-id","title":"","category":"setting","rules":[],"content":"","revealedFacts":[],"storyState":""}',
      styles: '{"id":"short-kebab-id","name":"","tone":"","voice":"","pacing":"","dos":[],"donts":[]}',
    };
    const prompt = `Create one reusable ${type.slice(0, -1)} library entry from the user's description. Return JSON only, matching this exact shape (use concise values, no markdown): ${schemas[type]}\nUser description:\n${description}`;
    try {
      const result = await callOpenAICompatible({
        baseUrl: provider.baseUrl,
        apiKey,
        model: String(body.model || provider.model || "").trim(),
        messages: [
          { role: "system", content: "You generate structured fiction library data. Never include commentary outside JSON." },
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
        topP: 1,
        max_tokens: 1800,
        responseFormat: { type: "json_object" },
      });
      sendJson(res, 200, { type, draft: parseGeneratedJson(result.content) });
    } catch (error) {
      sendJson(res, 502, { error: error.message || "Failed to generate library draft" });
    }
    return true;
  }
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
    if (req.method === "POST" && segments[3] === "workspace" && segments[4] === "characters" && segments[5] && segments[6] === "compress") {
      if (!segments[5] || segments[5] === "." || segments[5] === ".." || /[\\/:*?"<>|\x00-\x1f]/.test(segments[5])) {
        sendJson(res, 400, { error: "Invalid character id" });
        return true;
      }
      const story = getStory(storyId);
      const character = story && readJson(path.join(getStoryWorkspaceDir(storyId, "characters"), `${segments[5]}.json`), null);
      if (!story || !character) {
        notFound(res);
        return true;
      }
      const provider = loadProviders().find((item) => item.id === story.providerId);
      const apiKey = provider ? decryptSecret(provider.encryptedApiKey) : "";
      if (!provider || !apiKey) {
        sendJson(res, 400, { error: "Configure a usable provider before compressing a character card" });
        return true;
      }
      const body = await parseBody(req);
      try {
        if (body.accept === true) {
          const summary = body.runtimeSummary;
          if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
            sendJson(res, 400, { error: "A reviewed runtime summary is required" });
            return true;
          }
          const { changeLog, ...clean } = character;
          writeJson(path.join(getStoryWorkspaceDir(storyId, "characters"), `${segments[5]}.json`), {
            ...clean,
            runtimeSummary: summary,
            workspaceUpdatedAt: new Date().toISOString(),
          });
          sendJson(res, 200, { ok: true });
          return true;
        }
        const result = await callOpenAICompatible({
          baseUrl: provider.baseUrl,
          apiKey,
          model: story.model || provider.model,
          messages: [
            { role: "system", content: "Compress a character card into faithful JSON. Preserve all canon facts, relationships, current arc, and important notes. Do not invent or alter facts. Return only JSON with keys core, traits, relationships, arcState, notes." },
            { role: "user", content: JSON.stringify({ core: character.core, traits: character.traits, relationships: character.relationships, arcState: character.arcState, notes: character.notes }, null, 2) },
          ],
          temperature: 0.1,
          topP: 1,
          max_tokens: 1200,
          responseFormat: { type: "json_object" },
        });
        sendJson(res, 200, { runtimeSummary: parseGeneratedJson(result.content) });
      } catch (error) {
        sendJson(res, 502, { error: error.message || "Failed to compress character card" });
      }
      return true;
    }
    if (req.method === "GET" && segments[3] === "chat" && segments[4] === "pending") {
      if (!getStory(storyId)) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { pendingGeneration: getPendingGeneration(storyId) });
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
      if (await handleLibraryGenerateRoute(req, res, segments)) return true;
      if (await handleLibraryRoute(req, res, segments)) return true;
      if (segments[1] === "stories" && segments[2] && req.method === "GET") {
        if (await handleStoriesRoute(req, res, segments)) return true;
      } else if (segments[1] === "stories" && segments[2]) {
        if (await runStoryTask(segments[2], () => handleStoriesRoute(req, res, segments))) return true;
      } else if (await handleStoriesRoute(req, res, segments)) {
        return true;
      }
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
