const tauriInvoke = window.__TAURI__?.core?.invoke;
const isDesktop = typeof tauriInvoke === "function";

const state = {
  busy: false,
  agentMode: "ask",
  objects: [],
  plots: [],
  problems: [],
  revision: { state_revision: 1, project_revision: 0 },
  project: { root: "", files: [] },
  documents: {},
  activeDocument: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

async function invoke(command, args = {}) {
  if (isDesktop) return tauriInvoke(command, args);
  return mockInvoke(command, args);
}

async function mockInvoke(command, args) {
  await new Promise((resolve) => setTimeout(resolve, command === "run_agent" ? 800 : 300));
  if (command === "workspace_start") {
    return {
      status: "idle",
      r_version: "R version 4.6.0",
      kernel_pid: 14208,
      workspace: { execution_seq: 1, state_revision: 1, project_revision: 0 },
      python_required: false,
    };
  }
  if (command === "project_state") {
    return { root: "D:/Rho", files: [
      { path: "analysis.R", name: "analysis.R", kind: "source", size_bytes: 120 },
      { path: "scratch.R", name: "scratch.R", kind: "source", size_bytes: 420 },
    ] };
  }
  if (command === "project_read_file") {
    const fallback = args.path === "analysis.R"
      ? "# Project analysis\nsummary(qc)\n"
      : "# Live analysis in Workspace R\nset.seed(42)\nqc <- data.frame(sample = paste0(\"S\", 1:12), reads = round(rlnorm(12, 11.2, 0.35)), detected = round(rnorm(12, 3200, 420)))\nsummary(qc)\nplot(qc$reads, qc$detected)\n";
    return { path: args.path, content: state.documents[args.path]?.content || fallback };
  }
  if (command === "project_write_file" || command === "project_create_file") {
    state.documents[args.path] = { path: args.path, content: args.content || "", savedContent: args.content || "" };
    return mockInvoke("project_state", {});
  }
  if (command === "snapshot_workspace") {
    return {
      execution: {
        objects: state.objects,
        r: { version: "R version 4.6.0", cwd: "D:/Rho" },
      },
      workspace: state.revision,
    };
  }
  if (command === "execute_r") {
    state.revision.state_revision += 1;
    state.objects = [
      { name: "qc", classes: ["data.frame"], dimensions: [12, 3], size_bytes: 2184, typeof: "list" },
    ];
    return {
      execution_id: "exec_demo",
      execution: {
        ok: true,
        code: args.code,
        stdout: "",
        value: "     reads        detected   \n Min.   : 40122   Min.   :2511  \n Median : 72840   Median :3238  \n Mean   : 76114   Mean   :3216",
        warnings: [],
        messages: [],
        error: null,
      },
      events: [{ event: { type: "display_data", data: { "rho/mock-image": "assets/demo-plot.png" } } }],
      workspace: state.revision,
    };
  }
  if (command === "run_agent") {
    const act = args.mode === "act";
    return {
      workspace: state.revision,
      events: [
        { type: "agent.run_started", tool_names: act ? ["run_r", "inspect_r_object"] : ["get_workspace_snapshot", "inspect_r_object"] },
        { type: "tool.call_started", tool: act ? "run_r" : "inspect_r_object", arguments: act ? { code: "summary(qc)" } : { name: "qc" } },
        { type: "tool.call_completed", tool: act ? "run_r" : "inspect_r_object", success: true },
        { type: "chat.message_completed", event: { text: "`qc` 包含 12 个样本和 3 个变量。reads 与 detected 的分布整体稳定，目前没有明显离群样本。" } },
        { type: "desktop.agent_completed" },
      ],
    };
  }
  if (command === "restart_workspace") return mockInvoke("workspace_start", {});
  return { status: "ok" };
}

function setKernelStatus(status, label) {
  const dot = $("#kernelDot");
  dot.className = `kernel-dot ${status === "idle" ? "" : status}`.trim();
  $("#kernelStatus").textContent = label;
}

function setBusy(busy, label = "R is busy") {
  state.busy = busy;
  $("#runButton").disabled = busy;
  $("#editorRunButton").disabled = busy;
  setKernelStatus(busy ? "starting" : "idle", busy ? label : "R idle");
}

function updateIdentity(workspace) {
  if (!workspace) return;
  state.revision = { ...state.revision, ...workspace };
  $("#stateRevision").textContent = `state ${state.revision.state_revision ?? 0}`;
  $("#projectRevision").textContent = `project ${state.revision.project_revision ?? 0}`;
  $("#revisionBadge").textContent = `rev ${state.revision.state_revision ?? 0}`;
}

function documentIsDirty(document) {
  return document.content !== document.savedContent;
}

function activeDocument() {
  return state.documents[state.activeDocument] || null;
}

function renderProjectFiles() {
  const list = $("#projectFileList");
  list.replaceChildren();
  if (!state.project.files.length) {
    const empty = document.createElement("div");
    empty.className = "empty-tree";
    empty.textContent = "No supported source files";
    list.append(empty);
    return;
  }
  for (const file of state.project.files) {
    const button = document.createElement("button");
    button.className = `tree-item ${file.path === state.activeDocument ? "active" : ""}`;
    button.type = "button";
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = file.name.toLowerCase().endsWith(".r") ? "R" : "·";
    const label = document.createElement("span");
    label.textContent = file.name;
    const dirty = document.createElement("span");
    dirty.className = `dirty-dot ${documentIsDirty(state.documents[file.path] || { content: "", savedContent: "" }) ? "" : "hidden"}`;
    button.append(icon, label, dirty);
    button.addEventListener("click", () => openDocument(file.path));
    list.append(button);
  }
}

function renderDocumentTabs() {
  const tabs = $("#documentTabs");
  tabs.replaceChildren();
  for (const fileDocument of Object.values(state.documents)) {
    const button = document.createElement("button");
    button.className = `document-tab ${fileDocument.path === state.activeDocument ? "active" : ""}`;
    button.type = "button";
    const icon = document.createElement("span");
    icon.className = "r-badge";
    icon.textContent = fileDocument.path.toLowerCase().endsWith(".r") ? "R" : "·";
    const label = document.createElement("span");
    label.textContent = fileDocument.path;
    const dirty = document.createElement("span");
    dirty.className = `unsaved ${documentIsDirty(fileDocument) ? "" : "hidden"}`;
    dirty.textContent = "●";
    button.append(icon, label, dirty);
    button.addEventListener("click", () => openDocument(fileDocument.path));
    tabs.append(button);
  }
}

function renderActiveDocument() {
  const document = activeDocument();
  if (!document) return;
  $("#editor").value = document.content;
  $("#projectName").textContent = state.project.root.split(/[\\/]/).filter(Boolean).at(-1) || "Rho Project";
  renderProjectFiles();
  renderDocumentTabs();
  updateEditorChrome();
}

async function openDocument(path) {
  if (!state.documents[path]) {
    try {
      const result = await invoke("project_read_file", { path });
      state.documents[path] = { path, content: result.content || "", savedContent: result.content || "" };
    } catch (error) {
      toast(String(error), true);
      return;
    }
  }
  state.activeDocument = path;
  renderActiveDocument();
}

async function refreshProject() {
  try {
    state.project = await invoke("project_state");
    renderProjectFiles();
    const first = state.activeDocument && state.project.files.some((file) => file.path === state.activeDocument)
      ? state.activeDocument
      : state.project.files[0]?.path;
    if (first) await openDocument(first);
  } catch (error) {
    toast(String(error), true);
  }
}

async function saveActiveDocument() {
  const document = activeDocument();
  if (!document) return;
  document.content = $("#editor").value;
  try {
    state.project = await invoke("project_write_file", { path: document.path, content: document.content });
    document.savedContent = document.content;
    renderProjectFiles();
    renderDocumentTabs();
    addConsole("SYSTEM", `Saved ${document.path}`);
  } catch (error) {
    toast(String(error), true);
  }
}

async function createDocument() {
  const name = window.prompt("New R file name", "analysis.R");
  if (!name) return;
  const path = name.replace(/^[\\/]+/, "");
  try {
    state.project = await invoke("project_create_file", { path, content: "" });
    await openDocument(path);
  } catch (error) {
    toast(String(error), true);
  }
}

function addConsole(origin, text, kind = "") {
  if (text === null || text === undefined || text === "") return;
  const entry = document.createElement("div");
  entry.className = `console-entry ${origin.toLowerCase()} ${kind}`.trim();
  const badge = document.createElement("span");
  badge.className = "origin";
  badge.textContent = origin.toUpperCase();
  const content = document.createElement("span");
  content.textContent = String(text);
  entry.append(badge, content);
  $("#consoleOutput").append(entry);
  $("#consoleOutput").scrollTop = $("#consoleOutput").scrollHeight;
}

function addTimeline(title, body, status = "completed", code = null) {
  const row = document.createElement("div");
  row.className = `timeline-item ${status}`;
  const marker = document.createElement("span");
  marker.className = "timeline-marker";
  marker.textContent = status === "completed" ? "✓" : status === "error" ? "!" : "·";
  const content = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  content.append(heading);
  if (body) {
    const paragraph = document.createElement("p");
    paragraph.textContent = body;
    content.append(paragraph);
  }
  if (code) {
    const source = document.createElement("code");
    source.className = "timeline-code";
    source.textContent = code;
    content.append(source);
  }
  row.append(marker, content);
  $("#agentTimeline").append(row);
  $("#agentTimeline").scrollTop = $("#agentTimeline").scrollHeight;
}

function addProblem(message, call = "") {
  state.problems.push({ message, call });
  $("#problemEmpty").classList.add("hidden");
  const row = document.createElement("div");
  row.className = "problem-row";
  const icon = document.createElement("span");
  icon.className = "problem-icon";
  icon.textContent = "!";
  const content = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = message;
  content.append(title);
  if (call) {
    const detail = document.createElement("p");
    detail.textContent = call;
    content.append(detail);
  }
  const actions = document.createElement("div");
  actions.className = "problem-actions";
  const explain = document.createElement("button");
  explain.type = "button";
  explain.textContent = "Explain";
  explain.addEventListener("click", () => {
    switchContextTab("agent");
    $("#agentInput").value = `请解释这个 R 错误并给出修复建议：${message}`;
    $("#agentInput").focus();
  });
  actions.append(explain);
  row.append(icon, content, actions);
  $("#problemList").append(row);
  $("#problemCount").textContent = String(state.problems.length);
  $("#problemCount").classList.remove("quiet");
}

function renderExecution(response, origin = "USER") {
  const execution = response.execution || {};
  updateIdentity(response.workspace);
  addConsole(origin, execution.stdout);
  (execution.messages || []).forEach((message) => addConsole(origin, message));
  (execution.warnings || []).forEach((warning) => addConsole(origin, warning, "warning"));
  if (execution.value) addConsole(origin, execution.value);
  if (execution.error) {
    addConsole(origin, execution.error.message, "error");
    addProblem(execution.error.message, execution.error.call || "");
  }
  for (const wrapped of response.events || []) {
    const event = wrapped.event || wrapped;
    if (event.type === "stream") addConsole(origin, event.text, event.name === "stderr" ? "error" : "");
    if (event.type === "error") addProblem(event.traceback || "R execution failed");
    if (event.type === "display_data") renderDisplay(event.data || {});
  }
}

function renderDisplay(data) {
  let source = null;
  if (data["image/png"]) source = `data:image/png;base64,${data["image/png"]}`;
  if (data["image/svg+xml"]) source = `data:image/svg+xml;base64,${data["image/svg+xml"]}`;
  if (data["rho/mock-image"]) source = data["rho/mock-image"];
  if (!source) return;
  state.plots.push(source);
  $("#plotImage").src = source;
  $("#plotImage").classList.remove("hidden");
  $("#plotEmpty").classList.add("hidden");
  $("#plotCount").textContent = String(state.plots.length);
}

async function executeCode(code, origin = "USER") {
  if (state.busy || !code.trim()) return;
  setBusy(true);
  addConsole(origin, `> ${code}`);
  try {
    const response = await invoke("execute_r", { code });
    renderExecution(response, origin);
    await refreshEnvironment();
  } catch (error) {
    const message = String(error);
    addConsole("SYSTEM", message, "error");
    addProblem(message);
    toast(message, true);
  } finally {
    setBusy(false);
  }
}

function selectedEditorCode() {
  const editor = $("#editor");
  return editor.selectionStart !== editor.selectionEnd
    ? editor.value.slice(editor.selectionStart, editor.selectionEnd)
    : editor.value;
}

async function refreshEnvironment() {
  try {
    const response = await invoke("snapshot_workspace");
    updateIdentity(response.workspace);
    state.objects = response.execution?.objects || [];
    renderEnvironment();
  } catch (error) {
    toast(String(error), true);
  }
}

function renderEnvironment() {
  const query = $("#environmentSearch").value.trim().toLowerCase();
  const objects = state.objects.filter((object) => object.name.toLowerCase().includes(query));
  $("#environmentList").replaceChildren();
  if (!objects.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state compact-empty";
    const label = document.createElement("strong");
    label.textContent = query ? "No matching objects" : "Workspace is empty";
    empty.append(label);
    $("#environmentList").append(empty);
  }
  for (const object of objects) {
    const row = document.createElement("div");
    row.className = "environment-row";
    const name = document.createElement("div");
    name.className = "object-name";
    const symbol = document.createElement("span");
    symbol.className = "object-symbol";
    symbol.textContent = (object.classes?.[0] || object.typeof || "R").slice(0, 1).toUpperCase();
    const label = document.createElement("span");
    label.textContent = object.name;
    name.append(symbol, label);
    const type = document.createElement("span");
    type.className = "object-type";
    type.textContent = object.dimensions?.length ? object.dimensions.join(" × ") : object.classes?.[0] || object.typeof;
    const size = document.createElement("span");
    size.className = "object-size";
    size.textContent = formatBytes(object.size_bytes || 0);
    row.append(name, type, size);
    $("#environmentList").append(row);
  }
  $("#objectCount").textContent = String(state.objects.length);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function sendAgentPrompt() {
  const prompt = $("#agentInput").value.trim();
  if (!prompt || state.busy) return;
  $("#agentInput").value = "";
  setBusy(true, "Agent is working");
  $("#agentSendButton").disabled = true;
  $("#agentState").textContent = "Working";
  $("#agentStateDot").className = "agent-state-dot busy";
  addTimeline("You", prompt, "completed");
  try {
    const response = await invoke("run_agent", {
      prompt,
      mode: state.agentMode,
      model: "deepseek:deepseek-v4-flash",
    });
    updateIdentity(response.workspace);
    renderAgentEvents(response.events || []);
    await refreshEnvironment();
    $("#agentState").textContent = "Ready";
    $("#agentStateDot").className = "agent-state-dot";
  } catch (error) {
    const message = String(error);
    addTimeline("Agent failed", message, "error");
    $("#agentState").textContent = "Failed";
    $("#agentStateDot").className = "agent-state-dot error";
    toast(message, true);
  } finally {
    $("#agentSendButton").disabled = false;
    setBusy(false);
  }
}

function renderAgentEvents(events) {
  for (const event of events) {
    const type = event.type || "";
    if (type === "tool.approval_required") {
      addTimeline(`Approval · ${event.tool}`, "Execution requested", "running", event.arguments?.code);
    } else if (type === "tool.call_started") {
      addTimeline(`Tool · ${event.tool}`, "Running against Workspace R", "running", event.arguments?.code || null);
    } else if (type === "tool.call_completed") {
      addTimeline(`Tool completed · ${event.tool}`, "Workspace result returned", "completed");
    } else if (type === "tool.call_failed") {
      addTimeline(`Tool failed · ${event.tool}`, event.error || "Tool execution failed", "error");
    } else if (type === "chat.message_completed") {
      const text = event.event?.text || event.event?.content || event.text;
      if (text) addTimeline("Rho", text, "completed");
    }
  }
}

function switchDockTab(name) {
  $$("[data-dock-tab]").forEach((button) => button.classList.toggle("active", button.dataset.dockTab === name));
  ["console", "plots", "problems"].forEach((tab) => $(`#${tab}Panel`).classList.toggle("hidden", tab !== name));
}

function switchContextTab(name) {
  $$("[data-context-tab]").forEach((button) => button.classList.toggle("active", button.dataset.contextTab === name));
  $("#agentPanel").classList.toggle("hidden", name !== "agent");
  $("#environmentPanel").classList.toggle("hidden", name !== "environment");
}

const panelDefaults = {
  left: 214,
  right: 362,
  dock: 260,
};

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function panelLimits() {
  const shell = $(".app-shell").getBoundingClientRect();
  const workspace = $(".workspace").getBoundingClientRect();
  return {
    left: [160, Math.min(380, shell.width - 760)],
    right: [280, Math.min(620, shell.width - 640)],
    dock: [130, Math.max(130, workspace.height - 156)],
  };
}

function setPanelSize(panel, requested, persist = true) {
  const limits = panelLimits()[panel];
  const value = Math.round(clamp(requested, limits[0], limits[1]));
  const property = panel === "left"
    ? "--left-pane-width"
    : panel === "right"
      ? "--right-pane-width"
      : "--dock-height";
  $(".app-shell").style.setProperty(property, `${value}px`);
  const handle = panel === "left" ? $("#leftResizeHandle") : panel === "right" ? $("#rightResizeHandle") : $("#dockResizeHandle");
  handle.setAttribute("aria-valuenow", String(value));
  if (persist) localStorage.setItem(`rho.panel.${panel}`, String(value));
  return value;
}

function setupPanelResizer(handle, panel) {
  let startingPointer = 0;
  let startingSize = 0;
  let active = false;
  let inputType = null;
  const isDock = panel === "dock";

  const begin = (event, type) => {
    if (active || event.button !== 0) return;
    active = true;
    inputType = type;
    startingPointer = isDock ? event.clientY : event.clientX;
    startingSize = Number(handle.getAttribute("aria-valuenow"));
    if (type === "pointer") {
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        inputType = "mouse";
      }
    }
    handle.classList.add("active");
    document.body.classList.add("resizing", isDock ? "resizing-horizontal" : "resizing-vertical");
    event.preventDefault();
  };

  const move = (event, type) => {
    if (type !== inputType) return;
    if (!active) return;
    const pointer = isDock ? event.clientY : event.clientX;
    const delta = pointer - startingPointer;
    const requested = panel === "left"
      ? startingSize + delta
      : startingSize - delta;
    setPanelSize(panel, requested);
  };

  const stop = (event) => {
    if (!active) return;
    active = false;
    if (event.pointerId !== undefined && handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    handle.classList.remove("active");
    document.body.classList.remove("resizing", "resizing-horizontal", "resizing-vertical");
    inputType = null;
  };
  handle.addEventListener("pointerdown", (event) => begin(event, "pointer"));
  handle.addEventListener("pointermove", (event) => move(event, "pointer"));
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  handle.addEventListener("mousedown", (event) => begin(event, "mouse"));
  document.addEventListener("mousemove", (event) => move(event, "mouse"));
  document.addEventListener("mouseup", stop);
  handle.addEventListener("dblclick", () => setPanelSize(panel, panelDefaults[panel]));
  handle.addEventListener("keydown", (event) => {
    const current = Number(handle.getAttribute("aria-valuenow"));
    const amount = event.shiftKey ? 40 : 12;
    let delta = 0;
    if (panel === "left" && event.key === "ArrowLeft") delta = -amount;
    if (panel === "left" && event.key === "ArrowRight") delta = amount;
    if (panel === "right" && event.key === "ArrowLeft") delta = amount;
    if (panel === "right" && event.key === "ArrowRight") delta = -amount;
    if (panel === "dock" && event.key === "ArrowUp") delta = amount;
    if (panel === "dock" && event.key === "ArrowDown") delta = -amount;
    if (!delta) return;
    event.preventDefault();
    setPanelSize(panel, current + delta);
  });
}

function initializePanelLayout() {
  for (const panel of ["left", "right", "dock"]) {
    const stored = Number(localStorage.getItem(`rho.panel.${panel}`));
    setPanelSize(panel, Number.isFinite(stored) && stored > 0 ? stored : panelDefaults[panel], false);
  }
  setupPanelResizer($("#leftResizeHandle"), "left");
  setupPanelResizer($("#rightResizeHandle"), "right");
  setupPanelResizer($("#dockResizeHandle"), "dock");
}

function toggleDockMaximize() {
  const button = $("#toggleDockMaximize");
  const expanded = button.dataset.expanded === "true";
  if (expanded) {
    const previous = Number(button.dataset.previousHeight) || panelDefaults.dock;
    setPanelSize("dock", previous);
    button.dataset.expanded = "false";
    button.textContent = "⤢";
    button.title = "Expand execution panel";
    button.setAttribute("aria-label", "Expand execution panel");
    return;
  }
  button.dataset.previousHeight = $("#dockResizeHandle").getAttribute("aria-valuenow");
  setPanelSize("dock", panelLimits().dock[1]);
  button.dataset.expanded = "true";
  button.textContent = "⤡";
  button.title = "Restore execution panel";
  button.setAttribute("aria-label", "Restore execution panel");
}

function updateEditorChrome() {
  const editor = $("#editor");
  const lines = editor.value.split("\n").length;
  $("#lineNumbers").textContent = Array.from({ length: lines }, (_, index) => index + 1).join("\n");
  const before = editor.value.slice(0, editor.selectionStart).split("\n");
  $("#cursorLine").textContent = String(before.length);
  $("#cursorColumn").textContent = String(before.at(-1).length + 1);
  const document = activeDocument();
  if (document) {
    document.content = editor.value;
    renderProjectFiles();
    renderDocumentTabs();
  }
}

function toast(message, error = false) {
  const element = document.createElement("div");
  element.className = `toast ${error ? "error" : ""}`;
  element.textContent = message;
  $("#toastRegion").append(element);
  setTimeout(() => element.remove(), 4500);
}

async function initialize() {
  initializePanelLayout();
  try {
    const status = await invoke("workspace_start");
    updateIdentity(status.workspace);
    $("#rVersion").textContent = status.r_version || "R";
    setKernelStatus("idle", "R idle");
    addConsole("SYSTEM", `${status.r_version} · Ark PID ${status.kernel_pid}`);
    await refreshProject();
    await refreshEnvironment();
  } catch (error) {
    setKernelStatus("error", "R unavailable");
    addConsole("SYSTEM", String(error), "error");
    addProblem(String(error));
    toast(String(error), true);
  }
}

$("#runButton").addEventListener("click", () => executeCode(selectedEditorCode()));
$("#editorRunButton").addEventListener("click", () => executeCode(selectedEditorCode()));
$("#saveFileButton").addEventListener("click", saveActiveDocument);
$(".new-tab").addEventListener("click", createDocument);
$("#projectSwitcher").addEventListener("click", async () => {
  const path = window.prompt("Project directory", state.project.root || "D:/Rho");
  if (!path) return;
  try {
    state.project = await invoke("project_open", { path });
    state.documents = {};
    state.activeDocument = null;
    await refreshProject();
  } catch (error) {
    toast(String(error), true);
  }
});
$("#consoleRunButton").addEventListener("click", () => {
  const value = $("#consoleInput").value;
  $("#consoleInput").value = "";
  executeCode(value);
});
$("#consoleInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    $("#consoleRunButton").click();
  }
});
$("#editor").addEventListener("input", updateEditorChrome);
$("#editor").addEventListener("click", updateEditorChrome);
$("#editor").addEventListener("keyup", updateEditorChrome);
$("#editor").addEventListener("scroll", () => { $("#lineNumbers").scrollTop = $("#editor").scrollTop; });
$("#editor").addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveActiveDocument();
    return;
  }
  if (event.ctrlKey && event.key === "Enter") {
    event.preventDefault();
    executeCode(selectedEditorCode());
  }
  if (event.key === "Tab") {
    event.preventDefault();
    const editor = event.currentTarget;
    const start = editor.selectionStart;
    editor.setRangeText("  ", start, editor.selectionEnd, "end");
    updateEditorChrome();
  }
});

$$("[data-dock-tab]").forEach((button) => button.addEventListener("click", () => switchDockTab(button.dataset.dockTab)));
$$("[data-context-tab]").forEach((button) => button.addEventListener("click", () => switchContextTab(button.dataset.contextTab)));
$$("[data-side-tab]").forEach((button) => button.addEventListener("click", () => {
  $$("[data-side-tab]").forEach((value) => value.classList.toggle("active", value === button));
  $("#filesPanel").classList.toggle("hidden", button.dataset.sideTab !== "files");
  $("#runsPanel").classList.toggle("hidden", button.dataset.sideTab !== "runs");
}));
$$("[data-agent-mode]").forEach((button) => button.addEventListener("click", () => {
  state.agentMode = button.dataset.agentMode;
  $$("[data-agent-mode]").forEach((value) => value.classList.toggle("active", value === button));
}));
$$("[data-layout]").forEach((button) => button.addEventListener("click", () => {
  $$("[data-layout]").forEach((value) => value.classList.toggle("active", value === button));
  if (button.dataset.layout === "agent") switchContextTab("agent");
  if (button.dataset.layout === "analyze") switchContextTab("environment");
}));

$("#agentSendButton").addEventListener("click", sendAgentPrompt);
$("#agentInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendAgentPrompt();
  }
});
$("#refreshEnvironment").addEventListener("click", refreshEnvironment);
$("#environmentSearch").addEventListener("input", renderEnvironment);
$("#toggleDockMaximize").addEventListener("click", toggleDockMaximize);
window.addEventListener("resize", () => {
  for (const panel of ["left", "right", "dock"]) {
    const handle = panel === "left" ? $("#leftResizeHandle") : panel === "right" ? $("#rightResizeHandle") : $("#dockResizeHandle");
    setPanelSize(panel, Number(handle.getAttribute("aria-valuenow")), false);
  }
});
$("#interruptButton").addEventListener("click", async () => {
  try {
    await invoke("interrupt_r");
    addConsole("SYSTEM", "Interrupt requested");
  } catch (error) {
    toast(String(error), true);
  }
});
$("#restartButton").addEventListener("click", async () => {
  setKernelStatus("starting", "Restarting R…");
  try {
    const status = await invoke("restart_workspace");
    updateIdentity(status.workspace);
    setKernelStatus("idle", "R idle");
    state.objects = [];
    renderEnvironment();
    addConsole("SYSTEM", `Workspace restarted · Ark PID ${status.kernel_pid}`);
  } catch (error) {
    setKernelStatus("error", "R unavailable");
    toast(String(error), true);
  }
});

initialize();
