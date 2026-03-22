const fs = require("fs");
const path = require("path");

function createProposalTools({
  PROPOSAL_REASON_CHAR_LIMIT,
  CHARACTER_ROLE_CHAR_LIMIT,
  CHARACTER_TRAIT_CHAR_LIMIT,
  CHARACTER_RELATIONSHIP_CHAR_LIMIT,
  CHARACTER_ARC_CHAR_LIMIT,
  CHARACTER_NOTES_CHAR_LIMIT,
  safeId,
  slugify,
  summarizeText,
  getProviderForStory,
  decryptSecret,
  callOpenAICompatible,
  tryParseJsonObject,
  readJson,
  writeJson,
  readJsonLines,
  writeJsonLines,
  getStory,
  saveStory,
  getStoryProposalFile,
  getStoryWorkspaceDir,
}) {
  function trimText(value, maxLength) {
    return summarizeText(String(value || "").trim(), maxLength);
  }

  function trimStringArray(values, itemLimit, maxItems) {
    if (!Array.isArray(values)) {
      return [];
    }
    return values
      .map((item) => trimText(item, itemLimit))
      .filter(Boolean)
      .slice(0, maxItems);
  }

  function trimStringMapValues(value, maxLength, maxItems = 12) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, maxItems)
        .map(([key, item]) => [String(key), trimText(item, maxLength)])
        .filter(([, item]) => item)
    );
  }

  function getHeuristicProposalTriggers(messages, assistantText = "") {
    const recentText = [...messages.slice(-4).map((item) => item.content), assistantText].join("\n").toLowerCase();
    const triggers = [];
    if (/(new recurring character|story-local character|新角色|角色卡|角色设定)/i.test(recentText)) {
      triggers.push("New recurring character indicators detected");
    }
    if (/(relationship|alliance|betray|trust|mentor|lover|关系|伴侣|恋人|信任|背叛)/i.test(recentText)) {
      triggers.push("Relationship change indicators detected");
    }
    if (/(world state|rule changed|setting changed|世界状态|规则变化|设定变化)/i.test(recentText)) {
      triggers.push("World-state change indicators detected");
    }
    return triggers;
  }

  async function tryModelProposalTriggers(story, messages, workspace, assistantText) {
    const provider = getProviderForStory(story);
    if (!provider || !provider.encryptedApiKey || !story.model) {
      return getHeuristicProposalTriggers(messages, assistantText);
    }
    const apiKey = decryptSecret(provider.encryptedApiKey);
    if (!apiKey) {
      return getHeuristicProposalTriggers(messages, assistantText);
    }
    const prompt = [
      {
        role: "system",
        content:
          "Decide whether the latest story turn should trigger workspace proposal generation. Return compact JSON with keys: shouldGenerateProposal (boolean), triggers (string array). Trigger when the turn introduces a meaningful new recurring character, a durable relationship shift, a stable character-state update, a world-state change, or the user explicitly asks to remember or update story canon. Do not trigger for one-off flavor details.",
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            workspace: {
              characters: workspace.characters.map((item) => ({ id: item.id, name: item.name })),
              worldbooks: workspace.worldbooks.map((item) => ({ id: item.id, title: item.title })),
            },
            recentMessages: messages.slice(-6),
            assistantReply: assistantText,
          },
          null,
          2
        ),
      },
    ];
    try {
      const result = await callOpenAICompatible({
        baseUrl: provider.baseUrl,
        apiKey,
        model: story.model || provider.model,
        messages: prompt,
        temperature: 0.1,
        topP: 1,
        max_tokens: 160,
        responseFormat: { type: "json_object" },
      });
      const parsed = tryParseJsonObject(result.content);
      if (!parsed?.shouldGenerateProposal) {
        return [];
      }
      return Array.isArray(parsed.triggers)
        ? parsed.triggers.slice(0, 4).map((item) => String(item))
        : ["AI proposal trigger approved"];
    } catch {
      return getHeuristicProposalTriggers(messages, assistantText);
    }
  }

  async function tryGenerateProposals(story, messages, workspace) {
    const provider = getProviderForStory(story);
    if (!provider || !provider.encryptedApiKey || !story.model) {
      return [];
    }
    const apiKey = decryptSecret(provider.encryptedApiKey);
    if (!apiKey) {
      return [];
    }
    const prompt = [
      {
        role: "system",
        content:
          "Review recent fictional story messages. Return JSON: { proposals: [{ action, targetType, targetId, reason, patch }] }. action must be update or create. Use update when an existing workspace item changed in a meaningful way. Only allow create for targetType=character when the story clearly introduces a meaningful new recurring character with stable traits, relationships, or future plot importance who should live only inside this story workspace. Do not create one-off extras. Keep every field compact and retrieval-friendly, not literary. reason must be one short sentence, ideally 20-60 Chinese characters or under 18 English words. For create character patches, include name, core, traits, relationships, arcState, and notes, but keep them terse: role short phrase, traits short keywords, relationships short labels, arcState.current one compact sentence, notes one compact sentence.",
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            workspace: {
              characters: workspace.characters.map((item) => ({
                id: item.id,
                name: item.name,
                arcState: item.arcState,
                relationships: item.relationships,
              })),
              worldbooks: workspace.worldbooks.map((item) => ({
                id: item.id,
                title: item.title,
                storyState: item.storyState,
                revealedFacts: item.revealedFacts,
              })),
            },
            recentMessages: messages.slice(-6),
          },
          null,
          2
        ),
      },
    ];
    try {
      const result = await callOpenAICompatible({
        baseUrl: provider.baseUrl,
        apiKey,
        model: story.model || provider.model,
        messages: prompt,
        temperature: 0.3,
        topP: 1,
        max_tokens: 500,
        responseFormat: { type: "json_object" },
      });
      const parsed = tryParseJsonObject(result.content);
      if (!Array.isArray(parsed?.proposals)) {
        return [];
      }
      const allowedTypes = new Set(["character", "worldbook", "style"]);
      return parsed.proposals
        .filter(
          (item) =>
            ["update", "create"].includes(item?.action || "update") &&
            allowedTypes.has(item?.targetType) &&
            item?.patch &&
            typeof item.patch === "object" &&
            !Array.isArray(item.patch) &&
            ((item?.action || "update") === "create"
              ? item.targetType === "character" && typeof item.patch?.name === "string"
              : typeof item?.targetId === "string")
        )
        .slice(0, 5)
        .map((item) => ({
          id: safeId("proposal"),
          action: item.action || "update",
          targetType: item.targetType,
          targetId:
            item.action === "create"
              ? item.targetId || slugify(item.patch?.name || "story-character")
              : item.targetId,
          reason: summarizeText(item.reason, PROPOSAL_REASON_CHAR_LIMIT),
          diff: item.patch,
          sourceRefs: messages.slice(-4).map((message) => message.id),
          status: "pending",
          createdAt: new Date().toISOString(),
        }));
    } catch {
      return [];
    }
  }

  function normalizeCreatedCharacter(targetId, patch) {
    const name = String(patch?.name || "").trim();
    if (!name) {
      throw new Error("Created character must have a name");
    }
    return {
      id: targetId || safeId("char"),
      name,
      core:
        patch?.core && typeof patch.core === "object" && !Array.isArray(patch.core)
          ? { ...patch.core, role: trimText(patch.core.role, CHARACTER_ROLE_CHAR_LIMIT) }
          : { role: "" },
      traits: trimStringArray(patch?.traits, CHARACTER_TRAIT_CHAR_LIMIT, 8),
      relationships: trimStringMapValues(patch?.relationships, CHARACTER_RELATIONSHIP_CHAR_LIMIT, 8),
      arcState:
        patch?.arcState && typeof patch.arcState === "object" && !Array.isArray(patch.arcState)
          ? { current: trimText(patch.arcState.current, CHARACTER_ARC_CHAR_LIMIT) }
          : { current: "" },
      notes: trimText(patch?.notes, CHARACTER_NOTES_CHAR_LIMIT),
      sourceId: null,
      sourceUpdatedAt: null,
      workspaceUpdatedAt: new Date().toISOString(),
      changeLog: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function validateProposalPayload(action, targetType, targetId, patch) {
    const allowedActions = new Set(["update", "create"]);
    if (!allowedActions.has(action || "update")) {
      throw new Error("Unsupported proposal action type");
    }
    const allowedTypes = new Set(["character", "worldbook", "style"]);
    if (!allowedTypes.has(targetType)) {
      throw new Error("Unsupported proposal target type");
    }
    if (!targetId || typeof targetId !== "string") {
      throw new Error("Proposal target id is required");
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("Proposal patch must be an object");
    }
    if ((action || "update") === "create" && targetType !== "character") {
      throw new Error("Only character creation proposals are supported");
    }
  }

  function updateWorkspaceItem(storyId, targetType, targetId, patch, reason) {
    validateProposalPayload("update", targetType, targetId, patch);
    const filePath = path.join(getStoryWorkspaceDir(storyId, `${targetType}s`), `${targetId}.json`);
    const current = readJson(filePath);
    if (!current) {
      throw new Error("Workspace item not found");
    }
    const updated = {
      ...current,
      ...patch,
      workspaceUpdatedAt: new Date().toISOString(),
      changeLog: [
        ...(current.changeLog || []),
        {
          at: new Date().toISOString(),
          reason,
          patch,
        },
      ],
    };
    writeJson(filePath, updated);
    return updated;
  }

  function createWorkspaceItem(storyId, targetType, targetId, patch, reason) {
    validateProposalPayload("create", targetType, targetId, patch);
    const story = getStory(storyId);
    if (!story) {
      throw new Error("Story not found");
    }
    if (targetType !== "character") {
      throw new Error("Only character creation proposals are supported");
    }
    const payload = normalizeCreatedCharacter(targetId, patch);
    const nextChange = {
      at: new Date().toISOString(),
      reason,
      patch,
      action: "create",
    };
    const filePath = path.join(getStoryWorkspaceDir(storyId, "characters"), `${payload.id}.json`);
    if (fs.existsSync(filePath)) {
      const current = readJson(filePath);
      const updated = {
        ...current,
        ...payload,
        workspaceUpdatedAt: new Date().toISOString(),
        changeLog: [...(current?.changeLog || []), nextChange],
      };
      writeJson(filePath, updated);
      const enabledCharacters = new Set(story.enabled?.characters || []);
      enabledCharacters.add(payload.id);
      saveStory({
        ...story,
        enabled: {
          ...story.enabled,
          characters: Array.from(enabledCharacters),
        },
        updatedAt: new Date().toISOString(),
      });
      return updated;
    }
    payload.changeLog.push(nextChange);
    writeJson(filePath, payload);
    const enabledCharacters = new Set(story.enabled?.characters || []);
    enabledCharacters.add(payload.id);
    saveStory({
      ...story,
      enabled: {
        ...story.enabled,
        characters: Array.from(enabledCharacters),
      },
      updatedAt: new Date().toISOString(),
    });
    return payload;
  }

  function buildProposalPipelineStatus({
    stage = "idle",
    triggerCount = 0,
    generatedCount = 0,
    triggers = [],
    error = "",
  } = {}) {
    return {
      stage,
      triggerCount,
      generatedCount,
      triggers,
      error,
      updatedAt: new Date().toISOString(),
    };
  }

  async function generateProposalUpdate({ story, fullMessages, workspace, assistantText }) {
    const proposalRecords = [];
    const proposalTriggers = await tryModelProposalTriggers(story, fullMessages, workspace, assistantText);
    let proposalPipeline = proposalTriggers.length
      ? buildProposalPipelineStatus({
          stage: "triggered",
          triggerCount: proposalTriggers.length,
          triggers: proposalTriggers,
        })
      : buildProposalPipelineStatus({
          stage: "not_triggered",
          triggerCount: 0,
          triggers: [],
        });

    if (proposalTriggers.length > 0) {
      proposalPipeline = buildProposalPipelineStatus({
        stage: "generating",
        triggerCount: proposalTriggers.length,
        triggers: proposalTriggers,
      });
      try {
        const proposals = await tryGenerateProposals(story, fullMessages, workspace);
        for (const proposal of proposals) {
          proposalRecords.push(proposal);
        }
        proposalPipeline = buildProposalPipelineStatus({
          stage: proposals.length > 0 ? "queued" : "empty",
          triggerCount: proposalTriggers.length,
          generatedCount: proposals.length,
          triggers: proposalTriggers,
        });
      } catch (error) {
        proposalPipeline = buildProposalPipelineStatus({
          stage: "failed",
          triggerCount: proposalTriggers.length,
          generatedCount: 0,
          triggers: proposalTriggers,
          error: error.message || "Proposal generation failed",
        });
      }
    }

    return {
      proposalRecords,
      proposalTriggers,
      proposalPipeline,
    };
  }

  function reviewProposal(storyId, proposalId, action, note = "") {
    const proposals = readJsonLines(getStoryProposalFile(storyId));
    const proposal = proposals.find((item) => item.id === proposalId);
    if (!proposal) {
      throw new Error("Proposal not found");
    }
    if (!["accept", "reject"].includes(action)) {
      throw new Error("Unsupported proposal action");
    }
    if (proposal.status && proposal.status !== "pending") {
      throw new Error("Proposal has already been reviewed");
    }
    if (action === "accept") {
      if ((proposal.action || "update") === "create") {
        createWorkspaceItem(storyId, proposal.targetType, proposal.targetId, proposal.diff, proposal.reason);
      } else {
        updateWorkspaceItem(storyId, proposal.targetType, proposal.targetId, proposal.diff, proposal.reason);
      }
    }
    proposal.status = action === "accept" ? "accepted" : "rejected";
    proposal.reviewedAt = new Date().toISOString();
    proposal.reviewNote = note || "";
    writeJsonLines(getStoryProposalFile(storyId), proposals);
    return proposal;
  }

  return {
    buildProposalPipelineStatus,
    generateProposalUpdate,
    reviewProposal,
  };
}

module.exports = {
  createProposalTools,
};
