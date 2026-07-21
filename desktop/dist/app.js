const tauriInvoke = window.__TAURI__?.core?.invoke;
const isDesktop = typeof tauriInvoke === "function";
const tauriEvent = window.__TAURI__?.event;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const initialEditorContent = $("#editor")?.value || "";

const state = {
  busy: false,
  agentMode: "ask",
  actAutoApprove: false,
  agentBusy: false,
  activeAgentTurnId: null,
  agentRuntime: null,
  agentLlm: {
    settings: null,
    selectedModelId: null,
    selectorOpen: false,
    settingsOpen: false,
    selectedProviderId: null,
    editingProviderId: null,
    selectedModelEditorId: null,
    editingModelId: null,
    lastTestResult: null,
    testInFlight: false,
    catalog: [],
    catalogLoaded: false,
  },
  objects: [],
  plots: [],
  plotScope: "session",
  environment: null,
  selectedObjectName: null,
  selectedObjectDetail: null,
  lastRender: null,
  runs: [],
  problems: [],
  agentTurns: [],
  pendingApprovals: [],
  selectedTurnId: null,
  selectedTurnDetail: null,
  fileEditProposal: null,
  fileEditUndo: null,
  fileEditDecisions: new Map(),
  agentFileMention: { items: [], index: 0, start: -1, end: -1, mode: "mention", contextSource: null },
  agentContextSource: "editor",
  agentContextPath: null,
  agentPollTimer: null,
  activeRunId: null,
  agentConsoleHydrated: false,
  renderedAgentRunIds: new Set(),
  revision: { state_revision: 1, project_revision: 0 },
  projectStatus: "loading",
  unavailable: null,
  project: { root: "", files: [], truncated: false },
  expandedDirectories: new Set(),
  collapsedDirectories: new Set(),
  documents: {},
  closedDrafts: {},
  internalProjectWrites: new Map(),
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
    highlightDecorations: [],
  },
};

const mockProjects = {
  "D:/Rho": {
    files: [
      { path: "analysis.R", name: "analysis.R", kind: "source", size_bytes: 120 },
      { path: "report.Rmd", name: "report.Rmd", kind: "source", size_bytes: 92 },
      { path: "report.qmd", name: "report.qmd", kind: "source", size_bytes: 96 },
      { path: "scratch.R", name: "scratch.R", kind: "source", size_bytes: 420 },
    ],
    contents: {
      "analysis.R": "# Project analysis\nsummary(qc)\n",
      "report.Rmd": "---\ntitle: QC report\noutput: html_document\n---\n\n```{r}\nsummary(qc)\n```\n",
      "report.qmd": "---\ntitle: QC report\nformat: html\n---\n\n```{r}\nsummary(qc)\n```\n",
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
const mockPlots = [];
let mockAgentTurnSequence = 0;
let mockApprovalSequence = 0;
const mockAgentTurns = [];
const mockApprovalRequests = [];
let mockAgentLlmSettings = defaultMockAgentLlmSettingsView();

function slugifyAgentId(value, fallback = "item") {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function uniqueAgentId(prefix, label, values) {
  const existing = new Set(values || []);
  const stem = `${prefix}-${slugifyAgentId(label, prefix)}`;
  let candidate = stem;
  let index = 2;
  while (existing.has(candidate)) {
    candidate = `${stem}-${index}`;
    index += 1;
  }
  return candidate;
}

function mockEffectiveModelRef(provider, model) {
  if (!provider || !model) return model?.model_id || "unknown";
  if (provider.kind === "registered") {
    return `${provider.registered_provider_id || "provider"}:${model.model_id}`;
  }
  const runtimeProviderId = `rho_profile_provider_${provider.id.replace(/[^a-z0-9]/gi, "_")}`;
  return `${runtimeProviderId}:${model.model_id}`;
}

function mockSelectorStatus(model, provider) {
  if (!model.enabled) return "Disabled";
  if (provider?.credential_status === "not_detected" && provider.api_key_required) return "Key missing";
  if (model.last_test?.status === "ready") return "Ready";
  if (model.last_test?.status === "error") return "Error";
  return "Untested";
}

function rebuildMockAgentLlmSettings(settings = mockAgentLlmSettings) {
  const providerMap = new Map((settings.providers || []).map((provider) => [provider.id, provider]));
  settings.providers = (settings.providers || []).map((provider) => ({
    ...provider,
    credential_status: provider.credential_status || (provider.api_key_required ? "not_detected" : "not_required"),
  }));
  settings.models = (settings.models || []).map((model) => {
    const provider = providerMap.get(model.provider_id);
    const selectorStatus = mockSelectorStatus(model, provider);
    return {
      ...model,
      provider_display_name: provider?.display_name || "Provider",
      selected: model.id === settings.selected_model_id,
      selector_status: selectorStatus,
      act_enabled: Boolean(model.enabled && model.capabilities?.tool_calling === "yes"),
    };
  });
  const selected = settings.models.find((model) => model.id === settings.selected_model_id) || null;
  settings.selected_model = selected
    ? {
      id: selected.id,
      display_name: selected.display_name,
      provider_display_name: selected.provider_display_name,
      selector_status: selected.selector_status,
      tool_calling: selected.capabilities?.tool_calling || "unknown",
      act_enabled: selected.act_enabled,
    }
    : null;
  return settings;
}

function defaultMockAgentLlmSettingsView() {
  const settings = {
    schema_version: 1,
    selected_model_id: "model-deepseek-v4-flash",
    providers: [
      {
        id: "provider-deepseek-existing",
        display_name: "DeepSeek",
        kind: "registered",
        registered_provider_id: "deepseek",
        api_key_env: "DEEPSEEK_API_KEY",
        api_key_required: true,
        base_url: null,
        base_url_env: null,
        wire_api: null,
        disable_stream_options: null,
        credential_status: "detected",
      },
    ],
    models: [
      {
        id: "model-deepseek-v4-flash",
        provider_id: "provider-deepseek-existing",
        display_name: "DeepSeek V4 Flash",
        model_id: "deepseek-v4-flash",
        enabled: true,
        capabilities: {
          tool_calling: "yes",
          reasoning: "yes",
          vision_input: "no",
          source: "catalog",
        },
        last_test: {
          status: "ready",
          checked_at: new Date().toISOString(),
          latency_ms: 842,
          error_class: null,
          message: "Connection succeeded.",
        },
        provider_display_name: "DeepSeek",
        selected: true,
        selector_status: "Ready",
        act_enabled: true,
      },
      {
        id: "model-chat-only-demo",
        provider_id: "provider-deepseek-existing",
        display_name: "Chat-only Demo",
        model_id: "deepseek-chat-demo",
        enabled: true,
        capabilities: {
          tool_calling: "no",
          reasoning: "unknown",
          vision_input: "no",
          source: "declared",
        },
        last_test: null,
        provider_display_name: "DeepSeek",
        selected: false,
        selector_status: "Untested",
        act_enabled: false,
      },
    ],
    selected_model: null,
    user_environ: {
      path: "C:/Users/demo/.Renviron",
      source: "default",
    },
    validation_error: null,
  };
  return rebuildMockAgentLlmSettings(settings);
}

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

function createMockAgentTurn({ prompt, mode, model, editorContext = null }) {
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
        details_json: JSON.stringify({ prompt, mode, editor_context: editorContext }),
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
  } else if (prompt.includes("@")) {
    const match = prompt.match(/@(?:"([^"]+)"|([^\s，。]+))/);
    const path = match?.[1] || match?.[2] || editorContext?.active_path || "analysis.R";
    const operation = /追加|append/i.test(prompt)
      ? "append"
      : /新建|create/i.test(prompt)
        ? "create"
        : editorContext?.selection_end > editorContext?.selection_start
          ? "replace_selection"
          : "insert_at_cursor";
    const proposal = {
      kind: "rho.file_edit_proposal",
      path,
      operation,
      content: "# Proposed by Rho\nsummary(qc)\n",
    };
    const text = `已为 ${path} 创建编辑提案，请在应用前检查差异。`;
    turn.final_message = text;
    turn.events.push(
      {
        id: 3,
        turn_id: turn.turn_id,
        timestamp: startedAt,
        event_type: "tool.call_started",
        title: "Tool · propose_file_edit",
        body: "Preparing a reviewable file edit.",
        status: "running",
        tool: "propose_file_edit",
        request_id: null,
        code: null,
        details_json: "{}",
      },
      {
        id: 4,
        turn_id: turn.turn_id,
        timestamp: startedAt,
        event_type: "tool.call_completed",
        title: "Tool completed · propose_file_edit",
        body: JSON.stringify(proposal),
        status: "completed",
        tool: "propose_file_edit",
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
  return { root, files: project.files.map((file) => ({ ...file })), truncated: false };
}

function mockEnvironmentSnapshot() {
  return {
    execution: {
      ok: true,
      objects: state.objects,
      r: {
        version: "R version 4.6.0",
        cwd: mockLastProject,
        lib_paths: ["D:/R/library", "C:/R/site-library"],
      },
      environment: {
        project_dir: mockLastProject,
        renv: {
          status: "present",
          has_lockfile: false,
          lockfile_path: null,
          package_available: true,
          project_library: `${mockLastProject}/renv`,
          active: false,
        },
        bioconductor: {
          status: "available",
          version: "3.22",
          package_available: true,
        },
        attached_packages: {
          values: [
            { name: "stats", version: "4.6.0" },
            { name: "utils", version: "4.6.0" },
          ],
          truncated: false,
        },
        render: {
          quarto: { available: false, binary: null },
          rmarkdown: { available: true, version: "2.30" },
          knitr: { available: true, version: "1.50" },
          can_render_qmd: false,
          can_render_rmd: true,
        },
      },
    },
    workspace: state.revision,
  };
}

function updateLastRender(result) {
  state.lastRender = result ? { ...result } : null;
}

function activeDocumentCanRender() {
  return Boolean(state.activeDocument && /\.(rmd|qmd)$/i.test(state.activeDocument));
}

function renderDocumentHintText() {
  if (!state.activeDocument) return "Open an `.Rmd` or `.qmd` document to render.";
  if (!activeDocumentCanRender()) return `Current document \`${state.activeDocument}\` is not renderable.`;
  if (documentIsDirty(activeDocument())) return `Save \`${state.activeDocument}\` before rendering.`;
  return `Ready to render \`${state.activeDocument}\`.`;
}

function latestRenderProblem() {
  if (!state.lastRender?.sourcePath) return null;
  return state.problems.find((problem) => problem.execution_mode === "render" && problem.source_path === state.lastRender.sourcePath) || null;
}

function mockInspectObject(name) {
  if (name === "qc") {
    return {
      execution: {
        ok: true,
        name,
        classes: ["data.frame"],
        dimensions: [12, 3],
        size_bytes: 2184,
        typeof: "list",
        preview_kind: "tabular",
        preview: {
          kind: "tabular",
          columns: { values: ["sample", "reads", "detected"], truncated: false },
          column_types: { sample: "character", reads: "numeric", detected: "numeric" },
          rows: [
            { sample: "S1", reads: 70231, detected: 3188 },
            { sample: "S2", reads: 74412, detected: 3240 },
            { sample: "S3", reads: 69103, detected: 3112 },
          ],
          truncated_rows: true,
          truncated_columns: false,
        },
        structure: "'data.frame': 12 obs. of  3 variables:\n $ sample  : chr  \"S1\" \"S2\" \"S3\" ...\n $ reads   : num  70231 74412 69103 ...\n $ detected: num  3188 3240 3112 ...",
      },
      workspace: state.revision,
    };
  }
  return {
    execution: {
      ok: true,
      name,
      classes: ["numeric"],
      dimensions: null,
      size_bytes: 96,
      typeof: "integer",
      preview_kind: "vector",
      preview: {
        kind: "vector",
        values: [1, 2, 3, 4, 5],
        truncated: false,
      },
      structure: " int [1:5] 1 2 3 4 5",
    },
    workspace: state.revision,
  };
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
      agent_runtime: { available: true, aisdk_version: "1.5.0", error: null },
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
  if (command === "project_mark_files_changed") {
    state.revision.project_revision += 1;
    return structuredClone(state.revision);
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
    state.revision.project_revision += 1;
    updateIdentity(state.revision);
    return mockInvoke("project_state", {});
  }
  if (command === "project_delete_file") {
    const project = mockProjects[mockLastProject] || mockProjects["D:/Rho"];
    delete project.contents[args.path];
    project.files = project.files.filter((file) => file.path !== args.path);
    state.revision.project_revision += 1;
    updateIdentity(state.revision);
    return mockInvoke("project_state", {});
  }
  if (command === "snapshot_workspace") {
    return mockEnvironmentSnapshot();
  }
  if (command === "inspect_object") {
    return mockInspectObject(args.request?.name || args.name || "qc");
  }
  if (command === "execute_r") {
    const request = args.request || {};
    state.revision.state_revision += 1;
    state.objects = [
      { name: "qc", classes: ["data.frame"], dimensions: [12, 3], size_bytes: 2184, typeof: "list" },
    ];
    const run = recordMockRun({
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
    if (!request.code?.includes("stop(")) {
      mockPlots.unshift({
        plot_id: `plot_${run.run_id}`,
        run_id: run.run_id,
        project_root: mockLastProject,
        source_path: request.source_path ?? request.sourcePath ?? null,
        execution_mode: request.execution_mode ?? request.type ?? null,
        document_version: request.document_version ?? request.documentVersion ?? null,
        workspace_id: "desktop_mock",
        state_revision: state.revision.state_revision,
        project_revision: state.revision.project_revision,
        media_type: "rho/mock-image",
        payload_json: JSON.stringify({ "rho/mock-image": "assets/demo-plot.png" }),
        provenance_complete: Boolean(request.source_path ?? request.sourcePath ?? null),
        created_at: new Date().toISOString(),
      });
    }
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
  if (command === "list_plot_artifacts") {
    const plots = mockPlots.filter((plot) =>
      plot.project_root === mockLastProject
      && (!args.session_only || plot.workspace_id === "desktop_mock")
    );
    return structuredClone(plots.slice(0, args.limit || 50));
  }
  if (command === "clear_plot_artifacts") {
    const before = mockPlots.length;
    for (let index = mockPlots.length - 1; index >= 0; index -= 1) {
      const plot = mockPlots[index];
      if (plot.project_root !== mockLastProject) continue;
      if (args.session_only && plot.workspace_id !== "desktop_mock") continue;
      mockPlots.splice(index, 1);
    }
    return { deleted: before - mockPlots.length };
  }
  if (command === "list_problems") {
    return structuredClone(mockProblemList().slice(0, args.limit || 50));
  }
  if (command === "render_document") {
    const path = args.request?.path || "analysis.Rmd";
    const sourcePath = path;
    const isQmd = path.toLowerCase().endsWith(".qmd");
    if (isQmd) {
      const run = recordMockRun({
        origin: "user",
        status: "failed",
        requestType: "workspace.render_document",
        operationClass: "project_mutation",
        code: `render ${path}`,
        sourcePath,
        executionMode: "render",
        documentVersion: args.request?.document_version ?? null,
        errorMessage: "Quarto is not available in the current environment.",
      });
      return {
        execution_id: run.run_id,
        execution: {
          ok: false,
          kind: "render",
          tool: "quarto",
          capability: mockEnvironmentSnapshot().execution.environment.render,
          error: { message: "Quarto is not available in the current environment.", phase: "capability", tool: "quarto" },
          stdout: "",
        },
        events: [],
        workspace: state.revision,
      };
    }
    const run = recordMockRun({
      origin: "user",
      status: "completed",
      requestType: "workspace.render_document",
      operationClass: "project_mutation",
      code: `render ${path}`,
      sourcePath,
      executionMode: "render",
      documentVersion: args.request?.document_version ?? null,
    });
    return {
      execution_id: run.run_id,
      execution: {
        ok: true,
        kind: "render",
        tool: "rmarkdown",
        source_path: sourcePath,
        output_path: sourcePath.replace(/\.Rmd$/i, ".html"),
        stdout: "Output created.",
        messages: [],
        warnings: [],
        error: null,
      },
      events: [],
      workspace: state.revision,
    };
  }
  if (command === "get_run_detail") {
    const runId = args.runId ?? args.run_id;
    return structuredClone(mockRuns.find((run) => run.run_id === runId) || null);
  }
  if (command === "retry_run") {
    const runId = args.runId ?? args.run_id;
    const detail = mockRuns.find((run) => run.run_id === runId);
    if (!detail) throw new Error(`Run not found: ${runId}`);
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
    const runId = args.runId ?? args.run_id;
    const active = runId
      ? mockRuns.find((run) => run.run_id === runId)
      : mockRuns.find((run) => ["queued", "running", "waiting"].includes(run.status));
    if (active) {
      active.status = "interrupted";
      active.terminal_reason = "user_interrupt";
      active.finished_at = new Date().toISOString();
    }
    return { status: "interrupt_requested", run_id: active?.run_id || null };
  }
  if (command === "agent_llm_settings" || command === "agent_llm_refresh_credentials") {
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "agent_llm_open_user_environ") {
    return structuredClone(mockAgentLlmSettings.user_environ);
  }
  if (command === "agent_llm_catalog") {
    return [
      {
        provider: "openai",
        id: "gpt-4.1-mini",
        display_name: "GPT-4.1 Mini",
        description: "OpenAI catalog entry",
        capabilities: { tool_calling: "yes", reasoning: "yes", vision_input: "no", source: "catalog" },
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4",
        display_name: "Claude Sonnet 4",
        description: "Anthropic catalog entry",
        capabilities: { tool_calling: "yes", reasoning: "yes", vision_input: "yes", source: "catalog" },
      },
    ];
  }
  if (command === "agent_llm_save_provider") {
    const provider = structuredClone(args.provider || {});
    const index = mockAgentLlmSettings.providers.findIndex((item) => item.id === provider.id);
    provider.credential_status = provider.api_key_required ? "not_detected" : "not_required";
    if (index >= 0) mockAgentLlmSettings.providers[index] = provider;
    else mockAgentLlmSettings.providers.push(provider);
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "agent_llm_delete_provider") {
    const providerId = args.providerId ?? args.provider_id;
    if (mockAgentLlmSettings.models.some((model) => model.provider_id === providerId)) {
      throw new Error("Delete the provider's models before removing the provider.");
    }
    mockAgentLlmSettings.providers = mockAgentLlmSettings.providers.filter((provider) => provider.id !== providerId);
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "agent_llm_save_model") {
    const model = structuredClone(args.model || {});
    const index = mockAgentLlmSettings.models.findIndex((item) => item.id === model.id);
    if (index >= 0) mockAgentLlmSettings.models[index] = model;
    else mockAgentLlmSettings.models.push(model);
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "agent_llm_delete_model") {
    const request = args.request || {};
    const modelId = request.modelId ?? request.model_id;
    const replacementModelId = request.replacementModelId ?? request.replacement_model_id;
    if (mockAgentLlmSettings.selected_model_id === modelId) {
      if (!replacementModelId) throw new Error("Select another enabled model before deleting the current default.");
      mockAgentLlmSettings.selected_model_id = replacementModelId;
    }
    mockAgentLlmSettings.models = mockAgentLlmSettings.models.filter((model) => model.id !== modelId);
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "agent_llm_select_model") {
    const request = args.request || {};
    const modelId = request.modelId ?? request.model_id;
    mockAgentLlmSettings.selected_model_id = modelId;
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "agent_llm_test_model") {
    const modelId = args.modelId ?? args.model_id;
    const model = mockAgentLlmSettings.models.find((item) => item.id === modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);
    model.last_test = {
      status: "ready",
      checked_at: new Date().toISOString(),
      latency_ms: 420,
      error_class: null,
      message: "Connection succeeded.",
    };
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "run_agent") {
    const selectedModelId = args.modelId ?? args.model_id ?? mockAgentLlmSettings.selected_model_id;
    const modelProfile = mockAgentLlmSettings.models.find((item) => item.id === selectedModelId)
      || mockAgentLlmSettings.models.find((item) => item.id === mockAgentLlmSettings.selected_model_id)
      || null;
    const providerProfile = modelProfile
      ? mockAgentLlmSettings.providers.find((item) => item.id === modelProfile.provider_id)
      : null;
    const turn = createMockAgentTurn({
      prompt: args.prompt || "",
      mode: args.mode || "ask",
      model: modelProfile ? mockEffectiveModelRef(providerProfile, modelProfile) : "deepseek:deepseek-v4-flash",
      editorContext: args.editorContext || null,
    });
    return { status: "started", turn_id: turn.turn_id };
  }
  if (command === "cancel_agent_turn") {
    const turnId = args.turnId ?? args.turn_id;
    const turn = mockAgentTurns.find((item) => item.turn_id === turnId);
    if (!turn || !["running", "waiting"].includes(turn.status)) {
      throw new Error(`Agent turn is not active: ${turnId}`);
    }
    turn.status = "interrupted";
    turn.finished_at = new Date().toISOString();
    turn.error_message = "Agent turn cancelled by the user.";
    for (const approval of mockApprovalRequests.filter((item) => item.turn_id === turn.turn_id && item.status === "waiting")) {
      approval.status = "interrupted";
      approval.decision = "cancel";
      approval.reason = "Agent turn cancelled by the user.";
      approval.continuation_outcome = "user_cancelled";
      approval.responded_at = turn.finished_at;
    }
    return { status: "cancelled", turn_id: turn.turn_id };
  }
  if (command === "list_agent_turns") {
    return structuredClone(mockAgentTurns.slice(0, args.limit || 50).map(mockTurnSummary));
  }
  if (command === "clear_agent_history") {
    const deleted = mockAgentTurns.length;
    mockAgentTurns.splice(0, mockAgentTurns.length);
    mockApprovalRequests.splice(0, mockApprovalRequests.length);
    return { deleted };
  }
  if (command === "list_approval_requests") {
    const filtered = (mockApprovalRequests || []).filter((item) => !args.status || item.status === args.status);
    return structuredClone(filtered.slice(0, args.limit || 50));
  }
  if (command === "get_agent_turn_detail") {
    const turnId = args.turnId ?? args.turn_id;
    const turn = mockAgentTurns.find((item) => item.turn_id === turnId);
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
  const keywords = [
    "if", "else", "repeat", "while", "function", "for", "in", "next", "break",
    "return", "TRUE", "FALSE", "NULL", "NA", "Inf", "NaN",
  ];
  const functions = [
    "c", "list", "data.frame", "matrix", "factor", "summary", "head", "tail",
    "str", "names", "nrow", "ncol", "dim", "length", "class", "typeof", "print",
    "message", "warning", "stop", "plot", "hist", "boxplot", "library", "require",
    "requireNamespace", "source", "setwd", "getwd", "read.csv", "write.csv",
    "readRDS", "saveRDS", "Sys.getenv",
  ];
  monaco.languages.registerCompletionItemProvider("r", {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
      const keywordSuggestions = keywords.map((label) => ({
        label,
        kind: monaco.languages.CompletionItemKind.Keyword,
        insertText: label,
        range,
        sortText: `1-${label}`,
      }));
      const functionSuggestions = functions.map((label) => ({
        label,
        kind: monaco.languages.CompletionItemKind.Function,
        insertText: `${label}($0)`,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range,
        sortText: `2-${label}`,
        detail: "R function",
      }));
      const objectSuggestions = state.objects.slice(0, 200).map((object) => ({
        label: object.name,
        kind: monaco.languages.CompletionItemKind.Variable,
        insertText: object.name,
        range,
        sortText: `0-${object.name}`,
        detail: (object.classes || []).join("/") || object.typeof || "Workspace object",
      }));
      return { suggestions: [...objectSuggestions, ...keywordSuggestions, ...functionSuggestions] };
    },
  });
  monaco.languages.registerDocumentSymbolProvider("r", {
    provideDocumentSymbols(model) {
      const symbols = [];
      for (let index = 0; index < Math.min(model.getLineCount(), 5_000); index += 1) {
        const lineNumber = index + 1;
        const text = model.getLineContent(lineNumber);
        const match = text.match(/^\s*([A-Za-z.][\w.]*)\s*(?:<-|=)\s*(function\s*\()?/);
        if (!match) continue;
        const name = match[1];
        const startColumn = text.indexOf(name) + 1;
        const range = new monaco.Range(lineNumber, 1, lineNumber, text.length + 1);
        symbols.push({
          name,
          detail: match[2] ? "R function" : "R object",
          kind: match[2]
            ? monaco.languages.SymbolKind.Function
            : monaco.languages.SymbolKind.Variable,
          range,
          selectionRange: new monaco.Range(
            lineNumber,
            startColumn,
            lineNumber,
            startColumn + name.length,
          ),
        });
      }
      return symbols;
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
  renderEnvironmentSummary();
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
      clearAgentEditHighlight();
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
    const text = normalizeExecutableCode(model.getValueInRange(selection));
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
  const text = normalizeExecutableCode(editor.value.slice(editor.selectionStart, editor.selectionEnd));
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
    closed_documents: Object.entries(state.closedDrafts).map(([path, draft]) => ({
      path,
      cursor_start: draft.cursor_start ?? 0,
      cursor_end: draft.cursor_end ?? 0,
      draft_content: draft.draft_content ?? null,
    })),
    active_document: state.activeDocument,
    panels: currentPanelSnapshot(),
  };
}

function emergencySessionKey(root = state.project.root) {
  return root ? `rho.project-session:${root}` : null;
}

function persistEmergencySession() {
  const key = emergencySessionKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      saved_at: Date.now(),
      snapshot: buildSessionSnapshot(),
    }));
  } catch {
    // The broker-backed session remains authoritative when browser storage is unavailable.
  }
}

function loadEmergencySession(root) {
  const key = emergencySessionKey(root);
  if (!key) return null;
  try {
    return JSON.parse(localStorage.getItem(key) || "null")?.snapshot || null;
  } catch {
    return null;
  }
}

function scheduleSessionSave() {
  if (state.projectStatus !== "ready" || !state.project.root) return;
  clearTimeout(state.sessionSaveTimer);
  state.sessionSaveTimer = setTimeout(async () => {
    await flushSessionSnapshot();
  }, 350);
}

async function flushSessionSnapshot() {
  if (state.projectStatus !== "ready" || !state.project.root) return;
  clearTimeout(state.sessionSaveTimer);
  state.sessionSaveTimer = null;
  persistEmergencySession();
  try {
    await invoke("project_save_session", { snapshot: buildSessionSnapshot() });
    const key = emergencySessionKey();
    if (key) localStorage.removeItem(key);
  } catch (error) {
    toast(`Session state was not saved: ${error}`, true);
  }
}

function projectFileIcon(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".r")) return "R";
  if (name.endsWith(".rmd") || name.endsWith(".qmd") || name.endsWith(".md")) return "M";
  if (name.endsWith(".rd")) return "D";
  return "·";
}

function normalizeExecutableCode(code) {
  if (typeof code !== "string") return "";
  // Editors can preserve a UTF-8 BOM or zero-width marker at file start.
  return code
    .replace(/\r\n?/g, "\n")
    .replace(/^[\uFEFF\u200B\u200C\u200D\u2060]+/, "");
}

function asMessageList(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  return [String(value)];
}

function projectFileButton(file) {
  const button = document.createElement("button");
  button.className = `tree-item ${file.path === state.activeDocument ? "active" : ""}`;
  button.type = "button";
  const icon = document.createElement("span");
  icon.className = "file-icon";
  icon.textContent = projectFileIcon(file);
  const label = document.createElement("span");
  label.textContent = file.name;
  const dirty = document.createElement("span");
  dirty.className = `dirty-dot ${documentIsDirty(state.documents[file.path] || { content: "", savedContent: "" }) ? "" : "hidden"}`;
  button.append(icon, label, dirty);
  button.addEventListener("click", () => openDocument(file.path));
  return button;
}

function buildProjectTree(files) {
  const root = { directories: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    parts.pop();
    let node = root;
    let directoryPath = "";
    for (const part of parts) {
      directoryPath = directoryPath ? `${directoryPath}/${part}` : part;
      if (!node.directories.has(part)) {
        node.directories.set(part, {
          name: part,
          path: directoryPath,
          directories: new Map(),
          files: [],
        });
      }
      node = node.directories.get(part);
    }
    node.files.push(file);
  }
  return root;
}

function renderProjectTreeNode(node, container, depth = 0) {
  const directories = Array.from(node.directories.values())
    .sort((left, right) => left.name.localeCompare(right.name));
  const files = [...node.files].sort((left, right) => left.name.localeCompare(right.name));
  for (const directory of directories) {
    const details = document.createElement("details");
    details.className = "tree-directory";
    details.open = state.expandedDirectories.has(directory.path)
      || (depth === 0 && !state.collapsedDirectories.has(directory.path));
    const summary = document.createElement("summary");
    summary.className = "tree-directory-label";
    summary.textContent = directory.name;
    const children = document.createElement("div");
    children.className = "tree-directory-children";
    renderProjectTreeNode(directory, children, depth + 1);
    details.append(summary, children);
    details.addEventListener("toggle", () => {
      const method = details.open ? "add" : "delete";
      const opposite = details.open ? "delete" : "add";
      state.expandedDirectories[method](directory.path);
      state.collapsedDirectories[opposite](directory.path);
    });
    container.append(details);
  }
  for (const file of files) container.append(projectFileButton(file));
}

function renderProjectFiles() {
  const list = $("#projectFileList");
  list.replaceChildren();
  if (state.projectStatus !== "ready") return;
  if (!state.project.files.length) {
    const empty = document.createElement("div");
    empty.className = "empty-tree";
    empty.textContent = "No supported text files";
    list.append(empty);
    return;
  }
  renderProjectTreeNode(buildProjectTree(state.project.files), list);
  if (state.project.truncated) {
    const notice = document.createElement("div");
    notice.className = "empty-tree";
    notice.textContent = "Some files are hidden by project depth or file-count limits.";
    list.append(notice);
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
    clearAgentEditHighlight();
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
    clearAgentEditHighlight();
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
  if (state.activeDocument === path) clearAgentEditHighlight();
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
    state.internalProjectWrites.set(documentState.path, {
      content: documentState.content,
      expiresAt: Date.now() + 5000,
    });
    state.project = await invoke("project_write_file", { path: documentState.path, content: documentState.content });
    documentState.savedContent = documentState.content;
    documentState.conflictDiskContent = null;
    delete state.closedDrafts[documentState.path];
    renderProjectFiles();
    renderDocumentTabs();
    renderEnvironmentSummary();
    addConsole("SYSTEM", `Saved ${documentState.path}`);
    scheduleSessionSave();
  } catch (error) {
    state.internalProjectWrites.delete(documentState.path);
    toast(String(error), true);
  }
}

async function createDocument() {
  if (state.projectStatus !== "ready") return;
  const name = window.prompt("New R file name", "analysis.R");
  if (!name) return;
  const path = name.replace(/^[\\/]+/, "");
  try {
    state.internalProjectWrites.set(path, { content: "", expiresAt: Date.now() + 5000 });
    state.project = await invoke("project_create_file", { path, content: "" });
    await openDocument(path);
    scheduleSessionSave();
  } catch (error) {
    state.internalProjectWrites.delete(path);
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
    const [runs, problems, plots] = await Promise.all([
      invoke("list_runs", { limit: 50 }),
      invoke("list_problems", { limit: 50 }),
      invoke("list_plot_artifacts", { limit: 50, session_only: state.plotScope === "session" }),
    ]);
    state.runs = runs || [];
    state.problems = problems || [];
    state.plots = plots || [];
    state.activeRunId = activeRunRecord()?.run_id || null;
    await syncAgentRunsToConsole(state.runs);
    renderRuns();
    renderProblems();
    renderPlots();
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

function fileEditDecisionStorageKey(root = state.project.root) {
  return `rho.fileEditDecisions:${root || "default"}`;
}

function loadFileEditDecisions(root = state.project.root) {
  try {
    const value = JSON.parse(localStorage.getItem(fileEditDecisionStorageKey(root)) || "{}");
    return new Map(Object.entries(value));
  } catch (_) {
    return new Map();
  }
}

function persistFileEditDecisions() {
  try {
    localStorage.setItem(
      fileEditDecisionStorageKey(),
      JSON.stringify(Object.fromEntries(state.fileEditDecisions.entries()))
    );
  } catch {
    // File edit review state is best-effort in browser storage for V1.
  }
}

function clearFileEditDecisions(root = state.project.root) {
  try {
    localStorage.removeItem(fileEditDecisionStorageKey(root));
  } catch {
    // Ignore browser storage failures; explicit clear still resets in-memory state.
  }
}

function rankedProjectFileMentions(query) {
  const seen = new Set();
  const active = state.activeDocument ? [state.activeDocument] : [];
  const openDocuments = Object.keys(state.documents)
    .filter((path) => path !== state.activeDocument)
    .reverse();
  const projectFiles = state.project.files
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
  return [...active, ...openDocuments, ...projectFiles]
    .filter((path) => {
      if (!path || seen.has(path)) return false;
      seen.add(path);
      return path.toLowerCase().includes(query);
    })
    .slice(0, 8);
}

function parseAgentMentionInput(value, cursor) {
  const before = value.slice(0, cursor);
  const match = before.match(/(?:^|\s)@(?:"([^"\n]*)|([^\s@"]*))$/);
  if (!match) return null;
  return {
    query: String(match[1] ?? match[2] ?? "").toLowerCase(),
    start: before.lastIndexOf("@"),
    end: cursor,
  };
}

function agentTimelineEventBody(event) {
  if (event.event_type === "tool.call_completed" && event.tool === "propose_file_edit") {
    return "Review the proposed file edit below. No file has been changed yet.";
  }
  return event.body;
}

function hasVisibleAgentFileMentions() {
  return state.agentFileMention.items.length > 0;
}

function moveAgentFileMention(delta) {
  if (!hasVisibleAgentFileMentions()) return;
  const count = state.agentFileMention.items.length;
  state.agentFileMention.index = (state.agentFileMention.index + delta + count) % count;
  renderAgentFileMentions();
}

function agentMentionToken(path) {
  return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function activeSelectionExists() {
  if (!activeDocument()) return false;
  const { start, end } = currentEditorOffsets();
  return start !== end;
}

function closeAgentContextMenu() {
  $("#agentContextMenu").classList.add("hidden");
  $("#agentContextButton").setAttribute("aria-expanded", "false");
}

function openAgentContextMenu() {
  const hasDocument = Boolean(activeDocument());
  $("#agentContextChooseFile").disabled = state.projectStatus !== "ready" || !state.project.files.length;
  $("#agentContextUseCurrentFile").disabled = !hasDocument;
  $("#agentContextUseSelection").disabled = !activeSelectionExists();
  $("#agentContextNewFile").disabled = state.projectStatus !== "ready";
  $("#agentContextMenu").classList.remove("hidden");
  $("#agentContextButton").setAttribute("aria-expanded", "true");
}

function renderAgentContextBadge() {
  const badge = $("#agentContextBadge");
  if (state.agentContextSource === "editor" || !state.agentContextPath) {
    badge.textContent = "";
    badge.classList.add("hidden");
    return;
  }
  const suffix = {
    current_file: "",
    selection: " · selection",
    project_file: "",
    new_file: " · new",
  }[state.agentContextSource] || "";
  badge.textContent = `${state.agentContextPath}${suffix}`;
  badge.classList.remove("hidden");
}

function setAgentContext(source, path = null) {
  state.agentContextSource = source;
  state.agentContextPath = path;
  renderAgentContextBadge();
}

function resetAgentContext() {
  setAgentContext("editor", null);
}

function validateProjectRelativePath(path) {
  const normalized = String(path || "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized) {
    throw new Error("Project-relative path is required.");
  }
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith("/")) {
    throw new Error("Use a project-relative path, not an absolute path.");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Use a clean project-relative path without . or .. segments.");
  }
  return normalized;
}

function syncAgentContextFromInput() {
  const input = $("#agentInput").value;
  if (!state.agentContextPath || state.agentContextSource === "editor") return;
  if (!input.includes(agentMentionToken(state.agentContextPath))) {
    resetAgentContext();
  }
}

function insertAgentReference(path, options = {}) {
  const { source = null, range = null } = options;
  const input = $("#agentInput");
  const mention = agentMentionToken(path);
  const start = range?.start ?? input.selectionStart ?? input.value.length;
  const end = range?.end ?? input.selectionEnd ?? start;
  const prefix = start > 0 && /\S/.test(input.value[start - 1]) ? " " : "";
  const suffix = end < input.value.length && /\S/.test(input.value[end]) ? " " : " ";
  input.setRangeText(`${prefix}${mention}${suffix}`, start, end, "end");
  if (source) setAgentContext(source, path);
  input.focus();
}

function showAgentProjectFilePicker(contextSource = "project_file") {
  if (state.projectStatus !== "ready" || !state.project.files.length) return;
  const input = $("#agentInput");
  input.focus();
  state.agentFileMention = {
    items: rankedProjectFileMentions(""),
    index: 0,
    start: input.selectionStart ?? input.value.length,
    end: input.selectionEnd ?? input.selectionStart ?? input.value.length,
    mode: "picker",
    contextSource,
  };
  renderAgentFileMentions();
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
    const selectedTurnStillExists = state.selectedTurnId
      && state.agentTurns.some((turn) => turn.turn_id === state.selectedTurnId);
    const preferredTurnId = selectedTurnStillExists
      ? state.selectedTurnId
      || state.pendingApprovals[0]?.turn_id
      || state.agentTurns.find((turn) => ["running", "waiting"].includes(turn.status))?.turn_id
      || state.agentTurns[0]?.turn_id
      : state.pendingApprovals[0]?.turn_id
        || state.agentTurns.find((turn) => ["running", "waiting"].includes(turn.status))?.turn_id
        || state.agentTurns[0]?.turn_id
        || null;
    state.selectedTurnId = preferredTurnId;
    state.selectedTurnDetail = preferredTurnId
      ? await invoke("get_agent_turn_detail", { turnId: preferredTurnId })
      : null;
    renderAgentTimeline();
    renderApprovalPanel();
    renderFileEditPanel();
    updateAgentHeader();
    syncAgentPolling();
  } catch (error) {
    toast(`Agent history is unavailable: ${error}`, true);
  }
}

function emptyAgentLlmSettings(message) {
  return {
    schema_version: 1,
    selected_model_id: null,
    providers: [],
    models: [],
    selected_model: null,
    user_environ: { path: "", source: "default" },
    validation_error: message,
  };
}

function selectedAgentModel() {
  return state.agentLlm.settings?.selected_model || null;
}

function ensureAgentLlmSelectionState() {
  const settings = state.agentLlm.settings;
  if (!settings) return;
  if (!settings.providers.some((provider) => provider.id === state.agentLlm.selectedProviderId)) {
    state.agentLlm.selectedProviderId = settings.providers[0]?.id || null;
    state.agentLlm.editingProviderId = settings.providers[0]?.id || null;
  }
  if (!settings.models.some((model) => model.id === state.agentLlm.selectedModelEditorId)) {
    state.agentLlm.selectedModelEditorId = settings.selected_model_id || settings.models[0]?.id || null;
    state.agentLlm.editingModelId = state.agentLlm.selectedModelEditorId;
  }
}

function prettyToolCalling(value) {
  if (value === "yes") return "Act enabled";
  if (value === "no") return "Chat only";
  return "Act unavailable";
}

function agentSendDisabledReason() {
  if (state.agentRuntime && !state.agentRuntime.available) {
    return state.agentRuntime.error || "aisdk is unavailable in Agent R.";
  }
  if (state.agentLlm.settings?.validation_error) return state.agentLlm.settings.validation_error;
  if (!selectedAgentModel()) return "No enabled Agent model is configured.";
  return null;
}

function syncAgentComposerState() {
  const selected = selectedAgentModel();
  const reason = agentSendDisabledReason();
  const actBlocked = !selected?.act_enabled;
  const selectorLocked = state.pendingApprovals.length > 0
    || state.agentTurns.some((turn) => ["running", "waiting"].includes(turn.status));
  if (state.agentMode === "act" && actBlocked) {
    state.agentMode = "ask";
  }
  $("#agentSendButton").disabled = state.agentBusy || Boolean(reason);
  $("#agentInput").disabled = state.agentBusy || Boolean(reason);
  $$("[data-agent-mode]").forEach((button) => {
    const disabled = state.agentBusy || (button.dataset.agentMode === "act" && actBlocked);
    button.disabled = disabled;
    button.classList.toggle("active", button.dataset.agentMode === state.agentMode);
  });
  $("#actAutoApprove").disabled = state.agentBusy || state.agentMode !== "act" || actBlocked;
  $("#agentModelSelector").disabled = selectorLocked || !(state.agentLlm.settings?.models || []).length;
  const note = $("#agentCapabilityNote");
  if (reason && !state.agentBusy) {
    note.textContent = reason;
    note.className = "agent-capability-note warn";
    note.classList.remove("hidden");
    return;
  }
  if (selected && selected.tool_calling === "no") {
    note.textContent = "This model runs Ask and Plan as chat-only turns. It cannot inspect or modify the workspace.";
    note.className = "agent-capability-note warn";
    note.classList.remove("hidden");
    return;
  }
  if (selected && selected.tool_calling === "unknown") {
    note.textContent = "Test or declare tool support to use Act with this model.";
    note.className = "agent-capability-note warn";
    note.classList.remove("hidden");
    return;
  }
  note.classList.add("hidden");
}

function updateAgentModelLabel() {
  const selected = selectedAgentModel();
  $("#agentRuntimeLabel").textContent = selected?.display_name || "Select model";
  $("#agentModelSelector").title = selected
    ? `${selected.display_name} · ${selected.provider_display_name} · ${selected.selector_status}`
    : "Select Agent model";
}

async function loadAgentLlmSettings() {
  try {
    const settings = await invoke("agent_llm_settings");
    state.agentLlm.settings = settings || emptyAgentLlmSettings("Agent LLM settings are unavailable.");
    state.agentLlm.selectedModelId = state.agentLlm.settings.selected_model_id || null;
    state.agentLlm.lastTestResult = null;
  } catch (error) {
    state.agentLlm.settings = emptyAgentLlmSettings(String(error));
    state.agentLlm.selectedModelId = null;
  }
  ensureAgentLlmSelectionState();
  updateAgentModelLabel();
  renderAgentModelSelector();
  renderAgentLlmDialog();
  syncAgentComposerState();
}

function setAgentInputBusy(busy) {
  state.agentBusy = busy;
  if (busy) hideAgentFileMentions();
  if (!busy) state.agentLlm.lastTestResult = state.agentLlm.lastTestResult;
  syncAgentComposerState();
}

async function syncAgentRunsToConsole(runs) {
  const completed = runs.filter((run) =>
    run.origin === "agent" && ["completed", "failed", "interrupted"].includes(run.status)
  );
  if (!state.agentConsoleHydrated) {
    completed.forEach((run) => state.renderedAgentRunIds.add(run.run_id));
    state.agentConsoleHydrated = true;
    return;
  }
  for (const run of completed) {
    if (state.renderedAgentRunIds.has(run.run_id)) continue;
    state.renderedAgentRunIds.add(run.run_id);
    try {
      const detail = await invoke("get_run_detail", { runId: run.run_id });
      if (!detail) continue;
      addConsole("AGENT", `run_r > ${detail.code || run.code_preview || ""}`);
      if (detail.stdout) addConsole("AGENT", detail.stdout);
      asMessageList(detail.messages).forEach((message) => addConsole("AGENT", message));
      asMessageList(detail.warnings).forEach((warning) => addConsole("AGENT", warning, "warning"));
      if (detail.value_text) addConsole("AGENT", detail.value_text);
      if (detail.error_message) addConsole("AGENT", detail.error_message, "error");
    } catch (error) {
      addConsole("SYSTEM", `Could not display Agent run ${run.run_id}: ${error}`, "error");
    }
  }
}

function updateAgentHeader() {
  const latest = state.agentTurns[0] || null;
  const runtime = state.agentRuntime;
  updateAgentModelLabel();
  renderAgentModelSelector();
  if (runtime && !runtime.available) {
    state.agentBusy = true;
    syncAgentComposerState();
    $("#agentCancelButton").classList.add("hidden");
    $("#agentState").textContent = "Unavailable";
    $("#agentStateDot").className = "agent-state-dot error";
    return;
  }
  const active = state.pendingApprovals.length > 0
    || state.agentTurns.some((turn) => ["running", "waiting"].includes(turn.status));
  state.agentBusy = active;
  syncAgentComposerState();
  const activeTurn = state.agentTurns.find((turn) => ["running", "waiting"].includes(turn.status));
  state.activeAgentTurnId = activeTurn?.turn_id || null;
  $("#agentCancelButton").classList.toggle("hidden", !state.activeAgentTurnId);
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

function closeAgentModelSelector() {
  state.agentLlm.selectorOpen = false;
  $("#agentModelSelector").setAttribute("aria-expanded", "false");
  $("#agentModelSelectorMenu").classList.add("hidden");
}

function focusAgentModelMenuItem(position = "first") {
  const items = Array.from($("#agentModelSelectorMenu").querySelectorAll("button:not(:disabled)"));
  if (!items.length) return;
  if (position === "last") items[items.length - 1].focus();
  else items[0].focus();
}

function moveAgentModelMenuFocus(delta) {
  const items = Array.from($("#agentModelSelectorMenu").querySelectorAll("button:not(:disabled)"));
  if (!items.length) return;
  const current = items.indexOf(document.activeElement);
  const next = current < 0 ? 0 : (current + delta + items.length) % items.length;
  items[next].focus();
}

function openAgentModelSelector(focusPosition = null) {
  if (!state.agentLlm.settings?.models?.length) return;
  state.agentLlm.selectorOpen = true;
  $("#agentModelSelector").setAttribute("aria-expanded", "true");
  $("#agentModelSelectorMenu").classList.remove("hidden");
  if (focusPosition) requestAnimationFrame(() => focusAgentModelMenuItem(focusPosition));
}

function renderAgentModelSelector() {
  const menu = $("#agentModelSelectorMenu");
  menu.replaceChildren();
  const settings = state.agentLlm.settings;
  const models = settings?.models || [];
  if (!models.length) {
    const empty = document.createElement("div");
    empty.className = "agent-model-empty";
    empty.textContent = settings?.validation_error || "No Agent models configured.";
    menu.append(empty);
  } else {
    for (const model of models.filter((item) => item.enabled)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "agent-model-option";
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-checked", String(Boolean(model.selected)));
      const title = document.createElement("div");
      title.className = "agent-model-option-title";
      const strong = document.createElement("strong");
      strong.textContent = model.display_name;
      const meta = document.createElement("span");
      meta.className = model.selected ? "agent-model-check" : "agent-model-status";
      meta.textContent = model.selected ? "Selected" : model.selector_status;
      title.append(strong, meta);
      const info = document.createElement("p");
      info.textContent = `${model.provider_display_name} · ${prettyToolCalling(model.capabilities?.tool_calling || "unknown")}`;
      button.append(title, info);
      button.addEventListener("click", async () => {
        closeAgentModelSelector();
        try {
          const view = await invoke("agent_llm_select_model", { request: { model_id: model.id } });
          state.agentLlm.settings = view;
          state.agentLlm.selectedModelId = view.selected_model_id;
          ensureAgentLlmSelectionState();
          updateAgentHeader();
          renderAgentLlmDialog();
        } catch (error) {
          toast(String(error), true);
        }
      });
      menu.append(button);
    }
  }
  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = "agent-model-manage";
  manage.setAttribute("role", "menuitem");
  manage.innerHTML = "<strong>Manage LLMs...</strong><p>Edit providers, models and connection checks.</p>";
  manage.addEventListener("click", () => {
    closeAgentModelSelector();
    openAgentLlmDialog();
  });
  menu.append(manage);
}

function currentProviderRecord() {
  return state.agentLlm.settings?.providers?.find((provider) => provider.id === state.agentLlm.editingProviderId) || null;
}

function currentModelRecord() {
  return state.agentLlm.settings?.models?.find((model) => model.id === state.agentLlm.editingModelId) || null;
}

function createAgentLlmListRow(titleText, metaText, active) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `agent-llm-row${active ? " active" : ""}`;
  const title = document.createElement("strong");
  title.textContent = titleText;
  const meta = document.createElement("p");
  meta.textContent = metaText;
  row.append(title, meta);
  return row;
}

function catalogProviderId(provider) {
  if (!provider) return null;
  if (provider.kind === "registered") return provider.registered_provider_id || null;
  if (["openai", "anthropic", "gemini"].includes(provider.kind)) return provider.kind;
  return null;
}

function renderAgentLlmCatalogOptions() {
  const select = $("#agentLlmCatalogModel");
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = state.agentLlm.catalogLoaded
    ? "Choose a catalog model..."
    : "Load the model catalog first...";
  select.append(placeholder);
  const provider = (state.agentLlm.settings?.providers || [])
    .find((item) => item.id === $("#agentLlmModelProvider").value);
  const providerId = catalogProviderId(provider);
  for (const entry of state.agentLlm.catalog.filter((item) => !providerId || item.provider === providerId)) {
    const option = document.createElement("option");
    option.value = `${entry.provider}:${entry.id}`;
    option.textContent = `${entry.display_name || entry.id} (${entry.provider})`;
    select.append(option);
  }
  select.disabled = !state.agentLlm.catalog.length;
}

function renderAgentProviderForm() {
  const provider = currentProviderRecord();
  $("#agentLlmProviderDisplayName").value = provider?.display_name || "";
  $("#agentLlmProviderKind").value = provider?.kind || "registered";
  $("#agentLlmRegisteredProviderId").value = provider?.registered_provider_id || "";
  $("#agentLlmProviderApiKeyEnv").value = provider?.api_key_env || "";
  $("#agentLlmProviderBaseUrl").value = provider?.base_url || "";
  $("#agentLlmProviderBaseUrlEnv").value = provider?.base_url_env || "";
  $("#agentLlmProviderWireApi").value = provider?.wire_api || "";
  $("#agentLlmProviderApiKeyRequired").checked = provider ? Boolean(provider.api_key_required) : true;
  $("#agentLlmProviderDisableStreamOptions").checked = Boolean(provider?.disable_stream_options);
}

function renderAgentModelForm() {
  const model = currentModelRecord();
  const providerSelect = $("#agentLlmModelProvider");
  providerSelect.replaceChildren();
  for (const provider of state.agentLlm.settings?.providers || []) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.display_name;
    providerSelect.append(option);
  }
  $("#agentLlmModelDisplayName").value = model?.display_name || "";
  $("#agentLlmModelProvider").value = model?.provider_id || state.agentLlm.settings?.providers?.[0]?.id || "";
  renderAgentLlmCatalogOptions();
  $("#agentLlmModelId").value = model?.model_id || "";
  $("#agentLlmModelToolCalling").value = model?.capabilities?.tool_calling || "unknown";
  $("#agentLlmModelReasoning").value = model?.capabilities?.reasoning || "unknown";
  $("#agentLlmModelVisionInput").value = model?.capabilities?.vision_input || "unknown";
  $("#agentLlmModelCapabilitySource").value = model?.capabilities?.source || "declared";
  $("#agentLlmModelEnabled").checked = model ? Boolean(model.enabled) : true;
}

function renderAgentLlmDialog() {
  const settings = state.agentLlm.settings || emptyAgentLlmSettings("Agent LLM settings are unavailable.");
  ensureAgentLlmSelectionState();
  $("#agentLlmUserEnviron").textContent = settings.user_environ?.path
    ? `Effective user environment: ${settings.user_environ.path}`
    : "Effective user environment is unavailable.";
  $("#agentLlmValidation").textContent = settings.validation_error || "";
  $("#agentLlmValidation").classList.toggle("hidden", !settings.validation_error);
  const providerList = $("#agentLlmProviderList");
  providerList.replaceChildren();
  if (!settings.providers.length) {
    const empty = document.createElement("div");
    empty.className = "agent-llm-empty";
    empty.textContent = "No providers yet.";
    providerList.append(empty);
  } else {
    for (const provider of settings.providers) {
      const row = createAgentLlmListRow(
        provider.display_name,
        `${provider.kind} · credential ${provider.credential_status}`,
        provider.id === state.agentLlm.selectedProviderId
      );
      row.addEventListener("click", () => {
        state.agentLlm.selectedProviderId = provider.id;
        state.agentLlm.editingProviderId = provider.id;
        renderAgentLlmDialog();
      });
      providerList.append(row);
    }
  }
  const modelList = $("#agentLlmModelList");
  modelList.replaceChildren();
  if (!settings.models.length) {
    const empty = document.createElement("div");
    empty.className = "agent-llm-empty";
    empty.textContent = "No models yet.";
    modelList.append(empty);
  } else {
    for (const model of settings.models) {
      const row = createAgentLlmListRow(
        model.display_name,
        `${model.provider_display_name} · ${model.selector_status} · ${prettyToolCalling(model.capabilities?.tool_calling || "unknown")}`,
        model.id === state.agentLlm.selectedModelEditorId
      );
      row.addEventListener("click", () => {
        state.agentLlm.selectedModelEditorId = model.id;
        state.agentLlm.editingModelId = model.id;
        state.agentLlm.lastTestResult = model.last_test || null;
        renderAgentLlmDialog();
      });
      modelList.append(row);
    }
  }
  renderAgentProviderForm();
  renderAgentModelForm();
  const result = state.agentLlm.lastTestResult;
  $("#agentLlmTestResult").className = `agent-llm-test-result${result ? ` ${result.status}` : " hidden"}`;
  $("#agentLlmTestResult").textContent = result
    ? `${result.message || "Connection checked."}${result.latency_ms ? ` · ${result.latency_ms} ms` : ""}`
    : "";
  $("#agentLlmTestModel").disabled = state.agentLlm.testInFlight;
  $("#agentLlmCancelTest").disabled = !state.agentLlm.testInFlight;
}

function openAgentLlmDialog() {
  state.agentLlm.settingsOpen = true;
  renderAgentLlmDialog();
  $("#agentLlmDialog").classList.remove("hidden");
}

function closeAgentLlmDialog() {
  state.agentLlm.settingsOpen = false;
  $("#agentLlmDialog").classList.add("hidden");
}

function applyAgentLlmView(view) {
  state.agentLlm.settings = view || emptyAgentLlmSettings("Agent LLM settings are unavailable.");
  state.agentLlm.selectedModelId = state.agentLlm.settings.selected_model_id || null;
  ensureAgentLlmSelectionState();
  updateAgentHeader();
  renderAgentLlmDialog();
}

function clearAgentProviderForm() {
  state.agentLlm.editingProviderId = null;
  $("#agentLlmProviderDisplayName").value = "";
  $("#agentLlmProviderKind").value = "registered";
  $("#agentLlmRegisteredProviderId").value = "";
  $("#agentLlmProviderApiKeyEnv").value = "";
  $("#agentLlmProviderBaseUrl").value = "";
  $("#agentLlmProviderBaseUrlEnv").value = "";
  $("#agentLlmProviderWireApi").value = "";
  $("#agentLlmProviderApiKeyRequired").checked = true;
  $("#agentLlmProviderDisableStreamOptions").checked = false;
}

function clearAgentModelForm() {
  state.agentLlm.editingModelId = null;
  $("#agentLlmModelDisplayName").value = "";
  $("#agentLlmModelProvider").value = state.agentLlm.settings?.providers?.[0]?.id || "";
  $("#agentLlmModelId").value = "";
  $("#agentLlmModelToolCalling").value = "unknown";
  $("#agentLlmModelReasoning").value = "unknown";
  $("#agentLlmModelVisionInput").value = "unknown";
  $("#agentLlmModelCapabilitySource").value = "declared";
  $("#agentLlmModelEnabled").checked = true;
  state.agentLlm.lastTestResult = null;
  $("#agentLlmTestResult").className = "agent-llm-test-result hidden";
  $("#agentLlmTestResult").textContent = "";
}

function readAgentProviderForm() {
  const settings = state.agentLlm.settings || emptyAgentLlmSettings("Agent LLM settings are unavailable.");
  const displayName = $("#agentLlmProviderDisplayName").value.trim();
  const ids = settings.providers.map((provider) => provider.id);
  return {
    id: state.agentLlm.editingProviderId || uniqueAgentId("provider", displayName || "provider", ids),
    display_name: displayName,
    kind: $("#agentLlmProviderKind").value,
    registered_provider_id: $("#agentLlmRegisteredProviderId").value.trim() || null,
    api_key_env: $("#agentLlmProviderApiKeyEnv").value.trim() || null,
    api_key_required: $("#agentLlmProviderApiKeyRequired").checked,
    base_url: $("#agentLlmProviderBaseUrl").value.trim() || null,
    base_url_env: $("#agentLlmProviderBaseUrlEnv").value.trim() || null,
    wire_api: $("#agentLlmProviderWireApi").value || null,
    disable_stream_options: $("#agentLlmProviderDisableStreamOptions").checked ? true : null,
  };
}

function readAgentModelForm() {
  const settings = state.agentLlm.settings || emptyAgentLlmSettings("Agent LLM settings are unavailable.");
  const displayName = $("#agentLlmModelDisplayName").value.trim();
  const ids = settings.models.map((model) => model.id);
  return {
    id: state.agentLlm.editingModelId || uniqueAgentId("model", displayName || "model", ids),
    provider_id: $("#agentLlmModelProvider").value,
    display_name: displayName,
    model_id: $("#agentLlmModelId").value.trim(),
    enabled: $("#agentLlmModelEnabled").checked,
    capabilities: {
      tool_calling: $("#agentLlmModelToolCalling").value,
      reasoning: $("#agentLlmModelReasoning").value,
      vision_input: $("#agentLlmModelVisionInput").value,
      source: $("#agentLlmModelCapabilitySource").value,
    },
    last_test: currentModelRecord()?.last_test || null,
  };
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement("textarea");
  input.value = text;
  document.body.append(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

async function saveAgentProvider() {
  try {
    const provider = readAgentProviderForm();
    const view = await invoke("agent_llm_save_provider", { provider });
    state.agentLlm.selectedProviderId = provider.id;
    state.agentLlm.editingProviderId = provider.id;
    applyAgentLlmView(view);
    toast(`Saved provider ${provider.display_name || provider.id}.`);
  } catch (error) {
    toast(String(error), true);
  }
}

async function deleteAgentProvider() {
  const provider = currentProviderRecord();
  if (!provider) {
    toast("Select a provider to delete.", true);
    return;
  }
  if (!window.confirm(`Delete provider ${provider.display_name}?`)) return;
  try {
    const view = await invoke("agent_llm_delete_provider", { providerId: provider.id });
    state.agentLlm.selectedProviderId = view.providers[0]?.id || null;
    state.agentLlm.editingProviderId = state.agentLlm.selectedProviderId;
    applyAgentLlmView(view);
    renderAgentProviderForm();
    toast(`Deleted provider ${provider.display_name}.`);
  } catch (error) {
    toast(String(error), true);
  }
}

async function saveAgentModel() {
  try {
    const model = readAgentModelForm();
    const view = await invoke("agent_llm_save_model", { model });
    state.agentLlm.selectedModelEditorId = model.id;
    state.agentLlm.editingModelId = model.id;
    applyAgentLlmView(view);
    toast(`Saved model ${model.display_name || model.id}.`);
  } catch (error) {
    toast(String(error), true);
  }
}

async function deleteAgentModel() {
  const model = currentModelRecord();
  if (!model) {
    toast("Select a model to delete.", true);
    return;
  }
  if (!window.confirm(`Delete model ${model.display_name}?`)) return;
  try {
    let replacementModelId = null;
    if (state.agentLlm.settings?.selected_model_id === model.id) {
      replacementModelId = (state.agentLlm.settings.models || []).find((item) => item.enabled && item.id !== model.id)?.id || null;
      if (!replacementModelId) {
        toast("Select another enabled model before deleting the current default.", true);
        return;
      }
    }
    const view = await invoke("agent_llm_delete_model", {
      request: {
        model_id: model.id,
        replacement_model_id: replacementModelId,
      },
    });
    state.agentLlm.selectedModelEditorId = view.selected_model_id || view.models[0]?.id || null;
    state.agentLlm.editingModelId = state.agentLlm.selectedModelEditorId;
    state.agentLlm.lastTestResult = null;
    applyAgentLlmView(view);
    toast(`Deleted model ${model.display_name}.`);
  } catch (error) {
    toast(String(error), true);
  }
}

async function selectAgentDefaultModel() {
  const model = currentModelRecord();
  if (!model) {
    toast("Select a model to use as default.", true);
    return;
  }
  try {
    const view = await invoke("agent_llm_select_model", { request: { model_id: model.id } });
    applyAgentLlmView(view);
    toast(`Selected ${model.display_name} for the next Agent turns.`);
  } catch (error) {
    toast(String(error), true);
  }
}

async function testAgentModelConnection() {
  const model = currentModelRecord();
  if (!model) {
    toast("Select a model to test.", true);
    return;
  }
  try {
    state.agentLlm.testInFlight = true;
    renderAgentLlmDialog();
    $("#agentLlmTestResult").className = "agent-llm-test-result";
    $("#agentLlmTestResult").textContent = "Testing connection...";
    const view = await invoke("agent_llm_test_model", { modelId: model.id });
    state.agentLlm.lastTestResult = view.models.find((item) => item.id === model.id)?.last_test || null;
    applyAgentLlmView(view);
  } catch (error) {
    const message = String(error);
    state.agentLlm.lastTestResult = {
      status: message.includes("cancelled") ? "warn" : "error",
      latency_ms: null,
      message: message.includes("cancelled") ? "Connection test cancelled." : message,
    };
    renderAgentLlmDialog();
    if (!message.includes("cancelled")) toast(message, true);
  } finally {
    state.agentLlm.testInFlight = false;
    renderAgentLlmDialog();
  }
}

async function loadAgentLlmCatalog() {
  const button = $("#agentLlmLoadCatalog");
  button.disabled = true;
  try {
    const catalog = await invoke("agent_llm_catalog");
    state.agentLlm.catalog = Array.isArray(catalog) ? catalog : [];
    state.agentLlm.catalogLoaded = true;
    renderAgentLlmCatalogOptions();
    toast(`Loaded ${state.agentLlm.catalog.length} catalog models.`);
  } catch (error) {
    toast(`Could not load model catalog: ${error}`, true);
  } finally {
    button.disabled = false;
  }
}

function applySelectedCatalogModel() {
  const value = $("#agentLlmCatalogModel").value;
  if (!value) return;
  const entry = state.agentLlm.catalog.find((item) => `${item.provider}:${item.id}` === value);
  if (!entry) return;
  $("#agentLlmModelId").value = entry.id;
  $("#agentLlmModelDisplayName").value = entry.display_name || entry.id;
  $("#agentLlmModelToolCalling").value = entry.capabilities?.tool_calling || "unknown";
  $("#agentLlmModelReasoning").value = entry.capabilities?.reasoning || "unknown";
  $("#agentLlmModelVisionInput").value = entry.capabilities?.vision_input || "unknown";
  $("#agentLlmModelCapabilitySource").value = entry.capabilities?.source || "catalog";
}

async function cancelAgentModelTest() {
  if (!state.agentLlm.testInFlight) return;
  try {
    await invoke("agent_llm_cancel_test");
    $("#agentLlmTestResult").className = "agent-llm-test-result";
    $("#agentLlmTestResult").textContent = "Cancelling connection test...";
  } catch (error) {
    toast(String(error), true);
  }
}

async function reloadAgentCredentials() {
  try {
    applyAgentLlmView(await invoke("agent_llm_refresh_credentials"));
    toast("Reloaded Agent credential detection.");
  } catch (error) {
    toast(String(error), true);
  }
}

async function openAgentUserEnviron() {
  try {
    const info = await invoke("agent_llm_open_user_environ");
    toast(`Opened ${info.path}.`);
  } catch (error) {
    toast(String(error), true);
  }
}

async function copyAgentSetupLine() {
  const envName = $("#agentLlmProviderApiKeyEnv").value.trim() || currentProviderRecord()?.api_key_env || "API_KEY";
  try {
    await copyText(`${envName}=""`);
    toast(`Copied ${envName} setup line.`);
  } catch (error) {
    toast(String(error), true);
  }
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
    if (state.agentRuntime && !state.agentRuntime.available) {
      addTimeline("Agent unavailable", state.agentRuntime.error || "aisdk could not be loaded in Agent R.", "error");
    } else {
      const version = state.agentRuntime?.aisdk_version;
      addTimeline(
        "Workspace connected",
        `Ark session is ready. Agent R${version ? ` uses aisdk ${version}` : ""}.`,
        "completed",
      );
    }
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
    paragraph.textContent = `${prettyAgentStatus(turn.status)} · ${turn.model || "model?"}${turn.pending_request_id ? ` · ${turn.pending_request_id}` : ""}`;
    content.append(heading, paragraph);
    const detail = truncateText(turn.error_message || turn.final_message || "", 140);
    if (detail) {
      const detailLine = document.createElement("p");
      detailLine.textContent = detail;
      content.append(detailLine);
    }
    if (selected && turn.final_message) {
      const fullMessage = document.createElement("div");
      fullMessage.className = "timeline-final-message";
      fullMessage.textContent = turn.final_message;
      content.append(fullMessage);
    }
    row.append(marker, content);
    row.addEventListener("click", async () => {
      state.selectedTurnId = turn.turn_id;
      state.selectedTurnDetail = await invoke("get_agent_turn_detail", { turnId: turn.turn_id });
      renderAgentTimeline();
      renderApprovalPanel();
      renderFileEditPanel();
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
        const body = agentTimelineEventBody(event);
        if (body) {
          const childBody = document.createElement("p");
          childBody.textContent = body;
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
          await invoke("cancel_run", { runId: run.run_id });
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
      applyWorkbenchLayout("agent");
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
          const response = await invoke("retry_run", { runId: problem.run_id });
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
  asMessageList(execution.messages).forEach((message) => addConsole(origin, message));
  asMessageList(execution.warnings).forEach((warning) => addConsole(origin, warning, "warning"));
  if (execution.value) addConsole(origin, execution.value);
  if (execution.error) {
    addConsole(origin, execution.error.message, "error");
  }
  if (execution.kind === "render") {
    updateLastRender({
      ok: Boolean(execution.ok),
      tool: execution.tool || null,
      sourcePath: execution.source_path || request?.sourcePath || null,
      outputPath: execution.output_path || null,
      phase: execution.error?.phase || null,
      message: execution.error?.message || execution.stdout || null,
    });
    if (execution.ok) {
      addConsole("SYSTEM", `Render completed · ${execution.output_path || execution.source_path || "output"}`);
    } else if (execution.error?.message) {
      addProblem(execution.error.message, "", {
        origin: "user",
        status: "failed",
        sourcePath: execution.source_path || request?.sourcePath || null,
        executionMode: "render",
        documentVersion: request?.documentVersion ?? null,
      });
    }
    renderEnvironmentSummary();
  }
  for (const wrapped of asMessageList(response.events)) {
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
  $("#plotImage").src = source;
  $("#plotImage").classList.remove("hidden");
  $("#plotEmpty").classList.add("hidden");
}

function renderPlots() {
  const history = $("#plotHistory");
  const outputList = $("#plotOutputList");
  history.replaceChildren();
  outputList.replaceChildren();
  const plots = state.plots || [];
  $$('[data-plot-scope]').forEach((button) => button.classList.toggle("active", button.dataset.plotScope === state.plotScope));
  $("#plotCount").textContent = String(plots.length);
  $("#plotOutputCount").textContent = String(plots.length);
  if (!plots.length) {
    $("#plotEmpty").classList.remove("hidden");
    $("#plotImage").classList.add("hidden");
    return;
  }
  $("#plotEmpty").classList.add("hidden");
  const latest = plots[0];
  try {
    const payload = JSON.parse(latest.payload_json || "{}");
    renderDisplay(payload);
  } catch {
    $("#plotImage").classList.add("hidden");
  }
  for (const plot of plots) {
    const row = document.createElement("div");
    row.className = "plot-history-row";
    const title = document.createElement("strong");
    title.textContent = plot.source_path || plot.run_id;
    const line1 = document.createElement("p");
    line1.textContent = `${plot.execution_mode || "plot"} · run ${plot.run_id} · state ${plot.state_revision ?? "?"}`;
    const line2 = document.createElement("p");
    line2.textContent = plot.provenance_complete
      ? `Source ${plot.source_path || "available"} · rev ${plot.document_version ?? "?"}`
      : "Provenance incomplete";
    row.append(title, line1, line2);
    row.addEventListener("click", () => {
      try {
        renderDisplay(JSON.parse(plot.payload_json || "{}"));
      } catch {
        toast("Plot payload is unavailable.", true);
      }
    });
    history.append(row);

    const output = document.createElement("button");
    output.type = "button";
    output.className = "tree-item plot-output-item";
    const outputLabel = document.createElement("span");
    outputLabel.textContent = plot.source_path || plot.execution_mode || "Console plot";
    const outputIndex = document.createElement("small");
    outputIndex.textContent = plot.plot_id.split("_").at(-1) || "plot";
    output.append(outputLabel, outputIndex);
    output.addEventListener("click", () => {
      switchDockTab("plots");
      try {
        renderDisplay(JSON.parse(plot.payload_json || "{}"));
      } catch {
        toast("Plot payload is unavailable.", true);
      }
    });
    outputList.append(output);
  }
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
    state.environment = response.execution?.environment || null;
    renderEnvironment();
  } catch (error) {
    toast(String(error), true);
  }
}

function renderEnvironmentSummary() {
  const environment = state.environment;
  if (!environment) {
    $("#environmentContract").textContent = "Environment snapshot unavailable.";
    $("#renderCapability").textContent = "Render tooling not checked yet.";
    $("#renderDocumentHint").textContent = renderDocumentHintText();
    $("#renderDocumentButton").disabled = true;
    renderLastRenderCard();
    return;
  }
  const renv = environment.renv || {};
  const bioc = environment.bioconductor || {};
  const render = environment.render || {};
  const attached = (environment.attached_packages?.values || []).map((item) => `${item.name}${item.version ? ` ${item.version}` : ""}`).join(", ");
  $("#environmentContract").textContent = [
    `renv ${renv.status || "unknown"}`,
    bioc.version ? `Bioc ${bioc.version}` : `Bioc ${bioc.status || "unknown"}`,
    attached ? `packages ${attached}` : null,
  ].filter(Boolean).join(" · ");
  $("#renderCapability").textContent = [
    render.can_render_qmd ? "Quarto ready" : "Quarto unavailable",
    render.can_render_rmd ? "R Markdown ready" : "R Markdown unavailable",
  ].join(" · ");
  $("#renderDocumentHint").textContent = renderDocumentHintText();
  const path = state.activeDocument || "";
  const renderable = activeDocumentCanRender();
  const documentState = activeDocument();
  const saved = Boolean(documentState && !documentIsDirty(documentState));
  const canRender = path.toLowerCase().endsWith(".qmd")
    ? Boolean(render.can_render_qmd)
    : path.toLowerCase().endsWith(".rmd")
      ? Boolean(render.can_render_rmd)
      : false;
  $("#renderDocumentButton").disabled = !renderable || !canRender || !saved;
  renderLastRenderCard();
}

function renderLastRenderCard() {
  const card = $("#renderResultCard");
  const render = state.lastRender;
  card.className = "render-result-card";
  if (!render) {
    card.classList.add("hidden");
    $("#renderResultTitle").textContent = "Last Render";
    $("#renderResultState").textContent = "idle";
    $("#renderResultSummary").textContent = "No render has been run yet.";
    $("#renderResultPath").textContent = "";
    for (const id of ["renderOpenSourceButton", "renderShowProblemsButton", "renderShowPlotsButton"]) {
      $(`#${id}`).disabled = true;
    }
    return;
  }
  card.classList.remove("hidden");
  card.classList.add(render.ok ? "success" : "error");
  $("#renderResultTitle").textContent = render.tool ? `Last Render · ${render.tool}` : "Last Render";
  $("#renderResultState").textContent = render.ok ? "completed" : (render.phase || "failed");
  $("#renderResultSummary").textContent = render.ok
    ? `Rendered ${render.sourcePath || "document"} successfully.`
    : `${render.message || "Render failed."}`;
  $("#renderResultPath").textContent = render.ok
    ? `Output: ${render.outputPath || "unavailable"}`
    : `Source: ${render.sourcePath || "unknown"}${render.phase ? ` · phase ${render.phase}` : ""}`;
  $("#renderOpenSourceButton").disabled = !render.sourcePath;
  $("#renderShowProblemsButton").disabled = !latestRenderProblem();
  $("#renderShowPlotsButton").disabled = !state.plots.some((plot) => plot.source_path === render.sourcePath);
}

function previewSummary(detail) {
  if (!detail) return "Select an object to inspect its bounded summary.";
  const preview = detail.preview || {};
  const lines = [
    `${detail.name} · ${(detail.classes || []).join("/") || detail.typeof || "object"}`,
    detail.dimensions?.length ? `shape: ${detail.dimensions.join(" × ")}` : `type: ${detail.typeof || "unknown"}`,
    `size: ${formatBytes(detail.size_bytes || 0)}`,
  ];
  if (preview.kind === "tabular") {
    lines.push(`columns: ${(preview.columns?.values || []).join(", ")}${preview.columns?.truncated ? " ..." : ""}`);
    lines.push(`rows: ${(preview.rows || []).map((row) => Object.values(row).join(" | ")).join("\n")}`);
  } else if (preview.kind === "vector") {
    lines.push(`values: ${(preview.values || []).join(", ")}${preview.truncated ? " ..." : ""}`);
  } else if (preview.kind === "list") {
    lines.push(`items: ${(preview.items || []).join(", ")}${preview.truncated ? " ..." : ""}`);
  } else if (preview.unsupported_preview) {
    lines.push("Preview is bounded to structural metadata for this class.");
  }
  if (detail.structure) lines.push("", detail.structure);
  return lines.filter((line) => line !== null && line !== undefined).join("\n");
}

async function inspectEnvironmentObject(name) {
  try {
    state.selectedObjectName = name;
    const response = await invoke("inspect_object", {
      request: { name },
    });
    updateIdentity(response.workspace);
    state.selectedObjectDetail = response.execution || null;
    renderEnvironment();
  } catch (error) {
    toast(String(error), true);
  }
}

function renderEnvironment() {
  renderEnvironmentSummary();
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
    row.className = `environment-row${state.selectedObjectName === object.name ? " active" : ""}`;
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
    row.addEventListener("click", () => {
      inspectEnvironmentObject(object.name);
    });
    $("#environmentList").append(row);
  }
  $("#objectCount").textContent = String(state.objects.length);
  $("#objectPreviewTitle").textContent = state.selectedObjectDetail?.name || "Object Preview";
  $("#objectPreviewMeta").textContent = state.selectedObjectDetail?.preview_kind || "bounded";
  $("#objectPreviewBody").textContent = previewSummary(state.selectedObjectDetail);
}

async function renderActiveDocumentFile() {
  const path = state.activeDocument;
  if (!path) {
    toast("Open a .Rmd or .qmd document first.", true);
    return;
  }
  if (!/\.(rmd|qmd)$/i.test(path)) {
    toast("Render only supports .Rmd or .qmd files.", true);
    return;
  }
  const documentState = activeDocument();
  if (documentState && documentIsDirty(documentState)) {
    toast("Save the document before rendering so the rendered file matches the editor.", true);
    return;
  }
  $("#renderDocumentButton").disabled = true;
  try {
    const response = await invoke("render_document", {
      request: {
        path,
        document_version: documentState?.versionId ?? null,
      },
    });
    renderExecution(response, {
      type: "render",
      sourcePath: path,
      documentVersion: documentState?.versionId ?? null,
    }, "USER");
    await Promise.all([loadRunData(), refreshEnvironment()]);
  } catch (error) {
    updateLastRender({
      ok: false,
      tool: null,
      sourcePath: path,
      outputPath: null,
      phase: "transport",
      message: String(error),
    });
    addProblem(String(error), "", {
      sourcePath: path,
      executionMode: "render",
    });
    toast(String(error), true);
  } finally {
    $("#renderDocumentButton").disabled = false;
    renderEnvironmentSummary();
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function buildAgentEditorContext() {
  syncDocumentFromEditor({ render: false, persist: false });
  const documentState = activeDocument();
  const files = state.project.files.map((file) => file.path).slice(0, 500);
  if (!documentState) {
    return {
      project_root: state.project.root,
      files,
      active_path: null,
      context_source: state.agentContextSource,
      context_path: state.agentContextPath,
    };
  }
  const offsets = currentEditorOffsets();
  const start = Math.min(offsets.start, offsets.end);
  const end = Math.max(offsets.start, offsets.end);
  const content = currentEditorValue();
  const position = currentCursorPosition();
  return {
    project_root: state.project.root,
    files,
    active_path: documentState.path,
    document_version: documentState.versionId ?? null,
    selection_start: start,
    selection_end: end,
    selection_text: content.slice(start, end),
    cursor_line: position.line,
    cursor_column: position.column,
    anchor_before: content.slice(Math.max(0, start - 160), start),
    anchor_after: content.slice(end, Math.min(content.length, end + 160)),
    nearby_before: content.slice(Math.max(0, start - 2000), start),
    nearby_after: content.slice(end, Math.min(content.length, end + 2000)),
    file_tail: content.slice(Math.max(0, content.length - 2000)),
    context_source: state.agentContextSource,
    context_path: state.agentContextPath,
  };
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function selectedFileEditProposal() {
  const detail = state.selectedTurnDetail;
  if (!detail?.events?.length) return null;
  const event = [...detail.events].reverse().find((item) =>
    item.event_type === "tool.call_completed" && item.tool === "propose_file_edit"
  );
  if (!event) return null;
  const proposal = parseJsonObject(event.body);
  if (proposal?.kind !== "rho.file_edit_proposal") return null;
  const userEvent = detail.events.find((item) => item.event_type === "agent.user_prompt");
  const editorContext = parseJsonObject(userEvent?.details_json)?.editor_context || null;
  return {
    ...proposal,
    turnId: detail.turn_id || state.selectedTurnId,
    eventId: event.id,
    key: `${detail.turn_id || state.selectedTurnId}:${event.id}`,
    editorContext,
  };
}

function fileEditOperationLabel(operation) {
  return {
    replace_selection: "Replace selection",
    insert_at_cursor: "Insert at cursor",
    append: "Append to file",
    create: "Create file",
  }[operation] || operation;
}

function renderFileEditDecisionNote(decision, undoAvailable) {
  const note = $("#fileEditDecisionNote");
  if (decision === "accepted" && undoAvailable) {
    note.textContent = "Already applied. Undo is available for this latest accepted proposal.";
    note.className = "file-edit-note";
    note.classList.remove("hidden");
    return;
  }
  if (decision === "accepted") {
    note.textContent = "Already applied. Undo is no longer available.";
    note.className = "file-edit-note";
    note.classList.remove("hidden");
    return;
  }
  if (decision === "rejected") {
    note.textContent = "This proposal was rejected.";
    note.className = "file-edit-note rejected";
    note.classList.remove("hidden");
    return;
  }
  note.textContent = "";
  note.className = "file-edit-note hidden";
}

function boundedFileEditPreview(text, limit = 4000) {
  const value = String(text || "");
  if (!value) return "(empty)";
  if (value.length <= limit) return value;
  const half = Math.max(1, Math.floor(limit / 2));
  return `${value.slice(0, half)}\n...\n${value.slice(-half)}`;
}

function contextualFileEditPreview(proposal) {
  const context = proposal.editorContext || {};
  const nearbyBefore = String(context.nearby_before || "");
  const nearbyAfter = String(context.nearby_after || "");
  const selectionText = String(context.selection_text || "");
  const inserted = String(proposal.content || "");
  if (proposal.operation === "replace_selection") {
    return {
      before: `${nearbyBefore}${selectionText || "(empty selection)"}${nearbyAfter}`,
      after: `${nearbyBefore}${inserted}${nearbyAfter}`,
    };
  }
  if (proposal.operation === "insert_at_cursor") {
    return {
      before: `${nearbyBefore}\n| cursor |\n${nearbyAfter}`,
      after: `${nearbyBefore}${inserted}${nearbyAfter}`,
    };
  }
  if (proposal.operation === "append") {
    if (context.active_path === proposal.path && context.file_tail) {
      return {
        before: context.file_tail,
        after: `${context.file_tail}${inserted}`,
      };
    }
    return {
      before: "(Latest file tail will be loaded on Accept for this append target.)",
      after: inserted || "(empty)",
    };
  }
  if (proposal.operation === "create") {
    return {
      before: "(new file)",
      after: inserted || "(empty)",
    };
  }
  return {
    before: "(preview unavailable)",
    after: inserted || "(empty)",
  };
}

function renderFileEditPanel() {
  const proposal = selectedFileEditProposal();
  state.fileEditProposal = proposal;
  const decision = proposal ? state.fileEditDecisions.get(proposal.key) : null;
  const visible = Boolean(proposal);
  $("#fileEditPanel").classList.toggle("hidden", !visible);
  if (!visible) return;
  $("#fileEditPath").textContent = proposal.path;
  const summaryState = decision === "accepted"
    ? "Already applied"
    : decision === "rejected"
      ? "Rejected"
      : "Review before applying";
  $("#fileEditSummary").textContent = `${fileEditOperationLabel(proposal.operation)} · ${summaryState}`;
  const preview = contextualFileEditPreview(proposal);
  $("#fileEditBefore").textContent = boundedFileEditPreview(preview.before, 4000);
  $("#fileEditAfter").textContent = boundedFileEditPreview(preview.after, 8000);
  const accepted = decision === "accepted";
  const rejected = decision === "rejected";
  const undoAvailable = accepted && state.fileEditUndo?.key === proposal.key;
  renderFileEditDecisionNote(decision, undoAvailable);
  $("#fileEditAccept").classList.toggle("hidden", accepted || rejected);
  $("#fileEditReject").classList.toggle("hidden", accepted || rejected);
  $("#fileEditUndo").classList.toggle("hidden", !undoAvailable);
}

async function projectFileContent(path) {
  if (state.activeDocument === path) {
    syncDocumentFromEditor({ render: false, persist: false });
  }
  if (state.documents[path]) return state.documents[path].content;
  if (state.closedDrafts[path]) return state.closedDrafts[path].draft_content;
  const result = await invoke("project_read_file", { path });
  return result.content || "";
}

function calculateProposedFileEdit(proposal, beforeContent) {
  const context = proposal.editorContext || {};
  const inserted = String(proposal.content || "");
  if (proposal.operation === "create") {
    return { content: inserted, start: 0, end: inserted.length };
  }
  if (proposal.operation === "append") {
    return { content: beforeContent + inserted, start: beforeContent.length, end: beforeContent.length + inserted.length };
  }
  if (context.active_path !== proposal.path) {
    throw new Error(`${fileEditOperationLabel(proposal.operation)} requires the proposal target to remain the active file.`);
  }
  const start = Number(context.selection_start);
  const end = Number(context.selection_end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > beforeContent.length) {
    throw new Error("The saved editor range is no longer valid. Ask the Agent to create a fresh proposal.");
  }
  if (proposal.operation === "replace_selection") {
    if (start === end || beforeContent.slice(start, end) !== String(context.selection_text || "")) {
      throw new Error("The selected text changed after this proposal was created. Ask the Agent to regenerate it.");
    }
  } else if (proposal.operation === "insert_at_cursor") {
    const beforeAnchor = String(context.anchor_before || "");
    const afterAnchor = String(context.anchor_after || "");
    if (!beforeContent.slice(Math.max(0, start - beforeAnchor.length), start).endsWith(beforeAnchor)
      || !beforeContent.slice(end, end + afterAnchor.length).startsWith(afterAnchor)) {
      throw new Error("The cursor context changed after this proposal was created. Ask the Agent to regenerate it.");
    }
  } else {
    throw new Error(`Unsupported file edit operation: ${proposal.operation}`);
  }
  return {
    content: beforeContent.slice(0, start) + inserted + beforeContent.slice(end),
    start,
    end: start + inserted.length,
  };
}

function clearAgentEditHighlight() {
  if (state.editor.editor && state.editor.highlightDecorations.length) {
    state.editor.highlightDecorations = state.editor.editor.deltaDecorations(state.editor.highlightDecorations, []);
  }
}

function highlightAgentEdit(path, start, end) {
  if (state.activeDocument !== path) return;
  const documentState = state.documents[path];
  documentState.cursorStart = end;
  documentState.cursorEnd = end;
  applyDocumentSelection(documentState);
  if (state.editor.mode !== "monaco" || !state.editor.editor?.getModel()) return;
  const model = state.editor.editor.getModel();
  const startPosition = model.getPositionAt(start);
  const endPosition = model.getPositionAt(Math.max(start, end));
  const range = new state.editor.monaco.Range(
    startPosition.lineNumber,
    startPosition.column,
    endPosition.lineNumber,
    endPosition.column,
  );
  state.editor.highlightDecorations = state.editor.editor.deltaDecorations(
    state.editor.highlightDecorations,
    [{ range, options: { inlineClassName: "agent-edit-highlight" } }],
  );
  state.editor.editor.revealRangeInCenter(range);
}

async function updateDocumentAfterFileEdit(path, content, start, end) {
  if (!state.documents[path]) {
    await openDocument(path, { forceReload: true });
  } else {
    const documentState = state.documents[path];
    documentState.content = content;
    documentState.savedContent = content;
    documentState.conflictDiskContent = null;
    documentState.cursorStart = end;
    documentState.cursorEnd = end;
    ensureDocumentModel(documentState);
    state.activeDocument = path;
    renderActiveDocument();
  }
  highlightAgentEdit(path, start, end);
  renderProjectFiles();
  renderDocumentTabs();
  scheduleSessionSave();
}

async function acceptFileEditProposal() {
  const proposal = state.fileEditProposal;
  if (!proposal) return;
  const button = $("#fileEditAccept");
  button.disabled = true;
  try {
    const exists = state.project.files.some((file) => file.path === proposal.path);
    if (proposal.operation === "create" && exists) {
      throw new Error(`Cannot create ${proposal.path}: the file already exists.`);
    }
    if (proposal.operation !== "create" && !exists) {
      throw new Error(`Cannot edit ${proposal.path}: the file does not exist.`);
    }
    const beforeContent = proposal.operation === "create" ? "" : await projectFileContent(proposal.path);
    const edit = calculateProposedFileEdit(proposal, beforeContent);
    state.internalProjectWrites.set(proposal.path, { content: edit.content, expiresAt: Date.now() + 5000 });
    state.project = await invoke(
      proposal.operation === "create" ? "project_create_file" : "project_write_file",
      { path: proposal.path, content: edit.content },
    );
    delete state.closedDrafts[proposal.path];
    await updateDocumentAfterFileEdit(proposal.path, edit.content, edit.start, edit.end);
    state.fileEditUndo = {
      key: proposal.key,
      path: proposal.path,
      beforeContent,
      afterContent: edit.content,
      created: proposal.operation === "create",
      start: edit.start,
    };
    state.fileEditDecisions.set(proposal.key, "accepted");
    persistFileEditDecisions();
    scheduleSessionSave();
    renderFileEditPanel();
    toast(`Applied Agent edit to ${proposal.path}.`);
  } catch (error) {
    state.internalProjectWrites.delete(proposal.path);
    toast(String(error), true);
  } finally {
    button.disabled = false;
  }
}

function rejectFileEditProposal() {
  const proposal = state.fileEditProposal;
  if (!proposal) return;
  state.fileEditDecisions.set(proposal.key, "rejected");
  persistFileEditDecisions();
  renderFileEditPanel();
  toast(`Rejected Agent edit for ${proposal.path}.`);
}

async function undoFileEditProposal() {
  const undo = state.fileEditUndo;
  if (!undo) return;
  const button = $("#fileEditUndo");
  button.disabled = true;
  try {
    const current = await projectFileContent(undo.path);
    if (current !== undo.afterContent) {
      throw new Error("The file changed after the Agent edit, so automatic undo was stopped.");
    }
    if (undo.created) {
      state.project = await invoke("project_delete_file", { path: undo.path });
      if (state.documents[undo.path]) closeDocument(undo.path);
    } else {
      state.internalProjectWrites.set(undo.path, { content: undo.beforeContent, expiresAt: Date.now() + 5000 });
      state.project = await invoke("project_write_file", { path: undo.path, content: undo.beforeContent });
      await updateDocumentAfterFileEdit(undo.path, undo.beforeContent, undo.start, undo.start);
    }
    state.fileEditDecisions.set(undo.key, "undone");
    state.fileEditUndo = null;
    persistFileEditDecisions();
    scheduleSessionSave();
    renderFileEditPanel();
    renderProjectFiles();
    renderDocumentTabs();
    toast(`Undid Agent edit in ${undo.path}.`);
  } catch (error) {
    toast(String(error), true);
  } finally {
    button.disabled = false;
  }
}

function hideAgentFileMentions() {
  state.agentFileMention = { items: [], index: 0, start: -1, end: -1, mode: "mention", contextSource: null };
  $("#agentFileMentions").classList.add("hidden");
  $("#agentFileMentions").replaceChildren();
}

function insertAgentFileMention(path) {
  const { start, end, contextSource } = state.agentFileMention;
  insertAgentReference(path, {
    source: contextSource,
    range: start >= 0 ? { start, end } : null,
  });
  hideAgentFileMentions();
  closeAgentContextMenu();
}

function renderAgentFileMentions() {
  const panel = $("#agentFileMentions");
  panel.replaceChildren();
  state.agentFileMention.items.forEach((path, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `agent-file-mention${index === state.agentFileMention.index ? " active" : ""}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", index === state.agentFileMention.index ? "true" : "false");
    button.textContent = path;
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => insertAgentFileMention(path));
    panel.append(button);
  });
  panel.classList.toggle("hidden", !state.agentFileMention.items.length);
}

function updateAgentFileMentions() {
  const input = $("#agentInput");
  if (state.agentFileMention.mode === "picker") return;
  const mention = parseAgentMentionInput(input.value, input.selectionStart);
  if (!mention) {
    hideAgentFileMentions();
    return;
  }
  const items = rankedProjectFileMentions(mention.query);
  state.agentFileMention = {
    items,
    index: 0,
    start: mention.start,
    end: mention.end,
    mode: "mention",
    contextSource: ["editor", "project_file"].includes(state.agentContextSource) ? "project_file" : null,
  };
  renderAgentFileMentions();
}

async function sendAgentPrompt() {
  const prompt = $("#agentInput").value.trim();
  if (!prompt || state.agentBusy) return;
  const selectedModelId = state.agentLlm.selectedModelId || state.agentLlm.settings?.selected_model_id || null;
  if (!selectedModelId) {
    toast(agentSendDisabledReason() || "No Agent model is selected.", true);
    return;
  }
  hideAgentFileMentions();
  closeAgentModelSelector();
  closeAgentContextMenu();
  $("#agentInput").value = "";
  setAgentInputBusy(true);
  applyWorkbenchLayout("agent");
  $("#agentState").textContent = "Working";
  $("#agentStateDot").className = "agent-state-dot busy";
  try {
    const editorContext = buildAgentEditorContext();
    const response = await invoke("run_agent", {
      prompt,
      mode: state.agentMode,
      modelId: selectedModelId,
      autoApprove: state.agentMode === "act" && state.actAutoApprove,
      editorContext,
    });
    resetAgentContext();
    state.activeAgentTurnId = response?.turn_id || null;
    await Promise.all([loadAgentData(), loadRunData()]);
  } catch (error) {
    const message = String(error);
    $("#agentState").textContent = "Failed";
    $("#agentStateDot").className = "agent-state-dot error";
    setAgentInputBusy(false);
    toast(message, true);
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

function applyWorkbenchLayout(layout) {
  $(".app-shell").classList.toggle("layout-code", layout === "code");
  $$("[data-layout]").forEach((button) => button.classList.toggle("active", button.dataset.layout === layout));
  if (layout === "agent") switchContextTab("agent");
  if (layout === "analyze") switchContextTab("environment");
  if (layout === "agent") setAgentComposerHeight(Number($("#agentComposerResizeHandle").getAttribute("aria-valuenow")), false);
  requestAnimationFrame(() => layoutEditor());
}

function closeWorkbenchMenus(except = null) {
  $$('[data-menu-trigger]').forEach((trigger) => {
    const name = trigger.dataset.menuTrigger;
    const keepOpen = name === except;
    trigger.setAttribute("aria-expanded", String(keepOpen));
    $(`[data-menu="${name}"]`).hidden = !keepOpen;
  });
}

function runEditorMenuCommand(command) {
  if (state.editor.mode === "monaco" && state.editor.editor) {
    state.editor.editor.trigger("rho-menu", command, null);
    state.editor.editor.focus();
    return;
  }
  const editor = fallbackEditor();
  editor.focus();
  document.execCommand(command);
}

function runWorkbenchMenuCommand(command) {
  const actions = {
    "open-project": () => $("#projectSwitcher").click(),
    "new-file": () => $(".new-tab").click(),
    "save-file": () => $("#saveFileButton").click(),
    undo: () => runEditorMenuCommand("undo"),
    redo: () => runEditorMenuCommand("redo"),
    interrupt: () => $("#interruptButton").click(),
    restart: () => $("#restartButton").click(),
    "show-agent": () => applyWorkbenchLayout("agent"),
    "show-environment": () => applyWorkbenchLayout("analyze"),
    "render-document": () => {
      const button = $("#renderDocumentButton");
      if (button.disabled) {
        toast($("#renderDocumentHint").textContent, true);
      } else {
        button.click();
      }
    },
  };
  actions[command]?.();
}

const panelDefaults = {
  left: 214,
  right: 362,
  dock: 260,
};

function agentComposerLimits() {
  const height = $("#agentPanel").getBoundingClientRect().height;
  return [140, Math.max(140, height > 0 ? height - 180 : 480)];
}

function setAgentComposerHeight(requested, persist = true) {
  const limits = agentComposerLimits();
  const value = Math.round(clamp(Number(requested) || 190, limits[0], limits[1]));
  $("#agentPanel").style.setProperty("--agent-composer-height", `${value}px`);
  $("#agentComposerResizeHandle").setAttribute("aria-valuenow", String(value));
  if (persist) localStorage.setItem("rho.agentComposerHeight", String(value));
  return value;
}

function setupAgentComposerResizer() {
  const handle = $("#agentComposerResizeHandle");
  let active = false;
  let startingPointer = 0;
  let startingHeight = 0;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    active = true;
    startingPointer = event.clientY;
    startingHeight = Number(handle.getAttribute("aria-valuenow")) || 190;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("active");
    document.body.classList.add("resizing", "resizing-horizontal");
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (!active) return;
    setAgentComposerHeight(startingHeight - (event.clientY - startingPointer));
  });
  const stop = (event) => {
    if (!active) return;
    active = false;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    handle.classList.remove("active");
    document.body.classList.remove("resizing", "resizing-horizontal");
  };
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  handle.addEventListener("dblclick", () => setAgentComposerHeight(190));
  handle.addEventListener("keydown", (event) => {
    const amount = event.shiftKey ? 40 : 12;
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const current = Number(handle.getAttribute("aria-valuenow")) || 190;
    setAgentComposerHeight(current + (event.key === "ArrowUp" ? amount : -amount));
  });
  const stored = Number(localStorage.getItem("rho.agentComposerHeight"));
  $("#agentPanel").style.setProperty("--agent-composer-height", `${Number.isFinite(stored) && stored > 0 ? stored : 190}px`);
  handle.setAttribute("aria-valuenow", String(Number.isFinite(stored) && stored > 0 ? stored : 190));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function panelLimits() {
  const shell = $(".app-shell").getBoundingClientRect();
  const workspace = $(".workspace").getBoundingClientRect();
  const currentLeft = Number($("#leftResizeHandle").getAttribute("aria-valuenow")) || panelDefaults.left;
  const currentRight = Number($("#rightResizeHandle").getAttribute("aria-valuenow")) || panelDefaults.right;
  const minimumWorkspaceWidth = 420;
  return {
    left: [160, Math.max(160, Math.min(380, shell.width - currentRight - minimumWorkspaceWidth))],
    right: [280, Math.max(280, Math.min(520, shell.width - currentLeft - minimumWorkspaceWidth))],
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
  if (panel === "dock") requestAnimationFrame(() => layoutEditor());
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
  setupAgentComposerResizer();
  window.addEventListener("resize", () => {
    setPanelSize("left", Number($("#leftResizeHandle").getAttribute("aria-valuenow")), false);
    setPanelSize("right", Number($("#rightResizeHandle").getAttribute("aria-valuenow")), false);
    setPanelSize("dock", Number($("#dockResizeHandle").getAttribute("aria-valuenow")), false);
    if (!$("#agentPanel").classList.contains("hidden")) {
      setAgentComposerHeight(Number($("#agentComposerResizeHandle").getAttribute("aria-valuenow")), false);
    }
  });
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
    const changedPaths = payload.changed_paths || [];
    await refreshProject();
    const externalPaths = [];
    let matchedInternalWrite = false;
    for (const path of changedPaths) {
      if (!path) continue;
      const pending = state.internalProjectWrites.get(path);
      if (pending && pending.expiresAt < Date.now()) {
        state.internalProjectWrites.delete(path);
      }
      let selfGenerated = false;
      if (pending && pending.expiresAt >= Date.now()) {
        try {
          const result = await invoke("project_read_file", { path });
          selfGenerated = result.content === pending.content;
        } catch {
          selfGenerated = false;
        }
        if (selfGenerated) {
          matchedInternalWrite = true;
          state.internalProjectWrites.delete(path);
        }
      }
      if (!selfGenerated) {
        const documentState = state.documents[path];
        if (documentState && !documentIsDirty(documentState)) {
          try {
            const result = await invoke("project_read_file", { path });
            selfGenerated = result.content === documentState.savedContent;
          } catch {
            selfGenerated = false;
          }
        }
      }
      if (!selfGenerated) externalPaths.push(path);
    }
    if (changedPaths.includes("") && !matchedInternalWrite) externalPaths.push("");
    if (externalPaths.length) {
      try {
        updateIdentity(await invoke("project_mark_files_changed"));
      } catch (error) {
        console.warn("Could not advance project revision after a file change", error);
      }
    }
    for (const path of externalPaths) {
      await handleExternalDocumentChange(path);
    }
  });
}

async function handleExternalDocumentChange(path) {
  const document = state.documents[path];
  if (!document) return;
  const stillExists = state.project.files.some((file) => file.path === path);
  if (!stillExists) {
    if (documentIsDirty(document)) {
      document.conflictDiskContent = "";
      renderProjectFiles();
      renderDocumentTabs();
      toast(`${path} was removed on disk. Your local draft is preserved; Save will recreate it.`, true);
      scheduleSessionSave();
    } else {
      closeDocument(path);
      toast(`Closed ${path} after it was removed on disk.`);
    }
    return;
  }
  try {
    const result = await invoke("project_read_file", { path });
    const diskContent = result.content || "";
    if (diskContent === document.savedContent) return;
    if (diskContent === document.content) {
      document.savedContent = diskContent;
      document.conflictDiskContent = null;
      renderDocumentTabs();
      scheduleSessionSave();
      return;
    }
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
  closeAgentContextMenu();
  hideAgentFileMentions();
  clearAgentEditHighlight();
  resetAgentContext();
  state.fileEditProposal = null;
  state.fileEditUndo = null;
  state.documents = {};
  state.closedDrafts = {};
  state.expandedDirectories.clear();
  state.collapsedDirectories.clear();
  state.activeDocument = null;
  state.editor.models.forEach((model) => model.dispose());
  state.editor.models.clear();
  state.project = response.project || { root: "", files: [], truncated: false };
  state.fileEditDecisions = loadFileEditDecisions(state.project.root);
  const session = loadEmergencySession(state.project.root) || response.session || {};
  for (const entry of session.closed_documents || []) {
    if (!entry?.path || entry.draft_content === null || entry.draft_content === undefined) continue;
    state.closedDrafts[entry.path] = {
      draft_content: entry.draft_content,
      cursor_start: entry.cursor_start ?? 0,
      cursor_end: entry.cursor_end ?? 0,
    };
  }
  applySessionPanels(session.panels || {});
  setProjectStatus("ready");
  const sessionDocuments = session.open_documents || [];
  const activeDocumentPath = session.active_document;
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
    state.agentRuntime = status.agent_runtime || null;
    updateIdentity(status.workspace);
    $("#rVersion").textContent = status.r_version || "R";
    setKernelStatus("idle", "R idle");
    addConsole("SYSTEM", `${status.r_version} · Ark PID ${status.kernel_pid}`);
    await loadAgentLlmSettings();
    const response = await invoke("project_restore_session");
    if (response.status === "ready") {
      await hydrateProject(response);
    } else if (response.status === "unavailable") {
      state.project = { root: "", files: [], truncated: false };
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
  clearAgentEditHighlight();
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
  syncDocumentFromEditor({ render: false, persist: false });
  persistEmergencySession();
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
$$("[data-context-tab]").forEach((button) => button.addEventListener("click", () => {
  applyWorkbenchLayout(button.dataset.contextTab === "agent" ? "agent" : "analyze");
}));
$$("[data-side-tab]").forEach((button) => button.addEventListener("click", () => {
  $$("[data-side-tab]").forEach((value) => value.classList.toggle("active", value === button));
  $("#filesPanel").classList.toggle("hidden", button.dataset.sideTab !== "files");
  $("#runsPanel").classList.toggle("hidden", button.dataset.sideTab !== "runs");
}));
$$("[data-agent-mode]").forEach((button) => button.addEventListener("click", () => {
  state.agentMode = button.dataset.agentMode;
  $$("[data-agent-mode]").forEach((value) => value.classList.toggle("active", value === button));
}));
$("#actAutoApprove").addEventListener("change", (event) => {
  state.actAutoApprove = Boolean(event.target.checked);
});
$("#agentModelSelector").addEventListener("click", (event) => {
  event.stopPropagation();
  if (state.agentLlm.selectorOpen) closeAgentModelSelector();
  else openAgentModelSelector();
});
$("#agentModelSelector").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    openAgentModelSelector(event.key === "ArrowUp" ? "last" : "first");
  }
});
$("#agentModelSelectorMenu").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveAgentModelMenuFocus(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    focusAgentModelMenuItem(event.key === "End" ? "last" : "first");
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeAgentModelSelector();
    $("#agentModelSelector").focus();
  }
});
$("#agentLlmClose").addEventListener("click", closeAgentLlmDialog);
$("#agentLlmDialog").addEventListener("click", (event) => {
  if (event.target?.dataset?.agentLlmClose === "true") closeAgentLlmDialog();
});
$("#agentLlmAddProvider").addEventListener("click", clearAgentProviderForm);
$("#agentLlmSaveProvider").addEventListener("click", saveAgentProvider);
$("#agentLlmDeleteProvider").addEventListener("click", deleteAgentProvider);
$("#agentLlmReloadCredentials").addEventListener("click", reloadAgentCredentials);
$("#agentLlmOpenEnviron").addEventListener("click", openAgentUserEnviron);
$("#agentLlmCopySetupLine").addEventListener("click", copyAgentSetupLine);
$("#agentLlmAddModel").addEventListener("click", clearAgentModelForm);
$("#agentLlmLoadCatalog").addEventListener("click", loadAgentLlmCatalog);
$("#agentLlmCatalogModel").addEventListener("change", applySelectedCatalogModel);
$("#agentLlmModelProvider").addEventListener("change", renderAgentLlmCatalogOptions);
$("#agentLlmSaveModel").addEventListener("click", saveAgentModel);
$("#agentLlmDeleteModel").addEventListener("click", deleteAgentModel);
$("#agentLlmTestModel").addEventListener("click", testAgentModelConnection);
$("#agentLlmCancelTest").addEventListener("click", cancelAgentModelTest);
$("#agentLlmSelectDefault").addEventListener("click", selectAgentDefaultModel);
$$("[data-layout]").forEach((button) => button.addEventListener("click", () => {
  applyWorkbenchLayout(button.dataset.layout);
}));

$("#agentSendButton").addEventListener("click", sendAgentPrompt);
$("#agentCancelButton").addEventListener("click", async () => {
  const turnId = state.activeAgentTurnId;
  if (!turnId) return;
  $("#agentCancelButton").disabled = true;
  try {
    await invoke("cancel_agent_turn", { turnId });
    await Promise.all([loadAgentData(), loadRunData()]);
  } catch (error) {
    toast(String(error), true);
  } finally {
    $("#agentCancelButton").disabled = false;
  }
});
$("#clearAgentHistoryButton").addEventListener("click", async () => {
  if (!window.confirm("Clear all Agent history?")) return;
  try {
    await invoke("clear_agent_history");
    state.selectedTurnId = null;
    state.selectedTurnDetail = null;
    state.fileEditProposal = null;
    state.fileEditUndo = null;
    state.fileEditDecisions = new Map();
    clearFileEditDecisions();
    clearAgentEditHighlight();
    await Promise.all([loadAgentData(), loadRunData()]);
    toast("Agent history cleared.");
  } catch (error) {
    toast(`Could not clear Agent history: ${error}`, true);
  }
});
$("#agentInput").addEventListener("keydown", (event) => {
  if (hasVisibleAgentFileMentions()) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveAgentFileMention(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveAgentFileMention(-1);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insertAgentFileMention(state.agentFileMention.items[state.agentFileMention.index]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      hideAgentFileMentions();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendAgentPrompt();
  }
});
$("#agentInput").addEventListener("input", updateAgentFileMentions);
$("#agentInput").addEventListener("input", syncAgentContextFromInput);
$("#agentInput").addEventListener("click", updateAgentFileMentions);
$("#agentInput").addEventListener("keyup", (event) => {
  if (["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)) return;
  updateAgentFileMentions();
});
$("#fileEditAccept").addEventListener("click", acceptFileEditProposal);
$("#fileEditReject").addEventListener("click", rejectFileEditProposal);
$("#fileEditUndo").addEventListener("click", undoFileEditProposal);
$("#agentContextButton").addEventListener("click", (event) => {
  event.stopPropagation();
  if ($("#agentContextMenu").classList.contains("hidden")) {
    openAgentContextMenu();
  } else {
    closeAgentContextMenu();
  }
});
$("#agentContextChooseFile").addEventListener("click", () => {
  closeAgentContextMenu();
  showAgentProjectFilePicker("project_file");
});
$("#agentContextUseCurrentFile").addEventListener("click", () => {
  const documentState = activeDocument();
  if (!documentState) return;
  insertAgentReference(documentState.path, { source: "current_file" });
  closeAgentContextMenu();
});
$("#agentContextUseSelection").addEventListener("click", () => {
  const documentState = activeDocument();
  if (!documentState || !activeSelectionExists()) return;
  insertAgentReference(documentState.path, { source: "selection" });
  closeAgentContextMenu();
});
$("#agentContextNewFile").addEventListener("click", () => {
  const value = window.prompt("New project-relative path", "report.qmd");
  if (!value) {
    closeAgentContextMenu();
    return;
  }
  try {
    const path = validateProjectRelativePath(value);
    insertAgentReference(path, { source: "new_file" });
    closeAgentContextMenu();
  } catch (error) {
    toast(String(error), true);
  }
});
$("#refreshEnvironment").addEventListener("click", refreshEnvironment);
$("#environmentSearch").addEventListener("input", renderEnvironment);
$("#renderDocumentButton").addEventListener("click", renderActiveDocumentFile);
$("#renderOpenSourceButton").addEventListener("click", async () => {
  if (!state.lastRender?.sourcePath) return;
  await openDocument(state.lastRender.sourcePath);
});
$("#renderShowProblemsButton").addEventListener("click", () => {
  if (!latestRenderProblem()) return;
  switchDockTab("problems");
});
$("#renderShowPlotsButton").addEventListener("click", () => {
  if (!state.lastRender?.sourcePath) return;
  switchDockTab("plots");
});
$("#plotsShortcut").addEventListener("click", () => switchDockTab("plots"));
async function clearPlots(sessionOnly) {
  const scope = sessionOnly ? "this session" : "this project";
  if (!window.confirm(`Clear plots from ${scope}?`)) return;
  try {
    await invoke("clear_plot_artifacts", { session_only: sessionOnly });
    await loadRunData();
    toast(`Cleared plots from ${scope}.`);
  } catch (error) {
    toast(`Could not clear plots: ${error}`, true);
  }
}
$("#clearSessionPlotsButton").addEventListener("click", () => clearPlots(true));
$("#clearProjectPlotsButton").addEventListener("click", () => clearPlots(false));
$$('[data-plot-scope]').forEach((button) => button.addEventListener("click", async () => {
  state.plotScope = button.dataset.plotScope;
  await loadRunData();
}));
$("#toggleDockMaximize").addEventListener("click", toggleDockMaximize);
$$('[data-menu-trigger]').forEach((trigger) => trigger.addEventListener("click", (event) => {
  event.stopPropagation();
  const name = trigger.dataset.menuTrigger;
  closeWorkbenchMenus(trigger.getAttribute("aria-expanded") === "true" ? null : name);
}));
$$('[data-menu-command]').forEach((item) => item.addEventListener("click", () => {
  closeWorkbenchMenus();
  runWorkbenchMenuCommand(item.dataset.menuCommand);
}));
document.addEventListener("click", (event) => {
  if (!event.target.closest(".menu-item")) closeWorkbenchMenus();
  if (!event.target.closest("#agentContextButton") && !event.target.closest("#agentContextMenu")) {
    closeAgentContextMenu();
  }
  if (!event.target.closest("#agentModelSelector") && !event.target.closest("#agentModelSelectorMenu")) {
    closeAgentModelSelector();
  }
  if (!event.target.closest("#agentInput") && !event.target.closest("#agentFileMentions")) {
    hideAgentFileMentions();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeWorkbenchMenus();
    hideAgentFileMentions();
    closeAgentModelSelector();
    closeAgentLlmDialog();
    clearAgentEditHighlight();
  }
});
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
      ? await invoke("cancel_run", { runId: state.activeRunId })
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
    state.environment = null;
    state.selectedObjectName = null;
    state.selectedObjectDetail = null;
    renderEnvironment();
    addConsole("SYSTEM", `Workspace restarted · Ark PID ${status.kernel_pid}`);
    await loadRunData();
  } catch (error) {
    setKernelStatus("error", "R unavailable");
    toast(String(error), true);
  }
});

initialize();
