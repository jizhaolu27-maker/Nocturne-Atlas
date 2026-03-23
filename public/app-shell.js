window.createShellTools = function createShellTools({
  state,
  els,
  api,
  sidebarCollapsedStorageKey,
  renderActiveRightPanel,
}) {
  function showStorySaveStatus(message, tone = "") {
    if (state.storySaveStatusTimer) {
      clearTimeout(state.storySaveStatusTimer);
      state.storySaveStatusTimer = null;
    }
    els.storySaveStatus.className = `story-save-status ${tone}`.trim();
    els.storySaveStatus.textContent = message;
    if (!message) {
      return;
    }
    state.storySaveStatusTimer = setTimeout(() => {
      els.storySaveStatus.textContent = "";
      els.storySaveStatus.className = "story-save-status";
      state.storySaveStatusTimer = null;
    }, 2600);
  }

  function applyTheme(theme) {
    const nextTheme = theme === "light" ? "light" : "dark";
    state.appConfig = { ...(state.appConfig || {}), theme: nextTheme };
    document.body.dataset.theme = nextTheme;
    if (els.themeToggleBtn) {
      els.themeToggleBtn.title = nextTheme === "light" ? "Switch to dark theme" : "Switch to light theme";
    }
  }

  async function toggleTheme() {
    const currentTheme = state.appConfig?.theme || "dark";
    const nextTheme = currentTheme === "light" ? "dark" : "light";
    applyTheme(nextTheme);
    try {
      const saved = await api("/api/app-config", {
        method: "POST",
        body: JSON.stringify({ theme: nextTheme }),
      });
      state.appConfig = saved || { theme: nextTheme };
      applyTheme(state.appConfig.theme || nextTheme);
    } catch (error) {
      applyTheme(currentTheme);
      alert(`Failed to toggle theme: ${error.message}`);
    }
  }

  function getSidebarCollapsedPreference() {
    try {
      return localStorage.getItem(sidebarCollapsedStorageKey) === "true";
    } catch {
      return false;
    }
  }

  function persistSidebarCollapsed(isCollapsed) {
    try {
      localStorage.setItem(sidebarCollapsedStorageKey, String(Boolean(isCollapsed)));
    } catch {
      return;
    }
  }

  function setSidebarCollapsed(isCollapsed) {
    if (!els.appShell || window.innerWidth <= 900) {
      return;
    }
    els.appShell.classList.toggle("sidebar-collapsed", Boolean(isCollapsed));
    persistSidebarCollapsed(isCollapsed);
  }

  function initializeSidebarState() {
    if (!els.appShell) {
      return;
    }
    if (window.innerWidth > 900) {
      setSidebarCollapsed(getSidebarCollapsedPreference());
      setSidebarOpen(false);
    } else {
      els.appShell.classList.remove("sidebar-collapsed");
    }
  }

  function setSidebarOpen(isOpen) {
    if (!els.appShell || window.innerWidth > 900) {
      return;
    }
    els.appShell.classList.toggle("sidebar-open", Boolean(isOpen));
  }

  function toggleSidebar() {
    if (!els.appShell || window.innerWidth > 900) {
      return;
    }
    setSidebarOpen(!els.appShell.classList.contains("sidebar-open"));
  }

  function toggleDesktopSidebar() {
    if (!els.appShell || window.innerWidth <= 900) {
      return;
    }
    setSidebarCollapsed(!els.appShell.classList.contains("sidebar-collapsed"));
  }

  function closeSidebar() {
    if (window.innerWidth <= 900) {
      setSidebarOpen(false);
    }
  }

  function closeRightPanelOverlay() {
    if (els.appShell) {
      els.appShell.classList.remove("right-open");
    }
  }

  function toggleRightPanel() {
    if (!els.appShell) {
      return;
    }
    if (window.innerWidth <= 900) {
      const isOpen = els.appShell.classList.contains("right-open");
      els.appShell.classList.toggle("right-open", !isOpen);
      return;
    }
    const isCollapsed = els.appShell.classList.contains("right-collapsed");
    els.appShell.classList.toggle("right-collapsed", !isCollapsed);
  }

  function activateRightTab(tab) {
    state.activeRightTab = tab;
    for (const button of document.querySelectorAll(".tab-btn")) {
      button.classList.toggle("active", button.dataset.tab === tab);
      button.setAttribute("aria-selected", button.dataset.tab === tab ? "true" : "false");
    }
    for (const content of document.querySelectorAll(".tab-content")) {
      content.classList.toggle("active", content.id === `tab-${tab}`);
    }
    renderActiveRightPanel();
    document.querySelector(".right-panel-body")?.scrollTo({ top: 0, behavior: "smooth" });
  }

  function bindShellEvents() {
    els.desktopSidebarBtn?.addEventListener("click", toggleDesktopSidebar);
    els.mobileSidebarBtn?.addEventListener("click", toggleSidebar);
    els.topMobileSidebarBtn?.addEventListener("click", toggleSidebar);
    els.sidebarOverlay?.addEventListener("click", () => {
      closeSidebar();
      closeRightPanelOverlay();
    });
    els.themeToggleBtn?.addEventListener("click", toggleTheme);

    const rightPanelBtn = document.getElementById("right-panel-btn");
    rightPanelBtn?.addEventListener("click", toggleRightPanel);

    for (const button of document.querySelectorAll(".tab-btn")) {
      button.setAttribute("aria-selected", button.classList.contains("active") ? "true" : "false");
      button.addEventListener("click", () => activateRightTab(button.dataset.tab));
    }

    window.addEventListener("resize", () => {
      initializeSidebarState();
      if (window.innerWidth > 900) {
        closeSidebar();
        closeRightPanelOverlay();
      }
    });
  }

  return {
    applyTheme,
    bindShellEvents,
    closeSidebar,
    initializeSidebarState,
    showStorySaveStatus,
    toggleTheme,
  };
};
