const state = {
  stories: [],
  libraries: { characters: [], worldbooks: [], styles: [] },
  providers: [],
  appConfig: {},
  activeStoryId: null,
  activeStoryData: null,
  selectedProviderId: null,
  selectedLibraryType: "characters",
  selectedLibraryItemId: null,
  chatAbortController: null,
  isStreamingChat: false,
  storySaveStatusTimer: null,
  pendingProposalPipeline: null,
  currentProposalTriggers: [],
  selectedWorkspaceAssetKey: null,
  isPrewarmingLocalEmbedding: false,
  activeRightTab: "controls",
};

const els = {
  appShell: document.querySelector(".app-shell"),
  sidebarOverlay: document.getElementById("sidebar-overlay"),
  desktopSidebarBtn: document.getElementById("desktop-sidebar-btn"),
  mobileSidebarBtn: document.getElementById("mobile-sidebar-btn"),
  topMobileSidebarBtn: document.getElementById("top-mobile-sidebar-btn"),
  storyList: document.getElementById("story-list"),
  storyTitle: document.getElementById("story-title"),
  storySubtitle: document.getElementById("story-subtitle"),
  chatLog: document.getElementById("chat-log"),
  chatForm: document.getElementById("chat-form"),
  chatInput: document.getElementById("chat-input"),
  chatSendBtn: document.getElementById("chat-send-btn"),
  chatStopBtn: document.getElementById("chat-stop-btn"),
  chatStatus: document.getElementById("chat-status"),
  saveStoryBtn: document.getElementById("save-story-btn"),
  storySaveStatus: document.getElementById("story-save-status"),
  newStoryBtn: document.getElementById("new-story-btn"),
  deleteStoryBtn: document.getElementById("delete-story-btn"),
  providerSelect: document.getElementById("provider-select"),
  workspaceView: document.getElementById("workspace-view"),
  memoryList: document.getElementById("memory-list"),
  proposalList: document.getElementById("proposal-list"),
  countCharacters: document.getElementById("count-characters"),
  countWorldbooks: document.getElementById("count-worldbooks"),
  countStyles: document.getElementById("count-styles"),
  statusBlocks: document.getElementById("status-blocks"),
  statusTokens: document.getElementById("status-tokens"),
  statusPressure: document.getElementById("status-pressure"),
  statusForgetfulness: document.getElementById("status-forgetfulness"),
  statusReasons: document.getElementById("status-reasons"),
  appMemoryRetrievalMode: document.getElementById("app-memory-retrieval-mode"),
  appLocalEmbeddingMode: document.getElementById("app-local-embedding-mode"),
  prewarmLocalEmbeddingBtn: document.getElementById("prewarm-local-embedding-btn"),
  localEmbeddingStatus: document.getElementById("local-embedding-status"),
  localEmbeddingResult: document.getElementById("local-embedding-result"),
  providerName: document.getElementById("provider-name"),
  providerEditorSelect: document.getElementById("provider-editor-select"),
  providerBaseUrl: document.getElementById("provider-base-url"),
  providerModel: document.getElementById("provider-model"),
  providerContextWindow: document.getElementById("provider-context-window"),
  providerApiKey: document.getElementById("provider-api-key"),
  saveProviderBtn: document.getElementById("save-provider-btn"),
  testProviderBtn: document.getElementById("test-provider-btn"),
  newProviderBtn: document.getElementById("new-provider-btn"),
  providerTestResult: document.getElementById("provider-test-result"),
  storyConfigTitle: document.getElementById("story-config-title"),
  storyConfigSummary: document.getElementById("story-config-summary"),
  storyConfigModel: document.getElementById("story-config-model"),
  storyConfigContextBlocks: document.getElementById("story-config-context-blocks"),
  storyConfigSummaryInterval: document.getElementById("story-config-summary-interval"),
  storyConfigMemoryRetrievalMode: document.getElementById("story-config-memory-retrieval-mode"),
  storyConfigLocalEmbeddingMode: document.getElementById("story-config-local-embedding-mode"),
  storyConfigTemperature: document.getElementById("story-config-temperature"),
  storyConfigMaxCompletion: document.getElementById("story-config-max-completion"),
  promptGlobal: document.getElementById("prompt-global"),
  promptStory: document.getElementById("prompt-story"),
  promptUser: document.getElementById("prompt-user"),
  selectorCharacters: document.getElementById("selector-characters"),
  selectorWorldbooks: document.getElementById("selector-worldbooks"),
  selectorStyles: document.getElementById("selector-styles"),
  libraryTypeSelect: document.getElementById("library-type-select"),
  libraryItemSelect: document.getElementById("library-item-select"),
  libraryJsonEditor: document.getElementById("library-json-editor"),
  saveLibraryBtn: document.getElementById("save-library-btn"),
  newLibraryBtn: document.getElementById("new-library-btn"),
  deleteLibraryBtn: document.getElementById("delete-library-btn"),
  diagnosticTriggers: document.getElementById("diagnostic-triggers"),
  diagnosticContextBlocks: document.getElementById("diagnostic-context-blocks"),
  diagnosticPromptPreview: document.getElementById("diagnostic-prompt-preview"),
  themeToggleBtn: document.getElementById("theme-toggle-btn"),
};

const SIDEBAR_COLLAPSED_STORAGE_KEY = "nocturne-atlas.sidebar-collapsed";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInlineMarkdownSafe(text) {
  return String(text || "")
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
}

function renderMarkdownSafe(source) {
  const escaped = escapeHtml(source || "").replace(/\r\n/g, "\n");
  const codeBlocks = [];
  const withPlaceholders = escaped.replace(/```([\w-]+)?\n?([\s\S]*?)```/g, (_, language = "", code = "") => {
    const index = codeBlocks.length;
    const languageClass = language ? ` class="language-${language}"` : "";
    codeBlocks.push(`<pre><code${languageClass}>${code.trim()}</code></pre>`);
    return `@@CODEBLOCK_${index}@@`;
  });

  const blocks = withPlaceholders.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const html = blocks
    .map((block) => {
      const codeMatch = block.match(/^@@CODEBLOCK_(\d+)@@$/);
      if (codeMatch) {
        return codeBlocks[Number(codeMatch[1])] || "";
      }

      const lines = block.split("\n");
      if (lines.every((line) => /^[-*]\s+/.test(line))) {
        return `<ul>${lines
          .map((line) => `<li>${renderInlineMarkdownSafe(line.replace(/^[-*]\s+/, ""))}</li>`)
          .join("")}</ul>`;
      }
      if (lines.every((line) => /^\d+\.\s+/.test(line))) {
        return `<ol>${lines
          .map((line) => `<li>${renderInlineMarkdownSafe(line.replace(/^\d+\.\s+/, ""))}</li>`)
          .join("")}</ol>`;
      }
      if (lines.every((line) => /^&gt;\s?/.test(line))) {
        return `<blockquote>${lines
          .map((line) => renderInlineMarkdownSafe(line.replace(/^&gt;\s?/, "")))
          .join("<br>")}</blockquote>`;
      }
      if (lines.length === 1) {
        const heading = lines[0].match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
          const level = heading[1].length;
          return `<h${level}>${renderInlineMarkdownSafe(heading[2])}</h${level}>`;
        }
      }
      return `<p>${lines.map((line) => renderInlineMarkdownSafe(line)).join("<br>")}</p>`;
    })
    .join("");

  return `<div class="markdown-body">${html}</div>`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

const {
  buildProposalPipelineMessage,
  renderChatStatus,
  renderMemory,
  renderProposals,
  renderStatusCurrent,
  renderDiagnosticsCurrent,
} = window.createReviewTools({
  state,
  els,
  escapeHtml,
  formatContextLabel,
  summarizeContextSources,
  api,
  loadStory: (...args) => loadStory(...args),
});

const {
  sendChat,
  stopChatGeneration,
  reviseLastUserMessage,
} = window.createChatTools({
  state,
  els,
  escapeHtml,
  api,
  loadStory: (...args) => loadStory(...args),
  renderChatStatus,
});

const {
  renderLibraryEditor,
  saveLibraryItem,
  deleteLibraryItem,
} = window.createLibraryTools({
  state,
  els,
  escapeHtml,
  api,
  refreshAll: (...args) => refreshAll(...args),
  loadStory: (...args) => loadStory(...args),
});

const {
  renderWorkspace,
} = window.createWorkspaceTools({
  state,
  els,
  escapeHtml,
});

function formatStoryDate(value) {
  if (!value) {
    return "Unknown";
  }
  try {
    return new Date(value).toLocaleDateString();
  } catch {
    return "Unknown";
  }
}

function parseNumberInput(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatContextLabel(label) {
  const value = String(label || "");
  if (value === "system:global") return "Global system prompt";
  if (value === "system:story") return "Story system prompt";
  if (value === "knowledge:retrieved") return "Retrieved knowledge blocks";
  if (value === "style") return "Enabled style";
  if (value === "characters") return "Enabled character cards";
  if (value === "worldbook") return "Enabled worldbooks";
  if (value === "memory") return "Story memory summary";
  if (value === "memory:long_term") return "Long-term memory";
  if (value === "memory:critical") return "Critical memory";
  if (value === "memory:recent") return "Recent memory";
  const historyTurn = value.match(/^history_turn:(\d+)$/);
  if (historyTurn) {
    return `Recent conversation turn ${Number(historyTurn[1]) + 1}`;
  }
  return value;
}

function summarizeContextSources(blocks) {
  const labels = (blocks || []).map((item) => String(item.label || ""));
  const basicSources = [];
  if (labels.includes("system:global")) basicSources.push("Global system prompt");
  if (labels.includes("system:story")) basicSources.push("Story system prompt");
  if (labels.includes("knowledge:retrieved")) basicSources.push("Retrieved knowledge");
  if (labels.includes("characters")) basicSources.push("Character cards");
  if (labels.includes("worldbook")) basicSources.push("Worldbooks");
  if (labels.includes("style")) basicSources.push("Style");
  if (labels.includes("memory")) basicSources.push("Story memory");
  if (labels.includes("memory:long_term")) basicSources.push("Long-term memory");
  if (labels.includes("memory:critical")) basicSources.push("Critical memory");
  if (labels.includes("memory:recent")) basicSources.push("Recent memory");
  const historyTurns = labels.filter((item) => item.startsWith("history_turn:")).length;
  if (!basicSources.length && historyTurns === 0) {
    return "There are no context sources to display for this preview yet.";
  }
  return `Included in this run: ${basicSources.length ? basicSources.join(", ") : "no base sources"}; history turns: ${historyTurns}.`;
}

function showStorySaveStatus(message, tone = "") {
  if (state.storySaveStatusTimer) {
    clearTimeout(state.storySaveStatusTimer);
    state.storySaveStatusTimer = null;
  }
  els.storySaveStatus.className = `story-save-status ${tone}`.trim();
  els.storySaveStatus.textContent = message;
  if (!message) {
    return;
  }
  state.storySaveStatusTimer = setTimeout(() => {
    els.storySaveStatus.textContent = "";
    els.storySaveStatus.className = "story-save-status";
    state.storySaveStatusTimer = null;
  }, 2600);
}

function renderActiveRightPanel() {
  const payload = state.activeStoryData;
  const story = payload?.story || null;
  if (!story) {
    return;
  }
  if (state.activeRightTab === "knowledge") {
    try {
      renderSelectors(story.enabled || {});
      renderWorkspace(payload.workspace || {});
      renderMemory(payload.memoryRecords || []);
      renderLibraryEditor();
    } catch (error) {
      console.error("Failed to render knowledge tab", error);
    }
    return;
  }
  if (state.activeRightTab === "review") {
    try {
      renderProposals(payload.proposals || []);
    } catch (error) {
      console.error("Failed to render review tab", error);
      els.proposalList.innerHTML = `<article class="proposal-item">The proposals panel is temporarily unavailable. Refresh and try again.</article>`;
    }
    return;
  }
  if (state.activeRightTab === "diagnostics") {
    try {
      renderDiagnosticsCurrent(payload.diagnostics || {});
    } catch (error) {
      console.error("Failed to render diagnostics tab", error);
      els.diagnosticTriggers.innerHTML = `<article class="diagnostic-item"><strong>Diagnostics</strong><span>The diagnostics panel is temporarily unavailable. Refresh and try again.</span></article>`;
      els.diagnosticContextBlocks.innerHTML = "";
      els.diagnosticPromptPreview.innerHTML = "";
    }
  }
}

async function bootstrap() {
  const data = await api("/api/bootstrap");
  state.appConfig = data.appConfig || {};
  state.stories = data.stories || [];
  state.providers = data.providers || [];
  state.libraries = data.libraries || state.libraries;
  applyTheme(state.appConfig.theme || "dark");
  renderCounts();
  renderProviders();
  renderStories();
  syncProviderForm();
  renderLibraryEditor();
  const preferredStoryId = state.appConfig?.lastOpenedStoryId;
  const initialStoryId =
    state.stories.find((item) => item.id === preferredStoryId)?.id ||
    state.stories[0]?.id;
  if (initialStoryId) {
    await loadStory(initialStoryId);
  } else {
    renderEmptyState();
  }
}

function renderCounts() {
  els.countCharacters.textContent = state.libraries.characters.length;
  els.countWorldbooks.textContent = state.libraries.worldbooks.length;
  els.countStyles.textContent = state.libraries.styles.length;
}

function applyTheme(theme) {
  const nextTheme = theme === "light" ? "light" : "dark";
  state.appConfig = { ...(state.appConfig || {}), theme: nextTheme };
  document.body.dataset.theme = nextTheme;
  if (els.themeToggleBtn) {
    // Update the tooltip instead of textContent so the SVG icon stays intact.
    els.themeToggleBtn.title = nextTheme === "light" ? "Switch to dark theme" : "Switch to light theme";
  }
}

async function toggleTheme() {
  const currentTheme = state.appConfig?.theme || "dark";
  const nextTheme = currentTheme === "light" ? "dark" : "light";
  applyTheme(nextTheme);
  try {
    const saved = await api("/api/app-config", {
      method: "POST",
      body: JSON.stringify({ theme: nextTheme }),
    });
    state.appConfig = saved || { theme: nextTheme };
    applyTheme(state.appConfig.theme || nextTheme);
  } catch (error) {
    applyTheme(currentTheme);
    alert(`Failed to toggle theme: ${error.message}`);
  }
}

function renderStories() {
  els.storyList.innerHTML = state.stories
    .map(
      (story) => `
        <button class="story-item ${story.id === state.activeStoryId ? "active" : ""}" data-story-id="${story.id}" type="button" title="${escapeHtml(story.summary || story.title)}">
          <span class="story-item-dot"></span>
          <span class="story-item-name">${escapeHtml(story.title)}</span>
        </button>
      `
    )
    .join("");
  for (const node of els.storyList.querySelectorAll("[data-story-id]")) {
    node.addEventListener("click", () => loadStory(node.dataset.storyId));
  }
}

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
  let summary = "Local embeddings: Off";
  if (mode === "on" && dependencyReady && cacheReady) {
    summary = "Local embeddings: Enabled. Cache: ready.";
  } else if (mode === "on" && dependencyReady) {
    summary = "Local embeddings: Enabled. Cache: not detected yet.";
  } else if (mode === "on") {
    summary = "Local embeddings: Enabled. Dependency: missing.";
  } else if (dependencyReady) {
    summary = "Local embeddings: Off. Dependency: ready.";
  }
  const tone = mode === "on" && !dependencyReady ? "error" : cacheReady ? "ok" : "";
  els.localEmbeddingStatus.className = `provider-test-result ${tone}`.trim();
  els.localEmbeddingStatus.textContent = summary;
  if (els.prewarmLocalEmbeddingBtn) {
    const canPrewarm = (config.provider || "transformers_local") !== "hash_v1";
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
    const cacheReady = Boolean(result.runtime?.cacheExists);
    const dependencyReady = Boolean(result.runtime?.dependencyInstalled);
    let message = "Last prewarm: completed.";
    if (result.ok && dependencyReady && cacheReady) {
      message = "Last prewarm: success. Cache is ready.";
    } else if (result.ok && dependencyReady) {
      message = "Last prewarm: success. Model loaded, but cache is not detected yet.";
    } else if (result.ok) {
      message = "Last prewarm: completed.";
    } else {
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

function renderEmptyState() {
  state.pendingProposalPipeline = null;
  state.currentProposalTriggers = [];
  state.selectedWorkspaceAssetKey = null;
  els.storyTitle.textContent = "No story yet";
  els.storySubtitle.textContent = "Create a story and this area will show its workspace copies, memory, proposals, and context preview.";
  els.chatLog.innerHTML =
    `<div class="message assistant"><div class="meta">system</div>Create or select a story to start chatting.</div>`;
  els.deleteStoryBtn.disabled = true;
  els.storyConfigTitle.value = "";
  els.storyConfigSummary.value = "";
  els.storyConfigModel.value = "";
  els.storyConfigContextBlocks.value = 20;
  els.storyConfigSummaryInterval.value = 20;
  els.storyConfigMemoryRetrievalMode.value = "inherit";
  els.storyConfigLocalEmbeddingMode.value = "inherit";
  els.storyConfigTemperature.value = 1;
  els.storyConfigMaxCompletion.value = 120000;
  els.promptGlobal.value = state.appConfig?.globalSystemPrompt || "";
  els.appMemoryRetrievalMode.value = state.appConfig?.memoryRetrievalMode || "lexical";
  els.appLocalEmbeddingMode.value = state.appConfig?.localEmbedding?.mode || "off";
  els.promptStory.value = "";
  els.promptUser.value = "";
  els.providerSelect.value = "";
  els.workspaceView.innerHTML =
    `<article class="workspace-card">There is no workspace content to display.</article>`;
  els.memoryList.innerHTML =
    `<article class="memory-item">There is no story memory to display yet.</article>`;
  els.proposalList.innerHTML =
    `<article class="proposal-item">There are no proposals to process yet.</article>`;
  renderStatusCurrent({});
  renderChatStatus();
  renderLocalEmbeddingStatus();
  renderLocalEmbeddingResult();
  els.workspaceView.innerHTML =
    `<article class="workspace-card">There is no workspace content to display.</article>`;
  els.memoryList.innerHTML =
    `<article class="memory-item">There is no story memory to display yet.</article>`;
  els.proposalList.innerHTML =
    `<article class="proposal-item">There are no proposals to process yet.</article>`;
  els.diagnosticTriggers.innerHTML =
    `<article class="diagnostic-item"><strong>Diagnostics</strong><span>There is no diagnostic information to display yet.</span></article>`;
  els.diagnosticContextBlocks.innerHTML = "";
  els.diagnosticPromptPreview.innerHTML = "";
}

async function loadStory(storyId, options = {}) {
  const { preserveTransientDiagnostics = false } = options;
  const data = await api(`/api/stories/${storyId}`);
  state.activeStoryId = storyId;
  state.activeStoryData = data;
  state.appConfig = { ...(state.appConfig || {}), lastOpenedStoryId: storyId };
  api("/api/app-config", {
    method: "POST",
    body: JSON.stringify({ lastOpenedStoryId: storyId }),
  }).catch(() => {});
  closeSidebar();
  if (!preserveTransientDiagnostics) {
    state.currentProposalTriggers = [];
    state.pendingProposalPipeline = null;
  }
  renderStories();
  renderStory();
}

function renderStory() {
  const payload = state.activeStoryData;
  if (!payload?.story) {
    renderEmptyState();
    return;
  }
  const story = payload.story;
  els.deleteStoryBtn.disabled = false;
  els.storyTitle.textContent = story.title;
  els.storySubtitle.textContent = story.summary || "This story does not have a summary yet.";
  els.storyConfigTitle.value = story.title || "";
  els.storyConfigSummary.value = story.summary || "";
  els.storyConfigModel.value = story.model || "";
  els.storyConfigContextBlocks.value = story.settings?.contextBlocks ?? 20;
  els.storyConfigSummaryInterval.value = story.settings?.summaryInterval ?? 20;
  els.storyConfigMemoryRetrievalMode.value = story.settings?.memoryRetrievalMode || "inherit";
  els.storyConfigLocalEmbeddingMode.value = story.settings?.localEmbeddingMode || "inherit";
  els.storyConfigTemperature.value = story.settings?.temperature ?? 1;
  els.storyConfigMaxCompletion.value = story.settings?.maxCompletionTokens ?? 120000;
  els.promptGlobal.value = state.appConfig?.globalSystemPrompt || story.promptConfig?.globalSystemPrompt || "";
  els.appMemoryRetrievalMode.value = state.appConfig?.memoryRetrievalMode || "lexical";
  els.appLocalEmbeddingMode.value = state.appConfig?.localEmbedding?.mode || "off";
  els.promptStory.value = story.promptConfig?.storySystemPrompt || "";
  els.promptUser.value = story.promptConfig?.userPromptTemplate || "";
  els.providerSelect.value = story.providerId || "";
  renderMessages(payload.messages || []);
  decorateLatestEditableMessage(payload.messages || []);
  try {
    renderStatusCurrent(payload.diagnostics?.currentContextPreview?.contextStatus || story.contextStatus || {});
  } catch (error) {
    console.error("Failed to render context status", error);
  }
  renderChatStatus();
  renderLocalEmbeddingStatus();
  renderActiveRightPanel();
}

function decorateLatestEditableMessage(messages) {
  const lastMessage = messages[messages.length - 1];
  const previousMessage = messages[messages.length - 2];
  if (lastMessage?.role !== "assistant" || previousMessage?.role !== "user") {
    return;
  }
  const userNodes = els.chatLog.querySelectorAll(".message.user");
  const target = userNodes[userNodes.length - 1];
  if (!target || target.querySelector("[data-edit-last-user]")) {
    return;
  }
  const actions = document.createElement("div");
  actions.className = "message-actions";
  // Add a compact icon to the revise action without disturbing the message layout.
  actions.innerHTML = `<button type="button" class="ghost msg-action-btn" data-edit-last-user="true">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
    Revise this turn and regenerate
  </button>`;
  target.appendChild(actions);
}

function renderMessages(messages) {
  els.chatLog.innerHTML = messages.length
    ? messages
        .map(
          (message) => `
            <div class="message ${message.role}">
              <div class="message-role">${escapeHtml(message.role)} / ${escapeHtml(new Date(message.createdAt).toLocaleString())}</div>
              <div class="message-content">${message.role === "assistant" ? renderMarkdownSafe(message.content) : escapeHtml(message.content)}</div>
            </div>
          `
        )
        .join("")
    : `<div class="message assistant"><div class="message-role">system</div><div class="message-content">Start chatting with this story.</div></div>`;
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function renderSelectors(enabled) {
  renderSelectorList(els.selectorCharacters, state.libraries.characters, enabled.characters || []);
  renderSelectorList(els.selectorWorldbooks, state.libraries.worldbooks, enabled.worldbooks || []);
  renderSelectorList(els.selectorStyles, state.libraries.styles, enabled.styles || []);
}

function renderSelectorList(root, items, enabledIds) {
  if (!items.length) {
    root.innerHTML = `<article class="selector-empty">There are no selectable entries yet.</article>`;
    return;
  }
  root.innerHTML = items
    .map(
      (item) => `
        <label class="selector-item">
          <input type="checkbox" value="${item.id}" ${enabledIds.includes(item.id) ? "checked" : ""} />
          <strong>${escapeHtml(item.name || item.title || item.id)}</strong>
        </label>
      `
    )
    .join("");
}

function collectStoryPayload() {
  const collectEnabledIds = (type, selectorRoot) => {
    const selectedIds = new Set(
      Array.from(selectorRoot.querySelectorAll("input:checked")).map((node) => node.value)
    );
    const libraryIds = new Set((state.libraries[type] || []).map((item) => item.id));
    for (const id of state.activeStoryData?.story?.enabled?.[type] || []) {
      if (!libraryIds.has(id)) {
        selectedIds.add(id);
      }
    }
    return Array.from(selectedIds);
  };

  return {
    title: els.storyConfigTitle.value.trim(),
    summary: els.storyConfigSummary.value.trim(),
    providerId: els.providerSelect.value,
    model: els.storyConfigModel.value.trim(),
    settings: {
      contextBlocks: parseNumberInput(els.storyConfigContextBlocks.value, 20),
      summaryInterval: parseNumberInput(els.storyConfigSummaryInterval.value, 20),
      memoryRetrievalMode: els.storyConfigMemoryRetrievalMode.value || "inherit",
      localEmbeddingMode: els.storyConfigLocalEmbeddingMode.value || "inherit",
      temperature: parseNumberInput(els.storyConfigTemperature.value, 1),
      maxCompletionTokens: parseNumberInput(els.storyConfigMaxCompletion.value, 120000),
    },
    promptConfig: {
      storySystemPrompt: els.promptStory.value,
      userPromptTemplate: els.promptUser.value,
    },
    enabled: {
      characters: collectEnabledIds("characters", els.selectorCharacters),
      worldbooks: collectEnabledIds("worldbooks", els.selectorWorldbooks),
      styles: collectEnabledIds("styles", els.selectorStyles),
    },
  };
}

async function saveStoryConfig() {
  if (!state.activeStoryId) {
    return;
  }
  showStorySaveStatus("Saving configuration and refreshing the context preview...");
  try {
    const nextGlobalSystemPrompt = els.promptGlobal.value.trim();
    const currentGlobalSystemPrompt = state.appConfig?.globalSystemPrompt || "";
    const nextAppMemoryRetrievalMode = els.appMemoryRetrievalMode.value === "hybrid" ? "hybrid" : "lexical";
    const currentAppMemoryRetrievalMode = state.appConfig?.memoryRetrievalMode || "lexical";
    const nextAppLocalEmbeddingMode = els.appLocalEmbeddingMode.value === "on" ? "on" : "off";
    const currentAppLocalEmbeddingMode = state.appConfig?.localEmbedding?.mode || "off";
    if (
      nextGlobalSystemPrompt !== currentGlobalSystemPrompt ||
      nextAppMemoryRetrievalMode !== currentAppMemoryRetrievalMode ||
      nextAppLocalEmbeddingMode !== currentAppLocalEmbeddingMode
    ) {
      state.appConfig = await api("/api/app-config", {
        method: "POST",
        body: JSON.stringify({
          globalSystemPrompt: nextGlobalSystemPrompt,
          memoryRetrievalMode: nextAppMemoryRetrievalMode,
          localEmbedding: {
            ...(state.appConfig?.localEmbedding || {}),
            mode: nextAppLocalEmbeddingMode,
          },
        }),
      });
    }
    await api(`/api/stories/${state.activeStoryId}/config`, {
      method: "POST",
      body: JSON.stringify(collectStoryPayload()),
    });
    await refreshAll();
    await loadStory(state.activeStoryId);
    showStorySaveStatus("Saved. Diagnostics has been refreshed for the current configuration preview.", "ok");
  } catch (error) {
    showStorySaveStatus(`Save failed: ${error.message}`, "error");
    throw error;
  }
}

async function refreshAll() {
  const data = await api("/api/bootstrap");
  state.stories = data.stories || [];
  state.providers = data.providers || [];
  state.libraries = data.libraries || state.libraries;
  renderCounts();
  renderProviders();
  renderStories();
  syncProviderForm();
  renderLocalEmbeddingStatus();
  if (state.activeRightTab === "knowledge") {
    try {
      renderLibraryEditor();
    } catch (error) {
      console.error("Failed to refresh library editor", error);
    }
  }
}

async function createStory() {
  const title = prompt("Enter a title for the new story", `Story ${state.stories.length + 1}`);
  if (!title) {
    return;
  }
  const firstProvider = state.providers[0];
  const story = await api("/api/stories", {
    method: "POST",
    body: JSON.stringify({
      title,
      providerId: firstProvider?.id || "",
      model: firstProvider?.model || "",
      enabled: {
        characters: state.libraries.characters.slice(0, 1).map((item) => item.id),
        worldbooks: state.libraries.worldbooks.slice(0, 1).map((item) => item.id),
        styles: state.libraries.styles.slice(0, 1).map((item) => item.id),
      },
    }),
  });
  await refreshAll();
  await loadStory(story.id);
}

async function deleteActiveStory() {
  if (!state.activeStoryId || !state.activeStoryData?.story) {
    return;
  }
  const confirmed = confirm(`Delete story "${state.activeStoryData.story.title}"? This will remove the story's chat, memory, proposals, and workspace copies.`);
  if (!confirmed) {
    return;
  }
  await api(`/api/stories/${state.activeStoryId}`, { method: "DELETE" });
  state.activeStoryId = null;
  state.activeStoryData = null;
  await refreshAll();
  if (state.stories[0]?.id) {
    await loadStory(state.stories[0].id);
  } else {
    renderEmptyState();
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
  els.providerTestResult.className = `provider-test-result ${decryptable === false ? "error" : ""}`;
  els.providerTestResult.textContent =
    decryptable === false
      ? "The saved API key cannot be decrypted in this environment. Re-enter the key and test again."
      : "Click Test Provider to check connectivity.";
}

function getSidebarCollapsedPreference() {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function persistSidebarCollapsed(isCollapsed) {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(Boolean(isCollapsed)));
  } catch {
    return;
  }
}

function setSidebarCollapsed(isCollapsed) {
  if (!els.appShell || window.innerWidth <= 900) {
    return;
  }
  els.appShell.classList.toggle("sidebar-collapsed", Boolean(isCollapsed));
  persistSidebarCollapsed(isCollapsed);
}

function initializeSidebarState() {
  if (!els.appShell) {
    return;
  }
  if (window.innerWidth > 900) {
    setSidebarCollapsed(getSidebarCollapsedPreference());
    setSidebarOpen(false);
  } else {
    els.appShell.classList.remove("sidebar-collapsed");
  }
}

function setSidebarOpen(isOpen) {
  if (!els.appShell) {
    return;
  }
  if (window.innerWidth > 900) {
    return;
  }
  els.appShell.classList.toggle("sidebar-open", Boolean(isOpen));
}

function toggleSidebar() {
  if (!els.appShell || window.innerWidth > 900) {
    return;
  }
  setSidebarOpen(!els.appShell.classList.contains("sidebar-open"));
}

function toggleDesktopSidebar() {
  if (!els.appShell || window.innerWidth <= 900) {
    return;
  }
  setSidebarCollapsed(!els.appShell.classList.contains("sidebar-collapsed"));
}

function closeSidebar() {
  if (window.innerWidth <= 900) {
    setSidebarOpen(false);
  }
}

els.chatForm.addEventListener("submit", sendChat);
els.chatStopBtn.addEventListener("click", stopChatGeneration);
els.chatLog.addEventListener("click", (event) => {
  const target = event.target.closest("[data-edit-last-user]");
  if (target) {
    reviseLastUserMessage();
  }
});
els.saveStoryBtn.addEventListener("click", saveStoryConfig);
els.newStoryBtn.addEventListener("click", createStory);
els.deleteStoryBtn.addEventListener("click", deleteActiveStory);
els.desktopSidebarBtn?.addEventListener("click", toggleDesktopSidebar);
els.mobileSidebarBtn?.addEventListener("click", toggleSidebar);
els.topMobileSidebarBtn?.addEventListener("click", toggleSidebar);
els.sidebarOverlay?.addEventListener("click", closeSidebar);
els.saveProviderBtn.addEventListener("click", saveProvider);
els.testProviderBtn.addEventListener("click", testProvider);
els.newProviderBtn.addEventListener("click", () => {
  state.selectedProviderId = null;
  els.providerEditorSelect.value = "__new__";
  syncProviderForm();
});
els.prewarmLocalEmbeddingBtn?.addEventListener("click", prewarmLocalEmbeddingModel);
els.providerEditorSelect.addEventListener("change", () => {
  state.selectedProviderId = els.providerEditorSelect.value === "__new__" ? null : els.providerEditorSelect.value;
  syncProviderForm();
});
els.libraryTypeSelect.addEventListener("change", () => {
  state.selectedLibraryType = els.libraryTypeSelect.value;
  state.selectedLibraryItemId = null;
  renderLibraryEditor();
});
els.libraryItemSelect.addEventListener("change", () => {
  state.selectedLibraryItemId = els.libraryItemSelect.value;
  renderLibraryEditor();
});
els.saveLibraryBtn.addEventListener("click", saveLibraryItem);
els.newLibraryBtn.addEventListener("click", () => {
  state.selectedLibraryItemId = "__new__";
  renderLibraryEditor();
});
els.deleteLibraryBtn.addEventListener("click", deleteLibraryItem);
els.themeToggleBtn?.addEventListener("click", toggleTheme);

// Right panel tab switching
for (const btn of document.querySelectorAll(".tab-btn")) {
  btn.setAttribute("aria-selected", btn.classList.contains("active") ? "true" : "false");
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    state.activeRightTab = tab;
    for (const b of document.querySelectorAll(".tab-btn")) {
      b.classList.toggle("active", b.dataset.tab === tab);
      b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false");
    }
    for (const c of document.querySelectorAll(".tab-content")) {
      c.classList.toggle("active", c.id === `tab-${tab}`);
    }
    renderActiveRightPanel();
    document.querySelector(".right-panel-body")?.scrollTo({ top: 0, behavior: "smooth" });
  });
}

// Right panel toggle (desktop collapse / mobile overlay)
const rightPanelBtn = document.getElementById("right-panel-btn");
if (rightPanelBtn) {
  rightPanelBtn.addEventListener("click", () => {
    if (!els.appShell) return;
    if (window.innerWidth <= 900) {
      const isOpen = els.appShell.classList.contains("right-open");
      els.appShell.classList.toggle("right-open", !isOpen);
    } else {
      const isCollapsed = els.appShell.classList.contains("right-collapsed");
      els.appShell.classList.toggle("right-collapsed", !isCollapsed);
    }
  });
}

// Close overlays on overlay click (mobile sidebar + right panel)
els.sidebarOverlay?.addEventListener("click", () => {
  closeSidebar();
  if (els.appShell) els.appShell.classList.remove("right-open");
});

window.addEventListener("resize", () => {
  initializeSidebarState();
  if (window.innerWidth > 900) {
    closeSidebar();
    if (els.appShell) els.appShell.classList.remove("right-open");
  }
});

initializeSidebarState();

bootstrap().catch((error) => {
  console.error(error);
  alert(error.message);
});
