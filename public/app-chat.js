window.createChatTools = function createChatTools({
  state,
  els,
  escapeHtml,
  renderMarkdownSafe,
  api,
  loadStory,
  renderChatStatus,
}) {
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

    const existing = els.chatLog.querySelector(".message.assistant.pending");
    if (!isPending) {
      existing?.remove();
      return;
    }
    if (existing) {
      return;
    }
    const pending = document.createElement("div");
    pending.className = "message assistant pending";
    pending.innerHTML = `
      <div class="meta">assistant</div>
      AI received the request${submittedText ? `: ${escapeHtml(submittedText)}` : ""}
Preparing the reply...
    `;
    els.chatLog.appendChild(pending);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function updateStreamingAssistant(text) {
    const pending = els.chatLog.querySelector(".message.assistant.pending");
    if (!pending) {
      return;
    }
    pending.innerHTML = `<div class="meta">assistant</div>${escapeHtml(text || "Generating reply...")}`;
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
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
    setChatPending(true, message);
    try {
      const payload = await streamChat(message);
      if (payload) {
        state.pendingProposalPipeline = payload.diagnostics?.proposalPipeline || null;
        state.currentProposalTriggers = payload.diagnostics?.proposalTriggers || [];
        renderChatStatus();
        await loadStory(state.activeStoryId, { preserveTransientDiagnostics: true });
      }
    } catch (error) {
      if (error.name !== "AbortError") {
        alert(error.message);
        await loadStory(state.activeStoryId);
      }
    } finally {
      state.chatAbortController = null;
      setChatPending(false);
      renderChatStatus();
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
    setChatPending(true, nextMessage);
    try {
      await api(`/api/stories/${state.activeStoryId}/chat/revise-last`, {
        method: "POST",
        body: JSON.stringify({ message: nextMessage }),
      });
      await loadStory(state.activeStoryId);
    } catch (error) {
      alert(error.message);
      await loadStory(state.activeStoryId);
    } finally {
      setChatPending(false);
      renderChatStatus();
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
    updateStreamingAssistant,
    streamChat,
    sendChat,
    stopChatGeneration,
    reviseLastUserMessage,
  };
};
