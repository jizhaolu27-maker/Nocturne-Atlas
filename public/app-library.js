window.createLibraryTools = function createLibraryTools({
  state,
  els,
  escapeHtml,
  api,
  refreshAll,
  loadStory,
}) {
  function getSelectedLibraryItems() {
    return state.libraries[state.selectedLibraryType] || [];
  }

  function getNewLibraryTemplate(type) {
    if (type === "characters") {
      return {
        id: "",
        name: "",
        core: { role: "" },
        traits: [],
        relationships: {},
        arcState: { current: "" },
        notes: "",
      };
    }
    if (type === "worldbooks") {
      return {
        id: "",
        title: "",
        category: "setting",
        rules: [],
        content: "",
        revealedFacts: [],
        storyState: "",
      };
    }
    return { id: "", name: "", tone: "", voice: "", pacing: "", dos: [], donts: [] };
  }

  function renderLibraryEditor() {
    els.libraryTypeSelect.value = state.selectedLibraryType;
    const items = getSelectedLibraryItems();
    els.libraryItemSelect.innerHTML =
      items.map((item) => `<option value="${item.id}">${escapeHtml(item.name || item.title || item.id)}</option>`).join("") +
      `<option value="__new__">New entry</option>`;
    if (!state.selectedLibraryItemId && items[0]?.id) {
      state.selectedLibraryItemId = items[0].id;
    }
    if (!items.find((item) => item.id === state.selectedLibraryItemId)) {
      state.selectedLibraryItemId = "__new__";
    }
    els.libraryItemSelect.value = state.selectedLibraryItemId || "__new__";
    const current = items.find((item) => item.id === state.selectedLibraryItemId);
    els.libraryJsonEditor.value = current
      ? JSON.stringify(current, null, 2)
      : JSON.stringify(getNewLibraryTemplate(state.selectedLibraryType), null, 2);
    els.deleteLibraryBtn.disabled = !current;
    els.libraryJsonEditor.placeholder = items.length
      ? "Edit the current entry JSON, or switch to New entry."
      : "There are no entries for this type yet. Edit the template and save it as a new entry.";
  }

  async function saveLibraryItem() {
    let payload;
    try {
      payload = JSON.parse(els.libraryJsonEditor.value);
    } catch (error) {
      alert(`JSON parse failed: ${error.message}`);
      return;
    }
    const saved = await api(`/api/library/${state.selectedLibraryType}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.selectedLibraryItemId = saved.id;
    await refreshAll();
    if (state.activeStoryId) {
      await loadStory(state.activeStoryId);
    }
  }

  async function deleteLibraryItem() {
    const items = getSelectedLibraryItems();
    const current = items.find((item) => item.id === state.selectedLibraryItemId);
    if (!current) {
      alert("There is no library item to delete.");
      return;
    }
    const label = current.name || current.title || current.id;
    const confirmed = confirm(`Delete library item "${label}"? This will not remove copies that already exist in story workspaces.`);
    if (!confirmed) {
      return;
    }
    await api(`/api/library/${state.selectedLibraryType}/${current.id}`, { method: "DELETE" });
    state.selectedLibraryItemId = "__new__";
    await refreshAll();
    if (state.activeStoryId) {
      await loadStory(state.activeStoryId);
    } else {
      renderLibraryEditor();
    }
  }

  return {
    getSelectedLibraryItems,
    getNewLibraryTemplate,
    renderLibraryEditor,
    saveLibraryItem,
    deleteLibraryItem,
  };
};
