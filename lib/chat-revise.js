const fs = require("fs");
const path = require("path");

function createChatReviseTools({
  getStory,
  saveStory,
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

  return {
    collectWorkspaceFileBackups,
    rollbackAcceptedProposalEffects,
    restoreReviseState,
  };
}

module.exports = {
  createChatReviseTools,
};
