const fs = require("fs");
const path = require("path");

function createWorkspaceTools({
  getLibraryTypeDir,
  getStoryWorkspaceDir,
  getStory,
  readJson,
  writeJson,
  listJsonFiles,
}) {
  function copyLibraryItemToWorkspace(type, id, storyId) {
    const sourcePath = path.join(getLibraryTypeDir(type), `${id}.json`);
    if (!fs.existsSync(sourcePath)) {
      return;
    }
    const targetPath = path.join(getStoryWorkspaceDir(storyId, type), `${id}.json`);
    if (!fs.existsSync(targetPath)) {
      const source = readJson(sourcePath, {});
      writeJson(targetPath, {
        ...source,
        sourceId: source.id,
        sourceUpdatedAt: source.updatedAt || source.createdAt || null,
        workspaceUpdatedAt: new Date().toISOString(),
        changeLog: [],
      });
    }
  }

  function syncStoryWorkspace(storyId) {
    const story = getStory(storyId);
    if (!story) {
      return;
    }
    for (const type of ["characters", "worldbooks", "styles"]) {
      for (const id of story.enabled[type] || []) {
        copyLibraryItemToWorkspace(type, id, storyId);
      }
    }
  }

  function loadWorkspaceItems(storyId, type) {
    return listJsonFiles(getStoryWorkspaceDir(storyId, type));
  }

  function loadActiveWorkspaceItems(storyId, type, enabledIds = []) {
    const allowed = new Set(enabledIds || []);
    if (allowed.size === 0) {
      return [];
    }
    return loadWorkspaceItems(storyId, type).filter((item) => allowed.has(item.id));
  }

  return {
    copyLibraryItemToWorkspace,
    syncStoryWorkspace,
    loadWorkspaceItems,
    loadActiveWorkspaceItems,
  };
}

module.exports = {
  createWorkspaceTools,
};
