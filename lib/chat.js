const fs = require("fs");
const path = require("path");

function createChatTools({
  safeId,
  summarizeText,
  jsonResponse,
  sendJson,
  getAppConfig,
  getStory,
  saveStory,
  getProviderForStory,
  decryptSecret,
  syncStoryWorkspace,
  loadActiveWorkspaceItems,
  readJsonLines,
  appendJsonLine,
  writeJson,
  writeJsonLines,
  getStoryMessagesFile,
  getStoryMemoryFile,
  getStoryMemoryChunkFile,
  getStoryProposalFile,
  getStorySnapshotFile,
  getStoryWorkspaceDir,
  getDefaultContextStatus,
  buildContextBlocks,
  classifyPressure,
  getSummaryTriggers,
  getSummarySchedule,
  buildTransientMemoryCandidate,
  generateMemoryUpdate,
  generateProposalUpdate,
  detectForgetfulness,
  buildEndpointUrl,
  callOpenAICompatible,
  streamOpenAICompatible,
}) {
  function getResolvedGlobalSystemPrompt(story) {
    const appConfig = getAppConfig?.() || {};
    return (
      String(appConfig.globalSystemPrompt || "").trim() ||
      String(story?.promptConfig?.globalSystemPrompt || "").trim()
    );
  }

  function getResolvedMemoryRetrievalMode(story) {
    const appConfig = getAppConfig?.() || {};
    const storyMode = String(story?.settings?.memoryRetrievalMode || "inherit").trim().toLowerCase();
    if (storyMode === "lexical" || storyMode === "hybrid" || storyMode === "rag") {
      return storyMode;
    }
    if (appConfig.memoryRetrievalMode === "hybrid" || appConfig.memoryRetrievalMode === "rag") {
      return appConfig.memoryRetrievalMode;
    }
    return "lexical";
  }

  function getResolvedKnowledgeRetrievalMode(story) {
    const appConfig = getAppConfig?.() || {};
    const storyMode = String(story?.settings?.knowledgeRetrievalMode || "inherit").trim().toLowerCase();
    if (storyMode === "lexical" || storyMode === "hybrid") {
      return storyMode;
    }
    if (appConfig.knowledgeRetrievalModeSource === "derived") {
      return getResolvedLocalEmbeddingMode(story) === "on" ? "hybrid" : "lexical";
    }
    return appConfig.knowledgeRetrievalMode === "hybrid" ? "hybrid" : "lexical";
  }

  function getResolvedLocalEmbeddingMode(story) {
    const appConfig = getAppConfig?.() || {};
    const storyMode = String(story?.settings?.localEmbeddingMode || "inherit").trim().toLowerCase();
    const appMode = String(appConfig.localEmbedding?.mode || "off").trim().toLowerCase();
    return storyMode === "on" || storyMode === "off" ? storyMode : appMode === "on" ? "on" : "off";
  }

  function withResolvedPromptConfig(story) {
    return {
      ...story,
      settings: {
        ...(story?.settings || {}),
        memoryRetrievalMode: story?.settings?.memoryRetrievalMode || "inherit",
        knowledgeRetrievalMode: story?.settings?.knowledgeRetrievalMode || "inherit",
        localEmbeddingMode: story?.settings?.localEmbeddingMode || "inherit",
      },
      promptConfig: {
        ...(story?.promptConfig || {}),
        globalSystemPrompt: getResolvedGlobalSystemPrompt(story),
      },
    };
  }

  function replaceTemplate(template, userInput) {
    return String(template || "").replace(/\{\{user_input\}\}/g, userInput);
  }

  function uniqueStrings(values = []) {
    return Array.from(new Set((values || []).filter(Boolean).map((item) => String(item))));
  }

  function cloneStoryEnabled(enabled = {}) {
    return {
      characters: Array.isArray(enabled.characters) ? [...enabled.characters] : [],
      worldbooks: Array.isArray(enabled.worldbooks) ? [...enabled.worldbooks] : [],
      styles: Array.isArray(enabled.styles) ? [...enabled.styles] : [],
    };
  }

  function getWorkspaceProposalFilePath(storyId, targetType, targetId) {
    return path.join(getStoryWorkspaceDir(storyId, `${targetType}s`), `${targetId}.json`);
  }

  function collectWorkspaceFileBackups(storyId, proposals = []) {
    const backups = [];
    const seenKeys = new Set();
    for (const proposal of proposals) {
      const undo = proposal?.acceptanceUndo;
      if (!undo?.targetType || !undo?.targetId) {
        continue;
      }
      const key = `${undo.targetType}:${undo.targetId}`;
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      const filePath = getWorkspaceProposalFilePath(storyId, undo.targetType, undo.targetId);
      if (!fs.existsSync(filePath)) {
        backups.push({ filePath, exists: false, value: null });
        continue;
      }
      backups.push({
        filePath,
        exists: true,
        value: JSON.parse(fs.readFileSync(filePath, "utf8")),
      });
    }
    return backups;
  }

  function restoreWorkspaceFileBackups(backups = []) {
    for (const backup of backups) {
      if (backup.exists) {
        writeJson(backup.filePath, backup.value);
      } else if (fs.existsSync(backup.filePath)) {
        fs.unlinkSync(backup.filePath);
      }
    }
  }

  function rollbackAcceptedProposalEffects(storyId, proposals = []) {
    let currentStory = getStory(storyId);
    if (!currentStory) {
      return;
    }
    for (const proposal of [...proposals].reverse()) {
      const undo = proposal?.acceptanceUndo;
      if (!undo?.targetType || !undo?.targetId) {
        continue;
      }
      const filePath = getWorkspaceProposalFilePath(storyId, undo.targetType, undo.targetId);
      if (undo.previousItem) {
        writeJson(filePath, undo.previousItem);
      } else if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      if (undo.previousStoryEnabled) {
        currentStory = {
          ...currentStory,
          enabled: cloneStoryEnabled(undo.previousStoryEnabled),
          updatedAt: new Date().toISOString(),
        };
        saveStory(currentStory);
      }
    }
  }

  function restoreReviseState({
    story,
    messages,
    memory,
    memoryChunks,
    proposals,
    snapshots,
    workspaceBackups,
  }) {
    writeJsonLines(getStoryMessagesFile(story.id), messages);
    writeJsonLines(getStoryMemoryFile(story.id), memory);
    writeJsonLines(getStoryMemoryChunkFile(story.id), memoryChunks);
    writeJsonLines(getStoryProposalFile(story.id), proposals);
    writeJsonLines(getStorySnapshotFile(story.id), snapshots);
    restoreWorkspaceFileBackups(workspaceBackups);
    saveStory(story);
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

  async function buildChatContext(storyId, body) {
    const rawStory = getStory(storyId);
    const story = rawStory ? withResolvedPromptConfig(rawStory) : rawStory;
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
    const memoryChunks = readJsonLines(getStoryMemoryChunkFile(storyId));
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
    const configuredMemoryRetrievalMode = getResolvedMemoryRetrievalMode(story);
    const configuredKnowledgeRetrievalMode = getResolvedKnowledgeRetrievalMode(story);
    const contextInfo = await buildContextBlocks(story, nextMessages, memoryRecords, workspace, {
      currentUserInput: userMessage.content,
      memoryChunks,
      memoryRetrievalMode: configuredMemoryRetrievalMode,
      knowledgeRetrievalMode: configuredKnowledgeRetrievalMode,
      embeddingOptions: {
        ...(getAppConfig?.().localEmbedding || {}),
        mode: getResolvedLocalEmbeddingMode(story),
      },
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
      memoryChunks,
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
    memoryChunks,
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
    const effectiveSummaryTriggers = uniqueStrings([
      ...(summaryTriggers || []),
      ...getSummaryTriggers(story, fullMessages, contextInfo),
    ]);

    const summaryRecords = [];
    let summarySchedule = getSummarySchedule(story, fullMessages);
    let consolidatedMemoryRecords = [];
    let summaryChunks = [];
    let consolidatedMemorySourceIds = [];
    let supersededLongTermIds = [];
    if (effectiveSummaryTriggers.length > 0) {
      const memoryUpdate = await generateMemoryUpdate({
        story,
        fullMessages,
        memoryRecords,
        memoryChunks,
        workspace,
        summaryTriggers: effectiveSummaryTriggers,
      });
      summarySchedule = memoryUpdate.summarySchedule;
      summaryRecords.push(...memoryUpdate.summaryRecords);
      summaryChunks = memoryUpdate.summaryChunks || [];
      consolidatedMemoryRecords = memoryUpdate.consolidatedMemoryRecords;
      consolidatedMemorySourceIds = memoryUpdate.consolidatedMemorySourceIds;
      supersededLongTermIds = memoryUpdate.supersededLongTermIds;
      writeJsonLines(getStoryMemoryFile(storyId), memoryUpdate.records);
      writeJsonLines(getStoryMemoryChunkFile(storyId), memoryUpdate.chunks || memoryChunks);
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

    const storedMemoryRecords = readJsonLines(getStoryMemoryFile(storyId));
    const transientMemoryCandidate =
      summaryRecords.length || consolidatedMemoryRecords.length || typeof buildTransientMemoryCandidate !== "function"
        ? null
        : buildTransientMemoryCandidate(story, fullMessages, workspace);
    const finalMemoryRecords = transientMemoryCandidate
      ? [...storedMemoryRecords, transientMemoryCandidate]
      : storedMemoryRecords;
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
        forgetfulnessSignals: forgetfulness.forgetfulnessSignals,
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
      summaryTriggers: effectiveSummaryTriggers,
      summarySchedule,
      proposalTriggers,
      proposalPipeline,
      usedLabels: contextInfo.blocks.map((block) => block.label),
      contextBlocks: contextInfo.blocks.map((block) => ({
        label: block.label,
        tokens: block.tokens,
        preview: summarizeText(block.content, 220),
      })),
      memoryRetrievalMeta: contextInfo.memoryRetrievalMeta,
      knowledgeRetrievalMeta: contextInfo.knowledgeRetrievalMeta,
      promptMessages,
      generatedSummaryIds: [...summaryRecords, ...consolidatedMemoryRecords].map((item) => item.id),
      generatedChunkIds: summaryChunks.map((item) => item.id),
      consolidatedMemorySourceIds: Array.from(new Set(consolidatedMemorySourceIds)),
      supersededLongTermIds: Array.from(new Set(supersededLongTermIds)),
      transientMemoryCandidate: transientMemoryCandidate
        ? {
            summary: transientMemoryCandidate.summary,
            scope: transientMemoryCandidate.scope || "plot",
            source: "diagnostic_only",
          }
        : null,
      generatedProposalIds: proposalRecords.map((item) => item.id),
      generatedSummaryCount: summaryRecords.length + consolidatedMemoryRecords.length,
      generatedChunkCount: summaryChunks.length,
      generatedProposalCount: proposalRecords.length,
    };
    appendJsonLine(getStorySnapshotFile(storyId), snapshot);

    return {
      message: assistantMessage,
      memoryRecords: [...summaryRecords, ...consolidatedMemoryRecords],
      memoryChunks: summaryChunks,
      proposals: proposalRecords,
      contextStatus: updatedStory.contextStatus,
      diagnostics: {
        latestSnapshot: snapshot,
        snapshotCount: readJsonLines(getStorySnapshotFile(storyId)).length,
        requestMeta: snapshot.requestMeta,
        summaryTriggers: effectiveSummaryTriggers,
        summarySchedule,
        proposalTriggers,
        proposalPipeline,
        usedLabels: snapshot.usedLabels,
        contextBlocks: snapshot.contextBlocks,
        memoryRetrievalMeta: snapshot.memoryRetrievalMeta,
        knowledgeRetrievalMeta: snapshot.knowledgeRetrievalMeta,
        transientMemoryCandidate: snapshot.transientMemoryCandidate,
        generatedSummaryCount: summaryRecords.length,
        generatedChunkCount: summaryChunks.length,
        generatedProposalCount: proposalRecords.length,
      },
    };
  }

  async function handleChat(storyId, body) {
    let chat;
    try {
      chat = await buildChatContext(storyId, body);
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
        reasoningEffort: chat.story.settings.reasoningEffort,
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
      memoryChunks: chat.memoryChunks,
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
      chat = await buildChatContext(storyId, body);
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
        reasoningEffort: chat.story.settings.reasoningEffort,
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
        memoryChunks: chat.memoryChunks,
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

  async function reviseLastExchange(storyId, replacementMessage) {
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

    const memoryBeforeRevise = readJsonLines(getStoryMemoryFile(storyId));
    const memoryChunksBeforeRevise = readJsonLines(getStoryMemoryChunkFile(storyId));
    const proposalsBeforeRevise = readJsonLines(getStoryProposalFile(storyId));
    const snapshots = readJsonLines(getStorySnapshotFile(storyId));
    let workspaceBackups = [];

    writeJsonLines(getStoryMessagesFile(storyId), messages.slice(0, -2));
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
      const chunkIds = new Set(latestSnapshot.generatedChunkIds || []);
      if (chunkIds.size > 0) {
        const memoryChunks = readJsonLines(getStoryMemoryChunkFile(storyId)).filter((item) => !chunkIds.has(item.id));
        writeJsonLines(getStoryMemoryChunkFile(storyId), memoryChunks);
      }

      const proposalIds = new Set(latestSnapshot.generatedProposalIds || []);
      if (proposalIds.size > 0) {
        const storedProposals = proposalsBeforeRevise;
        const generatedProposals = storedProposals.filter((item) => proposalIds.has(item.id));
        const acceptedGeneratedProposals = generatedProposals.filter((item) => item.status === "accepted");
        if (acceptedGeneratedProposals.length) {
          workspaceBackups = collectWorkspaceFileBackups(storyId, acceptedGeneratedProposals);
          rollbackAcceptedProposalEffects(storyId, acceptedGeneratedProposals);
        }
        const proposals = storedProposals.filter((item) => !proposalIds.has(item.id));
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

    try {
      const result = await handleChat(storyId, { message: nextUserContent });
      if ((result?.status || 500) >= 400) {
        restoreReviseState({
          story,
          messages,
          memory: memoryBeforeRevise,
          memoryChunks: memoryChunksBeforeRevise,
          proposals: proposalsBeforeRevise,
          snapshots,
          workspaceBackups,
        });
      }
      return result;
    } catch (error) {
      restoreReviseState({
        story,
        messages,
        memory: memoryBeforeRevise,
        memoryChunks: memoryChunksBeforeRevise,
        proposals: proposalsBeforeRevise,
        snapshots,
        workspaceBackups,
      });
      throw error;
    }
  }

  async function buildStoryPreview(storyId) {
    const rawStory = getStory(storyId);
    const story = rawStory ? withResolvedPromptConfig(rawStory) : rawStory;
    if (!story) {
      throw new Error("Story not found");
    }
    const workspace = buildWorkspace(storyId, story.enabled || {});
    const messages = readJsonLines(getStoryMessagesFile(storyId));
    const memoryRecords = readJsonLines(getStoryMemoryFile(storyId));
    const memoryChunks = readJsonLines(getStoryMemoryChunkFile(storyId));
    const configuredMemoryRetrievalMode = getResolvedMemoryRetrievalMode(story);
    const configuredKnowledgeRetrievalMode = getResolvedKnowledgeRetrievalMode(story);
    const configuredEmbeddingMode = getResolvedLocalEmbeddingMode(story);
    const currentContextInfo = await buildContextBlocks(story, messages, memoryRecords, workspace, {
      memoryChunks,
      memoryRetrievalMode: configuredMemoryRetrievalMode,
      knowledgeRetrievalMode: configuredKnowledgeRetrievalMode,
      embeddingOptions: {
        ...(getAppConfig?.().localEmbedding || {}),
        mode: "off",
      },
    });
    currentContextInfo.memoryRetrievalMeta = currentContextInfo.memoryRetrievalMeta || {
      mode: configuredMemoryRetrievalMode,
      activeMode: "lexical",
      vectorEnabled: false,
      vectorCandidateCount: 0,
      vectorSelectedCount: 0,
      evidenceCandidateCount: 0,
      evidenceSelectedCount: 0,
      fallbackReason: "",
    };
    currentContextInfo.knowledgeRetrievalMeta = currentContextInfo.knowledgeRetrievalMeta || {
      mode: configuredKnowledgeRetrievalMode,
      activeMode: "lexical",
      vectorEnabled: false,
      vectorCandidateCount: 0,
      vectorSelectedCount: 0,
      fallbackReason: "",
      vectorProvider: "",
      vectorFailure: "",
      cachedVectorCount: 0,
    };
    if (configuredEmbeddingMode === "on") {
      currentContextInfo.memoryRetrievalMeta = {
        ...currentContextInfo.memoryRetrievalMeta,
        mode: configuredMemoryRetrievalMode,
        activeMode: "lexical",
        vectorEnabled: false,
        fallbackReason:
          currentContextInfo.memoryRetrievalMeta.fallbackReason ||
          "Story preview skips local embeddings to keep story switching responsive.",
      };
      currentContextInfo.knowledgeRetrievalMeta = {
        ...currentContextInfo.knowledgeRetrievalMeta,
        mode: configuredKnowledgeRetrievalMode,
        activeMode: "lexical",
        vectorEnabled: false,
        fallbackReason:
          currentContextInfo.knowledgeRetrievalMeta.fallbackReason ||
          "Story preview skips local embeddings to keep story switching responsive.",
        vectorFailure:
          currentContextInfo.knowledgeRetrievalMeta.vectorFailure ||
          "Story preview skips local embeddings to keep story switching responsive.",
      };
    }
    const currentPromptMessages = buildPromptMessages(
      currentContextInfo.blocks,
      story.promptConfig?.userPromptTemplate || "",
      "[The current user input will be inserted here]"
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
          memoryRetrievalMeta: currentContextInfo.memoryRetrievalMeta,
          knowledgeRetrievalMeta: currentContextInfo.knowledgeRetrievalMeta,
          contextBlocks: currentContextInfo.blocks.map((block) => ({
            label: block.label,
            tokens: block.tokens,
            preview: summarizeText(block.content, 220),
          })),
          selectedKnowledgeChunks: currentContextInfo.selectedKnowledgeChunks.map((item) => ({
            id: item.id,
            sourceType: item.sourceType,
            sourceId: item.sourceId,
            chunkType: item.chunkType || "",
            title: item.title,
            text: item.text,
            reasons: item.reasons || [],
          })),
          selectedMemoryRecords: currentContextInfo.selectedMemoryRecords.map((item) => ({
            id: item.id,
            tier: item.tier || "short_term",
            kind: item.kind || "plot_checkpoint",
            summary: item.summary,
            importance: item.importance || "medium",
            scope: item.scope || "plot",
            subjectIds: Array.isArray(item.subjectIds) ? item.subjectIds : [],
            tags: Array.isArray(item.tags) ? item.tags : [],
            reasons: currentContextInfo.selectedMemoryReasons[item.id] || [],
          })),
          selectedMemoryEvidence: (currentContextInfo.selectedMemoryEvidence || []).map((item) => ({
            id: item.id,
            linkedRecordId: item.linkedRecordId || "",
            text: item.text || "",
            sourceRole: item.sourceRole || "",
            scope: item.scope || "plot",
            subjectIds: Array.isArray(item.subjectIds) ? item.subjectIds : [],
            tags: Array.isArray(item.tags) ? item.tags : [],
            reasons: currentContextInfo.selectedMemoryEvidenceReasons[item.id] || [],
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
