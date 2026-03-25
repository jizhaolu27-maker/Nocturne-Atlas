window.createChatTools = function createChatTools({
  state,
  els,
  escapeHtml,
  renderMarkdownSafe,
  api,
  loadStory,
  renderChatStatus,
}) {
  const MIN_CHAT_INPUT_HEIGHT = 96;
  const MAX_CHAT_INPUT_HEIGHT = 240;
  let pendingAssistantText = "";
  let pendingAssistantSubmittedText = "";
  let pendingAssistantRenderFrame = 0;

  function syncChatInputHeight({ reset = false } = {}) {
    if (!els.chatInput) {
      return;
    }
    els.chatInput.style.height = "0px";
    const contentHeight = reset && !els.chatInput.value
      ? MIN_CHAT_INPUT_HEIGHT
      : Math.max(els.chatInput.scrollHeight, MIN_CHAT_INPUT_HEIGHT);
    els.chatInput.style.height = `${Math.min(contentHeight, MAX_CHAT_INPUT_HEIGHT)}px`;
  }

  function handleChatInputKeydown(event) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      els.chatForm.requestSubmit();
    }
  }

  els.chatInput.addEventListener("input", () => syncChatInputHeight());
  els.chatInput.addEventListener("keydown", handleChatInputKeydown);
  requestAnimationFrame(() => syncChatInputHeight({ reset: true }));

  function cancelPendingAssistantRender() {
    if (pendingAssistantRenderFrame) {
      cancelAnimationFrame(pendingAssistantRenderFrame);
      pendingAssistantRenderFrame = 0;
    }
  }

  function getPendingAssistantNode() {
    return els.chatLog.querySelector(".message.assistant.pending");
  }

  function buildPendingAssistantPlaceholder() {
    const parts = ["Preparing the reply..."];
    if (pendingAssistantSubmittedText) {
      parts.push(`Current user input: ${pendingAssistantSubmittedText}`);
    }
    return renderMarkdownSafe(parts.join("\n\n"));
  }

  function renderPendingAssistantNow() {
    pendingAssistantRenderFrame = 0;
    const pending = getPendingAssistantNode();
    if (!pending) {
      return;
    }
    const renderedContent = pendingAssistantText
      ? renderMarkdownSafe(pendingAssistantText)
      : buildPendingAssistantPlaceholder();
    pending.innerHTML = `
      <div class="message-role">assistant / streaming</div>
      <div class="message-content">${renderedContent}</div>
    `;
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function setChatPending(isPending, submittedText = "") {
    state.isStreamingChat = isPending;
    els.chatInput.disabled = isPending;
    els.chatSendBtn.disabled = isPending;
    els.chatStopBtn.disabled = !isPending;
    if (isPending) {
      state.pendingProposalPipeline = null;
      state.currentProposalTriggers = [];
    }
    els.chatStatus.className = `chat-status ${isPending ? "busy" : ""}`.trim();
    els.chatStatus.textContent = isPending ? "AI received the request and is preparing the reply." : "";

    const existing = getPendingAssistantNode();
    if (!isPending) {
      cancelPendingAssistantRender();
      pendingAssistantText = "";
      pendingAssistantSubmittedText = "";
      existing?.remove();
      return;
    }
    if (existing) {
      return;
    }
    pendingAssistantText = "";
    pendingAssistantSubmittedText = String(submittedText || "").trim();
    const pending = document.createElement("div");
    pending.className = "message assistant pending";
    els.chatLog.appendChild(pending);
    renderPendingAssistantNow();
  }

  function setChatPreparing(isPreparing) {
    els.chatInput.disabled = isPreparing;
    els.chatSendBtn.disabled = isPreparing;
    els.chatStopBtn.disabled = true;
    if (!isPreparing) {
      return;
    }
    state.pendingProposalPipeline = null;
    state.currentProposalTriggers = [];
    els.chatStatus.className = "chat-status busy";
    els.chatStatus.textContent = "Rewinding the latest turn to the previous state...";
  }

  function updateStreamingAssistant(text) {
    pendingAssistantText = String(text || "");
    if (pendingAssistantRenderFrame) {
      return;
    }
    pendingAssistantRenderFrame = requestAnimationFrame(renderPendingAssistantNow);
  }

  async function streamChat(message) {
    const controller = new AbortController();
    state.chatAbortController = controller;
    const response = await fetch(`/api/stories/${state.activeStoryId}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Streaming request failed");
    }
    if (!response.body) {
      throw new Error("Streaming response body is unavailable");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistantText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        const event = JSON.parse(line);
        if (event.type === "delta") {
          assistantText += event.text || "";
          updateStreamingAssistant(assistantText);
        } else if (event.type === "replace") {
          assistantText = event.text || assistantText;
          updateStreamingAssistant(assistantText);
        } else if (event.type === "done") {
          return event.payload;
        } else if (event.type === "error") {
          throw new Error(event.error || "Streaming request failed");
        } else if (event.type === "aborted") {
          return null;
        }
      }
    }
    return null;
  }

  async function runFreshChatTurn(message) {
    setChatPending(true, message);
    try {
      const payload = await streamChat(message);
      if (payload) {
        state.pendingProposalPipeline = payload.diagnostics?.proposalPipeline || null;
        state.currentProposalTriggers = payload.diagnostics?.proposalTriggers || [];
        renderChatStatus();
        await loadStory(state.activeStoryId, { preserveTransientDiagnostics: true });
      }
      return payload;
    } finally {
      state.chatAbortController = null;
      setChatPending(false);
      renderChatStatus();
    }
  }

  async function sendChat(event) {
    event.preventDefault();
    if (!state.activeStoryId) {
      alert("Please select a story first.");
      return;
    }
    const message = els.chatInput.value.trim();
    if (!message) {
      return;
    }
    els.chatInput.value = "";
    syncChatInputHeight({ reset: true });
    try {
      await runFreshChatTurn(message);
    } catch (error) {
      if (error.name !== "AbortError") {
        alert(error.message);
        await loadStory(state.activeStoryId);
      }
    }
  }

  function stopChatGeneration() {
    state.chatAbortController?.abort();
  }

  async function reviseLastUserMessage() {
    const messages = state.activeStoryData?.messages || [];
    if (messages.length < 2) {
      alert("There is no recent exchange available to revise.");
      return;
    }
    const previousMessage = messages[messages.length - 2];
    const lastMessage = messages[messages.length - 1];
    if (previousMessage?.role !== "user" || lastMessage?.role !== "assistant") {
      alert("Only the latest user input and AI reply can be revised.");
      return;
    }
    const replacement = prompt("Edit the previous user input and regenerate the AI reply", previousMessage.content || "");
    if (replacement === null) {
      return;
    }
    const nextMessage = replacement.trim();
    if (!nextMessage) {
      alert("Input cannot be empty.");
      return;
    }
    try {
      setChatPreparing(true);
      await api(`/api/stories/${state.activeStoryId}/chat/revise-last/prepare`, {
        method: "POST",
      });
      await loadStory(state.activeStoryId);
    } catch (error) {
      setChatPreparing(false);
      renderChatStatus();
      alert(error.message);
      await loadStory(state.activeStoryId).catch(() => {});
      return;
    }
    try {
      await runFreshChatTurn(nextMessage);
    } catch (error) {
      if (error.name !== "AbortError") {
        alert(error.message);
        await loadStory(state.activeStoryId);
      }
    }
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

  return {
    decorateLatestEditableMessage,
    renderMessages,
    setChatPending,
    syncChatInputHeight,
    updateStreamingAssistant,
    streamChat,
    sendChat,
    stopChatGeneration,
    reviseLastUserMessage,
  };
};
