const { createChatContextTools } = require("./chat-context");
const { createChatGroundingTools } = require("./chat-grounding");
const { createChatReviseTools } = require("./chat-revise");
const { createChatTurnTools } = require("./chat-turn");

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
  evaluateAssistantGrounding = () => null,
  buildEndpointUrl,
  callOpenAICompatible,
  streamOpenAICompatible,
}) {
  const contextTools = createChatContextTools({
    safeId,
    getAppConfig,
    getStory,
    getProviderForStory,
    decryptSecret,
    getSummaryTriggers,
    syncStoryWorkspace,
    loadActiveWorkspaceItems,
    readJsonLines,
    getStoryMessagesFile,
    getStoryMemoryFile,
    getStoryMemoryChunkFile,
    buildContextBlocks,
  });
  const groundingTools = createChatGroundingTools({
    evaluateAssistantGrounding,
    buildEndpointUrl,
    callOpenAICompatible,
  });
  const reviseTools = createChatReviseTools({
    getStory,
    saveStory,
    getDefaultContextStatus,
    readJsonLines,
    writeJson,
    writeJsonLines,
    getStoryMessagesFile,
    getStoryMemoryFile,
    getStoryMemoryChunkFile,
    getStoryProposalFile,
    getStorySnapshotFile,
    getStoryWorkspaceDir,
  });
  const turnTools = createChatTurnTools({
    safeId,
    summarizeText,
    readJsonLines,
    appendJsonLine,
    writeJsonLines,
    saveStory,
    getStoryMessagesFile,
    getStoryMemoryFile,
    getStoryMemoryChunkFile,
    getStoryProposalFile,
    getStorySnapshotFile,
    getSummaryTriggers,
    getSummarySchedule,
    buildTransientMemoryCandidate,
    generateMemoryUpdate,
    generateProposalUpdate,
    detectForgetfulness,
    evaluateAssistantGrounding,
    buildEndpointUrl,
    buildGroundingInputs: groundingTools.buildGroundingInputs,
    uniqueStrings: contextTools.uniqueStrings,
  });
  const {
    buildChatContext,
    buildPromptMessages,
    buildWorkspace,
    getResolvedLocalEmbeddingMode,
    replaceTemplate,
    uniqueStrings,
    withResolvedPromptConfig,
  } = contextTools;
  const { buildGroundingInputs, maybeRepairGrounding } = groundingTools;
  const { finalizeChatTurn } = turnTools;
  const { prepareReviseLastExchange, restoreReviseState } = reviseTools;

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
    const groundedResult = await maybeRepairGrounding({
      story: chat.story,
      provider: chat.provider,
      apiKey: chat.apiKey,
      promptMessages: chat.promptMessages,
      contextInfo: chat.contextInfo,
      assistantText,
      completionMeta,
    });
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
      assistantText: groundedResult.assistantText,
      completionMeta: groundedResult.completionMeta,
      groundingCheckOverride: groundedResult.groundingCheck,
      groundingRepair: groundedResult.groundingRepair,
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
      const groundedResult = await maybeRepairGrounding({
        story: chat.story,
        provider: chat.provider,
        apiKey: chat.apiKey,
        promptMessages: chat.promptMessages,
        contextInfo: chat.contextInfo,
        assistantText,
        completionMeta: {
          endpoint: providerMeta.endpoint,
          latencyMs: Date.now() - providerMeta.startedAt,
          promptMessages: chat.promptMessages.length,
        },
      });
      if (groundedResult.groundingRepair?.applied && groundedResult.assistantText !== assistantText) {
        sendEvent({ type: "replace", text: groundedResult.assistantText });
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
        assistantText: groundedResult.assistantText,
        completionMeta: groundedResult.completionMeta,
        groundingCheckOverride: groundedResult.groundingCheck,
        groundingRepair: groundedResult.groundingRepair,
      });
      sendEvent({ type: "done", payload });
    } catch (error) {
      sendEvent({ type: "error", error: error.message || "Failed to finalize chat turn" });
    }
    res.end();
  }

  async function reviseLastExchange(storyId, replacementMessage) {
    const nextUserContent = String(replacementMessage || "").trim();
    if (!nextUserContent) {
      throw new Error("Message is required");
    }
    const preparedState = prepareReviseLastExchange(storyId);

    try {
      const result = await handleChat(storyId, { message: nextUserContent });
      if ((result?.status || 500) >= 400) {
        restoreReviseState(preparedState);
      }
      return result;
    } catch (error) {
      restoreReviseState(preparedState);
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
    const configuredEmbeddingMode = getResolvedLocalEmbeddingMode(story);
    const currentContextInfo = await buildContextBlocks(story, messages, memoryRecords, workspace, {
      memoryChunks,
      embeddingOptions: {
        ...(getAppConfig?.().localEmbedding || {}),
        mode: "off",
      },
    });
    currentContextInfo.memoryRetrievalMeta = currentContextInfo.memoryRetrievalMeta || {
      mode: "rag",
      activeMode: "lexical",
      vectorEnabled: false,
      vectorCandidateCount: 0,
      vectorSelectedCount: 0,
      evidenceCandidateCount: 0,
      evidenceSelectedCount: 0,
      contestedCandidateCount: 0,
      canonicalCandidateCount: 0,
      canonicalSelectedCount: 0,
      recentCandidateCount: 0,
      recentSelectedCount: 0,
      canonicalBudget: 0,
      recentBudget: 0,
      episodicCandidateCount: 0,
      episodicSelectedCount: 0,
      supportCandidateCount: 0,
      supportSelectedCount: 0,
      episodicBudget: 0,
      supportBudget: 0,
      fallbackReason: "",
    };
    currentContextInfo.knowledgeRetrievalMeta = currentContextInfo.knowledgeRetrievalMeta || {
      mode: "rag",
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
        mode: "rag",
        activeMode: "lexical",
        vectorEnabled: false,
        fallbackReason:
          currentContextInfo.memoryRetrievalMeta.fallbackReason ||
          "Story preview skips local embeddings to keep story switching responsive.",
      };
      currentContextInfo.knowledgeRetrievalMeta = {
        ...currentContextInfo.knowledgeRetrievalMeta,
        mode: "rag",
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
          retrievalPlan: currentContextInfo.retrievalPlan || null,
          retrievalFusionMeta: currentContextInfo.retrievalFusionMeta || null,
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
            canonKey: item.canonKey || "",
            conflictGroup: item.conflictGroup || "",
            sourceMessageRange: Array.isArray(item.sourceMessageRange) ? item.sourceMessageRange : [],
            confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
            reasons: currentContextInfo.selectedMemoryReasons[item.id] || [],
          })),
          selectedMemoryEvidence: (currentContextInfo.selectedMemoryEvidence || []).map((item) => ({
            id: item.id,
            type: item.type || "memory_evidence",
            linkedRecordId: item.linkedRecordId || "",
            text: item.text || "",
            sourceRole: item.sourceRole || "",
            scope: item.scope || "plot",
            subjectIds: Array.isArray(item.subjectIds) ? item.subjectIds : [],
            tags: Array.isArray(item.tags) ? item.tags : [],
            canonKey: item.canonKey || "",
            conflictGroup: item.conflictGroup || "",
            sourceMessageRange: Array.isArray(item.sourceMessageRange) ? item.sourceMessageRange : [],
            confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
            reasons: currentContextInfo.selectedMemoryEvidenceReasons[item.id] || [],
          })),
          selectedContestedMemoryRecords: (currentContextInfo.selectedContestedMemoryRecords || []).map((item) => ({
            id: item.id,
            tier: item.tier || "short_term",
            kind: item.kind || "plot_checkpoint",
            summary: item.summary,
            importance: item.importance || "medium",
            scope: item.scope || "plot",
            subjectIds: Array.isArray(item.subjectIds) ? item.subjectIds : [],
            tags: Array.isArray(item.tags) ? item.tags : [],
            canonKey: item.canonKey || "",
            conflictGroup: item.conflictGroup || "",
            sourceMessageRange: Array.isArray(item.sourceMessageRange) ? item.sourceMessageRange : [],
            confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
            reasons: currentContextInfo.selectedContestedMemoryReasons?.[item.id] || [],
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
    prepareReviseLastExchange,
    reviseLastExchange,
    buildStoryPreview,
  };
}

module.exports = {
  createChatTools,
};
