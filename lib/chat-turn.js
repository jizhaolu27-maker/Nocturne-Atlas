function createChatTurnTools({
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
  evaluateAssistantGrounding = () => null,
  buildEndpointUrl,
  buildGroundingInputs,
  uniqueStrings,
}) {
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
    let episodicChunks = [];
    let summaryChunks = [];
    let consolidatedMemorySourceIds = [];
    let supersededLongTermIds = [];
    const memoryUpdate = await generateMemoryUpdate({
      story,
      fullMessages,
      memoryRecords,
      memoryChunks,
      workspace,
      summaryTriggers: effectiveSummaryTriggers,
    });
    summarySchedule = memoryUpdate.summarySchedule;
    summaryRecords.push(...(memoryUpdate.summaryRecords || []));
    episodicChunks = memoryUpdate.episodicChunks || [];
    summaryChunks = memoryUpdate.summaryChunks || [];
    consolidatedMemoryRecords = memoryUpdate.consolidatedMemoryRecords || [];
    consolidatedMemorySourceIds = memoryUpdate.consolidatedMemorySourceIds || [];
    supersededLongTermIds = memoryUpdate.supersededLongTermIds || [];
    writeJsonLines(getStoryMemoryFile(storyId), memoryUpdate.records || memoryRecords);
    writeJsonLines(getStoryMemoryChunkFile(storyId), memoryUpdate.chunks || memoryChunks);

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
      summaryRecords.length || consolidatedMemoryRecords.length
        ? null
        : memoryUpdate?.transientMemoryCandidate ||
          (typeof buildTransientMemoryCandidate === "function"
            ? await buildTransientMemoryCandidate(story, fullMessages, workspace)
            : null);
    const finalMemoryRecords = transientMemoryCandidate
      ? [...storedMemoryRecords, transientMemoryCandidate]
      : storedMemoryRecords;
    const forgetfulness = detectForgetfulness({
      workspace,
      memoryRecords: finalMemoryRecords,
      assistantText,
      contextInfo,
      userInput: userMessage?.content || "",
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
      retrievalPlan: contextInfo.retrievalPlan || null,
      retrievalFusionMeta: contextInfo.retrievalFusionMeta || null,
      memoryRetrievalMeta: contextInfo.memoryRetrievalMeta,
      knowledgeRetrievalMeta: contextInfo.knowledgeRetrievalMeta,
      groundingCheck,
      groundingRepair,
      promptMessages,
      generatedSummaryIds: [...summaryRecords, ...consolidatedMemoryRecords].map((item) => item.id),
      generatedChunkIds: [...episodicChunks, ...summaryChunks].map((item) => item.id),
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
      generatedEpisodicChunkCount: episodicChunks.length,
      generatedSummaryChunkCount: summaryChunks.length,
      generatedChunkCount: episodicChunks.length + summaryChunks.length,
      generatedProposalCount: proposalRecords.length,
    };
    appendJsonLine(getStorySnapshotFile(storyId), snapshot);

    return {
      message: assistantMessage,
      memoryRecords: [...summaryRecords, ...consolidatedMemoryRecords],
      memoryChunks: [...episodicChunks, ...summaryChunks],
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
        retrievalPlan: snapshot.retrievalPlan,
        retrievalFusionMeta: snapshot.retrievalFusionMeta,
        memoryRetrievalMeta: snapshot.memoryRetrievalMeta,
        knowledgeRetrievalMeta: snapshot.knowledgeRetrievalMeta,
        groundingCheck: snapshot.groundingCheck,
        groundingRepair: snapshot.groundingRepair,
        transientMemoryCandidate: snapshot.transientMemoryCandidate,
        generatedSummaryCount: summaryRecords.length,
        generatedEpisodicChunkCount: episodicChunks.length,
        generatedSummaryChunkCount: summaryChunks.length,
        generatedChunkCount: episodicChunks.length + summaryChunks.length,
        generatedProposalCount: proposalRecords.length,
      },
    };
  }

  return {
    finalizeChatTurn,
  };
}

module.exports = {
  createChatTurnTools,
};
