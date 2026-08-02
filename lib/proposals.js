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
  appendJsonLine,
  writeJsonLines,
  getStory,
  saveStory,
  getStoryProposalFile,
  getStoryMessagesFile,
  getStoryWorkspaceDir,
  syncStoryWorkspace,
  getStoryStateView,
  saveStoryState,
}) {
  function normalizeStorageId(value, label = "Proposal target id") {
    const normalized = String(value || "").trim();
    if (!normalized) {
      throw new Error(`${label} is required`);
    }
    if (normalized === "." || normalized === "..") {
      throw new Error(`${label} is invalid`);
    }
    if (/[\\/:*?"<>|\x00-\x1f]/.test(normalized)) {
      throw new Error(`${label} contains invalid filename characters`);
    }
    return normalized;
  }

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

  function getProposalDedupKey(item) {
    const action = item?.action || "update";
    const targetType = item?.targetType || "";
    if (action === "create" && targetType === "character") {
      const explicitId = String(item?.targetId || "").trim().toLowerCase();
      const name = String(item?.patch?.name || "").trim().toLowerCase();
      return `create:${targetType}:${explicitId || slugify(name || "story-character")}`;
    }
    if (targetType === "story_state") {
      const patch = item?.patch || item?.diff || {};
      const mapItem = patch.item || {};
      const identity = String(mapItem.id || mapItem.title || mapItem.label || mapItem.summary || "")
        .trim().toLowerCase().slice(0, 120);
      return `update:${targetType}:${patch.kind || "unknown"}:${identity}`;
    }
    return `update:${targetType}:${String(item?.targetId || "").trim().toLowerCase()}`;
  }

  function getHeuristicProposalTriggers(messages, assistantText = "") {
    const recentText = [...messages.slice(-4).map((item) => item.content), assistantText].join("\n").toLowerCase();
    const triggers = [];
    if (/(new recurring character|story-local character|\u65b0\u89d2\u8272|\u89d2\u8272\u5361|\u89d2\u8272\u8bbe\u5b9a)/i.test(recentText)) {
      triggers.push("New recurring character indicators detected");
    }
    if (/(relationship|alliance|betray|trust|mentor|lover|\u5173\u7cfb|\u4f34\u4fa3|\u604b\u4eba|\u4fe1\u4efb|\u80cc\u53db)/i.test(recentText)) {
      triggers.push("Relationship change indicators detected");
    }
    if (/(world state|rule changed|setting changed|\u4e16\u754c\u72b6\u6001|\u89c4\u5219\u53d8\u5316|\u8bbe\u5b9a\u53d8\u5316)/i.test(recentText)) {
      triggers.push("World-state change indicators detected");
    }
    return triggers;
  }

  async function tryModelProposalTriggers(story, messages, workspace, assistantText, signal) {
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
          "Decide whether the latest story turn should trigger a reviewed canon proposal. Return compact JSON with keys: shouldGenerateProposal (boolean), triggers (string array). Trigger for a meaningful new recurring character, durable character/relationship change, a canon timeline event, a current plot/outline state change, a durable world rule change, or an explicit remember/update-canon request. One-off flavor details do not trigger. Route plot progress, events, current goals, and relationship changes to story_state; route only durable world rules, organizations, locations, stable setting facts, or a changed present condition of a worldbook subject to worldbook. Do not route ordinary scene events or temporary status there.",
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
        reasoningEffort: story.settings?.reasoningEffort,
        responseFormat: { type: "json_object" },
        signal,
      });
      const parsed = tryParseJsonObject(result.content);
      if (!parsed?.shouldGenerateProposal) {
        return [];
      }
      return Array.isArray(parsed.triggers)
        ? parsed.triggers.slice(0, 4).map((item) => String(item))
        : ["AI proposal trigger approved"];
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      return getHeuristicProposalTriggers(messages, assistantText);
    }
  }

  async function tryGenerateProposals(story, messages, workspace, signal, storyState = null) {
    const provider = getProviderForStory(story);
    if (!provider || !provider.encryptedApiKey || !story.model) {
      return [];
    }
    const apiKey = decryptSecret(provider.encryptedApiKey);
    if (!apiKey) {
      return [];
    }
    const recentText = messages.slice(-6).map((item) => item.content || "").join("\n").toLowerCase();
    const relatedAssets = {
      characters: (workspace.characters || []).filter((item) => recentText.includes(String(item.name || item.id || "").toLowerCase())).slice(0, 4),
      worldbooks: (workspace.worldbooks || []).filter((item) => recentText.includes(String(item.title || item.id || "").toLowerCase())).slice(0, 4),
    };
    const prompt = [
      {
        role: "system",
        content:
          "Review recent fictional story messages. Return JSON: { proposals: [{ action, targetType, targetId, reason, patch }] }. targetType may be character, worldbook, style, or story_state. For story_state, patch must be { kind: outline|thread|timeline|relationship, item: {...} } and only represent a meaningful reviewed story change. Use timeline for events that happened, thread/outline for current direction and goals, relationship for durable relationship changes. Use worldbook only for durable world rules, organizations, locations, stable setting facts, or a changed present condition of an existing worldbook subject; do not put ordinary plot events, scene details, character arcs, future goals, or temporary state there. A worldbook storyState is only a concise present-condition summary. action must be update or create; story_state uses update. Only allow create for targetType=character when the story clearly introduces a meaningful new recurring character. Do not create one-off extras. Keep every field compact and retrieval-friendly, not literary. reason must be one short sentence, ideally 20-60 Chinese characters or under 18 English words. For create character patches, include name, core, traits, relationships, arcState, and notes, but keep them terse.",
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
            storyMap: storyState ? {
              currentOutline: storyState.currentOutline || null,
              activePlotThreads: storyState.activePlotThreads || [],
              recentTimelineEvents: (storyState.timelineEvents || []).filter((item) => item.status === "canon").slice(-12),
              currentRelationships: storyState.currentRelationships || [],
            } : null,
            relatedAssetDetails: relatedAssets,
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
        reasoningEffort: story.settings?.reasoningEffort,
        responseFormat: { type: "json_object" },
        signal,
      });
      const parsed = tryParseJsonObject(result.content);
      if (!Array.isArray(parsed?.proposals)) {
        return [];
      }
      const allowedTypes = new Set(["character", "worldbook", "style", "story_state"]);
      const seen = new Set();
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
              : typeof item?.targetId === "string" && (item.targetType !== "story_state" || item.patch?.item && typeof item.patch.item === "object"))
        )
        .filter((item) => {
          if (item.targetType !== "story_state" || item.patch?.kind !== "timeline") return true;
          const timelineItem = item.patch?.item || {};
          return Boolean(String(timelineItem.title || timelineItem.summary || "").trim());
        })
        .filter((item) => {
          const key = getProposalDedupKey(item);
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        })
        .slice(0, 5)
        .map((item) => {
          let resolvedTargetId = item.targetId;
          if (item.action !== "create") {
            const candidates = workspace[`${item.targetType}s`] || [];
            const exact = candidates.find((candidate) => candidate.id === item.targetId);
            if (!exact) {
              const expected = String(item.targetType === "character" ? item.patch?.name : item.patch?.title || "")
                .trim()
                .toLowerCase();
              const matched = expected
                ? candidates.find((candidate) => String(item.targetType === "character" ? candidate.name : candidate.title || "").trim().toLowerCase() === expected)
                : null;
              if (matched) {
                resolvedTargetId = matched.id;
              }
            }
          }
          return {
          id: safeId("proposal"),
          action: item.action || "update",
          targetType: item.targetType,
          targetId:
            item.action === "create"
              ? item.targetId || slugify(item.patch?.name || "story-character")
              : resolvedTargetId,
          reason: summarizeText(item.reason, PROPOSAL_REASON_CHAR_LIMIT),
          diff: item.patch,
          sourceRefs: messages.slice(-4).map((message) => message.id),
          status: "pending",
          createdAt: new Date().toISOString(),
          };
        });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function validateProposalPayload(action, targetType, targetId, patch) {
    const allowedActions = new Set(["update", "create"]);
    if (!allowedActions.has(action || "update")) {
      throw new Error("Unsupported proposal action type");
    }
    const allowedTypes = new Set(["character", "worldbook", "style", "story_state"]);
    if (!allowedTypes.has(targetType)) {
      throw new Error("Unsupported proposal target type");
    }
    normalizeStorageId(targetId);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("Proposal patch must be an object");
    }
    if ((action || "update") === "create" && targetType !== "character") {
      throw new Error("Only character creation proposals are supported");
    }
    if (targetType === "story_state" && (action || "update") !== "update") {
      throw new Error("Story State proposals must update reviewed state");
    }
  }

  function cloneStoryEnabled(enabled = {}) {
    return {
      characters: Array.isArray(enabled.characters) ? [...enabled.characters] : [],
      worldbooks: Array.isArray(enabled.worldbooks) ? [...enabled.worldbooks] : [],
      styles: Array.isArray(enabled.styles) ? [...enabled.styles] : [],
    };
  }

  function updateWorkspaceItem(storyId, targetType, targetId, patch, reason) {
    validateProposalPayload("update", targetType, targetId, patch);
    let safeTargetId = normalizeStorageId(targetId);
    let filePath = path.join(getStoryWorkspaceDir(storyId, `${targetType}s`), `${safeTargetId}.json`);
    let current = readJson(filePath);
    if (!current) {
      const directory = getStoryWorkspaceDir(storyId, `${targetType}s`);
      const candidates = fs
        .readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => ({ id: entry.name.slice(0, -5), item: readJson(path.join(directory, entry.name)) }));
      const expected = String(targetType === "character" ? patch?.name : patch?.title || "").trim().toLowerCase();
      if (expected) {
        const match = candidates.find(({ item }) => String(targetType === "character" ? item?.name : item?.title || "").trim().toLowerCase() === expected);
        if (match) {
          safeTargetId = match.id;
          filePath = path.join(directory, `${safeTargetId}.json`);
          current = match.item;
        }
      }
      if (!current && targetType === "character") {
        const relationshipKeys = Object.keys(patch?.relationships || {});
        const relationshipMatches = candidates.filter(({ item }) =>
          relationshipKeys.some((key) => Object.prototype.hasOwnProperty.call(item?.relationships || {}, key))
        );
        if (relationshipMatches.length === 1) {
          safeTargetId = relationshipMatches[0].id;
          filePath = path.join(directory, `${safeTargetId}.json`);
          current = relationshipMatches[0].item;
        }
      }
    }
    if (!current) {
      throw new Error("Workspace item not found");
    }
    const updated = {
      ...current,
      ...patch,
      workspaceUpdatedAt: new Date().toISOString(),
    };
    writeJson(filePath, updated);
    return {
      item: updated,
      undo: {
        targetType,
        targetId: safeTargetId,
        previousItem: current,
      },
    };
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
    const safeTargetId = normalizeStorageId(targetId);
    const payload = normalizeCreatedCharacter(safeTargetId, patch);
    const filePath = path.join(getStoryWorkspaceDir(storyId, "characters"), `${payload.id}.json`);
    const previousStoryEnabled = cloneStoryEnabled(story.enabled || {});
    if (fs.existsSync(filePath)) {
      throw new Error("Workspace character already exists");
    }
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
    return {
      item: payload,
      undo: {
        targetType,
        targetId: payload.id,
        previousItem: null,
        previousStoryEnabled,
      },
    };
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

  async function generateProposalUpdate({ story, fullMessages, workspace, assistantText, signal, onStage }) {
    const proposalRecords = [];
    const proposalTriggers = await tryModelProposalTriggers(story, fullMessages, workspace, assistantText, signal);
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
      onStage?.("proposal_generating");
      proposalPipeline = buildProposalPipelineStatus({
        stage: "generating",
        triggerCount: proposalTriggers.length,
        triggers: proposalTriggers,
      });
      try {
        let storyState = null;
        if (story?.id) {
          try {
            storyState = getStoryStateView(story.id);
          } catch {
            storyState = null;
          }
        }
        const proposals = await tryGenerateProposals(story, fullMessages, workspace, signal, storyState);
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

  async function generateManualProposals({ storyId, signal }) {
    syncStoryWorkspace?.(storyId);
    const story = getStory(storyId);
    if (!story) throw new Error("Story not found");
    const fullMessages = readJsonLines(getStoryMessagesFile(storyId));
    if (!fullMessages.length) return { proposals: [], generatedCount: 0 };
    const enabled = story.enabled || {};
    const loadItems = (type, ids) => (Array.isArray(ids) ? ids : []).map((id) =>
      readJson(path.join(getStoryWorkspaceDir(storyId, type), `${normalizeStorageId(id)}.json`), null)
    ).filter(Boolean);
    const workspace = {
      characters: loadItems("characters", enabled.characters),
      worldbooks: loadItems("worldbooks", enabled.worldbooks),
      styles: loadItems("styles", enabled.styles),
    };
    const generated = await tryGenerateProposals(story, fullMessages, workspace, signal, getStoryStateView(storyId));
    const existing = readJsonLines(getStoryProposalFile(storyId));
    const existingKeys = new Set(existing.filter((item) => !item.status || item.status === "pending").map(getProposalDedupKey));
    const proposals = generated.filter((item) => !existingKeys.has(getProposalDedupKey(item)));
    for (const proposal of proposals) appendJsonLine(getStoryProposalFile(storyId), proposal);
    return { proposals, generatedCount: proposals.length };
  }

  function reviewProposal(storyId, proposalId, action, note = "") {
    syncStoryWorkspace?.(storyId);
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
      let result;
      if (proposal.targetType === "story_state") {
        const current = getStoryStateView(storyId);
        const kind = proposal.diff?.kind;
        const collectionByKind = { outline: "outlineNodes", thread: "plotThreads", timeline: "timelineEvents", relationship: "relationshipEvents" };
        const collection = collectionByKind[kind];
        if (!collection || !proposal.diff?.item || typeof proposal.diff.item !== "object") throw new Error("Invalid story state proposal");
        if (kind === "timeline" && !String(proposal.diff.item.title || proposal.diff.item.summary || "").trim()) {
          throw new Error("Timeline proposal requires a title or summary");
        }
        const next = {
          outlineNodes: [...(current.outlineNodes || [])],
          plotThreads: [...(current.plotThreads || [])],
          timelineEvents: [...(current.timelineEvents || [])],
          relationshipEvents: [...(current.relationshipEvents || [])],
        };
        const item = proposal.diff.item;
        const index = next[collection].findIndex((entry) => entry.id && entry.id === item.id);
        if (index >= 0) next[collection][index] = { ...next[collection][index], ...item };
        else next[collection].push(item);
        result = { item: saveStoryState(storyId, next), undo: null };
      } else if ((proposal.action || "update") === "create") {
        result = createWorkspaceItem(storyId, proposal.targetType, proposal.targetId, proposal.diff, proposal.reason);
      } else {
        result = updateWorkspaceItem(storyId, proposal.targetType, proposal.targetId, proposal.diff, proposal.reason);
      }
      proposal.acceptanceUndo = result?.undo || null;
    }
    proposal.status = action === "accept" ? "accepted" : "rejected";
    proposal.reviewedAt = new Date().toISOString();
    proposal.reviewNote = note || "";
    writeJsonLines(getStoryProposalFile(storyId), proposals);
    return proposal;
  }

  return {
    buildProposalPipelineStatus,
    generateManualProposals,
    generateProposalUpdate,
    reviewProposal,
  };
}

module.exports = {
  createProposalTools,
};
