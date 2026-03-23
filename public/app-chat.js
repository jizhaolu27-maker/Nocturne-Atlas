window.createChatTools = function createChatTools({
  state,
  els,
  escapeHtml,
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
    els.chatStatus.textContent = isPending ? "AI 已收到请求，正在整理上下文并准备回答。" : "";

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
      AI 已收到请求${submittedText ? `：${escapeHtml(submittedText)}` : ""}
正在准备回答...
    `;
    els.chatLog.appendChild(pending);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function updateStreamingAssistant(text) {
    const pending = els.chatLog.querySelector(".message.assistant.pending");
    if (!pending) {
      return;
    }
    pending.innerHTML = `<div class="meta">assistant</div>${escapeHtml(text || "正在生成回复...")}`;
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
      alert("请先选择一个故事。");
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
      alert("当前没有可重写的最近一轮对话。");
      return;
    }
    const previousMessage = messages[messages.length - 2];
    const lastMessage = messages[messages.length - 1];
    if (previousMessage?.role !== "user" || lastMessage?.role !== "assistant") {
      alert("只有最近一轮“用户输入 + AI 回复”可以被重写。");
      return;
    }
    const replacement = prompt("修改上一条用户输入，并重新生成 AI 回复", previousMessage.content || "");
    if (replacement === null) {
      return;
    }
    const nextMessage = replacement.trim();
    if (!nextMessage) {
      alert("输入内容不能为空。");
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

  return {
    setChatPending,
    updateStreamingAssistant,
    streamChat,
    sendChat,
    stopChatGeneration,
    reviseLastUserMessage,
  };
};
