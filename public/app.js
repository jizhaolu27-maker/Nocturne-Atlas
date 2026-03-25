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
  appLocalEmbeddingMode: document.getElementById("app-local-embedding-mode"),
  appLocalEmbeddingRemoteHost: document.getElementById("app-local-embedding-remote-host"),
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
  storyConfigTemperature: document.getElementById("story-config-temperature"),
  storyConfigReasoningEffort: document.getElementById("story-config-reasoning-effort"),
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
  diagnosticHighlights: document.getElementById("diagnostic-highlights"),
  diagnosticWarnings: document.getElementById("diagnostic-warnings"),
  diagnosticTriggers: document.getElementById("diagnostic-triggers"),
  diagnosticContextBlocks: document.getElementById("diagnostic-context-blocks"),
  diagnosticPromptPreview: document.getElementById("diagnostic-prompt-preview"),
  themeToggleBtn: document.getElementById("theme-toggle-btn"),
};

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
  renderChatStatus,
  renderMemory,
  renderProposals,
  renderStatusCurrent,
  renderDiagnosticsCurrent,
} = window.createReviewTools({
  state,
  els,
  escapeHtml,
  api,
  loadStory: (...args) => loadStory(...args),
});

const {
  decorateLatestEditableMessage,
  renderMessages,
  sendChat,
  stopChatGeneration,
  reviseLastUserMessage,
} = window.createChatTools({
  state,
  els,
  escapeHtml,
  renderMarkdownSafe,
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

function parseNumberInput(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const {
  prewarmLocalEmbeddingModel,
  renderLocalEmbeddingResult,
  renderLocalEmbeddingStatus,
  renderProviders,
  saveProvider,
  syncProviderForm,
  testProvider,
} = window.createProviderTools({
  state,
  els,
  escapeHtml,
  api,
  parseNumberInput,
  refreshAll: (...args) => refreshAll(...args),
});

const {
  applyTheme,
  bindShellEvents,
  closeSidebar,
  initializeSidebarState,
  showStorySaveStatus,
} = window.createShellTools({
  state,
  els,
  api,
  sidebarCollapsedStorageKey: "nocturne-atlas.sidebar-collapsed",
  renderActiveRightPanel: (...args) => renderActiveRightPanel(...args),
});

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

function renderNoStorySelectorState(root) {
  root.innerHTML = `<article class="selector-empty">Select a story to manage enabled assets.</article>`;
}

function clearStorySelectors() {
  renderNoStorySelectorState(els.selectorCharacters);
  renderNoStorySelectorState(els.selectorWorldbooks);
  renderNoStorySelectorState(els.selectorStyles);
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
  els.storyConfigTemperature.value = 1;
  els.storyConfigReasoningEffort.value = "inherit";
  els.storyConfigMaxCompletion.value = 120000;
  els.promptGlobal.value = state.appConfig?.globalSystemPrompt || "";
  els.appLocalEmbeddingMode.value = state.appConfig?.localEmbedding?.mode || "off";
  els.appLocalEmbeddingRemoteHost.value = state.appConfig?.localEmbedding?.remoteHost || "";
  els.promptStory.value = "";
  els.promptUser.value = "";
  els.providerSelect.value = "";
  clearStorySelectors();
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
  els.storyConfigTemperature.value = story.settings?.temperature ?? 1;
  els.storyConfigReasoningEffort.value = story.settings?.reasoningEffort || "inherit";
  els.storyConfigMaxCompletion.value = story.settings?.maxCompletionTokens ?? 120000;
  els.promptGlobal.value = state.appConfig?.globalSystemPrompt || story.promptConfig?.globalSystemPrompt || "";
  els.appLocalEmbeddingMode.value = state.appConfig?.localEmbedding?.mode || "off";
  els.appLocalEmbeddingRemoteHost.value = state.appConfig?.localEmbedding?.remoteHost || "";
  els.promptStory.value = story.promptConfig?.storySystemPrompt || "";
  els.promptUser.value = story.promptConfig?.userPromptTemplate || "";
  els.providerSelect.value = story.providerId || "";
  renderSelectors(story.enabled || {});
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
    const currentEnabledIds = Array.isArray(state.activeStoryData?.story?.enabled?.[type])
      ? [...state.activeStoryData.story.enabled[type]]
      : [];
    const renderedCheckboxes = Array.from(selectorRoot.querySelectorAll("input[type=checkbox]"));
    if (!renderedCheckboxes.length) {
      return currentEnabledIds;
    }
    const selectedIds = new Set(
      renderedCheckboxes.filter((node) => node.checked).map((node) => node.value)
    );
    const libraryIds = new Set((state.libraries[type] || []).map((item) => item.id));
    for (const id of currentEnabledIds) {
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
      temperature: parseNumberInput(els.storyConfigTemperature.value, 1),
      reasoningEffort: els.storyConfigReasoningEffort.value || "inherit",
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
    const nextAppLocalEmbeddingMode = els.appLocalEmbeddingMode.value === "on" ? "on" : "off";
    const currentAppLocalEmbeddingMode = state.appConfig?.localEmbedding?.mode || "off";
    const nextAppLocalEmbeddingRemoteHost = els.appLocalEmbeddingRemoteHost.value.trim();
    const currentAppLocalEmbeddingRemoteHost = state.appConfig?.localEmbedding?.remoteHost || "";
    if (
      nextGlobalSystemPrompt !== currentGlobalSystemPrompt ||
      nextAppLocalEmbeddingMode !== currentAppLocalEmbeddingMode ||
      nextAppLocalEmbeddingRemoteHost !== currentAppLocalEmbeddingRemoteHost
    ) {
      state.appConfig = await api("/api/app-config", {
        method: "POST",
        body: JSON.stringify({
          globalSystemPrompt: nextGlobalSystemPrompt,
          localEmbedding: {
            ...(state.appConfig?.localEmbedding || {}),
            mode: nextAppLocalEmbeddingMode,
            remoteHost: nextAppLocalEmbeddingRemoteHost,
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

bindShellEvents();
initializeSidebarState();

bootstrap().catch((error) => {
  console.error(error);
  alert(error.message);
});
