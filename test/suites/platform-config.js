const {
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
  DEFAULT_CONTEXT_BLOCKS,
  DEFAULT_SUMMARY_INTERVAL,
  DEFAULT_MAX_COMPLETION_TOKENS,
  summarizeText,
  slugify,
  safeId,
  createTempRoot,
  createStoreHarness,
  buildMemoryTools,
} = require("../helpers/harness");

module.exports = async function runPlatformConfigTests(runTest) {
  await runTest("story-store isolates a truncated JSONL tail before appending the next record", () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      const linesFile = path.join(rootDir, "events.jsonl");
      fs.writeFileSync(linesFile, '{"id":"complete"}\n{"id":', "utf8");
      harness.appendJsonLine(linesFile, { id: "recovered" });
      assert.deepEqual(harness.readJsonLines(linesFile), [
        { id: "complete" },
        { id: "recovered" },
      ]);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
  
  await runTest("provider secret storage uses the platform path and imports the legacy POSIX path", () => {
    const rootDir = createTempRoot();
    try {
      const configDir = path.join(rootDir, "data", "config");
      const readJson = (filePath, fallback = null) => {
        try {
          return JSON.parse(fs.readFileSync(filePath, "utf8"));
        } catch {
          return fallback;
        }
      };
      const writeJson = (filePath, value) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
      };
      const providerTools = createProviderTools({
        CONFIG_DIR: configDir,
        readJson,
        writeJson,
        loadProviders: () => [],
        summarizeText,
      });
      const legacyFile = `${configDir}\\app-secret.json`;
      fs.mkdirSync(path.dirname(configDir), { recursive: true });
      fs.writeFileSync(legacyFile, JSON.stringify({ secret: "legacy-secret" }), "utf8");
      const encrypted = providerTools.encryptSecret("provider-token");
      assert.equal(fs.existsSync(providerTools.getAppSecretFile()), true);
      assert.equal(fs.existsSync(legacyFile), false);
      assert.equal(readJson(providerTools.getAppSecretFile()).secret, "legacy-secret");
      assert.equal(providerTools.decryptSecret(encrypted), "provider-token");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
  
  await runTest("keyed serial executor preserves order per story while allowing independent stories", async () => {
    const executor = createKeyedSerialExecutor();
    const events = [];
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const first = executor.run("story-a", async () => {
      events.push("a:start");
      await pause(15);
      events.push("a:end");
      return "a";
    });
    const second = executor.run("story-a", async () => {
      events.push("a2");
      return "a2";
    });
    const other = executor.run("story-b", async () => {
      events.push("b");
      return "b";
    });
    assert.deepEqual(await Promise.all([first, second, other]), ["a", "a2", "b"]);
    assert.deepEqual(events, ["a:start", "b", "a:end", "a2"]);
    assert.equal(executor.getPendingKeyCount(), 0);
  });
  
  await runTest("auth tools issue, validate, and revoke a session cookie", async () => {
    const rootDir = createTempRoot();
    try {
      const authFile = path.join(rootDir, "auth.json");
      const readJson = (filePath, fallback = null) => {
        try {
          return JSON.parse(fs.readFileSync(filePath, "utf8"));
        } catch {
          return fallback;
        }
      };
      const writeJson = (filePath, value) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
      };
      const auth = createAuthTools({
        readJson,
        writeJson,
        authFile,
        username: "test-user",
        password: "test-password",
      });
      const responses = [];
      const makeResponse = () => ({
        headers: {},
        setHeader(name, value) {
          this.headers[name] = value;
        },
      });
      const sendJson = (res, status, data) => {
        responses.push({ res, status, data });
      };
      const loginRes = makeResponse();
      await auth.handleRoute(
        { method: "POST", headers: {}, on() {} },
        loginRes,
        {
          parseBody: async () => ({ username: "test-user", password: "test-password" }),
          sendJson,
          pathname: "/api/auth/login",
        }
      );
      assert.equal(responses.at(-1).status, 200);
      const cookie = loginRes.headers["Set-Cookie"].split(";")[0];
      const sessionReq = { method: "GET", headers: { cookie } };
      assert.equal(auth.isAuthenticated(sessionReq), true);
      const logoutRes = makeResponse();
      await auth.handleRoute({ ...sessionReq, method: "POST" }, logoutRes, { parseBody: async () => ({}), sendJson, pathname: "/api/auth/logout" });
      assert.equal(auth.isAuthenticated(sessionReq), false);
      assert.equal(readJson(authFile).password, undefined);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
  
  await runTest("server config prewarm fails when neural embeddings do not return a usable vector", async () => {
    const rootDir = createTempRoot();
    try {
      const appConfigFile = path.join(rootDir, "app.json");
      fs.writeFileSync(
        appConfigFile,
        JSON.stringify(
          {
            theme: "dark",
            localEmbedding: {
              mode: "on",
              provider: "transformers_local",
              model: "Xenova/all-MiniLM-L6-v2",
              dimensions: 384,
              cacheDir: path.join(rootDir, ".cache", "transformers"),
              remoteHost: "https://hf-mirror.com",
              allowFallback: true,
            },
          },
          null,
          2
        ),
        "utf8"
      );
      const serverConfigTools = createServerConfigTools({
        readJson: (filePath, fallback = {}) => {
          try {
            return JSON.parse(fs.readFileSync(filePath, "utf8"));
          } catch {
            return fallback;
          }
        },
        getAppConfigFile: () => appConfigFile,
        normalizeEmbeddingConfig,
        normalizeEmbeddingMode,
        embedText: async () => null,
        embedTextDetailed: async () => ({
          vector: null,
          provider: "transformers_local",
          model: "Xenova/all-MiniLM-L6-v2",
          requestedProvider: "transformers_local",
          requestedModel: "Xenova/all-MiniLM-L6-v2",
          fallbackUsed: false,
          error: "fetch failed",
        }),
        isTransformersDependencyInstalled: () => true,
        DEFAULT_GLOBAL_SYSTEM_PROMPT: "Global prompt",
      });
  
      const result = await serverConfigTools.prewarmLocalEmbeddingModel(serverConfigTools.getAppConfig());
      assert.equal(result.ok, false);
      assert.equal(result.warmed, false);
      assert.match(result.message, /fetch failed/);
      assert.equal(result.activeProvider, "transformers_local");
      assert.equal(result.runtime.remoteHost, "https://hf-mirror.com/");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
  
  await runTest("server config drops legacy retrieval mode fields while keeping rag defaults internal", async () => {
    const rootDir = createTempRoot();
    try {
      const appConfigFile = path.join(rootDir, "app.json");
      fs.writeFileSync(
        appConfigFile,
        JSON.stringify(
          {
            theme: "dark",
            memoryRetrievalMode: "lexical",
            knowledgeRetrievalMode: "lexical",
            localEmbedding: {
              mode: "off",
              provider: "transformers_local",
              model: "Xenova/all-MiniLM-L6-v2",
              dimensions: 384,
            },
          },
          null,
          2
        ),
        "utf8"
      );
      const serverConfigTools = createServerConfigTools({
        readJson: (filePath, fallback = {}) => {
          try {
            return JSON.parse(fs.readFileSync(filePath, "utf8"));
          } catch {
            return fallback;
          }
        },
        getAppConfigFile: () => appConfigFile,
        normalizeEmbeddingConfig,
        normalizeEmbeddingMode,
        embedText: async () => null,
        embedTextDetailed: async () => null,
        DEFAULT_GLOBAL_SYSTEM_PROMPT: "Global prompt",
      });
  
      const appConfig = serverConfigTools.getAppConfig();
      const nextSettings = serverConfigTools.buildNextStorySettings(
        {
          settings: {
            memoryRetrievalMode: "lexical",
            knowledgeRetrievalMode: "lexical",
            localEmbeddingMode: "inherit",
          },
        },
        {
          knowledgeRetrievalMode: "lexical",
          memoryRetrievalMode: "lexical",
        }
      );
  
      assert.equal("knowledgeRetrievalMode" in appConfig, false);
      assert.equal("memoryRetrievalMode" in appConfig, false);
      assert.equal("knowledgeRetrievalMode" in nextSettings, false);
      assert.equal("memoryRetrievalMode" in nextSettings, false);
      assert.equal("localEmbeddingMode" in nextSettings, false);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
  
};
