window.createShellTools = function createShellTools({
  state,
  els,
  api,
  sidebarCollapsedStorageKey,
  renderActiveRightPanel,
}) {
  function setMobileNavState(view = "chat") {
    if (window.innerWidth > 900) {
      return;
    }
    for (const button of document.querySelectorAll("[data-mobile-view]")) {
      const isActive = button.dataset.mobileView === view;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-current", isActive ? "page" : "false");
    }
  }

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
      els.themeToggleBtn.setAttribute("aria-label", els.themeToggleBtn.title);
      els.themeToggleBtn.classList.toggle("is-light", nextTheme === "light");
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
      if (!els.appShell.classList.contains("sidebar-open") && !els.appShell.classList.contains("right-open")) {
        setMobileNavState("chat");
      }
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
    const willOpen = !els.appShell.classList.contains("sidebar-open");
    closeRightPanelOverlay();
    setSidebarOpen(willOpen);
    setMobileNavState(willOpen ? "stories" : "chat");
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
      setMobileNavState("chat");
    }
  }

  function closeRightPanelOverlay() {
    if (els.appShell) {
      els.appShell.classList.remove("right-open");
    }
  }

  function openMobileView(view) {
    if (!els.appShell || window.innerWidth > 900) {
      return;
    }
    setSidebarOpen(false);
    closeRightPanelOverlay();
    if (view === "stories") {
      setSidebarOpen(true);
    } else if (view === "knowledge" || view === "story-map" || view === "controls") {
      activateRightTab(view);
      els.appShell.classList.add("right-open");
    }
    setMobileNavState(view);
  }

  function toggleRightPanel() {
    if (!els.appShell) {
      return;
    }
    if (window.innerWidth <= 900) {
      const isOpen = els.appShell.classList.contains("right-open");
      setSidebarOpen(false);
      els.appShell.classList.toggle("right-open", !isOpen);
      if (isOpen) {
        document.querySelector(".right-panel")?.classList.remove("story-map-expanded");
        els.appShell.classList.remove("story-map-focus");
      }
      setMobileNavState(
        isOpen
          ? "chat"
          : state.activeRightTab === "knowledge" || state.activeRightTab === "story-map"
            ? state.activeRightTab
            : "controls"
      );
      return;
    }
    const isCollapsed = els.appShell.classList.contains("right-collapsed");
    els.appShell.classList.toggle("right-collapsed", !isCollapsed);
    if (!isCollapsed) {
      document.querySelector(".right-panel")?.classList.remove("story-map-expanded");
      els.appShell.classList.remove("story-map-focus");
    }
  }

  function activateRightTab(tab) {
    state.activeRightTab = tab;
    document.querySelector(".right-panel")?.classList.toggle("story-map-expanded", tab === "story-map");
    document.querySelector(".app-shell")?.classList.toggle("story-map-focus", tab === "story-map");
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
      setMobileNavState("chat");
    });
    els.themeToggleBtn?.addEventListener("click", toggleTheme);

    const rightPanelBtn = document.getElementById("right-panel-btn");
    rightPanelBtn?.addEventListener("click", toggleRightPanel);

    for (const button of document.querySelectorAll(".tab-btn")) {
      button.setAttribute("aria-selected", button.classList.contains("active") ? "true" : "false");
      button.addEventListener("click", () => activateRightTab(button.dataset.tab));
    }

    for (const button of document.querySelectorAll("[data-mobile-view]")) {
      button.addEventListener("click", () => openMobileView(button.dataset.mobileView));
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
