function createChatContextTools({
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
    const appMode = String(appConfig.localEmbedding?.mode || "off").trim().toLowerCase();
    return appMode === "on" ? "on" : "off";
  }

  function withResolvedPromptConfig(story) {
    return {
      ...story,
      settings: {
        ...(story?.settings || {}),
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
    const promptMessages = buildPromptMessages(
      contextInfo.blocks,
      story.promptConfig?.userPromptTemplate || "",
      userMessage.content
    );
    const summaryTriggers = getSummaryTriggers(story, nextMessages, contextInfo);

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

  return {
    getResolvedGlobalSystemPrompt,
    getResolvedLocalEmbeddingMode,
    withResolvedPromptConfig,
    replaceTemplate,
    uniqueStrings,
    buildPromptMessages,
    buildWorkspace,
    buildChatContext,
  };
}

module.exports = {
  createChatContextTools,
};
