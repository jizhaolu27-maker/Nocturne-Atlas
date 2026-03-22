function createChatTools({
  safeId,
  summarizeText,
  jsonResponse,
  sendJson,
  getStory,
  saveStory,
  getProviderForStory,
  decryptSecret,
  syncStoryWorkspace,
  loadActiveWorkspaceItems,
  readJsonLines,
  appendJsonLine,
  writeJsonLines,
  getStoryMessagesFile,
  getStoryMemoryFile,
  getStoryProposalFile,
  getStorySnapshotFile,
  getDefaultContextStatus,
  buildContextBlocks,
  classifyPressure,
  getSummaryTriggers,
  getSummarySchedule,
  generateMemoryUpdate,
  generateProposalUpdate,
  detectForgetfulness,
  buildEndpointUrl,
  callOpenAICompatible,
  streamOpenAICompatible,
}) {
  function replaceTemplate(template, userInput) {
    return String(template || "").replace(/\{\{user_input\}\}/g, userInput);
  }

  function buildPromptMessages(contextBlocks, userPromptTemplate, userInput) {
    return [
      ...contextBlocks
        .filter((block) => block.label.startsWith("system"))
        .map((block) => ({ role: "system", content: block.content })),
      {
        role: "user",
        content: [
          "Active context:",
          ...contextBlocks
            .filter((block) => !block.label.startsWith("system"))
            .map((block) => `[${block.label}]\n${block.content}`),
          "",
          replaceTemplate(userPromptTemplate, userInput),
        ].join("\n\n"),
      },
    ];
  }

  function buildWorkspace(storyId, enabled = {}) {
    syncStoryWorkspace(storyId);
    return {
      characters: loadActiveWorkspaceItems(storyId, "characters", enabled.characters),
      worldbooks: loadActiveWorkspaceItems(storyId, "worldbooks", enabled.worldbooks),
      styles: loadActiveWorkspaceItems(storyId, "styles", enabled.styles),
    };
  }

  function buildChatContext(storyId, body) {
    const story = getStory(storyId);
    if (!story) {
      throw new Error("Story not found");
    }
    const provider = getProviderForStory(story);
    if (!provider) {
      throw new Error("No provider configured for this story");
    }
    const apiKey = decryptSecret(provider.encryptedApiKey);
    if (!apiKey) {
      throw new Error("Provider API key is unavailable");
    }

    const workspace = buildWorkspace(storyId, story.enabled || {});
    const messages = readJsonLines(getStoryMessagesFile(storyId));
    const memoryRecords = readJsonLines(getStoryMemoryFile(storyId));
    const userMessage = {
      id: safeId("msg"),
      role: "user",
      content: String(body.message || "").trim(),
      createdAt: new Date().toISOString(),
    };
    if (!userMessage.content) {
      throw new Error("Message is required");
    }
    const nextMessages = [...messages, userMessage];
    const contextInfo = buildContextBlocks(story, nextMessages, memoryRecords, workspace, {
      currentUserInput: userMessage.content,
    });
    const summaryTriggers = getSummaryTriggers(story, nextMessages, contextInfo);
    const promptMessages = buildPromptMessages(
      contextInfo.blocks,
      story.promptConfig?.userPromptTemplate || "",
      userMessage.content
    );

    return {
      story,
      provider,
      apiKey,
      workspace,
      messages,
      memoryRecords,
      userMessage,
      nextMessages,
      contextInfo,
      summaryTriggers,
      promptMessages,
    };
  }

  async function finalizeChatTurn({
    storyId,
    story,
    provider,
    workspace,
    memoryRecords,
    nextMessages,
    userMessage,
    contextInfo,
    summaryTriggers,
    promptMessages,
    assistantText,
    completionMeta,
  }) {
    appendJsonLine(getStoryMessagesFile(storyId), userMessage);
    const assistantMessage = {
      id: safeId("msg"),
      role: "assistant",
      content: assistantText,
      createdAt: new Date().toISOString(),
    };
    appendJsonLine(getStoryMessagesFile(storyId), assistantMessage);
    const fullMessages = [...nextMessages, assistantMessage];

    const summaryRecords = [];
    let summarySchedule = getSummarySchedule(story, fullMessages);
    let consolidatedMemoryRecords = [];
    let consolidatedMemorySourceIds = [];
    let supersededLongTermIds = [];
    if (summaryTriggers.length > 0) {
      const memoryUpdate = await generateMemoryUpdate({
        story,
        fullMessages,
        memoryRecords,
        workspace,
        summaryTriggers,
      });
      summarySchedule = memoryUpdate.summarySchedule;
      summaryRecords.push(...memoryUpdate.summaryRecords);
      consolidatedMemoryRecords = memoryUpdate.consolidatedMemoryRecords;
      consolidatedMemorySourceIds = memoryUpdate.consolidatedMemorySourceIds;
      supersededLongTermIds = memoryUpdate.supersededLongTermIds;
      writeJsonLines(getStoryMemoryFile(storyId), memoryUpdate.records);
    }

    const proposalUpdate = await generateProposalUpdate({
      story,
      fullMessages,
      workspace,
      assistantText,
    });
    const proposalRecords = proposalUpdate.proposalRecords;
    const proposalTriggers = proposalUpdate.proposalTriggers;
    const proposalPipeline = proposalUpdate.proposalPipeline;
    for (const proposal of proposalRecords) {
      appendJsonLine(getStoryProposalFile(storyId), proposal);
    }

    const finalMemoryRecords = readJsonLines(getStoryMemoryFile(storyId));
    const forgetfulness = detectForgetfulness({
      workspace,
      memoryRecords: finalMemoryRecords,
      assistantText,
      contextInfo,
    });
    const updatedStory = {
      ...story,
      updatedAt: new Date().toISOString(),
      contextStatus: {
        usedTokens: contextInfo.usedTokens,
        maxTokens: contextInfo.maxTokens,
        usedBlocks: contextInfo.usedBlocks,
        maxBlocks: contextInfo.maxBlocks,
        pressureLevel: forgetfulness.pressureLevel,
        forgetfulnessState: forgetfulness.forgetfulnessState,
        forgetfulnessReasons: forgetfulness.forgetfulnessReasons,
      },
    };
    saveStory(updatedStory);

    const snapshot = {
      at: new Date().toISOString(),
      provider: {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        model: story.model || provider.model,
      },
      requestMeta: {
        endpoint: completionMeta?.endpoint || buildEndpointUrl(provider.baseUrl, "chat/completions"),
        latencyMs: completionMeta?.latencyMs || null,
        promptMessages: completionMeta?.promptMessages || promptMessages.length,
        completionChars: assistantText.length,
      },
      contextStatus: updatedStory.contextStatus,
      summaryTriggers,
      summarySchedule,
      proposalTriggers,
      proposalPipeline,
      usedLabels: contextInfo.blocks.map((block) => block.label),
      contextBlocks: contextInfo.blocks.map((block) => ({
        label: block.label,
        tokens: block.tokens,
        preview: summarizeText(block.content, 220),
      })),
      promptMessages,
      generatedSummaryIds: [...summaryRecords, ...consolidatedMemoryRecords].map((item) => item.id),
      consolidatedMemorySourceIds: Array.from(new Set(consolidatedMemorySourceIds)),
      supersededLongTermIds: Array.from(new Set(supersededLongTermIds)),
      generatedProposalIds: proposalRecords.map((item) => item.id),
      generatedSummaryCount: summaryRecords.length + consolidatedMemoryRecords.length,
      generatedProposalCount: proposalRecords.length,
    };
    appendJsonLine(getStorySnapshotFile(storyId), snapshot);

    return {
      message: assistantMessage,
      memoryRecords: [...summaryRecords, ...consolidatedMemoryRecords],
      proposals: proposalRecords,
      contextStatus: updatedStory.contextStatus,
      diagnostics: {
        latestSnapshot: snapshot,
        snapshotCount: readJsonLines(getStorySnapshotFile(storyId)).length,
        requestMeta: snapshot.requestMeta,
        summaryTriggers,
        summarySchedule,
        proposalTriggers,
        proposalPipeline,
        usedLabels: snapshot.usedLabels,
        contextBlocks: snapshot.contextBlocks,
        generatedSummaryCount: summaryRecords.length,
        generatedProposalCount: proposalRecords.length,
      },
    };
  }

  async function handleChat(storyId, body) {
    let chat;
    try {
      chat = buildChatContext(storyId, body);
    } catch (error) {
      const status = error.message === "Story not found" ? 404 : 400;
      return jsonResponse(status, { error: error.message });
    }
    let assistantText;
    let completionMeta = null;
    try {
      const completion = await callOpenAICompatible({
        baseUrl: chat.provider.baseUrl,
        apiKey: chat.apiKey,
        model: chat.story.model || chat.provider.model,
        messages: chat.promptMessages,
        temperature: chat.story.settings.temperature,
        topP: chat.story.settings.topP,
        max_tokens: chat.story.settings.maxCompletionTokens,
      });
      assistantText = completion.content;
      completionMeta = completion.meta;
    } catch (error) {
      return jsonResponse(502, { error: error.message || "Chat request failed" });
    }
    const payload = await finalizeChatTurn({
      storyId,
      story: chat.story,
      provider: chat.provider,
      workspace: chat.workspace,
      memoryRecords: chat.memoryRecords,
      nextMessages: chat.nextMessages,
      userMessage: chat.userMessage,
      contextInfo: chat.contextInfo,
      summaryTriggers: chat.summaryTriggers,
      promptMessages: chat.promptMessages,
      assistantText,
      completionMeta,
    });
    return jsonResponse(200, payload);
  }

  async function handleChatStream(req, res, storyId, body) {
    let chat;
    try {
      chat = buildChatContext(storyId, body);
    } catch (error) {
      return sendJson(res, error.message === "Story not found" ? 404 : 400, { error: error.message });
    }

    const abortController = new AbortController();
    let clientClosed = false;
    req.on("close", () => {
      clientClosed = true;
      abortController.abort();
    });

    const sendEvent = (payload) => {
      if (!res.writableEnded) {
        res.write(`${JSON.stringify(payload)}\n`);
      }
    };

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    sendEvent({
      type: "start",
      contextStatus: {
        usedTokens: chat.contextInfo.usedTokens,
        maxTokens: chat.contextInfo.maxTokens,
        usedBlocks: chat.contextInfo.usedBlocks,
        maxBlocks: chat.contextInfo.maxBlocks,
      },
    });

    let assistantText = "";
    let providerMeta = null;
    try {
      providerMeta = await streamOpenAICompatible({
        baseUrl: chat.provider.baseUrl,
        apiKey: chat.apiKey,
        model: chat.story.model || chat.provider.model,
        messages: chat.promptMessages,
        temperature: chat.story.settings.temperature,
        topP: chat.story.settings.topP,
        max_tokens: chat.story.settings.maxCompletionTokens,
        signal: abortController.signal,
      });

      const reader = providerMeta.stream.getReader();
      const decoder = new TextDecoder("utf8");
      let buffer = "";
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
          if (!line.startsWith("data:")) {
            continue;
          }
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") {
            continue;
          }
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = parsed?.choices?.[0]?.delta?.content;
          const text = Array.isArray(delta) ? delta.map((part) => part?.text || "").join("") : delta;
          if (text) {
            assistantText += text;
            sendEvent({ type: "delta", text });
          }
        }
      }
    } catch (error) {
      if (abortController.signal.aborted || clientClosed) {
        sendEvent({ type: "aborted" });
        res.end();
        return;
      }
      sendEvent({ type: "error", error: error.message || "Streaming request failed" });
      res.end();
      return;
    }

    if (!assistantText.trim()) {
      sendEvent({ type: "error", error: "Provider returned empty content" });
      res.end();
      return;
    }

    try {
      const payload = await finalizeChatTurn({
        storyId,
        story: chat.story,
        provider: chat.provider,
        workspace: chat.workspace,
        memoryRecords: chat.memoryRecords,
        nextMessages: chat.nextMessages,
        userMessage: chat.userMessage,
        contextInfo: chat.contextInfo,
        summaryTriggers: chat.summaryTriggers,
        promptMessages: chat.promptMessages,
        assistantText,
        completionMeta: {
          endpoint: providerMeta.endpoint,
          latencyMs: Date.now() - providerMeta.startedAt,
          promptMessages: chat.promptMessages.length,
        },
      });
      sendEvent({ type: "done", payload });
    } catch (error) {
      sendEvent({ type: "error", error: error.message || "Failed to finalize chat turn" });
    }
    res.end();
  }

  function reviseLastExchange(storyId, replacementMessage) {
    const story = getStory(storyId);
    if (!story) {
      throw new Error("Story not found");
    }

    const nextUserContent = String(replacementMessage || "").trim();
    if (!nextUserContent) {
      throw new Error("Message is required");
    }

    const messages = readJsonLines(getStoryMessagesFile(storyId));
    if (messages.length < 2) {
      throw new Error("No recent exchange to revise");
    }
    const lastAssistant = messages[messages.length - 1];
    const lastUser = messages[messages.length - 2];
    if (lastAssistant.role !== "assistant" || lastUser.role !== "user") {
      throw new Error("Only the latest user input can be revised");
    }

    writeJsonLines(getStoryMessagesFile(storyId), messages.slice(0, -2));

    const snapshots = readJsonLines(getStorySnapshotFile(storyId));
    const latestSnapshot = snapshots[snapshots.length - 1] || null;
    if (latestSnapshot) {
      writeJsonLines(getStorySnapshotFile(storyId), snapshots.slice(0, -1));

      const summaryIds = new Set(latestSnapshot.generatedSummaryIds || []);
      if (summaryIds.size > 0) {
        const consolidatedSourceIds = new Set(latestSnapshot.consolidatedMemorySourceIds || []);
        const supersededLongTermIds = new Set(latestSnapshot.supersededLongTermIds || []);
        const memory = readJsonLines(getStoryMemoryFile(storyId))
          .filter((item) => !summaryIds.has(item.id))
          .map((item) => {
            const next = { ...item };
            if (consolidatedSourceIds.has(item.id)) {
              delete next.mergedInto;
              delete next.mergedAt;
            }
            if (supersededLongTermIds.has(item.id)) {
              delete next.supersededBy;
              delete next.supersededAt;
            }
            return next;
          });
        writeJsonLines(getStoryMemoryFile(storyId), memory);
      }

      const proposalIds = new Set(latestSnapshot.generatedProposalIds || []);
      if (proposalIds.size > 0) {
        const proposals = readJsonLines(getStoryProposalFile(storyId)).filter((item) => !proposalIds.has(item.id));
        writeJsonLines(getStoryProposalFile(storyId), proposals);
      }
    }

    const remainingSnapshots = readJsonLines(getStorySnapshotFile(storyId));
    const previousSnapshot = remainingSnapshots[remainingSnapshots.length - 1] || null;
    saveStory({
      ...story,
      updatedAt: new Date().toISOString(),
      contextStatus: previousSnapshot?.contextStatus || getDefaultContextStatus(story),
    });

    return handleChat(storyId, { message: nextUserContent });
  }

  function buildStoryPreview(storyId) {
    const story = getStory(storyId);
    if (!story) {
      throw new Error("Story not found");
    }
    const workspace = buildWorkspace(storyId, story.enabled || {});
    const messages = readJsonLines(getStoryMessagesFile(storyId));
    const memoryRecords = readJsonLines(getStoryMemoryFile(storyId));
    const currentContextInfo = buildContextBlocks(story, messages, memoryRecords, workspace);
    const currentPromptMessages = buildPromptMessages(
      currentContextInfo.blocks,
      story.promptConfig?.userPromptTemplate || "",
      "[当前用户输入将插入这里]"
    );
    const snapshots = readJsonLines(getStorySnapshotFile(storyId));
    return {
      story,
      messages,
      memoryRecords,
      proposals: readJsonLines(getStoryProposalFile(storyId)),
      diagnostics: {
        latestSnapshot: snapshots[snapshots.length - 1] || null,
        snapshotCount: snapshots.length,
        proposalPipeline: (snapshots[snapshots.length - 1] || null)?.proposalPipeline || null,
        currentContextPreview: {
          contextStatus: {
            ...getDefaultContextStatus(story),
            usedTokens: currentContextInfo.usedTokens,
            maxTokens: currentContextInfo.maxTokens,
            usedBlocks: currentContextInfo.usedBlocks,
            maxBlocks: currentContextInfo.maxBlocks,
            pressureLevel: classifyPressure(currentContextInfo.usedTokens, currentContextInfo.maxTokens),
          },
          contextBlocks: currentContextInfo.blocks.map((block) => ({
            label: block.label,
            tokens: block.tokens,
            preview: summarizeText(block.content, 220),
          })),
          selectedMemoryRecords: currentContextInfo.selectedMemoryRecords.map((item) => ({
            id: item.id,
            tier: item.tier || "short_term",
            kind: item.kind || "plot_checkpoint",
            summary: item.summary,
            importance: item.importance || "medium",
            reasons: currentContextInfo.selectedMemoryReasons[item.id] || [],
          })),
          promptMessages: currentPromptMessages,
        },
      },
      workspace,
    };
  }

  return {
    replaceTemplate,
    buildPromptMessages,
    buildChatContext,
    finalizeChatTurn,
    handleChat,
    handleChatStream,
    reviseLastExchange,
    buildStoryPreview,
  };
}

module.exports = {
  createChatTools,
};
