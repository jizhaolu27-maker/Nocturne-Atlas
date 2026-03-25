const fs = require("fs");
const path = require("path");

function createChatReviseTools({
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
}) {
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

  function prepareReviseLastExchange(storyId) {
    const story = getStory(storyId);
    if (!story) {
      throw new Error("Story not found");
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
    try {
      writeJsonLines(getStoryMessagesFile(storyId), messages.slice(0, -2));

      const latestSnapshot = snapshots[snapshots.length - 1] || null;
      const remainingSnapshots = latestSnapshot ? snapshots.slice(0, -1) : snapshots;
      if (latestSnapshot) {
        writeJsonLines(getStorySnapshotFile(storyId), remainingSnapshots);

        const summaryIds = new Set(latestSnapshot.generatedSummaryIds || []);
        if (summaryIds.size > 0) {
          const consolidatedSourceIds = new Set(latestSnapshot.consolidatedMemorySourceIds || []);
          const supersededLongTermIds = new Set(latestSnapshot.supersededLongTermIds || []);
          const memory = memoryBeforeRevise
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
          const memoryChunks = memoryChunksBeforeRevise.filter((item) => !chunkIds.has(item.id));
          writeJsonLines(getStoryMemoryChunkFile(storyId), memoryChunks);
        }

        const proposalIds = new Set(latestSnapshot.generatedProposalIds || []);
        if (proposalIds.size > 0) {
          const generatedProposals = proposalsBeforeRevise.filter((item) => proposalIds.has(item.id));
          const acceptedGeneratedProposals = generatedProposals.filter((item) => item.status === "accepted");
          if (acceptedGeneratedProposals.length) {
            workspaceBackups = collectWorkspaceFileBackups(storyId, acceptedGeneratedProposals);
            rollbackAcceptedProposalEffects(storyId, acceptedGeneratedProposals);
          }
          const proposals = proposalsBeforeRevise.filter((item) => !proposalIds.has(item.id));
          writeJsonLines(getStoryProposalFile(storyId), proposals);
        }
      }

      const previousSnapshot = remainingSnapshots[remainingSnapshots.length - 1] || null;
      saveStory({
        ...story,
        updatedAt: new Date().toISOString(),
        contextStatus: previousSnapshot?.contextStatus || getDefaultContextStatus(story),
      });

      return {
        story,
        messages,
        memory: memoryBeforeRevise,
        memoryChunks: memoryChunksBeforeRevise,
        proposals: proposalsBeforeRevise,
        snapshots,
        workspaceBackups,
        removedExchange: {
          user: lastUser,
          assistant: lastAssistant,
        },
      };
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

  return {
    collectWorkspaceFileBackups,
    prepareReviseLastExchange,
    rollbackAcceptedProposalEffects,
    restoreReviseState,
  };
}

module.exports = {
  createChatReviseTools,
};
