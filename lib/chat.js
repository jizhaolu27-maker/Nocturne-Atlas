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
  evaluateAssistantGrounding = () => null,
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
        memoryRetrievalMode: "rag",
        knowledgeRetrievalMode: "rag",
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

  function formatGroundingSupportRefs(refs = []) {
    return (Array.isArray(refs) ? refs : [])
      .slice(0, 2)
      .map((item) => {
        const sourceType = String(item?.sourceType || "")
          .replace(/_/g, " ")
          .trim();
        const matchedTerms = Array.isArray(item?.matchedTerms) ? item.matchedTerms.filter(Boolean) : [];
        const base = `${sourceType || "support"}: ${item?.preview || item?.label || item?.id || "source"}`;
        return matchedTerms.length ? `${base} [matched: ${matchedTerms.join(", ")}]` : base;
      })
      .join(" | ");
  }

  function formatGroundingClauses(clauses = [], options = {}) {
    const includeSupport = Boolean(options.includeSupport);
    return (Array.isArray(clauses) ? clauses : [])
      .slice(0, 3)
      .map((item) => {
        const reasons = Array.isArray(item?.reasons) ? item.reasons.filter(Boolean) : [];
        const rows = [reasons.length ? `- ${item.text} (${reasons.join("; ")})` : `- ${item.text}`];
        if (includeSupport && Array.isArray(item?.supportRefs) && item.supportRefs.length) {
          rows.push(`  Canon support: ${formatGroundingSupportRefs(item.supportRefs)}`);
        }
        if (includeSupport && Array.isArray(item?.contestedSupportRefs) && item.contestedSupportRefs.length) {
          rows.push(`  Contested support: ${formatGroundingSupportRefs(item.contestedSupportRefs)}`);
        }
        return rows.join("\n");
      })
      .join("\n");
  }

  function getGroundingStateRank(state) {
    const ranks = {
      grounded: 0,
      caution: 1,
      insufficient_context: 2,
      risk: 3,
    };
    return ranks[String(state || "").trim()] ?? 2;
  }

  function shouldAttemptGroundingRepair(groundingCheck) {
    if (!groundingCheck || groundingCheck.state !== "risk") {
      return false;
    }
    return (
      Number(groundingCheck.unsupportedClauseCount || 0) > 0 || Number(groundingCheck.contestedClauseCount || 0) > 0
    );
  }

  function didGroundingImprove(previousCheck, nextCheck) {
    if (!nextCheck) {
      return false;
    }
    const previousRank = getGroundingStateRank(previousCheck?.state);
    const nextRank = getGroundingStateRank(nextCheck?.state);
    if (nextRank < previousRank) {
      return true;
    }
    if (Number(nextCheck.unsupportedClauseCount || 0) < Number(previousCheck?.unsupportedClauseCount || 0)) {
      return true;
    }
    if (Number(nextCheck.contestedClauseCount || 0) < Number(previousCheck?.contestedClauseCount || 0)) {
      return true;
    }
    if (Number(nextCheck.supportedClauseCount || 0) > Number(previousCheck?.supportedClauseCount || 0)) {
      return true;
    }
    return false;
  }

  function buildGroundingRepairMessages(promptMessages, assistantText, groundingCheck) {
    const supportedSection = formatGroundingClauses(groundingCheck?.supportedClauses, { includeSupport: true });
    const unsupportedSection = formatGroundingClauses(groundingCheck?.unsupportedClauses, { includeSupport: true });
    const contestedSection = formatGroundingClauses(groundingCheck?.contestedClauses, { includeSupport: true });
    return [
      ...promptMessages,
      { role: "assistant", content: assistantText },
      {
        role: "system",
        content: [
          "Revise the previous assistant answer so every claim stays grounded in the retrieved canon.",
          "Keep the same scene intent and tone.",
          "Preserve clauses that are already grounded whenever possible.",
          "Only revise unsupported or contested clauses unless a tiny wording adjustment is needed for flow.",
          "Remove unsupported claims, and soften disputed claims into uncertainty instead of stating them as settled fact.",
          "If support is thin, prefer omission over invention.",
          "Prefer the smallest rewrite that fixes grounding.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          "Rewrite the previous assistant answer conservatively using the grounding report below.",
          supportedSection ? `Grounded clauses to preserve if possible:\n${supportedSection}` : "",
          unsupportedSection ? `Unsupported clauses to remove or rewrite:\n${unsupportedSection}` : "",
          contestedSection ? `Contested clauses to soften into uncertainty:\n${contestedSection}` : "",
          "Keep already grounded chronology, cause-and-effect, and character intent whenever support exists.",
          "Return only the corrected in-story answer.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ];
  }

  function buildGroundingInputs(contextInfo, assistantText) {
    return {
      assistantText,
      selectedKnowledgeChunks: contextInfo.selectedKnowledgeChunks || [],
      selectedMemoryRecords: contextInfo.selectedMemoryRecords || [],
      selectedMemoryEvidence: contextInfo.selectedMemoryEvidence || [],
      contestedMemoryRecords: contextInfo.selectedContestedMemoryRecords || [],
    };
  }

  async function maybeRepairGrounding({
    story,
    provider,
    apiKey,
    promptMessages,
    contextInfo,
    assistantText,
    completionMeta,
  }) {
    if (typeof evaluateAssistantGrounding !== "function") {
      return {
        assistantText,
        completionMeta,
        groundingCheck: null,
        groundingRepair: null,
      };
    }

    const initialGroundingCheck = evaluateAssistantGrounding(buildGroundingInputs(contextInfo, assistantText));
    const groundingRepair = {
      attempted: false,
      applied: false,
      initialState: initialGroundingCheck?.state || "not_checked",
      finalState: initialGroundingCheck?.state || "not_checked",
      retryPromptMessages: 0,
      retryLatencyMs: 0,
      notes: [],
    };

    if (!shouldAttemptGroundingRepair(initialGroundingCheck)) {
      groundingRepair.notes.push("Auto-repair was not needed for this reply.");
      return {
        assistantText,
        completionMeta,
        groundingCheck: initialGroundingCheck,
        groundingRepair,
      };
    }

    groundingRepair.attempted = true;
    groundingRepair.notes.push("Triggered one conservative rewrite pass because the first reply failed the grounding check.");
    const repairMessages = buildGroundingRepairMessages(promptMessages, assistantText, initialGroundingCheck);
    groundingRepair.retryPromptMessages = repairMessages.length;

    try {
      const repairedCompletion = await callOpenAICompatible({
        baseUrl: provider.baseUrl,
        apiKey,
        model: story.model || provider.model,
        messages: repairMessages,
        temperature: story.settings.temperature,
        topP: story.settings.topP,
        max_tokens: story.settings.maxCompletionTokens,
        reasoningEffort: story.settings.reasoningEffort,
      });
      const repairedText = String(repairedCompletion?.content || "").trim();
      groundingRepair.retryLatencyMs = Number(repairedCompletion?.meta?.latencyMs || 0);
      if (!repairedText) {
        groundingRepair.notes.push("Auto-repair returned empty content, so the original reply was kept.");
        return {
          assistantText,
          completionMeta,
          groundingCheck: initialGroundingCheck,
          groundingRepair,
        };
      }

      const repairedGroundingCheck = evaluateAssistantGrounding(buildGroundingInputs(contextInfo, repairedText));
      groundingRepair.finalState = repairedGroundingCheck?.state || groundingRepair.initialState;

      if (!didGroundingImprove(initialGroundingCheck, repairedGroundingCheck)) {
        groundingRepair.notes.push("Auto-repair did not improve grounding enough, so the original reply was kept.");
        return {
          assistantText,
          completionMeta: {
            ...completionMeta,
            latencyMs: Number(completionMeta?.latencyMs || 0) + groundingRepair.retryLatencyMs,
          },
          groundingCheck: initialGroundingCheck,
          groundingRepair,
        };
      }

      groundingRepair.applied = true;
      groundingRepair.notes.push("Applied the grounded rewrite because it reduced unsupported or contested claims.");
      return {
        assistantText: repairedText,
        completionMeta: {
          ...completionMeta,
          latencyMs: Number(completionMeta?.latencyMs || 0) + groundingRepair.retryLatencyMs,
        },
        groundingCheck: repairedGroundingCheck,
        groundingRepair,
      };
    } catch (error) {
      groundingRepair.notes.push(`Auto-repair failed and the original reply was kept: ${error.message || "Unknown error"}`);
      return {
        assistantText,
        completionMeta,
        groundingCheck: initialGroundingCheck,
        groundingRepair,
      };
    }
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
    const contextInfo = await buildContextBlocks(story, nextMessages, memoryRecords, workspace, {
      currentUserInput: userMessage.content,
      memoryChunks,
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
    groundingCheckOverride,
    groundingRepair = null,
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
    const groundingCheck =
      groundingCheckOverride !== undefined
        ? groundingCheckOverride
        : typeof evaluateAssistantGrounding === "function"
          ? evaluateAssistantGrounding(buildGroundingInputs(contextInfo, assistantText))
          : null;
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
      groundingCheck,
      groundingRepair,
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
        groundingCheck: snapshot.groundingCheck,
        groundingRepair: snapshot.groundingRepair,
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
    reviseLastExchange,
    buildStoryPreview,
  };
}

module.exports = {
  createChatTools,
};
