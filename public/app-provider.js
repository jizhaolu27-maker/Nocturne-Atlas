window.createProviderTools = function createProviderTools({
  state,
  els,
  escapeHtml,
  api,
  parseNumberInput,
  refreshAll,
}) {
  function renderProviders() {
    const providerOptions = state.providers
      .map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`)
      .join("");
    els.providerSelect.innerHTML =
      `<option value="">${state.providers.length ? "Select Provider" : "No Providers"}</option>` + providerOptions;
    els.providerEditorSelect.innerHTML = providerOptions + `<option value="__new__">New Provider</option>`;
    if (!state.selectedProviderId && state.providers[0]?.id) {
      state.selectedProviderId = state.providers[0].id;
    }
    els.providerEditorSelect.value = state.selectedProviderId || "__new__";
    renderProviderStatus();
    renderLocalEmbeddingStatus();
  }

  function renderLocalEmbeddingStatus() {
    const runtime = state.appConfig?.localEmbeddingRuntime || null;
    const config = state.appConfig?.localEmbedding || {};
    if (!els.localEmbeddingStatus) {
      return;
    }
    const mode = config.mode || "off";
    const dependencyReady = Boolean(runtime?.dependencyInstalled);
    const cacheReady = Boolean(runtime?.cacheExists);
    const neuralReady = Boolean(runtime?.neuralReady);
    const configuredProvider = runtime?.configuredProvider || config.provider || "transformers_local";
    const remoteHost = runtime?.remoteHost || config.remoteHost || "";
    let summary = "Local embeddings: Off";
    if (mode === "on" && configuredProvider === "hash_v1") {
      summary = "Local embeddings: Enabled. Active backend: deterministic hash vectors.";
    } else if (mode === "on" && dependencyReady && neuralReady) {
      summary = "Local embeddings: Enabled. Neural backend: ready.";
    } else if (mode === "on" && dependencyReady) {
      summary = "Local embeddings: Enabled. Neural backend: not ready yet.";
    } else if (mode === "on") {
      summary = "Local embeddings: Enabled. Dependency: missing.";
    } else if (dependencyReady) {
      summary = "Local embeddings: Off. Dependency: ready.";
    }
    const tone =
      mode === "on" && configuredProvider !== "hash_v1" && !dependencyReady
        ? "error"
        : mode === "on" && (configuredProvider === "hash_v1" || neuralReady)
          ? "ok"
          : "";
    els.localEmbeddingStatus.className = `provider-test-result ${tone}`.trim();
    const mirrorNote =
      mode === "on" && configuredProvider === "transformers_local" && remoteHost
        ? ` Mirror: ${remoteHost}`
        : "";
    els.localEmbeddingStatus.textContent = `${summary}${mirrorNote}${runtime?.note ? ` ${runtime.note}` : ""}`;
    if (els.prewarmLocalEmbeddingBtn) {
      const canPrewarm = configuredProvider !== "hash_v1";
      els.prewarmLocalEmbeddingBtn.disabled = state.isPrewarmingLocalEmbedding || !canPrewarm;
      els.prewarmLocalEmbeddingBtn.textContent = state.isPrewarmingLocalEmbedding
        ? "Prewarming Local Embedding Model..."
        : "Prewarm Local Embedding Model";
      els.prewarmLocalEmbeddingBtn.title = canPrewarm
        ? "Download and warm the local transformers embedding model before the first chat turn."
        : "The hash_v1 provider does not use a neural model cache, so prewarming is unnecessary.";
    }
  }

  function renderLocalEmbeddingResult(message = "", tone = "") {
    if (!els.localEmbeddingResult) {
      return;
    }
    els.localEmbeddingResult.className = `provider-test-result ${tone}`.trim();
    els.localEmbeddingResult.textContent = message;
  }

  async function prewarmLocalEmbeddingModel() {
    state.isPrewarmingLocalEmbedding = true;
    renderLocalEmbeddingStatus();
    renderLocalEmbeddingResult("Prewarming local embedding model...");
    try {
      const result = await api("/api/local-embedding/prewarm", {
        method: "POST",
        body: JSON.stringify({}),
      });
      state.appConfig = {
        ...(state.appConfig || {}),
        localEmbeddingRuntime: result.runtime || state.appConfig?.localEmbeddingRuntime || null,
      };
      const activeProvider = result.activeProvider || result.runtime?.configuredProvider || "";
      let message = result.message || "Last prewarm: completed.";
      if (result.ok && result.warmed && activeProvider === "transformers_local") {
        message = "Last prewarm: success. Neural embeddings are ready.";
      } else if (!result.ok) {
        message = result.message || "Last prewarm: failed.";
      }
      renderLocalEmbeddingResult(message, result.ok ? "ok" : "error");
    } catch (error) {
      try {
        const bootstrapData = await api("/api/bootstrap");
        state.appConfig = bootstrapData.appConfig || state.appConfig || {};
      } catch {
        // Keep the current runtime snapshot if the refresh call also fails.
      }
      renderLocalEmbeddingResult(`Last prewarm: failed. ${error.message}`, "error");
    } finally {
      state.isPrewarmingLocalEmbedding = false;
      renderLocalEmbeddingStatus();
    }
  }

  async function saveProvider() {
    const current = state.providers.find((item) => item.id === state.selectedProviderId) || {};
    const saved = await api("/api/providers", {
      method: "POST",
      body: JSON.stringify({
        id: current.id || undefined,
        name: els.providerName.value.trim() || "Custom Provider",
        baseUrl: els.providerBaseUrl.value.trim(),
        model: els.providerModel.value.trim(),
        contextWindow: parseNumberInput(els.providerContextWindow.value, 32000),
        apiKey: els.providerApiKey.value.trim(),
      }),
    });
    state.selectedProviderId = saved.id;
    els.providerApiKey.value = "";
    await refreshAll();
  }

  async function testProvider() {
    if (!state.selectedProviderId) {
      renderProviderStatus("Please save or select a provider first.");
      return;
    }
    els.providerTestResult.className = "provider-test-result";
    els.providerTestResult.textContent = "Testing provider...";
    try {
      const result = await api("/api/providers/test", {
        method: "POST",
        body: JSON.stringify({
          id: state.selectedProviderId,
          model: els.providerModel.value.trim() || undefined,
        }),
      });
      els.providerTestResult.className = "provider-test-result ok";
      els.providerTestResult.textContent = `Test passed / ${result.latencyMs || "n/a"} ms / ${result.endpoint || ""} / ${result.replyPreview || "provider reachable"}`;
    } catch (error) {
      els.providerTestResult.className = "provider-test-result error";
      els.providerTestResult.textContent = `Test failed: ${error.message}`;
    }
  }

  function syncProviderForm() {
    const provider = state.providers.find((item) => item.id === state.selectedProviderId) || {};
    els.providerName.value = provider.name || "";
    els.providerBaseUrl.value = provider.baseUrl || "";
    els.providerModel.value = provider.model || "";
    els.providerContextWindow.value = provider.contextWindow ?? 32000;
    els.providerApiKey.value = "";
    renderProviderStatus();
  }

  function renderProviderStatus(message = "") {
    const provider = state.providers.find((item) => item.id === state.selectedProviderId) || null;
    if (message) {
      els.providerTestResult.className = "provider-test-result";
      els.providerTestResult.textContent = message;
      return;
    }
    if (!provider) {
      els.providerTestResult.className = "provider-test-result";
      els.providerTestResult.textContent = "Create or select a provider.";
      return;
    }
    const decryptable = provider.encryptedApiKey?.decryptable;
    els.providerTestResult.className = `provider-test-result ${decryptable === false ? "error" : ""}`.trim();
    els.providerTestResult.textContent =
      decryptable === false
        ? "The saved API key cannot be decrypted in this environment. Re-enter the key and test again."
        : "Click Test Provider to check connectivity.";
  }

  return {
    prewarmLocalEmbeddingModel,
    renderLocalEmbeddingResult,
    renderLocalEmbeddingStatus,
    renderProviderStatus,
    renderProviders,
    saveProvider,
    syncProviderForm,
    testProvider,
  };
};
