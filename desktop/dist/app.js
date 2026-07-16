const tauriInvoke = window.__TAURI__?.core?.invoke;
const isDesktop = typeof tauriInvoke === "function";
const tauriEvent = window.__TAURI__?.event;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const initialEditorContent = $("#editor")?.value || "";

const state = {
  busy: false,
  agentMode: "ask",
  agentBusy: false,
  objects: [],
  plots: [],
  runs: [],
  problems: [],
  agentTurns: [],
  pendingApprovals: [],
  selectedTurnId: null,
  selectedTurnDetail: null,
  agentPollTimer: null,
  activeRunId: null,
  revision: { state_revision: 1, project_revision: 0 },
  projectStatus: "loading",
  unavailable: null,
  project: { root: "", files: [] },
  documents: {},
  closedDrafts: {},
  activeDocument: null,
  sessionSaveTimer: null,
  watcherUnlisten: null,
  editor: {
    mode: "textarea",
    monaco: null,
    editor: null,
    models: new Map(),
    workerUrl: null,
    ready: false,
    loading: false,
    fallbackNotice: "",
    suppressChange: false,
  },
};

const mockProjects = {
  "D:/Rho": {
    files: [
      { path: "analysis.R", name: "analysis.R", kind: "source", size_bytes: 120 },
      { path: "scratch.R", name: "scratch.R", kind: "source", size_bytes: 420 },
    ],
    contents: {
      "analysis.R": "# Project analysis\nsummary(qc)\n",
      "scratch.R": "# Live analysis in Workspace R\nset.seed(42)\nqc <- data.frame(sample = paste0(\"S\", 1:12), reads = round(rlnorm(12, 11.2, 0.35)), detected = round(rnorm(12, 3200, 420)))\nsummary(qc)\nplot(qc$reads, qc$detected)\n",
    },
  },
  "D:/Rho-demo": {
    files: [
      { path: "demo.R", name: "demo.R", kind: "source", size_bytes: 64 },
    ],
    contents: {
      "demo.R": "message('demo project')\n",
    },
  },
};
let mockLastProject = "D:/Rho";
const mockProjectSessions = {};
let mockRunSequence = 0;
const mockRuns = [];
let mockAgentTurnSequence = 0;
let mockApprovalSequence = 0;
const mockAgentTurns = [];
const mockApprovalRequests = [];

function nextMockRunId() {
  mockRunSequence += 1;
  return `exec_mock_${mockRunSequence}`;
}

function nextMockTurnId() {
  mockAgentTurnSequence += 1;
  return `agent_turn_${mockAgentTurnSequence}`;
}

function nextMockApprovalId() {
  mockApprovalSequence += 1;
  return `approval_${mockApprovalSequence}`;
}

function mockTurnSummary(turn) {
  const pending = mockApprovalRequests.find((item) => item.turn_id === turn.turn_id && item.status === "waiting");
  return {
    turn_id: turn.turn_id,
    mode: turn.mode,
    status: turn.status,
    started_at: turn.started_at,
    finished_at: turn.finished_at,
    prompt_preview: turn.prompt_preview,
    model: turn.model,
    workspace_id_before: turn.workspace_id_before,
    state_revision_before: turn.state_revision_before,
    project_revision_before: turn.project_revision_before,
    workspace_id_after: turn.workspace_id_after,
    state_revision_after: turn.state_revision_after,
    project_revision_after: turn.project_revision_after,
    final_message: turn.final_message,
    error_message: turn.error_message,
    pending_request_id: pending?.request_id || null,
  };
}

function createMockAgentTurn({ prompt, mode, model }) {
  const startedAt = new Date().toISOString();
  const turn = {
    turn_id: nextMockTurnId(),
    mode,
    status: mode === "act" ? "waiting" : "completed",
    started_at: startedAt,
    finished_at: mode === "act" ? null : startedAt,
    prompt_preview: prompt.replace(/\s+/g, " ").trim().slice(0, 120) || "<empty>",
    model,
    workspace_id_before: "desktop_mock",
    state_revision_before: state.revision.state_revision,
    project_revision_before: state.revision.project_revision,
    workspace_id_after: mode === "act" ? null : "desktop_mock",
    state_revision_after: mode === "act" ? null : state.revision.state_revision,
    project_revision_after: mode === "act" ? null : state.revision.project_revision,
    final_message: null,
    error_message: null,
    events: [
      {
        id: 1,
        turn_id: null,
        timestamp: startedAt,
        event_type: "agent.user_prompt",
        title: "You",
        body: prompt,
        status: "completed",
        tool: null,
        request_id: null,
        code: null,
        details_json: JSON.stringify({ prompt, mode }),
      },
      {
        id: 2,
        turn_id: null,
        timestamp: startedAt,
        event_type: "agent.run_started",
        title: "Agent started",
        body: mode === "act" ? "Act mode may request execution after approval." : `${mode[0].toUpperCase()}${mode.slice(1)} mode is running in read-only broker policy.`,
        status: "running",
        tool: null,
        request_id: null,
        code: null,
        details_json: "{}",
      },
    ],
  };
  turn.events.forEach((event) => { event.turn_id = turn.turn_id; });
  if (mode === "act") {
    const requestId = nextMockApprovalId();
    mockApprovalRequests.unshift({
      request_id: requestId,
      turn_id: turn.turn_id,
      tool: "run_r",
      policy: "required",
      status: "waiting",
      decision: null,
      reason: null,
      arguments_json: JSON.stringify({ code: "summary(qc)" }),
      code: "summary(qc)",
      workspace_id: "desktop_mock",
      state_revision: state.revision.state_revision,
      project_revision: state.revision.project_revision,
      requested_at: startedAt,
      responded_at: null,
      continuation_outcome: null,
    });
    turn.events.push({
      id: 3,
      turn_id: turn.turn_id,
      timestamp: startedAt,
      event_type: "approval.requested",
      title: "Approval requested · run_r",
      body: "Workspace R remains unchanged until you approve this request.",
      status: "running",
      tool: "run_r",
      request_id: requestId,
      code: "summary(qc)",
      details_json: JSON.stringify({ request_id: requestId }),
    });
  } else {
    const text = "`qc` 包含 12 个样本和 3 个变量。reads 与 detected 的分布整体稳定，目前没有明显离群样本。";
    turn.final_message = text;
    turn.events.push(
      {
        id: 3,
        turn_id: turn.turn_id,
        timestamp: startedAt,
        event_type: "tool.call_started",
        title: "Tool · inspect_r_object",
        body: "Running against Workspace R",
        status: "running",
        tool: "inspect_r_object",
        request_id: null,
        code: null,
        details_json: "{}",
      },
      {
        id: 4,
        turn_id: turn.turn_id,
        timestamp: startedAt,
        event_type: "tool.call_completed",
        title: "Tool completed · inspect_r_object",
        body: "Workspace result returned.",
        status: "completed",
        tool: "inspect_r_object",
        request_id: null,
        code: null,
        details_json: "{}",
      },
      {
        id: 5,
        turn_id: turn.turn_id,
        timestamp: startedAt,
        event_type: "chat.message_completed",
        title: "Rho",
        body: text,
        status: "completed",
        tool: null,
        request_id: null,
        code: null,
        details_json: JSON.stringify({ text }),
      },
    );
  }
  mockAgentTurns.unshift(turn);
  return turn;
}

function recordMockRun({
  origin = "user",
  status = "completed",
  requestType = "workspace.execute",
  operationClass = "state_capable",
  code = "",
  sourcePath = null,
  executionMode = null,
  documentVersion = null,
  errorMessage = null,
  errorCall = null,
  traceback = [],
  parentRunId = null,
}) {
  const runId = nextMockRunId();
  const startedAt = new Date().toISOString();
  const entry = {
    run_id: runId,
    parent_run_id: parentRunId,
    origin,
    status,
    started_at: startedAt,
    finished_at: startedAt,
    terminal_reason: errorMessage ? "r_error" : null,
    request_type: requestType,
    operation_class: operationClass,
    source_path: sourcePath,
    execution_mode: executionMode,
    document_version: documentVersion,
    workspace_id: "desktop_mock",
    state_revision_before: state.revision.state_revision,
    project_revision_before: state.revision.project_revision,
    state_revision_after: state.revision.state_revision,
    project_revision_after: state.revision.project_revision,
    code_preview: code.split("\n").find((line) => line.trim())?.trim() || "<empty>",
    error_message: errorMessage,
    code,
    arguments_json: JSON.stringify({
      code,
      source_path: sourcePath,
      execution_mode: executionMode,
      document_version: documentVersion,
      parent_run_id: parentRunId,
    }),
    stdout: "",
    value_text: errorMessage ? null : "Mock result",
    messages: [],
    warnings: [],
    error_call: errorCall,
    traceback,
  };
  mockRuns.unshift(entry);
  return entry;
}

function mockProblemList() {
  return mockRuns
    .filter((run) => run.error_message)
    .map((run) => ({
      run_id: run.run_id,
      parent_run_id: run.parent_run_id,
      origin: run.origin,
      status: run.status,
      message: run.error_message,
      call: run.error_call,
      traceback: [...(run.traceback || [])],
      source_path: run.source_path,
      execution_mode: run.execution_mode,
      document_version: run.document_version,
      workspace_id: run.workspace_id,
      started_at: run.started_at,
      finished_at: run.finished_at,
    }));
}

function mockProjectState(root = mockLastProject) {
  const project = mockProjects[root] || mockProjects["D:/Rho"];
  return { root, files: project.files.map((file) => ({ ...file })) };
}

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
  if (command === "project_restore_session") {
    const project = mockProjectState(mockLastProject);
    return {
      status: "ready",
      project,
      session: mockProjectSessions[mockLastProject] || {
        open_documents: [{ path: project.files[0]?.path || "", cursor_start: 1, cursor_end: 1, draft_content: null }].filter((item) => item.path),
        active_document: project.files[0]?.path || null,
        panels: { left: 214, right: 362, dock: 260 },
      },
      unavailable: null,
    };
  }
  if (command === "project_pick_directory") {
    const roots = Object.keys(mockProjects);
    const currentIndex = roots.indexOf(mockLastProject);
    mockLastProject = roots[(currentIndex + 1) % roots.length];
    return mockInvoke("project_restore_session");
  }
  if (command === "project_save_session") {
    mockProjectSessions[mockLastProject] = structuredClone(args.snapshot || {});
    return { status: "saved" };
  }
  if (command === "project_state") {
    return mockProjectState(mockLastProject);
  }
  if (command === "project_read_file") {
    const project = mockProjects[mockLastProject] || mockProjects["D:/Rho"];
    return { path: args.path, content: project.contents[args.path] || "" };
  }
  if (command === "project_write_file" || command === "project_create_file") {
    const project = mockProjects[mockLastProject] || mockProjects["D:/Rho"];
    project.contents[args.path] = args.content || "";
    if (!project.files.some((file) => file.path === args.path)) {
      project.files.push({
        path: args.path,
        name: args.path.split("/").at(-1),
        kind: "source",
        size_bytes: (args.content || "").length,
      });
    }
    return mockInvoke("project_state", {});
  }
  if (command === "snapshot_workspace") {
    return {
      execution: {
        objects: state.objects,
        r: { version: "R version 4.6.0", cwd: mockLastProject },
      },
      workspace: state.revision,
    };
  }
  if (command === "execute_r") {
    const request = args.request || {};
    state.revision.state_revision += 1;
    state.objects = [
      { name: "qc", classes: ["data.frame"], dimensions: [12, 3], size_bytes: 2184, typeof: "list" },
    ];
    recordMockRun({
      origin: "user",
      status: request.code?.includes("stop(") ? "failed" : "completed",
      code: request.code || "",
      sourcePath: request.source_path ?? request.sourcePath ?? null,
      executionMode: request.execution_mode ?? request.type ?? null,
      documentVersion: request.document_version ?? request.documentVersion ?? null,
      errorMessage: request.code?.includes("stop(") ? "boom" : null,
      errorCall: request.code?.includes("stop(") ? "stop(\"boom\")" : null,
      traceback: request.code?.includes("stop(") ? ["stop(\"boom\")"] : [],
      parentRunId: request.parent_run_id ?? null,
    });
    return {
      execution_id: "exec_demo",
      execution: {
        ok: !request.code?.includes("stop("),
        code: request.code,
        stdout: "",
        value: request.code?.includes("stop(") ? null : "     reads        detected   \n Min.   : 40122   Min.   :2511  \n Median : 72840   Median :3238  \n Mean   : 76114   Mean   :3216",
        warnings: [],
        messages: [],
        error: request.code?.includes("stop(") ? { message: "boom", call: "stop(\"boom\")" } : null,
        traceback: request.code?.includes("stop(") ? ["stop(\"boom\")"] : [],
      },
      events: [{ event: { type: "display_data", data: { "rho/mock-image": "assets/demo-plot.png" } } }],
      workspace: state.revision,
    };
  }
  if (command === "list_runs") {
    return structuredClone(mockRuns.slice(0, args.limit || 50));
  }
  if (command === "list_problems") {
    return structuredClone(mockProblemList().slice(0, args.limit || 50));
  }
  if (command === "get_run_detail") {
    return structuredClone(mockRuns.find((run) => run.run_id === args.run_id) || null);
  }
  if (command === "retry_run") {
    const detail = mockRuns.find((run) => run.run_id === args.run_id);
    if (!detail) throw new Error(`Run not found: ${args.run_id}`);
    return mockInvoke("execute_r", {
      request: {
        code: detail.code,
        source_path: detail.source_path,
        execution_mode: detail.execution_mode,
        document_version: detail.document_version,
        parent_run_id: detail.run_id,
      },
    });
  }
  if (command === "cancel_run" || command === "interrupt_r") {
    const active = args.run_id
      ? mockRuns.find((run) => run.run_id === args.run_id)
      : mockRuns.find((run) => ["queued", "running", "waiting"].includes(run.status));
    if (active) {
      active.status = "interrupted";
      active.terminal_reason = "user_interrupt";
      active.finished_at = new Date().toISOString();
    }
    return { status: "interrupt_requested", run_id: active?.run_id || null };
  }
  if (command === "run_agent") {
    const turn = createMockAgentTurn({
      prompt: args.prompt || "",
      mode: args.mode || "ask",
      model: args.model || "deepseek:deepseek-v4-flash",
    });
    return { status: "started", turn_id: turn.turn_id };
  }
  if (command === "list_agent_turns") {
    return structuredClone(mockAgentTurns.slice(0, args.limit || 50).map(mockTurnSummary));
  }
  if (command === "list_approval_requests") {
    const filtered = (mockApprovalRequests || []).filter((item) => !args.status || item.status === args.status);
    return structuredClone(filtered.slice(0, args.limit || 50));
  }
  if (command === "get_agent_turn_detail") {
    const turn = mockAgentTurns.find((item) => item.turn_id === args.turn_id);
    if (!turn) return null;
    return structuredClone({
      turn: mockTurnSummary(turn),
      events: turn.events || [],
      approvals: mockApprovalRequests.filter((item) => item.turn_id === turn.turn_id),
    });
  }
  if (command === "respond_approval") {
    const approval = mockApprovalRequests.find((item) => item.request_id === args.request.request_id);
    if (!approval) throw new Error(`Approval request not found: ${args.request.request_id}`);
    const turn = mockAgentTurns.find((item) => item.turn_id === approval.turn_id);
    if (!turn) throw new Error(`Agent turn not found: ${approval.turn_id}`);
    approval.decision = args.request.decision;
    approval.responded_at = new Date().toISOString();
    approval.reason = args.request.reason || null;
    if (args.request.decision === "approve") {
      approval.status = "approved";
      approval.continuation_outcome = "execute";
      turn.status = "completed";
      turn.finished_at = approval.responded_at;
      turn.workspace_id_after = "desktop_mock";
      state.revision.state_revision += 1;
      turn.state_revision_after = state.revision.state_revision;
      turn.project_revision_after = state.revision.project_revision;
      recordMockRun({
        origin: "agent",
        status: "completed",
        code: approval.code || "summary(qc)",
        sourcePath: state.activeDocument,
        executionMode: "selection",
      });
      turn.final_message = "我已经执行并检查结果，当前工作区状态已更新。";
      turn.events.push(
        {
          id: turn.events.length + 1,
          turn_id: turn.turn_id,
          timestamp: approval.responded_at,
          event_type: "approval.approved",
          title: "Approval granted · run_r",
          body: "Broker resumed the pending tool call.",
          status: "completed",
          tool: "run_r",
          request_id: approval.request_id,
          code: approval.code,
          details_json: "{}",
        },
        {
          id: turn.events.length + 2,
          turn_id: turn.turn_id,
          timestamp: approval.responded_at,
          event_type: "tool.call_completed",
          title: "Tool completed · run_r",
          body: "Workspace result returned.",
          status: "completed",
          tool: "run_r",
          request_id: approval.request_id,
          code: approval.code,
          details_json: "{}",
        },
        {
          id: turn.events.length + 3,
          turn_id: turn.turn_id,
          timestamp: approval.responded_at,
          event_type: "chat.message_completed",
          title: "Rho",
          body: turn.final_message,
          status: "completed",
          tool: null,
          request_id: null,
          code: null,
          details_json: "{}",
        },
      );
      return { status: "delivered", request_id: approval.request_id, turn_id: turn.turn_id };
    }
    approval.status = args.request.decision === "cancel" ? "cancelled" : "rejected";
    approval.continuation_outcome = args.request.decision === "cancel" ? "approval_cancelled" : "approval_rejected";
    turn.status = "completed";
    turn.finished_at = approval.responded_at;
    turn.workspace_id_after = "desktop_mock";
    turn.state_revision_after = state.revision.state_revision;
    turn.project_revision_after = state.revision.project_revision;
    turn.final_message = args.request.decision === "cancel" ? "这次执行已取消，Workspace R 保持不变。" : "我没有执行这段代码，Workspace R 保持不变。";
    turn.events.push(
      {
        id: turn.events.length + 1,
        turn_id: turn.turn_id,
        timestamp: approval.responded_at,
        event_type: `approval.${approval.status}`,
        title: `${approval.status === "cancelled" ? "Approval cancelled" : "Approval rejected"} · run_r`,
        body: approval.reason || turn.final_message,
        status: "error",
        tool: "run_r",
        request_id: approval.request_id,
        code: approval.code,
        details_json: "{}",
      },
      {
        id: turn.events.length + 2,
        turn_id: turn.turn_id,
        timestamp: approval.responded_at,
        event_type: "chat.message_completed",
        title: "Rho",
        body: turn.final_message,
        status: "completed",
        tool: null,
        request_id: null,
        code: null,
        details_json: "{}",
      },
    );
    return { status: "delivered", request_id: approval.request_id, turn_id: turn.turn_id };
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
  $("#runButton").disabled = busy || state.projectStatus !== "ready";
  $("#editorRunButton").disabled = busy || state.projectStatus !== "ready";
  $("#editorRunFileButton").disabled = busy || state.projectStatus !== "ready";
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

function activeProjectName() {
  return state.project.root.split(/[\\/]/).filter(Boolean).at(-1) || "Rho Project";
}

function supportsMonaco() {
  return typeof window.Worker === "function";
}

function fallbackEditor() {
  return $("#editor");
}

function fallbackNotice(message = "") {
  state.editor.fallbackNotice = message;
  const notice = $("#editorFallbackNotice");
  notice.textContent = message;
  notice.classList.toggle("hidden", !message || state.editor.mode === "monaco");
}

function setEditorMode(mode, notice = "") {
  state.editor.mode = mode;
  $("#editorMonaco").classList.toggle("hidden", mode !== "monaco");
  $("#editorFallback").classList.toggle("hidden", mode === "monaco");
  fallbackNotice(mode === "monaco" ? "" : notice);
  fallbackEditor().disabled = state.projectStatus !== "ready";
}

function loadScript(source) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-src="${source}"]`);
    if (existing) {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${source}`)), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = source;
    script.dataset.src = source;
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", () => reject(new Error(`Failed to load ${source}`)), { once: true });
    document.head.append(script);
  });
}

function monacoWorkerUrl() {
  if (state.editor.workerUrl) return state.editor.workerUrl;
  const workerSource = `
self.MonacoEnvironment = { baseUrl: "./vendor/monaco/" };
importScripts("./vendor/monaco/vs/base/worker/workerMain.js");
`;
  state.editor.workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  return state.editor.workerUrl;
}

function registerRLanguage(monaco) {
  if (monaco.languages.getLanguages().some((language) => language.id === "r")) return;
  monaco.languages.register({
    id: "r",
    extensions: [".r", ".R", ".rmd", ".Rmd", ".qmd", ".Qmd"],
    aliases: ["R", "r"],
  });
  monaco.languages.setLanguageConfiguration("r", {
    comments: { lineComment: "#" },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"" },
      { open: "'", close: "'" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"" },
      { open: "'", close: "'" },
    ],
  });
  monaco.languages.setMonarchTokensProvider("r", {
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/\b(if|else|repeat|while|function|for|in|next|break)\b/, "keyword"],
        [/\b(TRUE|FALSE|NULL|NA|NA_integer_|NA_real_|NA_complex_|NA_character_|Inf|NaN)\b/, "keyword"],
        [/\b(library|require|source|return|setwd)\b/, "keyword"],
        [/\b([A-Za-z.][\w.]*)\s*(?=\()/, "predefined"],
        [/[{}()[\]]/, "@brackets"],
        [/<<?-|->>?|==|!=|<=|>=|&&?|\|\|?|\$|@|:|=|\+|-|\*|\/|\^|~|!/, "operator"],
        [/\d+\.\d*([eE][\-+]?\d+)?[Li]?/, "number.float"],
        [/\d+([eE][\-+]?\d+)?[Li]?/, "number"],
        [/"/, { token: "string.quote", bracket: "@open", next: "@string_double" }],
        [/'/, { token: "string.quote", bracket: "@open", next: "@string_single" }],
        [/[A-Za-z.][\w.]*/, "identifier"],
      ],
      string_double: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
      ],
      string_single: [
        [/[^\\']+/, "string"],
        [/\\./, "string.escape"],
        [/'/, { token: "string.quote", bracket: "@close", next: "@pop" }],
      ],
    },
  });
}

function modelUriForPath(path) {
  return state.editor.monaco.Uri.parse(`rho:///${path.replace(/\\/g, "/")}`);
}

function ensureDocumentModel(documentState) {
  if (!state.editor.monaco) return null;
  let model = state.editor.models.get(documentState.path);
  if (!model) {
    model = state.editor.monaco.editor.createModel(
      documentState.content,
      documentState.language || "r",
      modelUriForPath(documentState.path)
    );
    state.editor.models.set(documentState.path, model);
  }
  if (model.getValue() !== documentState.content) {
    state.editor.suppressChange = true;
    model.setValue(documentState.content);
    state.editor.suppressChange = false;
  }
  documentState.versionId = model.getAlternativeVersionId();
  return model;
}

function syncDocumentFromEditor(options = {}) {
  const { render = true, persist = true } = options;
  const documentState = activeDocument();
  if (!documentState) return;
  if (state.editor.mode === "monaco" && state.editor.editor) {
    const model = state.editor.editor.getModel();
    const selection = state.editor.editor.getSelection();
    if (model) {
      documentState.content = model.getValue();
      documentState.versionId = model.getAlternativeVersionId();
    }
    if (selection && model) {
      documentState.cursorStart = model.getOffsetAt(selection.getStartPosition());
      documentState.cursorEnd = model.getOffsetAt(selection.getEndPosition());
    }
  } else {
    const editor = fallbackEditor();
    documentState.content = editor.value;
    documentState.cursorStart = editor.selectionStart;
    documentState.cursorEnd = editor.selectionEnd;
  }
  if (render) {
    renderProjectFiles();
    renderDocumentTabs();
  }
  if (persist) scheduleSessionSave();
}

function currentEditorValue() {
  if (state.editor.mode === "monaco" && state.editor.editor?.getModel()) {
    return state.editor.editor.getModel().getValue();
  }
  return fallbackEditor().value;
}

function currentEditorOffsets() {
  if (state.editor.mode === "monaco" && state.editor.editor?.getModel()) {
    const model = state.editor.editor.getModel();
    const selection = state.editor.editor.getSelection();
    return {
      start: model.getOffsetAt(selection.getStartPosition()),
      end: model.getOffsetAt(selection.getEndPosition()),
    };
  }
  return {
    start: fallbackEditor().selectionStart,
    end: fallbackEditor().selectionEnd,
  };
}

function currentCursorPosition() {
  if (state.editor.mode === "monaco" && state.editor.editor) {
    const position = state.editor.editor.getPosition();
    return {
      line: position?.lineNumber || 1,
      column: position?.column || 1,
    };
  }
  const before = fallbackEditor().value.slice(0, fallbackEditor().selectionStart).split("\n");
  return {
    line: before.length,
    column: before.at(-1).length + 1,
  };
}

function currentSelectionLabel() {
  if (state.projectStatus !== "ready") return "Project unavailable";
  const documentState = activeDocument();
  if (!documentState) return "No file";
  const { start, end } = currentEditorOffsets();
  if (start !== end) {
    return `Selection ${Math.abs(end - start)} ch`;
  }
  return `Line ${currentCursorPosition().line}`;
}

function updateEditorChrome() {
  const position = currentCursorPosition();
  $("#cursorLine").textContent = String(position.line);
  $("#cursorColumn").textContent = String(position.column);
  $("#selectionStatus").textContent = currentSelectionLabel();
  if (state.editor.mode === "textarea") {
    const editor = fallbackEditor();
    const lines = editor.value.split("\n").length;
    $("#lineNumbers").textContent = Array.from({ length: lines }, (_, index) => index + 1).join("\n");
  }
}

function applyDocumentSelection(documentState) {
  if (!documentState) return;
  if (state.editor.mode === "monaco" && state.editor.editor) {
    const model = ensureDocumentModel(documentState);
    if (!model) return;
    state.editor.editor.setModel(model);
    const start = model.getPositionAt(documentState.cursorStart ?? 0);
    const end = model.getPositionAt(documentState.cursorEnd ?? documentState.cursorStart ?? 0);
    state.editor.editor.setSelection({
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    });
    state.editor.editor.revealPositionInCenterIfOutsideViewport(end);
    state.editor.editor.focus();
  } else {
    const editor = fallbackEditor();
    editor.value = documentState.content;
    editor.selectionStart = Math.min(documentState.cursorStart ?? 0, editor.value.length);
    editor.selectionEnd = Math.min(documentState.cursorEnd ?? documentState.cursorStart ?? 0, editor.value.length);
  }
  updateEditorChrome();
}

async function initializeEditor() {
  if (state.editor.ready) return;
  state.editor.ready = true;
  if (!supportsMonaco()) {
    setEditorMode("textarea", "Advanced editor is unavailable here. Running in basic mode.");
    updateEditorChrome();
    return;
  }
  try {
    await loadScript("./vendor/monaco/vs/loader.js");
    await new Promise((resolve, reject) => {
      window.MonacoEnvironment = {
        getWorkerUrl: () => monacoWorkerUrl(),
      };
      window.require.config({ paths: { vs: "./vendor/monaco/vs" } });
      window.require(["vs/editor/editor.main"], resolve, reject);
    });
    state.editor.monaco = window.monaco;
    registerRLanguage(state.editor.monaco);
    state.editor.monaco.editor.defineTheme("rho", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "keyword", foreground: "1f746d" },
        { token: "string", foreground: "8a4d00" },
        { token: "comment", foreground: "70848a", fontStyle: "italic" },
      ],
      colors: {
        "editorLineNumber.foreground": "#9aa6aa",
        "editor.lineHighlightBackground": "#f6fbfa",
        "editor.selectionBackground": "#cfe9e6",
      },
    });
    state.editor.editor = state.editor.monaco.editor.create($("#editorMonaco"), {
      value: initialEditorContent,
      language: "r",
      automaticLayout: false,
      minimap: { enabled: false },
      fontSize: 13,
      lineHeight: 21,
      tabSize: 2,
      insertSpaces: true,
      theme: "rho",
      scrollBeyondLastLine: false,
      wordWrap: "off",
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true },
    });
    state.editor.editor.onDidChangeModelContent(() => {
      if (state.editor.suppressChange) return;
      syncDocumentFromEditor({ render: true, persist: true });
      updateEditorChrome();
    });
    state.editor.editor.onDidChangeCursorSelection(() => {
      syncDocumentFromEditor({ render: false, persist: true });
      updateEditorChrome();
    });
    const KeyMod = state.editor.monaco.KeyMod;
    const KeyCode = state.editor.monaco.KeyCode;
    state.editor.editor.addCommand(KeyMod.CtrlCmd | KeyCode.Enter, () => runSelectionOrCurrentLine());
    state.editor.editor.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter, () => runActiveFile());
    setEditorMode("monaco");
    if (activeDocument()) applyDocumentSelection(activeDocument());
  } catch (error) {
    setEditorMode("textarea", `Advanced editor failed to load. Running in basic mode. ${error}`);
  }
  updateEditorChrome();
}

function setEditorDisabled(disabled) {
  fallbackEditor().disabled = disabled;
  if (state.editor.editor) {
    state.editor.editor.updateOptions({ readOnly: disabled });
  }
}

function layoutEditor() {
  if (state.editor.mode === "monaco" && state.editor.editor) {
    state.editor.editor.layout();
  } else {
    $("#lineNumbers").scrollTop = fallbackEditor().scrollTop;
  }
}

function selectionExecution() {
  const documentState = activeDocument();
  if (!documentState) return null;
  if (state.editor.mode === "monaco" && state.editor.editor?.getModel()) {
    const model = state.editor.editor.getModel();
    const selection = state.editor.editor.getSelection();
    const start = model.getOffsetAt(selection.getStartPosition());
    const end = model.getOffsetAt(selection.getEndPosition());
    const text = model.getValueInRange(selection);
    if (start === end || !text.trim()) return null;
    return {
      code: text,
      type: "selection",
      sourcePath: documentState.path,
      documentVersion: documentState.versionId ?? model.getAlternativeVersionId(),
      range: { start, end },
    };
  }
  const editor = fallbackEditor();
  if (editor.selectionStart === editor.selectionEnd) return null;
  const text = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  if (!text.trim()) return null;
  return {
    code: text,
    type: "selection",
    sourcePath: documentState.path,
    documentVersion: documentState.versionId ?? 0,
    range: { start: editor.selectionStart, end: editor.selectionEnd },
  };
}

function currentLineExecution() {
  const documentState = activeDocument();
  if (!documentState) return null;
  if (state.editor.mode === "monaco" && state.editor.editor?.getModel()) {
    const model = state.editor.editor.getModel();
    const position = state.editor.editor.getPosition();
    const line = position?.lineNumber || 1;
    const code = model.getLineContent(line);
    if (!code.trim()) return null;
    return {
      code,
      type: "line",
      sourcePath: documentState.path,
      documentVersion: documentState.versionId ?? model.getAlternativeVersionId(),
      range: {
        start: model.getOffsetAt({ lineNumber: line, column: 1 }),
        end: model.getOffsetAt({ lineNumber: line, column: model.getLineMaxColumn(line) }),
      },
      line,
    };
  }
  const value = fallbackEditor().value;
  const caret = fallbackEditor().selectionStart;
  const lineStart = value.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  const nextBreak = value.indexOf("\n", caret);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const code = value.slice(lineStart, lineEnd);
  if (!code.trim()) return null;
  return {
    code,
    type: "line",
    sourcePath: documentState.path,
    documentVersion: documentState.versionId ?? 0,
    range: { start: lineStart, end: lineEnd },
    line: value.slice(0, lineStart).split("\n").length,
  };
}

function fileExecution() {
  const documentState = activeDocument();
  if (!documentState) return null;
  syncDocumentFromEditor({ render: false, persist: false });
  const code = documentState.content;
  if (!code.trim()) return null;
  return {
    code,
    type: "file",
    sourcePath: documentState.path,
    documentVersion: documentState.versionId ?? 0,
    range: { start: 0, end: code.length },
  };
}

function setProjectStatus(status, unavailable = null) {
  state.projectStatus = status;
  state.unavailable = unavailable;
  const disabled = status !== "ready";
  setEditorDisabled(disabled);
  $("#runButton").disabled = disabled || state.busy;
  $("#editorRunButton").disabled = disabled || state.busy;
  $("#editorRunFileButton").disabled = disabled || state.busy;
  $("#saveFileButton").disabled = disabled;
  $(".new-tab").disabled = disabled;
  $("#projectName").textContent = unavailable?.path?.split(/[\\/]/).filter(Boolean).at(-1) || activeProjectName();
  $("#projectTreeRoot").textContent = unavailable?.path || state.project.root || "No project";
  $("#projectBanner").classList.toggle("hidden", status === "ready");
  $("#projectBannerTitle").textContent = status === "unavailable" ? "Project unavailable" : "No project loaded";
  $("#projectBannerMessage").textContent = unavailable
    ? `${unavailable.path} · ${unavailable.reason}`
    : "Select a project to continue.";
  $("#projectFileList").classList.toggle("hidden", status !== "ready");
  $("#projectEmptyState").classList.toggle("hidden", status === "ready");
  $("#projectEmptyState").textContent = status === "unavailable"
    ? "Saved project is unavailable. Choose another directory."
    : "Select a project to get started.";
  updateEditorChrome();
}

function documentSession(document) {
  return {
    path: document.path,
    cursor_start: document.cursorStart ?? 0,
    cursor_end: document.cursorEnd ?? 0,
    draft_content: documentIsDirty(document) ? document.content : null,
  };
}

function currentPanelSnapshot() {
  return {
    left: Number($("#leftResizeHandle").getAttribute("aria-valuenow")) || panelDefaults.left,
    right: Number($("#rightResizeHandle").getAttribute("aria-valuenow")) || panelDefaults.right,
    dock: Number($("#dockResizeHandle").getAttribute("aria-valuenow")) || panelDefaults.dock,
  };
}

function buildSessionSnapshot() {
  return {
    open_documents: Object.values(state.documents).map(documentSession),
    active_document: state.activeDocument,
    panels: currentPanelSnapshot(),
  };
}

function scheduleSessionSave() {
  if (state.projectStatus !== "ready" || !state.project.root) return;
  clearTimeout(state.sessionSaveTimer);
  state.sessionSaveTimer = setTimeout(async () => {
    await flushSessionSnapshot();
  }, 180);
}

async function flushSessionSnapshot() {
  if (state.projectStatus !== "ready" || !state.project.root) return;
  clearTimeout(state.sessionSaveTimer);
  state.sessionSaveTimer = null;
  try {
    await invoke("project_save_session", { snapshot: buildSessionSnapshot() });
  } catch (error) {
    toast(`Session state was not saved: ${error}`, true);
  }
}

function renderProjectFiles() {
  const list = $("#projectFileList");
  list.replaceChildren();
  if (state.projectStatus !== "ready") return;
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
    const button = document.createElement("div");
    button.className = `document-tab ${fileDocument.path === state.activeDocument ? "active" : ""}`;
    const icon = document.createElement("span");
    icon.className = "r-badge";
    icon.textContent = fileDocument.path.toLowerCase().endsWith(".r") ? "R" : "·";
    const label = document.createElement("span");
    label.textContent = fileDocument.path;
    const dirty = document.createElement("span");
    dirty.className = `unsaved ${documentIsDirty(fileDocument) ? "" : "hidden"}`;
    dirty.textContent = "●";
    const activate = document.createElement("button");
    activate.type = "button";
    activate.className = "document-tab-main";
    activate.append(icon, label, dirty);
    activate.addEventListener("click", () => openDocument(fileDocument.path));
    const close = document.createElement("button");
    close.type = "button";
    close.className = "document-tab-close";
    close.setAttribute("aria-label", `Close ${fileDocument.path}`);
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeDocument(fileDocument.path);
    });
    button.append(activate, close);
    tabs.append(button);
  }
}

function renderActiveDocument() {
  const documentState = activeDocument();
  if (!documentState) {
    if (state.editor.mode === "monaco" && state.editor.editor) {
      state.editor.editor.setModel(null);
    } else {
      fallbackEditor().value = "";
    }
    renderProjectFiles();
    renderDocumentTabs();
    updateEditorChrome();
    return;
  }
  $("#projectName").textContent = activeProjectName();
  applyDocumentSelection(documentState);
  renderProjectFiles();
  renderDocumentTabs();
  updateEditorChrome();
}

async function restoreDraftChoice(path, savedContent, draftContent) {
  if (draftContent === null || draftContent === undefined || draftContent === savedContent) return savedContent;
  const restore = window.confirm(
    `Restore the unsaved draft for ${path}?\n\nOK restores the draft.\nCancel loads the on-disk file.`
  );
  return restore ? draftContent : savedContent;
}

async function openDocument(path, options = {}) {
  const { sessionEntry = null, forceReload = false } = options;
  if (state.activeDocument && state.activeDocument !== path) {
    syncDocumentFromEditor({ render: false, persist: false });
  }
  if (!state.project.files.some((file) => file.path === path)) {
    toast(`File is no longer available: ${path}`, true);
    return;
  }
  if (!state.documents[path] || forceReload) {
    try {
      const result = await invoke("project_read_file", { path });
      const savedContent = result.content || "";
      const closedDraft = state.closedDrafts[path] || null;
      const restoredContent = await restoreDraftChoice(
        path,
        savedContent,
        sessionEntry?.draft_content ?? closedDraft?.draft_content ?? null
      );
      state.documents[path] = {
        path,
        content: restoredContent,
        savedContent,
        language: path.toLowerCase().endsWith(".r") ? "r" : "plaintext",
        versionId: 0,
        lastExecutedRange: null,
        cursorStart: sessionEntry?.cursor_start ?? closedDraft?.cursor_start ?? 0,
        cursorEnd: sessionEntry?.cursor_end ?? closedDraft?.cursor_end ?? 0,
        conflictDiskContent: null,
      };
      delete state.closedDrafts[path];
    } catch (error) {
      toast(String(error), true);
      return;
    }
  }
  state.activeDocument = path;
  renderActiveDocument();
  requestAnimationFrame(() => layoutEditor());
  scheduleSessionSave();
}

function closeDocument(path) {
  syncDocumentFromEditor({ render: false, persist: false });
  const document = state.documents[path];
  if (!document) return;
  const model = state.editor.models.get(path);
  if (model) {
    model.dispose();
    state.editor.models.delete(path);
  }
  if (documentIsDirty(document)) {
    state.closedDrafts[path] = {
      draft_content: document.content,
      cursor_start: document.cursorStart ?? 0,
      cursor_end: document.cursorEnd ?? 0,
    };
  } else {
    delete state.closedDrafts[path];
  }
  delete state.documents[path];
  if (state.activeDocument === path) {
    const remaining = Object.keys(state.documents);
    state.activeDocument = remaining.at(-1) || null;
  }
  renderActiveDocument();
  scheduleSessionSave();
}

async function refreshProject() {
  if (state.projectStatus !== "ready") {
    renderProjectFiles();
    renderDocumentTabs();
    return;
  }
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
  const documentState = activeDocument();
  if (!documentState) return;
  syncDocumentFromEditor({ render: false, persist: false });
  try {
    state.project = await invoke("project_write_file", { path: documentState.path, content: documentState.content });
    documentState.savedContent = documentState.content;
    documentState.conflictDiskContent = null;
    delete state.closedDrafts[documentState.path];
    renderProjectFiles();
    renderDocumentTabs();
    addConsole("SYSTEM", `Saved ${documentState.path}`);
    scheduleSessionSave();
  } catch (error) {
    toast(String(error), true);
  }
}

async function createDocument() {
  if (state.projectStatus !== "ready") return;
  const name = window.prompt("New R file name", "analysis.R");
  if (!name) return;
  const path = name.replace(/^[\\/]+/, "");
  try {
    state.project = await invoke("project_create_file", { path, content: "" });
    await openDocument(path);
    scheduleSessionSave();
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

function prettyOrigin(origin) {
  if (origin === "agent") return "Agent";
  if (origin === "system") return "System";
  return "User";
}

function prettyStatus(status) {
  return {
    queued: "Queued",
    running: "Running",
    waiting: "Waiting",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
    crashed: "Crashed",
  }[status] || status || "Unknown";
}

function runStatusTone(status) {
  if (status === "completed") return "success";
  if (status === "running" || status === "queued" || status === "waiting") return "running";
  if (status === "failed" || status === "crashed") return "error";
  if (status === "interrupted" || status === "cancelled") return "warning";
  return "";
}

function runTitle(run) {
  if (run.execution_mode === "selection" && run.source_path) return `Selection · ${run.source_path}`;
  if (run.execution_mode === "line" && run.source_path) return `Line · ${run.source_path}`;
  if (run.execution_mode === "file" && run.source_path) return `File · ${run.source_path}`;
  if (run.request_type === "workspace.snapshot") return "Workspace snapshot";
  if (run.request_type === "workspace.inspect_object") return `Inspect · ${run.code_preview}`;
  if (run.request_type === "workspace.bootstrap") return "Workspace bootstrap";
  return run.code_preview || run.request_type || "Run";
}

function activeRunRecord() {
  return state.runs.find((run) => ["queued", "running", "waiting"].includes(run.status)) || null;
}

async function loadRunData() {
  try {
    const [runs, problems] = await Promise.all([
      invoke("list_runs", { limit: 50 }),
      invoke("list_problems", { limit: 50 }),
    ]);
    state.runs = runs || [];
    state.problems = problems || [];
    state.activeRunId = activeRunRecord()?.run_id || null;
    renderRuns();
    renderProblems();
  } catch (error) {
    toast(`Run history is unavailable: ${error}`, true);
  }
}

function agentStatusTone(status) {
  if (["completed", "approved"].includes(status)) return "completed";
  if (["running", "waiting", "queued"].includes(status)) return "running";
  return "error";
}

function prettyAgentMode(mode) {
  return { ask: "Ask", plan: "Plan", act: "Act" }[mode] || mode || "Agent";
}

function prettyAgentStatus(status) {
  return {
    queued: "Queued",
    running: "Running",
    waiting: "Waiting for approval",
    completed: "Completed",
    failed: "Failed",
    rejected: "Rejected",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
    stale: "Stale",
    policy_denied: "Policy denied",
    approved: "Approved",
  }[status] || status || "Unknown";
}

function truncateText(text, limit = 120) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}

function approvalLabel(approval) {
  if (!approval) return "";
  return `${approval.tool} · ${approval.request_id}`;
}

function parseApprovalArguments(argumentsJson) {
  try {
    return JSON.parse(argumentsJson || "{}");
  } catch {
    return {};
  }
}

async function loadAgentData() {
  try {
    const [turns, approvals] = await Promise.all([
      invoke("list_agent_turns", { limit: 20 }),
      invoke("list_approval_requests", { limit: 20 }),
    ]);
    state.agentTurns = turns || [];
    state.pendingApprovals = (approvals || []).filter((item) => item.status === "waiting");
    const preferredTurnId = state.selectedTurnId
      || state.pendingApprovals[0]?.turn_id
      || state.agentTurns.find((turn) => ["running", "waiting"].includes(turn.status))?.turn_id
      || state.agentTurns[0]?.turn_id
      || null;
    state.selectedTurnId = preferredTurnId;
    state.selectedTurnDetail = preferredTurnId
      ? await invoke("get_agent_turn_detail", { turn_id: preferredTurnId })
      : null;
    renderAgentTimeline();
    renderApprovalPanel();
    updateAgentHeader();
    syncAgentPolling();
  } catch (error) {
    toast(`Agent history is unavailable: ${error}`, true);
  }
}

function updateAgentHeader() {
  const latest = state.agentTurns[0] || null;
  if (state.pendingApprovals.length) {
    $("#agentState").textContent = "Waiting approval";
    $("#agentStateDot").className = "agent-state-dot busy";
    return;
  }
  if (latest && ["running", "waiting"].includes(latest.status)) {
    $("#agentState").textContent = "Working";
    $("#agentStateDot").className = "agent-state-dot busy";
    return;
  }
  if (latest?.status === "failed") {
    $("#agentState").textContent = "Failed";
    $("#agentStateDot").className = "agent-state-dot error";
    return;
  }
  if (latest?.status === "completed") {
    $("#agentState").textContent = "Completed";
    $("#agentStateDot").className = "agent-state-dot";
    return;
  }
  $("#agentState").textContent = "Ready";
  $("#agentStateDot").className = "agent-state-dot";
}

function syncAgentPolling() {
  const shouldPoll = state.agentTurns.some((turn) => ["running", "waiting"].includes(turn.status)) || state.pendingApprovals.length > 0;
  if (shouldPoll && !state.agentPollTimer) {
    state.agentPollTimer = window.setInterval(() => {
      loadAgentData().catch(() => {});
      loadRunData().catch(() => {});
    }, 1500);
  }
  if (!shouldPoll && state.agentPollTimer) {
    window.clearInterval(state.agentPollTimer);
    state.agentPollTimer = null;
  }
}

function renderAgentTimeline() {
  const panel = $("#agentTimeline");
  panel.replaceChildren();
  if (!state.agentTurns.length) {
    addTimeline("Workspace connected", "Ark session is ready for inspection and execution.", "completed");
    return;
  }
  for (const turn of state.agentTurns.slice(0, 8)) {
    const selected = state.selectedTurnId === turn.turn_id;
    const row = document.createElement("div");
    row.className = `timeline-item ${agentStatusTone(turn.status)} timeline-parent${selected ? " is-selected" : ""}`;
    row.dataset.turnId = turn.turn_id;
    const marker = document.createElement("span");
    marker.className = "timeline-marker";
    marker.textContent = agentStatusTone(turn.status) === "completed" ? "✓" : agentStatusTone(turn.status) === "error" ? "!" : "·";
    const content = document.createElement("div");
    const heading = document.createElement("strong");
    heading.textContent = `${prettyAgentMode(turn.mode)} · ${turn.prompt_preview}`;
    const paragraph = document.createElement("p");
    paragraph.textContent = `${prettyAgentStatus(turn.status)}${turn.pending_request_id ? ` · ${turn.pending_request_id}` : ""}`;
    content.append(heading, paragraph);
    const detail = truncateText(turn.error_message || turn.final_message || "", 140);
    if (detail) {
      const detailLine = document.createElement("p");
      detailLine.textContent = detail;
      content.append(detailLine);
    }
    row.append(marker, content);
    row.addEventListener("click", async () => {
      state.selectedTurnId = turn.turn_id;
      state.selectedTurnDetail = await invoke("get_agent_turn_detail", { turn_id: turn.turn_id });
      renderAgentTimeline();
      renderApprovalPanel();
      updateAgentHeader();
    });
    panel.append(row);
    if (state.selectedTurnId === turn.turn_id && state.selectedTurnDetail?.events?.length) {
      for (const event of state.selectedTurnDetail.events) {
        const child = document.createElement("div");
        child.className = `timeline-item ${agentStatusTone(event.status)} timeline-child`;
        const childMarker = document.createElement("span");
        childMarker.className = "timeline-marker";
        childMarker.textContent = agentStatusTone(event.status) === "completed" ? "✓" : agentStatusTone(event.status) === "error" ? "!" : "·";
        const childContent = document.createElement("div");
        const childHeading = document.createElement("strong");
        childHeading.textContent = event.title;
        childContent.append(childHeading);
        const meta = [];
        if (event.request_id) meta.push(event.request_id);
        if (event.tool) meta.push(event.tool);
        if (meta.length) {
          const metaLine = document.createElement("p");
          metaLine.textContent = meta.join(" · ");
          childContent.append(metaLine);
        }
        if (event.body) {
          const childBody = document.createElement("p");
          childBody.textContent = event.body;
          childContent.append(childBody);
        }
        if (event.code) {
          const source = document.createElement("code");
          source.className = "timeline-code";
          source.textContent = event.code;
          childContent.append(source);
        }
        child.append(childMarker, childContent);
        panel.append(child);
      }
    }
  }
}

function renderApprovalPanel() {
  const approval = state.pendingApprovals.find((item) => item.turn_id === state.selectedTurnId) || state.pendingApprovals[0] || null;
  $("#approvalPanel").classList.toggle("hidden", !approval);
  if (!approval) {
    $("#approvalRequestId").textContent = "request";
    $("#approvalSummary").textContent = "Review the exact tool request before Workspace R changes.";
    $("#approvalRevision").textContent = "";
    $("#approvalCode").textContent = "";
    $("#approvalCode").classList.add("hidden");
    return;
  }
  const argumentsObject = parseApprovalArguments(approval.arguments_json);
  const turn = state.agentTurns.find((item) => item.turn_id === approval.turn_id) || null;
  $("#approvalRequestId").textContent = approval.request_id;
  $("#approvalSummary").textContent = `${approval.tool} wants to mutate Workspace R in ${prettyAgentMode(turn?.mode || "act")} mode. Review the exact code before approving.`;
  const staleHint = approval.state_revision !== state.revision.state_revision
    || approval.project_revision !== state.revision.project_revision
    ? ` · current state ${state.revision.state_revision ?? "?"}/${state.revision.project_revision ?? "?"}`
    : "";
  $("#approvalRevision").textContent = `captured ${approval.workspace_id || "?"} · state ${approval.state_revision ?? "?"} · project ${approval.project_revision ?? "?"}${staleHint}`;
  const code = approval.code || argumentsObject.code || approval.arguments_json;
  $("#approvalCode").textContent = code || "";
  $("#approvalCode").classList.toggle("hidden", !code);
  $("#approvalApprove").textContent = `Approve ${approval.tool}`;
  $("#approvalReject").textContent = `Reject ${approval.tool}`;
  $("#approvalCancel").textContent = "Cancel pending";
  $("#approvalPanel").dataset.requestId = approval.request_id;
  $("#approvalPanel").dataset.label = approvalLabel(approval);
  $("#approvalApprove").onclick = () => submitApproval("approve", approval);
  $("#approvalReject").onclick = () => submitApproval("reject", approval);
  $("#approvalCancel").onclick = () => submitApproval("cancel", approval);
}

async function submitApproval(decision, approval) {
  const reason = decision === "approve"
    ? null
    : window.prompt(
      decision === "cancel" ? "Provide a cancellation note (optional)." : "Provide a rejection reason (optional).",
      "",
    ) || null;
  for (const id of ["approvalApprove", "approvalReject", "approvalCancel"]) {
    $(["#", id].join("")).disabled = true;
  }
  try {
    await invoke("respond_approval", {
      request: {
        request_id: approval.request_id,
        decision,
        reason,
      },
    });
    await Promise.all([loadAgentData(), loadRunData(), refreshEnvironment()]);
  } catch (error) {
    toast(String(error), true);
  } finally {
    for (const id of ["approvalApprove", "approvalReject", "approvalCancel"]) {
      $(["#", id].join("")).disabled = false;
    }
  }
}

function renderRuns() {
  const panel = $("#runsPanel");
  panel.replaceChildren();
  if (!state.runs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-tree";
    empty.textContent = "No run records yet.";
    panel.append(empty);
    return;
  }
  for (const run of state.runs) {
    const row = document.createElement("div");
    row.className = "run-row";
    const marker = document.createElement("span");
    marker.className = `run-state ${runStatusTone(run.status)}`.trim();
    const content = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = runTitle(run);
    const detail = document.createElement("small");
    detail.textContent = `${prettyOrigin(run.origin)} · ${prettyStatus(run.status)}${run.error_message ? ` · ${run.error_message}` : ""}`;
    content.append(title, detail);
    row.append(marker, content);
    if (["queued", "running", "waiting"].includes(run.status)) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "run-action";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", async () => {
        try {
          await invoke("cancel_run", { run_id: run.run_id });
          addConsole("SYSTEM", `Interrupt requested for ${run.run_id}`);
          await loadRunData();
        } catch (error) {
          toast(String(error), true);
        }
      });
      row.append(cancel);
    }
    panel.append(row);
  }
}

function addProblem(message, call = "", options = {}) {
  state.problems.unshift({
    run_id: options.runId || `transient_${Date.now()}`,
    parent_run_id: null,
    origin: options.origin || "system",
    status: options.status || "failed",
    message,
    call,
    traceback: options.traceback || [],
    source_path: options.sourcePath || null,
    execution_mode: options.executionMode || null,
    document_version: options.documentVersion || null,
    workspace_id: options.workspaceId || null,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  });
  renderProblems();
}

function renderProblems() {
  const list = $("#problemList");
  list.replaceChildren();
  $("#problemEmpty").classList.toggle("hidden", state.problems.length > 0);
  $("#problemCount").textContent = String(state.problems.length);
  $("#problemCount").classList.toggle("quiet", state.problems.length === 0);
  for (const problem of state.problems) {
    const row = document.createElement("div");
    row.className = "problem-row";
    const icon = document.createElement("span");
    icon.className = "problem-icon";
    icon.textContent = "!";
    const content = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = problem.message;
    const detail = document.createElement("p");
    detail.textContent = [
      problem.call,
      problem.source_path ? `Source: ${problem.source_path}` : null,
      `${prettyOrigin(problem.origin)} · ${prettyStatus(problem.status)}`,
    ].filter(Boolean).join(" · ");
    content.append(title, detail);
    const actions = document.createElement("div");
    actions.className = "problem-actions";
    const explain = document.createElement("button");
    explain.type = "button";
    explain.textContent = "Explain";
    explain.addEventListener("click", () => {
      switchContextTab("agent");
      $("#agentInput").value = `请解释这个 R 错误并给出修复建议：${problem.message}`;
      $("#agentInput").focus();
    });
    actions.append(explain);
    if (problem.run_id && !String(problem.run_id).startsWith("transient_")) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry";
      retry.addEventListener("click", async () => {
        try {
          const response = await invoke("retry_run", { run_id: problem.run_id });
          renderExecution(response, {
            type: problem.execution_mode || "file",
            sourcePath: problem.source_path,
            documentVersion: problem.document_version,
          }, prettyOrigin(problem.origin).toUpperCase());
          await refreshEnvironment();
          await loadRunData();
        } catch (error) {
          addProblem(String(error));
          toast(String(error), true);
        }
      });
      actions.append(retry);
    }
    if (problem.source_path) {
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "Open Source";
      open.addEventListener("click", async () => {
        await openDocument(problem.source_path);
      });
      actions.append(open);
    }
    row.append(icon, content, actions);
    list.append(row);
  }
}

function describeExecution(request) {
  if (!request) return "Code";
  if (request.type === "console") return "Console";
  if (request.type === "selection") return `Selection · ${request.sourcePath}`;
  if (request.type === "line") return `Line ${request.line} · ${request.sourcePath}`;
  return `File · ${request.sourcePath} · rev ${request.documentVersion ?? 0}`;
}

function renderExecution(response, request, origin = "USER") {
  const execution = response.execution || {};
  updateIdentity(response.workspace);
  if (request?.sourcePath) {
    addConsole("SOURCE", describeExecution(request));
  }
  addConsole(origin, execution.stdout);
  (execution.messages || []).forEach((message) => addConsole(origin, message));
  (execution.warnings || []).forEach((warning) => addConsole(origin, warning, "warning"));
  if (execution.value) addConsole(origin, execution.value);
  if (execution.error) {
    addConsole(origin, execution.error.message, "error");
  }
  for (const wrapped of response.events || []) {
    const event = wrapped.event || wrapped;
    if (event.type === "stream") addConsole(origin, event.text, event.name === "stderr" ? "error" : "");
    if (event.type === "error") addConsole(origin, event.traceback || "R execution failed", "error");
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

async function executeCode(request, origin = "USER") {
  if (state.busy || !request?.code?.trim()) return;
  setBusy(true);
  addConsole(origin, `> ${request.code}`);
  try {
    const response = await invoke("execute_r", {
      request: {
        code: request.code,
        source_path: request.sourcePath ?? null,
        execution_mode: request.type ?? null,
        document_version: request.documentVersion ?? null,
      },
    });
    const documentState = activeDocument();
    if (documentState && request.type !== "console") documentState.lastExecutedRange = request.range || null;
    renderExecution(response, request, origin);
    await refreshEnvironment();
  } catch (error) {
    const message = String(error);
    addConsole("SYSTEM", message, "error");
    addProblem(message);
    toast(message, true);
  } finally {
    await loadRunData();
    setBusy(false);
  }
}

async function runSelectionOrCurrentLine() {
  const request = selectionExecution() || currentLineExecution();
  if (!request) {
    toast("Current line is empty.", true);
    return;
  }
  await executeCode(request);
}

async function runActiveFile() {
  const request = fileExecution();
  if (!request) {
    toast("File has no executable content.", true);
    return;
  }
  await executeCode(request);
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
  if (!prompt || state.agentBusy) return;
  $("#agentInput").value = "";
  state.agentBusy = true;
  switchContextTab("agent");
  $("#agentSendButton").disabled = true;
  $("#agentInput").disabled = true;
  $$("[data-agent-mode]").forEach((button) => { button.disabled = true; });
  $("#agentState").textContent = "Working";
  $("#agentStateDot").className = "agent-state-dot busy";
  try {
    await invoke("run_agent", {
      prompt,
      mode: state.agentMode,
      model: "deepseek:deepseek-v4-flash",
    });
    await Promise.all([loadAgentData(), loadRunData()]);
  } catch (error) {
    const message = String(error);
    $("#agentState").textContent = "Failed";
    $("#agentStateDot").className = "agent-state-dot error";
    toast(message, true);
  } finally {
    state.agentBusy = false;
    $("#agentSendButton").disabled = false;
    $("#agentInput").disabled = false;
    $$("[data-agent-mode]").forEach((button) => { button.disabled = false; });
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
  if (persist) {
    if (!isDesktop) localStorage.setItem(`rho.panel.${panel}`, String(value));
    scheduleSessionSave();
  }
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
    const stored = !isDesktop ? Number(localStorage.getItem(`rho.panel.${panel}`)) : NaN;
    setPanelSize(panel, Number.isFinite(stored) && stored > 0 ? stored : panelDefaults[panel], false);
  }
  setupPanelResizer($("#leftResizeHandle"), "left");
  setupPanelResizer($("#rightResizeHandle"), "right");
  setupPanelResizer($("#dockResizeHandle"), "dock");
}

function applySessionPanels(panels = {}) {
  setPanelSize("left", panels.left || panelDefaults.left, false);
  setPanelSize("right", panels.right || panelDefaults.right, false);
  setPanelSize("dock", panels.dock || panelDefaults.dock, false);
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

function toast(message, error = false) {
  const element = document.createElement("div");
  element.className = `toast ${error ? "error" : ""}`;
  element.textContent = message;
  $("#toastRegion").append(element);
  setTimeout(() => element.remove(), 4500);
}

async function listenForProjectChanges() {
  if (!isDesktop || !tauriEvent?.listen || state.watcherUnlisten) return;
  state.watcherUnlisten = await tauriEvent.listen("project://files-changed", async (event) => {
    const payload = event.payload || {};
    if (payload.root && payload.root !== state.project.root) return;
    await refreshProject();
    for (const path of payload.changed_paths || []) {
      await handleExternalDocumentChange(path);
    }
  });
}

async function handleExternalDocumentChange(path) {
  const document = state.documents[path];
  if (!document) return;
  try {
    const result = await invoke("project_read_file", { path });
    const diskContent = result.content || "";
    if (!documentIsDirty(document)) {
      document.savedContent = diskContent;
      document.content = diskContent;
      if (state.activeDocument === path) renderActiveDocument();
      toast(`Reloaded ${path} after an external change.`);
      scheduleSessionSave();
      return;
    }
    document.conflictDiskContent = diskContent;
    const reload = window.confirm(
      `${path} changed on disk while you have unsaved edits.\n\nOK reloads the disk version.\nCancel keeps your local draft.`
    );
    if (reload) {
      document.savedContent = diskContent;
      document.content = diskContent;
      document.conflictDiskContent = null;
      if (state.activeDocument === path) renderActiveDocument();
      toast(`Reloaded ${path} from disk.`);
    } else {
      toast(`Kept your local draft for ${path}.`);
    }
    renderProjectFiles();
    renderDocumentTabs();
    scheduleSessionSave();
  } catch (error) {
    toast(`External change detected for ${path}, but reloading failed: ${error}`, true);
  }
}

async function hydrateProject(response) {
  state.documents = {};
  state.closedDrafts = {};
  state.activeDocument = null;
  state.editor.models.forEach((model) => model.dispose());
  state.editor.models.clear();
  state.project = response.project || { root: "", files: [] };
  applySessionPanels(response.session?.panels || {});
  setProjectStatus("ready");
  const sessionDocuments = response.session?.open_documents || [];
  const activeDocumentPath = response.session?.active_document;
  for (const entry of sessionDocuments) {
    await openDocument(entry.path, { sessionEntry: entry });
  }
  const target = activeDocumentPath && state.project.files.some((file) => file.path === activeDocumentPath)
    ? activeDocumentPath
    : sessionDocuments[0]?.path || state.project.files[0]?.path || null;
  if (target) {
    await openDocument(target, {
      sessionEntry: sessionDocuments.find((entry) => entry.path === target) || null,
    });
  } else {
    renderActiveDocument();
  }
}

async function initialize() {
  initializePanelLayout();
  try {
    await initializeEditor();
    await listenForProjectChanges();
    const status = await invoke("workspace_start");
    updateIdentity(status.workspace);
    $("#rVersion").textContent = status.r_version || "R";
    setKernelStatus("idle", "R idle");
    addConsole("SYSTEM", `${status.r_version} · Ark PID ${status.kernel_pid}`);
    const response = await invoke("project_restore_session");
    if (response.status === "ready") {
      await hydrateProject(response);
    } else if (response.status === "unavailable") {
      state.project = { root: "", files: [] };
      state.documents = {};
      state.activeDocument = null;
      applySessionPanels(panelDefaults);
      setProjectStatus("unavailable", response.unavailable || null);
      renderActiveDocument();
    } else {
      setProjectStatus("empty");
      renderActiveDocument();
    }
    await loadRunData();
    await loadAgentData();
    await refreshEnvironment();
    if (isDesktop && tauriEvent?.listen) {
      tauriEvent.listen("rho://agent-turn-updated", async () => {
        await Promise.all([loadAgentData(), loadRunData(), refreshEnvironment()]);
      }).catch(() => {});
    }
  } catch (error) {
    setKernelStatus("error", "R unavailable");
    addConsole("SYSTEM", String(error), "error");
    addProblem(String(error));
    toast(String(error), true);
  }
}

$("#runButton").addEventListener("click", runSelectionOrCurrentLine);
$("#editorRunButton").addEventListener("click", runSelectionOrCurrentLine);
$("#editorRunFileButton").addEventListener("click", runActiveFile);
$("#saveFileButton").addEventListener("click", saveActiveDocument);
$(".new-tab").addEventListener("click", createDocument);
$("#projectSwitcher").addEventListener("click", async () => {
  try {
    await flushSessionSnapshot();
    const response = await invoke("project_pick_directory");
    if (response.status === "cancelled") return;
    if (response.status === "unavailable") {
      setProjectStatus("unavailable", response.unavailable || null);
      renderActiveDocument();
      return;
    }
    await hydrateProject(response);
  } catch (error) {
    toast(String(error), true);
  }
});
$("#projectBannerAction").addEventListener("click", () => $("#projectSwitcher").click());
$("#consoleRunButton").addEventListener("click", () => {
  const value = $("#consoleInput").value;
  $("#consoleInput").value = "";
  executeCode({ code: value, type: "console", sourcePath: "<console>", documentVersion: null, range: null });
});
$("#consoleInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    $("#consoleRunButton").click();
  }
});
$("#editor").addEventListener("input", () => {
  syncDocumentFromEditor({ render: true, persist: true });
  updateEditorChrome();
});
$("#editor").addEventListener("click", () => {
  syncDocumentFromEditor({ render: false, persist: true });
  updateEditorChrome();
});
$("#editor").addEventListener("keyup", () => {
  syncDocumentFromEditor({ render: false, persist: true });
  updateEditorChrome();
});
$("#editor").addEventListener("scroll", () => { $("#lineNumbers").scrollTop = $("#editor").scrollTop; });
window.addEventListener("beforeunload", () => {
  if (state.agentPollTimer) window.clearInterval(state.agentPollTimer);
  flushSessionSnapshot().catch(() => {});
});
$("#editor").addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveActiveDocument();
    return;
  }
  if (event.ctrlKey && event.shiftKey && event.key === "Enter") {
    event.preventDefault();
    runActiveFile();
    return;
  }
  if (event.ctrlKey && event.key === "Enter") {
    event.preventDefault();
    runSelectionOrCurrentLine();
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    const editor = event.currentTarget;
    const start = editor.selectionStart;
    editor.setRangeText("  ", start, editor.selectionEnd, "end");
    updateEditorChrome();
    syncDocumentFromEditor({ render: true, persist: true });
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
  layoutEditor();
});
$("#interruptButton").addEventListener("click", async () => {
  try {
    const response = state.activeRunId
      ? await invoke("cancel_run", { run_id: state.activeRunId })
      : await invoke("interrupt_r");
    addConsole("SYSTEM", "Interrupt requested");
    if (response?.run_id) state.activeRunId = response.run_id;
    await loadRunData();
  } catch (error) {
    toast(String(error), true);
  }
});
$("#restartButton").addEventListener("click", async () => {
  setKernelStatus("starting", "Restarting R…");
  try {
    await flushSessionSnapshot();
    const status = await invoke("restart_workspace");
    updateIdentity(status.workspace);
    setKernelStatus("idle", "R idle");
    state.objects = [];
    renderEnvironment();
    addConsole("SYSTEM", `Workspace restarted · Ark PID ${status.kernel_pid}`);
    await loadRunData();
  } catch (error) {
    setKernelStatus("error", "R unavailable");
    toast(String(error), true);
  }
});

initialize();
