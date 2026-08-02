window.createStoryMapTools = function createStoryMapTools({ state, els, escapeHtml, api }) {
  let activeView = "overview";
  let editor = null;
  let graphScale = 1;
  let graphOffset = { x: 0, y: 0 };

  const collectionByKind = {
    outline: "outlineNodes",
    thread: "plotThreads",
    timeline: "timelineEvents",
    relationship: "relationshipEvents",
  };

  function storyState() {
    return state.activeStoryData?.storyState || {
      outlineNodes: [],
      plotThreads: [],
      timelineEvents: [],
      relationshipEvents: [],
      currentRelationships: [],
      activePlotThreads: [],
      counts: {},
    };
  }

  function workspaceCharacters() {
    return state.activeStoryData?.workspace?.characters || [];
  }

  function characterName(id) {
    const character = workspaceCharacters().find((item) => item.id === id);
    return character?.name || id || "Unknown character";
  }

  function statusBadge(status) {
    const value = String(status || "planned");
    return `<span class="story-map-badge story-map-status-${escapeHtml(value)}">${escapeHtml(value)}</span>`;
  }

  function emptyState(message) {
    return `<div class="story-map-empty">${escapeHtml(message)}</div>`;
  }

  function renderMetrics(current) {
    const counts = current.counts || {};
    return `
      <div class="story-map-metrics">
        <div><strong>${counts.activeOutline || 0}</strong><span>active nodes</span></div>
        <div><strong>${counts.openPlotThreads || 0}</strong><span>open threads</span></div>
        <div><strong>${counts.canonTimelineEvents || 0}</strong><span>canon events</span></div>
        <div><strong>${counts.relationships || 0}</strong><span>relations</span></div>
      </div>
    `;
  }

  function renderOverview(current) {
    const activeNode = current.currentOutline;
    const activeThreads = current.activePlotThreads || [];
    const recentEvents = (current.timelineEvents || [])
      .filter((item) => item.status === "canon")
      .slice()
      .sort((left, right) => right.sortKey - left.sortKey)
      .slice(0, 4);
    return `
      ${renderMetrics(current)}
      <section class="story-map-current">
        <span>Current direction</span>
        ${activeNode
          ? `<strong>${escapeHtml(activeNode.title)}</strong><p>${escapeHtml(activeNode.summary || "No node summary yet.")}</p>${statusBadge(activeNode.status)}`
          : `<strong>Direction not set</strong><p>Add an outline node and mark it active.</p>`}
      </section>
      <div class="story-map-subhead"><strong>Active plot threads</strong><button class="story-map-text-btn" data-map-add="thread" type="button">Add thread</button></div>
      <div class="story-map-list">${activeThreads.length
        ? activeThreads.map((item) => renderThreadItem(item)).join("")
        : emptyState("No active plot threads.")}</div>
      <div class="story-map-subhead"><strong>Recent canon events</strong><button class="story-map-text-btn" data-map-add="timeline" type="button">Add event</button></div>
      <div class="story-map-list">${recentEvents.length
        ? recentEvents.map((item) => renderTimelineItem(item)).join("")
        : emptyState("No canon timeline events.")}</div>
    `;
  }

  function outlineDepth(node, nodeById) {
    let depth = 0;
    let cursor = node;
    const seen = new Set([node.id]);
    while (cursor?.parentId && nodeById.has(cursor.parentId) && depth < 4) {
      if (seen.has(cursor.parentId)) break;
      seen.add(cursor.parentId);
      cursor = nodeById.get(cursor.parentId);
      depth += 1;
    }
    return depth;
  }

  function renderOutlineItem(item, nodeById) {
    const depth = outlineDepth(item, nodeById);
    return `
      <button class="story-map-item story-map-outline-item" style="--outline-depth:${depth}" data-map-edit="outline" data-map-id="${escapeHtml(item.id)}" type="button">
        <span class="story-map-item-marker"></span>
        <span class="story-map-item-body"><small>${escapeHtml(item.type)}${item.storyTime ? ` · ${escapeHtml(item.storyTime)}` : ""}</small><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.summary || "No summary")}</span></span>
        ${statusBadge(item.status)}
      </button>
    `;
  }

  function renderOutline(current) {
    const nodes = (current.outlineNodes || []).slice().sort((left, right) => left.order - right.order);
    const nodeById = new Map(nodes.map((item) => [item.id, item]));
    return `
      <div class="story-map-subhead"><strong>Outline progression</strong><button class="story-map-text-btn" data-map-add="outline" type="button">Add node</button></div>
      <div class="story-map-outline">${nodes.length ? nodes.map((item) => renderOutlineItem(item, nodeById)).join("") : emptyState("No outline nodes yet.")}</div>
      <div class="story-map-subhead"><strong>All plot threads</strong><button class="story-map-text-btn" data-map-add="thread" type="button">Add thread</button></div>
      <div class="story-map-list">${(current.plotThreads || []).length ? current.plotThreads.map(renderThreadItem).join("") : emptyState("No plot threads yet.")}</div>
    `;
  }

  function renderThreadItem(item) {
    return `
      <button class="story-map-item" data-map-edit="thread" data-map-id="${escapeHtml(item.id)}" type="button">
        <span class="story-map-item-body"><small>${escapeHtml(item.kind)}</small><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.currentGoal || item.summary || "No current goal")}</span>${item.nextStep ? `<em>Next: ${escapeHtml(item.nextStep)}</em>` : ""}</span>
        ${statusBadge(item.status)}
      </button>
    `;
  }

  function renderTimelineItem(item) {
    return `
      <button class="story-map-item story-map-event-item" data-map-edit="timeline" data-map-id="${escapeHtml(item.id)}" type="button">
        <span class="story-map-time">${escapeHtml(item.storyTime || `#${item.sortKey}`)}</span>
        <span class="story-map-item-body"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.summary || "No summary")}</span></span>
        ${statusBadge(item.status)}
      </button>
    `;
  }

  function renderTimeline(current) {
    const events = (current.timelineEvents || []).slice().sort((left, right) => left.sortKey - right.sortKey);
    return `
      <div class="story-map-subhead"><strong>Story chronology</strong><button class="story-map-text-btn" data-map-add="timeline" type="button">Add event</button></div>
      <div class="story-map-timeline">${events.length ? events.map(renderTimelineItem).join("") : emptyState("No timeline events yet.")}</div>
    `;
  }

  function graphLayout(relationships) {
    const ids = Array.from(new Set(relationships.flatMap((item) => [item.sourceId, item.targetId])));
    const width = 640;
    const height = Math.max(320, Math.min(520, ids.length * 52));
    const radius = Math.min(width, height) * 0.34;
    const nodes = new Map(ids.map((id, index) => {
      const angle = ids.length === 1 ? 0 : (Math.PI * 2 * index) / ids.length - Math.PI / 2;
      return [id, { id, x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius }];
    }));
    return { width, height, nodes };
  }

  function renderRelationshipGraph(relationships) {
    if (!relationships.length) return emptyState("No canon relationship events yet.");
    const layout = graphLayout(relationships);
    const edges = relationships.map((item) => {
      const source = layout.nodes.get(item.sourceId);
      const target = layout.nodes.get(item.targetId);
      const midX = (source.x + target.x) / 2;
      const midY = (source.y + target.y) / 2;
      const strokeWidth = 1.5 + Math.abs(Number(item.strength || 0)) * 3;
      return `
        <g class="relationship-edge" data-map-edit="relationship" data-map-id="${escapeHtml(item.id)}">
          <line x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" style="stroke-width:${strokeWidth}" ${item.direction === "directed" ? 'marker-end="url(#story-map-arrow)"' : ""}></line>
          <text x="${midX}" y="${midY - 7}">${escapeHtml(item.label || item.type)}</text>
        </g>`;
    }).join("");
    const nodes = Array.from(layout.nodes.values()).map((node) => `
      <g class="relationship-node" transform="translate(${node.x} ${node.y})">
        <circle r="25"></circle>
        <text y="4">${escapeHtml(characterName(node.id).slice(0, 8))}</text>
      </g>`).join("");
    return `
      <div class="relationship-canvas">
        <div class="relationship-controls"><button type="button" data-graph-zoom="out" aria-label="Zoom out">−</button><button type="button" data-graph-zoom="reset" aria-label="Reset graph view">Reset</button><button type="button" data-graph-zoom="in" aria-label="Zoom in">+</button></div>
        <svg viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="Current canon character relationships" data-relationship-graph>
          <defs><marker id="story-map-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z"></path></marker></defs>
          <g data-relationship-stage transform="translate(${graphOffset.x} ${graphOffset.y}) scale(${graphScale})">${edges}${nodes}</g>
        </svg>
      </div>`;
  }

  function renderRelationships(current) {
    const relationships = current.currentRelationships || [];
    const history = (current.relationshipEvents || []).slice().sort((left, right) => right.sortKey - left.sortKey);
    return `
      <div class="story-map-subhead"><strong>Current canon graph</strong><button class="story-map-text-btn" data-map-add="relationship" type="button">Add relation</button></div>
      ${renderRelationshipGraph(relationships)}
      <div class="story-map-list relationship-list">${relationships.map((item) => `
        <button class="story-map-item" data-map-edit="relationship" data-map-id="${escapeHtml(item.id)}" type="button">
          <span class="story-map-item-body"><small>${escapeHtml(item.type)} · ${escapeHtml(item.direction)}</small><strong>${escapeHtml(characterName(item.sourceId))} → ${escapeHtml(characterName(item.targetId))}</strong><span>${escapeHtml(item.label || item.note || "No relationship note")}</span></span>
          ${statusBadge(item.status)}
        </button>`).join("")}</div>
      <div class="story-map-subhead"><strong>Relationship history</strong><span>${history.length} events</span></div>
      <div class="story-map-list relationship-history">${history.length ? history.map((item) => `
        <button class="story-map-item" data-map-edit="relationship" data-map-id="${escapeHtml(item.id)}" type="button">
          <span class="story-map-time">${escapeHtml(item.storyTime || `#${item.sortKey}`)}</span>
          <span class="story-map-item-body"><small>${escapeHtml(item.type)} · ${escapeHtml(item.direction)}</small><strong>${escapeHtml(characterName(item.sourceId))} → ${escapeHtml(characterName(item.targetId))}</strong><span>${escapeHtml(item.label || item.note || "No relationship note")}</span>${item.sourceMessageRange?.length ? `<em>Source turns ${escapeHtml(item.sourceMessageRange.join("–"))}</em>` : ""}</span>
          ${statusBadge(item.status)}
        </button>`).join("") : emptyState("No relationship history yet.")}</div>
    `;
  }

  function renderStoryMap(requestedView) {
    if (!els.storyMapContent) return;
    if (["overview", "outline", "timeline", "relationships"].includes(requestedView)) {
      activeView = requestedView;
    }
    const current = storyState();
    const renderers = { overview: renderOverview, outline: renderOutline, timeline: renderTimeline, relationships: renderRelationships };
    els.storyMapContent.innerHTML = renderers[activeView](current);
    bindGraphInteractions();
    for (const button of document.querySelectorAll("[data-story-map-view]")) {
      button.classList.toggle("active", button.dataset.storyMapView === activeView);
    }
  }

  function bindGraphInteractions() {
    if (typeof els.storyMapContent.querySelector !== "function") return;
    const svg = els.storyMapContent.querySelector("[data-relationship-graph]");
    const stage = els.storyMapContent.querySelector("[data-relationship-stage]");
    if (!svg || !stage) return;
    const apply = () => { stage.setAttribute("transform", `translate(${graphOffset.x} ${graphOffset.y}) scale(${graphScale})`); };
    for (const button of els.storyMapContent.querySelectorAll("[data-graph-zoom]")) {
      button.addEventListener("click", () => {
        const action = button.dataset.graphZoom;
        if (action === "reset") { graphScale = 1; graphOffset = { x: 0, y: 0 }; }
        else graphScale = Math.max(0.55, Math.min(2.5, graphScale + (action === "in" ? 0.2 : -0.2)));
        apply();
      });
    }
    let dragging = false;
    let last = null;
    svg.addEventListener("pointerdown", (event) => { if (event.target.closest(".relationship-edge")) return; dragging = true; last = { x: event.clientX, y: event.clientY }; svg.setPointerCapture(event.pointerId); });
    svg.addEventListener("pointermove", (event) => { if (!dragging || !last) return; const rect = svg.getBoundingClientRect(); graphOffset.x += (event.clientX - last.x) * layoutScale(rect.width, 640); graphOffset.y += (event.clientY - last.y) * layoutScale(rect.height, 320); last = { x: event.clientX, y: event.clientY }; apply(); });
    svg.addEventListener("pointerup", () => { dragging = false; last = null; });
    svg.addEventListener("pointercancel", () => { dragging = false; last = null; });
    svg.addEventListener("wheel", (event) => { event.preventDefault(); graphScale = Math.max(0.55, Math.min(2.5, graphScale + (event.deltaY < 0 ? 0.1 : -0.1))); apply(); }, { passive: false });
  }

  function layoutScale(viewport, canvas) {
    return canvas / Math.max(1, viewport);
  }

  function optionRows(items, selected, labelKey = "title") {
    return [`<option value=""></option>`, ...items.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selected ? "selected" : ""}>${escapeHtml(item[labelKey] || item.id)}</option>`)].join("");
  }

  function input(name, label, value = "", options = {}) {
    const field = options.type === "textarea"
      ? `<textarea name="${name}" rows="${options.rows || 3}">${escapeHtml(value)}</textarea>`
      : options.options
        ? `<select name="${name}">${options.options.map(([key, text]) => `<option value="${key}" ${key === value ? "selected" : ""}>${text}</option>`).join("")}</select>`
        : `<input name="${name}" value="${escapeHtml(value)}" type="${options.type || "text"}" ${options.step ? `step="${options.step}"` : ""}>`;
    return `<label class="${options.wide ? "wide" : ""}"><span>${label}</span>${field}</label>`;
  }

  function editorFields(kind, item = {}) {
    const current = storyState();
    if (kind === "outline") return [
      input("title", "Title", item.title, { wide: true }),
      input("type", "Type", item.type || "chapter", { options: ["volume", "arc", "chapter", "scene", "beat"].map((value) => [value, value]) }),
      input("status", "Status", item.status || "planned", { options: ["planned", "active", "completed", "paused", "abandoned"].map((value) => [value, value]) }),
      input("order", "Order", item.order ?? current.outlineNodes.length, { type: "number" }),
      `<label><span>Parent</span><select name="parentId">${optionRows((current.outlineNodes || []).filter((node) => node.id !== item.id), item.parentId)}</select></label>`,
      input("storyTime", "Story time", item.storyTime),
      input("locationId", "Location ID", item.locationId),
      input("characterIds", "Character IDs", (item.characterIds || []).join(", "), { wide: true }),
      input("plotThreadIds", "Plot thread IDs", (item.plotThreadIds || []).join(", "), { wide: true }),
      input("summary", "Summary", item.summary, { type: "textarea", wide: true }),
    ];
    if (kind === "thread") return [
      input("title", "Title", item.title, { wide: true }),
      input("kind", "Kind", item.kind || "subplot", { options: ["main", "subplot", "character", "mystery", "romance", "world"].map((value) => [value, value]) }),
      input("status", "Status", item.status || "planned", { options: ["planned", "active", "blocked", "resolved", "abandoned"].map((value) => [value, value]) }),
      input("currentGoal", "Current goal", item.currentGoal, { wide: true }),
      input("nextStep", "Next step", item.nextStep, { wide: true }),
      input("stakes", "Stakes", item.stakes, { wide: true }),
      input("characterIds", "Character IDs", (item.characterIds || []).join(", "), { wide: true }),
      input("outlineNodeIds", "Outline node IDs", (item.outlineNodeIds || []).join(", "), { wide: true }),
      input("summary", "Summary", item.summary, { type: "textarea", wide: true }),
    ];
    if (kind === "timeline") return [
      input("title", "Title", item.title, { wide: true }),
      input("status", "Status", item.status || "planned", { options: ["planned", "canon", "superseded", "discarded"].map((value) => [value, value]) }),
      input("storyTime", "Story time", item.storyTime),
      input("sortKey", "Sort order", item.sortKey ?? current.timelineEvents.length, { type: "number" }),
      `<label><span>Outline node</span><select name="outlineNodeId">${optionRows(current.outlineNodes || [], item.outlineNodeId)}</select></label>`,
      input("locationId", "Location ID", item.locationId),
      input("characterIds", "Character IDs", (item.characterIds || []).join(", "), { wide: true }),
      input("summary", "Summary", item.summary, { type: "textarea", wide: true }),
    ];
    return [
      `<label><span>From character</span><select name="sourceId">${optionRows(workspaceCharacters(), item.sourceId, "name")}</select></label>`,
      `<label><span>To character</span><select name="targetId">${optionRows(workspaceCharacters(), item.targetId, "name")}</select></label>`,
      input("type", "Relation type", item.type || "ally"),
      input("direction", "Direction", item.direction || "mutual", { options: [["mutual", "mutual"], ["directed", "directed"]] }),
      input("status", "Status", item.status || "canon", { options: ["planned", "canon", "superseded", "discarded"].map((value) => [value, value]) }),
      input("strength", "Strength (-1 to 1)", item.strength ?? 0.5, { type: "number", step: "0.1" }),
      input("storyTime", "Story time", item.storyTime),
      input("sortKey", "Sort order", item.sortKey ?? current.relationshipEvents.length, { type: "number" }),
      `<label><span>Outline node</span><select name="outlineNodeId">${optionRows(current.outlineNodes || [], item.outlineNodeId)}</select></label>`,
      `<label><span>Timeline event</span><select name="timelineEventId">${optionRows(current.timelineEvents || [], item.timelineEventId)}</select></label>`,
      input("label", "Graph label", item.label, { wide: true }),
      input("note", "Note", item.note, { type: "textarea", wide: true }),
    ];
  }

  function openEditor(kind, id = "") {
    const collection = storyState()[collectionByKind[kind]] || [];
    const item = collection.find((entry) => entry.id === id) || {};
    editor = { kind, id, item };
    els.storyMapEditorTitle.textContent = `${id ? "Edit" : "Add"} ${kind}`;
    els.storyMapEditorForm.innerHTML = editorFields(kind, item).join("");
    els.storyMapEditorError.textContent = "";
    els.storyMapEditorDelete.hidden = !id;
    els.storyMapEditorModal.hidden = false;
    els.storyMapEditorForm.querySelector("input, select, textarea")?.focus();
  }

  function closeEditor() {
    editor = null;
    els.storyMapEditorModal.hidden = true;
    els.storyMapEditorError.textContent = "";
  }

  function splitIds(value) {
    return String(value || "").split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  }

  function formItem() {
    const form = new FormData(els.storyMapEditorForm);
    const item = { ...editor.item };
    for (const [key, value] of form.entries()) item[key] = String(value).trim();
    for (const key of ["order", "sortKey", "strength"]) {
      if (key in item) item[key] = Number(item[key]);
    }
    for (const key of ["characterIds", "plotThreadIds", "outlineNodeIds"]) {
      if (typeof item[key] === "string") item[key] = splitIds(item[key]);
    }
    item.updatedAt = new Date().toISOString();
    return item;
  }

  async function saveState(nextState) {
    els.storyMapStatus.textContent = "Saving story map…";
    const saved = await api(`/api/stories/${state.activeStoryId}/story-state`, {
      method: "PUT",
      body: JSON.stringify(nextState),
    });
    state.activeStoryData.storyState = saved;
    els.storyMapStatus.textContent = "Story map saved.";
    renderStoryMap();
  }

  async function submitEditor(event) {
    event.preventDefault();
    if (!editor) return;
    const current = storyState();
    const collectionName = collectionByKind[editor.kind];
    const next = {
      outlineNodes: [...(current.outlineNodes || [])],
      plotThreads: [...(current.plotThreads || [])],
      timelineEvents: [...(current.timelineEvents || [])],
      relationshipEvents: [...(current.relationshipEvents || [])],
    };
    const item = formItem();
    const index = next[collectionName].findIndex((entry) => entry.id === editor.id);
    if (index >= 0) next[collectionName][index] = item;
    else next[collectionName].push(item);
    try {
      await saveState(next);
      closeEditor();
    } catch (error) {
      els.storyMapEditorError.textContent = error.message || "Unable to save story map.";
    }
  }

  async function deleteEditorItem() {
    if (!editor?.id || !confirm(`Delete this ${editor.kind}?`)) return;
    const current = storyState();
    const collectionName = collectionByKind[editor.kind];
    const next = {
      outlineNodes: [...(current.outlineNodes || [])],
      plotThreads: [...(current.plotThreads || [])],
      timelineEvents: [...(current.timelineEvents || [])],
      relationshipEvents: [...(current.relationshipEvents || [])],
    };
    next[collectionName] = next[collectionName].filter((entry) => entry.id !== editor.id);
    if (editor.kind === "outline") {
      next.outlineNodes = next.outlineNodes.map((item) => ({
        ...item,
        parentId: item.parentId === editor.id ? "" : item.parentId,
      }));
      next.plotThreads = next.plotThreads.map((item) => ({
        ...item,
        outlineNodeIds: (item.outlineNodeIds || []).filter((id) => id !== editor.id),
      }));
      next.timelineEvents = next.timelineEvents.map((item) => ({
        ...item,
        outlineNodeId: item.outlineNodeId === editor.id ? "" : item.outlineNodeId,
      }));
      next.relationshipEvents = next.relationshipEvents.map((item) => ({
        ...item,
        outlineNodeId: item.outlineNodeId === editor.id ? "" : item.outlineNodeId,
      }));
    }
    if (editor.kind === "thread") {
      next.outlineNodes = next.outlineNodes.map((item) => ({
        ...item,
        plotThreadIds: (item.plotThreadIds || []).filter((id) => id !== editor.id),
      }));
      next.timelineEvents = next.timelineEvents.map((item) => ({
        ...item,
        plotThreadIds: (item.plotThreadIds || []).filter((id) => id !== editor.id),
      }));
    }
    if (editor.kind === "timeline") {
      next.relationshipEvents = next.relationshipEvents.map((item) => ({
        ...item,
        timelineEventId: item.timelineEventId === editor.id ? "" : item.timelineEventId,
      }));
    }
    try {
      await saveState(next);
      closeEditor();
    } catch (error) {
      els.storyMapEditorError.textContent = error.message || "Unable to delete story map item.";
    }
  }

  function defaultAddKind() {
    if (activeView === "timeline") return "timeline";
    if (activeView === "relationships") return "relationship";
    return "outline";
  }

  function bindStoryMapEvents() {
    document.addEventListener("click", (event) => {
      const mode = event.target.closest("[data-story-map-view]");
      if (mode) { activeView = mode.dataset.storyMapView; renderStoryMap(); return; }
      const add = event.target.closest("[data-map-add]");
      if (add) { openEditor(add.dataset.mapAdd); return; }
      const edit = event.target.closest("[data-map-edit]");
      if (edit) openEditor(edit.dataset.mapEdit, edit.dataset.mapId);
    });
    els.storyMapAdd?.addEventListener("click", () => openEditor(defaultAddKind()));
    els.storyMapEditorForm?.addEventListener("submit", submitEditor);
    els.storyMapEditorClose?.addEventListener("click", closeEditor);
    els.storyMapEditorCancel?.addEventListener("click", closeEditor);
    els.storyMapEditorDelete?.addEventListener("click", deleteEditorItem);
    els.storyMapEditorModal?.addEventListener("click", (event) => { if (event.target === els.storyMapEditorModal) closeEditor(); });
  }

  return { bindStoryMapEvents, renderStoryMap };
};
