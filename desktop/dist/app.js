const tauriInvoke = window.__TAURI__?.core?.invoke;
const isDesktop = typeof tauriInvoke === "function";
const tauriEvent = window.__TAURI__?.event;
const previewParams = new URLSearchParams(window.location.search);
const mockPlatformFixture = previewParams.get("platform") === "macos-aarch64"
  ? {
      platform: "macos-aarch64",
      rscript: "/Library/Frameworks/R.framework/Resources/bin/Rscript",
      logPath: "/Users/researcher/Library/Logs/Rho/startup.log",
      projectRoot: "/Users/researcher/Documents/Rho Mac 研究",
      alternateProjectRoot: "/Users/researcher/Documents/Rho Demo",
    }
  : {
      platform: "windows-x86_64",
      rscript: "C:/Program Files/R/R-4.6.0/bin/Rscript.exe",
      logPath: "C:/Users/example/AppData/Local/Rho/logs/startup.log",
      projectRoot: "D:/Rho",
      alternateProjectRoot: "D:/Rho-demo",
    };

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const initialEditorContent = $("#editor")?.value || "";

const state = {
  startupBusy: false,
  startupView: null,
  startupPrepared: false,
  product: { appInfo: null, updateResult: null, updateBusy: false, dialog: null, returnFocus: null },
  busy: false,
  consoleHistory: [],
  consoleHistoryIndex: -1,
  consoleDraft: "",
  agentMode: "ask",
  actAutoApprove: false,
  posture: "human",
  agentSurface: "direct",
  agentWorkSurface: "none",
  agentSelectedOutput: null,
  humanPreset: "code",
  auditResult: null,
  auditLoading: false,
  auditBlockedFiles: [],
  auditRequestSequence: 0,
  editorFunctions: null,
  editorFunctionsLoaded: false,
  agentBusy: false,
  agentSubmissionPending: false,
  activeAgentTurnId: null,
  agentRuntime: null,
  projectSkills: { project_root: "", trust_status: "untrusted_project_content", skills: [], discovery_error: null },
  projectRefreshSequence: 0,
  agentRefreshRequestSequence: 0,
  agentLlm: {
    settings: null,
    activeView: "connections",
    selectedRouteCapability: "agent.chat",
    routingFocusModelId: null,
    routingExpandedCapability: null,
    settingsLoading: false,
    selectedModelId: null,
    selectorOpen: false,
    settingsOpen: false,
    selectedProviderId: null,
    editingProviderId: null,
    selectedModelEditorId: null,
    editingModelId: null,
    lastTestResult: null,
    testInFlight: false,
    discoverySequence: 0,
    wizardDiscovery: { requestId: 0, providerId: null, status: "idle", models: [], truncated: false, message: "" },
    modelDiscovery: { requestId: 0, providerId: null, status: "idle", models: [], truncated: false, message: "" },
    operation: { state: "idle", message: "" },
    wizardOperation: { state: "idle", message: "" },
    modelOperation: { state: "idle", message: "" },
    wizardOpen: false,
    wizardStep: "connection",
    wizardProviderId: null,
    wizardModelId: null,
    modelDialogOpen: false,
    returnFocusElement: null,
    wizardReturnFocusElement: null,
    modelReturnFocusElement: null,
  },
  objects: [],
  plots: [],
  artifacts: [],
  plotScope: "session",
  selectedPlotId: null,
  selectedArtifactId: null,
  selectedArtifactDetail: null,
  viewer: {
    open: false,
    busy: false,
    mode: "both",
    kind: null,
    path: null,
    title: null,
    mediaType: null,
    content: "",
    sourceContent: "",
    projectRoot: null,
    sourcePath: null,
    artifactId: null,
    notice: null,
    error: null,
  },
  evidenceEntries: [],
  evidenceClaims: [],
  evidenceClaimReviews: new Map(),
  evidenceClaimArtifacts: [],
  evidenceClaimArtifactsError: null,
  evidenceClaimPreviewProbe: null,
  evidenceTab: "entries",
  claimAnchorKind: "source_range",
  gitStatus: null,
  gitReview: {
    loading: false,
    error: null,
    working: [],
    staged: [],
    stagedRevision: "",
    selectedPath: null,
    selectedStaged: false,
    diff: null,
    projectRoot: "",
  },
  environment: null,
  environmentRefreshRequestId: 0,
  installedPackages: null,
  lockfilePackages: null,
  environmentPackageTab: "installed",
  packageInventoryDialog: { open: false, returnFocus: null },
  environmentOperations: [],
  environmentOperationDialog: { requestId: null, busy: false, phase: "", returnFocus: null },
  environmentOperationPollTimer: null,
  packageManagementDialog: { busy: false, returnFocus: null },
  localHelp: { status: "empty", record: null, error: null },
  agentLocalHelpContext: null,
  installedHelp: { status: "empty", record: null, error: null, activeView: "overview", running: false },
  projectReferences: { status: "empty", record: null, error: null },
  selectedObjectName: null,
  selectedObjectDetail: null,
  selectedDataObjectDetail: null,
  selectedDataPage: null,
  dataViewerRefreshPreviewProbe: null,
  dataViewer: {
    busy: false,
    loadingPage: false,
    rowOffset: 0,
    rowLimit: 50,
    columnOffset: 0,
    columnLimit: 20,
    workspace: null,
    query: null,
    error: null,
    queryTimer: null,
    pageRequestId: 0,
    inspectionRequestId: 0,
    viewKind: null,
    viewKey: null,
    sortColumn: null,
    sortDirection: null,
  },
  previewScenarioApplied: false,
  objectInspection: null,
  lastRender: null,
  renderJob: null,
  runs: [],
  compareMode: false,
  compareLeft: null,
  compareRight: null,
  compareResult: null,
  problems: [],
  problemRefreshRequestSequence: 0,
  problemRefreshAppliedSequence: 0,
  problemRefreshProjectRoot: "",
  consoleRepairEntries: new Map(),
  consoleRepairSequence: 0,
  consoleRepairPreviewProbe: null,
  lint: { status: "idle", response: null, proposal: null, projectRoot: null, error: null },
  refactor: { status: "idle", proposal: null, undo: null, error: null, returnFocus: null },
  agentConversations: [],
  agentTurns: [],
  agentActivityExpanded: new Set(),
  pendingApprovals: [],
  selectedConversationId: null,
  selectedTurnId: null,
  selectedTurnDetail: null,
  fileEditProposal: null,
  fileEditUndo: null,
  fileEditUndoVerifiedKey: null,
  fileEditDecisions: new Map(),
  actAuthorizedTurnIds: new Set(),
  fileEditAutoApplyAttempts: new Set(),
  fileEditApplyBusy: false,
  agentFileMention: { items: [], index: 0, start: -1, end: -1, mode: "mention", contextSource: null },
  agentContextSource: "editor",
  agentContextPath: null,
  agentDiagnostic: null,
  agentProblemRunContext: null,
  problemRepairPreviewProbe: null,
  agentPollTimer: null,
  activeRunId: null,
  agentReviewRunId: null,
  agentReviewRunDetail: null,
  agentReviewRunLoading: false,
  agentReviewRunError: null,
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
    fallbackHistories: new Map(),
    suppressChange: false,
    highlightDecorations: [],
  },
};

function stringValues(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value === null || value === undefined || value === "") return [];
  return [String(value)];
}

const mockProjects = {
  [mockPlatformFixture.projectRoot]: {
    files: [
      { path: "analysis.R", name: "analysis.R", kind: "source", size_bytes: 120 },
      { path: "examples/editor-intelligence.R", name: "editor-intelligence.R", kind: "source", size_bytes: 420 },
      { path: "examples/editor-formatting.R", name: "editor-formatting.R", kind: "source", size_bytes: 180 },
      { path: "examples/editor-refactor-use.R", name: "editor-refactor-use.R", kind: "source", size_bytes: 120 },
      { path: "examples/single-cell-qc/03-visualize-qc.R", name: "03-visualize-qc.R", kind: "source", size_bytes: 164 },
      { path: "report.Rmd", name: "report.Rmd", kind: "source", size_bytes: 92 },
      { path: "report.qmd", name: "report.qmd", kind: "source", size_bytes: 96 },
      { path: "reports/claim-review-demo.qmd", name: "claim-review-demo.qmd", kind: "source", size_bytes: 360 },
      { path: "scratch.R", name: "scratch.R", kind: "source", size_bytes: 420 },
    ],
    contents: {
      "analysis.R": "# Project analysis\nsummary(qc)\n",
      "examples/editor-intelligence.R": "flag_low_quality <- function(features, mito_percent, doublet_score) {\n  features < 300 | mito_percent > 20 | doublet_score > 0.30\n}\n\ndata$needs_review <- flag_low_quality(data$n_features, data$mito_percent, data$doublet_score)\n\nexample_value<-stats::median(c(1, 3, 5))\n",
      "examples/editor-formatting.R": "# Formatting review keeps comments and explicit save control\nthreshold<-20\nreview_rows<-subset(data,mito_percent>threshold)\nreview_rows\n",
      "examples/single-cell-qc/03-visualize-qc.R": "library(ggplot2)\nggplot(qc, aes(library_size, mitochondrial_percent)) + geom_point()\n",
      "examples/editor-refactor-use.R": "review_subset <- flag_low_quality(data$n_features, data$mito_percent, data$doublet_score)\n",
      "report.Rmd": "---\ntitle: QC report\noutput: html_document\n---\n\n```{r}\nsummary(qc)\n```\n",
      "report.qmd": "---\ntitle: QC report\nformat: html\n---\n\n```{r}\nsummary(qc)\n```\n",
      "reports/claim-review-demo.qmd": "---\ntitle: Claim review demo\nformat: html\n---\n\n# Findings\n\ncontrol <- c(4, 5, 6)\ntreatment <- c(7, 8, 9)\n\n## Result\nThe treatment group has a higher mean response.\nThis second line completes the recorded claim range.\n\nmean(treatment) - mean(control)\n",
      "scratch.R": "# Live analysis in Workspace R\nset.seed(42)\nqc <- data.frame(sample = paste0(\"S\", 1:12), reads = round(rlnorm(12, 11.2, 0.35)), detected = round(rnorm(12, 3200, 420)))\nsummary(qc)\nplot(qc$reads, qc$detected)\n",
    },
  },
  [mockPlatformFixture.alternateProjectRoot]: {
    files: [
      { path: "demo.R", name: "demo.R", kind: "source", size_bytes: 64 },
    ],
    contents: {
      "demo.R": "message('demo project')\n",
    },
  },
};

function emptyProjectSkillsView(projectRoot = "") {
  return {
    project_root: projectRoot,
    trust_status: "untrusted_project_content",
    skills: [],
    discovery_error: null,
  };
}

function mockProjectSkillsView(projectRoot = mockLastProject) {
  if (!projectRoot) return emptyProjectSkillsView("");
  return {
    project_root: projectRoot,
    trust_status: "untrusted_project_content",
    skills: [
      {
        id: "qc-notes",
        title: "Project QC notes",
        description: "Project-authored QC guidance for the current workspace.",
        trust_status: "untrusted_project_content",
        instructions_path: ".rho/skills/qc-notes.md",
        references: [".rho/skills/thresholds.json"],
      },
    ],
    discovery_error: null,
  };
}

// ── Product dialogs (replaces window.prompt/confirm) ──

function showProductDialog({ title, message, buttons, onClose }) {
  const dialog = document.getElementById("genericDialog");
  dialog.classList.remove("hidden");
  document.getElementById("genericDialogTitle").textContent = title;
  document.getElementById("genericDialogMessage").textContent = message || "";
  document.getElementById("genericDialogInputRow").classList.add("hidden");
  document.getElementById("genericDialogError").classList.add("hidden");
  const actions = document.getElementById("genericDialogActions");
  actions.replaceChildren();

  return new Promise((resolve) => {
    const cleanup = (result) => {
      dialog.classList.add("hidden");
      resolve(result);
    };
    document.getElementById("genericDialogClose").onclick = () => {
      if (onClose) onClose();
      cleanup(null);
    };
    document.querySelector("#genericDialog .product-dialog-scrim").onclick = () => {
      cleanup(null);
    };

    for (const btn of buttons) {
      const el = document.createElement("button");
      el.type = "button";
      el.textContent = btn.label;
      if (btn.primary) el.classList.add("primary");
      if (btn.destructive) el.style.cssText = "color:#fff;border-color:var(--danger);background:var(--danger)";
      el.addEventListener("click", () => cleanup(btn.key));
      actions.append(el);
    }
  });
}

function showInputDialog({ title, message, label, defaultValue, placeholder, validate }) {
  const dialog = document.getElementById("genericDialog");
  dialog.classList.remove("hidden");
  document.getElementById("genericDialogTitle").textContent = title;
  document.getElementById("genericDialogMessage").textContent = message || "";
  const inputRow = document.getElementById("genericDialogInputRow");
  inputRow.classList.remove("hidden");
  document.getElementById("genericDialogInputLabel").textContent = label || "";
  const input = document.getElementById("genericDialogInput");
  input.value = defaultValue || "";
  input.placeholder = placeholder || "";
  document.getElementById("genericDialogInputError").classList.add("hidden");
  document.getElementById("genericDialogError").classList.add("hidden");
  const actions = document.getElementById("genericDialogActions");
  actions.replaceChildren();

  return new Promise((resolve) => {
    const cleanup = (result) => {
      dialog.classList.add("hidden");
      resolve(result);
    };
    document.getElementById("genericDialogClose").onclick = () => cleanup(null);
    document.querySelector("#genericDialog .product-dialog-scrim").onclick = () => cleanup(null);

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => cleanup(null));
    actions.append(cancelBtn);

    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.textContent = "OK";
    okBtn.classList.add("primary");
    okBtn.addEventListener("click", () => {
      const value = input.value.trim();
      if (validate && !validate(value)) return;
      cleanup(value);
    });
    actions.append(okBtn);

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const value = input.value.trim();
        if (validate && !validate(value)) return;
        cleanup(value);
      }
    });

    input.focus();
  });
}

async function promptForPath({ title, message, defaultValue, validate, formatHint }) {
  const value = await showInputDialog({
    title: title || "Enter path",
    message: message || `Project-relative path under ${state.project.root || "project"}/`,
    label: "Project-relative path",
    defaultValue,
    placeholder: formatHint || "analysis.R",
    validate: (v) => {
      if (!v) { document.getElementById("genericDialogInputError").textContent = "Path is required."; document.getElementById("genericDialogInputError").classList.remove("hidden"); return false; }
      if (v.includes("..")) { document.getElementById("genericDialogInputError").textContent = "Use a clean project-relative path without . or .. segments."; document.getElementById("genericDialogInputError").classList.remove("hidden"); return false; }
      if (/^[A-Za-z]:[\\/]/.test(v)) { document.getElementById("genericDialogInputError").textContent = "Use a project-relative path, not an absolute path."; document.getElementById("genericDialogInputError").classList.remove("hidden"); return false; }
      if (validate && !validate(v)) return false;
      document.getElementById("genericDialogInputError").classList.add("hidden");
      return true;
    }
  });
  return value;
}

async function confirmAction({ title, message, confirmLabel, cancelLabel, destructive }) {
  const result = await showProductDialog({
    title: title || "Confirm",
    message,
    buttons: [
      { key: false, label: cancelLabel || "Cancel" },
      { key: true, label: confirmLabel || "Confirm", primary: true, destructive },
    ],
  });
  return result === true;
}

let mockLastProject = mockPlatformFixture.projectRoot;
const mockProjectSessions = {};
let mockRunSequence = 0;
const mockRuns = [];
const mockPlots = [];
const mockArtifacts = [];
let mockArtifactSequence = 0;
let mockAgentTurnSequence = 0;
let mockAgentConversationSequence = 0;
let mockApprovalSequence = 0;
let mockEnvironmentOperationSequence = 0;
const mockAgentTurns = [];
const mockAgentConversations = [];
const mockApprovalRequests = [];
const mockEnvironmentOperationRequests = [];
const mockEvidenceEntries = [];
const mockEvidenceClaims = [];
const mockRenderJobs = new Map();
let mockRenderSequence = 0;
let mockGitRevisionSequence = 1;
const mockGitReview = { working: [], staged: [] };
let mockGitFailureCommand = null;
let mockEvidenceClaimCreateFailure = null;
let mockAgentLlmFailure = previewParams.get("failure") || null;
let mockAgentLlmLoadFailureConsumed = false;
let mockAgentRunFailureOnce = null;
let mockProblemPreparationProjectSwitchOnce = false;
let mockProblemListFailureOnce = false;
let mockDataViewerInspectCount = 0;
let mockDataViewerReadCount = 0;

function seedMockEvidenceClaims() {
  const currentProject = mockLastProject;
  const foreignProject = Object.keys(mockProjects).find((root) => root !== currentProject) || `${currentProject}-foreign`;
  if (!mockEvidenceEntries.length) {
    mockEvidenceEntries.push(
      { id: 101, project_root: currentProject, title: "Treatment response study", notes: "Methods and outcome are inspectable.", doi: "10.1000/rho.demo", run_id: null, artifact_id: null, citation_json: null, created_at: "2026-08-03T08:00:00Z", updated_at: "2026-08-03T08:00:00Z" },
      { id: 102, project_root: currentProject, title: "Incomplete citation", notes: "", doi: null, run_id: null, artifact_id: null, citation_json: null, created_at: "2026-08-03T08:01:00Z", updated_at: "2026-08-03T08:01:00Z" },
      { id: 199, project_root: foreignProject, title: "FOREIGN PRIVATE EVIDENCE", notes: "Must not cross the project boundary.", doi: null, run_id: null, artifact_id: null, citation_json: null, created_at: "2026-08-03T08:02:00Z", updated_at: "2026-08-03T08:02:00Z" },
    );
  }
  if (!mockArtifacts.length) mockArtifacts.push(
    {
      artifact_id: "artifact_claim_demo", artifact_kind: "render_output", run_id: "run_claim_demo",
      project_root: currentProject, output_path: "reports/claim-review-demo.html",
      source_path: "reports/claim-review-demo.qmd", execution_mode: "render", document_version: 1,
      workspace_id: "ws_mock", state_revision: 1, project_revision: 1, media_type: "text/html",
      metadata_json: "{}", provenance_complete: true, incomplete_reason: null, created_at: "2026-08-03T08:05:00Z",
    },
    {
      artifact_id: "artifact_claim_foreign", artifact_kind: "render_output", run_id: "run_claim_foreign",
      project_root: foreignProject, output_path: "private/foreign-result.html",
      source_path: "private/foreign-analysis.qmd", execution_mode: "render", document_version: 1,
      workspace_id: "ws_foreign", state_revision: 1, project_revision: 1, media_type: "text/html",
      metadata_json: "{}", provenance_complete: true, incomplete_reason: null, created_at: "2026-08-03T08:06:00Z",
    },
  );
  const base = {
    project_root: currentProject, kind: "result", anchor_kind: "source_range",
    source_path: "reports/claim-review-demo.qmd", start_line: 12, start_column: null,
    end_line: 13, end_column: null, source_sha256: "a".repeat(64),
    source_excerpt: "The treatment group showed a bounded response in the demo analysis.",
    artifact_id: null, created_at: "2026-08-03T08:10:00Z", updated_at: "2026-08-03T08:10:00Z",
  };
  [
    ["linked", "Treatment response is linked to inspectable literature.", [101]],
    ["missing_evidence", "The secondary observation still needs a citation.", []],
    ["incomplete_evidence", "The sensitivity statement uses an incomplete citation.", [102]],
    ["unresolved_source", "This source range changed after claim creation.", [101]],
  ].forEach(([status, summary, ids], index) => mockEvidenceClaims.push({
    ...base, claim_id: `cl_mock_${index + 1}`, summary, linked_evidence_ids: ids, mock_status: status,
  }));
  mockEvidenceClaims.push({
    ...base,
    claim_id: "cl_mock_artifact_missing",
    summary: "The anchored Artifact was removed after claim creation.",
    anchor_kind: "artifact",
    source_path: null,
    start_line: null,
    start_column: null,
    end_line: null,
    end_column: null,
    source_sha256: null,
    source_excerpt: null,
    artifact_id: "artifact_claim_missing",
    linked_evidence_ids: [101],
    mock_status: "unresolved_source",
  });
  mockEvidenceClaims.push({
    ...base,
    claim_id: "cl_mock_foreign",
    project_root: foreignProject,
    summary: "FOREIGN PRIVATE CLAIM",
    linked_evidence_ids: [199],
    mock_status: "linked",
  });
}

async function runEvidenceClaimMockIsolationProbe() {
  const before = mockEvidenceClaims.length;
  const probe = { current_project: mockLastProject };
  try {
    await mockInvoke("create_evidence_claim", { request: { kind: "result", summary: "foreign evidence probe", anchor_kind: "source_range", source_path: "analysis.R", start_line: 1, end_line: 1, evidence_ids: [199] } });
    probe.foreign_evidence_rejected = false;
  } catch { probe.foreign_evidence_rejected = true; }
  try {
    await mockInvoke("create_evidence_claim", { request: { kind: "result", summary: "foreign artifact probe", anchor_kind: "artifact", artifact_id: "artifact_claim_foreign", evidence_ids: [] } });
    probe.foreign_artifact_rejected = false;
  } catch { probe.foreign_artifact_rejected = true; }
  probe.mutations_unchanged = mockEvidenceClaims.length === before;
  try {
    await mockInvoke("review_evidence_claim", { claimId: "cl_mock_foreign" });
    probe.foreign_review_rejected = false;
  } catch { probe.foreign_review_rejected = true; }
  probe.foreign_delete_rejected = await mockInvoke("delete_evidence_claim", { claimId: "cl_mock_foreign" }) === false;
  const visibleClaims = await mockInvoke("list_evidence_claims", { limit: 100 });
  const visibleEvidence = await mockInvoke("list_evidence_entries", { limit: 100 });
  probe.foreign_content_hidden = !JSON.stringify({ visibleClaims, visibleEvidence }).includes("FOREIGN PRIVATE");
  return probe;
}

function seedMockGitReview() {
  mockGitRevisionSequence += 1;
  mockGitReview.working = [
    {
      path: "examples/git-review-demo.txt",
      status: "M",
      hunks: [
        {
          header: "@@ -3,3 +3,3 @@ Section A: QC threshold note",
          content: "diff --git a/examples/git-review-demo.txt b/examples/git-review-demo.txt\n--- a/examples/git-review-demo.txt\n+++ b/examples/git-review-demo.txt\n@@ -3,3 +3,3 @@ Section A: QC threshold note\n-The mitochondrial review threshold is 20 percent.\n+The mitochondrial review threshold is 18 percent.\n This line is intentionally plain so it can be edited.\n",
        },
        {
          header: "@@ -16,3 +16,3 @@ Section B: report note",
          content: "diff --git a/examples/git-review-demo.txt b/examples/git-review-demo.txt\n--- a/examples/git-review-demo.txt\n+++ b/examples/git-review-demo.txt\n@@ -16,3 +16,3 @@ Section B: report note\n-The report is generated after the QC summary is reviewed.\n+The report is generated after QC approval is recorded.\n Edit this line separately to create a second diff hunk.\n",
        },
      ],
    },
    { path: "notes/manual-review.md", status: "?", hunks: [] },
  ];
  mockGitReview.staged = [];
}

function mockGitFileRevision(file, staged) {
  return `${staged ? "staged" : "working"}-${mockGitRevisionSequence}-${file?.path || "missing"}-${file?.hunks?.length || 0}`;
}

function mockGitStagedRevision() {
  return `index-${mockGitRevisionSequence}-${mockGitReview.staged.map((file) => `${file.path}:${file.hunks.length}`).join("|")}`;
}
const MOCK_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5z8AAAAASUVORK5CYII=";
const MOCK_PLOT_DATA_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="840" height="480" viewBox="0 0 840 480"><rect width="840" height="480" fill="white"/><path d="M72 36v376h720M72 412l720-376" fill="none" stroke="#d9e1e0" stroke-width="2"/><g fill="#187a70" opacity=".8"><circle cx="150" cy="340" r="9"/><circle cx="220" cy="310" r="10"/><circle cx="286" cy="286" r="8"/><circle cx="350" cy="242" r="11"/><circle cx="430" cy="225" r="9"/><circle cx="505" cy="174" r="10"/><circle cx="580" cy="148" r="8"/><circle cx="660" cy="112" r="11"/><circle cx="735" cy="82" r="9"/></g><g fill="#536467" font-family="Arial,sans-serif"><text x="350" y="458" font-size="18">Library size</text><text x="-292" y="24" font-size="18" transform="rotate(-90)">Mitochondrial percent</text><text x="72" y="26" font-size="22" font-weight="700">Single-cell QC review</text></g></svg>')}`;

const MOCK_BASE_PACKAGES = [
  { name: "base",     version: "4.6.1", library: "C:/R/R-4.6.1/library",     priority: "base",     built: "4.6.1" },
  { name: "datasets", version: "4.6.1", library: "C:/R/R-4.6.1/library",     priority: "base",     built: "4.6.1" },
  { name: "graphics", version: "4.6.1", library: "C:/R/R-4.6.1/library",     priority: "base",     built: "4.6.1" },
  { name: "grDevices",version: "4.6.1", library: "C:/R/R-4.6.1/library",     priority: "base",     built: "4.6.1" },
  { name: "methods",  version: "4.6.1", library: "C:/R/R-4.6.1/library",     priority: "base",     built: "4.6.1" },
  { name: "stats",    version: "4.6.1", library: "C:/R/R-4.6.1/library",     priority: "base",     built: "4.6.1" },
  { name: "utils",    version: "4.6.1", library: "C:/R/R-4.6.1/library",     priority: "base",     built: "4.6.1" },
  { name: "MASS",     version: "7.3-65",library: "C:/R/R-4.6.1/library",     priority: "recommended", built: "4.6.0" },
  { name: "Matrix",   version: "1.7-3", library: "C:/R/R-4.6.1/library",     priority: "recommended", built: "4.6.0" },
  { name: "nlme",     version: "3.1-168",library: "C:/R/R-4.6.1/library",    priority: "recommended", built: "4.6.0" },
];

const MOCK_BIOC_PACKAGES = [
  { name: "BiocManager",  version: "1.30.27",library: "C:/R/win-library/4.6", priority: null, built: "4.6.1" },
  { name: "DESeq2",       version: "1.48.0", library: "C:/R/win-library/4.6", priority: null, built: "4.6.1" },
  { name: "GenomicRanges",version: "1.60.0", library: "C:/R/win-library/4.6", priority: null, built: "4.6.1" },
  { name: "ggplot2",      version: "3.5.2",  library: "C:/R/win-library/4.6", priority: null, built: "4.6.1" },
  { name: "renv",         version: "1.2.3",  library: "C:/R/win-library/4.6", priority: null, built: "4.6.1" },
  { name: "SummarizedExperiment", version: "1.38.0", library: "C:/R/win-library/4.6", priority: null, built: "4.6.1" },
];

function mockLockfileInventory() {
  const mockState = previewParams.get("state") || "default";
  const base = {
    project_dir: "C:/Users/demo/RhoProject",
    lockfile: {
      path: "C:/Users/demo/RhoProject/renv.lock",
      exists: true,
      valid: true,
      state: "available",
      parse_error: null,
    },
    packages: [
      { name: "DESeq2", locked_version: "1.48.0", installed_version: "1.48.0", library: "C:/R/win-library/4.6", dependency_role: "direct", source: { kind: "repository", detail: "Bioconductor" }, state: "matched" },
      { name: "ggplot2", locked_version: "3.5.1", installed_version: "3.5.2", library: "C:/R/win-library/4.6", dependency_role: "transitive", source: { kind: "repository", detail: "CRAN" }, state: "version_mismatch" },
      { name: "tidyr", locked_version: "1.3.1", installed_version: null, library: null, dependency_role: "unclassified", source: { kind: "github", detail: "tidyverse/tidyr@v1.3.1" }, state: "missing_in_library" },
      { name: "SummarizedExperiment", locked_version: null, installed_version: "1.38.0", library: "C:/R/win-library/4.6", dependency_role: "unclassified", source: { kind: "unknown", detail: null }, state: "missing_in_lockfile" },
    ],
    dependency_roles: {
      state: "available",
      path: "C:/Users/demo/RhoProject/DESCRIPTION",
      fields: { Imports: ["DESeq2"], Suggests: [] },
      error: null,
      incomplete: false,
      incomplete_reasons: [],
    },
    total_count: 4,
    returned_count: 4,
    counts: { matched: 1, version_mismatch: 1, missing_in_library: 1, missing_in_lockfile: 1 },
    truncated: false,
    incomplete: false,
    incomplete_reasons: [],
  };
  if (mockState === "missing") {
    return {
      ...base,
      lockfile: { ...base.lockfile, exists: false, valid: false, state: "no_lockfile", parse_error: null },
      packages: [{ name: "ggplot2", locked_version: null, installed_version: "3.5.2", library: "C:/R/win-library/4.6", state: "missing_in_lockfile" }],
      total_count: 1,
      returned_count: 1,
      counts: { matched: 0, version_mismatch: 0, missing_in_library: 0, missing_in_lockfile: 1 },
    };
  }
  if (mockState === "malformed") {
    return {
      ...base,
      lockfile: { ...base.lockfile, valid: false, state: "invalid_lockfile", parse_error: "lexical error while parsing renv.lock" },
      packages: [],
      total_count: null,
      returned_count: 0,
      counts: { matched: 0, version_mismatch: 0, missing_in_library: 0, missing_in_lockfile: 0 },
      incomplete: true,
      incomplete_reasons: ["lockfile_invalid"],
    };
  }
  if (mockState === "missing-description") {
    return {
      ...base,
      packages: base.packages.map((pkg) => ({ ...pkg, dependency_role: "unclassified" })),
      dependency_roles: { state: "no_description", path: null, fields: {}, error: null, incomplete: false, incomplete_reasons: [] },
    };
  }
  if (mockState === "invalid-description") {
    return {
      ...base,
      packages: base.packages.map((pkg) => ({ ...pkg, dependency_role: "unclassified" })),
      dependency_roles: { state: "invalid_description", path: null, fields: {}, error: "DESCRIPTION could not be parsed", incomplete: false, incomplete_reasons: [] },
    };
  }
  if (mockState === "truncated") return { ...base, total_count: 612, truncated: true };
  return base;
}

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
  if (["not_detected", "unavailable"].includes(provider?.credential_status) && provider.api_key_required) return "Key missing";
  if (model.last_test?.status === "ready") return "Ready";
  if (model.last_test?.status === "error") return "Error";
  return "Untested";
}

const AGENT_MODEL_CAPABILITIES = [
  "function_call",
  "reasoning",
  "vision_input",
  "image_output",
  "image_edit",
  "audio_input",
  "audio_output",
  "structured_output",
  "web_search",
];

const AGENT_CAPABILITY_LABELS = {
  function_call: "Tool calling",
  reasoning: "Reasoning",
  vision_input: "Vision input",
  image_output: "Image output",
  image_edit: "Image editing",
  audio_input: "Audio input",
  audio_output: "Audio output",
  structured_output: "Structured output",
  web_search: "Web search",
};

const AGENT_PROVIDER_PRESETS = {
  deepseek: { displayName: "DeepSeek", description: "Reasoning and chat models", kind: "registered", registeredProviderId: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY", defaultBaseUrl: "https://api.deepseek.com", wireApi: "chat_completions", keyRequired: true },
  openai: { displayName: "OpenAI", description: "GPT, reasoning and image models", kind: "openai", registeredProviderId: null, apiKeyEnv: "OPENAI_API_KEY", defaultBaseUrl: "https://api.openai.com/v1", wireApi: null, keyRequired: true },
  anthropic: { displayName: "Anthropic", description: "Claude language and vision models", kind: "anthropic", registeredProviderId: null, apiKeyEnv: "ANTHROPIC_API_KEY", defaultBaseUrl: "https://api.anthropic.com/v1", wireApi: null, keyRequired: true },
  gemini: { displayName: "Gemini", description: "Google multimodal models", kind: "gemini", registeredProviderId: null, apiKeyEnv: "GEMINI_API_KEY", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/models", wireApi: null, keyRequired: true },
  moonshot: { displayName: "Moonshot", description: "Kimi Open Platform models", kind: "registered", registeredProviderId: "moonshot", apiKeyEnv: "MOONSHOT_API_KEY", defaultBaseUrl: "https://api.moonshot.cn/v1", wireApi: "chat_completions", keyRequired: true },
  kimi: { displayName: "Kimi Code", description: "Kimi coding membership endpoint", kind: "registered", registeredProviderId: "kimi", apiKeyEnv: "KIMI_API_KEY", defaultBaseUrl: "https://api.kimi.com/coding/v1", wireApi: "anthropic_messages", keyRequired: true },
  stepfun: { displayName: "Stepfun", description: "Language and image models", kind: "registered", registeredProviderId: "stepfun", apiKeyEnv: "STEPFUN_API_KEY", defaultBaseUrl: "https://api.stepfun.com/v1", wireApi: "chat_completions", keyRequired: true },
  volcengine: { displayName: "Volcengine", description: "ByteDance Ark model endpoints", kind: "registered", registeredProviderId: "volcengine", apiKeyEnv: "ARK_API_KEY", defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3", wireApi: "chat_completions", keyRequired: true },
  aihubmix: { displayName: "AiHubMix", description: "Unified multi-provider gateway", kind: "registered", registeredProviderId: "aihubmix", apiKeyEnv: "AIHUBMIX_API_KEY", defaultBaseUrl: "https://aihubmix.com/v1", wireApi: "chat_completions", keyRequired: true },
  xai: { displayName: "xAI", description: "Grok language and image models", kind: "registered", registeredProviderId: "xai", apiKeyEnv: "XAI_API_KEY", defaultBaseUrl: "https://api.x.ai/v1", wireApi: "chat_completions", keyRequired: true },
  openrouter: { displayName: "OpenRouter", description: "One API for many model vendors", kind: "registered", registeredProviderId: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", defaultBaseUrl: "https://openrouter.ai/api/v1", wireApi: "chat_completions", keyRequired: true },
  bailian: { displayName: "Bailian", description: "Alibaba Cloud DashScope models", kind: "registered", registeredProviderId: "bailian", apiKeyEnv: "DASHSCOPE_API_KEY", defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", wireApi: "chat_completions", keyRequired: true },
  nvidia: { displayName: "NVIDIA", description: "NVIDIA NIM model endpoints", kind: "registered", registeredProviderId: "nvidia", apiKeyEnv: "NVIDIA_API_KEY", defaultBaseUrl: "https://integrate.api.nvidia.com/v1", wireApi: "chat_completions", keyRequired: true },
  openai_compatible: { displayName: "Custom compatible", description: "OpenAI or Anthropic-compatible API", kind: "openai_compatible", registeredProviderId: null, apiKeyEnv: null, defaultBaseUrl: null, wireApi: "chat_completions", keyRequired: true },
  local_openai_compatible: { displayName: "Local compatible", description: "Local OpenAI-compatible service", kind: "local_openai_compatible", registeredProviderId: null, apiKeyEnv: null, defaultBaseUrl: null, wireApi: "chat_completions", keyRequired: false },
};

const STANDARD_AGENT_ROUTES = [
  { capability: "agent.chat", label: "Chat", description: "Ask and Plan turns", modelType: "language", required: [], consumer: "available" },
  { capability: "agent.act", label: "Act", description: "Tool-enabled Act turns", modelType: "language", required: ["function_call"], consumer: "available" },
  { capability: "vision.inspect", label: "Inspect images", description: "Consumer not installed", modelType: "language", required: ["vision_input"], consumer: "not_installed" },
  { capability: "image.generate", label: "Generate images", description: "Consumer not installed", modelType: "image", required: ["image_output"], consumer: "not_installed" },
  { capability: "image.edit", label: "Edit images", description: "Consumer not installed", modelType: "image", required: ["image_edit"], consumer: "not_installed" },
  { capability: "embedding.default", label: "Embeddings", description: "Consumer not installed", modelType: "embedding", required: [], consumer: "not_installed" },
];

function agentCapability(value = "unknown", source = "unknown") {
  return { value, source };
}

function emptyAgentCapabilities() {
  return Object.fromEntries(AGENT_MODEL_CAPABILITIES.map((name) => [name, agentCapability()]));
}

function agentModelCapability(model, name) {
  return model?.capabilities?.[name]?.value || "unknown";
}

function agentModelCapabilitySource(model, name) {
  return model?.capabilities?.[name]?.source || "unknown";
}

function agentModelType(model) {
  return model?.model_type?.value || "unknown";
}

function agentRouteCompatibility(model, route) {
  if (!model) return "unassigned";
  if (!model.enabled) return "incompatible";
  const type = agentModelType(model);
  if (type !== "unknown" && type !== route.model_type) return "incompatible";
  if ((route.required_model_capabilities || []).some((name) => agentModelCapability(model, name) === "no")) return "incompatible";
  if (type === "unknown" || (route.required_model_capabilities || []).some((name) => agentModelCapability(model, name) === "unknown")) return "needs_review";
  return "compatible";
}

function mockCapabilityRouteViews(settings) {
  const persistedRoutes = settings.persisted_capability_routes || [];
  const providers = new Map((settings.providers || []).map((provider) => [provider.id, provider]));
  const models = new Map((settings.models || []).map((model) => [model.id, model]));
  const chat = persistedRoutes.find((route) => route.capability === "agent.chat") || null;
  const definitions = [
    ...STANDARD_AGENT_ROUTES,
    ...persistedRoutes
      .filter((route) => !STANDARD_AGENT_ROUTES.some((standard) => standard.capability === route.capability))
      .map((route) => ({
        capability: route.capability,
        label: route.capability,
        description: "Custom route; unavailable until a typed consumer is registered",
        modelType: route.model_type,
        required: route.required_model_capabilities || [],
        consumer: "not_installed",
      })),
  ];
  return definitions.map((definition) => {
    const configured = persistedRoutes.find((route) => route.capability === definition.capability) || null;
    const inherited = !configured && definition.capability === "agent.act" ? chat : null;
    const effective = configured || inherited;
    const model = models.get(effective?.model_id) || null;
    const provider = providers.get(model?.provider_id) || null;
    const routeContract = {
      model_type: definition.modelType,
      required_model_capabilities: definition.required,
    };
    return {
      capability: definition.capability,
      label: definition.label,
      description: definition.description,
      model_id: model?.id || null,
      model_display_name: model?.display_name || null,
      provider_display_name: provider?.display_name || null,
      model_type: definition.modelType,
      required_model_capabilities: definition.required,
      configured: Boolean(configured),
      inherited_from: inherited ? "agent.chat" : null,
      compatibility: agentRouteCompatibility(model, routeContract),
      credential_status: provider?.credential_status || "unavailable",
      consumer_status: definition.consumer,
    };
  });
}

function rebuildMockAgentLlmSettings(settings = mockAgentLlmSettings) {
  const chatRoute = (settings.persisted_capability_routes || []).find((route) => route.capability === "agent.chat") || null;
  settings.selected_model_id = chatRoute?.model_id || null;
  const providerMap = new Map((settings.providers || []).map((provider) => [provider.id, provider]));
  settings.providers = (settings.providers || []).map((provider) => ({
    ...provider,
    credential_status: provider.credential_status || (provider.api_key_required ? "not_detected" : "not_required"),
    credential_source: provider.credential_source || (provider.api_key_required ? "none" : "not_required"),
  }));
  settings.models = (settings.models || []).map((model) => {
    const provider = providerMap.get(model.provider_id);
    const selectorStatus = mockSelectorStatus(model, provider);
    return {
      ...model,
      provider_display_name: provider?.display_name || "Provider",
      selected: model.id === settings.selected_model_id,
      selector_status: selectorStatus,
      act_enabled: Boolean(model.enabled && agentModelCapability(model, "function_call") === "yes"),
    };
  });
  const selected = settings.models.find((model) => model.id === settings.selected_model_id) || null;
  settings.selected_model = selected
    ? {
      id: selected.id,
      display_name: selected.display_name,
      provider_display_name: selected.provider_display_name,
      selector_status: selected.selector_status,
      tool_calling: agentModelCapability(selected, "function_call"),
      act_enabled: selected.act_enabled,
    }
    : null;
  settings.capability_routes = mockCapabilityRouteViews(settings);
  return settings;
}

function maybeFailMockAgentLlm(failure) {
  if (mockAgentLlmFailure !== failure) return;
  mockAgentLlmFailure = null;
  const messages = {
    "save-provider": "Mock provider save failed.",
    "set-credential": "Mock credential storage failed.",
    "save-model": "Mock model save failed.",
    "discover-models": "Mock provider discovery failed.",
    "test-model": "Mock connection test failed.",
    "select-model": "Mock model selection failed.",
  };
  throw new Error(messages[failure] || "Mock model settings operation failed.");
}

function defaultMockAgentLlmSettingsView() {
  const deepseekCapabilities = emptyAgentCapabilities();
  Object.assign(deepseekCapabilities, {
    function_call: agentCapability("yes", "aisdk_catalog"),
    reasoning: agentCapability("yes", "aisdk_catalog"),
    vision_input: agentCapability("no", "aisdk_catalog"),
    image_output: agentCapability("no", "aisdk_catalog"),
    image_edit: agentCapability("no", "aisdk_catalog"),
    structured_output: agentCapability("yes", "aisdk_catalog"),
  });
  const chatOnlyCapabilities = emptyAgentCapabilities();
  Object.assign(chatOnlyCapabilities, {
    function_call: agentCapability("no", "user_declared"),
    vision_input: agentCapability("no", "user_declared"),
  });
  const settings = {
    schema_version: 2,
    revision: 1,
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
        credential_source: "system",
      },
    ],
    models: [
      {
        id: "model-deepseek-v4-flash",
        provider_id: "provider-deepseek-existing",
        display_name: "DeepSeek V4 Flash",
        model_id: "deepseek-v4-flash",
        enabled: true,
        model_type: agentCapability("language", "aisdk_catalog"),
        capabilities: deepseekCapabilities,
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
        model_type: agentCapability("language", "user_declared"),
        capabilities: chatOnlyCapabilities,
        last_test: null,
        provider_display_name: "DeepSeek",
        selected: false,
        selector_status: "Untested",
        act_enabled: false,
      },
    ],
    persisted_capability_routes: [
      {
        capability: "agent.chat",
        model_id: "model-deepseek-v4-flash",
        model_type: "language",
        required_model_capabilities: [],
      },
    ],
    selected_model: null,
    user_environ: {
      path: "",
      source: "system",
    },
    validation_error: null,
  };
  return rebuildMockAgentLlmSettings(settings);
}

function mockAisdkCatalogEntries() {
  const rows = [
    ["anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5", true, true, true],
    ["deepseek", "deepseek-v4-flash", "DeepSeek V4 Flash", true, true, false],
    ["deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro", true, true, false],
    ["openai", "gpt-5-mini", "GPT-5 mini", true, true, true],
  ];
  return rows.map(([provider, id, displayName, functionCall, reasoning, visionInput]) => {
    const capabilities = emptyAgentCapabilities();
    for (const [name, value] of Object.entries({
      function_call: functionCall,
      reasoning,
      vision_input: visionInput,
      image_output: false,
      image_edit: false,
      audio_input: false,
      audio_output: false,
      structured_output: true,
      web_search: false,
    })) capabilities[name] = agentCapability(value ? "yes" : "no", "aisdk_catalog");
    return {
      provider,
      id,
      display_name: displayName,
      description: `${provider} catalog entry`,
      model_type: agentCapability("language", "aisdk_catalog"),
      capabilities,
    };
  });
}

let mockAgentLlmSettings = defaultMockAgentLlmSettingsView();
const mockAgentLlmSystemCredentials = new Set(
  mockAgentLlmSettings.providers
    .filter((provider) => provider.credential_source === "system")
    .map((provider) => provider.id),
);

function nextMockRunId() {
  mockRunSequence += 1;
  return `exec_mock_${mockRunSequence}`;
}

function nextMockTurnId() {
  mockAgentTurnSequence += 1;
  return `agent_turn_${mockAgentTurnSequence}`;
}

function nextMockConversationId() {
  mockAgentConversationSequence += 1;
  return `agent_conversation_${mockAgentConversationSequence}`;
}

function nextMockApprovalId() {
  mockApprovalSequence += 1;
  return `approval_${mockApprovalSequence}`;
}

function nextMockEnvironmentOperationId() {
  mockEnvironmentOperationSequence += 1;
  return `envreq_${mockEnvironmentOperationSequence}`;
}

function mockTurnSummary(turn) {
  const pending = mockApprovalRequests.find((item) => item.turn_id === turn.turn_id && item.status === "waiting");
  return {
    turn_id: turn.turn_id,
    conversation_id: turn.conversation_id,
    project_root: turn.project_root,
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
    retry_of_turn_id: turn.retry_of_turn_id || null,
    terminal_reason: turn.terminal_reason || null,
  };
}

function createMockAgentConversation({ projectRoot = mockLastProject, legacyUnthreaded = false } = {}) {
  const timestamp = new Date().toISOString();
  const conversation = {
    conversation_id: nextMockConversationId(),
    project_root: projectRoot,
    title: legacyUnthreaded ? "Legacy project history" : "New conversation",
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null,
    legacy_unthreaded: legacyUnthreaded,
  };
  mockAgentConversations.unshift(conversation);
  return conversation;
}

function mockConversationSummary(conversation) {
  const turns = mockAgentTurns
    .filter((turn) => turn.project_root === conversation.project_root
      && turn.conversation_id === conversation.conversation_id)
    .sort((left, right) => String(right.started_at).localeCompare(String(left.started_at)));
  const latest = turns[0] || null;
  const pending = latest
    ? mockApprovalRequests.find((item) => item.turn_id === latest.turn_id && item.status === "waiting")
    : null;
  return {
    ...conversation,
    turn_count: turns.length,
    status: latest?.status || "empty",
    latest_turn_id: latest?.turn_id || null,
    latest_mode: latest?.mode || null,
    latest_prompt_preview: latest?.prompt_preview || null,
    terminal_reason: latest?.terminal_reason || null,
    pending_request_id: pending?.request_id || null,
  };
}

function touchMockAgentConversation(turn, timestamp = new Date().toISOString()) {
  const conversation = mockAgentConversations.find((item) =>
    item.conversation_id === turn.conversation_id && item.project_root === turn.project_root);
  if (conversation) conversation.updated_at = timestamp;
}

function createMockAgentTurn({
  prompt,
  mode,
  model,
  editorContext = null,
  autoApprove = false,
  taskKind = "agent_turn",
  capabilityRoute = null,
  conversationId = null,
}) {
  let conversation = conversationId
    ? mockAgentConversations.find((item) => item.conversation_id === conversationId && item.project_root === mockLastProject)
    : null;
  if (conversationId && !conversation) throw new Error("Agent Conversation was not found");
  const activeTurns = mockAgentTurns.filter((item) => item.project_root === mockLastProject
    && ["running", "waiting"].includes(item.status));
  if (conversation?.legacy_unthreaded) throw new Error("Legacy project history is read-only; start a new conversation");
  if (conversation && activeTurns.some((item) => item.conversation_id === conversation.conversation_id
    && ["running", "waiting"].includes(item.status))) {
    throw new Error("AGENT_CONVERSATION_BUSY: This Conversation already has an active Agent turn.");
  }
  if (mode === "act" && activeTurns.length) {
    throw new Error("AGENT_ACT_EXCLUSIVE: Act mode cannot run beside another Agent turn.");
  }
  if (activeTurns.some((item) => item.mode === "act")) {
    throw new Error("AGENT_ACT_EXCLUSIVE: Wait for the active Act turn to finish.");
  }
  if (activeTurns.length >= 2) {
    throw new Error("AGENT_CONCURRENCY_LIMIT: At most two Agent turns can run at once.");
  }
  if (!conversation) conversation = createMockAgentConversation();
  const startedAt = new Date().toISOString();
  const waitingForApproval = mode === "act" && !autoApprove;
  const turn = {
    turn_id: nextMockTurnId(),
    conversation_id: conversation.conversation_id,
    project_root: mockLastProject,
    mode,
    status: waitingForApproval ? "waiting" : "completed",
    started_at: startedAt,
    finished_at: waitingForApproval ? null : startedAt,
    prompt_preview: prompt.replace(/\s+/g, " ").trim().slice(0, 120) || "<empty>",
    model,
    workspace_id_before: "desktop_mock",
    state_revision_before: state.revision.state_revision,
    project_revision_before: state.revision.project_revision,
    workspace_id_after: waitingForApproval ? null : "desktop_mock",
    state_revision_after: waitingForApproval ? null : state.revision.state_revision,
    project_revision_after: waitingForApproval ? null : state.revision.project_revision,
    final_message: null,
    error_message: null,
    retry_of_turn_id: null,
    terminal_reason: null,
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
        details_json: JSON.stringify({
          prompt,
          mode,
          task_kind: taskKind,
          capability_route: capabilityRoute,
          auto_approve: autoApprove,
          editor_context: editorContext,
        }),
      },
      {
        id: 2,
        turn_id: null,
        timestamp: startedAt,
        event_type: "agent.run_started",
        title: "Agent started",
        body: mode === "act" ? "Act mode completes requested work through authorized tools." : `${mode[0].toUpperCase()}${mode.slice(1)} mode is running in read-only broker policy.`,
        status: "running",
        tool: null,
        request_id: null,
        code: null,
        details_json: "{}",
      },
    ],
  };
  turn.events.forEach((event) => { event.turn_id = turn.turn_id; });
  if (waitingForApproval) {
    const requestId = nextMockApprovalId();
    mockApprovalRequests.unshift({
      request_id: requestId,
      turn_id: turn.turn_id,
      project_root: mockLastProject,
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
  if (conversation.title === "New conversation") conversation.title = turn.prompt_preview;
  conversation.updated_at = startedAt;
  return turn;
}

function recordMockRun({
  runId = null,
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
  sourceRange = null,
  errorRange = null,
  projectRoot = mockLastProject,
}) {
  const resolvedRunId = runId || nextMockRunId();
  const startedAt = new Date().toISOString();
  const entry = {
    run_id: resolvedRunId,
    parent_run_id: parentRunId,
    project_root: projectRoot,
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
      source_range: sourceRange,
    }),
    stdout: "",
    value_text: errorMessage ? null : "Mock result",
    messages: [],
    warnings: [],
    error_call: errorCall,
    traceback,
    line_number: errorRange?.start_line ?? null,
    column_number: errorRange?.start_column ?? null,
    end_line_number: errorRange?.end_line ?? null,
    end_column_number: errorRange?.end_column ?? null,
    range_kind: errorRange
      ? (errorRange.range_kind ?? errorRange.rangeKind ?? "r_expression")
      : null,
  };
  mockRuns.unshift(entry);
  return entry;
}

function nextMockArtifactId() {
  mockArtifactSequence += 1;
  return `artifact_mock_${mockArtifactSequence}`;
}

function mockOutputAbsolutePath(projectRoot, outputPath) {
  const root = String(projectRoot || mockLastProject).replace(/\\/g, "/").replace(/\/+$/, "");
  const relative = validateProjectRelativePath(outputPath);
  return `${root}/${relative}`;
}

function mockFileAvailable(projectRoot, outputPath) {
  const project = mockProjects[projectRoot] || mockProjects[mockLastProject] || mockProjects[mockPlatformFixture.projectRoot];
  return Object.prototype.hasOwnProperty.call(project.contents || {}, outputPath);
}

function mockFileStatus(record) {
  if (!mockFileAvailable(record.project_root, record.output_path)) return "missing";
  const extension = pathFileName(record.output_path).split(".").pop()?.toLowerCase();
  return ["html", "htm", "md", "r", "rmd", "txt", "log", "json", "csv", "tsv", "png", "jpg", "jpeg", "gif", "webp"].includes(extension)
    ? "available"
    : "unsupported";
}

function mockUpsertProjectFile(projectRoot, path, content, options = {}) {
  const { trackInTree = true, kind = "source" } = options;
  const normalized = validateProjectRelativePath(path);
  const project = mockProjects[projectRoot] || mockProjects[mockLastProject] || mockProjects[mockPlatformFixture.projectRoot];
  project.contents[normalized] = content;
  if (!trackInTree) return normalized;
  const size = typeof content === "string" ? content.length : 0;
  const existing = project.files.find((file) => file.path === normalized);
  if (existing) {
    existing.size_bytes = size;
    existing.kind = kind;
    existing.name = normalized.split("/").at(-1);
  } else {
    project.files.push({
      path: normalized,
      name: normalized.split("/").at(-1),
      kind,
      size_bytes: size,
    });
  }
  return normalized;
}

function createMockArtifactRecord({
  artifactKind,
  runId = null,
  projectRoot = mockLastProject,
  outputPath,
  sourcePath = null,
  executionMode = null,
  documentVersion = null,
  workspaceId = "desktop_mock",
  stateRevision = state.revision.state_revision,
  projectRevision = state.revision.project_revision,
  mediaType,
  metadata = {},
  provenanceComplete = true,
  incompleteReason = null,
}) {
  const record = {
    artifact_id: nextMockArtifactId(),
    artifact_kind: artifactKind,
    run_id: runId,
    project_root: projectRoot,
    output_path: validateProjectRelativePath(outputPath),
    source_path: sourcePath,
    execution_mode: executionMode,
    document_version: documentVersion,
    workspace_id: workspaceId,
    state_revision: stateRevision,
    project_revision: projectRevision,
    media_type: mediaType,
    metadata_json: JSON.stringify(metadata || {}),
    provenance_complete: Boolean(provenanceComplete),
    incomplete_reason: incompleteReason || null,
    created_at: new Date().toISOString(),
  };
  mockArtifacts.unshift(record);
  return record;
}

function mockArtifactView(record) {
  if (!record) return null;
  return {
    artifact: structuredClone(record),
    file_available: mockFileAvailable(record.project_root, record.output_path),
    file_status: mockFileStatus(record),
    output_absolute_path: mockOutputAbsolutePath(record.project_root, record.output_path),
    run: record.run_id ? structuredClone(mockRuns.find((run) => run.run_id === record.run_id) || null) : null,
  };
}

function mockRetentionScopeSummary({ sessionOnly }) {
  const plots = mockPlots.filter((plot) =>
    plot.project_root === mockLastProject
    && (!sessionOnly || plot.workspace_id === "desktop_mock")
  );
  const artifacts = mockArtifacts.filter((artifact) =>
    artifact.project_root === mockLastProject
    && (!sessionOnly || artifact.workspace_id === "desktop_mock")
  );
  return {
    plot_history_count: plots.length,
    plot_payload_bytes: plots.reduce((total, plot) => total + String(plot.payload_json || "").length, 0),
    artifact_record_count: artifacts.length,
    artifact_metadata_bytes: artifacts.reduce((total, artifact) => total + String(artifact.metadata_json || "").length, 0),
  };
}

function mockProjectRetentionSummary() {
  return {
    project_root: mockLastProject,
    session: mockRetentionScopeSummary({ sessionOnly: true }),
    project: mockRetentionScopeSummary({ sessionOnly: false }),
    policy: {
      max_plot_history_rows: 200,
      max_plot_payload_bytes: 52428800,
      max_artifact_record_rows: 500,
      max_artifact_metadata_bytes: 104857600,
      prune_order: "oldest_first",
      auto_prune_enabled: false,
    },
  };
}

function mockRunForWorkspaceState(workspaceId, stateRevision, projectRevision) {
  return mockRuns.find((run) =>
    run.workspace_id === workspaceId
    && run.state_revision_after === stateRevision
    && run.project_revision_after === projectRevision,
  ) || null;
}

function mockProblemList() {
  return mockRuns
    .filter((run) => run.project_root === mockLastProject && run.error_message)
    .map((run) => ({
      run_id: run.run_id,
      parent_run_id: run.parent_run_id,
      project_root: run.project_root,
      origin: run.origin,
      status: run.status,
      message: run.error_message,
      call: run.error_call,
      traceback: [...(run.traceback || [])],
      source_path: run.source_path,
      execution_mode: run.execution_mode,
      document_version: run.document_version,
      line_number: run.line_number,
      column_number: run.column_number,
      end_line_number: run.end_line_number,
      end_column_number: run.end_column_number,
      range_kind: run.range_kind,
      workspace_id: run.workspace_id,
      started_at: run.started_at,
      finished_at: run.finished_at,
    }));
}

function mockExecutionErrorRange(request) {
  const sourceRange = request?.source_range ?? request?.sourceRange ?? null;
  const code = String(request?.code || "");
  if (!sourceRange) return null;
  const parseTokenOffset = code.indexOf("，");
  if (parseTokenOffset >= 0) {
    const lineStart = code.lastIndexOf("\n", Math.max(0, parseTokenOffset - 1)) + 1;
    const relativeLine = code.slice(0, lineStart).split("\n").length;
    const relativeColumn = code.slice(lineStart, parseTokenOffset).length + 1;
    const startLine = sourceRange.start_line + relativeLine - 1;
    const startColumn = relativeLine === 1
      ? sourceRange.start_column + relativeColumn - 1
      : relativeColumn;
    return {
      start_line: startLine,
      start_column: startColumn,
      end_line: startLine,
      end_column: startColumn + 1,
      range_kind: "r_parse_token",
    };
  }
  if (!code.includes("stop(")) return null;
  const stopOffset = code.indexOf("stop(");
  const lineStart = code.lastIndexOf("\n", Math.max(0, stopOffset - 1)) + 1;
  const lineEnd = code.indexOf("\n", stopOffset);
  const relativeLine = code.slice(0, lineStart).split("\n").length;
  const lineText = code.slice(lineStart, lineEnd < 0 ? code.length : lineEnd);
  const startLine = sourceRange.start_line + relativeLine - 1;
  return {
    start_line: startLine,
    start_column: relativeLine === 1 ? sourceRange.start_column : 1,
    end_line: startLine,
    end_column: (relativeLine === 1 ? sourceRange.start_column : 1) + lineText.length,
    range_kind: "r_expression",
  };
}

function mockProjectState(root = mockLastProject) {
  const project = mockProjects[root] || mockProjects[mockPlatformFixture.projectRoot];
  return { root, files: project.files.map((file) => ({ ...file })), truncated: false };
}

function mockEnvironmentSnapshot() {
  const latestCompletedOperation = mockEnvironmentOperationRequests.find((item) => item.status === "completed");
  const operationName = latestCompletedOperation?.request_name || "";
  const hasLockfile = Boolean(latestCompletedOperation);
  const renvActive = ["environment.initialize", "environment.restore"].includes(operationName);
  const renvStatus = hasLockfile ? (renvActive ? "active" : "present") : "absent";
  const renvSynchronization = operationName === "environment.snapshot" ? "synchronized" : (hasLockfile ? "synchronized" : "no_lockfile");
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
          status: renvStatus,
          has_lockfile: hasLockfile,
          lockfile_path: hasLockfile ? `${mockLastProject}/renv.lock` : null,
          package_available: true,
          project_library: `${mockLastProject}/renv`,
          active: renvActive,
          synchronization: renvSynchronization,
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

function mockEnvironmentOperationTone(status) {
  if (["completed", "approved"].includes(status)) return "success";
  if (["requested", "running"].includes(status)) return "warning";
  if (["failed", "rejected", "cancelled", "interrupted", "stale"].includes(status)) return "error";
  return "";
}

function createMockEnvironmentOperationRequest(operation, request = {}) {
  const requestedAt = new Date().toISOString();
  const requestName = {
    install_package: "environment.package_install",
    update_package: "environment.package_update",
    remove_package: "environment.package_remove",
  }[operation] || `environment.${operation}`;
  const beforeSnapshotId = `env_before_${mockEnvironmentOperationSequence + 1}`;
  const packageOperation = ["install_package", "update_package", "remove_package"].includes(operation);
  const packageName = request.package || null;
  const projectLibrary = packageOperation ? `${mockLastProject}/renv/library` : null;
  const repositories = packageOperation && operation !== "remove_package"
    ? { CRAN: "https://cloud.r-project.org" }
    : (request.repositories || {});
  const packagePreview = packageOperation ? {
    ok: true,
    operation,
    package: packageName,
    project_dir: mockLastProject,
    project_library: projectLibrary,
    installed_version: operation === "install_package" ? null : "3.5.1",
    locked_version: operation === "remove_package" ? null : "3.4.4",
    disposition: { install_package: "will_install", update_package: "will_update", remove_package: "will_remove" }[operation],
    repositories,
    warnings: ["Package operations can leave partial library writes after failure or cancellation; refresh before recovery."],
  } : null;
  const preview = {
    request_name: requestName,
    arguments: {
      operation,
      project_root: mockLastProject,
      repositories: Object.entries(repositories).map(([name, value]) => ({ name, value })),
      bioconductor: request.bioconductor || null,
      package: packageName,
      project_library: projectLibrary,
    },
    workspace: {
      workspace_id: "desktop_mock",
      state_revision: state.revision.state_revision,
      project_revision: state.revision.project_revision,
    },
    before_snapshot_id: beforeSnapshotId,
    preview: packagePreview || {
      project_dir: mockLastProject,
      renv: {
        status: operation === "initialize" ? "absent" : "present",
        synchronization: operation === "snapshot" ? "drifted" : "synchronized",
      },
      renv_status: {
        ok: true,
        synchronized: operation === "snapshot" ? false : true,
        messages: [],
        warnings: operation === "restore" ? ["Restore will reuse the project lockfile."] : [],
        error: null,
      },
      bioconductor: {
        status: "available",
        version: request.bioconductor || "3.22",
        package_available: true,
      },
      diff: {
        values: operation === "snapshot"
          ? [{ name: "ggplot2", lockfile_version: "3.4.4", library_version: "3.5.1", direction: "version_mismatch" }]
          : [],
        truncated: false,
      },
    },
  };
  const previewJson = JSON.stringify(preview);
  const summary = {
    request_id: nextMockEnvironmentOperationId(),
    turn_id: null,
    source: "user",
    request_name: requestName,
    status: "requested",
    decision: null,
    reason: null,
    project_root: mockLastProject,
    arguments_json: JSON.stringify({
      operation,
      project_root: mockLastProject,
      repositories: packageOperation ? repositories : (request.repositories || null),
      bioconductor: request.bioconductor || null,
      package: packageName,
      project_library: projectLibrary,
    }),
    preview_json: previewJson,
    preview_sha256: `preview_mock_${mockEnvironmentOperationSequence}`,
    workspace_id: "desktop_mock",
    state_revision: state.revision.state_revision,
    project_revision: state.revision.project_revision,
    before_snapshot_id: beforeSnapshotId,
    run_id: null,
    requested_at: requestedAt,
    responded_at: null,
    completed_at: null,
    terminal_outcome: null,
  };
  mockEnvironmentOperationRequests.unshift(summary);
  return summary;
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

function mockInspectDataObject(name) {
  mockDataViewerInspectCount += 1;
  if (["qc", "qc_paged", "qc_types"].includes(name)) {
    const rowCount = name === "qc_paged" ? 60 : name === "qc_types" ? 6 : 12;
    const columnCount = name === "qc_types" ? 6 : 3;
    return {
      execution: {
        ok: true,
        name,
        class: ["data.frame"],
        display_kind: "data_frame",
        dimensions: [rowCount, columnCount],
        view_token: `mock-view-${name}-${state.revision.state_revision}`,
        views: [
          { kind: "table", key: "table", label: "Table", rows: rowCount, columns: columnCount },
        ],
        truncated: false,
        truncation_reason: null,
      },
      workspace: state.revision,
    };
  }
  return {
    execution: {
      ok: false,
      error_code: "unsupported_object_class",
      message: `Viewer support is not available for \`${name}\`.`,
      name,
      classes: ["numeric"],
    },
    workspace: state.revision,
  };
}

function mockReadDataView(request) {
  mockDataViewerReadCount += 1;
  const viewToken = `mock-view-${request.object_name}-${request.workspace?.state_revision ?? state.revision.state_revision}`;
  if (request.view_token !== viewToken) {
    return {
      execution: {
        ok: false,
        error_code: "stale_view_token",
        message: "The selected data view is stale. Reload the object before requesting another page.",
      },
      workspace: state.revision,
    };
  }
  const typedRows = [
    { row_name: "sample_1", cells: [true, 1, 1.5, "", "control", "2026-01-01"], cell_states: ["value", "value", "value", "empty", "value", "value"] },
    { row_name: "sample_2", cells: [null, null, "NaN", null, null, null], cell_states: ["na", "na", "nan", "na", "na", "na"] },
    { row_name: "sample_3", cells: [false, 3, "Inf", "plain", "treated", "2026-01-03"], cell_states: ["value", "value", "pos_inf", "value", "value", "value"] },
    { row_name: "sample_4", cells: [true, 4, "-Inf", "alpha", "control", "2026-01-04"], cell_states: ["value", "value", "neg_inf", "value", "value", "value"] },
    { row_name: "sample_5", cells: [false, 5, null, "beta", "treated", "2026-01-05"], cell_states: ["value", "value", "na", "value", "value", "value"] },
    { row_name: "sample_6", cells: [true, 6, 2.75, "gamma", "control", "2026-01-06"], cell_states: ["value", "value", "value", "value", "value", "value"] },
  ].map((row, index) => ({ ...row, source_index: index }));
  const sourceTotalRows = request.object_name === "qc_paged" ? 60 : request.object_name === "qc_types" ? 6 : 12;
  const sourceRows = request.object_name === "qc_types"
    ? typedRows
    : Array.from({ length: sourceTotalRows }, (_, index) => ({
      source_index: index,
      row_name: `cell_${index + 1}`,
      cells: [`S${index + 1}`, 70000 + index * 231, 3100 + index * 17],
      cell_states: ["value", "value", "value"],
    }));
  const normalizedQuery = request.query === null || request.query === undefined
    ? null
    : String(request.query).trim() || null;
  if (normalizedQuery && (new TextEncoder().encode(normalizedQuery).length > 256 || /[\r\n\0]/.test(normalizedQuery))) {
    return {
      execution: { ok: false, error_code: "invalid_query", message: "Search query is invalid." },
      workspace: state.revision,
    };
  }
  const sortColumn = request.sort_column === null || request.sort_column === undefined
    ? null
    : Number(request.sort_column);
  const sortDirection = request.sort_direction === null || request.sort_direction === undefined
    ? null
    : String(request.sort_direction);
  const sourceColumnCount = request.object_name === "qc_types" ? 6 : 3;
  if ((sortColumn === null) !== (sortDirection === null)
      || (sortColumn !== null && (!Number.isInteger(sortColumn) || sortColumn < 0 || sortColumn >= sourceColumnCount))
      || (sortDirection !== null && !["asc", "desc"].includes(sortDirection))) {
    return {
      execution: { ok: false, error_code: "invalid_sort", message: "Sort request is invalid." },
      workspace: state.revision,
    };
  }
  const needle = normalizedQuery?.toLocaleLowerCase() || null;
  let rows = needle
    ? sourceRows.filter((row) => [row.row_name, ...row.cells].some((value) => String(value ?? "").toLocaleLowerCase().includes(needle)))
    : [...sourceRows];
  if (sortColumn !== null) {
    rows.sort((left, right) => {
      const a = left.cells[sortColumn];
      const b = right.cells[sortColumn];
      const aMissing = a === null || a === undefined;
      const bMissing = b === null || b === undefined;
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      if (aMissing) return left.source_index - right.source_index;
      const comparison = typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a).localeCompare(String(b));
      return comparison === 0
        ? left.source_index - right.source_index
        : (sortDirection === "desc" ? -comparison : comparison);
    });
  }
  const rowOffset = request.row_offset || 0;
  const rowLimit = request.row_limit || 50;
  const columnOffset = request.column_offset || 0;
  const columnLimit = request.column_limit || 20;
  const allColumns = request.object_name === "qc_types" ? [
    { index: 0, name: "included", label: "included", type: "logical", classes: ["logical"] },
    { index: 1, name: "replicate", label: "replicate", type: "integer", classes: ["integer"] },
    { index: 2, name: "score", label: "score", type: "double", classes: ["numeric"] },
    { index: 3, name: "note", label: "note", type: "character", classes: ["character"] },
    { index: 4, name: "group", label: "group", type: "factor", classes: ["factor"] },
    { index: 5, name: "collected", label: "collected", type: "date", classes: ["Date"] },
  ] : [
    { index: 0, name: "sample", label: "sample", type: "character", classes: ["character"] },
    { index: 1, name: "reads", label: "reads", type: "integer", classes: ["integer"] },
    { index: 2, name: "detected", label: "detected", type: "integer", classes: ["integer"] },
  ];
  const selectedColumns = allColumns.slice(columnOffset, columnOffset + columnLimit);
  const pageRows = rows.slice(rowOffset, rowOffset + rowLimit).map((row) => ({
    row_name: row.row_name,
    cells: row.cells.slice(columnOffset, columnOffset + columnLimit).map((value) => value === null || value === undefined ? null : String(value)),
    cell_states: row.cell_states.slice(columnOffset, columnOffset + columnLimit),
  }));
  const columns = selectedColumns.map((column, index) => ({
    ...column,
    page_missing_count: pageRows.filter((row) => ["na", "nan"].includes(row.cell_states[index])).length,
  }));
  const page = {
    object_name: request.object_name,
    class: ["data.frame"],
    dimensions: [sourceTotalRows, sourceColumnCount],
    view_kind: request.view_kind,
    view_key: request.view_key,
    view_token: request.view_token,
    source_total_rows: sourceTotalRows,
    total_rows: rows.length,
    total_columns: sourceColumnCount,
    row_offset: rowOffset,
    row_limit: rowLimit,
    column_offset: columnOffset,
    column_limit: columnLimit,
    query: normalizedQuery,
    sort_column: sortColumn,
    sort_direction: sortDirection,
    columns,
    rows: pageRows,
    truncated: false,
    truncation_reason: null,
    payload_bytes: JSON.stringify(pageRows).length,
  };
  return {
    execution: {
      ok: true,
      page,
    },
    workspace: state.revision,
  };
}

async function invoke(command, args = {}) {
  if (isDesktop) return tauriInvoke(command, args);
  return mockInvoke(command, args);
}

function mockConsoleHelpTarget(code) {
  const match = /^\s*\?\s*(?:([A-Za-z][A-Za-z0-9.]*)\s*::\s*)?([A-Za-z.][A-Za-z0-9._]*)\s*$/.exec(String(code || ""));
  if (!match) return null;
  const packageName = match[1] || {
    mean: "base",
    lm: "stats",
    sd: "stats",
  }[match[2]] || null;
  return { topic: match[2], package: packageName };
}

async function mockInvoke(command, args) {
  if (mockGitFailureCommand === command) {
    throw new Error(`Injected ${command} preview failure`);
  }
  await new Promise((resolve) => setTimeout(resolve, command === "run_agent" ? 800 : 300));
  if (command === "app_info") {
    return {
      version: "0.4.0-dev.24",
      channel: "development",
      commit: "4090cf725c53ab657ba9dfc9743ec6159f27dcf9",
      platform: mockPlatformFixture.platform,
      website_url: "https://yulab-smu.top/Rho/",
      source_url: "https://github.com/YuLab-SMU/Rho",
      runtime: {
        rscript: mockPlatformFixture.rscript,
        r_version: "R version 4.6.0",
        agent_available: true,
        aisdk_version: "1.5.0",
      },
    };
  }
  if (command === "check_for_updates") {
    return {
      status: "up_to_date",
      channel: "development",
      installed_version: "0.4.0-dev.24",
      available_version: "0.4.0-dev.24",
      published_at: "2026-07-22T14:45:23Z",
      summary: "Rho is current for the development channel.",
      release_page_url: "https://yulab-smu.top/Rho/",
    };
  }
  if (command === "open_rho_website") return null;
  if (["startup_bootstrap", "startup_choose_rscript", "startup_status"].includes(command)) {
    return {
      phase: "runtime_ready",
      busy: false,
      runtime: {
        rscript: mockPlatformFixture.rscript,
        r_version: "R version 4.6.0",
        agent_runtime: { available: true, aisdk_version: "1.5.0", error: null },
      },
      issue: null,
    };
  }
  if (command === "startup_diagnostics") return "Rho mock startup diagnostics";
  if (command === "startup_open_log_directory") return { path: mockPlatformFixture.logPath };
  if (command === "agent_runtime_retry") return { available: true, aisdk_version: "1.5.0", error: null };
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
      blocker: null,
      reason_code: null,
      message: null,
      restored_root: null,
      restart_required: false,
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
    const project = mockProjects[mockLastProject] || mockProjects[mockPlatformFixture.projectRoot];
    return { path: args.path, content: project.contents[args.path] || "" };
  }
  if (command === "viewer_read_file") {
    const path = String(args.path || "");
    const extension = viewerPathExtension(path);
    const samples = {
      md: "# Markdown preview\n\nThis preview is rendered from the current project buffer.\n\n```r\nsummary(qc)\n```\n",
      r: "counts <- read.csv('counts.csv')\nsummary(counts)\n",
      rmd: "---\ntitle: 'Analysis'\n---\n\n```{r}\nsummary(counts)\n```\n",
      txt: "Generated text output\n",
      json: "{\"status\":\"complete\"}\n",
      html: "<!doctype html><html><head><title>Interactive output</title><style>body{font:16px sans-serif;padding:24px}button{padding:8px 12px}</style></head><body><h1>Interactive HTML output</h1><button id='update'>Update</button><p id='value'>Ready</p><script>document.querySelector('#update').onclick=()=>document.querySelector('#value').textContent='Updated inside sandbox';</script></body></html>",
      csv: "sample,reads,detected\nA,1200,3100\nB,1400,3300\n",
      tsv: "sample\treads\tdetected\nA\t1200\t3100\nB\t1400\t3300\n",
    };
    if (!samples[extension]) throw new Error(`Preview is not available for this file: ${path}`);
    return { contract: "rho.viewer_file.v1", project_root: mockLastProject, path, media_type: { md: "text/markdown", html: "text/html", r: "text/x-r", rmd: "text/x-r-markdown", txt: "text/plain", json: "application/json", csv: "text/csv", tsv: "text/tab-separated-values" }[extension], content_encoding: "utf-8", content: samples[extension], size_bytes: samples[extension].length };
  }
  if (command === "project_write_file" || command === "project_create_file") {
    const project = mockProjects[mockLastProject] || mockProjects[mockPlatformFixture.projectRoot];
    mockUpsertProjectFile(mockLastProject, args.path, args.content || "", { trackInTree: true, kind: "source" });
    state.revision.project_revision += 1;
    updateIdentity(state.revision);
    return mockInvoke("project_state", {});
  }
  if (command === "project_delete_file") {
    const project = mockProjects[mockLastProject] || mockProjects[mockPlatformFixture.projectRoot];
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
  if (command === "inspect_data_object") {
    return mockInspectDataObject(args.request?.object_name || args.request?.objectName || "qc");
  }
  if (command === "read_data_view") {
    return mockReadDataView(args.request || {});
  }
  if (command === "execute_r") {
    const request = args.request || {};
    const helpTarget = mockConsoleHelpTarget(request.code);
    const parseFailed = String(request.code || "").includes("，");
    const evaluationFailed = String(request.code || "").includes("stop(");
    const executionFailed = parseFailed || evaluationFailed;
    const errorMessage = parseFailed ? "<text>:1:11: unexpected input" : evaluationFailed ? "boom" : null;
    const errorCall = evaluationFailed ? "stop(\"boom\")" : null;
    const unpaddedMockPng = MOCK_PNG_BASE64.replace(/=+$/, "");
    state.revision.state_revision += 1;
    const selectedObject = state.selectedObjectName && state.selectedObjectName !== "qc"
      ? state.objects.find((object) => object.name === state.selectedObjectName) || null
      : null;
    state.objects = [
      { name: "qc", classes: ["data.frame"], dimensions: [12, 3], size_bytes: 2184, typeof: "list" },
      ...(selectedObject ? [selectedObject] : []),
    ];
    const run = recordMockRun({
      origin: "user",
      status: executionFailed ? "failed" : "completed",
      code: request.code || "",
      sourcePath: request.source_path ?? request.sourcePath ?? null,
      executionMode: request.execution_mode ?? request.type ?? null,
      documentVersion: request.document_version ?? request.documentVersion ?? null,
      errorMessage,
      errorCall,
      traceback: evaluationFailed ? ["stop(\"boom\")"] : [],
      parentRunId: request.parent_run_id ?? null,
      sourceRange: request.source_range ?? request.sourceRange ?? null,
      errorRange: mockExecutionErrorRange(request),
    });
    if (!executionFailed && !helpTarget) {
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
        media_type: "image/png",
        payload_json: JSON.stringify({ "image/png": unpaddedMockPng }),
        provenance_complete: Boolean(request.source_path ?? request.sourcePath ?? null),
        created_at: new Date().toISOString(),
      });
    }
    return {
      execution_id: run.run_id,
      execution: {
        ok: !executionFailed,
        code: request.code,
        stdout: "",
        value: executionFailed || helpTarget ? null : "     reads        detected   \n Min.   : 40122   Min.   :2511  \n Median : 72840   Median :3238  \n Mean   : 76114   Mean   :3216",
        warnings: [],
        messages: [],
        help: helpTarget,
        error: executionFailed ? { message: errorMessage, call: errorCall } : null,
        traceback: evaluationFailed ? ["stop(\"boom\")"] : [],
      },
      events: helpTarget || executionFailed ? [] : [{ event: { type: "display_data", data: { "image/png": unpaddedMockPng } } }],
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
  if (command === "get_project_retention_summary") {
    return structuredClone(mockProjectRetentionSummary());
  }
  if (command === "prune_plot_payloads") {
    let prunedCount = 0;
    let reclaimedBytes = 0;
    for (const plot of mockPlots) {
      if (plot.project_root !== mockLastProject) continue;
      if (args.session_only && plot.workspace_id !== "desktop_mock") continue;
      const payload = parseJsonObject(plot.payload_json);
      if (payload["rho/pruned"]) continue;
      const nextPayload = JSON.stringify({
        "rho/pruned": true,
        "rho/pruned_at": new Date().toISOString(),
        "rho/original_media_type": plot.media_type,
        "rho/prune_reason": "manual_retention_prune",
      });
      reclaimedBytes += Math.max(String(plot.payload_json || "").length - nextPayload.length, 0);
      plot.payload_json = nextPayload;
      prunedCount += 1;
    }
    return { pruned_count: prunedCount, reclaimed_bytes: reclaimedBytes };
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
  if (command === "export_plot_artifact") {
    const plot = mockPlots.find((item) => item.plot_id === args.request?.plot_id || item.plot_id === args.plot_id);
    if (!plot) throw new Error(`Plot artifact not found: ${args.request?.plot_id || args.plot_id}`);
    const outputPath = validateProjectRelativePath(args.request?.path || args.path || "plot.png");
    if (!outputPath.toLowerCase().endsWith(".png")) throw new Error("Plot export path must end with .png.");
    if (mockFileAvailable(mockLastProject, outputPath)) throw new Error(`Artifact path already exists: ${outputPath}`);
    mockUpsertProjectFile(mockLastProject, outputPath, "PNG", { trackInTree: false, kind: "artifact" });
    state.revision.project_revision += 1;
    updateIdentity(state.revision);
    const artifact = createMockArtifactRecord({
      artifactKind: "plot_export",
      runId: plot.run_id,
      outputPath,
      sourcePath: plot.source_path,
      executionMode: plot.execution_mode,
      documentVersion: plot.document_version,
      workspaceId: plot.workspace_id,
      stateRevision: plot.state_revision,
      projectRevision: state.revision.project_revision,
      mediaType: "image/png",
      metadata: { plot_id: plot.plot_id, payload_media_type: plot.media_type },
      provenanceComplete: plot.provenance_complete,
      incompleteReason: plot.provenance_complete ? null : "Source path or document version is unavailable.",
    });
    return mockArtifactView(artifact);
  }
  if (command === "list_problems") {
    if (mockProblemListFailureOnce) {
      mockProblemListFailureOnce = false;
      throw new Error("Mock durable Problems refresh failed.");
    }
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
    const outputPath = sourcePath.replace(/\.Rmd$/i, ".html");
    mockUpsertProjectFile(mockLastProject, outputPath, "<html><body>Mock render output</body></html>", { trackInTree: false, kind: "artifact" });
    state.revision.project_revision += 1;
    updateIdentity(state.revision);
    run.project_revision_after = state.revision.project_revision;
    createMockArtifactRecord({
      artifactKind: "render_output",
      runId: run.run_id,
      outputPath,
      sourcePath,
      executionMode: "render",
      documentVersion: args.request?.document_version ?? null,
      workspaceId: run.workspace_id,
      stateRevision: run.state_revision_after,
      projectRevision: state.revision.project_revision,
      mediaType: "text/html",
      metadata: { tool: "rmarkdown", source_path: sourcePath },
      provenanceComplete: Boolean(sourcePath && args.request?.document_version !== null && args.request?.document_version !== undefined),
      incompleteReason: sourcePath && args.request?.document_version !== null && args.request?.document_version !== undefined
        ? null
        : "Source path or document version is unavailable.",
    });
    return {
      execution_id: run.run_id,
      execution: {
        ok: true,
        kind: "render",
        tool: "rmarkdown",
        source_path: sourcePath,
        output_path: outputPath,
        stdout: "Output created.",
        messages: [],
        warnings: [],
        error: null,
      },
      events: [],
      workspace: state.revision,
    };
  }
  if (command === "render_document_job") {
    mockRenderSequence += 1;
    const jobId = `render_mock_${String(mockRenderSequence).padStart(3, "0")}`;
    mockRenderJobs.set(jobId, {
      job_id: jobId,
      project_root: mockLastProject,
      path: args.path,
      document_version: args.document_version ?? null,
      status: "submitted",
      message: null,
      terminal_reason: null,
      submitted_at: new Date().toISOString(),
      completed_at: null,
      poll_count: 0,
    });
    return { job_id: jobId, status: "submitted" };
  }
  if (command === "render_job_status") {
    if (args.job_id) {
      const job = mockRenderJobs.get(args.job_id);
      if (!job || job.project_root !== mockLastProject) throw new Error("Render job not found");
      if (job.status === "cancel_requested") {
        job.status = "interrupted";
        job.message = "Render cancelled.";
        job.terminal_reason = "user_interrupt";
        job.completed_at = new Date().toISOString();
      } else if (["submitted", "running"].includes(job.status)) {
        job.poll_count += 1;
        job.status = job.poll_count > 3 ? "completed" : "running";
        if (job.status === "completed") {
          const run = recordMockRun({
            runId: job.job_id,
            origin: "user",
            status: "completed",
            requestType: "workspace.render_document",
            operationClass: "project_mutation",
            code: `render ${job.path}`,
            sourcePath: job.path,
            executionMode: "render",
            documentVersion: job.document_version,
          });
          const outputPath = job.path.replace(/\.(Rmd|qmd)$/i, ".html");
          mockUpsertProjectFile(mockLastProject, outputPath, "<html><body>Mock render output</body></html>", { trackInTree: false, kind: "artifact" });
          state.revision.project_revision += 1;
          updateIdentity(state.revision);
          run.project_revision_after = state.revision.project_revision;
          const artifact = createMockArtifactRecord({
            artifactKind: "render_output",
            runId: run.run_id,
            outputPath,
            sourcePath: job.path,
            executionMode: "render",
            documentVersion: job.document_version,
            workspaceId: run.workspace_id,
            stateRevision: run.state_revision_after,
            projectRevision: run.project_revision_after,
            mediaType: "text/html",
            metadata: { tool: "rmarkdown", source_path: job.path },
            provenanceComplete: job.document_version !== null && job.document_version !== undefined,
            incompleteReason: job.document_version !== null && job.document_version !== undefined
              ? null
              : "Source path or document version is unavailable.",
          });
          job.artifact_id = artifact.artifact_id;
          job.output_path = artifact.output_path;
          job.tool = "rmarkdown";
          job.media_type = artifact.media_type;
          job.provenance_complete = artifact.provenance_complete;
          job.completed_at = new Date().toISOString();
        }
      }
      const { poll_count: _pollCount, ...view } = job;
      return structuredClone(view);
    }
    return [...mockRenderJobs.values()]
      .filter((job) => job.project_root === mockLastProject)
      .map(({ poll_count: _pollCount, ...job }) => structuredClone(job));
  }
  if (command === "cancel_render_job") {
    const job = mockRenderJobs.get(args.job_id);
    if (!job || job.project_root !== mockLastProject) throw new Error("Render job not found");
    if (["completed", "failed"].includes(job.status)) throw new Error(`Render job is already ${job.status}`);
    if (job.status !== "interrupted") job.status = "cancel_requested";
    return { job_id: job.job_id, status: "cancel_requested" };
  }
  if (command === "get_run_detail") {
    const runId = args.runId ?? args.run_id;
    const detail = structuredClone(mockRuns.find((run) =>
      run.run_id === runId && run.project_root === mockLastProject
    ) || null);
    if (mockProblemPreparationProjectSwitchOnce) {
      mockProblemPreparationProjectSwitchOnce = false;
      mockLastProject = mockPlatformFixture.alternateProjectRoot;
      state.project = mockProjectState(mockLastProject);
      state.projectRefreshSequence += 1;
    }
    return detail;
  }
  if (command === "compare_runs") {
    const leftId = args.left_run_id ?? args.leftRunId;
    const rightId = args.right_run_id ?? args.rightRunId;
    const leftRun = mockRuns.find(r => r.run_id === leftId);
    const rightRun = mockRuns.find(r => r.run_id === rightId);
    if (!leftRun || !rightRun) throw new Error("Run not found");
    return {
      schema_version: 1,
      project_root: "D:/mock-project",
      generated_at: new Date().toISOString(),
      left_run_id: leftId,
      right_run_id: rightId,
      summary: { same: 8, different: 2, unknown: 2, limitations: 0 },
      sections: [
        {
          id: "identity", label: "Identity & Execution", fields: [
            { field: "status", state: leftRun.status === rightRun.status ? "same" : "different", left_value: leftRun.status, right_value: rightRun.status },
            { field: "origin", state: "same", left_value: leftRun.origin, right_value: rightRun.origin },
            { field: "request_type", state: "same", left_value: leftRun.request_type, right_value: rightRun.request_type },
            { field: "parent_run_id", state: "same", left_value: leftRun.parent_run_id, right_value: rightRun.parent_run_id },
          ]
        },
        {
          id: "source", label: "Source & Request", fields: [
            { field: "source_path", state: leftRun.source_path === rightRun.source_path ? "same" : "different", left_value: leftRun.source_path, right_value: rightRun.source_path },
            { field: "code_digest", state: "same", left_value: "abc123", right_value: "abc123" },
          ]
        },
        { id: "environment", label: "Environment", fields: [{ field: "snapshot_available", state: "unknown", left_value: "true", right_value: "true" }] },
        { id: "outcome", label: "Outcome & Problems", fields: [{ field: "error_message", state: "same", left_value: leftRun.error_message, right_value: rightRun.error_message }] },
        { id: "artifacts", label: "Artifacts", fields: [{ field: "artifact_count", state: "not_applicable", left_value: "0", right_value: "0" }] }
      ],
      truncated: false,
      truncation_reasons: []
    };
  }
  if (command === "editor_package_functions") {
    return {
      functions: [
        { name: "c", package: "base", signature: "function (..., recursive = FALSE, use.names = TRUE)" },
        { name: "list", package: "base", signature: "function (...)" },
        { name: "data.frame", package: "base", signature: "function (..., row.names = NULL, check.rows = FALSE, ...)" },
        { name: "matrix", package: "base", signature: "function (data = NA, nrow = 1, ncol = 1, byrow = FALSE, dimnames = NULL)" },
        { name: "factor", package: "base", signature: "function (x = character(), levels, labels = levels, ...)" },
        { name: "lm", package: "stats", signature: "function (formula, data, subset, weights, na.action, ...)" },
        { name: "glm", package: "stats", signature: "function (formula, family = gaussian, data, weights, subset, ...)" },
        { name: "mean", package: "base", signature: "function (x, ...)" },
        { name: "median", package: "stats", signature: "function (x, na.rm = FALSE, ...)" },
        { name: "sd", package: "stats", signature: "function (x, na.rm = FALSE)" },
        { name: "summary", package: "base", signature: "function (object, ...)" },
        { name: "head", package: "utils", signature: "function (x, ...)" },
        { name: "tail", package: "utils", signature: "function (x, ...)" },
        { name: "str", package: "utils", signature: "function (object, ...)" },
        { name: "plot", package: "graphics", signature: "function (x, y, ...)" },
        { name: "hist", package: "graphics", signature: "function (x, ...)" },
        { name: "boxplot", package: "graphics", signature: "function (x, ...)" },
        { name: "read.csv", package: "utils", signature: "function (file, header = TRUE, sep = \",\", quote = \"\\\"\", ...)" },
        { name: "write.csv", package: "utils", signature: "function (...)" },
        { name: "readRDS", package: "base", signature: "function (file, refhook = NULL)" },
        { name: "saveRDS", package: "base", signature: "function (object, file = \"\", ascii = FALSE, ...)" },
        { name: "library", package: "base", signature: "function (package, help, pos = 2, lib.loc = NULL, ...)" },
        { name: "require", package: "base", signature: "function (package, lib.loc = NULL, quietly = FALSE, ...)" },
        { name: "subset", package: "base", signature: "function (x, ...)" },
        { name: "merge", package: "base", signature: "function (x, y, ...)" },
      ]
    };
  }
  if (command === "editor_function_help") {
    const name = args.name || "";
    const agentPreviewState = previewParams.get("preview") === "agent-help-link" ? previewParams.get("state") : null;
    const previewState = previewParams.get("locationState") || previewParams.get("helpState") || agentPreviewState
      || (previewParams.get("preview") === "local-help" ? previewParams.get("state") : null)
      || "found";
    if (previewState === "error") throw new Error("Local Help bridge is unavailable.");
    if (previewState === "unavailable") {
      return { name, found: false, package: null, signature: null, help_topic: null, help_record: null, package_root: null, library_root: null, source_path: null, source_line: null, ambiguous: false, truncated: false };
    }
    const longRoot = previewState === "long"
      ? `C:/Users/scientist/Documents/Unicode project/packages/${"nested-location/".repeat(9)}stats`
      : "C:/R/library/stats";
    const mockHelp = {
      "mean": { package: "base", signature: "function (x, ...)", root: "C:/R/library/base" },
      "lm": { package: "stats", signature: "function (formula, data, subset, weights, na.action, method = \"qr\", model = TRUE, ...)", root: longRoot },
      "plot": { package: "graphics", signature: "function (x, y, ...)", root: "C:/R/library/graphics" },
      "summary": { package: "base", signature: "function (object, ...)", root: "C:/R/library/base" },
      "read.csv": { package: "utils", signature: "function (file, header = TRUE, sep = \",\", quote = \"\\\"\", dec = \".\", fill = TRUE, comment.char = \"\", ...)", root: "C:/R/library/utils" },
    };
    const item = mockHelp[name] || { package: "base", signature: `function ${name}(...)`, root: "C:/R/library/base" };
    return {
      name, found: true, package: item.package, signature: item.signature,
      help_topic: name, help_record: `${item.root}/help/${name}`,
      package_root: item.root, library_root: item.root.slice(0, item.root.lastIndexOf("/")),
      source_path: name === "lm" ? `${item.root}/R/lm.R` : null,
      source_line: name === "lm" ? 20 : null,
      ambiguous: previewState === "ambiguous", truncated: previewState === "long",
      help_title: null, help_text: null,
    };
  }
  if (command === "editor_function_documentation") {
    const name = args.name || "lm";
    const packageName = args.package || "stats";
    const previewState = previewParams.get("helpState")
      || (previewParams.get("preview") === "agent-help-link" ? previewParams.get("state") : null)
      || "found";
    if (previewState === "error") throw new Error("Installed Rd documentation could not be read.");
    if (previewState === "unavailable") {
      return { name, package: packageName, package_version: "4.6.0", help_topic: null, found: false, title: null, description: null, usage: null, arguments: [], details: null, value: null, example: { code: null, executable: false, omitted_tags: [], parse_error: null }, vignettes: [], truncated: false, incomplete: false, notices: [] };
    }
    const empty = previewState === "empty";
    const truncated = previewState === "truncated";
    const omitted = previewState === "omitted";
    const executionError = previewState === "execution-error";
    const long = previewState === "long";
    const meanTopic = name === "mean";
    const exampleCode = executionError
      ? 'stop("boom")'
      : meanTopic ? "mean(c(2, 4, 6, 8))" : "fit <- lm(mpg ~ wt, data = mtcars)\nsummary(fit)";
    return {
      name,
      package: packageName,
      package_version: "4.6.0",
      help_topic: name,
      found: true,
      title: empty ? null : meanTopic ? "Arithmetic Mean" : "Fitting Linear Models",
      description: empty ? null : meanTopic ? "Calculate the arithmetic mean." : "Fit linear models to a formula and data.",
      usage: empty ? null : meanTopic ? "mean(x, ...)" : long ? `lm(formula, data, ${"optional_argument, ".repeat(35)}...)` : "lm(formula, data, subset, weights, na.action, ...)",
      arguments: empty ? [] : [
        ...(meanTopic
          ? [{ name: "x", description: "An R object for which a mean is requested." }]
          : [
            { name: "formula", description: "A symbolic description of the model to be fitted." },
            { name: "data", description: "An optional data frame containing model variables." },
          ]),
      ],
      details: empty ? null : meanTopic ? "The default method returns the arithmetic mean after optional method dispatch." : long ? "Model terms are evaluated from the installed documentation. ".repeat(30) : "Models are specified symbolically and fitted by least squares.",
      value: empty ? null : meanTopic ? "A numeric or complex mean value." : "An object of class lm containing the fitted model.",
      example: {
        code: empty ? null : truncated ? `${exampleCode}\n# ${"truncated ".repeat(40)}...` : exampleCode,
        executable: !empty && !truncated,
        omitted_tags: omitted ? ["dontrun", "donttest"] : [],
        parse_error: truncated ? "Example exceeds the executable transport limit." : null,
      },
      vignettes: empty ? [] : [{ topic: "reshape", title: "Using the reshape function" }],
      truncated,
      incomplete: truncated || omitted,
      notices: truncated ? ["example_byte_limit"] : omitted ? ["example_tags_omitted"] : [],
    };
  }
  if (command === "editor_lint_file") {
    const path = args.path || "examples/editor-intelligence.R";
    const documentVersion = args.documentVersion ?? 0;
    const previewState = previewParams.get("state") || "found";
    const provider = { name: "lintr", version: "3.4.0", available: previewState !== "unavailable" };
    if (previewState === "unavailable" || previewState === "error") {
      return {
        provider, source_path: path, source_digest: previewState === "error" ? "md5:mock" : null,
        document_version: documentVersion, scan_scope: "file", diagnostics: [],
        truncated: false, incomplete: true,
        notices: [previewState === "error" ? "provider_error" : "provider_unavailable"],
        error: previewState === "error" ? "lintr could not parse the file." : "lintr package is not installed.",
      };
    }
    const expectedLine = previewState === "changed-line"
      ? "example_value <- stats::median(c(1, 3, 5))"
      : "example_value<-stats::median(c(1, 3, 5))";
    const message = previewState === "long"
      ? `Put spaces around all infix operators. ${"Long diagnostic detail. ".repeat(80)}`
      : "Put spaces around all infix operators.";
    const quickFix = {
      title: "Put spaces around the operator", line_number: 7,
      column_number: 14, end_column_number: 15, expected_line: expectedLine,
      replacement_line: "example_value <- stats::median(c(1, 3, 5))",
    };
    const primary = {
      diagnostic_id: "lintr:mock:7:14:infix_spaces_linter:1", source_path: path,
      line_number: 7, column_number: 14, end_line_number: 7, end_column_number: 15,
      severity: "info", message, rule: "infix_spaces_linter", producer: "lintr",
      producer_version: "3.4.0", document_version: previewState === "stale" ? Math.max(0, documentVersion - 1) : documentVersion,
      scan_scope: "file", quick_fix: quickFix,
    };
    const secondary = {
      diagnostic_id: "lintr:mock:5:1:seq_linter:2", source_path: path,
      line_number: 5, column_number: 1, end_line_number: 5, end_column_number: 12,
      severity: "warning", message: "Use seq_len() instead of 1:length(...).", rule: "seq_linter",
      producer: "lintr", producer_version: "3.4.0", document_version: documentVersion,
      scan_scope: "file", quick_fix: null,
    };
    const diagnostics = previewState === "empty" ? [] : [primary, secondary];
    if (previewState === "duplicate") diagnostics.push({ ...primary, diagnostic_id: `${primary.diagnostic_id}:duplicate` });
    return {
      provider, source_path: path, source_digest: "md5:mock", document_version: documentVersion,
      scan_scope: "file", diagnostics,
      truncated: previewState === "truncated", incomplete: previewState === "truncated",
      notices: previewState === "truncated" ? ["diagnostic_count_limit"] : [], error: null,
    };
  }
  if (command === "editor_format_source") {
    const request = args.request || args;
    const source = String(request.source || "");
    const path = String(request.path || "examples/editor-formatting.R");
    const documentVersion = Number(request.document_version ?? 1);
    const previewState = previewParams.get("state") || "formatted";
    if (previewState === "unavailable") {
      return {
        kind: "rho.editor_format_result.v1", ok: false, status: "unavailable",
        provider: "styler", provider_version: null, path, document_version: documentVersion,
        before: source, after: null, changed: false, warnings: [],
        error: { code: "formatter_unavailable", message: "The selected styler formatter is not installed in Workspace R." },
      };
    }
    if (previewState === "error") {
      return {
        kind: "rho.editor_format_result.v1", ok: false, status: "error",
        provider: "styler", provider_version: "1.2.0", path, document_version: documentVersion,
        before: source, after: null, changed: false, warnings: [],
        error: { code: "formatter_error", message: "The selected formatter could not parse this R source." },
      };
    }
    const after = previewState === "unchanged"
      ? source
      : source
        .replace(/\s*<-\s*/g, " <- ")
        .replace(/\s*\+\s*/g, " + ")
        .replace(/\s*>\s*/g, " > ");
    return {
      kind: "rho.editor_format_result.v1", ok: true,
      status: after === source ? "unchanged" : "formatted",
      provider: "styler", provider_version: "1.2.0", path,
      document_version: documentVersion, before: source, after,
      changed: after !== source, warnings: [], error: null,
    };
  }
  if (command === "audit_reproducibility") {
    const scopeStr = args.scope || "project";
    return {
      schema_version: 1,
      rule_profile: "rho.repro.v1",
      rule_profile_version: 1,
      project_root: "D:/mock-project",
      scope: scopeStr,
      generated_at: new Date().toISOString(),
      reference_snapshot_id: null,
      status: "findings",
      findings: [
        {
          rule_id: "rho.repro.v1.evidence.env.lockfile_missing",
          rule_version: 1,
          severity: "error",
          category: "evidence",
          summary: "No renv.lock found in project root.",
          evidence: [{ kind: "file_path", path: "renv.lock", excerpt: "file not found" }],
          limitations: []
        },
        {
          rule_id: "rho.repro.v1.portability.absolute_path.windows",
          rule_version: 1,
          severity: "warning",
          category: "portability",
          summary: "Source contains a machine-specific absolute path.",
          evidence: [{ kind: "source_range", path: "analysis.R", line: 18, column: 12, excerpt: 'readRDS("D:/data/input.rds")' }],
          limitations: []
        },
        {
          rule_id: "rho.repro.v1.randomness.rng_without_seed",
          rule_version: 1,
          severity: "info",
          category: "randomness",
          summary: "Uses rnorm without set.seed in this file.",
          evidence: [{ kind: "source_range", path: "analysis.R", line: 5, column: 1, excerpt: "x <- rnorm(100)" }],
          limitations: []
        }
      ],
      summary: {
        total_findings: 3,
        info: 1, warning: 1, error: 1,
        by_category: { evidence: 1, portability: 1, randomness: 1 },
        files_scanned: 3,
        runs_checked: 5
      },
      coverage: {
        files_scanned: 3, files_skipped: 1,
        skipped_reasons: ["file_too_large: data/large.csv"],
        runs_considered: 5, artifacts_considered: 2,
        snapshot_available: true
      },
      truncated: false,
      truncation_reasons: []
    };
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
    if (command === "agent_llm_settings" && mockAgentLlmFailure === "load-settings" && !mockAgentLlmLoadFailureConsumed) {
      mockAgentLlmLoadFailureConsumed = true;
      throw new Error("Injected one-shot Agent model settings read failure");
    }
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "agent_llm_set_credential") {
    maybeFailMockAgentLlm("set-credential");
    const providerId = args.providerId ?? args.provider_id;
    const provider = mockAgentLlmSettings.providers.find((item) => item.id === providerId);
    if (!provider) throw new Error("The selected provider is no longer available.");
    if (!provider.api_key_required) throw new Error("This provider does not require an API key.");
    if (!String(args.credential || "")) throw new Error("Enter an API key before saving.");
    mockAgentLlmSystemCredentials.add(providerId);
    provider.credential_status = "detected";
    provider.credential_source = "system";
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "agent_llm_delete_credential") {
    const providerId = args.providerId ?? args.provider_id;
    const provider = mockAgentLlmSettings.providers.find((item) => item.id === providerId);
    if (!provider) throw new Error("The selected provider is no longer available.");
    mockAgentLlmSystemCredentials.delete(providerId);
    provider.credential_status = "not_detected";
    provider.credential_source = "none";
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "agent_llm_discover_models") {
    maybeFailMockAgentLlm("discover-models");
    const providerId = args.providerId ?? args.provider_id;
    const provider = mockAgentLlmSettings.providers.find((item) => item.id === providerId);
    if (!provider) throw new Error("The selected provider is no longer available.");
    const discoveryState = previewParams.get("discovery") || "ready";
    if (discoveryState === "slow") await new Promise((resolve) => window.setTimeout(resolve, 80));
    if (provider.api_key_required && !mockAgentLlmSystemCredentials.has(providerId)) {
      return {
        status: "error", provider_id: providerId, models: [], truncated: false,
        message: "No API key is stored for this provider. Save a key or enter a model ID manually.",
        error_class: "credential",
      };
    }
    if (discoveryState === "unsupported") {
      return {
        status: "unsupported", provider_id: providerId, models: [], truncated: false,
        message: "This provider does not expose a supported model list. Enter a model ID manually.",
        error_class: "unsupported",
      };
    }
    if (discoveryState === "auth-error") {
      return {
        status: "error", provider_id: providerId, models: [], truncated: false,
        message: "The provider rejected the stored API key. Replace the key or enter a model ID manually.",
        error_class: "auth",
      };
    }
    if (discoveryState === "malformed") {
      return { status: "ready", provider_id: providerId, models: "invalid", truncated: false, message: "Invalid mock response.", error_class: null };
    }
    if (discoveryState === "empty") {
      return {
        status: "ready", provider_id: providerId, models: [], truncated: false,
        message: "The provider returned no usable generation models. Enter a model ID manually.",
        error_class: null,
      };
    }
    const providerKey = provider.registered_provider_id || provider.kind;
    const choices = {
      deepseek: [["deepseek-v4-flash", "DeepSeek V4 Flash"], ["deepseek-v4-pro", "DeepSeek V4 Pro"]],
      openai: [["gpt-5-mini", "GPT-5 mini"], ["gpt-5.2", "GPT-5.2"]],
      anthropic: [["claude-sonnet-4-5", "Claude Sonnet 4.5"], ["claude-opus-4-1", "Claude Opus 4.1"]],
      gemini: [["gemini-3.5-flash", "Gemini 3.5 Flash"], ["gemini-3.1-pro", "Gemini 3.1 Pro"]],
    }[providerKey] || [["provider-model-small", "Provider Model Small"], ["provider-model-large", "Provider Model Large"]];
    const catalog = mockAisdkCatalogEntries();
    return {
      status: "ready",
      provider_id: providerId,
      models: choices.map(([id, displayName]) => {
        const exact = catalog.find((entry) => entry.provider === providerKey && entry.id === id);
        return exact
          ? { id, display_name: displayName, model_type: structuredClone(exact.model_type), capabilities: structuredClone(exact.capabilities) }
          : { id, display_name: displayName, model_type: agentCapability("unknown", "unknown"), capabilities: emptyAgentCapabilities() };
      }),
      truncated: discoveryState === "truncated",
      message: discoveryState === "truncated" ? "Loaded the first 2 models. The provider reported additional models." : "Loaded 2 available models.",
      error_class: null,
    };
  }
  if (command === "agent_llm_catalog") {
    return structuredClone(mockAisdkCatalogEntries());
  }
  if (command === "agent_llm_save_provider") {
    maybeFailMockAgentLlm("save-provider");
    const provider = structuredClone(args.provider || {});
    const index = mockAgentLlmSettings.providers.findIndex((item) => item.id === provider.id);
    provider.credential_status = provider.api_key_required
      ? (mockAgentLlmSystemCredentials.has(provider.id) ? "detected" : "not_detected")
      : "not_required";
    provider.credential_source = provider.api_key_required
      ? (mockAgentLlmSystemCredentials.has(provider.id) ? "system" : "none")
      : "not_required";
    if (index >= 0) mockAgentLlmSettings.providers[index] = provider;
    else mockAgentLlmSettings.providers.push(provider);
    mockAgentLlmSettings.revision += 1;
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "agent_llm_delete_provider") {
    const providerId = args.providerId ?? args.provider_id;
    if (mockAgentLlmSettings.models.some((model) => model.provider_id === providerId)) {
      throw new Error("Delete the provider's models before removing the provider.");
    }
    mockAgentLlmSystemCredentials.delete(providerId);
    mockAgentLlmSettings.providers = mockAgentLlmSettings.providers.filter((provider) => provider.id !== providerId);
    mockAgentLlmSettings.revision += 1;
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "agent_llm_save_model") {
    maybeFailMockAgentLlm("save-model");
    const model = structuredClone(args.model || {});
    const existing = mockAgentLlmSettings.models.find((item) => item.id === model.id);
    if (existing && (
      JSON.stringify(existing.model_type) !== JSON.stringify(model.model_type)
      || JSON.stringify(existing.capabilities) !== JSON.stringify(model.capabilities)
    )) {
      throw new Error("Use the capability declaration operation to change existing model evidence.");
    }
    if (existing?.enabled && !model.enabled && mockAgentLlmSettings.persisted_capability_routes.some((route) => route.model_id === model.id)) {
      throw new Error("Reassign this model's capability routes before disabling it.");
    }
    const index = mockAgentLlmSettings.models.findIndex((item) => item.id === model.id);
    if (index >= 0) mockAgentLlmSettings.models[index] = model;
    else mockAgentLlmSettings.models.push(model);
    mockAgentLlmSettings.revision += 1;
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "agent_llm_delete_model") {
    const request = args.request || {};
    const modelId = request.modelId ?? request.model_id;
    if (mockAgentLlmSettings.persisted_capability_routes.some((route) => route.model_id === modelId)) {
      throw new Error("Reassign or remove this model's capability routes before deleting it.");
    }
    mockAgentLlmSettings.models = mockAgentLlmSettings.models.filter((model) => model.id !== modelId);
    mockAgentLlmSettings.revision += 1;
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "agent_llm_select_model") {
    maybeFailMockAgentLlm("select-model");
    const request = args.request || {};
    const modelId = request.modelId;
    const expectedRevision = request.expectedRevision;
    if (expectedRevision !== mockAgentLlmSettings.revision) throw new Error("Model settings changed while this route editor was open. Reload and try again.");
    const route = mockAgentLlmSettings.persisted_capability_routes.find((item) => item.capability === "agent.chat");
    route.model_id = modelId;
    mockAgentLlmSettings.revision += 1;
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "agent_llm_save_capability_route") {
    const expectedRevision = args.expectedRevision;
    if (expectedRevision !== mockAgentLlmSettings.revision) throw new Error("Model settings changed while this route editor was open. Reload and try again.");
    const route = structuredClone(args.route || {});
    const model = mockAgentLlmSettings.models.find((item) => item.id === route.model_id);
    const compatibility = agentRouteCompatibility(model, route);
    if (compatibility === "incompatible") throw new Error("The selected model is incompatible with this route.");
    if (compatibility === "needs_review") throw new Error("Declare this model's type and required capabilities before assigning the route.");
    const index = mockAgentLlmSettings.persisted_capability_routes.findIndex((item) => item.capability === route.capability);
    if (index >= 0) mockAgentLlmSettings.persisted_capability_routes[index] = route;
    else mockAgentLlmSettings.persisted_capability_routes.push(route);
    mockAgentLlmSettings.revision += 1;
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "agent_llm_delete_capability_route") {
    const expectedRevision = args.expectedRevision;
    const capability = args.capability;
    if (expectedRevision !== mockAgentLlmSettings.revision) throw new Error("Model settings changed while this route editor was open. Reload and try again.");
    if (capability === "agent.chat") throw new Error("The required agent.chat route cannot be removed.");
    mockAgentLlmSettings.persisted_capability_routes = mockAgentLlmSettings.persisted_capability_routes.filter((route) => route.capability !== capability);
    mockAgentLlmSettings.revision += 1;
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "agent_llm_declare_model_capabilities") {
    const expectedRevision = args.expectedRevision;
    const modelId = args.modelId ?? args.model_id;
    if (expectedRevision !== mockAgentLlmSettings.revision) throw new Error("Model settings changed while this capability editor was open. Reload and try again.");
    const model = mockAgentLlmSettings.models.find((item) => item.id === modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);
    const candidate = structuredClone(model);
    const patch = args.patch || {};
    if (patch.model_type) candidate.model_type = agentCapability(patch.model_type, "user_declared");
    for (const [name, value] of Object.entries(patch.capabilities || {})) {
      candidate.capabilities[name] = agentCapability(value, "user_declared");
    }
    for (const route of mockAgentLlmSettings.persisted_capability_routes.filter((item) => item.model_id === modelId)) {
      if (agentRouteCompatibility(candidate, route) !== "compatible") {
        throw new Error(`The capability change would make ${route.capability} incompatible. Reassign or remove that route first.`);
      }
    }
    Object.assign(model, candidate);
    mockAgentLlmSettings.revision += 1;
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "agent_llm_test_model") {
    maybeFailMockAgentLlm("test-model");
    const modelId = args.modelId ?? args.model_id;
    const model = mockAgentLlmSettings.models.find((item) => item.id === modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);
    if (!model.enabled) throw new Error("Selected Agent model is disabled.");
    if (agentModelType(model) !== "language") throw new Error("Connection probes are available only for language models.");
    const provider = mockAgentLlmSettings.providers.find((item) => item.id === model.provider_id);
    if (!provider) throw new Error(`Missing provider for Agent model ${model.display_name}`);
    if (provider.api_key_required && provider.credential_status !== "detected") {
      model.last_test = {
        status: "error",
        checked_at: new Date().toISOString(),
        latency_ms: null,
        error_class: "credential",
        message: "No API key is available for this provider.",
      };
      mockAgentLlmSettings.revision += 1;
      return structuredClone(rebuildMockAgentLlmSettings());
    }
    model.last_test = {
      status: "ready",
      checked_at: new Date().toISOString(),
      latency_ms: 420,
      error_class: null,
      message: "Connection succeeded.",
    };
    mockAgentLlmSettings.revision += 1;
    return structuredClone(rebuildMockAgentLlmSettings());
  }
  if (command === "agent_llm_cancel_test") {
    return { status: "cancel_requested" };
  }
  if (command === "list_project_skills") {
    return structuredClone(mockProjectSkillsView(mockLastProject));
  }
  if (command === "run_agent") {
    if (mockAgentRunFailureOnce) {
      const failure = mockAgentRunFailureOnce;
      mockAgentRunFailureOnce = null;
      throw new Error(failure);
    }
    const mode = args.mode || "ask";
    const taskKind = args.taskKind ?? args.task_kind ?? "agent_turn";
    if (!["agent_turn", "problem_repair"].includes(taskKind)) throw new Error("Unsupported typed Agent task.");
    if (taskKind === "problem_repair" && mode !== "ask") throw new Error("Problem repair must use read-only Ask mode.");
    const persistedRoutes = mockAgentLlmSettings.persisted_capability_routes || [];
    const effectiveRoute = mode === "act" || taskKind === "problem_repair"
      ? (persistedRoutes.find((route) => route.capability === "agent.act")
        || persistedRoutes.find((route) => route.capability === "agent.chat"))
      : persistedRoutes.find((route) => route.capability === "agent.chat");
    const requestedModelId = args.modelId ?? args.model_id ?? null;
    if (requestedModelId && requestedModelId !== effectiveRoute?.model_id) {
      throw new Error("Per-turn model overrides are unavailable. Assign the model to the effective capability route first.");
    }
    const selectedModelId = effectiveRoute?.model_id;
    const modelProfile = mockAgentLlmSettings.models.find((item) => item.id === selectedModelId)
      || mockAgentLlmSettings.models.find((item) => item.id === mockAgentLlmSettings.selected_model_id)
      || null;
    if ((mode === "act" || taskKind === "problem_repair") && agentModelCapability(modelProfile, "function_call") !== "yes") {
      throw new Error(taskKind === "problem_repair"
        ? "Problem repair requires a compatible function-calling model on the effective agent.act route."
        : "Act is unavailable because its effective model does not declare function_call=yes.");
    }
    const providerProfile = modelProfile
      ? mockAgentLlmSettings.providers.find((item) => item.id === modelProfile.provider_id)
      : null;
    if (taskKind === "problem_repair" && providerProfile?.api_key_required
      && providerProfile.credential_status !== "detected") {
      throw new Error("Problem repair is unavailable because the effective agent.act Provider credential is missing.");
    }
    const turn = createMockAgentTurn({
      prompt: args.prompt || "",
      mode,
      model: modelProfile ? mockEffectiveModelRef(providerProfile, modelProfile) : "deepseek:deepseek-v4-flash",
      editorContext: args.editorContext || null,
      autoApprove: Boolean(args.autoApprove ?? args.auto_approve),
      taskKind,
      capabilityRoute: effectiveRoute?.capability || null,
      conversationId: args.conversationId ?? args.conversation_id ?? null,
    });
    return {
      status: "started",
      turn_id: turn.turn_id,
      conversation_id: turn.conversation_id,
      task_kind: taskKind,
    };
  }
  if (command === "cancel_agent_turn") {
    const turnId = args.turnId ?? args.turn_id;
    const turn = mockAgentTurns.find((item) => item.turn_id === turnId && item.project_root === mockLastProject);
    if (!turn || !["running", "waiting"].includes(turn.status)) {
      throw new Error(`Agent turn is not active: ${turnId}`);
    }
    turn.status = "interrupted";
    turn.terminal_reason = "user_cancelled";
    turn.finished_at = new Date().toISOString();
    turn.error_message = "Agent turn cancelled by the user.";
    for (const approval of mockApprovalRequests.filter((item) =>
      item.turn_id === turn.turn_id
      && item.project_root === mockLastProject
      && item.status === "waiting")) {
      approval.status = "interrupted";
      approval.decision = "cancel";
      approval.reason = "Agent turn cancelled by the user.";
      approval.continuation_outcome = "user_cancelled";
      approval.responded_at = turn.finished_at;
    }
    touchMockAgentConversation(turn, turn.finished_at);
    return { status: "cancelled", turn_id: turn.turn_id };
  }
  if (command === "create_agent_conversation") {
    return structuredClone(mockConversationSummary(createMockAgentConversation()));
  }
  if (command === "list_agent_conversations") {
    return structuredClone(mockAgentConversations
      .filter((item) => item.project_root === mockLastProject && !item.archived_at)
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
      .slice(0, args.limit || 50)
      .map(mockConversationSummary));
  }
  if (command === "list_agent_turns") {
    const conversationId = args.conversationId ?? args.conversation_id ?? null;
    return structuredClone(mockAgentTurns
      .filter((item) => item.project_root === mockLastProject
        && (!conversationId || item.conversation_id === conversationId))
      .slice(0, args.limit || 50)
      .map(mockTurnSummary));
  }
  if (command === "clear_agent_history") {
    const deletedTurnIds = new Set(mockAgentTurns
      .filter((item) => item.project_root === mockLastProject)
      .map((item) => item.turn_id));
    const deleted = deletedTurnIds.size;
    for (let index = mockAgentTurns.length - 1; index >= 0; index -= 1) {
      if (deletedTurnIds.has(mockAgentTurns[index].turn_id)) mockAgentTurns.splice(index, 1);
    }
    for (let index = mockApprovalRequests.length - 1; index >= 0; index -= 1) {
      if (deletedTurnIds.has(mockApprovalRequests[index].turn_id)) mockApprovalRequests.splice(index, 1);
    }
    for (let index = mockAgentConversations.length - 1; index >= 0; index -= 1) {
      if (mockAgentConversations[index].project_root === mockLastProject) mockAgentConversations.splice(index, 1);
    }
    return { deleted };
  }
  if (command === "list_approval_requests") {
    const filtered = (mockApprovalRequests || []).filter((item) =>
      item.project_root === mockLastProject && (!args.status || item.status === args.status));
    return structuredClone(filtered.slice(0, args.limit || 50));
  }
  if (command === "get_agent_turn_detail") {
    const turnId = args.turnId ?? args.turn_id;
    const turn = mockAgentTurns.find((item) => item.turn_id === turnId && item.project_root === mockLastProject);
    if (!turn) return null;
    return structuredClone({
      turn: mockTurnSummary(turn),
      events: turn.events || [],
      approvals: mockApprovalRequests.filter((item) =>
        item.turn_id === turn.turn_id && item.project_root === mockLastProject),
    });
  }
  if (command === "respond_approval") {
    const approval = mockApprovalRequests.find((item) =>
      item.request_id === args.request.request_id && item.project_root === mockLastProject);
    if (!approval) throw new Error(`Approval request not found: ${args.request.request_id}`);
    const turn = mockAgentTurns.find((item) =>
      item.turn_id === approval.turn_id && item.project_root === mockLastProject);
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
      touchMockAgentConversation(turn, approval.responded_at);
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
    touchMockAgentConversation(turn, approval.responded_at);
    return { status: "delivered", request_id: approval.request_id, turn_id: turn.turn_id };
  }
  if (command === "request_environment_operation_preview") {
    const operation = args.request?.operation;
    if (["install_package", "update_package", "remove_package"].includes(operation)
        && !/^[A-Za-z][A-Za-z0-9.]{0,127}$/.test(args.request?.package || "")) {
      throw new Error("Package must be one valid R package name.");
    }
    return structuredClone(createMockEnvironmentOperationRequest(args.request?.operation, args.request || {}));
  }
  if (command === "export_data_view_artifact") {
    const request = args.request || {};
    const outputPath = validateProjectRelativePath(request.path || args.path || "view.csv");
    const format = String(request.format || "").toLowerCase();
    if (!["csv", "tsv"].includes(format)) throw new Error("Visible table export format must be csv or tsv.");
    if (!outputPath.toLowerCase().endsWith(`.${format}`)) throw new Error(`Visible table export path must end with .${format}.`);
    if (mockFileAvailable(mockLastProject, outputPath)) throw new Error(`Artifact path already exists: ${outputPath}`);
    const response = mockReadDataView({
      object_name: request.object_name,
      view_token: request.view_token,
      view_kind: request.view_kind,
      view_key: request.view_key,
      row_offset: request.row_offset,
      row_limit: request.row_limit,
      column_offset: request.column_offset,
      column_limit: request.column_limit,
      query: request.query,
      sort_column: request.sort_column,
      sort_direction: request.sort_direction,
      workspace: request.workspace,
    });
    if (!response.execution?.ok) throw new Error(response.execution?.message || "Workspace data view did not return a page");
    const page = response.execution.page;
    const content = dataViewerDelimitedText(page, format === "tsv" ? "\t" : ",");
    mockUpsertProjectFile(mockLastProject, outputPath, content, { trackInTree: true, kind: "source" });
    state.revision.project_revision += 1;
    updateIdentity(state.revision);
    const run = mockRunForWorkspaceState(
      request.workspace?.kernel_instance_id || "desktop_mock",
      request.workspace?.state_revision,
      request.workspace?.project_revision,
    );
    const sourcePath = run?.source_path || null;
    const documentVersion = run?.document_version ?? null;
    const artifact = createMockArtifactRecord({
      artifactKind: "table_export",
      runId: run?.run_id || null,
      outputPath,
      sourcePath,
      executionMode: "table_export",
      documentVersion,
      workspaceId: request.workspace?.kernel_instance_id || "desktop_mock",
      stateRevision: request.workspace?.state_revision ?? state.revision.state_revision,
      projectRevision: state.revision.project_revision,
      mediaType: format === "tsv" ? "text/tab-separated-values" : "text/csv",
      metadata: {
        object_name: request.object_name,
        view_kind: request.view_kind,
        view_key: request.view_key,
        row_offset: page.row_offset,
        row_count: page.rows?.length || 0,
        column_offset: page.column_offset,
        column_count: page.columns?.length || 0,
        query: page.query,
        sort_column: page.sort_column,
        sort_direction: page.sort_direction,
        format,
      },
      provenanceComplete: Boolean(sourcePath && documentVersion !== null && documentVersion !== undefined),
      incompleteReason: sourcePath && documentVersion !== null && documentVersion !== undefined
        ? null
        : "The exporting run could not be linked to a source document.",
    });
    return mockArtifactView(artifact);
  }
  if (command === "list_artifact_records") {
    const items = mockArtifacts.filter((artifact) =>
      artifact.project_root === mockLastProject
      && (!args.session_only || artifact.workspace_id === "desktop_mock")
    );
    return structuredClone(items.slice(0, args.limit || 100));
  }
  if (command === "get_artifact_record") {
    const artifactId = args.artifact_id ?? args.artifactId;
    return mockArtifactView(mockArtifacts.find((artifact) => artifact.project_root === mockLastProject && artifact.artifact_id === artifactId) || null);
  }
  if (command === "clear_artifact_records") {
    const before = mockArtifacts.length;
    for (let index = mockArtifacts.length - 1; index >= 0; index -= 1) {
      const artifact = mockArtifacts[index];
      if (artifact.project_root !== mockLastProject) continue;
      if (args.session_only && artifact.workspace_id !== "desktop_mock") continue;
      mockArtifacts.splice(index, 1);
    }
    return { deleted: before - mockArtifacts.length };
  }
  if (command === "list_environment_operation_requests") {
    const filtered = mockEnvironmentOperationRequests.filter((item) => !args.status || item.status === args.status);
    return structuredClone(filtered.slice(0, args.limit || 50));
  }
  if (command === "editor_goto_definition") {
    return { file: "analysis.R", line: 42, column: 1 };
  }
  if (command === "editor_find_project_references") {
    const name = args.name || "flag_low_quality";
    const previewState = previewParams.get("state") || "found";
    if (previewState === "error") throw new Error("Workspace reference search is unavailable.");
    if (previewState === "empty") {
      return { name, references: [], matched_count: 0, files_scanned: 4, bytes_scanned: 1200, truncated: false, incomplete: false, notices: [] };
    }
    const longPath = `analysis/${"\u5206\u6790\u7ed3\u679c/".repeat(10)}editor-intelligence.R`;
    const references = [
      { file: previewState === "long" ? longPath : "examples/editor-intelligence.R", line: 1, column: 1, kind: "definition", preview: `${name} <- function(features, mito_percent, doublet_score) {` },
      { file: "examples/editor-intelligence.R", line: 5, column: 22, kind: "reference", preview: `data$needs_review <- ${name}(` },
      { file: "examples/editor-refactor-use.R", line: 1, column: 18, kind: "reference", preview: `review_subset <- ${name}(` },
    ];
    return {
      name,
      references,
      matched_count: previewState === "truncated" ? 243 : references.length,
      files_scanned: 12,
      bytes_scanned: 48210,
      truncated: previewState === "truncated",
      incomplete: previewState === "incomplete" || previewState === "long",
      notices: previewState === "incomplete" || previewState === "long" ? ["parse_incomplete"] : [],
    };
  }
  if (command === "list_installed_packages") {
    return {
      packages: MOCK_BASE_PACKAGES.concat(MOCK_BIOC_PACKAGES),
      total_count: MOCK_BASE_PACKAGES.length + MOCK_BIOC_PACKAGES.length,
      truncated: false,
    };
  }
  if (command === "list_lockfile_packages") {
    return structuredClone(mockLockfileInventory());
  }
  if (command === "resolve_doi") {
    return {
      title: "Example Research Article",
      authors: "Smith, J and Doe, A",
      year: 2024,
      journal: "Nature Methods",
    };
  }
  if (command === "create_evidence_entry") {
    const entry = {
      id: Date.now(),
      project_root: mockLastProject,
      title: args.title,
      notes: args.notes || "",
      doi: args.doi || null,
      run_id: args.run_id || null,
      artifact_id: args.artifact_id || null,
      citation_json: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mockEvidenceEntries.push(entry);
    return structuredClone(entry);
  }
  if (command === "list_evidence_entries") {
    const limit = args.limit || 50;
    let results = structuredClone(mockEvidenceEntries.filter((entry) => entry.project_root === mockLastProject));
    if (args.search) {
      const term = args.search.toLowerCase();
      results = results.filter(
        (e) =>
          e.title.toLowerCase().includes(term) ||
          e.notes.toLowerCase().includes(term)
      );
    }
    return results.slice(0, limit);
  }
  if (command === "get_evidence_entry") {
    return structuredClone(
      mockEvidenceEntries.find((entry) => entry.project_root === mockLastProject && entry.id === args.id) || null
    );
  }
  if (command === "delete_evidence_entry") {
    const idx = mockEvidenceEntries.findIndex((entry) => entry.project_root === mockLastProject && entry.id === args.id);
    if (idx >= 0) {
      mockEvidenceEntries.splice(idx, 1);
      return true;
    }
    return false;
  }
  if (command === "create_evidence_claim") {
    const request = args.request || {};
    if (mockEvidenceClaimCreateFailure) {
      const failure = mockEvidenceClaimCreateFailure;
      mockEvidenceClaimCreateFailure = null;
      throw new Error(failure);
    }
    const evidenceIds = Array.isArray(request.evidence_ids) ? request.evidence_ids : [];
    const evidence = evidenceIds.map((id) => mockEvidenceEntries.find((entry) => entry.project_root === mockLastProject && entry.id === id));
    if (evidence.some((entry) => !entry)) throw new Error("The selected Evidence entry is no longer available in this project.");
    if (request.anchor_kind === "artifact" && !mockArtifacts.some((artifact) => artifact.project_root === mockLastProject && artifact.artifact_id === request.artifact_id)) {
      throw new Error("The selected Artifact is no longer available in this project.");
    }
    const claim = {
      claim_id: `cl_mock_${mockEvidenceClaims.length + 1}`,
      project_root: mockLastProject,
      kind: request.kind,
      summary: request.summary,
      anchor_kind: request.anchor_kind,
      source_path: request.source_path || null,
      start_line: request.start_line || null,
      start_column: request.start_column || null,
      end_line: request.end_line || null,
      end_column: request.end_column || null,
      source_sha256: request.anchor_kind === "source_range" ? "a".repeat(64) : null,
      source_excerpt: request.anchor_kind === "source_range" ? "The treatment group showed a bounded response in the demo analysis." : null,
      artifact_id: request.artifact_id || null,
      linked_evidence_ids: evidenceIds,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mockEvidenceClaims.unshift(claim);
    return structuredClone(claim);
  }
  if (command === "list_evidence_claims") {
    if (!mockEvidenceClaims.length && previewParams.get("preview") === "evidence-claims") seedMockEvidenceClaims();
    return structuredClone(mockEvidenceClaims.filter((claim) => claim.project_root === mockLastProject).slice(0, args.limit || 50));
  }
  if (command === "review_evidence_claim") {
    const claim = mockEvidenceClaims.find((item) => item.project_root === mockLastProject && (item.claim_id === args.claimId || item.claim_id === args.claim_id));
    if (!claim) throw new Error("claim was not found");
    const scenario = claim.mock_status || "linked";
    if (scenario === "cross_project_rejected") {
      return { status: scenario, claim: null, evidence: [], limitations: ["The claim belongs to another project."] };
    }
    const evidence = mockEvidenceEntries.filter((entry) => entry.project_root === mockLastProject && claim.linked_evidence_ids.includes(entry.id));
    const limitations = scenario === "linked" ? [] : [{
      unresolved_source: "The exact claim anchor no longer resolves.",
      missing_evidence: "No Evidence entry is linked to this claim.",
      incomplete_evidence: "At least one linked Evidence entry lacks inspectable metadata or notes.",
    }[scenario] || "The claim cannot be reviewed."];
    return structuredClone({ status: scenario, claim, evidence, limitations });
  }
  if (command === "delete_evidence_claim") {
    const claimId = args.claimId || args.claim_id;
    const index = mockEvidenceClaims.findIndex((item) => item.project_root === mockLastProject && item.claim_id === claimId);
    if (index < 0) return false;
    mockEvidenceClaims.splice(index, 1);
    return true;
  }
  if (command === "editor_discover_chunks") {
    return {
      chunks: [
        { label: "setup",     engine: "r", options: "include=FALSE", start_line: 3,  end_line: 8,  code: 'library(dplyr)\nlibrary(ggplot2)\ntheme_set(theme_minimal())', code_preview: 'library(dplyr)\nlibrary(ggplot2)\ntheme_set(theme_minimal())' },
        { label: "load-data", engine: "r", options: "",               start_line: 10, end_line: 14, code: 'data <- read.csv("input.csv")\nsummary(data)',            code_preview: 'data <- read.csv("input.csv")\nsummary(data)' },
        { label: "unnamed-chunk-3", engine: "r",    options: "fig.width=8",     start_line: 16, end_line: 21, code: 'ggplot(data, aes(x, y)) +\n  geom_point() +\n  labs(title = "Results")', code_preview: 'ggplot(data, aes(x, y)) +\n  geom_point() +\n  labs(title = "Results")' },
        { label: "python-setup",    engine: "python", options: "", start_line: 23, end_line: 26, code: 'import pandas as pd\nimport numpy as np', code_preview: 'import pandas as pd\nimport numpy as np' },
      ],
      total_count: 4,
      truncated: false,
      unsupported: false,
    };
  }
  if (command === "get_environment_operation_request") {
    const requestId = args.requestId ?? args.request_id;
    return structuredClone(mockEnvironmentOperationRequests.find((item) => item.request_id === requestId) || null);
  }
  if (command === "respond_environment_operation") {
    const request = mockEnvironmentOperationRequests.find((item) => item.request_id === args.request.request_id);
    if (!request) throw new Error(`Environment operation request not found: ${args.request.request_id}`);
    const respondedAt = new Date().toISOString();
    request.decision = args.request.decision;
    request.reason = args.request.reason || null;
    request.responded_at = respondedAt;
    if (args.request.decision !== "approve") {
      request.status = args.request.decision === "cancel" ? "cancelled" : "rejected";
      request.completed_at = respondedAt;
      request.terminal_outcome = args.request.decision === "cancel" ? "user_cancelled" : "user_rejected";
      return { request_id: request.request_id, status: request.status, decision: request.decision };
    }
    request.status = "completed";
    request.run_id = recordMockRun({
      origin: "user",
      status: "completed",
      requestType: request.request_name,
      operationClass: "project_mutation",
      code: `${request.request_name}(${request.project_root})`,
      sourcePath: null,
      executionMode: null,
    }).run_id;
    if (request.request_name.startsWith("environment.package_")) {
      state.revision.state_revision += 1;
    } else {
      state.revision.project_revision += 1;
    }
    request.completed_at = respondedAt;
    request.terminal_outcome = "completed";
    const run = mockRuns[0];
    if (run) {
      run.state_revision_after = state.revision.state_revision;
      run.project_revision_after = state.revision.project_revision;
      run.code_preview = request.request_name;
      run.arguments_json = request.arguments_json;
    }
    return {
      execution_id: request.run_id,
      execution: { ok: true, value: `${request.request_name} completed.` },
      workspace: state.revision,
    };
  }
  if (command === "restart_workspace") {
    for (const job of mockRenderJobs.values()) {
      if (job.project_root !== mockLastProject || ["completed", "failed", "interrupted"].includes(job.status)) continue;
      job.status = "interrupted";
      job.message = "Render interrupted while Workspace R restarted.";
      job.terminal_reason = "workspace_restart";
      job.completed_at = new Date().toISOString();
    }
    return mockInvoke("workspace_start", {});
  }
  if (command === "git_status") {
    const working = mockGitReview.working;
    const staged = mockGitReview.staged;
    return {
      is_repo: true,
      branch: "main",
      dirty: working.length > 0 || staged.length > 0,
      ahead: 0,
      behind: 0,
      untracked: working.filter((file) => file.status === "?").length,
      modified: working.filter((file) => file.status !== "?").length,
      staged: staged.length,
    };
  }
  if (command === "git_log") {
    return [
      { hash: "abc12345", author: "Alice", date: "2026-07-30", message: "fix: correct typo in README" },
      { hash: "def67890", author: "Bob", date: "2026-07-29", message: "feat: add initial project scaffold" },
    ];
  }
  if (command === "git_diff") {
    return (args.staged ? mockGitReview.staged : mockGitReview.working).map(({ path, status }) => ({ path, status }));
  }
  if (command === "git_diff_unified") {
    const staged = Boolean(args.staged);
    const file = (staged ? mockGitReview.staged : mockGitReview.working).find((entry) => entry.path === args.filePath);
    if (!file) throw new Error("Selected Git file is unavailable");
    return {
      path: file.path,
      staged,
      revision: mockGitFileRevision(file, staged),
      line_count: file.hunks.reduce((count, hunk) => count + hunk.content.split("\n").length, 0),
      truncated: false,
      hunks: file.hunks.map((hunk, index) => ({
        ...hunk,
        index,
        old_start: index === 0 ? 3 : 16,
        old_count: 3,
        new_start: index === 0 ? 3 : 16,
        new_count: 3,
      })),
    };
  }
  if (command === "git_staged_revision") return mockGitStagedRevision();
  if (["git_stage", "git_unstage_file", "git_restore_file", "git_hunk_stage", "git_hunk_unstage"].includes(command)) {
    const fromStaged = command === "git_unstage_file" || command === "git_hunk_unstage";
    const source = fromStaged ? mockGitReview.staged : mockGitReview.working;
    const target = fromStaged ? mockGitReview.working : mockGitReview.staged;
    const file = source.find((entry) => entry.path === args.filePath);
    if (!file) throw new Error("Stale Git review; refresh before changing files");
    const expected = mockGitFileRevision(file, fromStaged);
    if (args.expectedRevision !== expected) throw new Error("Stale Git review; refresh before changing files");
    if (command === "git_restore_file") {
      if (file.status === "?") throw new Error("Untracked files cannot be restored in Git review");
      source.splice(source.indexOf(file), 1);
    } else if (command === "git_hunk_stage" || command === "git_hunk_unstage") {
      const hunk = file.hunks[args.hunkIndex];
      if (!hunk) throw new Error("Selected Git hunk is unavailable");
      file.hunks.splice(args.hunkIndex, 1);
      let targetFile = target.find((entry) => entry.path === file.path);
      if (!targetFile) {
        targetFile = { path: file.path, status: file.status === "?" ? "A" : file.status, hunks: [] };
        target.push(targetFile);
      }
      targetFile.hunks.push(hunk);
      if (file.hunks.length === 0) source.splice(source.indexOf(file), 1);
    } else {
      source.splice(source.indexOf(file), 1);
      const existing = target.find((entry) => entry.path === file.path);
      if (existing) existing.hunks.push(...file.hunks);
      else target.push({ ...file, status: fromStaged && file.status === "A" ? "?" : file.status, hunks: [...file.hunks] });
    }
    mockGitRevisionSequence += 1;
    return null;
  }
  if (command === "git_commit") {
    if (!String(args.message || "").trim()) throw new Error("Commit message cannot be empty");
    if (args.expectedStagedRevision !== mockGitStagedRevision()) throw new Error("Stale staged changes; refresh before committing");
    if (mockGitReview.staged.length === 0) throw new Error("No staged changes to commit");
    mockGitReview.staged = [];
    mockGitRevisionSequence += 1;
    return "abc123def456";
  }
  if (command === "git_list_conflicts") {
    return { files: ["src/analysis.R", "R/utils.R"], merge_head: "abc1234", has_conflicts: true };
  }
  if (command === "git_resolve_conflict") {
    if (!args.filePath) throw new Error("Selected Git conflict is unavailable");
    return null;
  }
  if (command === "targets_status") {
    return {
      has_targets: true,
      pipeline_name: "qc_analysis, model_fit, report",
      targets_count: 12,
      outdated_count: 2,
      errored_count: 0,
      error: null
    };
  }
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
  $("#editorRenameButton").disabled = busy || state.projectStatus !== "ready" || Boolean(activeDocument()?.readOnly);
  $("#editorExtractButton").disabled = busy || state.projectStatus !== "ready" || Boolean(activeDocument()?.readOnly);
  $("#editorFormatButton").disabled = busy || state.projectStatus !== "ready" || Boolean(activeDocument()?.readOnly);
  $("#editorCheckCodeButton").disabled = busy || state.projectStatus !== "ready" || Boolean(activeDocument()?.readOnly);
  $("#consoleInput").disabled = busy;
  $("#consoleRunButton").disabled = busy;
  setKernelStatus(busy ? "starting" : "idle", busy ? label : "R idle");
}

function updateIdentity(workspace) {
  if (!workspace) return;
  state.revision = { ...state.revision, ...workspace };
}

function documentIsDirty(document) {
  return document.content !== document.savedContent;
}

function activeDocument() {
  return state.documents[state.activeDocument] || null;
}

function workbenchShortcutCommand(event) {
  if (!(event.ctrlKey || event.metaKey)) return null;
  const key = event.key.toLowerCase();
  if (event.altKey) return event.metaKey && !event.shiftKey && key === "f" ? "replace" : null;
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (event.shiftKey) return null;
  return {
    s: "save-file",
    w: "close-file",
    y: "redo",
    f: "find",
    h: "replace",
    "/": "toggle-line-comment",
    n: "new-file",
    o: "open-project",
  }[key] || null;
}

function workbenchShortcutOwnedByInput(target) {
  if (target?.closest?.("#editorFallback")) return false;
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
}

function workbenchShortcutOwnedByDialog() {
  return Boolean(document.querySelector('[role="dialog"]:not(.hidden)'));
}

function keepsNativeContextMenu(target) {
  return Boolean(target?.closest?.(".monaco-editor, input, textarea, select, [contenteditable='true']"));
}

function activeProjectName() {
  return state.project.root.split(/[\\/]/).filter(Boolean).at(-1) || "Rho Project";
}

function supportsMonaco() {
  if (!isDesktop && previewParams.get("editor") === "basic") return false;
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

async function loadEditorFunctions() {
  if (state.editorFunctionsLoaded) return;
  try {
    const result = await invoke("editor_package_functions", { limit: 500 });
    state.editorFunctions = result.functions || [];
  } catch {
    state.editorFunctions = [];
  }
  state.editorFunctionsLoaded = true;
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
        position.lineNumber, word.startColumn, position.lineNumber, word.endColumn,
      );
      const keywordSuggestions = keywords.map((label) => ({
        label, kind: monaco.languages.CompletionItemKind.Keyword,
        insertText: label, range, sortText: `1-${label}`,
      }));
      // Dynamic functions from Air, fall back to hardcoded list
      const funcList = (state.editorFunctions && state.editorFunctions.length > 0)
        ? state.editorFunctions : functions.map((name) => ({ name, package: "base", signature: `${name}()` }));
      const functionSuggestions = funcList.map((f) => ({
        label: f.name,
        kind: monaco.languages.CompletionItemKind.Function,
        insertText: `${f.name}($0)`,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range, sortText: `2-${f.name}`,
        detail: f.package ? `${f.package}::${f.name}` : "R function",
      }));
      const objectSuggestions = state.objects.slice(0, 200).map((object) => ({
        label: object.name,
        kind: monaco.languages.CompletionItemKind.Variable,
        insertText: object.name, range, sortText: `0-${object.name}`,
        detail: stringValues(object.classes).join("/") || object.typeof || "Workspace object",
      }));
      return { suggestions: [...objectSuggestions, ...keywordSuggestions, ...functionSuggestions] };
    },
  });
  // Signature help
  monaco.languages.registerSignatureHelpProvider("r", {
    signatureHelpTriggerCharacters: ["(", ","],
    provideSignatureHelp(model, position) {
      const funcs = state.editorFunctions;
      if (!funcs || !funcs.length) return null;
      // Find the function name before the opening paren
      const textUntilPos = model.getValueInRange(
        new monaco.Range(1, 1, position.lineNumber, position.column)
      );
      const lastOpen = textUntilPos.lastIndexOf("(");
      if (lastOpen < 0) return null;
      const beforeParen = textUntilPos.substring(0, lastOpen).trim();
      const wordMatch = beforeParen.match(/([\w.]+)$/);
      if (!wordMatch) return null;
      const funcName = wordMatch[1];
      const func = funcs.find((f) => f.name === funcName);
      if (!func) return null;
      const params = (func.signature || "").replace(/^function\s*\(/, "").replace(/\)\s*$/, "")
        .split(",").map((p) => p.trim()).filter((p) => p.length > 0);
      // Count commas up to cursor within current paren depth
      let depth = 0, commas = 0;
      for (let i = lastOpen; i < textUntilPos.length; i++) {
        const ch = textUntilPos[i];
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        else if (ch === "," && depth === 1) commas++;
      }
      return {
        activeSignature: 0,
        activeParameter: Math.min(commas, params.length - 1),
        signatures: [{
          label: func.signature || `${funcName}()`,
          documentation: `${func.package || "R"}::${funcName}`,
          parameters: params.map((p) => ({ label: p, documentation: "" })),
        }],
      };
    },
  });
  // Hover provider (async — queries Air for help text)
  monaco.languages.registerHoverProvider("r", {
    async provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      // Try Air-backed help
      if (state.editorFunctionsLoaded) {
        try {
          const help = await invoke("editor_function_help", { name: word.word });
          if (help && help.signature) {
            const contents = [
              { value: `**${help.package || "R"}::${help.name}**` },
              { value: "```r\n" + help.signature + "\n```" },
            ];
            if (help.help_title) contents.push({ value: `*${help.help_title}*` });
            if (help.help_text) contents.push({ value: help.help_text });
            if (help.help_record) contents.push({ value: `Local Help: \`${help.package || "R"}::${help.help_topic || help.name}\`` });
            if (help.source_path) contents.push({ value: "Installed source reference available in the Help panel." });
            return {
              range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
              contents,
            };
          }
        } catch {
          // Fall back to cached signature
        }
      }
      // Fallback: cached function list
      const funcs = state.editorFunctions;
      if (!funcs || !funcs.length) return null;
      const func = funcs.find((f) => f.name === word.word);
      if (!func) return null;
      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents: [
          { value: `**${func.package || "R"}::${func.name}**` },
          { value: "```r\n" + (func.signature || `${func.name}()`) + "\n```" },
        ],
      };
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
  if (state.fileEditUndo?.path === documentState.path && state.fileEditUndo.afterContent !== documentState.content) {
    state.fileEditUndo = null;
    state.fileEditUndoVerifiedKey = null;
    renderFileEditPanel();
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

const VIEWER_FILE_LIMIT = 4 * 1024 * 1024;
const VIEWER_HTML_LIMIT = 32 * 1024 * 1024;
const VIEWER_TABLE_ROW_LIMIT = 500;
const VIEWER_TABLE_COLUMN_LIMIT = 100;

function viewerPathExtension(path) {
  return String(path || "").split(".").pop()?.toLowerCase() || "";
}

function viewerTypeLabel(kind, mediaType) {
  if (kind === "plot") return "Plot";
  if (mediaType === "text/markdown") return "Markdown preview";
  if (mediaType === "text/html") return "Interactive HTML";
  if (mediaType === "image/png") return "PNG image";
  if (mediaType === "image/jpeg") return "JPEG image";
  if (mediaType === "image/gif") return "GIF image";
  if (mediaType === "image/webp") return "WebP image";
  if (mediaType === "text/csv") return "CSV table";
  if (mediaType === "text/tab-separated-values") return "TSV table";
  if (mediaType === "text/x-r" || mediaType === "text/x-r-markdown") return "R source";
  return "Output";
}

function viewerSetNotice(message) {
  state.viewer.notice = message || null;
  const notice = $("#viewerNotice");
  notice.textContent = message || "";
  notice.classList.toggle("hidden", !message);
}

function viewerSafeMarkdown(content) {
  if (typeof window.marked?.parse !== "function" || typeof window.DOMPurify?.sanitize !== "function") {
    throw new Error("Markdown preview dependencies are unavailable.");
  }
  const html = window.marked.parse(content, { gfm: true, breaks: false });
  const sanitizeOptions = {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "base", "meta"],
    FORBID_ATTR: ["style", "srcset", "onerror", "onclick", "onload", "onmouseover"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  };
  const sanitized = window.DOMPurify.sanitize(html, sanitizeOptions);
  if (typeof window.renderMathInElement !== "function") return sanitized;
  const container = document.createElement("div");
  container.innerHTML = sanitized;
  window.renderMathInElement(container, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "\\[", right: "\\]", display: true },
      { left: "$", right: "$", display: false },
      { left: "\\(", right: "\\)", display: false },
    ],
    throwOnError: false,
    output: "html",
  });
  return window.DOMPurify.sanitize(container.innerHTML, sanitizeOptions);
}

function viewerSandboxHtml(content) {
  const parser = new DOMParser();
  const document = parser.parseFromString(content, "text/html");
  document.querySelectorAll("base, meta[http-equiv='refresh']").forEach((node) => node.remove());
  const csp = document.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; navigate-to 'none'";
  document.head.prepend(csp);
  const navigationGuard = document.createElement("script");
  navigationGuard.textContent = `(() => {
    document.addEventListener("click", (event) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!link) return;
      const href = link.getAttribute("href") || "";
      event.preventDefault();
      if (!href.startsWith("#")) {
        event.stopImmediatePropagation();
        return;
      }
      if (href === "#") {
        window.scrollTo({ top: 0, left: 0 });
        return;
      }
      let fragment = href.slice(1);
      try {
        fragment = decodeURIComponent(fragment);
      } catch {}
      const target = document.getElementById(fragment) || document.getElementsByName(fragment)[0];
      target?.scrollIntoView({ block: "start" });
    }, true);
  })();`;
  csp.after(navigationGuard);
  const doctype = "<!doctype html>";
  return `${doctype}${document.documentElement.outerHTML}`;
}

function viewerHtmlResourceWarning(content) {
  return /(?:\b(?:src|href)\s*=\s*["'](?!data:|blob:|#|javascript:)|fetch\s*\(|XMLHttpRequest|WebSocket|\burl\s*\()/i.test(content)
    ? "External resources were blocked. V1 supports self-contained HTML only."
    : null;
}

function viewerRenderTable(content, extension) {
  if (typeof window.Papa?.parse !== "function") throw new Error("CSV preview dependency is unavailable.");
  const parsed = window.Papa.parse(content, {
    delimiter: extension === "tsv" ? "\t" : ",",
    newline: "",
    skipEmptyLines: false,
  });
  if (parsed.errors?.length) throw new Error(`Table parsing failed: ${parsed.errors[0].message || "malformed input"}`);
  const rows = Array.isArray(parsed.data) ? parsed.data : [];
  const maxColumns = Math.min(VIEWER_TABLE_COLUMN_LIMIT, rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0));
  const truncatedRows = rows.length > VIEWER_TABLE_ROW_LIMIT;
  const truncatedColumns = rows.some((row) => Array.isArray(row) && row.length > VIEWER_TABLE_COLUMN_LIMIT);
  const table = document.createElement("table");
  table.className = "viewer-table";
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const headerValues = rows[0] || [];
  for (let column = 0; column < maxColumns; column += 1) {
    const cell = document.createElement("th");
    cell.textContent = headerValues[column] || `Column ${column + 1}`;
    headerRow.append(cell);
  }
  head.append(headerRow);
  table.append(head);
  const body = document.createElement("tbody");
  for (const row of rows.slice(1, VIEWER_TABLE_ROW_LIMIT + 1)) {
    const tr = document.createElement("tr");
    for (let column = 0; column < maxColumns; column += 1) {
      const cell = document.createElement("td");
      cell.textContent = Array.isArray(row) ? String(row[column] ?? "") : "";
      tr.append(cell);
    }
    body.append(tr);
  }
  table.append(body);
  return { table, truncated: truncatedRows || truncatedColumns, rowCount: Math.max(0, rows.length - 1), columnCount: maxColumns };
}

function viewerRenderPreview() {
  const target = $("#viewerPreviewContent");
  target.replaceChildren();
  const viewer = state.viewer;
  if (viewer.error) {
    const error = document.createElement("div");
    error.className = "viewer-error";
    error.textContent = viewer.error;
    target.append(error);
    return;
  }
  if (viewer.busy) {
    const loading = document.createElement("div");
    loading.className = "viewer-empty";
    loading.textContent = "Loading preview...";
    target.append(loading);
    return;
  }
  try {
    if (viewer.kind === "plot") {
      const image = document.createElement("img");
      image.className = "plot-image";
      image.alt = viewer.title || "R plot";
      image.src = viewer.content;
      target.append(image);
      $("#viewerPreviewStatus").textContent = "static image";
    } else if (viewer.mediaType === "text/markdown") {
      const article = document.createElement("article");
      article.className = "viewer-markdown";
      article.innerHTML = viewerSafeMarkdown(viewer.content);
      article.querySelectorAll("a").forEach((link) => {
        link.removeAttribute("href");
        link.setAttribute("aria-disabled", "true");
        link.title = "External links are disabled in preview";
      });
      target.append(article);
      $("#viewerPreviewStatus").textContent = "non-executing";
    } else if (viewer.mediaType === "text/html") {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.setAttribute("title", viewer.title || "Interactive HTML output");
      frame.srcdoc = viewerSandboxHtml(viewer.content);
      target.append(frame);
      $("#viewerPreviewStatus").textContent = "sandboxed";
      viewerSetNotice(viewerHtmlResourceWarning(viewer.content));
    } else if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(viewer.mediaType)) {
      const image = document.createElement("img");
      image.className = "viewer-image-output";
      image.alt = viewer.title || "Image output";
      image.src = "data:" + viewer.mediaType + ";base64," + viewer.content;
      target.append(image);
      $("#viewerPreviewStatus").textContent = "image preview";
    } else if (["text/x-r", "text/x-r-markdown", "text/plain", "application/json"].includes(viewer.mediaType)) {
      const code = document.createElement("pre");
      code.className = "viewer-code-output";
      code.textContent = viewer.content;
      target.append(code);
      $("#viewerPreviewStatus").textContent = "source preview";
    } else if (["text/csv", "text/tab-separated-values"].includes(viewer.mediaType)) {
      const parsed = viewerRenderTable(viewer.content, viewerTypeLabel(viewer.kind, viewer.mediaType).startsWith("TSV") ? "tsv" : "csv");
      const wrapper = document.createElement("div");
      wrapper.className = "viewer-table-wrap";
      wrapper.append(parsed.table);
      target.append(wrapper);
      $("#viewerPreviewStatus").textContent = `${parsed.rowCount} rows · ${parsed.columnCount} columns`;
      if (parsed.truncated) viewerSetNotice(`Table preview is bounded to ${VIEWER_TABLE_ROW_LIMIT} rows and ${VIEWER_TABLE_COLUMN_LIMIT} columns.`);
    } else {
      const empty = document.createElement("div");
      empty.className = "viewer-empty";
      empty.textContent = "No preview is available for this output.";
      target.append(empty);
    }
  } catch (error) {
    state.viewer.error = String(error?.message || error);
    const failure = document.createElement("div");
    failure.className = "viewer-error";
    failure.textContent = state.viewer.error;
    target.replaceChildren(failure);
  }
}

function renderViewer() {
  const viewerRegion = $("#viewerRegion");
  const viewer = state.viewer;
  viewerRegion.classList.toggle("hidden", !viewer.open);
  viewerRegion.classList.remove("viewer-mode-both", "viewer-mode-source", "viewer-mode-preview");
  viewerRegion.classList.add(`viewer-mode-${viewer.mode}`);
  $(".workspace").classList.toggle("viewer-open", viewer.open);
  $("#viewerTitle").textContent = viewer.title || "No output selected";
  $("#viewerMeta").textContent = viewer.open ? [viewerTypeLabel(viewer.kind, viewer.mediaType), viewer.path || ""].filter(Boolean).join(" · ") : "";
  $("#viewerSourcePath").textContent = viewer.sourcePath || viewer.path || "";
  $("#viewerSourceContent").textContent = viewer.sourceContent || viewer.content || "";
  const sourceIsActiveDocument = Boolean(viewer.sourcePath && viewer.sourcePath === state.activeDocument);
  $("#viewerOpenSource").classList.toggle("hidden", !viewer.sourcePath || sourceIsActiveDocument);
  $("#viewerOpenSource").disabled = !viewer.sourcePath || sourceIsActiveDocument;
  for (const button of $$('[data-viewer-mode]')) {
    const selected = button.dataset.viewerMode === viewer.mode;
    button.setAttribute("aria-pressed", String(selected));
  }
  viewerSetNotice(viewer.notice);
  viewerRenderPreview();
}

function closeViewer() {
  state.viewer = { ...state.viewer, open: false, busy: false, error: null, notice: null };
  renderViewer();
}

async function openViewer(input) {
  const requestRoot = state.project.root;
  const viewer = {
    ...state.viewer,
    open: true,
    busy: true,
    error: null,
    notice: null,
    kind: input.kind || "file",
    path: input.path || null,
    title: input.title || input.path || "Output",
    sourcePath: input.sourcePath || input.path || null,
    artifactId: input.artifactId || null,
    sourceContent: input.sourceContent || "",
    content: "",
    mediaType: input.mediaType || null,
  };
  state.viewer = viewer;
  renderViewer();
  try {
    if (input.kind === "plot") {
      state.viewer.content = input.content || "";
      state.viewer.mediaType = "image/png";
    } else if (input.content !== undefined) {
      const contentLimit = viewerPathExtension(input.path) === "html" ? VIEWER_HTML_LIMIT : VIEWER_FILE_LIMIT;
      if (new Blob([String(input.content)]).size > contentLimit) throw new Error(`Current editor buffer is too large for preview (limit: ${contentLimit} bytes).`);
      state.viewer.content = String(input.content);
      state.viewer.mediaType = input.mediaType || ({ md: "text/markdown", html: "text/html", r: "text/x-r", rmd: "text/x-r-markdown", txt: "text/plain", json: "application/json", csv: "text/csv", tsv: "text/tab-separated-values" }[viewerPathExtension(input.path)] || "text/plain");
    } else {
      const result = await invoke("viewer_read_file", { path: input.path });
      if (result.project_root !== state.project.root || result.project_root !== requestRoot) throw new Error("The project changed while loading this output.");
      state.viewer.path = result.path;
      state.viewer.content = result.content;
      state.viewer.mediaType = result.media_type;
    }
    if (!state.viewer.sourceContent && state.viewer.kind !== "plot") state.viewer.sourceContent = state.viewer.content;
    state.viewer.busy = false;
    renderViewer();
  } catch (error) {
    state.viewer.busy = false;
    state.viewer.error = reportUiFailure("open Viewer output", error, "The output could not be previewed. Open it as source or refresh the project.");
    renderViewer();
  }
}

async function openViewerForActiveDocument() {
  const document = activeDocument();
  if (!document || !state.activeDocument) return;
  const extension = viewerPathExtension(state.activeDocument);
  if (!["md", "html", "r", "rmd", "txt", "json", "csv", "tsv"].includes(extension)) {
    toast("Preview is not available for this file.", true);
    return;
  }
  syncDocumentFromEditor({ render: false, persist: false });
  await openViewer({ path: state.activeDocument, title: state.activeDocument, sourcePath: state.activeDocument, content: document.content, mediaType: ({ md: "text/markdown", html: "text/html", r: "text/x-r", rmd: "text/x-r-markdown", txt: "text/plain", json: "application/json", csv: "text/csv", tsv: "text/tab-separated-values" })[extension] });
}

async function openSelectedOutputInViewer() {
  if (state.selectedPlotId) {
    const plot = state.plots.find((item) => item.plot_id === state.selectedPlotId);
    const payload = plotImageSource(parseJsonObject(plot?.payload_json));
    if (plot && payload) return openViewer({ kind: "plot", title: "Plot", sourcePath: plot.source_path || null, content: payload });
  }
  const artifact = state.selectedArtifactDetail?.artifact || state.artifacts.find((item) => item.artifact_id === state.selectedArtifactId);
  if (!artifact?.output_path) return toast("Select an output to preview.", true);
  return openViewer({ kind: "artifact", path: artifact.output_path, title: pathFileName(artifact.output_path), sourcePath: artifact.source_path || null, artifactId: artifact.artifact_id });
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

function updateRunButtonLabel() {
  const label = runButtonLabel();
  const span = document.querySelector("#runButton span:last-child");
  if (span) span.textContent = label;
  $("#runButton").title = label;
  $("#runButton").setAttribute("aria-label", label);
  // Also update the editor Run button title
  $("#editorRunButton").title = label;
}

function runButtonLabel() {
  if (state.projectStatus !== "ready") return "Run";
  const documentState = activeDocument();
  if (!documentState) return "Run";
  const { start, end } = currentEditorOffsets();
  if (start !== end) return "Run selected code";
  const position = currentCursorPosition();
  if (position.line > 0) return "Run current line";
  return "Run file";
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
  // Dynamic Run button label
  updateRunButtonLabel();
  const documentReadOnly = Boolean(activeDocument()?.readOnly);
  const documentActionsDisabled = state.projectStatus !== "ready" || state.busy || documentReadOnly;
  $("#runButton").disabled = documentActionsDisabled;
  $("#editorRunButton").disabled = documentActionsDisabled;
  $("#editorRunFileButton").disabled = documentActionsDisabled;
  $("#saveFileButton").disabled = state.projectStatus !== "ready" || documentReadOnly;
  $("#editorRenameButton").disabled = documentActionsDisabled;
  $("#editorExtractButton").disabled = documentActionsDisabled;
  $("#editorFormatButton").disabled = documentActionsDisabled || !activeDocument()?.path?.toLowerCase().endsWith(".r");
  $("#editorCheckCodeButton").disabled = documentActionsDisabled || !activeDocument()?.path?.toLowerCase().endsWith(".r");
  renderEnvironmentSummary();
}

function applyDocumentSelection(documentState) {
  if (!documentState) return;
  if (state.editor.mode === "monaco" && state.editor.editor) {
    const model = ensureDocumentModel(documentState);
    if (!model) return;
    state.editor.editor.setModel(model);
    state.editor.editor.updateOptions({
      readOnly: state.projectStatus !== "ready" || Boolean(documentState.readOnly),
    });
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
    editor.disabled = state.projectStatus !== "ready" || Boolean(documentState.readOnly);
    editor.value = documentState.content;
    editor.selectionStart = Math.min(documentState.cursorStart ?? 0, editor.value.length);
    editor.selectionEnd = Math.min(documentState.cursorEnd ?? documentState.cursorStart ?? 0, editor.value.length);
    ensureFallbackEditorHistory(documentState);
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
    loadEditorFunctions();
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
    state.editor.editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, () => runWorkbenchMenuCommand("save-file"));
    state.editor.editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyW, () => runWorkbenchMenuCommand("close-file"));
    state.editor.editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyZ, () => runWorkbenchMenuCommand("undo"));
    state.editor.editor.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, () => runWorkbenchMenuCommand("redo"));
    state.editor.editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyY, () => runWorkbenchMenuCommand("redo"));
    state.editor.editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyF, () => runWorkbenchMenuCommand("find"));
    state.editor.editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyH, () => runWorkbenchMenuCommand("replace"));
    state.editor.editor.addCommand(KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyF, () => runWorkbenchMenuCommand("replace"));
    state.editor.editor.addCommand(KeyMod.CtrlCmd | KeyCode.Slash, () => runWorkbenchMenuCommand("toggle-line-comment"));
    state.editor.editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyN, () => runWorkbenchMenuCommand("new-file"));
    state.editor.editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyO, () => runWorkbenchMenuCommand("open-project"));
    state.editor.editor.addCommand(KeyMod.CtrlCmd | KeyCode.Enter, () => runSelectionOrCurrentLine());
    state.editor.editor.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter, () => runActiveFile());
    state.editor.editor.addCommand(KeyCode.F12, () => gotoDefinitionAtCursor());
    state.editor.editor.addAction({
      id: "rho.findProjectReferences",
      label: "Find Project References",
      keybindings: [KeyMod.Shift | KeyCode.F12],
      contextMenuGroupId: "navigation",
      run: () => findProjectReferencesAtCursor(),
    });
    state.editor.editor.addAction({
      id: "rho.renameSymbol",
      label: "Rename Symbol",
      keybindings: [KeyCode.F2],
      contextMenuGroupId: "1_modification",
      run: () => requestRenameSymbol(),
    });
    state.editor.editor.addAction({
      id: "rho.extractFunction",
      label: "Extract Function",
      keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyE],
      contextMenuGroupId: "1_modification",
      run: () => requestExtractFunction(),
    });
    state.editor.editor.addAction({
      id: "rho.formatDocument",
      label: "Format Document",
      keybindings: [KeyMod.Shift | KeyMod.Alt | KeyCode.KeyF],
      contextMenuGroupId: "1_modification",
      run: () => requestFormatDocument(),
    });
    // Ctrl+Click on Windows/Linux or Command+Click on macOS.
    state.editor.editor.onMouseDown((e) => {
      if ((e.event.ctrlKey || e.event.metaKey) && e.target.type === 6 /* CONTENT_WORD */) {
        gotoDefinitionAtCursor();
      }
    });
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
    const content = model.getValue();
    const text = normalizeExecutableCode(model.getValueInRange(selection));
    if (start === end || !text.trim()) return null;
    return {
      code: text,
      type: "selection",
      sourcePath: documentState.path,
      documentVersion: documentState.versionId ?? model.getAlternativeVersionId(),
      range: { start, end },
      sourceRange: executableSourceRange(content, { start, end }, text),
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
    sourceRange: executableSourceRange(
      editor.value,
      { start: editor.selectionStart, end: editor.selectionEnd },
      text,
    ),
  };
}

function currentLineExecution() {
  const documentState = activeDocument();
  if (!documentState) return null;
  if (state.editor.mode === "monaco" && state.editor.editor?.getModel()) {
    const model = state.editor.editor.getModel();
    const position = state.editor.editor.getPosition();
    const line = position?.lineNumber || 1;
    const code = normalizeExecutableCode(model.getLineContent(line));
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
      sourceRange: executableSourceRange(
        model.getValue(),
        {
          start: model.getOffsetAt({ lineNumber: line, column: 1 }),
          end: model.getOffsetAt({ lineNumber: line, column: model.getLineMaxColumn(line) }),
        },
        code,
      ),
      line,
    };
  }
  const value = fallbackEditor().value;
  const caret = fallbackEditor().selectionStart;
  const lineStart = value.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  const nextBreak = value.indexOf("\n", caret);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const code = normalizeExecutableCode(value.slice(lineStart, lineEnd));
  if (!code.trim()) return null;
  return {
    code,
    type: "line",
    sourcePath: documentState.path,
    documentVersion: documentState.versionId ?? 0,
    range: { start: lineStart, end: lineEnd },
    sourceRange: executableSourceRange(value, { start: lineStart, end: lineEnd }, code),
    line: value.slice(0, lineStart).split("\n").length,
  };
}

function fileExecution() {
  const documentState = activeDocument();
  if (!documentState) return null;
  syncDocumentFromEditor({ render: false, persist: false });
  const rawCode = documentState.content;
  const code = normalizeExecutableCode(rawCode);
  if (!code.trim()) return null;
  return {
    code,
    type: "file",
    sourcePath: documentState.path,
    documentVersion: documentState.versionId ?? 0,
    range: { start: 0, end: rawCode.length },
    sourceRange: executableSourceRange(rawCode, { start: 0, end: rawCode.length }, code),
  };
}

function setProjectStatus(status, unavailable = null) {
  state.projectStatus = status;
  state.unavailable = unavailable;
  if (status !== "ready" && state.viewer.open) closeViewer();
  const disabled = status !== "ready";
  setEditorDisabled(disabled);
  $("#runButton").disabled = disabled || state.busy;
  $("#editorRunButton").disabled = disabled || state.busy;
  $("#editorRunFileButton").disabled = disabled || state.busy;
  $("#saveFileButton").disabled = disabled;
  $("#editorRenameButton").disabled = disabled || state.busy;
  $("#editorExtractButton").disabled = disabled || state.busy;
  $("#editorFormatButton").disabled = disabled || state.busy;
  $(".new-tab").disabled = disabled;
  $("#projectName").textContent = unavailable?.path?.split(/[\\/]/).filter(Boolean).at(-1) || activeProjectName();
  $("#projectTreeRoot").textContent = displayPath(unavailable?.path || state.project.root) || "No project";
  $("#projectBanner").classList.toggle("hidden", status === "ready");
  $("#projectBannerTitle").textContent = status === "unavailable" ? "Project unavailable" : "Open an R project to begin";
  $("#projectBannerMessage").textContent = unavailable
    ? `${displayPath(unavailable.path)} · ${unavailable.reason}`
    : "Select a project directory to connect a workspace.";
  $("#projectFileList").classList.toggle("hidden", status !== "ready");
  $("#projectEmptyState").classList.toggle("hidden", status === "ready");
  $("#projectEmptyState").textContent = status === "unavailable"
    ? "Saved project is unavailable. Choose another directory."
    : "Open a project to get started.";
  renderProjectSkills();
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
  const persistentDocuments = Object.values(state.documents).filter((document) => !document.transient);
  return {
    open_documents: persistentDocuments.map(documentSession),
    closed_documents: Object.entries(state.closedDrafts).map(([path, draft]) => ({
      path,
      cursor_start: draft.cursor_start ?? 0,
      cursor_end: draft.cursor_end ?? 0,
      draft_content: draft.draft_content ?? null,
    })),
    active_document: activeDocument()?.transient ? null : state.activeDocument,
    panels: currentPanelSnapshot(),
    posture: state.posture,
    agent_surface: state.agentSurface,
    human_preset: state.humanPreset,
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
    toast(reportUiFailure("save session state", error, "The session layout could not be saved. Your project files are unchanged."), true);
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

function editorPositionAtOffset(content, offset) {
  const bounded = Math.max(0, Math.min(String(content || "").length, Number(offset) || 0));
  const prefix = String(content || "").slice(0, bounded);
  const lastBreak = prefix.lastIndexOf("\n");
  return {
    line: prefix.split("\n").length,
    column: bounded - lastBreak,
  };
}

function executableSourceRange(content, offsets, code) {
  const value = String(content || "");
  const normalizedCode = String(code || "");
  const start = Number(offsets?.start);
  const end = Number(offsets?.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > value.length) return null;
  const raw = value.slice(start, end);
  const marker = raw.match(/^[\uFEFF\u200B\u200C\u200D\u2060]+/)?.[0] || "";
  const position = editorPositionAtOffset(value, start + marker.length);
  const lines = normalizedCode.split("\n");
  return {
    start_line: position.line,
    start_column: position.column,
    end_line: position.line + lines.length - 1,
    end_column: lines.length === 1
      ? position.column + lines[0].length
      : lines.at(-1).length + 1,
  };
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
    summary.title = directory.path;
    const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chevron.classList.add("ui-icon", "tree-directory-chevron");
    chevron.setAttribute("aria-hidden", "true");
    const chevronUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
    chevronUse.setAttribute("href", "#icon-chevron-right");
    chevron.append(chevronUse);
    const folder = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    folder.classList.add("ui-icon", "tree-directory-icon");
    folder.setAttribute("aria-hidden", "true");
    const folderUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
    folderUse.setAttribute("href", "#icon-folder");
    folder.append(folderUse);
    const name = document.createElement("span");
    name.className = "tree-directory-name";
    name.textContent = directory.name;
    summary.append(chevron, folder, name);
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
    const selected = fileDocument.path === state.activeDocument;
    const button = document.createElement("div");
    button.className = `document-tab ${selected ? "active" : ""}`;
    const icon = document.createElement("span");
    icon.className = "r-badge";
    icon.textContent = fileDocument.path.toLowerCase().endsWith(".r") ? "R" : "·";
    const label = document.createElement("span");
    label.textContent = fileDocument.displayName || fileDocument.path;
    const dirty = document.createElement("span");
    dirty.className = `unsaved ${documentIsDirty(fileDocument) ? "" : "hidden"}`;
    dirty.textContent = "●";
    const activate = document.createElement("button");
    activate.type = "button";
    activate.className = "document-tab-main";
    activate.setAttribute("role", "tab");
    activate.setAttribute("aria-selected", String(selected));
    activate.setAttribute("title", fileDocument.displayName || fileDocument.path);
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
    if (state.posture === "agent" && state.agentWorkSurface === "file") {
      $("#agentFileSurfaceTitle").textContent = "No file selected";
    }
    return;
  }
  $("#projectName").textContent = activeProjectName();
  applyDocumentSelection(documentState);
  renderProjectFiles();
  renderDocumentTabs();
  updateEditorChrome();
  if (state.posture === "agent" && state.agentWorkSurface === "file") {
    $("#agentFileSurfaceTitle").textContent = displayPath(documentState.path);
  }
}

async function restoreDraftChoice(path, savedContent, draftContent) {
  if (draftContent === null || draftContent === undefined || draftContent === savedContent) return savedContent;
  const restore = await confirmAction({
    title: "Restore unsaved draft",
    message: `${path} has unsaved changes.`,
    confirmLabel: "Restore draft",
    cancelLabel: "Load disk version",
  });
  return restore ? draftContent : savedContent;
}

async function openDocument(path, options = {}) {
  const { sessionEntry = null, forceReload = false, revealWorkSurface = true, preserveActive = false } = options;
  const previousActive = state.activeDocument;
  if (state.activeDocument && state.activeDocument !== path) {
    syncDocumentFromEditor({ render: false, persist: false });
    clearAgentEditHighlight();
  }
  if (state.documents[path]?.transient) {
    state.activeDocument = path;
    renderActiveDocument();
    if (preserveActive && state.activeDocument === path) {
      state.activeDocument = previousActive;
      renderActiveDocument();
    }
    if (revealWorkSurface && state.posture === "agent") openAgentWorkSurface("file");
    requestAnimationFrame(() => layoutEditor());
    return;
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
      toast(reportUiFailure("open project file", error, "The file could not be opened. Refresh the project and try again."), true);
      return;
    }
  }
  state.activeDocument = path;
  renderActiveDocument();
  if (preserveActive && state.activeDocument === path) {
    state.activeDocument = previousActive;
    renderActiveDocument();
  }
  if (revealWorkSurface && state.posture === "agent") openAgentWorkSurface("file");
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
    await loadProjectSkills();
    renderProjectFiles();
    const first = state.activeDocument && state.project.files.some((file) => file.path === state.activeDocument)
      ? state.activeDocument
      : state.project.files[0]?.path;
    if (first) await openDocument(first);
  } catch (error) {
    toast(reportUiFailure("refresh project", error, "The project could not be refreshed. Check that it is still available and try again."), true);
  }
}

async function saveActiveDocument() {
  const documentState = activeDocument();
  if (!documentState) return;
  if (documentState.readOnly) return;
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
    addLog("SYSTEM", `Saved ${documentState.path}`);
    scheduleSessionSave();
  } catch (error) {
    state.internalProjectWrites.delete(documentState.path);
    toast(reportUiFailure("save project file", error, "The file could not be saved. Check the project and try again."), true);
  }
}

async function createDocument() {
  if (state.projectStatus !== "ready") return;
  const name = await promptForPath({
    title: "Create analysis script",
    message: "Enter a project-relative path for the new R file.",
    defaultValue: "analysis.R",
  });
  if (!name) return;
  const path = name.replace(/^[\\/]+/, "");
  try {
    state.internalProjectWrites.set(path, { content: "", expiresAt: Date.now() + 5000 });
    state.project = await invoke("project_create_file", { path, content: "" });
    await openDocument(path);
    scheduleSessionSave();
  } catch (error) {
    state.internalProjectWrites.delete(path);
    toast(reportUiFailure("create project file", error, "The file could not be created. Check the project path and try again."), true);
  }
}

function scrollConsoleToPrompt() {
  const terminal = $("#consoleTerminal");
  terminal.scrollTop = terminal.scrollHeight;
}

function addTerminalOutput(text, kind = "") {
  if (text === null || text === undefined || text === "") return;
  const entry = document.createElement("div");
  entry.className = `terminal-entry ${kind}`.trim();
  entry.textContent = String(text);
  $("#consoleOutput").append(entry);
  scrollConsoleToPrompt();
}

function normalizedProjectRootValue(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function consoleRepairEntryIsCurrent(entry) {
  return entry.projectRefreshSequence === state.projectRefreshSequence
    && normalizedProjectRootValue(entry.projectRoot) === normalizedProjectRootValue(state.project.root);
}

function setConsoleRepairEntryState(entry, {
  label,
  status,
  title = "",
  disabled = false,
  statusKind = "",
  activate = null,
}) {
  entry.button.textContent = label;
  entry.button.title = title;
  entry.button.disabled = disabled;
  entry.button.onclick = disabled || !activate ? null : activate;
  entry.status.textContent = status;
  entry.status.className = `console-repair-status ${statusKind}`.trim();
}

function consoleRepairProblemForEntry(entry) {
  return state.problems.find((problem) => {
    if (problem.transient || String(problem.run_id || "") !== entry.runId) return false;
    return !problem.project_root
      || normalizedProjectRootValue(problem.project_root) === normalizedProjectRootValue(entry.projectRoot);
  }) || null;
}

function consoleRepairRetryAvailable(entry) {
  const refreshFailed = entry.lastFailedRefreshSequence >= entry.minimumRefreshRequestSequence
    && state.problemRefreshAppliedSequence < entry.minimumRefreshRequestSequence;
  return refreshFailed ? entry.retryCount < 2 : entry.retryCount < 1;
}

async function retryConsoleRepairContext(entry) {
  if (!consoleRepairEntryIsCurrent(entry) || entry.busy || !consoleRepairRetryAvailable(entry)) return;
  entry.retryCount += 1;
  entry.busy = true;
  entry.busyLabel = "Refreshing repair context…";
  syncConsoleRepairEntry(entry);
  const refreshed = await loadRunData({ quiet: true });
  entry.busy = false;
  entry.busyLabel = "";
  syncConsoleRepairEntry(entry);
  if (!consoleRepairEntryIsCurrent(entry) || entry.problem) return;
  if (!refreshed && consoleRepairRetryAvailable(entry)) {
    toast("Rho could not refresh this failed run yet. Retry repair context once more.", true);
  } else {
    toast("No durable Problem matched this failed run. Run the code again to create fresh repair context.", true);
  }
}

async function activateConsoleRepairEntry(entry) {
  if (!consoleRepairEntryIsCurrent(entry) || !entry.problem || entry.busy) return;
  entry.busy = true;
  entry.busyLabel = "Starting Agent repair…";
  syncConsoleRepairEntry(entry);
  try {
    await activateProblemRepairAction(entry.problem);
  } finally {
    entry.busy = false;
    entry.busyLabel = "";
    syncConsoleRepairEntry(entry);
  }
}

function syncConsoleRepairEntry(entry) {
  if (!entry?.element?.isConnected) {
    state.consoleRepairEntries.delete(entry?.id);
    return;
  }
  if (entry.expired) {
    setConsoleRepairEntryState(entry, {
      label: "Repair expired",
      status: "Run the code again to create current repair context.",
      title: "Rho keeps only a bounded number of live Console repair actions.",
      disabled: true,
      statusKind: "unavailable",
    });
    return;
  }
  if (!consoleRepairEntryIsCurrent(entry)) {
    entry.problem = null;
    setConsoleRepairEntryState(entry, {
      label: "Previous-project error",
      status: "Repair is disabled because the active project changed.",
      title: "Return to the original project and run the code again to create current repair context.",
      disabled: true,
      statusKind: "unavailable",
    });
    return;
  }
  if (entry.busy) {
    setConsoleRepairEntryState(entry, {
      label: entry.busyLabel || "Preparing Agent repair…",
      status: entry.busyLabel || "Preparing the exact failed run.",
      disabled: true,
      statusKind: "loading",
    });
    return;
  }
  const refreshReady = state.problemRefreshAppliedSequence >= entry.minimumRefreshRequestSequence
    && normalizedProjectRootValue(state.problemRefreshProjectRoot) === normalizedProjectRootValue(entry.projectRoot);
  if (refreshReady) {
    entry.problem = consoleRepairProblemForEntry(entry);
    if (entry.problem) {
      configureProblemRepairButton(entry.button, entry.problem, {
        activate: () => activateConsoleRepairEntry(entry),
      });
      entry.status.textContent = problemExactRange(entry.problem)
        ? "Exact diagnostic and failed run ready."
        : "Failed run ready; exact source range unavailable.";
      entry.status.className = "console-repair-status ready";
      return;
    }
    const retryAvailable = consoleRepairRetryAvailable(entry);
    setConsoleRepairEntryState(entry, {
      label: retryAvailable ? "Retry repair context" : "Run code again",
      status: retryAvailable
        ? "The failed run was not available in Problems. Retry its context once."
        : "No matching durable Problem was recorded. Run the code again.",
      title: retryAvailable
        ? "Refresh the current project's durable Problems and match this complete run ID again."
        : "A repair turn cannot start without the matching durable failed run.",
      disabled: !retryAvailable,
      statusKind: "unavailable",
      activate: retryAvailable ? () => retryConsoleRepairContext(entry) : null,
    });
    return;
  }
  const refreshFailed = entry.lastFailedRefreshSequence >= entry.minimumRefreshRequestSequence;
  if (refreshFailed) {
    const retryAvailable = consoleRepairRetryAvailable(entry);
    setConsoleRepairEntryState(entry, {
      label: retryAvailable ? "Retry repair context" : "Run code again",
      status: retryAvailable
        ? "Rho could not refresh the durable failed run."
        : "Repair context could not be refreshed. Run the code again.",
      title: "Agent repair remains disabled until the exact failed run is available.",
      disabled: !retryAvailable,
      statusKind: "unavailable",
      activate: retryAvailable ? () => retryConsoleRepairContext(entry) : null,
    });
    return;
  }
  setConsoleRepairEntryState(entry, {
    label: "Preparing Agent repair…",
    status: "Matching the durable failed run…",
    title: "Rho is loading the exact diagnostic range for this failed run.",
    disabled: true,
    statusKind: "loading",
  });
}

function syncConsoleRepairEntries() {
  for (const entry of state.consoleRepairEntries.values()) syncConsoleRepairEntry(entry);
}

function markConsoleRepairRefreshFailed(requestSequence, projectRoot, projectRefreshSequence) {
  for (const entry of state.consoleRepairEntries.values()) {
    if (entry.projectRefreshSequence !== projectRefreshSequence
      || normalizedProjectRootValue(entry.projectRoot) !== normalizedProjectRootValue(projectRoot)
      || requestSequence < entry.minimumRefreshRequestSequence) continue;
    entry.lastFailedRefreshSequence = Math.max(entry.lastFailedRefreshSequence, requestSequence);
  }
  syncConsoleRepairEntries();
}

function addConsoleExecutionError(message, { runId = null } = {}) {
  const durableRunId = String(runId || "").trim();
  if (!durableRunId) {
    addTerminalOutput(message, "error");
    return null;
  }
  const element = document.createElement("div");
  element.className = "terminal-entry error console-error-entry";
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", "R execution error and Agent repair action");
  const copy = document.createElement("span");
  copy.className = "console-error-message";
  copy.textContent = String(message || "R execution failed.");
  const repair = document.createElement("span");
  repair.className = "console-error-repair";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "console-repair-action";
  button.setAttribute("aria-label", "Repair this R error with Agent");
  const status = document.createElement("span");
  status.className = "console-repair-status loading";
  status.setAttribute("role", "status");
  repair.append(button, status);
  element.append(copy, repair);
  $("#consoleOutput").append(element);

  state.consoleRepairSequence += 1;
  const entry = {
    id: state.consoleRepairSequence,
    element,
    button,
    status,
    runId: durableRunId,
    projectRoot: state.project.root,
    projectRefreshSequence: state.projectRefreshSequence,
    minimumRefreshRequestSequence: state.problemRefreshRequestSequence + 1,
    lastFailedRefreshSequence: 0,
    retryCount: 0,
    problem: null,
    busy: false,
    busyLabel: "",
    expired: false,
  };
  state.consoleRepairEntries.set(entry.id, entry);
  while (state.consoleRepairEntries.size > 100) {
    const oldest = state.consoleRepairEntries.values().next().value;
    state.consoleRepairEntries.delete(oldest.id);
    oldest.expired = true;
    syncConsoleRepairEntry(oldest);
  }
  syncConsoleRepairEntry(entry);
  scrollConsoleToPrompt();
  return entry;
}

function addTerminalCommand(code) {
  const value = String(code || "");
  if (!value.trim()) return;
  addTerminalOutput(`> ${value.replace(/\n/g, "\n+ ")}`, "command");
}

function rememberConsoleCommand(code) {
  const value = String(code || "").trim();
  if (!value) return;
  if (state.consoleHistory.at(-1) !== value) state.consoleHistory.push(value);
  if (state.consoleHistory.length > 100) state.consoleHistory.shift();
  state.consoleHistoryIndex = -1;
  state.consoleDraft = "";
}

function browseConsoleHistory(direction) {
  const input = $("#consoleInput");
  if (!state.consoleHistory.length) return;
  if (state.consoleHistoryIndex === -1) {
    if (direction > 0) return;
    state.consoleDraft = input.value;
    state.consoleHistoryIndex = state.consoleHistory.length - 1;
  } else {
    const next = state.consoleHistoryIndex + direction;
    if (next < 0) {
      state.consoleHistoryIndex = 0;
    } else if (next >= state.consoleHistory.length) {
      state.consoleHistoryIndex = -1;
      input.value = state.consoleDraft;
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    } else {
      state.consoleHistoryIndex = next;
    }
  }
  input.value = state.consoleHistory[state.consoleHistoryIndex];
  input.setSelectionRange(input.value.length, input.value.length);
}

function addLog(origin, text, kind = "") {
  if (text === null || text === undefined || text === "") return;
  const entry = document.createElement("div");
  entry.className = `log-entry ${origin.toLowerCase()} ${kind}`.trim();
  const badge = document.createElement("span");
  badge.className = "origin";
  badge.textContent = { SYSTEM: "Rho", AGENT: "Agent", USER: "You" }[origin.toUpperCase()] || "Rho";
  const content = document.createElement("span");
  content.textContent = String(text);
  entry.append(badge, content);
  $("#logsOutput").append(entry);
  $("#logsOutput").scrollTop = $("#logsOutput").scrollHeight;
}

function addTimeline(title, body, status = "completed", code = null) {
  const row = document.createElement("div");
  row.className = `timeline-item ${status}`;
  const marker = createStateMarker(status, `${title}: ${prettyStatus(status)}`);
  marker.classList.add("timeline-marker");
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

const USER_ERROR_PRESENTATIONS = [
  { matches: /too large|over.?limit/i, message: "This file is too large to preview. Open it as source instead." },
  { matches: /stale|revision|changed since|changed after|out of date/i, message: "The underlying information changed. Refresh it and try again." },
  { matches: /not found|missing|no longer available|unavailable/i, message: "The requested information is no longer available. Refresh this view and try again." },
  { matches: /permission|policy|denied|not allowed|outside (?:the )?project/i, message: "This action is not allowed in the current project state. Review the project and try a permitted action." },
  { matches: /timeout|timed out|network|connection|http/i, message: "Rho could not reach the required service. Check the connection and try again." },
  { matches: /cancelled|canceled|interrupted|stopped/i, message: "The action was stopped. Your existing project files were left unchanged." },
];

function userFacingError(error, fallback = "Rho could not complete this action. Try again or review diagnostics if the problem continues.") {
  const raw = typeof error === "string" ? error : error?.message || String(error || "");
  return USER_ERROR_PRESENTATIONS.find((entry) => entry.matches.test(raw))?.message || fallback;
}

function reportUiFailure(context, error, fallback) {
  console.error(`[${context}]`, error);
  return userFacingError(error, fallback);
}

function userFacingStatus(status, labels, fallback = "Needs attention") {
  return Object.prototype.hasOwnProperty.call(labels, status) ? labels[status] : fallback;
}

function presentationState(status) {
  if (["completed", "success", "approved", "ready", "matched"].includes(status)) return "completed";
  if (["running", "busy"].includes(status)) return "running";
  if (["queued", "waiting", "requested", "pending"].includes(status)) return "waiting";
  if (["cancelled", "interrupted", "rejected", "policy_denied"].includes(status)) return "cancelled";
  if (["failed", "error", "crashed", "stale", "unavailable", "invalid"].includes(status)) return "failed";
  if (["warning", "incomplete", "unsynchronized"].includes(status)) return "warning";
  return "neutral";
}

function stateIconId(status) {
  return {
    completed: "check",
    running: "clock-3",
    waiting: "clock-3",
    cancelled: "ban",
    failed: "circle-x",
    warning: "triangle-alert",
    neutral: "info",
  }[presentationState(status)];
}

function createStateMarker(status, label) {
  const tone = presentationState(status);
  const marker = document.createElement("span");
  marker.className = `state-marker state-${tone}`;
  marker.setAttribute("role", "img");
  marker.setAttribute("aria-label", label || prettyStatus(status));
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "ui-icon");
  icon.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#icon-${stateIconId(status)}`);
  icon.append(use);
  marker.append(icon);
  return marker;
}

function createStateChip(label, status = "neutral") {
  const chip = document.createElement("span");
  chip.className = `state-chip state-${presentationState(status)}`;
  chip.textContent = label;
  chip.title = label;
  return chip;
}

function setStateChip(element, label, status) {
  element.className = `state-chip state-${presentationState(status)}`;
  element.textContent = label;
  element.title = label;
}

function renderStatusItems(element, items) {
  element.replaceChildren(...items.filter((item) => item?.label).map((item) => createStateChip(item.label, item.status)));
}

function runStatusTone(status) {
  if (status === "completed") return "success";
  if (status === "running" || status === "queued" || status === "waiting") return "running";
  if (status === "failed" || status === "crashed") return "error";
  if (status === "interrupted" || status === "cancelled") return "warning";
  return "";
}

function runTitle(run) {
  if (run.execution_mode === "selection" && run.source_path) return `Selection · ${displayPath(run.source_path)}`;
  if (run.execution_mode === "line" && run.source_path) return `Line · ${displayPath(run.source_path)}`;
  if (run.execution_mode === "file" && run.source_path) return `File · ${displayPath(run.source_path)}`;
  if (run.request_type === "workspace.snapshot") return "Workspace snapshot";
  if (run.request_type === "workspace.inspect_object") return `Inspect · ${run.code_preview}`;
  if (run.request_type === "workspace.bootstrap") return "Workspace bootstrap";
  return run.code_preview || "R action";
}

function isBackgroundRun(run) {
  return run?.origin === "system" || ["workspace.snapshot", "workspace.bootstrap"].includes(run?.request_type);
}

function humanRunTitle(run) {
  if (run?.request_type === "workspace.snapshot") return "Refreshing workspace context";
  if (run?.request_type === "workspace.bootstrap") return "Preparing Workspace R";
  const preview = String(run?.code_preview || run?.code || "");
  if (/rho_list_lockfile_packages|lockfile.*packages/i.test(preview)) return "Refreshing lockfile status";
  if (/rho_list_installed_packages|installed.*packages/i.test(preview)) return "Refreshing package inventory";
  if (/rho_environment_(?:evidence|operation)|environment.*evidence/i.test(preview)) return "Refreshing project environment";
  if (run?.origin === "system") return "Background workspace task";
  return runTitle(run);
}

function humanExecutionMode(run) {
  const mode = run?.execution_mode || run?.request_type || "";
  return {
    console: "Console",
    selection: "Selected code",
    line: "Current line",
    file: "File",
    render: "Document render",
    chunk: "Document chunk",
    help_example: "Help example",
    "workspace.snapshot": "Workspace refresh",
    "workspace.inspect_object": "Object inspection",
    "workspace.bootstrap": "Workspace startup",
  }[mode] || "R execution";
}

function runEvidence(runId) {
  return {
    plots: state.plots.filter((plot) => plot.run_id === runId),
    artifacts: state.artifacts.filter((artifact) => artifact.run_id === runId),
    problems: state.problems.filter((problem) => problem.run_id === runId),
  };
}

function runEvidenceLabel(runId) {
  const evidence = runEvidence(runId);
  const labels = [];
  if (evidence.plots.length) labels.push(`${evidence.plots.length} plot${evidence.plots.length === 1 ? "" : "s"}`);
  if (evidence.artifacts.length) labels.push(`${evidence.artifacts.length} saved output${evidence.artifacts.length === 1 ? "" : "s"}`);
  if (evidence.problems.length) labels.push(`${evidence.problems.length} problem${evidence.problems.length === 1 ? "" : "s"}`);
  return labels.join(" · ");
}

function activeRunRecord() {
  return state.runs.find((run) => ["queued", "running", "waiting"].includes(run.status)) || null;
}

async function loadRunData({ quiet = false } = {}) {
  state.problemRefreshRequestSequence += 1;
  const refreshRequestSequence = state.problemRefreshRequestSequence;
  const refreshSequence = state.projectRefreshSequence;
  const projectRoot = state.project.root;
  try {
    const [runs, problems, plots, artifacts] = await Promise.all([
      invoke("list_runs", { limit: 50 }),
      invoke("list_problems", { limit: 50 }),
      invoke("list_plot_artifacts", { limit: 50, session_only: state.plotScope === "session" }),
      invoke("list_artifact_records", { limit: 100, session_only: state.plotScope === "session" }),
    ]);
    if (refreshSequence !== state.projectRefreshSequence || projectRoot !== state.project.root) return false;
    if (refreshRequestSequence < state.problemRefreshAppliedSequence) return false;
    loadGitStatus();
    state.runs = runs || [];
    state.problems = problems || [];
    state.problemRefreshAppliedSequence = refreshRequestSequence;
    state.problemRefreshProjectRoot = projectRoot;
    state.plots = plots || [];
    state.artifacts = artifacts || [];
    if (!state.plots.some((plot) => plot.plot_id === state.selectedPlotId)) {
      state.selectedPlotId = state.plots[0]?.plot_id || null;
    }
    if (!state.artifacts.some((artifact) => artifact.artifact_id === state.selectedArtifactId)) {
      state.selectedArtifactId = state.artifacts[0]?.artifact_id || null;
    }
    state.selectedArtifactDetail = null;
    state.activeRunId = activeRunRecord()?.run_id || null;
    renderRuns();
    renderProblems();
    renderPlots();
    if (state.selectedArtifactId) {
      const listedArtifact = state.artifacts.find((item) => item.artifact_id === state.selectedArtifactId);
      try {
        const detail = await invoke("get_artifact_record", { artifactId: state.selectedArtifactId });
        state.selectedArtifactDetail = detail || (listedArtifact ? { artifact: listedArtifact, file_available: null } : null);
      } catch (error) {
        state.selectedArtifactDetail = listedArtifact ? { artifact: listedArtifact, file_available: null } : null;
        if (!quiet) toast(reportUiFailure("load saved output detail", error, "Saved output detail could not be loaded. Refresh and try again."), true);
      }
      renderPlots();
    }
    try {
      await syncAgentRunsToConsole(state.runs);
    } catch (error) {
      if (!quiet) toast(reportUiFailure("sync Agent Console", error, "Agent Console history could not be synchronized. Refresh and try again."), true);
    }
    return true;
  } catch (error) {
    if (refreshSequence === state.projectRefreshSequence && projectRoot === state.project.root) {
      markConsoleRepairRefreshFailed(refreshRequestSequence, projectRoot, refreshSequence);
    }
    if (!quiet) toast(reportUiFailure("load run history", error, "Run history could not be loaded. Refresh and try again."), true);
    return false;
  }
}

async function loadGitStatus() {
  try {
    state.gitStatus = await invoke("git_status");
  } catch {
    state.gitStatus = null;
  }
  renderGitStatus();
}

function renderGitStatus() {
  const s = state.gitStatus;
  if (!s || !s.is_repo) {
    $("#gitBranch").textContent = "";
    $("#gitDirty").classList.add("hidden");
    $("#gitChangeCount").textContent = "0";
    return;
  }
  $("#gitBranch").textContent = s.branch || "HEAD";
  const changeCount = Number(s.modified || 0) + Number(s.untracked || 0) + Number(s.staged || 0);
  $("#gitChangeCount").textContent = String(changeCount);
  if (s.dirty) {
    $("#gitDirty").classList.remove("hidden");
    $("#gitDirty").textContent = `${changeCount}*`;
  } else {
    $("#gitDirty").classList.add("hidden");
  }
  // Check for merge conflicts
  if (s.is_repo) loadGitConflicts();
}

function resetGitReview(projectRoot = state.project.root || "") {
  state.gitReview = {
    loading: false,
    error: null,
    working: [],
    staged: [],
    stagedRevision: "",
    selectedPath: null,
    selectedStaged: false,
    diff: null,
    projectRoot,
  };
}

function gitReviewSelectionExists(path, staged) {
  const files = staged ? state.gitReview.staged : state.gitReview.working;
  return files.some((file) => file.path === path);
}

function renderGitFileList(target, files, staged) {
  target.replaceChildren();
  if (!files.length) {
    const empty = document.createElement("div");
    empty.className = "git-file-empty";
    empty.textContent = staged ? "Nothing staged" : "No working changes";
    target.append(empty);
    return;
  }
  for (const file of files) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "git-file-button";
    button.classList.toggle("active", state.gitReview.selectedPath === file.path && state.gitReview.selectedStaged === staged);
    button.title = `${staged ? "Staged" : "Working"}: ${file.path}`;
    const status = document.createElement("span");
    status.className = "git-file-status";
    status.textContent = file.status || "M";
    const path = document.createElement("span");
    path.className = "git-file-path";
    path.textContent = file.path;
    button.append(status, path);
    button.addEventListener("click", () => selectGitReviewFile(file.path, staged));
    target.append(button);
  }
}

function gitDiffLineClass(line) {
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "remove";
  if (line.startsWith("@@") || line.startsWith("diff --git") || line.startsWith("---") || line.startsWith("+++")) return "meta";
  return "";
}

function renderGitDiff() {
  const diff = state.gitReview.diff;
  const review = $("#gitDiffReview");
  if (!diff) {
    review.classList.add("hidden");
    return;
  }
  review.classList.remove("hidden");
  $("#gitDiffScope").textContent = diff.staged ? "Staged" : "Working";
  $("#gitDiffPath").textContent = diff.path;
  const notice = $("#gitDiffNotice");
  notice.classList.toggle("hidden", !diff.truncated);
  notice.textContent = diff.truncated
    ? `Diff is bounded to 128 hunks / 4,000 lines. Refresh after each selected action.`
    : "";

  const actions = $("#gitFileActions");
  actions.replaceChildren();
  const file = (diff.staged ? state.gitReview.staged : state.gitReview.working).find((entry) => entry.path === diff.path);
  const primary = document.createElement("button");
  primary.type = "button";
  primary.className = "primary";
  primary.textContent = diff.staged ? "Unstage file" : "Stage file";
  primary.addEventListener("click", () => runGitMutation(
    diff.staged ? "git_unstage_file" : "git_stage",
    { filePath: diff.path, expectedRevision: diff.revision },
    `${diff.staged ? "Unstaged" : "Staged"} ${diff.path}`,
  ));
  actions.append(primary);
  if (!diff.staged && file?.status !== "?") {
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "danger";
    restore.textContent = "Restore";
    restore.addEventListener("click", () => confirmGitRestore(diff));
    actions.append(restore);
  }

  const list = $("#gitHunkList");
  list.replaceChildren();
  if (!diff.hunks?.length) {
    const empty = document.createElement("div");
    empty.className = "git-hunk-empty";
    empty.textContent = file?.status === "?"
      ? "Untracked file. Review it in the editor, then use Stage file."
      : "No text hunks are available. Use the guarded file-level action.";
    list.append(empty);
    return;
  }
  for (const hunk of diff.hunks) {
    const card = document.createElement("article");
    card.className = "git-hunk";
    const header = document.createElement("header");
    header.className = "git-hunk-header";
    const label = document.createElement("span");
    label.textContent = hunk.header;
    const action = document.createElement("button");
    action.type = "button";
    action.className = "git-hunk-action";
    action.textContent = diff.staged ? "Unstage hunk" : "Stage hunk";
    action.addEventListener("click", () => runGitMutation(
      diff.staged ? "git_hunk_unstage" : "git_hunk_stage",
      { filePath: diff.path, hunkIndex: hunk.index, expectedRevision: diff.revision },
      `${diff.staged ? "Unstaged" : "Staged"} selected hunk in ${diff.path}`,
    ));
    header.append(label, action);
    const code = document.createElement("pre");
    code.className = "git-hunk-code";
    for (const line of String(hunk.content || "").split("\n")) {
      if (!line) continue;
      const row = document.createElement("span");
      row.className = `git-diff-line ${gitDiffLineClass(line)}`.trim();
      row.textContent = line;
      code.append(row);
    }
    card.append(header, code);
    list.append(card);
  }
}

function renderGitReview() {
  const status = state.gitStatus;
  const reviewState = $("#gitReviewState");
  const body = $("#gitReviewBody");
  $("#gitReviewBranch").textContent = status?.is_repo ? (status.branch || "HEAD") : "not a repository";
  reviewState.className = "git-review-state";
  if (!status?.is_repo) {
    reviewState.textContent = "This project is not a Git repository.";
    body.classList.add("hidden");
    return;
  }
  if (state.gitReview.error) {
    reviewState.classList.add("error");
    reviewState.textContent = userFacingError(state.gitReview.error, "Git review is unavailable. Refresh it and try again.");
  } else if (state.gitReview.loading) {
    reviewState.textContent = "Refreshing repository state...";
  } else if (!state.gitReview.working.length && !state.gitReview.staged.length) {
    reviewState.classList.add("clean");
    reviewState.textContent = "Working tree clean.";
  } else {
    reviewState.classList.add("hidden");
  }
  body.classList.remove("hidden");
  $("#gitWorkingCount").textContent = String(state.gitReview.working.length);
  $("#gitStagedCount").textContent = String(state.gitReview.staged.length);
  $("#gitUntrackedCount").textContent = String(state.gitReview.working.filter((file) => file.status === "?").length);
  renderGitFileList($("#gitWorkingFiles"), state.gitReview.working, false);
  renderGitFileList($("#gitStagedFiles"), state.gitReview.staged, true);
  renderGitDiff();
  $("#gitCommitMessage").disabled = state.gitReview.loading || !state.gitReview.staged.length;
  $("#gitCommitButton").disabled = state.gitReview.loading || !state.gitReview.staged.length;
}

async function selectGitReviewFile(path, staged) {
  const projectRoot = state.project.root;
  state.gitReview.selectedPath = path;
  state.gitReview.selectedStaged = staged;
  state.gitReview.diff = null;
  renderGitReview();
  try {
    const diff = await invoke("git_diff_unified", { filePath: path, staged });
    if (projectRoot !== state.project.root || !gitReviewSelectionExists(path, staged)) return;
    state.gitReview.diff = diff;
    state.gitReview.error = null;
  } catch (error) {
    if (projectRoot !== state.project.root) return;
    state.gitReview.error = reportUiFailure("load Git file review", error, "This file could not be reviewed. Refresh Git review and try again.");
  }
  renderGitReview();
}

async function loadGitReview({ preserveSelection = true } = {}) {
  const projectRoot = state.project.root;
  if (!state.gitStatus?.is_repo || state.projectStatus !== "ready") {
    resetGitReview(projectRoot);
    renderGitReview();
    return;
  }
  const previousPath = preserveSelection ? state.gitReview.selectedPath : null;
  const previousStaged = preserveSelection ? state.gitReview.selectedStaged : false;
  state.gitReview.loading = true;
  state.gitReview.error = null;
  state.gitReview.projectRoot = projectRoot;
  renderGitReview();
  try {
    const [working, staged, stagedRevision] = await Promise.all([
      invoke("git_diff", { staged: false }),
      invoke("git_diff", { staged: true }),
      invoke("git_staged_revision"),
    ]);
    if (projectRoot !== state.project.root) return;
    state.gitReview.working = working || [];
    state.gitReview.staged = staged || [];
    state.gitReview.stagedRevision = stagedRevision || "";
    state.gitReview.loading = false;
    const keepSelection = previousPath && gitReviewSelectionExists(previousPath, previousStaged);
    const next = keepSelection
      ? { path: previousPath, staged: previousStaged }
      : state.gitReview.working[0]
        ? { path: state.gitReview.working[0].path, staged: false }
        : state.gitReview.staged[0]
          ? { path: state.gitReview.staged[0].path, staged: true }
          : null;
    state.gitReview.selectedPath = next?.path || null;
    state.gitReview.selectedStaged = Boolean(next?.staged);
    state.gitReview.diff = null;
    renderGitReview();
    if (next) await selectGitReviewFile(next.path, next.staged);
  } catch (error) {
    if (projectRoot !== state.project.root) return;
    state.gitReview.loading = false;
    state.gitReview.error = reportUiFailure("load Git review", error, "Git review is unavailable. Refresh it and try again.");
    renderGitReview();
  }
}

async function runGitMutation(command, args, successMessage) {
  if (state.gitReview.loading) return;
  state.gitReview.loading = true;
  renderGitReview();
  try {
    await invoke(command, args);
    toast(successMessage);
  } catch (error) {
    toast(reportUiFailure("change Git state", error, "The Git action could not be completed. Refresh Git review and try again."), true);
  } finally {
    await loadGitStatus();
    await loadGitReview();
  }
}

async function confirmGitRestore(diff) {
  const confirmed = await confirmAction({
    title: "Restore working changes?",
    message: `Discard the uncommitted working changes in ${diff.path}? Staged changes are preserved. This cannot be undone in Rho.`,
    confirmLabel: "Restore file",
    cancelLabel: "Keep changes",
    destructive: true,
  });
  if (!confirmed) return;
  await runGitMutation(
    "git_restore_file",
    { filePath: diff.path, expectedRevision: diff.revision },
    `Restored ${diff.path}`,
  );
}

async function loadGitConflicts() {
  try {
    const result = await invoke("git_list_conflicts");
    if (result.has_conflicts) {
      state.gitConflicts = result;
      renderConflictBanner();
    } else if (state.gitConflicts) {
      state.gitConflicts = null;
      $("#gitConflictBanner").classList.add("hidden");
    }
  } catch {
    // git_list_conflicts may fail if not in merge state - that's fine
  }
}

function renderConflictBanner() {
  const c = state.gitConflicts;
  if (!c || !c.files?.length) {
    $("#gitConflictBanner").classList.add("hidden");
    return;
  }
  const banner = $("#gitConflictBanner");
  banner.classList.remove("hidden");
  const list = $("#gitConflictList");
  list.replaceChildren();
  for (const file of c.files) {
    const item = document.createElement("div");
    item.className = "conflict-file";
    const name = document.createElement("span");
    name.className = "conflict-file-name";
    name.textContent = file;
    const actions = document.createElement("span");
    actions.className = "conflict-actions";
    ["ours", "theirs", "mark"].forEach((res) => {
      const btn = document.createElement("button");
      btn.textContent = res === "mark" ? "Mark Resolved" : `Accept ${res === "ours" ? "Ours" : "Theirs"}`;
      btn.addEventListener("click", async () => {
        try {
          await invoke("git_resolve_conflict", { filePath: file, resolution: res });
          toast(`Resolved ${file} (${res})`);
          loadGitConflicts();
        } catch (err) { toast(reportUiFailure("resolve Git conflict", err, "The conflict resolution could not be applied. Refresh Git review and try again."), true); }
      });
      actions.append(btn);
    });
    item.append(name, actions);
    list.append(item);
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

function prettyAgentStatus(status, terminalReason = null) {
  if (status === "interrupted" && terminalReason === "user_cancelled") return "Cancelled";
  return userFacingStatus(status, {
    queued: "Queued",
    empty: "Empty",
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
  }, "Needs attention");
}

const TASK_RAIL_MODE_PRESENTATION = Object.freeze({
  ask: Object.freeze({ label: "Ask", icon: "message-circle" }),
  plan: Object.freeze({ label: "Plan", icon: "list-checks" }),
  act: Object.freeze({ label: "Act", icon: "pencil-line" }),
});

const TASK_RAIL_FALLBACK_MODE_PRESENTATION = Object.freeze({
  key: "unknown",
  label: "Agent",
  icon: "bot",
});

function taskRailModePresentation(mode) {
  const key = String(mode || "").toLowerCase();
  const presentation = TASK_RAIL_MODE_PRESENTATION[key];
  return presentation ? { key, ...presentation } : TASK_RAIL_FALLBACK_MODE_PRESENTATION;
}

function createTaskRailModeIcon(mode) {
  const presentation = taskRailModePresentation(mode);
  const wrapper = document.createElement("span");
  wrapper.className = `task-mode-icon task-mode-${presentation.key}`;
  wrapper.dataset.mode = presentation.key;
  wrapper.setAttribute("role", "img");
  wrapper.setAttribute("aria-label", `${presentation.label} mode`);
  wrapper.title = `${presentation.label} mode`;

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.classList.add("ui-icon");
  icon.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#icon-${presentation.icon}`);
  icon.append(use);
  wrapper.append(icon);
  return wrapper;
}

function createTaskRailStatusDot(status, terminalReason = null) {
  const key = String(status || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const label = prettyAgentStatus(status, terminalReason);
  const dot = document.createElement("span");
  dot.className = `status-dot ${key}`;
  dot.dataset.status = String(status || "unknown");
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", `${label} status`);
  dot.title = `${label} status`;
  return dot;
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
  if (event.event_type === "agent.user_prompt" || event.event_type === "chat.message_completed") return event.body;
  if (event.event_type === "agent.run_started") return "Rho is working on this task.";
  if (event.event_type === "approval.requested") return "Review the requested action before work continues.";
  if (event.event_type === "tool.call_completed" && event.tool === "propose_file_edit") {
    return "Review the proposed file edit below. No file has been changed yet.";
  }
  if (event.event_type === "tool.call_completed" && event.tool === "run_r") {
    return friendlyRunRResult(event.body);
  }
  if (event.event_type === "tool.call_failed") {
    return userFacingError(event.body, "This step could not be completed. Review the task and try again.");
  }
  return "";
}

function agentTimelineEventTitle(event) {
  const key = `${event.event_type}:${event.tool || ""}`;
  return {
    "agent.user_prompt:": "You",
    "agent.run_started:": "Rho started",
    "chat.message_completed:": "Rho",
    "approval.requested:run_r": "Review R code",
    "tool.call_started:run_r": "Running R",
    "tool.call_completed:run_r": "R completed",
    "tool.call_failed:run_r": "R failed",
    "tool.call_started:get_workspace_snapshot": "Inspecting workspace",
    "tool.call_completed:get_workspace_snapshot": "Workspace inspected",
    "tool.call_started:inspect_r_object": "Inspecting R object",
    "tool.call_completed:inspect_r_object": "R object inspected",
    "tool.call_started:propose_file_edit": "Preparing file edit",
    "tool.call_completed:propose_file_edit": "File edit ready",
  }[key] || "Activity update";
}

function parseNestedJsonObject(value) {
  let parsed = value;
  for (let depth = 0; depth < 2; depth += 1) {
    if (typeof parsed !== "string") break;
    try {
      parsed = JSON.parse(parsed);
    } catch (_) {
      return null;
    }
  }
  return parsed && typeof parsed === "object" ? parsed : null;
}

function friendlyRunRResult(body) {
  const parsed = parseNestedJsonObject(body);
  if (!parsed) return body;
  const execution = parsed.execution && typeof parsed.execution === "object" ? parsed.execution : parsed;
  if (execution.ok === false || execution.error) {
    const error = execution.error;
    const message = typeof error === "string" ? error : error?.message || error?.error;
    return `Error\n${message || "R execution failed."}`;
  }
  const sections = [];
  const addSection = (label, value) => {
    const values = Array.isArray(value) ? value : [value];
    const text = values.filter((item) => item !== null && item !== undefined && item !== "").join("\n");
    if (text) sections.push(`${label}\n${text}`);
  };
  addSection("Output", execution.stdout);
  addSection("Result", execution.value ?? execution.value_text);
  addSection("Messages", execution.messages);
  addSection("Warnings", execution.warnings);
  return sections.join("\n\n") || "R completed successfully with no printed output.";
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

function normalizedAgentLocalHelpContext() {
  const location = state.localHelp.record;
  const documentation = state.installedHelp.record;
  if (state.projectStatus !== "ready" || !state.project.root
    || state.localHelp.status !== "found" || state.installedHelp.status !== "found"
    || !location?.found || location.ambiguous || location.truncated
    || !location.package || !location.help_topic || !location.help_record
    || !documentation?.found || documentation.package !== location.package
    || documentation.name !== location.name) return null;
  const bounded = (value, limit) => {
    if (value === null || value === undefined) return null;
    const text = String(value);
    return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
  };
  return {
    kind: "rho.local_help_context.v1",
    project_root: state.project.root,
    name: bounded(location.name, 128),
    package: bounded(location.package, 128),
    help_topic: bounded(location.help_topic, 128),
    help_record: bounded(location.help_record, 1000),
    package_version: bounded(documentation.package_version, 100),
    title: bounded(documentation.title, 500),
    usage: bounded(documentation.usage, 2000),
    description: bounded(documentation.description, 2000),
    incomplete: Boolean(documentation.incomplete),
    truncated: Boolean(documentation.truncated),
    notices: Array.isArray(documentation.notices) ? documentation.notices.slice(0, 20).map((item) => bounded(item, 100)) : [],
  };
}

function renderAgentHelpContextBadge() {
  const badge = $("#agentHelpContextBadge");
  const context = state.agentLocalHelpContext;
  badge.classList.toggle("hidden", !context);
  if (context) $("#agentHelpContextLabel").textContent = `Help: ${context.package}::${context.help_topic}`;
}

function resetAgentLocalHelpContext() {
  state.agentLocalHelpContext = null;
  renderAgentHelpContextBadge();
}

function attachLocalHelpToAgent() {
  const context = normalizedAgentLocalHelpContext();
  if (!context) {
    toast("Only a complete, unambiguous Local Help record can be attached.", true);
    return;
  }
  state.agentLocalHelpContext = context;
  applyWorkbenchLayout("agent");
  renderAgentHelpContextBadge();
  $("#agentInput").focus();
  toast(`Attached ${context.package}::${context.help_topic} Local Help to the next Agent question.`);
}

function renderLocalHelpAgentAction(container) {
  const context = normalizedAgentLocalHelpContext();
  if (!context) return;
  const action = document.createElement("button");
  action.type = "button";
  action.className = "local-help-agent-action";
  action.textContent = "Ask Rho with this Help";
  action.addEventListener("click", attachLocalHelpToAgent);
  container.append(action);
}

function renderProjectSkills() {
  const panel = $("#projectSkillsPanel");
  const trust = $("#projectSkillsTrust");
  const summary = $("#projectSkillsSummary");
  const list = $("#projectSkillsList");
  if (!panel || !trust || !summary || !list) return;
  if (state.projectStatus !== "ready" || !state.project.root) {
    panel.classList.add("hidden");
    summary.textContent = "";
    list.replaceChildren();
    return;
  }
  const discovery = state.projectSkills || emptyProjectSkillsView(state.project.root);
  const skills = Array.isArray(discovery.skills) ? discovery.skills : [];
  const trustLabel = discovery.trust_status === "untrusted_project_content"
    ? "Project guidance"
    : "Guidance unavailable";
  trust.textContent = trustLabel;
  summary.textContent = discovery.discovery_error
    ? `Project guidance could not be loaded for ${activeProjectName()}. The Agent will continue without it.`
    : skills.length
      ? `${skills.length} project guidance item${skills.length === 1 ? " is" : "s are"} available. Review this project-provided guidance before relying on it.`
      : "This project does not provide Agent guidance.";
  list.replaceChildren();
  if (discovery.discovery_error) {
    const row = document.createElement("div");
    row.className = "project-skill-row";
    const meta = document.createElement("div");
    meta.className = "project-skill-meta";
    meta.textContent = userFacingError(discovery.discovery_error, "Check the project guidance files, then refresh this view.");
    row.append(meta);
    list.append(row);
  } else if (!skills.length) {
    const empty = document.createElement("div");
    empty.className = "empty-tree";
    empty.textContent = "Project guidance will appear here when the project provides it.";
    list.append(empty);
  } else {
    for (const skill of skills) {
      const row = document.createElement("div");
      row.className = "project-skill-row";
      const title = document.createElement("div");
      title.className = "project-skill-title";
      const heading = document.createElement("strong");
      heading.textContent = skill.title || "Untitled guidance";
      title.append(heading);
      const meta = document.createElement("div");
      meta.className = "project-skill-meta";
      meta.textContent = skill.description || "No description provided.";
      const stateLabel = document.createElement("div");
      stateLabel.className = "project-skill-paths";
      stateLabel.textContent = "Provided by this project";
      row.append(title, meta, stateLabel);
      list.append(row);
    }
  }
  panel.classList.remove("hidden");
}

async function loadProjectSkills(options = {}) {
  const { quiet = true } = options;
  const refreshSequence = state.projectRefreshSequence;
  const projectRoot = state.project.root;
  if (state.projectStatus !== "ready" || !state.project.root) {
    state.projectSkills = emptyProjectSkillsView(state.project.root || "");
    renderProjectSkills();
    return;
  }
  try {
    const skills = await invoke("list_project_skills");
    if (refreshSequence !== state.projectRefreshSequence || projectRoot !== state.project.root) return;
    state.projectSkills = skills;
  } catch (error) {
    if (refreshSequence !== state.projectRefreshSequence || projectRoot !== state.project.root) return;
    state.projectSkills = {
      ...emptyProjectSkillsView(state.project.root),
      discovery_error: String(error),
    };
    if (!quiet) {
      toast(reportUiFailure("load project guidance", error, "Project guidance could not be loaded. The Agent will continue without it."), true);
    }
  }
  renderProjectSkills();
}

function setAgentContext(source, path = null) {
  state.agentContextSource = source;
  state.agentContextPath = path;
  renderAgentContextBadge();
}

function resetAgentContext() {
  setAgentContext("editor", null);
  state.agentDiagnostic = null;
  state.agentProblemRunContext = null;
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
  return agentToolLabel(approval.tool);
}

function agentToolLabel(tool) {
  return {
    run_r: "Run R code",
    inspect_r_object: "Inspect R object",
    get_workspace_snapshot: "Inspect workspace",
    propose_file_edit: "Propose file edit",
  }[tool] || "Agent action";
}

function parseApprovalArguments(argumentsJson) {
  try {
    return JSON.parse(argumentsJson || "{}");
  } catch {
    return {};
  }
}

function capturePanelViewport(panel, keySelector = null) {
  if (!panel) return null;
  const focused = document.activeElement;
  return {
    top: panel.scrollTop,
    left: panel.scrollLeft,
    focusKey: keySelector && panel.contains(focused) ? focused.getAttribute(keySelector) : null,
  };
}

function restorePanelViewport(panel, viewport, keySelector = null) {
  if (!panel || !viewport) return;
  panel.scrollTop = viewport.top;
  panel.scrollLeft = viewport.left;
  if (keySelector && viewport.focusKey) {
    panel.querySelector(`[${keySelector}="${CSS.escape(viewport.focusKey)}"]`)?.focus({ preventScroll: true });
  }
}

async function loadAgentData({ quiet = false } = {}) {
  state.agentRefreshRequestSequence += 1;
  const requestSequence = state.agentRefreshRequestSequence;
  const refreshSequence = state.projectRefreshSequence;
  const projectRoot = state.project.root;
  const requestIsCurrent = () => requestSequence === state.agentRefreshRequestSequence
    && refreshSequence === state.projectRefreshSequence
    && projectRoot === state.project.root;
  try {
    const [conversationResponse, approvalResponse] = await Promise.all([
      invoke("list_agent_conversations", { limit: 50 }),
      invoke("list_approval_requests", { limit: 20 }),
    ]);
    if (!requestIsCurrent()) return false;
    const conversations = conversationResponse || [];
    const pendingApprovals = (approvalResponse || []).filter((item) => item.status === "waiting");
    const selectedConversationStillExists = state.selectedConversationId
      && conversations.some((conversation) => conversation.conversation_id === state.selectedConversationId);
    const preferredConversationId = selectedConversationStillExists
      ? state.selectedConversationId
      : conversations.find((conversation) => conversation.pending_request_id)?.conversation_id
        || conversations.find((conversation) => ["running", "waiting"].includes(conversation.status))?.conversation_id
        || conversations[0]?.conversation_id
        || null;
    const turns = preferredConversationId
      ? await invoke("list_agent_turns", { conversationId: preferredConversationId, limit: 50 }) || []
      : [];
    if (!requestIsCurrent()) return false;
    const selectedTurnStillExists = state.selectedTurnId
      && turns.some((turn) => turn.turn_id === state.selectedTurnId);
    let preferredTurnId = selectedTurnStillExists
      ? state.selectedTurnId
      || pendingApprovals.find((approval) => turns.some((turn) => turn.turn_id === approval.turn_id))?.turn_id
      || turns.find((turn) => ["running", "waiting"].includes(turn.status))?.turn_id
      || turns[0]?.turn_id
      : pendingApprovals.find((approval) => turns.some((turn) => turn.turn_id === approval.turn_id))?.turn_id
        || turns.find((turn) => ["running", "waiting"].includes(turn.status))?.turn_id
        || turns[0]?.turn_id
        || null;
    let selectedTurnDetail = null;
    if (preferredTurnId) {
      try {
        selectedTurnDetail = await invoke("get_agent_turn_detail", { turnId: preferredTurnId });
      } catch (error) {
        if (!isStaleInformationError(error)) throw error;
        preferredTurnId = null;
      }
    }
    if (!requestIsCurrent()) return false;
    state.agentConversations = conversations;
    state.pendingApprovals = pendingApprovals;
    state.selectedConversationId = preferredConversationId;
    state.agentTurns = turns;
    state.selectedTurnId = preferredTurnId;
    state.selectedTurnDetail = selectedTurnDetail;
    renderAgentTimeline();
    renderApprovalPanel();
    renderFileEditPanel();
    maybeAutoApplyFileEditProposal();
    renderTaskRail();
    updateAgentHeader();
    syncAgentPolling();
    return true;
  } catch (error) {
    if (requestIsCurrent() && !quiet) {
      toast(reportUiFailure("load Agent history", error, "Conversation history could not be loaded. Refresh and try again."), true);
    }
    return false;
  }
}

function isStaleInformationError(error) {
  const raw = typeof error === "string" ? error : error?.message || String(error || "");
  return /not found|missing|no longer available|stale|changed/i.test(raw);
}

function emptyAgentLlmSettings(message) {
  return {
    schema_version: 2,
    revision: 0,
    selected_model_id: null,
    providers: [],
    models: [],
    selected_model: null,
    capability_routes: [],
    user_environ: { path: "", source: "system" },
    validation_error: message,
  };
}

function selectedAgentModel() {
  return state.agentLlm.settings?.selected_model || null;
}

function agentCapabilityRouteView(capability) {
  return (state.agentLlm.settings?.capability_routes || []).find((route) => route.capability === capability) || null;
}

function ensureAgentLlmSelectionState() {
  const settings = state.agentLlm.settings;
  if (!settings) return;
  if (!settings.providers.some((provider) => provider.id === state.agentLlm.selectedProviderId)) {
    const selectedModel = settings.models.find((model) => model.id === settings.selected_model_id) || null;
    state.agentLlm.selectedProviderId = selectedModel?.provider_id || settings.providers[0]?.id || null;
  }
  state.agentLlm.editingProviderId = state.agentLlm.selectedProviderId;
  const providerModels = settings.models.filter((model) => model.provider_id === state.agentLlm.selectedProviderId);
  if (!providerModels.some((model) => model.id === state.agentLlm.selectedModelEditorId)) {
    state.agentLlm.selectedModelEditorId = providerModels.find((model) => model.id === settings.selected_model_id)?.id
      || providerModels[0]?.id
      || null;
  }
  if (!state.agentLlm.modelDialogOpen) state.agentLlm.editingModelId = state.agentLlm.selectedModelEditorId;
}

function prettyToolCalling(value) {
  if (value === "yes") return "Act enabled";
  if (value === "no") return "Chat only";
  return "Act unavailable";
}

function agentSendDisabledReason() {
  if (state.agentRuntime && !state.agentRuntime.available) {
    return userFacingError(state.agentRuntime.error, "The assistant connection is unavailable. Retry the connection from this panel.");
  }
  if (state.agentLlm.settings?.validation_error) return "The assistant configuration needs attention. Open model settings to review it.";
  if (!selectedAgentModel()) return "No enabled Agent model is configured.";
  return null;
}

function activeAgentConversations() {
  return state.agentConversations.filter((conversation) =>
    ["running", "waiting"].includes(conversation.status)
  );
}

function selectedAgentConversation() {
  return state.agentConversations.find(
    (conversation) => conversation.conversation_id === state.selectedConversationId,
  ) || null;
}

function agentTurnAdmissionState(mode = state.agentMode, taskKind = "agent_turn") {
  const active = activeAgentConversations();
  const selected = selectedAgentConversation();
  const selectedBusy = taskKind === "agent_turn"
    && Boolean(selected && ["running", "waiting"].includes(selected.status));
  let reason = null;
  if (state.agentSubmissionPending) {
    reason = "The current Agent request is still starting.";
  } else if (selectedBusy) {
    reason = "This Conversation already has an active Agent turn.";
  } else if (mode === "act" && active.length > 0) {
    reason = "Act mode waits for every other Agent turn to finish.";
  } else if (active.some((conversation) => conversation.latest_mode === "act")) {
    reason = "Wait for the active Act turn to finish.";
  } else if (active.length >= 2) {
    reason = "Two Agent turns are already running. Cancel or finish one before starting another.";
  }
  return {
    active,
    selected,
    selectedBusy,
    capacityReached: active.length >= 2,
    reason,
  };
}

function syncAgentComposerState() {
  const reason = agentSendDisabledReason();
  const actRoute = agentCapabilityRouteView("agent.act");
  const actBlocked = actRoute?.compatibility !== "compatible"
    || ["not_detected", "unavailable"].includes(actRoute?.credential_status);
  if (state.agentMode === "act" && actBlocked) {
    state.agentMode = "ask";
  }
  const admission = agentTurnAdmissionState();
  syncAgentModeControl();
  const composerBlocked = Boolean(reason || admission.reason);
  $("#agentSendButton").disabled = composerBlocked;
  $("#agentInput").disabled = composerBlocked;
  $$("[data-agent-mode]").forEach((button) => {
    const disabled = button.dataset.agentMode === "act" && actBlocked;
    button.disabled = disabled;
    button.classList.toggle("active", button.dataset.agentMode === state.agentMode);
  });
  $("#actAutoApprove").disabled = state.agentMode !== "act" || actBlocked;
  $("#agentModelSelector").disabled = false;
  syncConsoleRepairEntries();
  const note = $("#agentCapabilityNote");
  if (reason) {
    note.textContent = reason;
    note.className = "agent-capability-note warn";
    note.classList.remove("hidden");
    return;
  }
  if (admission.reason) {
    note.textContent = admission.reason;
    note.className = "agent-capability-note warn";
    note.classList.remove("hidden");
    return;
  }
  if (actRoute && actBlocked) {
    note.textContent = actRoute.compatibility === "needs_review"
      ? "Review the effective Act model's type and function-call capability before using Act."
      : "Act needs a compatible function-calling route and a ready Provider connection.";
    note.className = "agent-capability-note warn";
    note.classList.remove("hidden");
    return;
  }
  note.classList.add("hidden");
}

function syncAgentModeControl() {
  const label = prettyAgentMode(state.agentMode);
  $("#agentModeLabel").textContent = label;
  $("#agentModeSummary").setAttribute("aria-label", `Agent mode: ${label}`);
  $(".act-authorization").classList.toggle("hidden", state.agentMode !== "act");
}

function updateAgentModelLabel() {
  const selected = selectedAgentModel();
  $("#agentRuntimeLabel").textContent = selected?.display_name || "Select model";
  $("#agentModelSelector").title = selected
    ? `${selected.display_name} · ${selected.provider_display_name}`
    : "Select Agent model";
}

function agentModelDisplayName(selector) {
  const raw = String(selector || "");
  const modelId = raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1) : raw;
  const match = (state.agentLlm.settings?.models || []).find((model) => model.id === raw || model.model_id === modelId);
  if (match?.display_name) return match.display_name;
  if (raw && !raw.includes(":") && /\s/.test(raw)) return raw;
  return "Configured model";
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

async function retryAgentLlmSettings() {
  if (state.agentLlm.settingsLoading) return;
  state.agentLlm.settingsLoading = true;
  setAgentLlmOperationState("working", "Reloading model settings…");
  renderAgentLlmDialog();
  try {
    const settings = await invoke("agent_llm_settings");
    state.agentLlm.settings = settings || emptyAgentLlmSettings("Agent LLM settings are unavailable.");
    state.agentLlm.selectedModelId = state.agentLlm.settings.selected_model_id || null;
    state.agentLlm.lastTestResult = null;
    ensureAgentLlmSelectionState();
    updateAgentModelLabel();
    renderAgentModelSelector();
    setAgentLlmOperationState("success", "Model settings reloaded.");
  } catch (error) {
    state.agentLlm.settings = emptyAgentLlmSettings(String(error));
    state.agentLlm.selectedModelId = null;
    setAgentLlmOperationState("error", reportUiFailure(
      "reload Agent model settings",
      error,
      "Model settings could not be reloaded. Your saved connections were not changed; retry or copy diagnostics.",
    ));
  } finally {
    state.agentLlm.settingsLoading = false;
    ensureAgentLlmSelectionState();
    updateAgentModelLabel();
    renderAgentModelSelector();
    renderAgentLlmDialog();
    syncAgentComposerState();
  }
}

function setAgentInputBusy(busy) {
  state.agentSubmissionPending = busy;
  state.agentBusy = busy || agentTurnAdmissionState().selectedBusy;
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
      addLog("AGENT", `R code\n${detail.code || run.code_preview || ""}`);
      if (detail.stdout) addLog("AGENT", detail.stdout);
      asMessageList(detail.messages).forEach((message) => addLog("AGENT", message));
      asMessageList(detail.warnings).forEach((warning) => addLog("AGENT", warning, "warning"));
      if (detail.value_text) addLog("AGENT", detail.value_text);
      if (detail.error_message) addLog("AGENT", detail.error_message, "error");
    } catch (error) {
      addLog("SYSTEM", reportUiFailure("display Agent R result", error, "An Agent R result could not be displayed. Refresh Runs to review it."), "error");
    }
  }
}

function updateAgentHeader() {
  const selectedConversation = selectedAgentConversation();
  const activeConversations = activeAgentConversations();
  const runningCount = activeConversations.filter((conversation) => conversation.status === "running").length;
  const waitingCount = activeConversations.filter((conversation) => conversation.status === "waiting").length;
  const runtime = state.agentRuntime;
  updateAgentModelLabel();
  renderAgentModelSelector();
  if (runtime && !runtime.available) {
    $("#agentRuntimeRetryButton").classList.remove("hidden");
    state.agentBusy = true;
    syncAgentComposerState();
    $("#agentCancelButton").classList.add("hidden");
    $("#agentState").textContent = "Unavailable";
    $("#agentStateDot").className = "agent-state-dot error";
    return;
  }
  $("#agentRuntimeRetryButton").classList.add("hidden");
  state.activeAgentTurnId = selectedConversation && ["running", "waiting"].includes(selectedConversation.status)
    ? selectedConversation.latest_turn_id
    : null;
  state.agentBusy = state.agentSubmissionPending || Boolean(state.activeAgentTurnId);
  syncAgentComposerState();
  $("#agentCancelButton").classList.toggle("hidden", !state.activeAgentTurnId);
  if (activeConversations.length) {
    const aggregate = [];
    if (runningCount) aggregate.push(`${runningCount} running`);
    if (waitingCount) aggregate.push(`${waitingCount} waiting approval${waitingCount === 1 ? "" : "s"}`);
    $("#agentState").textContent = aggregate.join(" · ");
    $("#agentStateDot").className = "agent-state-dot busy";
    return;
  }
  if (selectedConversation?.status === "failed") {
    $("#agentState").textContent = "Failed";
    $("#agentStateDot").className = "agent-state-dot error";
    return;
  }
  if (selectedConversation?.status === "completed") {
    $("#agentState").textContent = "Completed";
    $("#agentStateDot").className = "agent-state-dot";
    return;
  }
  if (selectedConversation?.status === "interrupted") {
    $("#agentState").textContent = prettyAgentStatus(
      selectedConversation.status,
      selectedConversation.terminal_reason,
    );
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

function positionAgentModelMenu() {
  const selector = $("#agentModelSelector");
  const menu = $("#agentModelSelectorMenu");
  const panel = selector.closest(".agent-panel");
  if (!panel || menu.classList.contains("hidden")) return;

  const panelRect = panel.getBoundingClientRect();
  const selectorRect = selector.getBoundingClientRect();
  const gutter = 8;
  const width = Math.max(0, Math.min(280, panelRect.width - gutter * 2));
  const left = Math.min(
    Math.max(selectorRect.left, panelRect.left + gutter),
    panelRect.right - gutter - width,
  );
  const availableHeight = selectorRect.top - panelRect.top - gutter - 6;

  menu.style.width = `${Math.floor(width)}px`;
  menu.style.left = `${Math.floor(left - selectorRect.left)}px`;
  menu.style.right = "auto";
  menu.style.maxHeight = `${Math.max(80, Math.min(280, Math.floor(availableHeight)))}px`;
}

function openAgentModelSelector(focusPosition = null) {
  state.agentLlm.selectorOpen = true;
  $("#agentModelSelector").setAttribute("aria-expanded", "true");
  $("#agentModelSelectorMenu").classList.remove("hidden");
  positionAgentModelMenu();
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
      info.textContent = `${model.provider_display_name} · ${prettyToolCalling(agentModelCapability(model, "function_call"))}`;
      button.append(title, info);
      button.addEventListener("click", async () => {
        closeAgentModelSelector();
        try {
          const view = await invoke("agent_llm_select_model", {
            request: { modelId: model.id, expectedRevision: settings.revision },
          });
          state.agentLlm.settings = view;
          state.agentLlm.selectedModelId = view.selected_model_id;
          ensureAgentLlmSelectionState();
          updateAgentHeader();
          renderAgentLlmDialog();
        } catch (error) {
          toast(reportUiFailure("select Agent model", error, "The model could not be selected. Refresh model settings and try again."), true);
        }
      });
      menu.append(button);
    }
  }
  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = "agent-model-manage";
  manage.setAttribute("role", "menuitem");
  manage.innerHTML = "<strong>Model settings...</strong><p>Edit connections, models and connection checks.</p>";
  manage.addEventListener("click", () => {
    closeAgentModelSelector();
    openAgentLlmDialog();
  });
  menu.append(manage);
}

function currentProviderRecord() {
  return state.agentLlm.settings?.providers?.find((provider) => provider.id === state.agentLlm.selectedProviderId) || null;
}

function currentModelRecord() {
  return state.agentLlm.settings?.models?.find((model) => model.id === state.agentLlm.selectedModelEditorId) || null;
}

function createAgentLlmListRow(titleText, metaText, active, className = "agent-llm-row") {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `${className}${active ? " active" : ""}`;
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", String(Boolean(active)));
  const title = document.createElement("strong");
  title.textContent = titleText;
  const meta = document.createElement("span");
  meta.textContent = metaText;
  row.append(title, meta);
  return row;
}

function createAgentConnectionModelCard(model, settings, active) {
  const card = document.createElement("article");
  card.className = `agent-llm-connection-model-card${active ? " active" : ""}`;
  card.setAttribute("role", "option");
  card.setAttribute("aria-selected", String(Boolean(active)));
  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "agent-llm-connection-model-summary";
  const heading = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = model.display_name;
  const meta = document.createElement("span");
  meta.textContent = modelConnectionLabel(model);
  heading.append(title, meta);
  summary.append(heading);
  appendModelCapabilityChips(summary, model);
  const provenance = document.createElement("small");
  const automatic = [model.model_type, ...Object.values(model.capabilities || {})]
    .filter(Boolean)
    .filter((value) => value.value !== "unknown" && value.source === "aisdk_catalog").length;
  provenance.textContent = automatic
    ? `${automatic} default capability facts from aisdk`
    : "Capability facts need review";
  summary.append(provenance);
  summary.addEventListener("click", () => {
    state.agentLlm.selectedModelEditorId = model.id;
    state.agentLlm.editingModelId = model.id;
    state.agentLlm.lastTestResult = model.last_test || null;
    renderAgentLlmDialog();
  });
  const routes = (settings.capability_routes || [])
    .filter((route) => route.configured && route.model_id === model.id)
    .map((route) => route.label || route.capability);
  const assignment = document.createElement("p");
  assignment.textContent = routes.length ? `Used for: ${routes.join(", ")}` : "Not assigned to a route";
  const actions = document.createElement("div");
  actions.className = "agent-llm-connection-model-actions";
  const assign = document.createElement("button");
  assign.type = "button";
  assign.className = "primary";
  assign.textContent = "Assign uses";
  assign.disabled = !model.enabled;
  assign.addEventListener("click", () => focusAgentModelRouting(model.id));
  const review = document.createElement("button");
  review.type = "button";
  review.textContent = "Model options";
  review.addEventListener("click", () => reviewAgentRouteModel(model.id));
  actions.append(assign, review);
  card.append(summary, assignment, actions);
  return card;
}

function providerConnectionLabel(provider) {
  return `${agentProviderKindLabel(provider?.kind)} · ${credentialStatusLabel(provider)}`;
}

function clearAgentLlmCredentialInput() {
  for (const selector of ["#agentLlmCredential", "#agentLlmWizardCredential"]) {
    const input = $(selector);
    if (input) input.value = "";
  }
}

function agentProviderKindLabel(kind) {
  return {
    registered: "R provider",
    openai: "OpenAI",
    anthropic: "Anthropic",
    gemini: "Gemini",
    openai_compatible: "Compatible service",
    local_openai_compatible: "Local service",
  }[kind] || "Provider";
}

function credentialStatusLabel(provider) {
  if (!provider?.api_key_required || provider?.credential_status === "not_required") return "Not required";
  if (provider.credential_status === "unavailable") return "Credential storage unavailable";
  if (provider.credential_status === "detected" && provider.credential_source === "system") return "Stored securely";
  return "Not set";
}

function providerReadiness(provider, settings = state.agentLlm.settings) {
  if (!provider) return { state: "error", label: "Unavailable", detail: "Provider unavailable" };
  if (provider.credential_status === "unavailable") {
    return { state: "error", label: "Storage unavailable", detail: "Credential storage unavailable" };
  }
  if (provider.api_key_required && provider.credential_status !== "detected") {
    return { state: "warning", label: "Needs API key", detail: "API key not set" };
  }
  const models = (settings?.models || []).filter((model) => model.provider_id === provider.id);
  if (!models.length) return { state: "warning", label: "No models", detail: "Add a model" };
  const enabledModels = models.filter((model) => model.enabled);
  if (!enabledModels.length) {
    return { state: "warning", label: "Models disabled", detail: "Enable a model" };
  }
  if (enabledModels.some((model) => model.last_test?.status === "ready")) {
    return { state: "ready", label: "Ready", detail: `${enabledModels.length} enabled` };
  }
  if (enabledModels.some((model) => model.last_test?.status === "error")) {
    return { state: "error", label: "Connection error", detail: "Review the latest test" };
  }
  return { state: "warning", label: "Ready to test", detail: `${enabledModels.length} enabled` };
}

function agentLlmOperationRecord(scope) {
  if (scope === "wizard") return state.agentLlm.wizardOperation;
  if (scope === "model") return state.agentLlm.modelOperation;
  return state.agentLlm.operation;
}

function syncAgentLlmOperationSubmissionState(scope, working) {
  if (scope === "main") {
    const provider = currentProviderRecord();
    const model = currentModelRecord();
    const missingCredential = provider?.api_key_required && provider.credential_status !== "detected";
    const baseDisabled = new Map([
      ["#agentLlmAddProvider", false],
      ["#agentLlmAddModel", !provider],
      ["#agentLlmEditModel", !model],
      ["#agentLlmSaveCredential", !provider?.api_key_required || provider?.credential_status === "unavailable"],
      ["#agentLlmTestModel", !model || !model.enabled || state.agentLlm.testInFlight || missingCredential],
      ["#agentLlmSelectDefault", !model || !model.enabled],
      ["#agentLlmSaveProvider", !provider],
      ["#agentLlmDeleteProvider", !provider],
      ["#agentLlmDeleteCredential", provider?.credential_source !== "system"],
    ]);
    for (const [selector, disabled] of baseDisabled) {
      const button = $(selector);
      if (button) button.disabled = working || disabled;
    }
    return;
  }
  const selectors = scope === "wizard"
    ? ["#agentLlmWizardCancel", "#agentLlmWizardContinue", "#agentLlmWizardBack", "#agentLlmWizardRefreshModels", "#agentLlmWizardFinishLater", "#agentLlmWizardFinish"]
    : ["#agentLlmRefreshModels", "#agentLlmModelCancel", "#agentLlmSaveModel", "#agentLlmDeleteModel"];
  for (const selector of selectors) {
    const button = $(selector);
    if (button) button.disabled = working;
  }
}

function renderAgentLlmOperationStatus(scope = "main") {
  const target = scope === "wizard"
    ? $("#agentLlmWizardStatus")
    : scope === "model"
      ? $("#agentLlmModelStatus")
      : $("#agentLlmOperationStatus");
  if (!target) return;
  const operation = agentLlmOperationRecord(scope);
  target.className = `agent-llm-operation-status${operation.state === "idle" ? " hidden" : ` ${operation.state}`}`;
  target.textContent = operation.message || "";
  syncAgentLlmOperationSubmissionState(scope, operation.state === "working");
}

function setAgentLlmOperationState(operationState, message = "", scope = "main") {
  const operation = agentLlmOperationRecord(scope);
  operation.state = operationState;
  operation.message = message;
  renderAgentLlmOperationStatus(scope);
}

function renderAgentCredentialFields() {
  const provider = currentProviderRecord();
  const kind = $("#agentLlmProviderKind").value;
  const compatible = ["openai_compatible", "local_openai_compatible"].includes(kind);
  const keyRequired = Boolean($("#agentLlmProviderApiKeyRequired").checked);
  const preset = Object.values(AGENT_PROVIDER_PRESETS).find((item) => (
    item.kind === kind
    && (kind !== "registered" || item.registeredProviderId === $("#agentLlmRegisteredProviderId").value.trim().toLowerCase())
  )) || null;
  $("#agentLlmProviderBaseUrl").placeholder = preset?.defaultBaseUrl || "https://api.example.com/v1";
  $("#agentLlmProviderBaseUrlHint").textContent = compatible
    ? "Required unless Advanced supplies a Base URL environment variable."
    : preset?.defaultBaseUrl
      ? `Optional. Leave blank to use ${preset.defaultBaseUrl}.`
      : "Optional for reviewed registered Providers; otherwise leave blank.";
  $("#agentLlmCredentialField").classList.toggle("hidden", !keyRequired);
  $("#agentLlmCredentialStatus").textContent = keyRequired ? credentialStatusLabel(provider) : "Not required";
  $("#agentLlmDeleteCredential").classList.toggle(
    "hidden",
    !keyRequired || provider?.credential_source !== "system"
  );
}

function modelSelectorStatusLabel(model) {
  return ({
    selected: "Selected",
    available: "Available",
    ready: "Ready",
    disabled: "Disabled",
    unavailable: "Unavailable",
    invalid: "Needs attention",
    untested: "Ready to test",
    "key missing": "Needs API key",
    error: "Connection error",
  })[String(model?.selector_status || "").toLowerCase()] || (model?.enabled ? "Available" : "Disabled");
}

function modelConnectionLabel(model) {
  const status = modelSelectorStatusLabel(model);
  return `${model?.provider_display_name || "Provider"} · ${model?.selected ? `Current · ${status}` : status}`;
}

function agentLlmDiscoveryRecord(scope) {
  return scope === "wizard" ? state.agentLlm.wizardDiscovery : state.agentLlm.modelDiscovery;
}

function agentLlmDiscoveryElements(scope) {
  return scope === "wizard"
    ? {
      select: $("#agentLlmWizardDiscoveredModel"),
      cards: $("#agentLlmWizardDiscoveredModelCards"),
      capabilityGrid: $("#agentLlmWizardCapabilityGrid"),
      status: $("#agentLlmWizardDiscoveryStatus"),
      refresh: $("#agentLlmWizardRefreshModels"),
      manual: $("#agentLlmWizardManualModel"),
      modelId: $("#agentLlmWizardModelId"),
      displayName: $("#agentLlmWizardModelName"),
      toolCalling: $("#agentLlmWizardModelToolCalling"),
      reasoning: $("#agentLlmWizardModelReasoning"),
      visionInput: $("#agentLlmWizardModelVisionInput"),
      imageOutput: $("#agentLlmWizardModelImageOutput"),
      imageEdit: $("#agentLlmWizardModelImageEdit"),
      audioInput: $("#agentLlmWizardModelAudioInput"),
      audioOutput: $("#agentLlmWizardModelAudioOutput"),
      structuredOutput: $("#agentLlmWizardModelStructuredOutput"),
      webSearch: $("#agentLlmWizardModelWebSearch"),
      modelType: $("#agentLlmWizardModelType"),
    }
    : {
      select: $("#agentLlmModelDiscoveredModel"),
      cards: $("#agentLlmModelDiscoveredModelCards"),
      capabilityGrid: $("#agentLlmModelCapabilityGrid"),
      status: $("#agentLlmModelDiscoveryStatus"),
      refresh: $("#agentLlmRefreshModels"),
      manual: $("#agentLlmModelManualFields"),
      modelId: $("#agentLlmModelId"),
      displayName: $("#agentLlmModelDisplayName"),
      toolCalling: $("#agentLlmModelToolCalling"),
      reasoning: $("#agentLlmModelReasoning"),
      visionInput: $("#agentLlmModelVisionInput"),
      imageOutput: $("#agentLlmModelImageOutput"),
      imageEdit: $("#agentLlmModelImageEdit"),
      audioInput: $("#agentLlmModelAudioInput"),
      audioOutput: $("#agentLlmModelAudioOutput"),
      structuredOutput: $("#agentLlmModelStructuredOutput"),
      webSearch: $("#agentLlmModelWebSearch"),
      modelType: $("#agentLlmModelType"),
    };
}

function agentCapabilityInputMap(elements) {
  return {
    function_call: elements.toolCalling,
    reasoning: elements.reasoning,
    vision_input: elements.visionInput,
    image_output: elements.imageOutput,
    image_edit: elements.imageEdit,
    audio_input: elements.audioInput,
    audio_output: elements.audioOutput,
    structured_output: elements.structuredOutput,
    web_search: elements.webSearch,
  };
}

function modelCapabilitySummary(model, { includeUnknown = false } = {}) {
  const chips = [{ label: agentModelType(model), state: agentModelType(model) === "unknown" ? "unknown" : "type" }];
  for (const name of AGENT_MODEL_CAPABILITIES) {
    const value = agentModelCapability(model, name);
    if (value === "yes" || (includeUnknown && value === "unknown")) {
      chips.push({ label: AGENT_CAPABILITY_LABELS[name], state: value });
    }
  }
  return chips;
}

function appendModelCapabilityChips(container, model, options = {}) {
  const row = document.createElement("div");
  row.className = "agent-llm-model-capabilities";
  for (const item of modelCapabilitySummary(model, options)) {
    const chip = document.createElement("span");
    chip.dataset.state = item.state;
    chip.textContent = item.label;
    row.append(chip);
  }
  container.append(row);
}

function renderAgentLlmDiscoveredModelCards(scope) {
  const record = agentLlmDiscoveryRecord(scope);
  const elements = agentLlmDiscoveryElements(scope);
  if (!elements.cards) return;
  elements.cards.replaceChildren();
  const selectedId = elements.select.value;
  for (const model of record.models) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `agent-llm-discovered-model-card${model.id === selectedId ? " active" : ""}`;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(model.id === selectedId));
    const title = document.createElement("strong");
    title.textContent = model.display_name || model.id;
    const id = document.createElement("code");
    id.textContent = model.id;
    button.append(title, id);
    appendModelCapabilityChips(button, model);
    const source = document.createElement("small");
    source.textContent = model.model_type?.source === "aisdk_catalog"
      ? "Default capabilities from aisdk catalog"
      : "Capability details need review";
    button.append(source);
    button.addEventListener("click", () => {
      elements.select.value = model.id;
      applyAgentLlmDiscoveredModel(scope);
      renderAgentLlmDiscoveredModelCards(scope);
    });
    elements.cards.append(button);
  }
  if (!record.models.length && record.status !== "loading") {
    const empty = document.createElement("div");
    empty.className = "agent-llm-empty";
    empty.textContent = record.status === "idle" ? "Fetch models to review their default capabilities." : "No Provider models are available here; use manual entry.";
    elements.cards.append(empty);
  }
}

function renderAgentCapabilityPanel(scope, sourceModel = null) {
  const elements = agentLlmDiscoveryElements(scope);
  if (!elements.capabilityGrid) return;
  const inputs = agentCapabilityInputMap(elements);
  const discovered = agentLlmDiscoveryRecord(scope).models.find((item) => item.id === elements.select.value) || null;
  const existing = scope === "model"
    ? state.agentLlm.settings?.models?.find((item) => item.id === state.agentLlm.editingModelId) || null
    : null;
  const evidenceModel = sourceModel || discovered || existing;
  elements.capabilityGrid.replaceChildren();
  for (const name of AGENT_MODEL_CAPABILITIES) {
    const input = inputs[name];
    const value = input?.value || "unknown";
    const evidence = evidenceModel?.capabilities?.[name];
    const source = evidence?.value === value ? evidence.source : "user_declared";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agent-llm-capability-toggle";
    button.dataset.value = value;
    button.dataset.source = source;
    button.setAttribute("role", "switch");
    button.setAttribute("aria-checked", String(value === "yes"));
    button.setAttribute("aria-label", `${AGENT_CAPABILITY_LABELS[name]}: ${value}`);
    const label = document.createElement("span");
    label.textContent = AGENT_CAPABILITY_LABELS[name];
    const status = document.createElement("small");
    const sourceLabel = source === "aisdk_catalog" ? "auto" : source === "provider_response" ? "provider" : source === "user_declared" ? "declared" : "unknown";
    status.textContent = `${value === "yes" ? "On" : value === "no" ? "Off" : "Unknown"} · ${sourceLabel}`;
    const track = document.createElement("i");
    track.setAttribute("aria-hidden", "true");
    button.append(label, status, track);
    button.addEventListener("click", () => {
      input.value = value === "yes" ? "no" : "yes";
      renderAgentCapabilityPanel(scope, evidenceModel);
    });
    elements.capabilityGrid.append(button);
  }
}

function resetAgentLlmDiscovery(scope, providerId = null) {
  state.agentLlm.discoverySequence += 1;
  const replacement = {
    requestId: state.agentLlm.discoverySequence,
    providerId,
    status: "idle",
    models: [],
    truncated: false,
    message: providerId ? "Ready to fetch available models." : "Choose a Provider to fetch models.",
  };
  if (scope === "wizard") state.agentLlm.wizardDiscovery = replacement;
  else state.agentLlm.modelDiscovery = replacement;
  renderAgentLlmDiscovery(scope);
}

function renderAgentLlmDiscovery(scope) {
  const record = agentLlmDiscoveryRecord(scope);
  const elements = agentLlmDiscoveryElements(scope);
  if (!elements.select || !elements.status) return;
  const currentModelId = elements.modelId?.value || "";
  elements.select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = ({
    idle: record.providerId ? "Fetch available models..." : "Choose a Provider first...",
    loading: "Fetching available models...",
    ready: record.models.length ? "Choose a model..." : "No available models returned",
    unsupported: "Provider model list unavailable",
    error: "Could not fetch models",
  })[record.status] || "Choose a model...";
  elements.select.append(placeholder);
  for (const model of record.models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.display_name && model.display_name !== model.id
      ? `${model.display_name} · ${model.id}`
      : model.id;
    elements.select.append(option);
  }
  if (record.models.some((model) => model.id === currentModelId)) elements.select.value = currentModelId;
  const operationWorking = agentLlmOperationRecord(scope).state === "working";
  elements.select.disabled = operationWorking || record.status !== "ready" || !record.models.length;
  elements.refresh.disabled = operationWorking || record.status === "loading" || !record.providerId;
  elements.status.textContent = record.message || "";
  elements.status.dataset.state = record.status === "ready" && record.models.length
    ? "ready"
    : record.status === "loading" || record.status === "idle" ? record.status : "warning";
  if (["unsupported", "error"].includes(record.status) || (record.status === "ready" && !record.models.length)) {
    elements.manual.open = true;
  }
  renderAgentLlmDiscoveredModelCards(scope);
  renderAgentCapabilityPanel(scope);
}

function applyAgentLlmDiscoveredModel(scope) {
  const record = agentLlmDiscoveryRecord(scope);
  const elements = agentLlmDiscoveryElements(scope);
  const model = record.models.find((item) => item.id === elements.select.value);
  if (!model) return;
  elements.modelId.value = model.id;
  elements.displayName.value = model.display_name || model.id;
  elements.modelType.value = model.model_type?.value || "unknown";
  elements.toolCalling.value = model.capabilities?.function_call?.value || "unknown";
  elements.reasoning.value = model.capabilities?.reasoning?.value || "unknown";
  elements.visionInput.value = model.capabilities?.vision_input?.value || "unknown";
  elements.imageOutput.value = model.capabilities?.image_output?.value || "unknown";
  elements.imageEdit.value = model.capabilities?.image_edit?.value || "unknown";
  elements.audioInput.value = model.capabilities?.audio_input?.value || "unknown";
  elements.audioOutput.value = model.capabilities?.audio_output?.value || "unknown";
  elements.structuredOutput.value = model.capabilities?.structured_output?.value || "unknown";
  elements.webSearch.value = model.capabilities?.web_search?.value || "unknown";
  renderAgentCapabilityPanel(scope, model);
}

function agentLlmDiscoveryContextIsCurrent(scope, providerId, requestId) {
  const record = agentLlmDiscoveryRecord(scope);
  if (record.requestId !== requestId || record.providerId !== providerId) return false;
  if (scope === "wizard") {
    return state.agentLlm.wizardOpen
      && state.agentLlm.wizardStep === "model"
      && state.agentLlm.wizardProviderId === providerId;
  }
  return state.agentLlm.modelDialogOpen && $("#agentLlmModelProvider").value === providerId;
}

async function discoverAgentLlmModels(providerId, scope) {
  if (!providerId) {
    resetAgentLlmDiscovery(scope, null);
    return;
  }
  state.agentLlm.discoverySequence += 1;
  const requestId = state.agentLlm.discoverySequence;
  const record = {
    requestId,
    providerId,
    status: "loading",
    models: [],
    truncated: false,
    message: "Fetching available models from the Provider. No prompt is sent...",
  };
  if (scope === "wizard") state.agentLlm.wizardDiscovery = record;
  else state.agentLlm.modelDiscovery = record;
  renderAgentLlmDiscovery(scope);
  try {
    const response = await invoke("agent_llm_discover_models", { providerId });
    if (!agentLlmDiscoveryContextIsCurrent(scope, providerId, requestId)) return;
    const validStatus = ["ready", "unsupported", "error"].includes(response?.status);
    const validModels = Array.isArray(response?.models)
      && response.models.every((model) => model && typeof model.id === "string" && typeof model.display_name === "string");
    if (!validStatus || !validModels || response.provider_id !== providerId) {
      record.status = "error";
      record.models = [];
      record.message = "The Provider returned an invalid model list. Enter a model ID manually.";
      record.truncated = false;
    } else {
      record.status = response.status;
      record.models = response.models;
      record.truncated = Boolean(response.truncated);
      record.message = response.message || (response.models.length
        ? `Loaded ${response.models.length} available models.`
        : "No available models were returned. Enter a model ID manually.");
    }
  } catch (error) {
    if (!agentLlmDiscoveryContextIsCurrent(scope, providerId, requestId)) return;
    record.status = "error";
    record.models = [];
    record.truncated = false;
    record.message = reportUiFailure("discover provider models", error,
      "Rho could not fetch this Provider's models. Enter a model ID manually or retry.",
    );
  }
  if (!agentLlmDiscoveryContextIsCurrent(scope, providerId, requestId)) return;
  const elements = agentLlmDiscoveryElements(scope);
  const focusWasOnStatus = document.activeElement === elements.status;
  renderAgentLlmDiscovery(scope);
  if (focusWasOnStatus) {
    if (record.status === "ready" && record.models.length) elements.cards.querySelector("button")?.focus();
    else {
      elements.manual.open = true;
      elements.modelId.focus();
    }
  }
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
  renderAgentCredentialFields();
}

function renderAgentModelForm() {
  const model = state.agentLlm.settings?.models?.find((item) => item.id === state.agentLlm.editingModelId) || null;
  const providerSelect = $("#agentLlmModelProvider");
  providerSelect.replaceChildren();
  for (const provider of state.agentLlm.settings?.providers || []) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.display_name;
    providerSelect.append(option);
  }
  $("#agentLlmModelDisplayName").value = model?.display_name || "";
  $("#agentLlmModelProvider").value = model?.provider_id || state.agentLlm.selectedProviderId || state.agentLlm.settings?.providers?.[0]?.id || "";
  $("#agentLlmModelId").value = model?.model_id || "";
  $("#agentLlmModelType").value = agentModelType(model) === "unknown" && !model ? "language" : agentModelType(model);
  const capabilityFields = {
    function_call: "#agentLlmModelToolCalling",
    reasoning: "#agentLlmModelReasoning",
    vision_input: "#agentLlmModelVisionInput",
    image_output: "#agentLlmModelImageOutput",
    image_edit: "#agentLlmModelImageEdit",
    audio_input: "#agentLlmModelAudioInput",
    audio_output: "#agentLlmModelAudioOutput",
    structured_output: "#agentLlmModelStructuredOutput",
    web_search: "#agentLlmModelWebSearch",
  };
  for (const [name, selector] of Object.entries(capabilityFields)) {
    $(selector).value = agentModelCapability(model, name);
  }
  const evidence = model
    ? [`type: ${model.model_type?.source || "unknown"}`, ...AGENT_MODEL_CAPABILITIES.map((name) => `${name}: ${agentModelCapabilitySource(model, name)}`)]
    : ["New manual values are recorded as user-declared evidence."];
  $("#agentLlmModelEvidence").textContent = evidence.join(" · ");
  $("#agentLlmModelEnabled").checked = model ? Boolean(model.enabled) : true;
  $("#agentLlmModelManualFields").open = Boolean(model);
  $("#agentLlmModelCapabilities").open = true;
  renderAgentLlmDiscovery("model");
}

function renderAgentLlmCurrentSelection(settings) {
  const model = (settings.models || []).find((item) => item.id === settings.selected_model_id)
    || settings.selected_model
    || null;
  const provider = model
    ? (settings.providers || []).find((item) => item.id === model.provider_id)
    : null;
  const status = model ? modelSelectorStatusLabel(model) : "No model selected";
  $("#agentLlmCurrentStatus").textContent = status;
  const selectorStatus = String(model?.selector_status || "").toLowerCase();
  const tone = ["error", "key missing", "unavailable", "invalid"].includes(selectorStatus)
    ? " error"
    : ["selected", "available", "ready"].includes(selectorStatus) ? " ready" : "";
  $("#agentLlmCurrentStatus").className = `agent-llm-current-status${tone}`;
  $("#agentLlmCurrentSelection").textContent = model
    ? `${model.display_name || model.model_id} · ${provider?.display_name || model.provider_display_name || "Provider"}`
    : "No model selected. Choose or add a model below.";
}

function switchAgentLlmView(view, { focus = false } = {}) {
  const next = ["routing", "connections", "library"].includes(view) ? view : "connections";
  state.agentLlm.activeView = next;
  const definitions = [
    ["connections", "#agentLlmConnectionsTab", "#agentLlmShell"],
    ["routing", "#agentLlmRoutingTab", "#agentLlmRoutingPanel"],
    ["library", "#agentLlmLibraryTab", "#agentLlmLibraryPanel"],
  ];
  for (const [name, tabSelector, panelSelector] of definitions) {
    const active = name === next;
    $(tabSelector).setAttribute("aria-selected", String(active));
    $(tabSelector).tabIndex = active ? 0 : -1;
    $(panelSelector).classList.toggle("hidden", !active);
  }
  if (focus) {
    const activeDefinition = definitions.find(([name]) => name === next);
    if (activeDefinition) $(activeDefinition[1]).focus();
  }
}

function routeModelOptions(select, route, settings, selectedModelId = null) {
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = route.inherited_from
    ? `Use ${route.inherited_from} (${route.model_display_name || "unavailable"})`
    : "Choose a model…";
  select.append(placeholder);
  const payload = {
    model_type: route.model_type,
    required_model_capabilities: route.required_model_capabilities || [],
  };
  const groups = {
    compatible: document.createElement("optgroup"),
    needs_review: document.createElement("optgroup"),
    incompatible: document.createElement("optgroup"),
  };
  groups.compatible.label = "Compatible";
  groups.needs_review.label = "Needs review";
  groups.incompatible.label = "Incompatible";
  for (const model of (settings.models || []).filter((item) => item.enabled)) {
    const compatibility = agentRouteCompatibility(model, payload);
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${model.display_name} · ${model.provider_display_name || "Provider"}`;
    option.dataset.compatibility = compatibility;
    option.disabled = compatibility === "incompatible";
    groups[compatibility].append(option);
  }
  for (const group of Object.values(groups)) if (group.children.length) select.append(group);
  select.value = selectedModelId || "";
}

function routeStatusCopy(route, model) {
  const details = [];
  if (route.inherited_from) details.push(`Uses ${route.inherited_from}`);
  details.push(route.compatibility === "compatible" ? "Compatible" : route.compatibility === "needs_review" ? "Needs review" : route.compatibility === "incompatible" ? "Incompatible" : "Not assigned");
  if (model) details.push(agentModelType(model));
  if (route.credential_status === "detected" || route.credential_status === "not_required") details.push("Connection ready");
  else if (model) details.push("Key missing");
  if (route.consumer_status !== "available") details.push("Consumer not installed");
  return details.join(" · ");
}

async function persistAgentCapabilityRoute(route, modelId) {
  const settings = state.agentLlm.settings;
  if (!settings) return;
  setAgentLlmOperationState("working", `Saving ${route.capability}…`);
  try {
    const view = await invoke("agent_llm_save_capability_route", {
      expectedRevision: settings.revision,
      route: {
        capability: route.capability,
        model_id: modelId,
        model_type: route.model_type,
        required_model_capabilities: route.required_model_capabilities || [],
      },
    });
    applyAgentLlmView(view);
    setAgentLlmOperationState("success", `${route.label || route.capability} now uses ${view.models.find((model) => model.id === modelId)?.display_name || modelId}.`);
  } catch (error) {
    if (isStaleInformationError(error)) {
      await loadAgentLlmSettings();
      setAgentLlmOperationState("warning", "Model settings changed in another window. The latest revision was loaded; review the route and try again.");
    } else {
      setAgentLlmOperationState("error", reportUiFailure("save capability route", error, "The route was not changed. Review model compatibility and try again."));
    }
  }
}

async function removeAgentCapabilityRoute(route) {
  const settings = state.agentLlm.settings;
  if (!settings || route.capability === "agent.chat") return;
  setAgentLlmOperationState("working", `Removing ${route.capability}…`);
  try {
    const view = await invoke("agent_llm_delete_capability_route", {
      expectedRevision: settings.revision,
      capability: route.capability,
    });
    applyAgentLlmView(view);
    setAgentLlmOperationState("success", `${route.label || route.capability} route removed. Its model and credential were kept.`);
  } catch (error) {
    if (isStaleInformationError(error)) {
      await loadAgentLlmSettings();
      setAgentLlmOperationState("warning", "Model settings changed. The latest revision was loaded.");
    } else {
      setAgentLlmOperationState("error", reportUiFailure("remove capability route", error, "The route could not be removed."));
    }
  }
}

function reviewAgentRouteModel(modelId) {
  const model = state.agentLlm.settings?.models?.find((item) => item.id === modelId);
  if (!model) return;
  state.agentLlm.selectedProviderId = model.provider_id;
  state.agentLlm.selectedModelEditorId = model.id;
  state.agentLlm.editingModelId = model.id;
  openAgentLlmModelDialog(model.id);
}

function openAgentConnectionForModel(modelId) {
  const model = state.agentLlm.settings?.models?.find((item) => item.id === modelId);
  if (!model) return;
  state.agentLlm.selectedProviderId = model.provider_id;
  state.agentLlm.selectedModelEditorId = model.id;
  state.agentLlm.editingProviderId = model.provider_id;
  state.agentLlm.editingModelId = model.id;
  switchAgentLlmView("connections");
  renderAgentLlmDialog();
  requestAnimationFrame(() => $("#agentLlmSelectedProviderName")?.focus());
}

function focusAgentModelRouting(modelId) {
  const model = state.agentLlm.settings?.models?.find((item) => item.id === modelId);
  if (!model) return;
  state.agentLlm.routingFocusModelId = model.id;
  state.agentLlm.routingExpandedCapability = null;
  switchAgentLlmView("routing");
  renderAgentLlmDialog();
  requestAnimationFrame(() => $("#agentLlmRoutingContext")?.focus());
}

function createAgentRouteModelCard(model, route, settings) {
  const compatibility = agentRouteCompatibility(model, route);
  const provider = settings.providers.find((item) => item.id === model.provider_id) || null;
  const assigned = route.configured && route.model_id === model.id;
  const card = document.createElement("article");
  card.className = `agent-llm-route-model-card${state.agentLlm.routingFocusModelId === model.id ? " highlighted" : ""}`;
  card.dataset.compatibility = compatibility;
  const heading = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = model.display_name;
  const meta = document.createElement("span");
  meta.textContent = `${provider?.display_name || model.provider_display_name || "Provider"} · ${modelSelectorStatusLabel(model)}`;
  heading.append(title, meta);
  card.append(heading);
  appendModelCapabilityChips(card, model, { includeUnknown: compatibility === "needs_review" });
  const explanation = document.createElement("p");
  explanation.textContent = compatibility === "compatible"
    ? "Matches this route's type and required capabilities."
    : compatibility === "needs_review"
      ? "One or more required capabilities are unknown. Review them before assignment."
      : "This model has an incompatible type or an explicitly unsupported capability.";
  card.append(explanation);
  const actions = document.createElement("div");
  actions.className = "agent-llm-route-model-actions";
  const use = document.createElement("button");
  use.type = "button";
  use.className = "primary";
  use.textContent = assigned ? "Assigned" : "Use for this route";
  use.disabled = assigned || compatibility !== "compatible";
  use.addEventListener("click", () => persistAgentCapabilityRoute(route, model.id));
  const review = document.createElement("button");
  review.type = "button";
  review.textContent = compatibility === "needs_review" ? "Review capabilities" : "Review model";
  review.addEventListener("click", () => reviewAgentRouteModel(model.id));
  const connection = document.createElement("button");
  connection.type = "button";
  connection.textContent = "Open connection";
  connection.addEventListener("click", () => openAgentConnectionForModel(model.id));
  actions.append(use, review, connection);
  card.append(actions);
  return card;
}

function renderAgentLlmRouting(settings) {
  $("#agentLlmRoutingRevision").textContent = `Revision ${settings.revision ?? "—"}`;
  const focusedModel = settings.models.find((item) => item.id === state.agentLlm.routingFocusModelId) || null;
  const context = $("#agentLlmRoutingContext");
  context.replaceChildren();
  context.classList.toggle("hidden", !focusedModel);
  context.tabIndex = focusedModel ? -1 : 0;
  if (focusedModel) {
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `Assign uses for ${focusedModel.display_name}`;
    const note = document.createElement("span");
    note.textContent = "Choose an explicit compatible route below. Importing a model never assigns it automatically.";
    copy.append(title, note);
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Show all models";
    clear.addEventListener("click", () => {
      state.agentLlm.routingFocusModelId = null;
      renderAgentLlmDialog();
    });
    context.append(copy, clear);
  }
  const list = $("#agentLlmRouteList");
  list.replaceChildren();
  for (const route of settings.capability_routes || []) {
    const model = settings.models.find((item) => item.id === route.model_id) || null;
    const card = document.createElement("article");
    card.className = "agent-llm-route-card";
    card.dataset.route = route.capability;
    card.dataset.state = route.compatibility;
    const title = document.createElement("div");
    title.className = "agent-llm-route-title";
    const strong = document.createElement("strong");
    strong.textContent = route.label || route.capability;
    const description = document.createElement("span");
    description.textContent = `${route.capability} · ${route.description || "Typed capability route"}`;
    title.append(strong, description);
    const meta = document.createElement("div");
    meta.className = "agent-llm-route-meta";
    meta.textContent = routeStatusCopy(route, model);
    const actions = document.createElement("div");
    actions.className = "agent-llm-route-actions";
    const choose = document.createElement("button");
    choose.type = "button";
    choose.className = "primary";
    const expanded = Boolean(focusedModel) || state.agentLlm.routingExpandedCapability === route.capability;
    choose.textContent = expanded ? "Hide models" : route.configured ? "Change model" : "Choose model";
    choose.setAttribute("aria-expanded", String(Boolean(expanded)));
    choose.addEventListener("click", () => {
      if (focusedModel) state.agentLlm.routingFocusModelId = null;
      state.agentLlm.routingExpandedCapability = expanded ? null : route.capability;
      renderAgentLlmDialog();
    });
    const connection = document.createElement("button");
    connection.type = "button";
    connection.textContent = "Open connection";
    connection.disabled = !model;
    connection.addEventListener("click", () => openAgentConnectionForModel(model?.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = route.capability === "agent.chat" ? "Required" : "Remove";
    remove.disabled = route.capability === "agent.chat" || !route.configured;
    remove.addEventListener("click", () => removeAgentCapabilityRoute(route));
    actions.append(choose, connection, remove);
    const modelPanel = document.createElement("div");
    modelPanel.className = `agent-llm-route-model-grid${expanded ? "" : " hidden"}`;
    if (expanded) {
      const candidates = (focusedModel ? [focusedModel] : settings.models.filter((item) => item.enabled));
      for (const candidate of candidates) modelPanel.append(createAgentRouteModelCard(candidate, route, settings));
      if (!candidates.length) {
        const empty = document.createElement("div");
        empty.className = "agent-llm-empty";
        empty.textContent = "No enabled models are available. Add a Provider connection and import a model first.";
        const add = document.createElement("button");
        add.type = "button";
        add.textContent = "Add a connection";
        add.addEventListener("click", () => switchAgentLlmView("connections", { focus: true }));
        modelPanel.append(empty, add);
      }
    }
    card.append(title, meta, actions, modelPanel);
    list.append(card);
  }
  renderAgentLlmCustomRouteModels(settings);
}

function renderAgentLlmCustomRouteModels(settings = state.agentLlm.settings) {
  const select = $("#agentLlmCustomRouteModel");
  if (!select || !settings) return;
  const modelType = $("#agentLlmCustomRouteType").value;
  const required = $("#agentLlmCustomRouteRequired").value.split(",").map((value) => value.trim()).filter(Boolean);
  routeModelOptions(select, {
    model_type: modelType,
    required_model_capabilities: required,
    inherited_from: null,
  }, settings, select.value);
}

async function saveAgentLlmCustomRoute() {
  const capability = $("#agentLlmCustomRouteName").value.trim().toLowerCase();
  const modelType = $("#agentLlmCustomRouteType").value;
  const required = [...new Set($("#agentLlmCustomRouteRequired").value.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))];
  const modelId = $("#agentLlmCustomRouteModel").value;
  if (!/^[a-z][a-z0-9._-]{0,79}$/.test(capability) || !modelId) {
    setAgentLlmOperationState("warning", "Enter a canonical route name and choose a compatible model.");
    return;
  }
  if (required.length > 16 || required.some((name) => !AGENT_MODEL_CAPABILITIES.includes(name))) {
    setAgentLlmOperationState("warning", "Required capabilities must use the supported vocabulary (up to 16 unique names).");
    return;
  }
  await persistAgentCapabilityRoute({
    capability,
    label: capability,
    model_type: modelType,
    required_model_capabilities: required,
  }, modelId);
  if (state.agentLlm.settings?.capability_routes?.some((route) => route.capability === capability)) {
    $("#agentLlmCustomRouteName").value = "";
    $("#agentLlmCustomRouteRequired").value = "";
    $("#agentLlmCustomRoute").open = false;
  }
}

function renderAgentLlmLibrary(settings) {
  const list = $("#agentLlmLibraryList");
  list.replaceChildren();
  for (const model of settings.models || []) {
    const assignments = (settings.capability_routes || [])
      .filter((route) => route.configured && route.model_id === model.id)
      .map((route) => route.capability);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `agent-llm-library-card${model.id === state.agentLlm.selectedModelEditorId ? " active" : ""}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(model.id === state.agentLlm.selectedModelEditorId));
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = model.display_name;
    const meta = document.createElement("p");
    meta.textContent = `${model.provider_display_name} · ${agentModelType(model)} · ${assignments.length ? assignments.join(", ") : "Unassigned"}`;
    copy.append(title, meta);
    const status = document.createElement("span");
    status.textContent = model.selector_status;
    button.append(copy, status);
    button.addEventListener("click", () => {
      state.agentLlm.selectedProviderId = model.provider_id;
      state.agentLlm.selectedModelEditorId = model.id;
      state.agentLlm.editingModelId = model.id;
      state.agentLlm.lastTestResult = model.last_test || null;
      renderAgentLlmDialog();
    });
    list.append(button);
  }
  if (!settings.models?.length) {
    const empty = document.createElement("div");
    empty.className = "agent-llm-empty";
    empty.textContent = "No models imported yet. Add a Connection, then import a model.";
    list.append(empty);
  }
  const selected = currentModelRecord();
  $("#agentLlmLibraryEditModel").disabled = !selected;
  $("#agentLlmLibraryTestModel").disabled = !selected || agentModelType(selected) !== "language" || state.agentLlm.testInFlight;
}

function renderAgentLlmDialog() {
  const settings = state.agentLlm.settings || emptyAgentLlmSettings("Agent LLM settings are unavailable.");
  ensureAgentLlmSelectionState();
  const selectedProvider = settings.providers.find((provider) => provider.id === state.agentLlm.selectedProviderId) || null;
  const providerModels = settings.models.filter((model) => model.provider_id === selectedProvider?.id);
  const selectedModel = providerModels.find((model) => model.id === state.agentLlm.selectedModelEditorId) || null;
  renderAgentLlmCurrentSelection(settings);
  $("#agentLlmUserEnviron").textContent = "Connections store keys; the model library stores evidence; capability routes choose each typed use.";
  $("#agentLlmValidationMessage").textContent = settings.validation_error
    ? userFacingError(settings.validation_error, "The model configuration needs attention. Review the selected provider and model.")
    : "";
  $("#agentLlmValidation").classList.toggle("hidden", !settings.validation_error);
  $("#agentLlmRetrySettings").disabled = state.agentLlm.settingsLoading;
  const providerList = $("#agentLlmProviderList");
  providerList.replaceChildren();
  if (!settings.providers.length) {
    const empty = document.createElement("div");
    empty.className = "agent-llm-empty";
    empty.textContent = "No providers yet.";
    providerList.append(empty);
  } else {
    for (const provider of settings.providers) {
      const readiness = providerReadiness(provider, settings);
      const providerModelCount = settings.models.filter((model) => model.provider_id === provider.id).length;
      const row = createAgentLlmListRow(
        provider.display_name,
        `${readiness.label} · ${providerModelCount} ${providerModelCount === 1 ? "model" : "models"} · ${agentProviderKindLabel(provider.kind)}`,
        provider.id === state.agentLlm.selectedProviderId,
        "agent-llm-provider-card",
      );
      row.addEventListener("click", () => {
        clearAgentLlmCredentialInput();
        state.agentLlm.selectedProviderId = provider.id;
        state.agentLlm.editingProviderId = provider.id;
        state.agentLlm.selectedModelEditorId = settings.models.find((model) => model.provider_id === provider.id && model.id === settings.selected_model_id)?.id
          || settings.models.find((model) => model.provider_id === provider.id)?.id
          || null;
        state.agentLlm.editingModelId = state.agentLlm.selectedModelEditorId;
        state.agentLlm.lastTestResult = null;
        setAgentLlmOperationState("idle");
        $("#agentLlmProviderAdvanced").open = false;
        renderAgentLlmDialog();
      });
      providerList.append(row);
    }
  }
  $("#agentLlmProviderEmpty").classList.toggle("hidden", Boolean(selectedProvider));
  $("#agentLlmProviderContent").classList.toggle("hidden", !selectedProvider);
  if (selectedProvider) {
    const readiness = providerReadiness(selectedProvider, settings);
    $("#agentLlmSelectedProviderName").textContent = selectedProvider.display_name;
    $("#agentLlmSelectedProviderKind").textContent = agentProviderKindLabel(selectedProvider.kind);
    $("#agentLlmSelectedProviderStatus").textContent = readiness.label;
    $("#agentLlmSelectedProviderStatus").className = `agent-llm-status-badge ${readiness.state}`;
    renderAgentProviderForm();
  }
  const modelList = $("#agentLlmModelList");
  modelList.replaceChildren();
  if (!providerModels.length) {
    const empty = document.createElement("div");
    empty.className = "agent-llm-empty";
    empty.textContent = selectedProvider ? "No models for this provider yet." : "Choose a provider first.";
    modelList.append(empty);
  } else {
    for (const model of providerModels) {
      modelList.append(createAgentConnectionModelCard(
        model,
        settings,
        model.id === state.agentLlm.selectedModelEditorId,
      ));
    }
  }
  const result = state.agentLlm.lastTestResult;
  $("#agentLlmTestResult").className = `agent-llm-test-result${result ? ` ${result.status}` : " hidden"}`;
  $("#agentLlmTestResult").textContent = result
    ? (result.status === "ready"
      ? `Connection ready${result.latency_ms ? ` · ${result.latency_ms} ms` : ""}`
      : userFacingError(result.message, "The connection could not be verified. Review the provider settings and try again."))
    : "";
  $("#agentLlmAddModel").disabled = !selectedProvider;
  $("#agentLlmEditModel").disabled = !selectedModel;
  $("#agentLlmSelectDefault").disabled = !selectedModel || !selectedModel.enabled;
  $("#agentLlmSaveCredential").disabled = !selectedProvider?.api_key_required
    || selectedProvider?.credential_status === "unavailable";
  $("#agentLlmTestModel").disabled = !selectedModel || agentModelType(selectedModel) !== "language" || state.agentLlm.testInFlight;
  $("#agentLlmCancelTest").disabled = !state.agentLlm.testInFlight;
  $("#agentLlmCancelTest").classList.toggle("hidden", !state.agentLlm.testInFlight);
  renderAgentLlmRouting(settings);
  renderAgentLlmLibrary(settings);
  switchAgentLlmView(state.agentLlm.activeView);
  renderAgentLlmOperationStatus();
}

function openAgentLlmDialog() {
  if (!state.agentLlm.settingsOpen) {
    state.agentLlm.returnFocusElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  }
  state.agentLlm.settingsOpen = true;
  const retryFailedRead = Boolean(state.agentLlm.settings?.validation_error);
  if (retryFailedRead || !(state.agentLlm.settings?.providers || []).length) {
    state.agentLlm.activeView = "connections";
  }
  clearAgentLlmCredentialInput();
  setAgentLlmMainDialogInert(false);
  labelAgentLlmModal();
  $("#agentLlmProviderAdvanced").open = false;
  setAgentLlmOperationState("idle");
  renderAgentLlmDialog();
  $("#agentLlmDialog").classList.remove("hidden");
  requestAnimationFrame(() => $("#agentLlmClose").focus());
  if (retryFailedRead) void retryAgentLlmSettings();
}

function closeAgentLlmDialog() {
  if (!state.agentLlm.settingsOpen && $("#agentLlmDialog").classList.contains("hidden")) return;
  const returnFocus = state.agentLlm.returnFocusElement;
  state.agentLlm.settingsOpen = false;
  state.agentLlm.returnFocusElement = null;
  clearAgentLlmCredentialInput();
  closeAgentLlmProviderWizard();
  closeAgentLlmModelDialog();
  $("#agentLlmDialog").classList.add("hidden");
  requestAnimationFrame(() => {
    if (returnFocus?.isConnected && !returnFocus.closest("[inert]")) returnFocus.focus();
    else $("#agentModelSelector").focus();
  });
}

function applyAgentLlmView(view) {
  state.agentLlm.settings = view || emptyAgentLlmSettings("Agent LLM settings are unavailable.");
  state.agentLlm.selectedModelId = state.agentLlm.settings.selected_model_id || null;
  ensureAgentLlmSelectionState();
  updateAgentHeader();
  renderAgentLlmDialog();
  renderProblems();
}

function clearAgentProviderForm() {
  clearAgentLlmCredentialInput();
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
  renderAgentCredentialFields();
}

function clearAgentModelForm() {
  clearAgentLlmCredentialInput();
  state.agentLlm.editingModelId = null;
  $("#agentLlmModelDisplayName").value = "";
  $("#agentLlmModelProvider").value = state.agentLlm.settings?.providers?.[0]?.id || "";
  $("#agentLlmModelId").value = "";
  $("#agentLlmModelType").value = "language";
  $("#agentLlmModelToolCalling").value = "unknown";
  $("#agentLlmModelReasoning").value = "unknown";
  $("#agentLlmModelVisionInput").value = "unknown";
  for (const selector of [
    "#agentLlmModelImageOutput",
    "#agentLlmModelImageEdit",
    "#agentLlmModelAudioInput",
    "#agentLlmModelAudioOutput",
    "#agentLlmModelStructuredOutput",
    "#agentLlmModelWebSearch",
  ]) $(selector).value = "unknown";
  $("#agentLlmModelEnabled").checked = true;
  state.agentLlm.lastTestResult = null;
  $("#agentLlmTestResult").className = "agent-llm-test-result hidden";
  $("#agentLlmTestResult").textContent = "";
}

function readAgentProviderForm() {
  const settings = state.agentLlm.settings || emptyAgentLlmSettings("Agent LLM settings are unavailable.");
  const displayName = $("#agentLlmProviderDisplayName").value.trim();
  const ids = settings.providers.map((provider) => provider.id);
  const literalBaseUrl = $("#agentLlmProviderBaseUrl").value.trim() || null;
  return {
    id: state.agentLlm.editingProviderId || uniqueAgentId("provider", displayName || "provider", ids),
    display_name: displayName,
    kind: $("#agentLlmProviderKind").value,
    registered_provider_id: $("#agentLlmRegisteredProviderId").value.trim() || null,
    api_key_env: $("#agentLlmProviderApiKeyEnv").value.trim() || null,
    api_key_required: $("#agentLlmProviderApiKeyRequired").checked,
    base_url: literalBaseUrl,
    base_url_env: literalBaseUrl ? null : ($("#agentLlmProviderBaseUrlEnv").value.trim() || null),
    wire_api: $("#agentLlmProviderWireApi").value || null,
    disable_stream_options: $("#agentLlmProviderDisableStreamOptions").checked ? true : null,
  };
}

function readAgentModelForm() {
  const settings = state.agentLlm.settings || emptyAgentLlmSettings("Agent LLM settings are unavailable.");
  const displayName = $("#agentLlmModelDisplayName").value.trim();
  const ids = settings.models.map((model) => model.id);
  const existing = settings.models.find((model) => model.id === state.agentLlm.editingModelId) || null;
  const discovery = state.agentLlm.modelDiscovery.models.find((model) => model.id === $("#agentLlmModelId").value.trim()) || null;
  const sourceModel = existing || discovery;
  const evidenceValue = (name, value) => {
    const source = sourceModel?.capabilities?.[name];
    return source?.value === value ? structuredClone(source) : agentCapability(value, "user_declared");
  };
  const capabilities = {
    function_call: evidenceValue("function_call", $("#agentLlmModelToolCalling").value),
    reasoning: evidenceValue("reasoning", $("#agentLlmModelReasoning").value),
    vision_input: evidenceValue("vision_input", $("#agentLlmModelVisionInput").value),
    image_output: evidenceValue("image_output", $("#agentLlmModelImageOutput").value),
    image_edit: evidenceValue("image_edit", $("#agentLlmModelImageEdit").value),
    audio_input: evidenceValue("audio_input", $("#agentLlmModelAudioInput").value),
    audio_output: evidenceValue("audio_output", $("#agentLlmModelAudioOutput").value),
    structured_output: evidenceValue("structured_output", $("#agentLlmModelStructuredOutput").value),
    web_search: evidenceValue("web_search", $("#agentLlmModelWebSearch").value),
  };
  const modelType = $("#agentLlmModelType").value;
  return {
    id: state.agentLlm.editingModelId || uniqueAgentId("model", displayName || "model", ids),
    provider_id: $("#agentLlmModelProvider").value,
    display_name: displayName,
    model_id: $("#agentLlmModelId").value.trim(),
    enabled: $("#agentLlmModelEnabled").checked,
    model_type: sourceModel?.model_type?.value === modelType
      ? structuredClone(sourceModel.model_type)
      : agentCapability(modelType, "user_declared"),
    capabilities,
    last_test: state.agentLlm.settings?.models?.find((model) => model.id === state.agentLlm.editingModelId)?.last_test || null,
  };
}

function wizardProviderPreset(kind) {
  return AGENT_PROVIDER_PRESETS[kind] || AGENT_PROVIDER_PRESETS.openai_compatible;
}

function wizardApiKeyEnvironment(displayName, preset) {
  if (preset.apiKeyEnv) return preset.apiKeyEnv;
  const stem = String(displayName || "CUSTOM")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "CUSTOM";
  return `RHO_${stem}_API_KEY`;
}

function renderAgentProviderPresetGrid() {
  const grid = $("#agentLlmWizardProviderGrid");
  if (!grid) return;
  const selected = $("#agentLlmWizardProviderKind").value;
  grid.replaceChildren();
  for (const [id, preset] of Object.entries(AGENT_PROVIDER_PRESETS)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `agent-llm-provider-preset${id === selected ? " active" : ""}`;
    button.dataset.providerPreset = id;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(id === selected));
    const title = document.createElement("strong");
    title.textContent = preset.displayName;
    const description = document.createElement("span");
    description.textContent = preset.description;
    const endpoint = document.createElement("small");
    endpoint.textContent = preset.defaultBaseUrl ? "Managed default endpoint" : "Custom endpoint required";
    button.append(title, description, endpoint);
    grid.append(button);
  }
}

function syncAgentLlmWizardProviderFields({ resetName = false } = {}) {
  const kind = $("#agentLlmWizardProviderKind").value;
  const preset = wizardProviderPreset(kind);
  const compatible = ["openai_compatible", "local_openai_compatible"].includes(kind);
  if (resetName || !$("#agentLlmWizardProviderName").value.trim()) {
    $("#agentLlmWizardProviderName").value = preset.displayName;
  }
  if (resetName) $("#agentLlmWizardApiKeyRequired").checked = preset.keyRequired;
  $("#agentLlmWizardBaseUrlField").classList.remove("hidden");
  $("#agentLlmWizardBaseUrl").placeholder = preset.defaultBaseUrl || "https://api.example.com/v1";
  $("#agentLlmWizardBaseUrlHint").textContent = compatible
    ? "Required for a custom Provider because it has no managed default."
    : `Optional. Leave blank to use ${preset.defaultBaseUrl}.`;
  $("#agentLlmWizardCredentialField").classList.toggle("hidden", !$("#agentLlmWizardApiKeyRequired").checked);
  if (resetName || !$("#agentLlmWizardApiFormat").value) $("#agentLlmWizardApiFormat").value = preset.wireApi || "";
  renderAgentProviderPresetGrid();
}

function refreshAgentLlmWizardAccessibility(step) {
  if (!step || $("#agentLlmProviderWizard").classList.contains("hidden")) return;
  const surface = $("#agentLlmProviderWizard").querySelector(":scope > .agent-llm-subdialog-surface");
  const fieldState = new Map(Array.from(surface.querySelectorAll("input[id], select[id]")).map((field) => [
    field.id,
    { value: field.value, checked: field instanceof HTMLInputElement ? field.checked : null },
  ]));
  const replacement = surface.cloneNode(true);
  surface.replaceWith(replacement);
  for (const [id, value] of fieldState) {
    const field = replacement.querySelector(`#${CSS.escape(id)}`);
    if (!field) continue;
    field.value = value.value;
    if (field instanceof HTMLInputElement && value.checked !== null) field.checked = value.checked;
  }
}

function renderAgentLlmWizardStep() {
  const connection = state.agentLlm.wizardStep === "connection";
  const connectionStep = $("#agentLlmWizardStepConnection");
  const modelStep = $("#agentLlmWizardStepModel");
  connectionStep.classList.toggle("hidden", !connection);
  modelStep.classList.toggle("hidden", connection);
  $("#agentLlmWizardConnectionIndicator").classList.toggle("active", connection);
  $("#agentLlmWizardModelIndicator").classList.toggle("active", !connection);
  $("#agentLlmWizardConnectionIndicator").setAttribute("aria-current", connection ? "step" : "false");
  $("#agentLlmWizardModelIndicator").setAttribute("aria-current", connection ? "false" : "step");
  renderAgentLlmOperationStatus("wizard");
  refreshAgentLlmWizardAccessibility(connection ? connectionStep : modelStep);
}

function setAgentLlmMainDialogInert(inert) {
  const root = $("#agentLlmDialog");
  root.classList.toggle("agent-llm-parent-suspended", inert);
  root.removeAttribute("aria-hidden");
}

function labelAgentLlmModal(titleId = "agentLlmDialogTitle") {
  const root = $("#agentLlmDialog");
  const children = [
    [$("#agentLlmProviderWizard"), "agentLlmWizardTitle"],
    [$("#agentLlmModelDialog"), "agentLlmModelDialogTitle"],
  ];
  for (const [child] of children) {
    child.removeAttribute("role");
    child.removeAttribute("aria-modal");
    child.removeAttribute("aria-labelledby");
  }
  if (titleId === "agentLlmDialogTitle") {
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", titleId);
    return;
  }
  const active = children.find(([, childTitleId]) => childTitleId === titleId)?.[0];
  active?.setAttribute("role", "dialog");
  active?.setAttribute("aria-modal", "true");
  active?.setAttribute("aria-labelledby", titleId);
}

function trapAgentLlmDialogFocus(event, dialog, closeDialog) {
  if (dialog.classList.contains("hidden")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeDialog();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = Array.from(dialog.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), details > summary, [tabindex]:not([tabindex="-1"])'
  )).filter((element) => {
    const style = window.getComputedStyle(element);
    return element.getClientRects().length > 0
      && style.display !== "none"
      && style.visibility !== "hidden"
      && !element.closest("[inert]");
  });
  if (!focusable.length) return;
  const activeIndex = focusable.indexOf(document.activeElement);
  const nextIndex = activeIndex < 0
    ? (event.shiftKey ? focusable.length - 1 : 0)
    : (activeIndex + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
  event.preventDefault();
  focusable[nextIndex].focus();
}

function readAgentLlmWizardProvider() {
  const settings = state.agentLlm.settings || emptyAgentLlmSettings("Agent LLM settings are unavailable.");
  const choice = $("#agentLlmWizardProviderKind").value;
  const preset = wizardProviderPreset(choice);
  const displayName = $("#agentLlmWizardProviderName").value.trim();
  const ids = settings.providers.map((provider) => provider.id);
  return {
    id: state.agentLlm.wizardProviderId || uniqueAgentId("provider", displayName || choice, ids),
    display_name: displayName,
    kind: preset.kind,
    registered_provider_id: preset.registeredProviderId,
    api_key_env: $("#agentLlmWizardApiKeyRequired").checked ? wizardApiKeyEnvironment(displayName, preset) : null,
    api_key_required: $("#agentLlmWizardApiKeyRequired").checked,
    base_url: $("#agentLlmWizardBaseUrl").value.trim() || null,
    base_url_env: null,
    wire_api: $("#agentLlmWizardApiFormat").value || preset.wireApi || null,
    disable_stream_options: null,
  };
}

function openAgentLlmProviderWizard() {
  state.agentLlm.wizardReturnFocusElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  state.agentLlm.wizardOpen = true;
  state.agentLlm.wizardStep = "connection";
  state.agentLlm.wizardProviderId = null;
  state.agentLlm.wizardModelId = null;
  state.agentLlm.wizardOperation = { state: "idle", message: "" };
  $("#agentLlmWizardProviderKind").value = "deepseek";
  $("#agentLlmWizardProviderName").value = "";
  $("#agentLlmWizardBaseUrl").value = "";
  $("#agentLlmWizardApiFormat").value = "";
  $("#agentLlmWizardApiKeyRequired").checked = true;
  $("#agentLlmWizardModelId").value = "";
  $("#agentLlmWizardModelName").value = "";
  $("#agentLlmWizardModelEnabled").checked = true;
  $("#agentLlmWizardModelType").value = "language";
  $("#agentLlmWizardModelToolCalling").value = "unknown";
  $("#agentLlmWizardModelReasoning").value = "unknown";
  $("#agentLlmWizardModelVisionInput").value = "unknown";
  for (const selector of [
    "#agentLlmWizardModelImageOutput",
    "#agentLlmWizardModelImageEdit",
    "#agentLlmWizardModelAudioInput",
    "#agentLlmWizardModelAudioOutput",
    "#agentLlmWizardModelStructuredOutput",
    "#agentLlmWizardModelWebSearch",
  ]) $(selector).value = "unknown";
  $("#agentLlmWizardManualModel").open = false;
  resetAgentLlmDiscovery("wizard", null);
  clearAgentLlmCredentialInput();
  syncAgentLlmWizardProviderFields({ resetName: true });
  setAgentLlmMainDialogInert(true);
  $("#agentLlmProviderWizard").classList.remove("hidden");
  renderAgentLlmWizardStep();
  labelAgentLlmModal("agentLlmWizardTitle");
  $("#agentLlmWizardProviderGrid [aria-checked=\"true\"]")?.focus();
}

function closeAgentLlmProviderWizard() {
  const returnFocus = state.agentLlm.wizardReturnFocusElement;
  state.agentLlm.wizardReturnFocusElement = null;
  state.agentLlm.wizardOpen = false;
  resetAgentLlmDiscovery("wizard", null);
  clearAgentLlmCredentialInput();
  $("#agentLlmProviderWizard").classList.add("hidden");
  if (!state.agentLlm.modelDialogOpen) {
    labelAgentLlmModal();
    setAgentLlmMainDialogInert(false);
  }
  requestAnimationFrame(() => {
    if (!state.agentLlm.settingsOpen) return;
    if (returnFocus?.isConnected && returnFocus.getClientRects().length && !returnFocus.closest("[inert], .hidden")) {
      returnFocus.focus();
    } else {
      $(`[data-agent-llm-view="${state.agentLlm.activeView}"]`)?.focus();
    }
  });
}

async function advanceAgentLlmProviderWizard() {
  const provider = readAgentLlmWizardProvider();
  const credential = $("#agentLlmWizardCredential").value;
  const savedProvider = state.agentLlm.settings?.providers?.find((item) => item.id === state.agentLlm.wizardProviderId) || null;
  const hasStoredCredential = savedProvider?.credential_status === "detected" && savedProvider?.credential_source === "system";
  if (!provider.display_name) {
    clearAgentLlmCredentialInput();
    setAgentLlmOperationState("warning", "Enter a provider name before continuing.", "wizard");
    $("#agentLlmWizardProviderName").focus();
    return;
  }
  if (["openai_compatible", "local_openai_compatible"].includes(provider.kind) && !provider.base_url) {
    clearAgentLlmCredentialInput();
    setAgentLlmOperationState("warning", "Enter the provider Base URL before continuing.", "wizard");
    $("#agentLlmWizardBaseUrl").focus();
    return;
  }
  if (provider.api_key_required && !credential && !hasStoredCredential) {
    setAgentLlmOperationState("warning", "Enter an API key, or turn off API key required, before continuing.", "wizard");
    $("#agentLlmWizardCredential").focus();
    return;
  }
  setAgentLlmOperationState("working", "Saving provider connection…", "wizard");
  try {
    let view = await invoke("agent_llm_save_provider", { provider });
    state.agentLlm.wizardProviderId = provider.id;
    state.agentLlm.selectedProviderId = provider.id;
    state.agentLlm.editingProviderId = provider.id;
    applyAgentLlmView(view);
    if (provider.api_key_required && credential) {
      try {
        view = await invoke("agent_llm_set_credential", { providerId: provider.id, credential });
        applyAgentLlmView(view);
      } catch (error) {
        clearAgentLlmCredentialInput();
        setAgentLlmOperationState("warning", `Provider saved; API key not stored. ${userFacingError(error, "Try storing the key again.")}`, "wizard");
        return;
      }
    }
    state.agentLlm.wizardStep = "model";
    resetAgentLlmDiscovery("wizard", provider.id);
    setAgentLlmOperationState("success", "Connection saved. Fetching this Provider's available models...", "wizard");
    renderAgentLlmWizardStep();
    $("#agentLlmWizardDiscoveryStatus").focus();
    void discoverAgentLlmModels(provider.id, "wizard");
  } catch (error) {
    setAgentLlmOperationState("error", reportUiFailure("save model provider", error, "The provider could not be saved. Review the connection fields and try again."), "wizard");
  } finally {
    clearAgentLlmCredentialInput();
  }
}

async function finishAgentLlmProviderWizard() {
  const providerId = state.agentLlm.wizardProviderId;
  const modelId = $("#agentLlmWizardModelId").value.trim();
  const displayName = $("#agentLlmWizardModelName").value.trim() || modelId;
  if (!providerId) {
    setAgentLlmOperationState("error", "Save the provider connection before adding a model.", "wizard");
    return;
  }
  if (!modelId) {
    const discovery = state.agentLlm.wizardDiscovery;
    setAgentLlmOperationState("warning", "Choose an available model, or enter a model ID manually, before finishing.", "wizard");
    if (discovery.status === "ready" && discovery.models.length) {
      $("#agentLlmWizardDiscoveredModelCards button")?.focus();
    } else {
      $("#agentLlmWizardManualModel").open = true;
      $("#agentLlmWizardModelId").focus();
    }
    return;
  }
  if (!state.agentLlm.wizardModelId) {
    state.agentLlm.wizardModelId = uniqueAgentId(
      "model",
      displayName || modelId,
      (state.agentLlm.settings?.models || []).map((model) => model.id),
    );
  }
  const discovered = state.agentLlm.wizardDiscovery.models.find(
    (item) => item.id === $("#agentLlmWizardDiscoveredModel").value && item.id === modelId,
  );
  const wizardCapability = (name, value) => {
    const evidence = discovered?.capabilities?.[name];
    return evidence?.value === value ? structuredClone(evidence) : agentCapability(value, "user_declared");
  };
  const capabilities = emptyAgentCapabilities();
  capabilities.function_call = wizardCapability("function_call", $("#agentLlmWizardModelToolCalling").value);
  capabilities.reasoning = wizardCapability("reasoning", $("#agentLlmWizardModelReasoning").value);
  capabilities.vision_input = wizardCapability("vision_input", $("#agentLlmWizardModelVisionInput").value);
  capabilities.image_output = wizardCapability("image_output", $("#agentLlmWizardModelImageOutput").value);
  capabilities.image_edit = wizardCapability("image_edit", $("#agentLlmWizardModelImageEdit").value);
  capabilities.audio_input = wizardCapability("audio_input", $("#agentLlmWizardModelAudioInput").value);
  capabilities.audio_output = wizardCapability("audio_output", $("#agentLlmWizardModelAudioOutput").value);
  capabilities.structured_output = wizardCapability("structured_output", $("#agentLlmWizardModelStructuredOutput").value);
  capabilities.web_search = wizardCapability("web_search", $("#agentLlmWizardModelWebSearch").value);
  const modelType = $("#agentLlmWizardModelType").value;
  const model = {
    id: state.agentLlm.wizardModelId,
    provider_id: providerId,
    display_name: displayName,
    model_id: modelId,
    enabled: $("#agentLlmWizardModelEnabled").checked,
    model_type: discovered?.model_type?.value === modelType
      ? structuredClone(discovered.model_type)
      : agentCapability(modelType, "user_declared"),
    capabilities,
    last_test: null,
  };
  setAgentLlmOperationState("working", "Saving model…", "wizard");
  let savedView;
  try {
    savedView = await invoke("agent_llm_save_model", { model });
    state.agentLlm.selectedModelEditorId = model.id;
    applyAgentLlmView(savedView);
  } catch (error) {
    setAgentLlmOperationState("warning", `Provider saved; model not saved. ${userFacingError(error, "Review the model fields and try again.")}`, "wizard");
    return;
  }
  closeAgentLlmProviderWizard();
  state.agentLlm.activeView = "routing";
  setAgentLlmOperationState("success", `${displayName} is saved. Assign it to a capability route when needed.`);
  renderAgentLlmDialog();
}

function finishAgentLlmProviderWizardLater() {
  const provider = currentProviderRecord();
  closeAgentLlmProviderWizard();
  setAgentLlmOperationState("warning", `${provider?.display_name || "Provider"} was saved without a model. Add a model when you are ready.`);
  renderAgentLlmDialog();
}

function openAgentLlmModelDialog(modelId = null) {
  state.agentLlm.modelReturnFocusElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  clearAgentLlmCredentialInput();
  state.agentLlm.modelDialogOpen = true;
  state.agentLlm.editingModelId = modelId;
  state.agentLlm.modelOperation = { state: "idle", message: "" };
  const model = state.agentLlm.settings?.models?.find((item) => item.id === modelId) || null;
  const providerId = model?.provider_id || state.agentLlm.selectedProviderId || state.agentLlm.settings?.providers?.[0]?.id || null;
  resetAgentLlmDiscovery("model", providerId);
  renderAgentModelForm();
  $("#agentLlmModelDialogTitle").textContent = modelId ? "Edit model" : "Add model";
  $("#agentLlmModelDanger").classList.toggle("hidden", !modelId);
  renderAgentLlmOperationStatus("model");
  setAgentLlmMainDialogInert(true);
  $("#agentLlmModelDialog").classList.remove("hidden");
  labelAgentLlmModal("agentLlmModelDialogTitle");
  if (modelId) {
    $("#agentLlmModelId").focus();
  } else {
    $("#agentLlmModelDiscoveryStatus").focus();
    void discoverAgentLlmModels(providerId, "model");
  }
}

function closeAgentLlmModelDialog() {
  const returnFocus = state.agentLlm.modelReturnFocusElement;
  state.agentLlm.modelReturnFocusElement = null;
  state.agentLlm.modelDialogOpen = false;
  resetAgentLlmDiscovery("model", null);
  state.agentLlm.editingModelId = state.agentLlm.selectedModelEditorId;
  $("#agentLlmModelDialog").classList.add("hidden");
  if (!state.agentLlm.wizardOpen) {
    labelAgentLlmModal();
    setAgentLlmMainDialogInert(false);
  }
  requestAnimationFrame(() => {
    if (!state.agentLlm.settingsOpen) return;
    if (returnFocus?.isConnected && returnFocus.getClientRects().length && !returnFocus.closest("[inert], .hidden")) {
      returnFocus.focus();
    } else {
      $(`[data-agent-llm-view="${state.agentLlm.activeView}"]`)?.focus();
    }
  });
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
  if (!document.execCommand("copy")) throw new Error("Clipboard access was unavailable.");
  input.remove();
}

async function saveAgentProvider() {
  const provider = readAgentProviderForm();
  provider.display_name = provider.display_name || agentProviderKindLabel(provider.kind);
  setAgentLlmOperationState("working", "Saving provider details…");
  try {
    const view = await invoke("agent_llm_save_provider", { provider });
    state.agentLlm.selectedProviderId = provider.id;
    state.agentLlm.editingProviderId = provider.id;
    applyAgentLlmView(view);
    setAgentLlmOperationState("success", `Saved provider ${provider.display_name || provider.id}.`);
  } catch (error) {
    setAgentLlmOperationState("error", reportUiFailure("save model provider", error, "The provider could not be saved. Review the connection settings and try again."));
  } finally {
    clearAgentLlmCredentialInput();
  }
}

async function deleteAgentProvider() {
  clearAgentLlmCredentialInput();
  const provider = currentProviderRecord();
  if (!provider) {
    toast("Select a provider to delete.", true);
    return;
  }
  if (!await confirmAction({
    title: "Delete provider",
    message: `Delete provider ${provider.display_name}? Its models must be removed first.`,
    confirmLabel: "Delete provider",
    destructive: true,
  })) return;
  setAgentLlmOperationState("working", `Deleting ${provider.display_name}…`);
  try {
    const view = await invoke("agent_llm_delete_provider", { providerId: provider.id });
    state.agentLlm.selectedProviderId = view.providers[0]?.id || null;
    state.agentLlm.editingProviderId = state.agentLlm.selectedProviderId;
    applyAgentLlmView(view);
    setAgentLlmOperationState("success", `Deleted provider ${provider.display_name}.`);
  } catch (error) {
    setAgentLlmOperationState("error", reportUiFailure("delete model provider", error, "The provider could not be deleted. Remove its models first, then try again."));
  }
}

async function saveAgentModel() {
  const model = readAgentModelForm();
  const existing = state.agentLlm.settings?.models?.find((item) => item.id === model.id) || null;
  model.display_name = model.display_name || model.model_id;
  if (!model.provider_id || !model.model_id) {
    setAgentLlmOperationState("warning", "Choose an available model, or enter a model ID manually, before saving.", "model");
    if (state.agentLlm.modelDiscovery.status === "ready" && state.agentLlm.modelDiscovery.models.length) {
      $("#agentLlmModelDiscoveredModelCards button")?.focus();
    } else {
      $("#agentLlmModelManualFields").open = true;
      $("#agentLlmModelId").focus();
    }
    return;
  }
  setAgentLlmOperationState("working", "Saving model…", "model");
  try {
    let view = state.agentLlm.settings;
    if (!existing) {
      view = await invoke("agent_llm_save_model", { model });
    } else {
      const metadataModel = {
        ...model,
        model_type: structuredClone(existing.model_type),
        capabilities: structuredClone(existing.capabilities),
        last_test: existing.last_test || null,
      };
      const metadataChanged = ["provider_id", "display_name", "model_id", "enabled"]
        .some((name) => metadataModel[name] !== existing[name]);
      if (metadataChanged) view = await invoke("agent_llm_save_model", { model: metadataModel });
      const patch = {
        model_type: model.model_type.value !== existing.model_type.value ? model.model_type.value : null,
        capabilities: Object.fromEntries(AGENT_MODEL_CAPABILITIES
          .filter((name) => model.capabilities[name].value !== existing.capabilities[name].value)
          .map((name) => [name, model.capabilities[name].value])),
      };
      if (patch.model_type || Object.keys(patch.capabilities).length) {
        try {
          view = await invoke("agent_llm_declare_model_capabilities", {
            expectedRevision: view.revision,
            modelId: model.id,
            patch,
          });
        } catch (error) {
          applyAgentLlmView(view);
          setAgentLlmOperationState("warning", `Model details were saved, but capability evidence was not changed. ${userFacingError(error, "Reload and review the model again.")}`, "model");
          return;
        }
      }
    }
    state.agentLlm.selectedProviderId = model.provider_id;
    state.agentLlm.selectedModelEditorId = model.id;
    state.agentLlm.editingModelId = model.id;
    applyAgentLlmView(view);
    closeAgentLlmModelDialog();
    setAgentLlmOperationState("success", `Saved model ${model.display_name || model.id}.`);
    renderAgentLlmDialog();
  } catch (error) {
    setAgentLlmOperationState("error", reportUiFailure("save model", error, "The model could not be saved. Review its provider and settings and try again."), "model");
  }
}

async function saveAgentLlmCredential() {
  const provider = currentProviderRecord();
  const credential = $("#agentLlmCredential").value;
  if (!provider?.api_key_required) {
    setAgentLlmOperationState("warning", "The selected provider does not require an API key.");
    clearAgentLlmCredentialInput();
    return;
  }
  if (!credential) {
    setAgentLlmOperationState("warning", "Enter a new API key before saving. The existing stored key was not changed.");
    return;
  }
  setAgentLlmOperationState("working", `Saving the API key for ${provider.display_name}…`);
  try {
    const view = await invoke("agent_llm_set_credential", { providerId: provider.id, credential });
    applyAgentLlmView(view);
    setAgentLlmOperationState("success", `API key stored securely for ${provider.display_name}.`);
  } catch (error) {
    setAgentLlmOperationState("error", reportUiFailure("save API key", error,
      "The API key could not be stored. The provider and model settings were not changed."));
  } finally {
    clearAgentLlmCredentialInput();
  }
}

async function deleteAgentLlmCredential() {
  clearAgentLlmCredentialInput();
  const provider = currentProviderRecord();
  if (!provider || provider.credential_source !== "system") return;
  if (!await confirmAction({
    title: "Remove stored API key",
    message: `Remove the API key stored for ${provider.display_name}?`,
    confirmLabel: "Remove key",
    destructive: true,
  })) return;
  setAgentLlmOperationState("working", `Removing the stored API key for ${provider.display_name}…`);
  try {
    applyAgentLlmView(await invoke("agent_llm_delete_credential", { providerId: provider.id }));
    setAgentLlmOperationState("success", "Stored API key removed.");
  } catch (error) {
    setAgentLlmOperationState("error", reportUiFailure("remove stored API key", error,
      "The stored API key could not be removed. Try again."));
  } finally {
    clearAgentLlmCredentialInput();
  }
}

async function deleteAgentModel() {
  const model = currentModelRecord();
  if (!model) {
    toast("Select a model to delete.", true);
    return;
  }
  if (!await confirmAction({
    title: "Delete model",
    message: `Delete model ${model.display_name}?`,
    confirmLabel: "Delete model",
    destructive: true,
  })) return;
  setAgentLlmOperationState("working", `Deleting ${model.display_name}…`, "model");
  try {
    const view = await invoke("agent_llm_delete_model", {
      request: {
        model_id: model.id,
        replacement_model_id: null,
      },
    });
    state.agentLlm.selectedModelEditorId = view.selected_model_id || view.models[0]?.id || null;
    state.agentLlm.editingModelId = state.agentLlm.selectedModelEditorId;
    state.agentLlm.lastTestResult = null;
    applyAgentLlmView(view);
    closeAgentLlmModelDialog();
    setAgentLlmOperationState("success", `Deleted model ${model.display_name}.`);
    renderAgentLlmDialog();
  } catch (error) {
    setAgentLlmOperationState("error", reportUiFailure("delete model", error, "The model could not be deleted. Reassign or remove every route that uses it, then try again."), "model");
  }
}

async function selectAgentDefaultModel() {
  clearAgentLlmCredentialInput();
  const model = currentModelRecord();
  if (!model) {
    setAgentLlmOperationState("warning", "Select a model to use for the next Agent turn.");
    return;
  }
  setAgentLlmOperationState("working", `Selecting ${model.display_name}…`);
  try {
    const view = await invoke("agent_llm_select_model", {
      request: { modelId: model.id, expectedRevision: state.agentLlm.settings.revision },
    });
    applyAgentLlmView(view);
    setAgentLlmOperationState("success", `${model.display_name} is assigned to Chat.`);
  } catch (error) {
    if (isStaleInformationError(error)) {
      await loadAgentLlmSettings();
      setAgentLlmOperationState("warning", "Model settings changed. The latest revision was loaded; review Chat and try again.");
    } else {
      setAgentLlmOperationState("error", reportUiFailure("assign Chat route", error, "Chat was not changed. Review model compatibility and try again."));
    }
  }
}

async function testAgentModelConnection() {
  clearAgentLlmCredentialInput();
  const model = currentModelRecord();
  if (!model) {
    setAgentLlmOperationState("warning", "Select a model to test.");
    return;
  }
  try {
    state.agentLlm.testInFlight = true;
    setAgentLlmOperationState("working", `Testing ${model.display_name}. This sends a small real provider request…`);
    renderAgentLlmDialog();
    $("#agentLlmTestResult").className = "agent-llm-test-result";
    $("#agentLlmTestResult").textContent = "Testing connection...";
    const view = await invoke("agent_llm_test_model", { modelId: model.id });
    state.agentLlm.lastTestResult = view.models.find((item) => item.id === model.id)?.last_test || null;
    applyAgentLlmView(view);
    const latency = state.agentLlm.lastTestResult?.latency_ms;
    setAgentLlmOperationState("success", `Connection ready${latency ? ` · ${latency} ms` : ""}.`);
  } catch (error) {
    const message = userFacingError(error, "The connection could not be verified. Review the provider settings and try again.");
    state.agentLlm.lastTestResult = {
      status: message.includes("cancelled") ? "warn" : "error",
      latency_ms: null,
      message: message.includes("cancelled") ? "Connection test cancelled." : message,
    };
    setAgentLlmOperationState(message.includes("cancelled") ? "warning" : "error", state.agentLlm.lastTestResult.message);
    renderAgentLlmDialog();
  } finally {
    state.agentLlm.testInFlight = false;
    renderAgentLlmDialog();
  }
}

async function cancelAgentModelTest() {
  if (!state.agentLlm.testInFlight) return;
  setAgentLlmOperationState("working", "Cancelling connection test…");
  try {
    await invoke("agent_llm_cancel_test");
    $("#agentLlmTestResult").className = "agent-llm-test-result";
    $("#agentLlmTestResult").textContent = "Cancelling connection test...";
  } catch (error) {
    setAgentLlmOperationState("error", reportUiFailure("cancel model test", error, "The connection test could not be stopped. Wait for it to finish, then try again."));
  }
}

function syncAgentPolling() {
  const shouldPoll = state.agentConversations.some((conversation) => ["running", "waiting"].includes(conversation.status))
    || state.pendingApprovals.length > 0;
  if (shouldPoll && !state.agentPollTimer) {
    state.agentPollTimer = window.setInterval(() => {
      loadAgentData({ quiet: true }).catch(() => {});
      loadRunData({ quiet: true }).catch(() => {});
    }, 1500);
  }
  if (!shouldPoll && state.agentPollTimer) {
    window.clearInterval(state.agentPollTimer);
    state.agentPollTimer = null;
  }
}

function renderAgentTimeline() {
  const panel = $("#agentTimeline");
  const viewport = capturePanelViewport(panel, "data-turn-id");
  panel.replaceChildren();
  if (!state.agentTurns.length) {
    if (state.agentRuntime && !state.agentRuntime.available) {
      addTimeline("Assistant unavailable", userFacingError(state.agentRuntime.error, "Retry the assistant connection when you are ready."), "error");
    } else if (state.selectedConversationId) {
      addTimeline("New conversation", "Describe the scientific goal to start this independent conversation.", "completed");
    } else {
      addTimeline("R session ready", "Ask Rho about the current project or attach a file for review.", "completed");
    }
    restorePanelViewport(panel, viewport, "data-turn-id");
    return;
  }
  for (const turn of state.agentTurns.slice(0, 8)) {
    const selected = state.selectedTurnId === turn.turn_id;
    const row = document.createElement("div");
    row.className = `timeline-item ${agentStatusTone(turn.status)} timeline-parent${selected ? " is-selected" : ""}`;
    row.dataset.turnId = turn.turn_id;
    const statusLabel = prettyAgentStatus(turn.status, turn.terminal_reason);
    const marker = createStateMarker(turn.status, statusLabel);
    marker.classList.add("timeline-marker");
    const content = document.createElement("div");
    const headingRow = document.createElement("div");
    headingRow.className = "timeline-heading-row";
    const heading = document.createElement("strong");
    heading.textContent = turn.prompt_preview;
    headingRow.append(heading, createStateChip(statusLabel, turn.status));
    const paragraph = document.createElement("p");
    paragraph.className = "timeline-meta technical-meta";
    paragraph.textContent = `${prettyAgentMode(turn.mode)} · ${agentModelDisplayName(turn.model)}`;
    content.append(headingRow, paragraph);
    const detail = truncateText(
      turn.error_message
        ? userFacingError(turn.error_message, "The Agent could not complete this task. Open it to review what happened.")
        : turn.final_message || "",
      140,
    );
    if (detail && !selected) {
      const detailLine = document.createElement("p");
      detailLine.textContent = detail;
      content.append(detailLine);
    }
    if (selected && turn.final_message) {
      const fullMessage = document.createElement("div");
      fullMessage.className = "timeline-final-message";
      const answerHeader = document.createElement("div");
      answerHeader.className = "timeline-final-message-header";
      const answerLabel = document.createElement("span");
      answerLabel.textContent = "Output";
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "timeline-copy-output";
      copyButton.title = "Copy output";
      copyButton.setAttribute("aria-label", "Copy output");
      const copyIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      copyIcon.classList.add("ui-icon");
      copyIcon.setAttribute("aria-hidden", "true");
      const copyUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
      copyUse.setAttribute("href", "#icon-copy");
      copyIcon.append(copyUse);
      copyButton.append(copyIcon, document.createTextNode("Copy"));
      copyButton.addEventListener("click", async (event) => {
        event.stopPropagation();
        try {
          await copyText(turn.final_message);
          copyButton.classList.add("is-copied");
          copyButton.lastChild.textContent = "Copied";
          window.setTimeout(() => {
            copyButton.classList.remove("is-copied");
            copyButton.lastChild.textContent = "Copy";
          }, 1600);
        } catch (error) {
          toast(reportUiFailure("copy Agent output", error, "The output could not be copied."), true);
        }
      });
      answerHeader.append(answerLabel, copyButton);
      const renderedMessage = document.createElement("article");
      renderedMessage.className = "timeline-markdown viewer-markdown";
      renderedMessage.innerHTML = viewerSafeMarkdown(turn.final_message);
      fullMessage.append(answerHeader, renderedMessage);
      content.append(fullMessage);
      appendAgentLocalHelpEvidence(content, state.selectedTurnDetail);
    }
    const events = selected && state.selectedTurnDetail?.events?.length
      ? state.selectedTurnDetail.events
      : [];
    if (events.length) {
      const activityExpanded = state.agentActivityExpanded.has(turn.turn_id);
      const activityButton = document.createElement("button");
      activityButton.type = "button";
      activityButton.className = "timeline-activity-toggle";
      activityButton.setAttribute("aria-expanded", String(activityExpanded));
      activityButton.textContent = `${activityExpanded ? "Hide" : "Show"} activity · ${events.length}`;
      activityButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (activityExpanded) state.agentActivityExpanded.delete(turn.turn_id);
        else state.agentActivityExpanded.add(turn.turn_id);
        renderAgentTimeline();
      });
      content.append(activityButton);
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
    if (state.agentActivityExpanded.has(turn.turn_id) && events.length) {
      for (const event of events) {
        const child = document.createElement("div");
        child.className = `timeline-item ${agentStatusTone(event.status)} timeline-child`;
        const childMarker = createStateMarker(event.status, prettyAgentStatus(event.status));
        childMarker.classList.add("timeline-marker");
        const childContent = document.createElement("div");
        const childHeading = document.createElement("strong");
        childHeading.textContent = agentTimelineEventTitle(event);
        childContent.append(childHeading);
        const body = agentTimelineEventBody(event);
        if (body) {
          const runResult = event.event_type === "tool.call_completed" && event.tool === "run_r";
          const childBody = document.createElement(runResult ? "pre" : "p");
          if (runResult) childBody.className = "timeline-result";
          childBody.textContent = body;
          childContent.append(childBody);
        }
        if (event.code && !(event.event_type === "tool.call_completed" && event.tool === "run_r")) {
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
  restorePanelViewport(panel, viewport, "data-turn-id");
}

function renderTaskRail() {
  const list = $("#taskRailList");
  const viewport = capturePanelViewport(list, "data-conversation-id");
  list.replaceChildren();

  const conversations = state.agentConversations.slice(0, 50);
  const header = document.querySelector(".task-rail-header span");
  if (header) header.textContent = `Conversations (${state.agentConversations.length})`;
  $("#taskRailNew").disabled = false;
  if (!conversations.length) {
    const empty = document.createElement("div");
    empty.className = "task-rail-empty";
    const heading = document.createElement("strong");
    heading.textContent = "Start a task";
    const description = document.createElement("p");
    description.textContent = "Describe the scientific goal, then review the work beside your source.";
    const start = document.createElement("button");
    start.type = "button";
    start.textContent = "Ask Rho";
    start.addEventListener("click", startNewAgentTask);
    empty.append(heading, description, start);
    list.append(empty);
    restorePanelViewport(list, viewport, "data-conversation-id");
    syncAgentWorkSurfaceLayout();
    return;
  }

  for (const conversation of conversations) {
    const active = state.selectedConversationId === conversation.conversation_id;
    const modePresentation = taskRailModePresentation(conversation.latest_mode);
    const statusLabel = conversation.status === "empty"
      ? "Empty"
      : prettyAgentStatus(conversation.status, conversation.terminal_reason);
    const previewText = conversation.title || conversation.latest_prompt_preview || "(empty)";
    const item = document.createElement("button");
    item.type = "button";
    item.className = `task-rail-item${active ? " active" : ""}`;
    item.dataset.conversationId = conversation.conversation_id;
    item.dataset.turnId = conversation.latest_turn_id || "";
    item.setAttribute("aria-label", conversation.latest_mode
      ? `${modePresentation.label} mode, ${statusLabel} status: ${previewText}`
      : `${statusLabel} conversation: ${previewText}`);
    if (active) item.setAttribute("aria-current", "true");

    const status = createTaskRailStatusDot(conversation.status, conversation.terminal_reason);
    const modeIcon = conversation.latest_mode ? createTaskRailModeIcon(conversation.latest_mode) : null;

    const preview = document.createElement("span");
    preview.className = "task-rail-preview";
    preview.textContent = previewText;

    item.append(status);
    if (modeIcon) item.append(modeIcon);
    item.append(preview);
    item.addEventListener("click", async () => selectTaskConversation(conversation.conversation_id));
    list.append(item);
  }

  restorePanelViewport(list, viewport, "data-conversation-id");
  syncAgentWorkSurfaceLayout();
}

async function startNewAgentTask() {
  try {
    const conversation = await invoke("create_agent_conversation");
    state.selectedConversationId = conversation.conversation_id;
    state.selectedTurnId = null;
    state.selectedTurnDetail = null;
    await loadAgentData();
    $("#agentInput").focus();
  } catch (error) {
    toast(reportUiFailure("create Agent conversation", error, "A new conversation could not be created."), true);
  }
}

async function selectTaskConversation(conversationId) {
  state.selectedConversationId = conversationId;
  state.selectedTurnId = null;
  state.selectedTurnDetail = null;
  await loadAgentData();
}

$("#taskRailNew").addEventListener("click", startNewAgentTask);

function renderApprovalPanel() {
  const approval = state.pendingApprovals.find((item) => item.turn_id === state.selectedTurnId) || null;
  $("#approvalPanel").classList.toggle("hidden", !approval);
  $("#approvalPanel").dataset.state = approval ? "waiting" : "empty";
  if (!approval) {
    $("#approvalSummary").textContent = "Review the exact tool request before Workspace R changes.";
    $("#approvalRevision").textContent = "";
    $("#approvalCode").textContent = "";
    $("#approvalCode").classList.add("hidden");
    return;
  }
  const argumentsObject = parseApprovalArguments(approval.arguments_json);
  const toolLabel = agentToolLabel(approval.tool);
  $("#approvalPanelTitle").textContent = toolLabel;
  $("#approvalSummary").textContent = approval.tool === "run_r"
    ? "Rho wants to run this R code. Review it before continuing."
    : `Rho wants to ${toolLabel.toLowerCase()}. Review the request before continuing.`;
  const requestIsStale = approval.state_revision !== state.revision.state_revision
    || approval.project_revision !== state.revision.project_revision;
  $("#approvalRevision").textContent = requestIsStale
    ? "Workspace content changed after this request. Review the code again before deciding."
    : "This request matches the current workspace.";
  const code = approval.code || argumentsObject.code || "";
  $("#approvalCode").textContent = code || "";
  $("#approvalCode").classList.toggle("hidden", !code);
  const exactCodeMissing = approval.tool === "run_r" && !code;
  if (exactCodeMissing) {
    $("#approvalSummary").textContent = "The exact R code is unavailable. Refresh this task before deciding.";
  }
  $("#approvalApprove").textContent = approval.tool === "run_r" ? "Run this code" : `Approve ${toolLabel.toLowerCase()}`;
  $("#approvalApprove").disabled = exactCodeMissing;
  $("#approvalReject").textContent = approval.tool === "run_r" ? "Not now" : `Reject ${toolLabel.toLowerCase()}`;
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
    : (await promptForPath({
      title: decision === "cancel" ? "Cancel approval" : "Reject approval",
      message: decision === "cancel" ? "Provide a cancellation note (optional)." : "Provide a rejection reason (optional).",
      defaultValue: "",
    })) || null;
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
    toast(reportUiFailure("respond to Agent approval", error, "The decision could not be saved. Review the request and try again."), true);
  } finally {
    for (const id of ["approvalApprove", "approvalReject", "approvalCancel"]) {
      $(["#", id].join("")).disabled = false;
    }
  }
}

function renderRuns() {
  const panel = $("#runsPanel");
  panel.replaceChildren();

  // compare toggle header
  const header = document.createElement("div");
  header.className = "run-list-header";
  const label = document.createElement("span");
  label.className = "run-list-title";
  label.textContent = `Runs (${state.runs.length})`;
  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "compare-toggle" + (state.compareMode ? " active" : "");
  toggleBtn.textContent = state.compareMode ? "Exit Compare" : "Compare";
  toggleBtn.addEventListener("click", toggleCompareMode);
  header.append(label, toggleBtn);
  panel.append(header);

  if (!state.runs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-tree";
    empty.textContent = "No run records yet.";
    panel.append(empty);
    return;
  }

  // action row in compare mode
  if (state.compareMode && state.compareLeft && state.compareRight) {
    const actionRow = document.createElement("div");
    actionRow.className = "compare-action-row";
    const btn = document.createElement("button");
    btn.textContent = "Compare selected runs";
    btn.addEventListener("click", doCompareRuns);
    actionRow.append(btn);
    panel.append(actionRow);
  }

  for (const run of state.runs) {
    const row = document.createElement("div");
    row.className = "run-row";

    if (state.compareMode) {
      const select = document.createElement("span");
      select.className = "compare-select";
      const leftRadio = document.createElement("input");
      leftRadio.type = "radio";
      leftRadio.name = "compareLeft_" + run.run_id;
      leftRadio.checked = state.compareLeft === run.run_id;
      leftRadio.addEventListener("change", () => selectCompareSide("left", run.run_id));
      const rightRadio = document.createElement("input");
      rightRadio.type = "radio";
      rightRadio.name = "compareRight_" + run.run_id;
      rightRadio.checked = state.compareRight === run.run_id;
      rightRadio.addEventListener("change", () => selectCompareSide("right", run.run_id));
      select.append(
        Object.assign(document.createElement("label"), {textContent: "L", style: {cursor: "pointer"}}),
        leftRadio,
        Object.assign(document.createElement("label"), {textContent: "R", style: {cursor: "pointer"}}),
        rightRadio
      );
      row.append(select);
    }

    const marker = createStateMarker(run.status, prettyStatus(run.status));
    marker.classList.add("run-state");
    const runTone = runStatusTone(run.status);
    if (runTone) marker.classList.add(runTone);
    const content = document.createElement("span");
    const titleLine = document.createElement("span");
    titleLine.className = "run-title-line";
    const title = document.createElement("strong");
    title.textContent = runTitle(run);
    titleLine.append(title, createStateChip(prettyStatus(run.status), run.status));
    const detail = document.createElement("small");
    detail.className = "run-meta";
    detail.textContent = [prettyOrigin(run.origin), displayPath(run.source_path), formatTimestamp(run.started_at), run.error_message].filter(Boolean).join(" · ");
    content.append(titleLine, detail);
    row.append(marker, content);
    if (["queued", "running", "waiting"].includes(run.status)) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "run-action";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", async () => {
        try {
          await invoke("cancel_run", { runId: run.run_id });
          addLog("SYSTEM", "Stop requested for the selected R run.");
          await loadRunData();
        } catch (error) {
          toast(reportUiFailure("stop R run", error, "This R run could not be stopped. Check its current status and try again."), true);
        }
      });
      row.append(cancel);
    }
    panel.append(row);
  }

  // render comparison result if available
  if (state.compareResult) {
    renderCompareResult();
  }
}

function toggleCompareMode() {
  state.compareMode = !state.compareMode;
  state.compareLeft = null;
  state.compareRight = null;
  state.compareResult = null;
  document.getElementById("runsPanel").classList.toggle("compare-mode", state.compareMode);
  renderRuns();
}

function selectCompareSide(side, runId) {
  if (side === "left") state.compareLeft = runId;
  else state.compareRight = runId;
  renderRuns();
}

async function doCompareRuns() {
  if (!state.compareLeft || !state.compareRight) return;
  try {
    const result = await invoke("compare_runs", {
      left_run_id: state.compareLeft,
      right_run_id: state.compareRight,
    });
    state.compareResult = result;
    renderRuns();
  } catch (error) {
    toast(reportUiFailure("compare runs", error, "The selected runs could not be compared. Refresh Run history and try again."), true);
  }
}

function renderCompareResult() {
  const panel = document.getElementById("runsPanel");
  const existing = panel.querySelector(".compare-result-card");
  if (existing) existing.remove();
  const result = state.compareResult;
  if (!result) return;

  const card = document.createElement("div");
  card.className = "compare-result-card";

  // close button
  const closeBtn = document.createElement("button");
  closeBtn.className = "compare-close";
  closeBtn.textContent = "\u00d7";
  closeBtn.title = "Close comparison";
  closeBtn.addEventListener("click", () => {
    state.compareResult = null;
    renderRuns();
  });

  // summary strip
  const summary = document.createElement("div");
  summary.className = "compare-summary";
  summary.innerHTML =
    `<div class="compare-summary-item"><span class="count" style="color:var(--accent)">${result.summary.same}</span><span class="label">Same</span></div>` +
    `<div class="compare-summary-item"><span class="count" style="color:var(--warning)">${result.summary.different}</span><span class="label">Different</span></div>` +
    `<div class="compare-summary-item"><span class="count" style="color:var(--muted)">${result.summary.unknown}</span><span class="label">Unknown</span></div>`;
  summary.append(closeBtn);
  card.append(summary);

  const sectionLabels = {
    "Identity & Execution": "Run",
    "Source & Request": "Source",
    Artifacts: "Saved outputs",
  };
  const fieldLabels = {
    status: "Status",
    origin: "Started by",
    request_type: "Action",
    source_path: "Source",
    snapshot_available: "Environment captured",
    error_message: "Error",
    artifact_count: "Saved outputs",
  };
  const hiddenFields = new Set(["parent_run_id", "code_digest"]);
  const stateLabels = {
    same: "Same",
    different: "Different",
    unknown: "Unavailable",
    not_applicable: "Not applicable",
  };

  for (const section of (result.sections || [])) {
    const sec = document.createElement("div");
    sec.className = "compare-section open";

    const header = document.createElement("div");
    header.className = "compare-section-header";
    header.textContent = sectionLabels[section.label] || "Run details";
    header.addEventListener("click", () => sec.classList.toggle("open"));

    const body = document.createElement("div");
    body.className = "compare-section-body";

    for (const field of (section.fields || []).filter((item) => fieldLabels[item.field] && !hiddenFields.has(item.field))) {
      const row = document.createElement("div");
      row.className = "compare-field";
      const label = document.createElement("span");
      label.className = "compare-field-label";
      label.textContent = fieldLabels[field.field];
      const comparisonState = document.createElement("span");
      comparisonState.className = `compare-field-state ${field.state}`;
      comparisonState.textContent = stateLabels[field.state] || "Review";
      const value = document.createElement("span");
      value.className = "compare-field-value";
      const mapCompareValue = (item) => {
        if (field.field === "status") return prettyStatus(item);
        if (field.field === "origin") return prettyOrigin(item);
        if (field.field === "request_type") return humanExecutionMode({ request_type: item });
        if (field.field === "snapshot_available") return item === true || item === "true" ? "Available" : item === false || item === "false" ? "Unavailable" : "Not checked";
        return item;
      };
      const values = [field.left_value, field.right_value].filter((item) => item !== null && item !== undefined).map(mapCompareValue);
      value.textContent = values.join(" \u2194 ") || "-";
      row.append(label, comparisonState, value);
      body.append(row);
    }

    sec.append(header, body);
    card.append(sec);
  }

  panel.append(card);
}

function addProblem(message, call = "", options = {}) {
  const problem = {
    run_id: options.runId || `transient_${Date.now()}`,
    parent_run_id: null,
    transient: true,
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
    diagnostic_id: options.diagnosticId || null,
    line_number: options.lineNumber || null,
    column_number: options.columnNumber || null,
    end_line_number: options.endLineNumber || null,
    end_column_number: options.endColumnNumber || null,
    severity: options.severity || null,
    rule: options.rule || null,
    producer: options.producer || null,
    producer_version: options.producerVersion || null,
    scan_scope: options.scanScope || null,
    quick_fix: options.quickFix || null,
    project_root: options.projectRoot || state.project.root || null,
  };
  state.problems.unshift(problem);
  renderProblems();
  return problem;
}

function renderProblemsLegacy() {
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
    title.textContent = problem.source_path
      ? `Analysis stopped at ${displayPath(problem.source_path)}`
      : problem.message;
    const detail = document.createElement("p");
    detail.textContent = [
      problem.message !== title.textContent ? problem.message : null,
      problem.call ? `called ${problem.call}` : null,
    ].filter(Boolean).join(" · ");
    content.append(title, detail);
    const actions = document.createElement("div");
    actions.className = "problem-actions";

    // Open source if available
    if (problem.source_path) {
      const openSource = document.createElement("button");
      openSource.type = "button";
      openSource.textContent = "Go to source";
      openSource.addEventListener("click", async () => {
        try {
          await openDocument(problem.source_path);
        } catch (error) {
          toast(reportUiFailure("open Problem source", error, "The source could not be opened. Refresh the project and try again."), true);
        }
      });
      actions.append(openSource);
    }

    const explain = document.createElement("button");
    explain.type = "button";
    explain.textContent = "Explain this problem";
    explain.addEventListener("click", () => {
      applyWorkbenchLayout("agent");
      $("#agentInput").value = `请解释这个 R 错误并给出修复建议：${problem.message}`;
      $("#agentInput").focus();
    });
    actions.append(explain);
    if (problem.run_id && !String(problem.run_id).startsWith("transient_")) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Run again";
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
          toast(reportUiFailure("retry R run", error, "The R run could not be started again. Review the Problem and try again."), true);
        }
      });
      actions.append(retry);
    }
    row.append(icon, content, actions);
    list.append(row);
  }
}

function diagnosticGroupKey(problem) {
  if (problem.origin !== "lintr") return `problem:${problem.run_id}`;
  const message = String(problem.message || "").trim().replace(/\s+/g, " ").toLowerCase();
  return [
    problem.source_path || "", problem.line_number || 0, problem.column_number || 0,
    problem.end_line_number || problem.line_number || 0,
    problem.end_column_number || problem.column_number || 0, message,
  ].join(":");
}

function compareDiagnosticProblems(left, right) {
  const pathComparison = String(left.source_path || "").localeCompare(String(right.source_path || ""));
  if (pathComparison) return pathComparison;
  for (const field of ["line_number", "column_number", "end_line_number", "end_column_number"]) {
    const compared = Number(left[field] || 0) - Number(right[field] || 0);
    if (compared) return compared;
  }
  for (const field of ["severity", "rule", "message", "diagnostic_id"]) {
    const compared = String(left[field] || "").localeCompare(String(right[field] || ""));
    if (compared) return compared;
  }
  return 0;
}

function groupedProblems() {
  const groups = [];
  const byKey = new Map();
  for (const problem of state.problems) {
    const key = diagnosticGroupKey(problem);
    if (!byKey.has(key)) {
      const group = { key, problems: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    byKey.get(key).problems.push(problem);
  }
  for (const group of groups) {
    if (group.problems[0]?.origin === "lintr") group.problems.sort(compareDiagnosticProblems);
  }
  const sortedLintGroups = groups
    .filter((group) => group.problems[0]?.origin === "lintr")
    .sort((left, right) => compareDiagnosticProblems(left.problems[0], right.problems[0]));
  let lintIndex = 0;
  return groups.map((group) => group.problems[0]?.origin === "lintr" ? sortedLintGroups[lintIndex++] : group);
}

function renderLintStatus() {
  const status = $("#lintStatus");
  const response = state.lint.response;
  const visible = state.lint.status !== "idle";
  status.classList.toggle("hidden", !visible);
  status.classList.toggle("warning", ["error", "unavailable", "incomplete", "stale"].includes(state.lint.status));
  if (!visible) return;
  if (state.lint.status === "running") {
    status.textContent = "lintr · scanning the saved active file";
    return;
  }
  if (state.lint.status === "applied") {
    status.textContent = "Quick fix applied to the unsaved editor buffer · Save to persist, then Check code again";
    return;
  }
  status.textContent = state.lint.error
    ? userFacingError(state.lint.error, "The code check could not be completed. Save the file and try again.")
    : `${response?.diagnostics?.length || 0} code ${response?.diagnostics?.length === 1 ? "issue" : "issues"} found`;
}

async function openProblemSource(problem, options = {}) {
  const { selectRange = false } = options;
  const sourceKind = problemSourceKind(problem);
  if (sourceKind === "console") {
    switchDockTab("console");
    return;
  }
  if (sourceKind !== "file") return;
  await openDocument(problem.source_path);
  if (state.activeDocument !== problem.source_path || !problem.line_number) return;
  const lineNumber = Math.max(1, Number(problem.line_number));
  const columnNumber = Math.max(1, Number(problem.column_number) || 1);
  if (state.editor.mode === "monaco" && state.editor.editor) {
    const model = state.editor.editor.getModel();
    const safeLineNumber = Math.min(model.getLineCount(), lineNumber);
    const endLineNumber = selectRange
      ? Math.min(model.getLineCount(), Math.max(safeLineNumber, Number(problem.end_line_number) || safeLineNumber))
      : safeLineNumber;
    const endColumnNumber = selectRange
      ? Math.min(model.getLineMaxColumn(endLineNumber), Number(problem.end_column_number) || model.getLineMaxColumn(endLineNumber))
      : columnNumber;
    state.editor.editor.revealLineInCenter(safeLineNumber);
    if (selectRange) {
      state.editor.editor.setSelection({
        startLineNumber: safeLineNumber,
        startColumn: selectRange && !problem.end_column_number ? 1 : Math.min(model.getLineMaxColumn(safeLineNumber), columnNumber),
        endLineNumber,
        endColumn: Math.max(1, endColumnNumber),
      });
    } else {
      state.editor.editor.setPosition({ lineNumber, column: columnNumber });
    }
    state.editor.editor.focus();
  } else if (selectRange) {
    const content = currentEditorValue();
    const lines = content.split("\n");
    const startLineIndex = Math.min(lines.length - 1, lineNumber - 1);
    const endLineIndex = Math.min(lines.length - 1, Math.max(startLineIndex, (Number(problem.end_line_number) || lineNumber) - 1));
    const lineStart = lines.slice(0, startLineIndex).reduce((offset, line) => offset + line.length + 1, 0);
    const endLineStart = lines.slice(0, endLineIndex).reduce((offset, line) => offset + line.length + 1, 0);
    const startOffset = lineStart + (problem.end_column_number ? Math.min(lines[startLineIndex].length, columnNumber - 1) : 0);
    const endOffset = endLineStart + (Number(problem.end_column_number) || lines[endLineIndex].length);
    const editor = fallbackEditor();
    editor.focus();
    editor.setSelectionRange(Math.min(startOffset, endOffset), Math.max(startOffset, endOffset));
  }
}

function boundedProblemTextList(value, maxItems = 12, maxChars = 1000) {
  return (Array.isArray(value) ? value : [])
    .slice(0, maxItems)
    .map((item) => truncateText(String(item || ""), maxChars))
    .filter(Boolean);
}

function problemExactRange(problem) {
  const values = [
    problem?.line_number,
    problem?.column_number,
    problem?.end_line_number,
    problem?.end_column_number,
  ].map(Number);
  if (values.some((value) => !Number.isInteger(value) || value < 1)) return null;
  const [startLine, startColumn, endLine, endColumn] = values;
  if (startLine > 10_000_000 || endLine > 10_000_000 || startColumn > 1_000_000 || endColumn > 1_000_000) return null;
  if (endLine < startLine || (endLine === startLine && endColumn <= startColumn)) return null;
  if (problem.origin !== "lintr"
    && !["r_expression", "r_parse_token"].includes(problem.range_kind)) return null;
  return {
    startLine,
    startColumn,
    endLine,
    endColumn,
    rangeKind: problem.range_kind || (problem.origin === "lintr" ? "lintr" : null),
  };
}

function currentProblemSelectionRange(problem) {
  const documentState = activeDocument();
  if (!documentState || documentState.path !== problem?.source_path) return null;
  const offsets = currentEditorOffsets();
  const start = Math.min(offsets.start, offsets.end);
  const end = Math.max(offsets.start, offsets.end);
  if (end <= start) return null;
  const content = currentEditorValue();
  const startPosition = editorPositionAtOffset(content, start);
  const endPosition = editorPositionAtOffset(content, end);
  if (startPosition.line > 10_000_000 || endPosition.line > 10_000_000
    || startPosition.column > 1_000_000 || endPosition.column > 1_000_000) return null;
  return {
    startLine: startPosition.line,
    startColumn: startPosition.column,
    endLine: endPosition.line,
    endColumn: endPosition.column,
    rangeKind: "user_selection",
  };
}

function problemRunContext(detail) {
  if (!detail) return null;
  return {
    kind: "rho.problem_run_context.v1",
    run_id: truncateText(String(detail.run_id || ""), 128),
    request_type: truncateText(String(detail.request_type || ""), 128),
    execution_mode: truncateText(String(detail.execution_mode || ""), 64),
    code: truncateText(String(detail.code || ""), 8000),
    stdout: detail.stdout ? truncateText(String(detail.stdout), 4000) : null,
    value: detail.value_text ? truncateText(String(detail.value_text), 2000) : null,
    messages: boundedProblemTextList(detail.messages),
    warnings: boundedProblemTextList(detail.warnings),
  };
}

function problemExpectedSourceText(problem, detail, rangeOverride = null) {
  const range = rangeOverride || problemExactRange(problem);
  const argumentsValue = parseJsonObject(detail?.arguments_json);
  const sourceRange = argumentsValue?.source_range;
  const code = String(detail?.code || "");
  if (!range || !sourceRange || !code) return null;
  const base = {
    startLine: Number(sourceRange.start_line),
    startColumn: Number(sourceRange.start_column),
    endLine: Number(sourceRange.end_line),
    endColumn: Number(sourceRange.end_column),
  };
  if (Object.values(base).some((value) => !Number.isInteger(value) || value < 1)) return null;
  const afterBaseStart = range.startLine > base.startLine
    || (range.startLine === base.startLine && range.startColumn >= base.startColumn);
  const beforeBaseEnd = range.endLine < base.endLine
    || (range.endLine === base.endLine && range.endColumn <= base.endColumn);
  if (!afterBaseStart || !beforeBaseEnd) return null;
  const relativeStartLine = range.startLine - base.startLine + 1;
  const relativeEndLine = range.endLine - base.startLine + 1;
  const relativeStartColumn = relativeStartLine === 1
    ? range.startColumn - base.startColumn + 1
    : range.startColumn;
  const relativeEndColumn = relativeEndLine === 1
    ? range.endColumn - base.startColumn + 1
    : range.endColumn;
  const start = refactorOffsetAtLineColumn(code, relativeStartLine, relativeStartColumn);
  const end = refactorOffsetAtLineColumn(code, relativeEndLine, relativeEndColumn);
  if (start === null || end === null || end <= start) return null;
  return code.slice(start, end);
}

function selectExactProblemRange(problem, rangeOverride = null) {
  const range = rangeOverride || problemExactRange(problem);
  if (!range) throw new Error("The diagnostic has no exact source range. Run the code again to capture one.");
  const content = currentEditorValue();
  const start = refactorOffsetAtLineColumn(content, range.startLine, range.startColumn);
  const end = refactorOffsetAtLineColumn(content, range.endLine, range.endColumn);
  if (start === null || end === null || end <= start) {
    throw new Error("The recorded error range is outside the current file. Run the code again to refresh Problems.");
  }
  if (state.editor.mode === "monaco" && state.editor.editor) {
    state.editor.editor.revealLineInCenter(range.startLine);
    state.editor.editor.setSelection({
      startLineNumber: range.startLine,
      startColumn: range.startColumn,
      endLineNumber: range.endLine,
      endColumn: range.endColumn,
    });
    state.editor.editor.focus();
  } else {
    const editor = fallbackEditor();
    editor.focus();
    editor.setSelectionRange(start, end);
  }
  return content.slice(start, end);
}

function problemRepairRouteReason() {
  const general = agentSendDisabledReason();
  if (general) return general;
  const route = agentCapabilityRouteView("agent.act");
  if (!route?.model_id) return "Assign a function-calling model to the Act route before starting Agent repair.";
  if (route.compatibility === "needs_review") return "Review the Act model's function-call capability before starting Agent repair.";
  if (route.compatibility !== "compatible") return "Agent repair needs a compatible function-calling model on the Act route.";
  if (!["detected", "not_required"].includes(route.credential_status)) {
    return "The Act route Provider connection needs a valid API key before Agent repair can start.";
  }
  return null;
}

function openProblemRepairModelRouting() {
  state.agentLlm.activeView = "routing";
  state.agentLlm.routingExpandedCapability = "agent.act";
  openAgentLlmDialog();
  switchAgentLlmView("routing", { focus: true });
}

function problemRepairActionState(problem) {
  const sourceKind = problemSourceKind(problem);
  if (sourceKind !== "file" && sourceKind !== "console") {
    return {
      kind: "unavailable",
      label: "Repair unavailable",
      title: "This problem has no available project source or Console run context.",
      disabled: true,
    };
  }
  if (sourceKind === "file" && !problemExactRange(problem)) {
    return {
      kind: "select",
      label: "Select code for Agent",
      title: "Open the source, select the failing expression, then use this action again. Running again may also capture an exact range.",
      disabled: false,
    };
  }
  const routeReason = problemRepairRouteReason();
  if (routeReason) {
    return {
      kind: "setup",
      label: "Set up Agent repair",
      title: routeReason,
      disabled: false,
    };
  }
  return {
    kind: "repair",
    label: "Fix with Agent",
    title: "Start one Agent repair turn with this exact failed run and diagnostic range.",
    disabled: false,
  };
}

async function activateProblemRepairAction(problem) {
  const action = problemRepairActionState(problem);
  if (action.disabled) {
    toast(action.title, true);
    return;
  }
  if (action.kind === "setup") {
    toast(action.title, true);
    openProblemRepairModelRouting();
    return;
  }
  await fixProblemWithAgent(problem);
}

function configureProblemRepairButton(button, problem, { activate = null } = {}) {
  const action = problemRepairActionState(problem);
  button.type = "button";
  button.textContent = action.label;
  button.title = action.title;
  button.disabled = action.disabled;
  button.dataset.repairAction = action.kind;
  button.onclick = null;
  if (action.disabled) return;
  if (activate) {
    button.onclick = activate;
    return;
  }
  button.onclick = async () => {
    if (button.dataset.repairBusy === "true") return;
    button.dataset.repairBusy = "true";
    button.disabled = true;
    try {
      await activateProblemRepairAction(problem);
    } finally {
      delete button.dataset.repairBusy;
      if (button.isConnected) configureProblemRepairButton(button, problem);
    }
  };
}

function problemAgentDiagnostic(problem, rangeOverride = null) {
  const range = rangeOverride || problemExactRange(problem);
  return {
    kind: "rho.problem_diagnostic.v1",
    project_root: truncateText(String(state.project.root || ""), 1000),
    source_path: problem.source_path ? truncateText(problem.source_path, 1000) : null,
    line_number: range?.startLine ?? null,
    column_number: range?.startColumn ?? null,
    end_line_number: range?.endLine ?? null,
    end_column_number: range?.endColumn ?? null,
    range_kind: range?.rangeKind ? truncateText(range.rangeKind, 64) : null,
    message: truncateText(String(problem.message || ""), 4000),
    call: problem.call ? truncateText(problem.call, 1000) : null,
    traceback: boundedProblemTextList(problem.traceback),
    origin: problem.origin ? truncateText(problem.origin, 128) : null,
    severity: problem.severity ? truncateText(problem.severity, 64) : (problem.status === "failed" ? "error" : "info"),
    run_id: problem.run_id ? truncateText(problem.run_id, 128) : null,
    execution_mode: problem.execution_mode ? truncateText(problem.execution_mode, 64) : null,
  };
}

async function fixProblemWithAgent(problem) {
  const sourceKind = problemSourceKind(problem);
  if (sourceKind === "missing" || sourceKind === "virtual" || sourceKind === "none") {
    toast("This problem has no available project file to repair. Open the source or attach the relevant file first.", true);
    return;
  }
  const projectRoot = state.project.root;
  const refreshSequence = state.projectRefreshSequence;
  const assertCurrentProject = () => {
    if (state.project.root !== projectRoot || state.projectRefreshSequence !== refreshSequence) {
      throw new Error("The active project changed while Agent repair was being prepared. Open the Problem in the current project and try again.");
    }
  };
  let repairRange = sourceKind === "file" ? problemExactRange(problem) : null;
  if (sourceKind === "file" && !repairRange) {
    repairRange = currentProblemSelectionRange(problem);
    if (!repairRange) {
      try {
        await openDocument(problem.source_path);
        assertCurrentProject();
        applyWorkbenchLayout("analyze");
        toast("Select the failing R expression in the editor, then use this error's Agent action again.", true);
      } catch (error) {
        toast(reportUiFailure("prepare Agent repair selection", error, "The source could not be opened. Restore it or refresh the project, then try again."), true);
      }
      return;
    }
  }
  const routeReason = problemRepairRouteReason();
  if (routeReason) {
    toast(routeReason, true);
    openProblemRepairModelRouting();
    return;
  }
  try {
    const normalizedProjectRoot = (value) => String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (problem.project_root && normalizedProjectRoot(problem.project_root) !== normalizedProjectRoot(projectRoot)) {
      throw new Error("This Problem belongs to a different project. Refresh Problems before starting repair.");
    }
    const durableRun = problem.run_id
      && !String(problem.run_id).startsWith("transient_")
      && problem.origin !== "lintr";
    const runDetail = durableRun ? await invoke("get_run_detail", { runId: problem.run_id }) : null;
    assertCurrentProject();
    if (durableRun && (!runDetail || runDetail.run_id !== problem.run_id
      || normalizedProjectRoot(runDetail.project_root) !== normalizedProjectRoot(projectRoot))) {
      throw new Error("The failed run is no longer available in this project. Refresh Problems and run the code again.");
    }
    if (sourceKind === "file") {
      await openDocument(problem.source_path);
      assertCurrentProject();
      if (state.activeDocument !== problem.source_path) throw new Error("The problem source could not be opened.");
      const selectedText = selectExactProblemRange(problem, repairRange);
      if (runDetail) {
        if (repairRange?.rangeKind !== "user_selection") {
          const expectedText = problemExpectedSourceText(problem, runDetail, repairRange);
          if (!expectedText || selectedText !== expectedText) {
            throw new Error("The source changed since this error was recorded. Run the code again to create a fresh diagnostic.");
          }
        }
        if (problem.execution_mode === "file" && normalizeExecutableCode(currentEditorValue()) !== String(runDetail.code || "")) {
          throw new Error("The file changed since this error was recorded. Run the file again before starting Agent repair.");
        }
      } else {
        const documentState = activeDocument();
        if (problem.document_version !== null && problem.document_version !== undefined
          && documentState?.versionId !== problem.document_version) {
          throw new Error("The checked document changed. Run Check code again before starting Agent repair.");
        }
      }
      setAgentContext("problem", problem.source_path);
    } else {
      if (!runDetail) throw new Error("The Console run details are unavailable. Run the command again, then retry Agent repair.");
      setAgentContext("problem", null);
    }
    state.agentDiagnostic = problemAgentDiagnostic(problem, repairRange);
    state.agentProblemRunContext = problemRunContext(runDetail);
    state.agentMode = "ask";
    syncAgentComposerState();
    applyWorkbenchLayout("agent");
    const location = problem.source_path
      ? `${displayPath(problem.source_path)}${repairRange ? `:${repairRange.startLine}:${repairRange.startColumn}` : ""}`
      : "the R Console";
    const reference = sourceKind === "file" ? ` @"${problem.source_path}"` : "";
    const rangeDescription = repairRange?.rangeKind === "user_selection"
      ? "the user-selected repair range"
      : "the exact diagnostic range";
    $("#agentInput").value = sourceKind === "file"
      ? `Repair this R problem at ${rangeDescription} ${location}${reference}. Diagnose the cause and generate at most one reviewable file edit proposal if a code change is appropriate. Do not run R, do not ask me to select the code again, and do not claim the file changed until I accept the proposal.\n\nError: ${problem.message || "(no error message)"}`
      : `Diagnose this R Console problem using the attached failed-run context and give concrete recovery steps. No project file range is known, so do not claim that a file edit was prepared unless you first identify an exact project file through read-only inspection. Do not run R.\n\nError: ${problem.message || "(no error message)"}`;
    const response = await sendAgentPrompt({ taskKind: "problem_repair", mode: "ask" });
    if (!response) {
      $("#agentInput").value = "";
      resetAgentContext();
    }
  } catch (error) {
    resetAgentContext();
    toast(reportUiFailure("start Agent repair", error, "The Agent repair context could not be prepared. Open the source and try again."), true);
  }
}

function problemSourceKind(problem) {
  const sourcePath = String(problem?.source_path || "").trim();
  if (!sourcePath) return "none";
  if (sourcePath === "<console>") return "console";
  if (/^<[^<>]+>$/.test(sourcePath)) return "virtual";
  return state.project.files.some((file) => file.path === sourcePath) ? "file" : "missing";
}

function problemSourceLabel(problem) {
  return problemSourceKind(problem) === "console" ? "Console" : problem.source_path;
}

function renderProblems() {
  const list = $("#problemList");
  list.replaceChildren();
  renderLintStatus();
  $("#clearLintResultsButton").disabled = state.lint.status === "idle"
    && !state.problems.some((problem) => problem.origin === "lintr");
  const groups = groupedProblems();
  $("#problemEmpty").classList.toggle("hidden", groups.length > 0);
  $("#problemCount").textContent = String(groups.length);
  $("#problemCount").classList.toggle("quiet", groups.length === 0);
  for (const group of groups) {
    const problem = group.problems[0];
    const row = document.createElement("div");
    row.className = "problem-row problem-row-grouped";
    const icon = document.createElement("span");
    const severity = problem.severity || (problem.status === "failed" ? "error" : "info");
    icon.className = `problem-icon ${severity}`;
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", `${severity} problem`);
    icon.textContent = { error: "E", warning: "W", info: "i" }[severity] || "i";
    const content = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = problem.origin === "lintr"
      ? problem.message
      : problem.source_path
        ? `Analysis stopped at ${problemSourceLabel(problem)}`
        : problem.message;
    const detail = document.createElement("p");
    detail.textContent = problem.origin === "lintr"
      ? ""
      : [problem.message !== title.textContent ? problem.message : null, problem.call ? `called ${problem.call}` : null].filter(Boolean).join(" · ");
    content.append(title, detail);
    if (problem.origin === "lintr") {
      const location = document.createElement("p");
      location.className = "problem-location";
      location.textContent = `${displayPath(problem.source_path)}:${problem.line_number}:${problem.column_number}`;
      const meta = document.createElement("p");
      meta.className = "problem-meta";
      meta.textContent = `${severity} · Code check`;
      content.append(location, meta);
      if (group.problems.length > 1) {
        const count = document.createElement("span");
        count.className = "problem-group-count";
        count.textContent = `${group.problems.length} grouped`;
        content.append(count);
      }
    }
    const actions = document.createElement("div");
    actions.className = "problem-actions";
    const sourceKind = problemSourceKind(problem);
    if (sourceKind === "file" || sourceKind === "console") {
      const openSource = document.createElement("button");
      openSource.type = "button";
      openSource.textContent = sourceKind === "console" ? "Open Console" : "Go to source";
      openSource.addEventListener("click", async () => {
        try {
          await openProblemSource(problem);
        } catch (error) {
          toast(reportUiFailure("open Problem source", error, "The source could not be opened. Refresh the project and try again."), true);
        }
      });
      actions.append(openSource);
    } else if (sourceKind === "missing") {
      const unavailable = document.createElement("span");
      unavailable.className = "problem-source-unavailable";
      unavailable.textContent = "Source unavailable";
      unavailable.title = `The project file is no longer available: ${displayPath(problem.source_path)}`;
      actions.append(unavailable);
    }
    if (problem.origin === "lintr" && problem.quick_fix) {
      const review = document.createElement("button");
      review.type = "button";
      review.textContent = "Review quick fix";
      review.addEventListener("click", () => reviewLintQuickFix(problem));
      actions.append(review);
    }
    const explain = document.createElement("button");
    explain.type = "button";
    explain.textContent = "Explain this problem";
    explain.addEventListener("click", () => {
      applyWorkbenchLayout("agent");
      $("#agentInput").value = `Explain this R problem and suggest a fix: ${problem.message}`;
      $("#agentInput").focus();
    });
    actions.append(explain);
    if (sourceKind === "file" || sourceKind === "console") {
      const fix = document.createElement("button");
      configureProblemRepairButton(fix, problem);
      actions.append(fix);
    }
    if (problem.origin !== "lintr" && problem.run_id && !String(problem.run_id).startsWith("transient_")) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Run again";
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
          toast(reportUiFailure("retry R run", error, "The R run could not be started again. Review the Problem and try again."), true);
        }
      });
      actions.append(retry);
    }
    row.append(icon, content, actions);
    list.append(row);
  }
  syncConsoleRepairEntries();
}

function setLintQuickFixError(message = null) {
  const error = $("#lintQuickFixError");
  error.textContent = message || "";
  error.classList.toggle("hidden", !message);
}

function closeLintQuickFix() {
  $("#lintQuickFixDialog").classList.add("hidden");
  state.lint.proposal = null;
  setLintQuickFixError();
}

function clearLintResults() {
  state.problems = state.problems.filter((problem) => problem.origin !== "lintr");
  state.lint = { status: "idle", response: null, proposal: null, projectRoot: null, error: null };
  closeLintQuickFix();
  renderProblems();
}

async function reviewLintQuickFix(problem) {
  if (!problem?.quick_fix) return;
  try {
    await openProblemSource(problem);
  } catch (error) {
    toast(reportUiFailure("open lint source", error, "The source could not be opened. Refresh the project and try again."), true);
    return;
  }
  state.lint.proposal = {
    problem,
    projectRoot: problem.project_root,
    sourcePath: problem.source_path,
    documentVersion: problem.document_version,
    quickFix: problem.quick_fix,
  };
  $("#lintQuickFixTitle").textContent = problem.quick_fix.title || "Review quick fix";
  $("#lintQuickFixPath").textContent = `${displayPath(problem.source_path)}:${problem.quick_fix.line_number}`;
  $("#lintQuickFixBefore").textContent = problem.quick_fix.expected_line;
  $("#lintQuickFixAfter").textContent = problem.quick_fix.replacement_line;
  $("#lintQuickFixNote").textContent = "Applying changes only the editor buffer. Review the exact line, then Save separately to persist it.";
  setLintQuickFixError();
  $("#lintQuickFixDialog").classList.remove("hidden");
  $("#lintQuickFixApply").focus();
}

async function applyLintQuickFix() {
  const proposal = state.lint.proposal;
  if (!proposal) return;
  const button = $("#lintQuickFixApply");
  button.disabled = true;
  try {
    if (state.project.root !== proposal.projectRoot) throw new Error("The active project changed. Check code again in this project.");
    if (state.activeDocument !== proposal.sourcePath) throw new Error("The active file changed. Reopen the diagnostic and review it again.");
    syncDocumentFromEditor({ render: false, persist: false });
    const documentState = activeDocument();
    if (!documentState || documentState.versionId !== proposal.documentVersion) {
      throw new Error("The document changed after this diagnostic was produced. Check code again.");
    }
    const lineNumber = Number(proposal.quickFix.line_number);
    const lines = documentState.content.split("\n");
    if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > lines.length
      || lines[lineNumber - 1] !== proposal.quickFix.expected_line) {
      throw new Error("The source line no longer matches this quick fix. Check code again.");
    }
    if (state.editor.mode === "monaco" && state.editor.editor?.getModel()) {
      const model = state.editor.editor.getModel();
      state.editor.editor.pushUndoStop();
      state.editor.editor.executeEdits("rho-lint-quick-fix", [{
        range: new state.editor.monaco.Range(lineNumber, 1, lineNumber, model.getLineMaxColumn(lineNumber)),
        text: proposal.quickFix.replacement_line,
        forceMoveMarkers: true,
      }]);
      state.editor.editor.pushUndoStop();
      state.editor.editor.focus();
    } else {
      lines[lineNumber - 1] = proposal.quickFix.replacement_line;
      documentState.content = lines.join("\n");
      documentState.versionId = (documentState.versionId || 0) + 1;
      fallbackEditor().value = documentState.content;
      recordFallbackEditorChange("lint-quick-fix");
    }
    syncDocumentFromEditor({ render: true, persist: true });
    state.problems = state.problems.filter((item) => item.origin !== "lintr" || item.source_path !== proposal.sourcePath);
    state.lint.status = "applied";
    state.lint.error = null;
    closeLintQuickFix();
    renderProblems();
    updateEditorChrome();
    toast("Quick fix applied to the editor. Save to persist it.");
  } catch (error) {
    setLintQuickFixError(String(error));
  } finally {
    button.disabled = false;
  }
}

const REFACTOR_MAX_TARGET_FILES = 20;
const REFACTOR_MAX_FILE_BYTES = 1024 * 1024;
const REFACTOR_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const REFACTOR_MAX_EXTRACT_BYTES = 20_000;

function refactorContentFingerprint(content) {
  const value = String(content || "");
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const bytes = new TextEncoder().encode(value).length;
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}:${bytes}`;
}

function validRefactorSymbol(value) {
  const name = String(value || "");
  return new TextEncoder().encode(name).length <= 128
    && /^(?:[A-Za-z]|\.(?!\d))[A-Za-z0-9._]*$/.test(name);
}

function selectedRefactorSymbol() {
  const content = currentEditorValue();
  const offsets = currentEditorOffsets();
  const start = Math.min(offsets.start, offsets.end);
  const end = Math.max(offsets.start, offsets.end);
  if (start !== end) {
    const selected = content.slice(start, end);
    return validRefactorSymbol(selected) ? selected : null;
  }
  if (state.editor.mode === "monaco" && state.editor.editor?.getModel()) {
    const position = state.editor.editor.getPosition();
    return state.editor.editor.getModel().getWordAtPosition(position)?.word || null;
  }
  let tokenStart = start;
  let tokenEnd = start;
  while (tokenStart > 0 && /[A-Za-z0-9._]/.test(content[tokenStart - 1])) tokenStart -= 1;
  while (tokenEnd < content.length && /[A-Za-z0-9._]/.test(content[tokenEnd])) tokenEnd += 1;
  const token = content.slice(tokenStart, tokenEnd);
  return validRefactorSymbol(token) ? token : null;
}

function refactorOffsetAtLineColumn(content, line, column) {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) return null;
  let offset = 0;
  for (let currentLine = 1; currentLine < line; currentLine += 1) {
    const next = content.indexOf("\n", offset);
    if (next < 0) return null;
    offset = next + 1;
  }
  const lineEnd = content.indexOf("\n", offset);
  const boundedEnd = lineEnd < 0 ? content.length : lineEnd;
  const result = offset + column - 1;
  return result <= boundedEnd ? result : null;
}

async function refactorTargetSnapshot(path, options = {}) {
  const { requireClean = false, projectRoot = state.project.root } = options;
  if (state.project.root !== projectRoot) throw new Error("The active project changed while the refactor proposal was being built.");
  if (!state.project.files.some((file) => file.path === path)) {
    throw new Error(`Refactor target is no longer in the active project: ${path}`);
  }
  if (state.closedDrafts[path]) {
    throw new Error(`Save or reopen the closed draft for ${path} before creating a refactor proposal.`);
  }
  if (state.activeDocument === path) syncDocumentFromEditor({ render: false, persist: false });
  const documentState = state.documents[path] || null;
  if (documentState?.readOnly) throw new Error(`Refactor target is read-only: ${path}`);
  if (requireClean && documentState && documentIsDirty(documentState)) {
    throw new Error(`Save ${path} before a project-wide rename so References and the editor use the same source.`);
  }
  const disk = await invoke("project_read_file", { path });
  if (state.project.root !== projectRoot) throw new Error("The active project changed while a refactor target was loading.");
  const diskContent = String(disk?.content || "");
  const before = documentState ? String(documentState.content || "") : diskContent;
  if (requireClean && before !== diskContent) {
    throw new Error(`The editor and disk versions of ${path} differ. Save or reload before renaming.`);
  }
  const byteLength = new TextEncoder().encode(before).length;
  if (byteLength > REFACTOR_MAX_FILE_BYTES) throw new Error(`Refactor target exceeds the 1 MiB file limit: ${path}`);
  return {
    path,
    before,
    savedContent: documentState?.savedContent ?? diskContent,
    beforeFingerprint: refactorContentFingerprint(before),
    documentVersion: documentState?.versionId ?? null,
    wasOpen: Boolean(documentState),
    byteLength,
  };
}

function applyRenameLocations(content, locations, oldName, newName, path) {
  const offsets = [];
  const seen = new Set();
  for (const location of locations) {
    const offset = refactorOffsetAtLineColumn(content, Number(location.line), Number(location.column));
    if (offset === null || content.slice(offset, offset + oldName.length) !== oldName) {
      throw new Error(`Reference location no longer matches ${oldName} in ${path}:${location.line}.`);
    }
    const before = content[offset - 1] || "";
    const after = content[offset + oldName.length] || "";
    if (/[A-Za-z0-9._]/.test(before) || /[A-Za-z0-9._]/.test(after)) {
      throw new Error(`Reference location is not an exact symbol token in ${path}:${location.line}.`);
    }
    if (seen.has(offset)) throw new Error(`Duplicate reference location in ${path}:${location.line}.`);
    seen.add(offset);
    offsets.push(offset);
  }
  let result = content;
  for (const offset of offsets.sort((left, right) => right - left)) {
    result = result.slice(0, offset) + newName + result.slice(offset + oldName.length);
  }
  return result;
}

async function buildRenameRefactorProposal(oldName, newName) {
  if (!validRefactorSymbol(oldName)) throw new Error("Place the cursor on one ordinary R identifier to rename it.");
  if (!validRefactorSymbol(newName)) throw new Error("Enter an ordinary R identifier with at most 128 UTF-8 bytes.");
  if (oldName === newName) throw new Error("Choose a different name for the symbol.");
  const projectRoot = state.project.root;
  const response = await invoke("editor_find_project_references", { name: oldName, limit: 200 });
  if (state.project.root !== projectRoot) throw new Error("The active project changed while References was running.");
  if (!response || response.name !== oldName) throw new Error("References returned a mismatched symbol. Refresh and try again.");
  if (response.incomplete || response.truncated) {
    throw new Error("Rename is unavailable because the bounded References result is incomplete or truncated.");
  }
  const references = Array.isArray(response.references) ? response.references : [];
  if (!references.length) throw new Error(`No project references were found for ${oldName}.`);
  if (!Number.isInteger(Number(response.matched_count)) || Number(response.matched_count) !== references.length) {
    throw new Error("References returned an inconsistent match count. Refresh and try again.");
  }
  const grouped = new Map();
  for (const reference of references) {
    if (!reference?.file || !state.project.files.some((file) => file.path === reference.file)) {
      throw new Error("References included a file outside the current safe project list.");
    }
    if (!grouped.has(reference.file)) grouped.set(reference.file, []);
    grouped.get(reference.file).push(reference);
  }
  if (grouped.size > REFACTOR_MAX_TARGET_FILES) {
    throw new Error(`Rename affects ${grouped.size} files; the review limit is ${REFACTOR_MAX_TARGET_FILES}.`);
  }
  const targets = [];
  let totalBytes = 0;
  for (const path of [...grouped.keys()].sort((left, right) => left.localeCompare(right))) {
    const snapshot = await refactorTargetSnapshot(path, { requireClean: true, projectRoot });
    totalBytes += snapshot.byteLength;
    if (totalBytes > REFACTOR_MAX_TOTAL_BYTES) throw new Error("Rename exceeds the 8 MiB total review limit.");
    const after = applyRenameLocations(snapshot.before, grouped.get(path), oldName, newName, path);
    if (after === snapshot.before) throw new Error(`Rename produced no change in ${path}.`);
    targets.push({ ...snapshot, after, matches: grouped.get(path).length });
  }
  return {
    kind: "rho.editor_refactor_proposal.v1",
    operation: "rename_symbol",
    projectRoot,
    title: `Rename ${oldName} to ${newName}`,
    oldName,
    newName,
    referenceCount: references.length,
    targets,
  };
}

function buildExtractReplacement(content, start, end, functionName) {
  if (start < 0 || end <= start || end > content.length) throw new Error("Select one or more complete R source lines.");
  if (start > 0 && content[start - 1] !== "\n") throw new Error("Extract Function requires a selection that starts at the beginning of a line.");
  let effectiveEnd = end;
  if (effectiveEnd < content.length && content[effectiveEnd] === "\n") effectiveEnd += 1;
  if (effectiveEnd < content.length && content[effectiveEnd - 1] !== "\n") {
    throw new Error("Extract Function requires a selection that ends at the end of a line.");
  }
  const selected = content.slice(start, effectiveEnd);
  if (!selected.trim()) throw new Error("Select non-empty R source lines to extract.");
  if (new TextEncoder().encode(selected).length > REFACTOR_MAX_EXTRACT_BYTES) {
    throw new Error("The selected source exceeds the 20,000-byte extract limit.");
  }
  const bodyText = selected.endsWith("\n") ? selected.slice(0, -1) : selected;
  if (/^\s*(?:[A-Za-z.]|\.(?!\d))[A-Za-z0-9._]*\s*(?:<-|=)\s*function\s*\(/m.test(bodyText)
    || /^\s*(?:return\s*\(|break\b|next\b)/m.test(bodyText)) {
    throw new Error("This conservative extract does not accept nested function declarations or return/break/next control flow.");
  }
  const bodyLines = bodyText.split("\n");
  const leading = bodyLines[0].match(/^\s*/)?.[0] || "";
  const normalizedLines = bodyLines.map((line) => line.startsWith(leading) ? line.slice(leading.length) : line);
  const body = normalizedLines.map((line) => `${leading}  ${line}`).join("\n");
  const replacement = `${leading}${functionName} <- function() {\n${body}\n${leading}}\n\n${leading}${functionName}()`
    + (selected.endsWith("\n") ? "\n" : "");
  return {
    selected,
    effectiveEnd,
    after: content.slice(0, start) + replacement + content.slice(effectiveEnd),
  };
}

async function buildExtractRefactorProposal(functionName) {
  if (!validRefactorSymbol(functionName)) throw new Error("Enter an ordinary R function name with at most 128 UTF-8 bytes.");
  syncDocumentFromEditor({ render: false, persist: false });
  const documentState = activeDocument();
  if (!documentState || documentState.readOnly || !/\.r$/i.test(documentState.path)) {
    throw new Error("Extract Function requires an editable R source file.");
  }
  const offsets = currentEditorOffsets();
  const start = Math.min(offsets.start, offsets.end);
  const end = Math.max(offsets.start, offsets.end);
  const projectRoot = state.project.root;
  const snapshot = await refactorTargetSnapshot(documentState.path, { requireClean: false, projectRoot });
  const symbolPattern = new RegExp(`(^|[^A-Za-z0-9._])${functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9._]|$)`);
  if (symbolPattern.test(snapshot.before)) throw new Error(`${functionName} already appears in the active source. Choose another function name.`);
  const replacement = buildExtractReplacement(snapshot.before, start, end, functionName);
  return {
    kind: "rho.editor_refactor_proposal.v1",
    operation: "extract_function",
    projectRoot,
    title: `Extract ${functionName}()`,
    functionName,
    targets: [{ ...snapshot, after: replacement.after, matches: 1, selectionStart: start, selectionEnd: replacement.effectiveEnd, selectionText: replacement.selected }],
  };
}

const FORMAT_MAX_SOURCE_BYTES = 1024 * 1024;

async function buildFormatProposal() {
  syncDocumentFromEditor({ render: false, persist: false });
  const documentState = activeDocument();
  if (!documentState || documentState.readOnly || !/\.r$/i.test(documentState.path)) {
    throw new Error("Format Document requires an editable R source file.");
  }
  const source = String(documentState.content || "");
  if (new TextEncoder().encode(source).length > FORMAT_MAX_SOURCE_BYTES) {
    throw new Error("The active R source exceeds the 1 MiB formatting limit.");
  }
  const projectRoot = state.project.root;
  const documentVersion = documentState.versionId ?? 0;
  const response = await invoke("editor_format_source", {
    request: {
      path: documentState.path,
      source,
      document_version: documentVersion,
    },
  });
  if (state.project.root !== projectRoot) {
    throw new Error("The active project changed while formatting was running.");
  }
  if (!response || response.kind !== "rho.editor_format_result.v1") {
    throw new Error("The formatter returned an invalid result. Refresh and try again.");
  }
  if (!response.ok) {
    const message = response.error?.message || "The formatter could not create a proposal.";
    const error = new Error(message);
    error.code = response.error?.code || response.status || "formatter_error";
    throw error;
  }
  if (response.path !== documentState.path || Number(response.document_version) !== Number(documentVersion)) {
    throw new Error("The formatter result is bound to a different document version. Try again.");
  }
  if (String(response.before || "") !== source) {
    throw new Error("The formatter did not return the exact editor source. Try again.");
  }
  const after = String(response.after ?? "");
  if (new TextEncoder().encode(after).length > FORMAT_MAX_SOURCE_BYTES) {
    throw new Error("The formatter returned output above the 1 MiB review limit.");
  }
  return {
    kind: "rho.editor_format_proposal.v1",
    operation: "format_document",
    projectRoot,
    title: `Format ${documentState.path}`,
    provider: response.provider || "styler",
    providerVersion: response.provider_version || null,
    warnings: Array.isArray(response.warnings) ? response.warnings : [],
    targets: [{
      path: documentState.path,
      before: source,
      after,
      savedContent: documentState.savedContent ?? source,
      beforeFingerprint: refactorContentFingerprint(source),
      documentVersion,
      wasOpen: true,
      matches: response.changed ? 1 : 0,
    }],
  };
}

function boundedRefactorPreview(content, limit = 32_000) {
  const value = String(content || "");
  if (value.length <= limit) return value || "(empty)";
  const half = Math.floor(limit / 2);
  return `${value.slice(0, half)}\n... preview truncated ...\n${value.slice(-half)}`;
}

function setRefactorReviewError(message = null) {
  state.refactor.error = message ? String(message) : null;
  const error = $("#refactorReviewError");
  error.textContent = state.refactor.error
    ? userFacingError(state.refactor.error, "The proposed editor change could not be completed. Refresh the project and try again.")
    : "";
  error.classList.toggle("hidden", !state.refactor.error);
}

function renderRefactorReview() {
  const proposal = state.refactor.proposal;
  const status = state.refactor.status;
  const formatting = proposal?.operation === "format_document";
  $("#refactorReviewState").textContent = status;
  $("#refactorReviewTitle").textContent = proposal?.title || (formatting ? "Review formatting" : "Review refactor");
  $("#refactorReviewSummary").textContent = proposal
    ? formatting
      ? `${proposal.provider || "styler"}${proposal.providerVersion ? ` ${proposal.providerVersion}` : ""} · exact before/after for one open document · Apply changes only the editor buffer; Save separately.${proposal.warnings?.length ? ` Warnings: ${proposal.warnings.join(" ")}` : ""}`
      : `${proposal.targets.length} file${proposal.targets.length === 1 ? "" : "s"} · ${proposal.operation === "rename_symbol" ? `${proposal.referenceCount} exact symbol locations` : "one whole-line selection"} · Apply changes only editor buffers; Save each dirty file separately.${proposal.operation === "extract_function" ? " Zero-argument extraction preserves lexical reads, but assignments and returns may change scope." : ""}`
    : "No formatting or refactor proposal is available.";
  const files = $("#refactorReviewFiles");
  files.replaceChildren();
  for (const target of proposal?.targets || []) {
    const card = document.createElement("section");
    card.className = "refactor-review-file";
    const header = document.createElement("header");
    const path = document.createElement("strong");
    path.textContent = target.path;
    const version = document.createElement("span");
    version.textContent = `${formatting ? (target.matches ? "changed" : "unchanged") : `${target.matches || 1} edit${target.matches === 1 ? "" : "s"}`} · ${target.documentVersion === null ? target.beforeFingerprint : `doc ${target.documentVersion}`}`;
    header.append(path, version);
    const diff = document.createElement("div");
    diff.className = "refactor-review-diff";
    const before = document.createElement("div");
    const beforeLabel = document.createElement("span");
    beforeLabel.textContent = "Before";
    const beforeCode = document.createElement("pre");
    beforeCode.textContent = boundedRefactorPreview(target.before);
    before.append(beforeLabel, beforeCode);
    const after = document.createElement("div");
    const afterLabel = document.createElement("span");
    afterLabel.textContent = "After";
    const afterCode = document.createElement("pre");
    afterCode.textContent = boundedRefactorPreview(target.after);
    after.append(afterLabel, afterCode);
    diff.append(before, after);
    card.append(header, diff);
    files.append(card);
  }
  $("#refactorReviewApply").classList.toggle("hidden", status !== "review");
  $("#refactorReviewUndo").classList.toggle("hidden", status !== "applied" || !state.refactor.undo);
  $("#refactorReviewCancel").textContent = status === "review" ? "Cancel" : "Close";
  setRefactorReviewError(state.refactor.error);
  if (["editor-refactor", "editor-format"].includes(previewParams.get("preview"))) requestAnimationFrame(recordPreviewLayoutEvidence);
}

function openRefactorReview(proposal = null, status = "review", returnFocus = document.activeElement) {
  state.refactor.proposal = proposal;
  state.refactor.status = status;
  state.refactor.returnFocus = returnFocus;
  setRefactorReviewError();
  renderRefactorReview();
  $("#refactorReviewDialog").classList.remove("hidden");
  $(status === "review" ? "#refactorReviewApply" : "#refactorReviewClose").focus();
}

function closeRefactorReview() {
  $("#refactorReviewDialog").classList.add("hidden");
  state.refactor.returnFocus?.focus?.();
  state.refactor.returnFocus = null;
}

async function promptRefactorName({ title, message, label, defaultValue = "" }) {
  return showInputDialog({
    title,
    message,
    label,
    defaultValue,
    placeholder: "new_name",
    validate: (value) => {
      const error = $("#genericDialogInputError");
      if (!validRefactorSymbol(value)) {
        error.textContent = "Use an ordinary R identifier with at most 128 UTF-8 bytes.";
        error.classList.remove("hidden");
        return false;
      }
      error.classList.add("hidden");
      return true;
    },
  });
}

async function requestRenameSymbol(options = {}) {
  const oldName = options.oldName || selectedRefactorSymbol();
  if (!validRefactorSymbol(oldName)) {
    toast("Place the cursor on one ordinary R identifier to rename it.", true);
    return;
  }
  let newName = options.newName || await promptRefactorName({
    title: "Rename symbol",
    message: `Review every bounded project reference before changing ${oldName}.`,
    label: "New symbol name",
    defaultValue: oldName,
  });
  if (!newName) return;
  const returnFocus = options.returnFocus || document.activeElement;
  for (;;) {
    state.refactor.status = "loading";
    state.refactor.error = null;
    updateEditorChrome();
    try {
      const proposal = await buildRenameRefactorProposal(oldName, newName);
      state.refactor.proposal = proposal;
      state.refactor.status = "review";
      openRefactorReview(proposal, "review", returnFocus);
      return;
    } catch (error) {
      state.refactor.status = "idle";
      state.refactor.proposal = null;
      state.refactor.error = String(error);
      updateEditorChrome();
      newName = await promptRefactorName({
        title: "Rename symbol - try again",
        message: userFacingError(error, `Rename ${oldName} could not be prepared.`),
        label: `New name for ${oldName}`,
        defaultValue: newName,
      });
      if (!newName) {
        state.refactor.error = null;
        updateEditorChrome();
        return;
      }
    }
  }
}

async function requestExtractFunction(options = {}) {
  const functionName = options.functionName || await promptRefactorName({
    title: "Extract function",
    message: "The selected complete lines become a zero-argument lexical closure. Review scope and assignments before applying.",
    label: "Function name",
    defaultValue: "extracted_step",
  });
  if (!functionName) return;
  openRefactorReview(null, "loading", options.returnFocus || document.activeElement);
  try {
    state.refactor.proposal = await buildExtractRefactorProposal(functionName);
    state.refactor.status = "review";
    setRefactorReviewError();
  } catch (error) {
    state.refactor.status = "error";
    setRefactorReviewError(error);
  }
  renderRefactorReview();
}

async function requestFormatDocument(options = {}) {
  openRefactorReview(null, "loading", options.returnFocus || document.activeElement);
  try {
    state.refactor.proposal = await buildFormatProposal();
    state.refactor.status = state.refactor.proposal.targets.some((target) => target.before !== target.after)
      ? "review"
      : "unchanged";
    setRefactorReviewError();
  } catch (error) {
    state.refactor.status = error?.code === "formatter_unavailable" ? "unavailable" : "error";
    setRefactorReviewError(error);
  }
  renderRefactorReview();
}

async function validateRefactorProposal(proposal) {
  if (!proposal || !["rho.editor_refactor_proposal.v1", "rho.editor_format_proposal.v1"].includes(proposal.kind)) {
    throw new Error("The editor change proposal is malformed.");
  }
  if (proposal.projectRoot !== state.project.root) throw new Error("The active project changed. Create a fresh refactor proposal.");
  const validated = [];
  for (const target of proposal.targets) {
    if (!state.project.files.some((file) => file.path === target.path)) throw new Error(`Refactor target is no longer available: ${target.path}`);
    if (state.closedDrafts[target.path]) throw new Error(`A closed draft now exists for ${target.path}. Reopen it and create a fresh proposal.`);
    if (state.activeDocument === target.path) syncDocumentFromEditor({ render: false, persist: false });
    const documentState = state.documents[target.path] || null;
    if (documentState) {
      if (target.documentVersion !== null && documentState.versionId !== target.documentVersion) {
        throw new Error(`The document version changed for ${target.path}. Create a fresh refactor proposal.`);
      }
      if (documentState.content !== target.before || refactorContentFingerprint(documentState.content) !== target.beforeFingerprint) {
        throw new Error(`The editor content changed for ${target.path}. Create a fresh refactor proposal.`);
      }
    } else if (target.documentVersion !== null) {
      throw new Error(`The open document state changed for ${target.path}. Create a fresh refactor proposal.`);
    }
    if (proposal.operation === "rename_symbol") {
      const disk = await invoke("project_read_file", { path: target.path });
      if (state.project.root !== proposal.projectRoot) throw new Error("The active project changed while the proposal was being checked.");
      if (String(disk?.content || "") !== target.before) {
        throw new Error(`The disk content changed for ${target.path}. Reload References and try again.`);
      }
    }
    if (proposal.operation === "format_document" && target.documentVersion === null) {
      throw new Error(`The document version is unavailable for ${target.path}. Reopen the file and try again.`);
    }
    validated.push({ target, documentState });
  }
  return validated;
}

function replaceRefactorDocumentContent(target, content) {
  let documentState = state.documents[target.path];
  if (!documentState) {
    documentState = {
      path: target.path,
      content: target.before,
      savedContent: target.savedContent,
      language: target.path.toLowerCase().endsWith(".r") ? "r" : "plaintext",
      versionId: 0,
      lastExecutedRange: null,
      cursorStart: 0,
      cursorEnd: 0,
      conflictDiskContent: null,
    };
    state.documents[target.path] = documentState;
  }
  if (state.editor.monaco) {
    const model = ensureDocumentModel(documentState);
    state.editor.suppressChange = true;
    try {
      model.pushStackElement();
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content, forceMoveMarkers: true }], () => null);
      model.pushStackElement();
    } finally {
      state.editor.suppressChange = false;
    }
    documentState.content = model.getValue();
    documentState.versionId = model.getAlternativeVersionId();
  } else {
    if (state.editor.mode === "textarea" && state.activeDocument === target.path) {
      const editor = fallbackEditor();
      editor.value = content;
      editor.selectionStart = 0;
      editor.selectionEnd = 0;
      recordFallbackEditorChange("refactor");
    }
    documentState.content = content;
    documentState.versionId = (documentState.versionId || 0) + 1;
  }
  documentState.cursorStart = 0;
  documentState.cursorEnd = 0;
  documentState.conflictDiskContent = null;
  return documentState.versionId;
}

async function applyRefactorProposal() {
  const proposal = state.refactor.proposal;
  const formatting = proposal?.operation === "format_document";
  const button = $("#refactorReviewApply");
  button.disabled = true;
  const appliedTargets = [];
  try {
    await validateRefactorProposal(proposal);
    for (const target of proposal.targets) {
      const applied = { ...target, appliedVersion: null };
      appliedTargets.push(applied);
      applied.appliedVersion = replaceRefactorDocumentContent(target, target.after);
    }
    state.activeDocument = proposal.targets[0].path;
    renderActiveDocument();
    state.problems = state.problems.filter((problem) => !proposal.targets.some((target) => target.path === problem.source_path && problem.origin === "lintr"));
    state.lint.status = "idle";
    state.refactor.undo = { projectRoot: proposal.projectRoot, proposal, targets: appliedTargets };
    state.refactor.status = "applied";
    setRefactorReviewError();
    renderProblems();
    renderRefactorReview();
    scheduleSessionSave();
    toast(formatting
      ? "Formatting applied to the editor buffer. Save to persist."
      : `Refactor applied to ${proposal.targets.length} editor buffer${proposal.targets.length === 1 ? "" : "s"}. Save to persist.`);
  } catch (error) {
    for (const target of [...appliedTargets].reverse()) {
      try {
        if (target.wasOpen) {
          replaceRefactorDocumentContent(target, target.before);
        } else {
          state.editor.models.get(target.path)?.dispose();
          state.editor.models.delete(target.path);
          delete state.documents[target.path];
        }
      } catch (_) { /* keep the original rejection visible */ }
    }
    state.refactor.status = "stale";
    setRefactorReviewError(error);
    renderRefactorReview();
  } finally {
    button.disabled = false;
  }
}

async function undoRefactorProposal() {
  const undo = state.refactor.undo;
  const formatting = undo?.proposal?.operation === "format_document";
  const button = $("#refactorReviewUndo");
  if (!undo) return;
  button.disabled = true;
  const revertedTargets = [];
  try {
    if (undo.projectRoot !== state.project.root) throw new Error(`The active project changed, so ${formatting ? "formatting" : "refactor"} undo was stopped.`);
    for (const target of undo.targets) {
      if (state.activeDocument === target.path) syncDocumentFromEditor({ render: false, persist: false });
      const documentState = state.documents[target.path];
      if (!documentState || documentState.versionId !== target.appliedVersion || documentState.content !== target.after) {
        throw new Error(`The editor changed after ${formatting ? "formatting" : "the refactor"} in ${target.path}; automatic undo was stopped.`);
      }
    }
    for (const target of undo.targets) {
      revertedTargets.push(target);
      replaceRefactorDocumentContent(target, target.before);
    }
    state.activeDocument = undo.targets[0].path;
    renderActiveDocument();
    state.refactor.undo = null;
    state.refactor.status = "undone";
    setRefactorReviewError();
    renderRefactorReview();
    scheduleSessionSave();
    toast(formatting ? "Formatting undone in the editor." : "Refactor undone in the editor.");
  } catch (error) {
    for (const target of [...revertedTargets].reverse()) {
      try { replaceRefactorDocumentContent(target, target.after); } catch (_) { /* keep the undo failure visible */ }
    }
    state.refactor.status = "stale";
    setRefactorReviewError(error);
    renderRefactorReview();
  } finally {
    button.disabled = false;
  }
}

function renderExecution(response, request) {
  const execution = response.execution || {};
  updateIdentity(response.workspace);
  addTerminalOutput(execution.stdout);
  asMessageList(execution.messages).forEach((message) => addTerminalOutput(message));
  asMessageList(execution.warnings).forEach((warning) => addTerminalOutput(warning, "warning"));
  if (execution.value) addTerminalOutput(execution.value);
  if (execution.error) {
    const errorMessage = execution.error.message || "R execution failed.";
    if (execution.kind !== "render") {
      addConsoleExecutionError(errorMessage, { runId: response.execution_id || null });
      addProblem(errorMessage, execution.error.call || "", {
        runId: response.execution_id || null,
        origin: "user",
        status: "failed",
        sourcePath: request?.sourcePath || null,
        executionMode: request?.type || null,
        documentVersion: request?.documentVersion ?? null,
        traceback: execution.traceback || execution.calls || [],
      });
    } else {
      addTerminalOutput(errorMessage, "error");
    }
  }
  if (execution.ok === false && !execution.error && execution.kind !== "render") {
    const errorMessage = "R execution failed.";
    addConsoleExecutionError(errorMessage, { runId: response.execution_id || null });
    addProblem(errorMessage, "", {
      runId: response.execution_id || null,
      origin: "user",
      status: "failed",
      sourcePath: request?.sourcePath || null,
      executionMode: request?.type || null,
      documentVersion: request?.documentVersion ?? null,
    });
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
      addLog("SYSTEM", `Render completed · ${execution.output_path || execution.source_path || "output"}`);
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
    if (event.type === "stream") addTerminalOutput(event.text, event.name === "stderr" ? "error" : "");
    if (event.type === "error") addTerminalOutput(event.traceback || "R execution failed", "error");
    if (event.type === "display_data") renderDisplay(event.data || {});
  }
}

function executionHelpTarget(response) {
  const target = response?.execution?.help;
  if (!target || typeof target !== "object" || typeof target.topic !== "string") return null;
  if (!target.topic.trim() || /[\u0000-\u001f\u007f]/.test(target.topic)) return null;
  if (new TextEncoder().encode(target.topic).length > 128) return null;
  if (target.package != null && (
    typeof target.package !== "string"
    || target.package.length > 128
    || !/^[A-Za-z][A-Za-z0-9.]*$/.test(target.package)
  )) return null;
  return { topic: target.topic, package: target.package || null };
}

function executionHasRenderablePlot(response) {
  return asMessageList(response?.events).some((wrapped) => {
    const event = wrapped.event || wrapped;
    const data = event?.type === "display_data" ? event.data : null;
    return Boolean(plotImageSource(data));
  });
}

function normalizeBase64Padding(value) {
  const compact = String(value || "").replace(/\s/g, "");
  const match = /^([A-Za-z0-9+/]*)(={0,2})$/.exec(compact);
  const core = match?.[1] || "";
  const paddingLength = match?.[2]?.length || 0;
  if (!core || core.length % 4 === 1 || (paddingLength && compact.length % 4 !== 0)) return null;
  return core.padEnd(core.length + ((4 - core.length % 4) % 4), "=");
}

function plotImageSource(data) {
  const payload = data && typeof data === "object" ? data : {};
  if (payload["image/png"]) {
    const encoded = normalizeBase64Padding(payload["image/png"]);
    return encoded ? `data:image/png;base64,${encoded}` : null;
  }
  if (payload["image/svg+xml"]) return `data:image/svg+xml;base64,${payload["image/svg+xml"]}`;
  return payload["rho/mock-image"] || null;
}

function renderDisplay(data) {
  const payload = data && typeof data === "object" ? data : {};
  const source = plotImageSource(payload);
  if (!source) {
    $("#plotImage").classList.add("hidden");
    $("#plotEmpty").classList.remove("hidden");
    const emptyLabel = $("#plotEmpty strong");
    if (emptyLabel) {
      emptyLabel.textContent = payload["rho/pruned"] ? "Preview no longer stored" : "Plot preview unavailable";
    }
    return;
  }
  const image = $("#plotImage");
  image.onerror = () => {
    if (image.src === source) {
      showPlotSurfaceState("failed", "Plot preview unavailable", "The plot image could not be displayed.");
    }
  };
  image.src = source;
  image.classList.remove("hidden");
  $("#plotEmpty").classList.add("hidden");
  const emptyLabel = $("#plotEmpty strong");
  if (emptyLabel) emptyLabel.textContent = "No plots yet";
}

function activePlotRecord() {
  return state.plots.find((plot) => plot.plot_id === state.selectedPlotId) || state.plots[0] || null;
}

function artifactKindLabel(kind) {
  return {
    plot_export: "Plot export",
    table_export: "Table export",
    render_output: "Render output",
    generated_file: "Generated file",
  }[kind] || kind || "Artifact";
}

function artifactFileTypeLabel(artifact) {
  const mediaType = String(artifact?.media_type || "").toLowerCase();
  const mediaLabels = {
    "image/png": "PNG",
    "image/jpeg": "JPEG",
    "image/gif": "GIF",
    "image/webp": "WebP",
    "text/csv": "CSV",
    "text/tab-separated-values": "TSV",
    "text/html": "HTML",
    "text/markdown": "Markdown",
    "text/x-r": "R source",
    "text/x-r-markdown": "R Markdown",
    "application/json": "JSON",
    "text/plain": "Text",
  };
  if (mediaLabels[mediaType]) return mediaLabels[mediaType];
  const filename = pathFileName(artifact?.output_path);
  const extension = filename.split(".").at(-1);
  return extension && extension !== filename ? extension.toUpperCase() : "File";
}

function artifactListSourceLabel(artifact) {
  const sourcePath = String(artifact?.source_path || "");
  if (!sourcePath) return "Workspace R output";
  if (artifact?.provenance_complete) return `From ${displayPath(sourcePath)}`;
  return `Source link incomplete · ${displayPath(sourcePath)}`;
}

function artifactStateLabel(detail) {
  if (!detail) return "Not selected";
  if (!detail.file_available) return "File missing";
  return detail.artifact?.provenance_complete ? "Available" : "Needs source details";
}

function displayPath(value) {
  return String(value || "")
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/i, "")
    .replace(/^\/\/\?\/UNC\//i, "//")
    .replace(/^\/\/\?\//i, "");
}

function pathFileName(path) {
  return displayPath(path).replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || "Untitled output";
}

function plotSourceLabel(plot) {
  const sourcePath = String(plot?.source_path || "");
  if (!sourcePath || sourcePath === "<console>") return "Created from Console";
  if (/^<[^<>]+>$/.test(sourcePath)) return "Created from R";
  return `Created from ${pathFileName(sourcePath)}`;
}

function plotReviewState(plot) {
  if (plotPayloadPruned(plot)) return "Preview removed to save space";
  if (!plotHasRenderablePayload(plot)) return "Preview unavailable";
  return plot.provenance_complete ? "Ready to review" : "Source details unavailable";
}

function formatTimestamp(value) {
  if (!value) return "unknown time";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function defaultPlotExportPath(plot) {
  const source = String(plot?.source_path || "")
    .split("/")
    .filter(Boolean)
    .at(-1)
    ?.replace(/\.[^.]+$/, "");
  const stem = source || plot?.execution_mode || "plot";
  return `artifacts/${stem}.png`;
}

function defaultDataViewExportPath(page, view) {
  const extension = page?.view_kind === "col_data" ? "tsv" : "csv";
  return `artifacts/${page?.object_name || "view"}-${view?.key || page?.view_kind || "table"}.${extension}`;
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function plotPayloadPruned(plot) {
  return Boolean(parseJsonObject(plot?.payload_json)?.["rho/pruned"]);
}

function plotHasRenderablePayload(plot) {
  const payload = parseJsonObject(plot?.payload_json);
  return Boolean(payload?.["image/png"] || payload?.["image/svg+xml"] || payload?.["rho/mock-image"]);
}

function renderArtifactDetail() {
  const detail = state.selectedArtifactDetail;
  const card = $("#artifactDetailCard");
  const action = $("#artifactOpenSourceButton");
  card.className = "render-result-card";
  if (!detail?.artifact) {
    card.classList.add("hidden");
    $("#artifactDetailTitle").textContent = "Saved output";
    $("#artifactDetailState").textContent = "Not selected";
    $("#artifactDetailSummary").textContent = "Select a saved file to review where it came from and whether it is still available.";
    $("#artifactDetailPath").textContent = "";
    action.disabled = true;
    return;
  }
  const artifact = detail.artifact;
  card.classList.remove("hidden");
  if (!detail.file_available) card.classList.add("error");
  else if (artifact.provenance_complete) card.classList.add("success");
  $("#artifactDetailTitle").textContent = pathFileName(artifact.output_path);
  $("#artifactDetailState").textContent = artifactStateLabel(detail);
  $("#artifactDetailSummary").textContent = detail.file_available
    ? (artifact.provenance_complete
      ? `This ${artifactKindLabel(artifact.artifact_kind).toLowerCase()} is available and linked to its source.`
      : "The file is available, but Rho could not capture all of its source details.")
    : "This saved file is no longer at its recorded location. Export or render it again to recreate it.";
  $("#artifactDetailPath").textContent = [
    `Saved to ${displayPath(detail.output_absolute_path)}`,
    artifact.source_path ? `Created from ${displayPath(artifact.source_path)}` : "Created from Workspace R",
    formatTimestamp(artifact.created_at),
  ].join(" · ");
  action.disabled = !artifact.source_path;
}

function renderArtifactRecords() {
  const list = $("#artifactRecordList");
  const outputList = $("#artifactOutputList");
  list.replaceChildren();
  outputList.replaceChildren();
  $("#artifactOutputCount").textContent = String(state.artifacts.length);
  $("#savedOutputCount").textContent = String(state.artifacts.length);
  const empty = $("#artifactEmpty");
  empty.classList.toggle("hidden", state.artifacts.length > 0);
  for (const artifact of state.artifacts) {
    const selected = artifact.artifact_id === state.selectedArtifactId;
    const row = document.createElement("button");
    row.type = "button";
    row.className = `plot-history-row artifact-row ${selected ? "active" : ""}`;
    const title = document.createElement("strong");
    title.textContent = `${artifactKindLabel(artifact.artifact_kind)} · ${pathFileName(artifact.output_path)}`;
    const line1 = document.createElement("p");
    line1.textContent = `${artifact.source_path ? `Created from ${displayPath(artifact.source_path)}` : "Created from Workspace R"} · ${formatTimestamp(artifact.created_at)}`;
    const line2 = document.createElement("p");
    line2.textContent = artifact.provenance_complete
      ? "Source details captured"
      : "Some source details are unavailable";
    row.append(title, line1, line2);
    row.addEventListener("click", async () => {
      state.selectedArtifactId = artifact.artifact_id;
      try {
        state.selectedArtifactDetail = await invoke("get_artifact_record", { artifactId: artifact.artifact_id });
      } catch (error) {
        state.selectedArtifactDetail = null;
        toast(reportUiFailure("open saved output", error, "Saved output details are unavailable. Refresh Outputs and try again."), true);
      }
      renderPlots();
      $("#artifactPanel").open = true;
      if (state.posture === "agent") openAgentWorkSurface("artifact");
    });
    list.append(row);

    const output = document.createElement("button");
    output.type = "button";
    output.className = `tree-item plot-output-item ${selected ? "active" : ""}`;
    const outputLabel = document.createElement("span");
    outputLabel.textContent = displayPath(artifact.output_path);
    const outputIndex = document.createElement("small");
    outputIndex.textContent = artifactKindLabel(artifact.artifact_kind);
    output.append(outputLabel, outputIndex);
    output.addEventListener("click", async () => {
      switchDockTab("plots");
      state.selectedArtifactId = artifact.artifact_id;
      try {
        state.selectedArtifactDetail = await invoke("get_artifact_record", { artifactId: artifact.artifact_id });
      } catch (error) {
        state.selectedArtifactDetail = null;
        toast(reportUiFailure("open saved output", error, "Saved output details are unavailable. Refresh Outputs and try again."), true);
      }
      renderPlots();
      $("#artifactPanel").open = true;
      if (state.posture === "agent") openAgentWorkSurface("artifact");
    });
    outputList.append(output);
  }
  renderArtifactDetail();
}

function showPlotSurfaceState(stateName, title, detail) {
  const empty = $("#plotEmpty");
  empty.dataset.state = stateName;
  empty.querySelector("strong").textContent = title;
  $("#plotEmptyDetail").textContent = detail;
  empty.querySelector("use").setAttribute("href", stateName === "failed" ? "#icon-triangle-alert" : "#icon-image");
  empty.classList.remove("hidden");
  $("#plotImage").classList.add("hidden");
}

function renderPlots() {
  const history = $("#plotHistory");
  const outputList = $("#plotOutputList");
  history.replaceChildren();
  outputList.replaceChildren();
  const plots = state.plots || [];
  const selectedPlot = activePlotRecord();
  $$('[data-plot-scope]').forEach((button) => button.classList.toggle("active", button.dataset.plotScope === state.plotScope));
  $("#plotCount").textContent = String(plots.length);
  $("#plotOutputCount").textContent = String(plots.length);
  $("#plotNavigatorCount").textContent = String(plots.length);
  $("#plotExportButton").disabled = !(selectedPlot && plotHasRenderablePayload(selectedPlot));
  if (!plots.length) {
    showPlotSurfaceState("empty", "No plots yet", "Run plotting code in Workspace R to create a preview.");
    renderArtifactRecords();
    renderAgentOutputs();
    return;
  }
  $("#plotEmpty").classList.add("hidden");
  try {
    const payload = JSON.parse((selectedPlot || plots[0]).payload_json || "null");
    if (!payload || typeof payload !== "object") throw new Error("Invalid plot payload");
    if (payload?.["rho/pruned"]) {
      showPlotSurfaceState(
        "warning",
        "Preview no longer stored",
        "Rho freed this preview to save space. The plot remains in history and saved files are unchanged.",
      );
    } else if (payload?.["image/png"] || payload?.["image/svg+xml"] || payload?.["rho/mock-image"]) {
      renderDisplay(payload);
      const selectedIndex = plots.findIndex((plot) => plot.plot_id === selectedPlot?.plot_id);
      $("#plotImage").alt = `Plot ${Math.max(0, selectedIndex) + 1}, ${plotSourceLabel(selectedPlot || plots[0])}`;
    } else {
      throw new Error("Unsupported plot payload");
    }
  } catch {
    showPlotSurfaceState(
      "failed",
      "Plot preview unavailable",
      "The plot remains in history, but its preview data could not be displayed.",
    );
  }
  for (const [index, plot] of plots.entries()) {
    const selected = plot.plot_id === selectedPlot?.plot_id;
    const row = document.createElement("button");
    row.type = "button";
    row.className = `plot-history-row ${selected ? "active" : ""}`;
    const thumbnail = document.createElement("span");
    thumbnail.className = "plot-history-thumbnail";
    const thumbnailSource = plotImageSource(parseJsonObject(plot.payload_json));
    if (thumbnailSource) {
      const image = document.createElement("img");
      image.src = thumbnailSource;
      image.alt = "";
      thumbnail.append(image);
    } else {
      const fallback = document.createElement("svg");
      fallback.className = "ui-icon";
      fallback.setAttribute("aria-hidden", "true");
      fallback.innerHTML = '<use href="#icon-image"></use>';
      thumbnail.append(fallback);
    }
    const content = document.createElement("span");
    content.className = "plot-history-content";
    const title = document.createElement("strong");
    title.textContent = `Plot ${index + 1}`;
    const line1 = document.createElement("p");
    line1.textContent = plotSourceLabel(plot);
    const line2 = document.createElement("p");
    line2.textContent = `${plotReviewState(plot)} · ${formatTimestamp(plot.created_at)}`;
    content.append(title, line1, line2);
    row.append(thumbnail, content);
    row.addEventListener("click", () => {
      state.selectedPlotId = plot.plot_id;
      try {
        renderDisplay(parseJsonObject(plot.payload_json));
        $("#plotImage").alt = `Plot ${index + 1}, ${plotSourceLabel(plot)}`;
      } catch {
        toast("This plot preview is unavailable.", true);
      }
      renderPlots();
    });
    history.append(row);

    const output = document.createElement("button");
    output.type = "button";
    output.className = `tree-item plot-output-item ${selected ? "active" : ""}`;
    const outputLabel = document.createElement("span");
    outputLabel.textContent = !plot.source_path || plot.source_path === "<console>"
      ? `Console plot ${index + 1}`
      : displayPath(plot.source_path);
    const outputIndex = document.createElement("small");
    outputIndex.textContent = `Plot ${index + 1}`;
    output.append(outputLabel, outputIndex);
    output.addEventListener("click", () => {
      switchDockTab("plots");
      state.selectedPlotId = plot.plot_id;
      try {
        renderDisplay(parseJsonObject(plot.payload_json));
      } catch {
        toast("This plot preview is unavailable.", true);
      }
      renderPlots();
    });
    outputList.append(output);
  }
  renderArtifactRecords();
  renderAgentOutputs();
}

async function executeCode(request) {
  if (state.busy || !request?.code?.trim()) return;
  setBusy(true);
  addTerminalCommand(request.code);
  let plotExecutionId = null;
  try {
    const response = await invoke("execute_r", {
      request: {
        code: request.code,
        source_path: request.sourcePath ?? null,
        execution_mode: request.type ?? null,
        document_version: request.documentVersion ?? null,
        source_range: request.sourceRange ?? null,
      },
    });
    const documentState = activeDocument();
    if (documentState && request.type !== "console") documentState.lastExecutedRange = request.range || null;
    renderExecution(response, request);
    if (executionHasRenderablePlot(response)) plotExecutionId = response.execution_id || null;
    const helpTarget = request.type === "console" ? executionHelpTarget(response) : null;
    if (helpTarget) await showLocalHelp(helpTarget.topic, helpTarget.package);
  } catch (error) {
    const message = userFacingError(error, "The connection could not be verified. Review the provider settings and try again.");
    addTerminalOutput(message, "error");
    addProblem(message);
    toast(message, true);
  } finally {
    await Promise.all([loadRunData(), refreshEnvironment()]);
    if (plotExecutionId) {
      const plot = state.plots.find((item) => item.run_id === plotExecutionId);
      if (plot) state.selectedPlotId = plot.plot_id;
      renderPlots();
      switchDockTab("plots");
    }
    setBusy(false);
    if (!$("#consolePanel").classList.contains("hidden")) $("#consoleInput").focus();
  }
}

async function gotoDefinitionAtCursor() {
  const editor = state.editor?.editor;
  if (!editor) return;
  const pos = editor.getPosition();
  if (!pos) return;
  const model = editor.getModel();
  if (!model) return;
  const word = model.getWordAtPosition(pos);
  if (!word) return;
  const name = word.word;

  try {
    const result = await invoke("editor_goto_definition", { name });
    if (result?.file) {
      // Open the file and jump to the definition line
      await openDocument(result.file);
      if (state.editor?.editor && result.line) {
        state.editor.editor.revealLineInCenter(result.line);
        state.editor.editor.setPosition({
          lineNumber: result.line,
          column: result.column || 1,
        });
        state.editor.editor.focus();
      }
    } else {
      // Fall back to help
      await showLocalHelp(name);
      toast(`No project definition for '${name}' — opening help`);
    }
  } catch (error) {
    toast(reportUiFailure("open definition", error, "The definition could not be opened. Try Local Help or refresh the project."), true);
  }
}

function appendLocalHelpLocation(container, label, value) {
  if (!value) return;
  const row = document.createElement("div");
  row.className = "local-help-location";
  const heading = document.createElement("span");
  heading.textContent = label;
  const path = document.createElement("code");
  path.textContent = value;
  row.append(heading, path);
  container.append(row);
}

function appendInstalledHelpText(container, headingText, value, code = false) {
  if (!value) return;
  const section = document.createElement("section");
  section.className = "installed-help-section";
  const heading = document.createElement("h3");
  heading.textContent = headingText;
  const body = document.createElement(code ? "pre" : "p");
  body.textContent = value;
  section.append(heading, body);
  container.append(section);
}

function setInstalledHelpView(view) {
  state.installedHelp.activeView = view;
  renderLocalHelp();
}

async function runInstalledHelpExample() {
  const documentation = state.installedHelp.record;
  const example = documentation?.example;
  if (state.busy || state.installedHelp.running || !example?.executable || !example.code?.trim()) return;
  const confirmed = await confirmAction({
    title: "Run reviewed Help example",
    message: `Run the displayed ${documentation.package}::${documentation.help_topic || documentation.name} example in Workspace R? Ordinary R code may change the Workspace, create files, produce plots, or fail.`,
    confirmLabel: "Run example",
    cancelLabel: "Cancel",
  });
  if (!confirmed) return;
  state.installedHelp.running = true;
  renderLocalHelp();
  switchDockTab("console");
  try {
    await executeCode({
      code: example.code,
      type: "help_example",
      sourcePath: null,
      documentVersion: null,
    });
  } finally {
    state.installedHelp.running = false;
    renderLocalHelp();
  }
}

function renderInstalledHelp(container) {
  const wrapper = document.createElement("div");
  wrapper.className = "installed-help";
  const header = document.createElement("div");
  header.className = "installed-help-header";
  const heading = document.createElement("strong");
  heading.textContent = "Installed documentation";
  const status = document.createElement("span");
  status.className = "revision-badge";
  status.textContent = userFacingStatus(state.installedHelp.status, {
    loading: "Loading", found: "Available", unavailable: "Not found", empty: "Not requested", error: "Unavailable",
  }, "Not requested");
  header.append(heading, status);
  wrapper.append(header);

  if (state.installedHelp.status === "loading") {
    wrapper.append(emptyRow("Loading installed documentation"));
    container.append(wrapper);
    return;
  }
  if (state.installedHelp.status === "error") {
    const error = emptyRow("Installed documentation unavailable");
    const detail = document.createElement("p");
    detail.textContent = userFacingError(state.installedHelp.error, "The installed documentation could not be opened.");
    error.append(detail);
    wrapper.append(error);
    container.append(wrapper);
    return;
  }
  const record = state.installedHelp.record;
  if (!record?.found) {
    wrapper.append(emptyRow(record ? `No installed documentation found for ${record.package}::${record.name}` : "Documentation not requested"));
    container.append(wrapper);
    return;
  }

  const identity = document.createElement("p");
  identity.className = "installed-help-identity";
  identity.textContent = `${record.package} ${record.package_version || "version unavailable"} · ${record.help_topic || record.name}`;
  wrapper.append(identity);
  const views = ["overview", "arguments", "examples", "vignettes"];
  const tabs = document.createElement("div");
  tabs.className = "installed-help-tabs";
  tabs.setAttribute("role", "tablist");
  for (const view of views) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(state.installedHelp.activeView === view));
    button.classList.toggle("active", state.installedHelp.activeView === view);
    button.textContent = view[0].toUpperCase() + view.slice(1);
    button.addEventListener("click", () => setInstalledHelpView(view));
    tabs.append(button);
  }
  wrapper.append(tabs);
  const body = document.createElement("div");
  body.className = "installed-help-body";
  const view = state.installedHelp.activeView;
  if (view === "overview") {
    appendInstalledHelpText(body, record.title || "Overview", record.description);
    appendInstalledHelpText(body, "Usage", record.usage, true);
    appendInstalledHelpText(body, "Details", record.details);
    appendInstalledHelpText(body, "Value", record.value);
    if (!record.title && !record.description && !record.usage && !record.details && !record.value) {
      body.append(emptyRow("No overview sections in this installed Help record"));
    }
  } else if (view === "arguments") {
    if (!record.arguments?.length) {
      body.append(emptyRow("No documented arguments"));
    } else {
      const list = document.createElement("dl");
      list.className = "installed-help-arguments";
      for (const argument of record.arguments) {
        const term = document.createElement("dt");
        term.textContent = argument.name || "argument";
        const description = document.createElement("dd");
        description.textContent = argument.description || "";
        list.append(term, description);
      }
      body.append(list);
    }
  } else if (view === "examples") {
    if (!record.example?.code) {
      body.append(emptyRow("No runnable example in this installed Help record"));
    } else {
      const code = document.createElement("pre");
      code.className = "installed-help-example";
      code.textContent = record.example.code;
      body.append(code);
      if (record.example.omitted_tags?.length || record.example.parse_error) {
        const note = document.createElement("p");
        note.className = "installed-help-warning";
        note.textContent = record.example.parse_error
          ? userFacingError(record.example.parse_error, "Some parts of this example cannot be run here.")
          : "Some documentation-only sections are not included in the runnable example.";
        body.append(note);
      }
      const run = document.createElement("button");
      run.type = "button";
      run.className = "installed-help-run";
      run.textContent = state.installedHelp.running ? "Running..." : "Run reviewed example";
      run.disabled = !record.example.executable || state.busy || state.installedHelp.running;
      run.addEventListener("click", runInstalledHelpExample);
      body.append(run);
    }
  } else if (!record.vignettes?.length) {
    body.append(emptyRow("No installed vignettes"));
  } else {
    const list = document.createElement("div");
    list.className = "installed-help-vignettes";
    for (const vignette of record.vignettes) {
      const row = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = vignette.title || vignette.topic;
      const topic = document.createElement("code");
      topic.textContent = vignette.topic;
      row.append(title, topic);
      list.append(row);
    }
    body.append(list);
  }
  wrapper.append(body);
  if (record.incomplete || record.truncated) {
    const warning = document.createElement("p");
    warning.className = "installed-help-warning";
    warning.textContent = "Showing the available part of this documentation.";
    wrapper.append(warning);
  }
  container.append(wrapper);
}

function renderLocalHelp() {
  const content = $("#localHelpContent");
  const badge = $("#localHelpState");
  content.replaceChildren();
  badge.textContent = userFacingStatus(state.localHelp.status, {
    loading: "Loading", found: "Available", unavailable: "Not found", error: "Unavailable",
  }, "Not selected");
  if (state.localHelp.status === "loading") {
    content.append(emptyRow("Resolving local Help"));
    return;
  }
  if (state.localHelp.status === "error") {
    const error = emptyRow("Local Help unavailable");
    const detail = document.createElement("p");
    detail.textContent = userFacingError(state.localHelp.error, "The installed Help record could not be opened.");
    error.append(detail);
    content.append(error);
    return;
  }
  const record = state.localHelp.record;
  if (!record?.found) {
    content.append(emptyRow(record ? `No installed Help found for ${record.name}` : "No symbol selected"));
    return;
  }
  const summary = document.createElement("div");
  summary.className = "local-help-summary";
  const title = document.createElement("strong");
  title.textContent = `${record.package || "R"}::${record.name}`;
  const note = document.createElement("p");
  note.textContent = record.help_topic ? `Local topic: ${record.help_topic}` : "Installed function location";
  summary.append(title, note);
  content.append(summary);
  if (record.signature) {
    const signature = document.createElement("code");
    signature.className = "local-help-signature";
    signature.textContent = record.signature;
    content.append(signature);
  }
  appendLocalHelpLocation(content, "Source reference", record.source_path ? `${displayPath(record.source_path)}${record.source_line ? `:${record.source_line}` : ""}` : null);
  if (record.ambiguous || record.truncated) {
    const warning = document.createElement("p");
    warning.className = "local-help-warning";
    warning.textContent = [
      record.ambiguous ? "Multiple local Help records matched; the first result in R's lookup order is shown." : null,
      record.truncated ? "Some long details are not shown." : null,
    ].filter(Boolean).join(" ");
    content.append(warning);
  }
  renderLocalHelpAgentAction(content);
  renderInstalledHelp(content);
}

async function showLocalHelp(name, packageName = null) {
  applyWorkbenchLayout("analyze");
  await switchContextTab("help");
  state.localHelp = { status: "loading", record: null, error: null };
  state.installedHelp = { status: "empty", record: null, error: null, activeView: "overview", running: false };
  renderLocalHelp();
  $("#localHelpHeading").focus();
  try {
    const recordResponse = await invoke("editor_function_help", { name, package: packageName });
    const record = helpRecordFromResponse(recordResponse);
    state.localHelp = { status: record?.found ? "found" : "unavailable", record, error: null };
    renderLocalHelp();
    if (record?.found && record.package) {
      state.installedHelp.status = "loading";
      renderLocalHelp();
      try {
        const documentationResponse = await invoke("editor_function_documentation", { name: record.help_topic || record.name, package: record.package });
        const documentation = helpRecordFromResponse(documentationResponse);
        state.installedHelp = {
          status: documentation?.found ? "found" : "unavailable",
          record: documentation,
          error: null,
          activeView: "overview",
          running: false,
        };
      } catch (error) {
        state.installedHelp = { status: "error", record: null, error: String(error), activeView: "overview", running: false };
      }
    }
  } catch (error) {
    state.localHelp = { status: "error", record: null, error: String(error) };
  }
  renderLocalHelp();
  return state.localHelp.record;
}

function helpRecordFromResponse(response) {
  const execution = response?.execution;
  if (execution && typeof execution === "object" && ("found" in execution || "help_topic" in execution || "package" in execution)) {
    return execution;
  }
  return response;
}

async function openProjectReference(reference) {
  if (!reference?.file || !state.project.files.some((file) => file.path === reference.file)) {
    toast(`Reference file is no longer available: ${reference?.file || "unknown"}`, true);
    return;
  }
  await openDocument(reference.file);
  if (state.activeDocument !== reference.file || !state.editor?.editor) return;
  const line = Math.max(1, Number(reference.line) || 1);
  const column = Math.max(1, Number(reference.column) || 1);
  state.editor.editor.revealLineInCenter(line);
  state.editor.editor.setPosition({ lineNumber: line, column });
  state.editor.editor.focus();
}

function renderProjectReferences() {
  const content = $("#projectReferencesContent");
  const badge = $("#projectReferencesState");
  content.replaceChildren();
  badge.textContent = userFacingStatus(state.projectReferences.status, {
    loading: "Searching", found: "Matches found", empty: "No matches", incomplete: "Partial results", truncated: "Partial results", error: "Unavailable",
  }, "Not selected");
  if (state.projectReferences.status === "loading") {
    content.append(emptyRow("Searching project references"));
    return;
  }
  if (state.projectReferences.status === "error") {
    const error = emptyRow("Project references unavailable");
    const detail = document.createElement("p");
    detail.textContent = userFacingError(state.projectReferences.error, "Project references could not be searched.");
    error.append(detail);
    content.append(error);
    return;
  }
  const record = state.projectReferences.record;
  if (!record) {
    content.append(emptyRow("No symbol selected"));
    return;
  }
  const summary = document.createElement("div");
  summary.className = "project-references-summary";
  const title = document.createElement("strong");
  title.textContent = record.name;
  const count = document.createElement("p");
  count.textContent = `${record.matched_count || 0} matches across ${record.files_scanned || 0} files`;
  summary.append(title, count);
  content.append(summary);
  if (!record.references?.length) {
    content.append(emptyRow(`No project references found for ${record.name}`));
  } else {
    const list = document.createElement("div");
    list.className = "project-reference-list";
    for (const reference of record.references) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "project-reference-row";
      const location = document.createElement("span");
      location.className = "project-reference-location";
      location.textContent = `${reference.file}:${reference.line}`;
      const kind = document.createElement("span");
      kind.className = `project-reference-kind ${reference.kind === "definition" ? "definition" : ""}`;
      kind.textContent = reference.kind === "definition" ? "Definition" : "Reference";
      const preview = document.createElement("code");
      preview.textContent = reference.preview || "";
      button.append(location, kind, preview);
      button.addEventListener("click", () => openProjectReference(reference));
      list.append(button);
    }
    content.append(list);
  }
  if (record.incomplete || record.truncated) {
    const warning = document.createElement("p");
    warning.className = "project-references-warning";
    const messages = [];
    if (record.incomplete) messages.push("Some project files could not be searched, so these results may be incomplete.");
    if (record.truncated) messages.push(`Showing the first ${record.references?.length || 0} of ${record.matched_count || 0} matches.`);
    warning.textContent = messages.join(" ");
    content.append(warning);
  }
}

async function showProjectReferences(name) {
  applyWorkbenchLayout("analyze");
  await switchContextTab("references");
  state.projectReferences = { status: "loading", record: null, error: null };
  renderProjectReferences();
  $("#projectReferencesHeading").focus();
  try {
    const record = await invoke("editor_find_project_references", { name, limit: 100 });
    state.projectReferences = {
      status: record?.incomplete
        ? "incomplete"
        : record?.truncated
          ? "truncated"
          : record?.references?.length ? "found" : "empty",
      record,
      error: null,
    };
  } catch (error) {
    state.projectReferences = { status: "error", record: null, error: String(error) };
  }
  renderProjectReferences();
  return state.projectReferences.record;
}

async function findProjectReferencesAtCursor() {
  const editor = state.editor?.editor;
  const position = editor?.getPosition();
  const model = editor?.getModel();
  const word = position && model?.getWordAtPosition(position);
  if (!word?.word) {
    toast("Place the cursor on an R symbol to find references.", true);
    return;
  }
  await showProjectReferences(word.word);
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

async function refreshEnvironment({ quiet = false } = {}) {
  const refreshRequestId = ++state.environmentRefreshRequestId;
  const projectRoot = state.project.root;
  const projectRefreshSequence = state.projectRefreshSequence;
  const selectedName = state.selectedObjectName;
  const selectedDetail = state.selectedDataObjectDetail || state.selectedObjectDetail;
  const selectedWorkspace = state.dataViewer.workspace || (selectedDetail ? { ...state.revision } : null);
  try {
    const response = await invoke("snapshot_workspace");
    if (refreshRequestId !== state.environmentRefreshRequestId
        || !viewerProjectRequestIsCurrent(projectRoot, projectRefreshSequence)) return false;
    updateIdentity(response.workspace);
    state.objects = response.execution?.objects || [];
    state.environment = response.execution?.environment || null;
    renderEnvironment();
    loadPackageInventories();
    if (selectedName && selectedDetail && state.selectedObjectName === selectedName) {
      const selectedStillExists = state.objects.some((object) => object.name === selectedName);
      if (!selectedStillExists) {
        clearEnvironmentObjectSelection();
        renderEnvironment();
      } else if (workspaceViewerIdentityChanged(selectedWorkspace, response.workspace)
          || Boolean(state.dataViewer.error?.error_code?.startsWith("stale_"))
          || state.dataViewer.error?.error_code === "viewer_refresh_failed") {
        await inspectEnvironmentObject(selectedName, {
          force: true,
          preserveViewerState: true,
          expectedProjectRoot: projectRoot,
          expectedProjectRefreshSequence: projectRefreshSequence,
        });
      }
    }
    return true;
  } catch (error) {
    if (refreshRequestId !== state.environmentRefreshRequestId) return false;
    if (viewerProjectRequestIsCurrent(projectRoot, projectRefreshSequence)
        && state.selectedDataObjectDetail) {
      state.selectedDataPage = null;
      state.dataViewer.pageRequestId += 1;
      state.dataViewer.error = {
        message: "The current Workspace R state could not be refreshed. Retry Environment before continuing.",
        error_code: "viewer_refresh_failed",
      };
      renderEnvironment();
    }
    if (!quiet) toast(reportUiFailure("refresh R environment", error, "The R environment could not be refreshed. Check the current project and try again."), true);
    return false;
  }
}

async function loadInstalledPackages() {
  try {
    const result = await invoke("list_installed_packages", { limit: 500 });
    state.installedPackages = result?.execution || result;
    renderReproducibilityInventorySummary();
    renderPackageList();
  } catch (error) {
    // Keep the failure visible. A failed inventory query must not look like an
    // empty R library, especially while switching projects or refreshing R.
    state.installedPackages = { error: String(error) };
    renderReproducibilityInventorySummary();
    renderPackageList();
  }
}

async function loadLockfilePackages() {
  try {
    const result = await invoke("list_lockfile_packages", { limit: 500 });
    state.lockfilePackages = result?.execution || result;
  } catch (error) {
    state.lockfilePackages = { error: String(error) };
  }
  renderReproducibilityInventorySummary();
  renderPackageList();
}

function renderReproducibilityInventorySummary() {
  const installed = state.installedPackages;
  const lockfile = state.lockfilePackages;
  if (!$("#reproducibilityStatus")) return;
  const installedText = installed?.error
    ? "Installed packages unavailable"
    : installed
      ? `${installed.total_count ?? installed.packages?.length ?? 0} installed packages`
      : "Installed packages loading";
  const lockfileText = lockfile?.error
    ? "Lockfile unavailable"
    : lockfile
      ? `${lockfile.total_count ?? lockfile.packages?.length ?? 0} locked packages`
      : "Lockfile loading";
  const renvText = $("#reproducibilityStatus").textContent || "Project package environment status is unavailable.";
  $("#reproducibilityStatus").textContent = `${renvText.split(". Use the inventory")[0]}. ${installedText}; ${lockfileText}.`;
}

function openPackageInventoryDialog(tab = "installed", trigger = null) {
  state.packageInventoryDialog.open = true;
  state.packageInventoryDialog.returnFocus = trigger || document.activeElement;
  switchEnvironmentPackageTab(tab);
  $("#packageInventoryDialog").classList.remove("hidden");
  $("#packageInventoryDialog").setAttribute("aria-hidden", "false");
  $("#packageFilter")?.focus();
}

function closePackageInventoryDialog() {
  $("#packageInventoryDialog").classList.add("hidden");
  $("#packageInventoryDialog").setAttribute("aria-hidden", "true");
  state.packageInventoryDialog.open = false;
  const returnFocus = state.packageInventoryDialog.returnFocus;
  state.packageInventoryDialog.returnFocus = null;
  if (returnFocus?.focus) returnFocus.focus();
}

function loadPackageInventories() {
  return Promise.all([loadInstalledPackages(), loadLockfilePackages()]);
}

function switchEnvironmentPackageTab(tab) {
  state.environmentPackageTab = tab === "lockfile" ? "lockfile" : "installed";
  $$('[data-package-tab]').forEach((button) => {
    const active = button.dataset.packageTab === state.environmentPackageTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  renderPackageList();
}

function renderPackageList() {
  const list = $("#packageList");
  const meta = $("#packageListMeta");
  const summary = $("#packageListSummary");
  const lockfileTab = state.environmentPackageTab === "lockfile";
  const data = lockfileTab ? state.lockfilePackages : state.installedPackages;
  const filter = ($("#packageFilter").value || "").trim().toLowerCase();

  if (!data || data.error) {
    meta.textContent = data?.error
      ? userFacingError(data.error, "The package list is unavailable. Refresh Environment and try again.")
      : "Loading";
    summary.textContent = "";
    list.replaceChildren(emptyRow(data?.error ? "Package list unavailable" : "Loading packages"));
    return;
  }

  if (lockfileTab) {
    renderLockfilePackageList(data, filter, list, meta, summary);
    return;
  }

  const packages = data.packages || [];
  const total = data.total_count || packages.length;
  const truncated = data.truncated;
  meta.textContent = truncated
    ? `Showing ${packages.length} of ${total} packages`
    : `${total} packages`;
  summary.textContent = "Packages visible to the current R library search path.";

  // Get set of attached package names for highlighting
  const attached = state.environment?.attached_packages;
  const attachedPackages = Array.isArray(attached) ? attached : attached?.values || [];
  const attachedNames = new Set(attachedPackages.map((pkg) => pkg.name));

  let visible = filter
    ? packages.filter((p) => p.name.toLowerCase().includes(filter))
    : packages;

  list.replaceChildren();
  if (!visible.length) {
    list.append(emptyRow(filter ? "No packages match the filter" : "No packages installed"));
    return;
  }

  for (const pkg of visible) {
    const row = document.createElement("div");
    row.className = "package-row";
    if (pkg.priority === "base" || pkg.priority === "recommended") {
      row.classList.add("base");
    }
    if (attachedNames.has(pkg.name)) {
      row.classList.add("loaded");
    }

    const name = document.createElement("span");
    name.className = "pkg-name";
    name.textContent = pkg.name;
    name.title = `${pkg.name} ${pkg.version || ""}`.trim();

    const version = document.createElement("span");
    version.className = "pkg-version";
    version.textContent = pkg.version || "";

    const lib = document.createElement("span");
    lib.className = "pkg-library";
    lib.textContent = attachedNames.has(pkg.name) ? "Loaded" : "Available";

    row.append(name, version, lib);
    list.append(row);
  }
}

function renderLockfilePackageList(data, filter, list, meta, summary) {
  const packages = data.packages || [];
  const counts = data.counts || {};
  const lockfile = data.lockfile || {};
  const total = data.total_count;
  const stateLabels = {
    matched: "Matched",
    version_mismatch: "Version mismatch",
    missing_in_library: "Not installed",
    missing_in_lockfile: "Not locked",
  };
  const roleLabels = { direct: "Direct", transitive: "Transitive", unclassified: "Unclassified" };
  const sourceLabels = {
    repository: "Repository", github: "GitHub", gitlab: "GitLab",
    bitbucket: "Bitbucket", git: "Git", url: "URL", local: "Local", unknown: "Unknown source",
  };
  if (lockfile.state === "invalid_lockfile") {
    meta.textContent = "Lockfile needs attention";
    summary.textContent = "Rho could not read renv.lock. Fix the file before comparing package versions.";
    list.replaceChildren(emptyRow("Fix renv.lock before comparing packages"));
    return;
  }
  meta.textContent = data.truncated
    ? `${data.returned_count || packages.length} shown; comparison incomplete`
    : `${total ?? packages.length} packages`;
  summary.textContent = lockfile.state === "no_lockfile"
    ? "No renv.lock. Installed packages are shown as not locked."
    : `Matched ${counts.matched || 0} · Mismatch ${counts.version_mismatch || 0} · Not installed ${counts.missing_in_library || 0} · Not locked ${counts.missing_in_lockfile || 0}`;
  const dependencyRoles = data.dependency_roles || {};
  if (dependencyRoles.state === "available") {
    summary.textContent += dependencyRoles.incomplete ? " · Dependency roles incomplete" : " · Roles from DESCRIPTION";
  } else if (dependencyRoles.state === "no_description") {
    summary.textContent += " · Dependency roles unavailable: no DESCRIPTION";
  } else if (dependencyRoles.state) {
    summary.textContent += " · Package roles could not be read from DESCRIPTION";
  }
  if (data.incomplete && data.incomplete_reasons?.length) {
    summary.textContent += " · Some comparison details are unavailable";
  }

  const visible = filter
    ? packages.filter((pkg) => [
      pkg.name,
      roleLabels[pkg.dependency_role] || pkg.dependency_role,
      sourceLabels[pkg.source?.kind] || pkg.source?.kind,
      pkg.source?.detail,
    ].filter(Boolean).join(" ").toLowerCase().includes(filter))
    : packages;
  list.replaceChildren();
  if (!visible.length) {
    list.append(emptyRow(filter ? "No packages match the search" : "No packages to compare"));
    return;
  }
  const header = document.createElement("div");
  header.className = "package-table-head";
  for (const label of ["Package", "Locked", "Installed", "State", "Action"]) {
    const cell = document.createElement("span");
    cell.textContent = label;
    header.append(cell);
  }
  list.append(header);
  for (const pkg of visible) {
    const row = document.createElement("div");
    row.className = "package-row lockfile";
    const identity = document.createElement("div");
    identity.className = "pkg-identity";
    const name = document.createElement("span");
    name.className = "pkg-name";
    name.textContent = pkg.name || "";
    name.title = pkg.name || "";
    const packageMeta = document.createElement("span");
    packageMeta.className = "pkg-metadata";
    const sourceText = sourceLabels[pkg.source?.kind] || "Unknown source";
    const sourceDetail = pkg.source?.detail ? `: ${pkg.source.detail}` : "";
    packageMeta.textContent = `${roleLabels[pkg.dependency_role] || "Unclassified"} · ${sourceText}${sourceDetail}`;
    packageMeta.title = packageMeta.textContent;
    identity.append(name, packageMeta);
    const locked = document.createElement("span");
    locked.className = "pkg-version";
    locked.textContent = pkg.locked_version || "—";
    const installed = document.createElement("span");
    installed.className = "pkg-version";
    installed.textContent = pkg.installed_version || "—";
    const status = document.createElement("span");
    status.className = `package-state ${pkg.state || ""}`;
    status.textContent = stateLabels[pkg.state] || "Status unavailable";
    status.title = status.textContent;
    const action = document.createElement("span");
    const packageOperation = {
      missing_in_library: ["install_package", "Install"],
      version_mismatch: ["update_package", "Update"],
      missing_in_lockfile: ["remove_package", "Remove"],
    }[pkg.state];
    if (packageOperation) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "package-manage-action";
      button.textContent = packageOperation[1];
      button.title = `${packageOperation[1]} ${pkg.name}`;
      button.addEventListener("click", () => openPackageManagementDialog(packageOperation[0], pkg.name, button));
      action.append(button);
    }
    row.append(identity, locked, installed, status, action);
    list.append(row);
  }
}

function abbreviateLibrary(path) {
  if (!path) return "";
  const parts = path.replace(/\\/g, "/").split("/");
  // Return last meaningful segment: e.g. "4.6" from "C:/.../R/win-library/4.6"
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] && parts[i] !== "library" && parts[i] !== "win-library") {
      return parts[i];
    }
  }
  return parts[parts.length - 1] || path;
}

function emptyRow(text) {
  const div = document.createElement("div");
  div.className = "empty-state compact-empty";
  div.innerHTML = `<strong>${text}</strong>`;
  return div;
}

// ── Evidence panel ───────────────────────────────────────────

async function loadEvidenceEntries() {
  try {
    state.evidenceEntries = await invoke("list_evidence_entries", { limit: 100 });
  } catch {
    state.evidenceEntries = [];
  }
  renderEvidenceList();
  renderEvidenceClaimFormOptions();
}

async function loadEvidenceClaims() {
  $("#evidenceClaimState").textContent = "Loading claims";
  try {
    state.evidenceClaimArtifacts = await invoke("list_artifact_records", { limit: 100, session_only: false });
    state.evidenceClaimArtifactsError = null;
  } catch (error) {
    state.evidenceClaimArtifacts = [];
    state.evidenceClaimArtifactsError = String(error);
  }
  try {
    state.evidenceClaims = await invoke("list_evidence_claims", { limit: 100 });
    const reviews = await Promise.all(state.evidenceClaims.map(async (claim) => {
      try { return [claim.claim_id, await invoke("review_evidence_claim", { claimId: claim.claim_id })]; }
      catch (error) { return [claim.claim_id, { status: "unavailable", claim, evidence: [], limitations: [String(error)] }]; }
    }));
    state.evidenceClaimReviews = new Map(reviews);
    $("#evidenceClaimState").textContent = "Structural review only";
  } catch (error) {
    state.evidenceClaims = [];
    state.evidenceClaimReviews = new Map();
    $("#evidenceClaimState").textContent = reportUiFailure("load evidence claims", error, "Claims are unavailable. Refresh Evidence and try again.");
  }
  renderEvidenceClaims();
  renderEvidenceClaimFormOptions();
}

function claimStatusLabel(status) {
  return ({ linked: "Ready to review", missing_evidence: "Needs evidence", unresolved_source: "Source unavailable", incomplete_evidence: "Review incomplete", cross_project_rejected: "Belongs to another project", unavailable: "Unavailable" })[status] || "Unavailable";
}

function claimKindLabel(kind) {
  return ({ result: "Result", method: "Method", interpretation: "Interpretation" })[kind] || "Claim";
}

function claimLimitationLabel(limitation) {
  const text = String(limitation || "");
  if (/artifact|saved output|anchor/i.test(text)) return "The linked source or saved output is no longer available.";
  if (/no evidence|not linked/i.test(text)) return "No Evidence entry is linked to this claim.";
  if (/metadata|notes|incomplete/i.test(text)) return "Some linked Evidence details are incomplete.";
  if (/project/i.test(text)) return "This claim cannot be reviewed in the current project.";
  return "Some claim details could not be verified.";
}

function renderEvidenceClaimFormOptions() {
  const links = $("#evidenceClaimLinks");
  const artifactSelect = $("#evidenceClaimArtifact");
  if (!links || !artifactSelect) return;
  links.replaceChildren();
  for (const entry of state.evidenceEntries || []) {
    const label = document.createElement("label");
    label.className = "evidence-link-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(entry.id);
    const text = document.createElement("span");
    text.textContent = entry.doi ? `${entry.title} · ${entry.doi}` : entry.title;
    label.append(input, text);
    links.append(label);
  }
  if (!links.childElementCount) links.append(emptyRow("Create an Evidence entry first, or create an unlinked claim."));
  const selected = artifactSelect.value;
  artifactSelect.replaceChildren(new Option("Select saved output", ""));
  for (const artifact of state.evidenceClaimArtifacts || []) artifactSelect.append(new Option(artifact.output_path || artifact.artifact_id, artifact.artifact_id));
  if (state.evidenceClaimArtifactsError) artifactSelect.append(new Option("Saved outputs unavailable", "", false, false));
  artifactSelect.value = selected;
}

async function openClaimSource(claim) {
  if (!claim?.source_path) return;
  await openDocument(claim.source_path);
  if (!state.editor?.editor) return;
  const model = state.editor.editor.getModel();
  const startLine = Math.max(1, Math.min(Number(claim.start_line) || 1, model?.getLineCount() || 1));
  const endLine = Math.max(startLine, Math.min(Number(claim.end_line) || startLine, model?.getLineCount() || startLine));
  const startColumn = claim.start_column ?? 1;
  const endColumn = claim.end_column ?? model?.getLineMaxColumn(endLine) ?? 1;
  state.editor.editor.revealLineInCenter(startLine);
  state.editor.editor.setSelection({ startLineNumber: startLine, startColumn, endLineNumber: endLine, endColumn });
  state.editor.editor.focus();
}

async function openClaimArtifact(claim) {
  if (!claim?.artifact_id) return;
  try {
    const detail = await invoke("get_artifact_record", { artifactId: claim.artifact_id });
    if (!detail) { toast("The linked saved output is no longer available.", true); return; }
    state.selectedArtifactId = claim.artifact_id;
    state.selectedArtifactDetail = detail;
    switchDockTab("plots");
    $("#artifactPanel").open = true;
    renderPlots();
  } catch (error) {
    toast(reportUiFailure("open claim output", error, "The linked saved output could not be opened. Refresh Evidence and try again."), true);
  }
}

async function openClaimEvidence(entryId) {
  await loadEvidenceEntries();
  switchEvidenceTab("entries");
  const item = document.querySelector(`.evidence-item[data-id="${entryId}"]`);
  if (!item) {
    toast("The linked Evidence entry is no longer available in this project.", true);
    return;
  }
  $$("#evidenceList .evidence-item-focused").forEach((candidate) => candidate.classList.remove("evidence-item-focused"));
  item.classList.add("expanded", "evidence-item-focused");
  item.setAttribute("aria-expanded", "true");
  item.scrollIntoView({ block: "center" });
  item.focus({ preventScroll: true });
}

function renderEvidenceClaims() {
  const list = $("#evidenceClaimList");
  const claims = state.evidenceClaims || [];
  $("#evidenceClaimCount").textContent = String(claims.length);
  list.replaceChildren();
  if (!claims.length) { list.append(emptyRow("No claims")); return; }
  for (const claim of claims) {
    const review = state.evidenceClaimReviews.get(claim.claim_id) || { status: "unavailable", claim, evidence: [], limitations: [] };
    const item = document.createElement("article");
    item.className = "evidence-item claim-item";
    const header = document.createElement("div");
    header.className = "evidence-item-header claim-item-header";
    const title = document.createElement("strong");
    title.className = "evidence-item-title";
    title.textContent = claim.summary;
    const badge = document.createElement("span");
    badge.className = `claim-status ${review.status}`;
    badge.textContent = claimStatusLabel(review.status);
    header.append(title, badge);
    const anchor = document.createElement("div");
    anchor.className = "claim-anchor";
    const anchoredOutput = state.evidenceClaimArtifacts.find((artifact) => artifact.artifact_id === claim.artifact_id);
    anchor.textContent = claim.anchor_kind === "artifact"
      ? `Saved output · ${anchoredOutput?.output_path ? pathFileName(anchoredOutput.output_path) : "unavailable"}`
      : `${claim.source_path}:${claim.start_line}-${claim.end_line}`;
    const meta = document.createElement("div");
    meta.className = "evidence-item-meta";
    meta.textContent = `${claimKindLabel(claim.kind)} · ${claim.linked_evidence_ids.length} linked Evidence ${claim.linked_evidence_ids.length === 1 ? "entry" : "entries"}`;
    const actions = document.createElement("div");
    actions.className = "claim-actions";
    const inspect = document.createElement("button");
    inspect.type = "button";
    inspect.textContent = "Review";
    const detail = document.createElement("div");
    detail.className = "claim-detail hidden";
    inspect.addEventListener("click", () => detail.classList.toggle("hidden"));
    const openAnchor = document.createElement("button");
    openAnchor.type = "button";
    openAnchor.textContent = claim.anchor_kind === "artifact" ? "Open saved output" : "Open Source";
    openAnchor.addEventListener("click", () => claim.anchor_kind === "artifact" ? openClaimArtifact(claim) : openClaimSource(claim));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      const accepted = await confirmAction({ title: "Delete claim?", message: "This removes the claim and its Evidence links. Evidence entries and source files are unchanged.", confirmLabel: "Delete Claim", destructive: true });
      if (!accepted) return;
      try { await invoke("delete_evidence_claim", { claimId: claim.claim_id }); await loadEvidenceClaims(); }
      catch (error) { toast(reportUiFailure("delete evidence claim", error, "The claim could not be deleted. Refresh Claims and try again."), true); }
    });
    actions.append(inspect, openAnchor, remove);
    if (claim.source_excerpt) {
      const excerpt = document.createElement("pre");
      excerpt.textContent = claim.source_excerpt;
      detail.append(excerpt);
    }
    for (const limitation of review.limitations || []) {
      const note = document.createElement("p");
      note.className = "form-error";
      note.textContent = claimLimitationLabel(limitation);
      detail.append(note);
    }
    for (const entry of review.evidence || []) {
      const row = document.createElement("div");
      row.className = "claim-evidence-row";
      row.textContent = [entry.title, entry.doi ? `DOI ${entry.doi}` : null, entry.notes || null].filter(Boolean).join(" · ");
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "Open Evidence";
      open.addEventListener("click", () => openClaimEvidence(entry.id));
      row.append(document.createElement("br"), open);
      detail.append(row);
    }
    item.append(header, anchor, meta, actions, detail);
    list.append(item);
  }
}

function switchEvidenceTab(tab) {
  state.evidenceTab = tab;
  $$('[data-evidence-tab]').forEach((button) => { const active = button.dataset.evidenceTab === tab; button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active)); });
  $("#evidenceEntriesView").classList.toggle("hidden", tab !== "entries");
  $("#evidenceClaimsView").classList.toggle("hidden", tab !== "claims");
  if (tab === "claims") loadEvidenceClaims();
}

function renderEvidenceList() {
  const list = $("#evidenceList");
  const count = $("#evidenceCount");
  const data = state.evidenceEntries || [];
  count.textContent = data.length;
  list.replaceChildren();
  if (!data.length) {
    list.append(emptyRow("No evidence entries"));
    return;
  }
  for (const entry of data) {
    const item = document.createElement("div");
    item.className = "evidence-item";
    item.dataset.id = entry.id;
    item.tabIndex = -1;
    item.setAttribute("aria-expanded", "false");

    const header = document.createElement("div");
    header.className = "evidence-item-header";
    const title = document.createElement("span");
    title.className = "evidence-item-title";
    title.textContent = entry.title;
    const date = document.createElement("span");
    date.className = "evidence-item-date";
    date.textContent = new Date(entry.created_at).toLocaleDateString();
    header.append(title, date);

    const notes = document.createElement("div");
    notes.className = "evidence-item-notes";
    notes.textContent = entry.notes || "";

    const meta = document.createElement("div");
    meta.className = "evidence-item-meta";
    if (entry.doi) {
      const tag = document.createElement("span");
      tag.className = "evidence-tag";
      tag.textContent = `DOI: ${entry.doi}`;
      meta.append(tag);
    }
    if (entry.run_id) {
      const tag = document.createElement("span");
      tag.className = "evidence-tag";
      tag.textContent = "Linked to a run";
      meta.append(tag);
    }
    if (entry.artifact_id) {
      const tag = document.createElement("span");
      tag.className = "evidence-tag";
      tag.textContent = "Linked to a saved output";
      meta.append(tag);
    }

    const actions = document.createElement("div");
    actions.className = "evidence-item-actions";
    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const accepted = await confirmAction({ title: "Delete Evidence entry?", message: "Claims linked only to this entry will become missing evidence. Source files and saved-output records are unchanged.", confirmLabel: "Delete Entry", destructive: true });
      if (!accepted) return;
      try {
        await invoke("delete_evidence_entry", { id: entry.id });
        await Promise.all([loadEvidenceEntries(), loadEvidenceClaims()]);
      } catch (err) { toast(reportUiFailure("delete evidence entry", err, "The Evidence entry could not be deleted. Refresh Evidence and try again."), true); }
    });
    actions.append(delBtn);

    item.append(header, notes, meta, actions);

    if (entry.citation_json) {
      try {
        const cit = JSON.parse(entry.citation_json);
        const citDiv = document.createElement("div");
        citDiv.className = "evidence-item-citation";
        const parts = [cit.authors, `(${cit.year})`, cit.title, cit.journal].filter(Boolean);
        citDiv.textContent = parts.join(". ");
        item.append(citDiv);
      } catch { /* citation parse failure is best-effort */ }
    }

    item.addEventListener("click", () => {
      item.classList.toggle("expanded");
      item.setAttribute("aria-expanded", String(item.classList.contains("expanded")));
    });
    list.append(item);
  }
}

function initEvidencePanel() {
  $(".context-panel").append($("#evidencePanel"));
  $$('[data-evidence-tab]').forEach((button) => button.addEventListener("click", () => switchEvidenceTab(button.dataset.evidenceTab)));
  $("#evidenceNewButton").addEventListener("click", () => {
    $("#evidenceNewForm").classList.toggle("hidden");
  });
  $("#evidenceCancelButton").addEventListener("click", () => {
    $("#evidenceNewForm").classList.add("hidden");
    $("#evidenceNewTitle").value = "";
    $("#evidenceNewNotes").value = "";
    $("#evidenceNewDoi").value = "";
    $("#evidenceCitationPreview").classList.add("hidden");
  });
  $("#evidenceResolveDoi").addEventListener("click", async () => {
    const doi = $("#evidenceNewDoi").value.trim();
    if (!doi) return;
    try {
      const citation = await invoke("resolve_doi", { doi });
      if (citation) {
        const preview = $("#evidenceCitationPreview");
        const parts = [citation.authors, `(${citation.year})`, citation.title, citation.journal].filter(Boolean);
        preview.textContent = parts.join(". ");
        preview.classList.remove("hidden");
      }
    } catch { toast("DOI resolution failed", "error"); }
  });
  $("#evidenceCreateButton").addEventListener("click", async () => {
    const title = $("#evidenceNewTitle").value.trim();
    if (!title) { toast("Title is required"); return; }
    try {
      await invoke("create_evidence_entry", {
        title,
        notes: $("#evidenceNewNotes").value,
        doi: $("#evidenceNewDoi").value.trim() || null,
        run_id: null,
        artifact_id: null,
      });
      $("#evidenceNewForm").classList.add("hidden");
      $("#evidenceNewTitle").value = "";
      $("#evidenceNewNotes").value = "";
      $("#evidenceNewDoi").value = "";
      $("#evidenceCitationPreview").classList.add("hidden");
      await loadEvidenceEntries();
    } catch (err) { toast(reportUiFailure("create evidence entry", err, "The Evidence entry could not be created. Review the form and try again."), true); }
  });
  $("#evidenceSearch").addEventListener("input", () => {
    if (!state.evidenceEntries) return;
    const term = $("#evidenceSearch").value.trim().toLowerCase();
    if (term) {
      const filtered = state.evidenceEntries.filter(
        (e) => e.title.toLowerCase().includes(term) || e.notes.toLowerCase().includes(term)
      );
      const saved = state.evidenceEntries;
      state.evidenceEntries = filtered;
      renderEvidenceList();
      state.evidenceEntries = saved;
    } else {
      renderEvidenceList();
    }
  });
  $("#refreshEvidence").addEventListener("click", loadEvidenceEntries);
  $("#refreshEvidenceClaims").addEventListener("click", loadEvidenceClaims);
  $("#evidenceClaimNew").addEventListener("click", () => { $("#evidenceClaimForm").classList.toggle("hidden"); renderEvidenceClaimFormOptions(); });
  $("#evidenceClaimCancel").addEventListener("click", () => { $("#evidenceClaimForm").classList.add("hidden"); $("#evidenceClaimFormError").classList.add("hidden"); });
  $$('[data-claim-anchor]').forEach((button) => button.addEventListener("click", () => {
    state.claimAnchorKind = button.dataset.claimAnchor;
    $$('[data-claim-anchor]').forEach((candidate) => candidate.classList.toggle("active", candidate === button));
    $("#evidenceSourceAnchorFields").classList.toggle("hidden", state.claimAnchorKind !== "source_range");
    $("#evidenceArtifactAnchorFields").classList.toggle("hidden", state.claimAnchorKind !== "artifact");
  }));
  $("#evidenceClaimCreate").addEventListener("click", async () => {
    const error = $("#evidenceClaimFormError");
    error.classList.add("hidden");
    const summary = $("#evidenceClaimSummary").value.trim();
    const sourcePath = $("#evidenceClaimSourcePath").value.trim().replaceAll("\\", "/");
    const startLine = Number($("#evidenceClaimStartLine").value);
    const endLine = Number($("#evidenceClaimEndLine").value);
    const artifactId = $("#evidenceClaimArtifact").value || null;
    if (!summary || (state.claimAnchorKind === "source_range" && (!sourcePath || startLine < 1 || endLine < startLine)) || (state.claimAnchorKind === "artifact" && !artifactId)) {
      error.textContent = "Enter a summary and a valid source range or saved output.";
      error.classList.remove("hidden");
      return;
    }
    const evidenceIds = $$("#evidenceClaimLinks input:checked").map((input) => Number(input.value));
    try {
      await invoke("create_evidence_claim", { request: {
        kind: $("#evidenceClaimKind").value.trim() || "result", summary, anchor_kind: state.claimAnchorKind,
        source_path: state.claimAnchorKind === "source_range" ? sourcePath : null,
        start_line: state.claimAnchorKind === "source_range" ? startLine : null, start_column: null,
        end_line: state.claimAnchorKind === "source_range" ? endLine : null, end_column: null,
        artifact_id: state.claimAnchorKind === "artifact" ? artifactId : null, evidence_ids: evidenceIds,
      }});
      $("#evidenceClaimForm").classList.add("hidden");
      $("#evidenceClaimSummary").value = "";
      await loadEvidenceClaims();
    } catch (failure) {
      error.textContent = reportUiFailure("create evidence claim", failure, "This claim could not be created. Review its source or saved output and try again.");
      error.classList.remove("hidden");
    }
  });
}


// ── Chunk panel ─────────────────────────────────────────────

async function loadChunks() {
  const filePath = state.activeFilePath;
  if (!filePath || !/\\.(Rmd|qmd)$/i.test(filePath)) return;
  try {
    state.chunks = await invoke("editor_discover_chunks", { path: filePath });
  } catch {
    state.chunks = null;
  }
  renderChunks();
}

function renderChunks() {
  const list = $("#chunksList");
  const count = $("#chunkCount");
  const tab = $("#chunksTab");
  const data = state.chunks;

  if (!data || data.unsupported) {
    count.textContent = "0";
    tab.classList.add("hidden");
    return;
  }

  const chunks = data.chunks || [];
  count.textContent = chunks.length;
  tab.classList.remove("hidden");
  list.replaceChildren();

  if (!chunks.length) {
    list.append(emptyRow("No code chunks found"));
    return;
  }

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];
    const item = document.createElement("div");
    item.className = "chunk-item";

    const header = document.createElement("div");
    header.className = "chunk-item-header";
    const label = document.createElement("span");
    label.className = "chunk-item-label";
    label.textContent = chunk.label;
    header.append(label);

    if (chunk.engine !== "r") {
      const engine = document.createElement("span");
      engine.className = "chunk-item-engine";
      engine.textContent = chunk.engine;
      header.append(engine);
    }
    if (chunk.options) {
      const opts = document.createElement("span");
      opts.className = "chunk-item-options";
      opts.textContent = chunk.options;
      header.append(opts);
    }
    const range = document.createElement("span");
    range.className = "chunk-item-range";
    range.textContent = `L${chunk.start_line}-L${chunk.end_line}`;
    header.append(range);

    const preview = document.createElement("div");
    preview.className = "chunk-item-preview";
    preview.textContent = chunk.code_preview || "";

    const actions = document.createElement("div");
    actions.className = "chunk-item-actions";
    const runBtn = document.createElement("button");
    runBtn.textContent = "\u25B6 Run";
    runBtn.title = "Run this chunk in Workspace R";
    runBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!chunk.code) return;
      try {
        await invoke("execute_r", {
          code: chunk.code,
          sourcePath: state.activeFilePath || null,
          executionMode: "chunk",
          operationClass: "scientific",
        });
        toast(`Ran chunk "${chunk.label}"`);
      } catch (err) { toast(reportUiFailure("run document chunk", err, "The document chunk could not be run. Review Console and Problems for the R error."), true); }
    });
    const precBtn = document.createElement("button");
    precBtn.textContent = "\u2191 Prec";
    precBtn.title = "Run all preceding chunks";
    precBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await runPrecedingChunks(idx);
    });
    const belowBtn = document.createElement("button");
    belowBtn.textContent = "\u2193 Below";
    belowBtn.title = "Run all chunks below this one";
    belowBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await runBelowChunks(idx);
    });
    actions.append(runBtn, precBtn, belowBtn);

    item.append(header, preview, actions);

    // Click chunk to navigate to its start line in editor
    item.addEventListener("click", () => {
      if (state.editor?.editor) {
        state.editor.editor.revealLineInCenter(chunk.start_line);
        state.editor.editor.setPosition({
          lineNumber: chunk.start_line,
          column: 1,
        });
        state.editor.editor.focus();
      }
    });

    list.append(item);
  }
}

function initChunkPanel() {
  // Run All chunks
  $("#chunksRunAll").addEventListener("click", () => runAllChunks());

  // Hook into openDocument to refresh chunks on file open
  const origOpenDocument = openDocument;
  openDocument = async function(path, options) {
    const result = await origOpenDocument(path, options);
    state.activeFilePath = path;
    loadChunks();
    return result;
  };
}

// ── Chunk batch execution helpers ────────────────────────────

function buildChunkBatch(chunks) {
  return chunks
    .map((c) => `#| chunk-label: ${c.label}\n${c.code}`)
    .join("\n\n");
}

async function runPrecedingChunks(index) {
  const chunks = (state.chunks?.chunks) || [];
  const preceding = chunks.slice(0, index);
  if (!preceding.length) { toast("No preceding chunks to run"); return; }
  const code = buildChunkBatch(preceding);
  try {
    await invoke("execute_r", {
      code,
      sourcePath: state.activeFilePath || null,
      executionMode: "chunk",
      operationClass: "scientific",
    });
    toast(`Ran ${preceding.length} preceding chunk(s)`);
  } catch (err) { toast(reportUiFailure("run preceding document chunks", err, "The preceding chunks could not be run. Review Console and Problems for the R error."), true); }
}

async function runBelowChunks(index) {
  const chunks = (state.chunks?.chunks) || [];
  const below = chunks.slice(index + 1);
  if (!below.length) { toast("No chunks below to run"); return; }
  const code = buildChunkBatch(below);
  try {
    await invoke("execute_r", {
      code,
      sourcePath: state.activeFilePath || null,
      executionMode: "chunk",
      operationClass: "scientific",
    });
    toast(`Ran ${below.length} chunk(s) below`);
  } catch (err) { toast(reportUiFailure("run following document chunks", err, "The following chunks could not be run. Review Console and Problems for the R error."), true); }
}

async function runAllChunks() {
  const chunks = (state.chunks?.chunks) || [];
  if (!chunks.length) { toast("No chunks to run"); return; }
  const code = buildChunkBatch(chunks);
  try {
    await invoke("execute_r", {
      code,
      sourcePath: state.activeFilePath || null,
      executionMode: "chunk",
      operationClass: "scientific",
    });
    toast(`Ran all ${chunks.length} chunk(s)`);
  } catch (err) { toast(reportUiFailure("run all document chunks", err, "The document chunks could not be run. Review Console and Problems for the R error."), true); }
}

function renderEnvironmentSummary() {
  const environment = state.environment;
  renderEnvironmentOperationCard();
  if (!environment) {
    renderStatusItems($("#environmentContract"), [{ label: "Snapshot unavailable", status: "unavailable" }]);
    $("#reproducibilitySummary").textContent = "renv status unavailable";
    $("#reproducibilityStatus").textContent = "Project package environment status is unavailable.";
    renderStatusItems($("#renderCapability"), [{ label: "Render tooling not checked", status: "neutral" }]);
    $("#renderDocumentHint").textContent = renderDocumentHintText();
    $("#renderDocumentButton").disabled = true;
    renderLastRenderCard();
    return;
  }
  const renv = environment.renv || {};
  const bioc = environment.bioconductor || {};
  const render = environment.render || {};
  const attached = (environment.attached_packages?.values || []).map((item) => `${item.name}${item.version ? ` ${item.version}` : ""}`).join(", ");
  const renvStatus = renv.status || "unknown";
  const renvLabel = {
    synchronized: "Package versions match the lockfile",
    active: "Project package environment active",
    present: "Package versions recorded",
    absent: "Package versions are not recorded",
    no_lockfile: "Package versions are not recorded",
    drifted: "Package versions differ from the lockfile",
    unavailable: "Package environment unavailable",
    error: "Package environment unavailable",
    invalid: "Lockfile needs attention",
  }[renvStatus] || "Package environment not checked";
  const renvTone = renvStatus === "synchronized"
    ? "completed"
    : /unavailable|error|invalid/.test(renvStatus)
      ? "failed"
      : "warning";
  const lockfileState = renv.synchronization || "unknown";
  const lockfileLabel = {
    synchronized: "Lockfile in sync",
    drifted: "Lockfile differs",
    no_lockfile: "No lockfile",
    invalid_lockfile: "Lockfile needs attention",
  }[lockfileState] || "Lockfile status unavailable";
  $("#reproducibilitySummary").textContent = `${renv.status || "unknown"} · ${lockfileLabel}`;
  $("#reproducibilityStatus").textContent = `${renvLabel}. ${lockfileLabel}. Use the inventory buttons for package details.`;
  renderStatusItems($("#environmentContract"), [
    { label: renvLabel, status: renvTone },
    { label: bioc.version ? `Bioconductor ${bioc.version}` : "Bioconductor version not detected", status: bioc.version ? "completed" : "neutral" },
    { label: attached ? `Packages ${attached}` : "No packages attached", status: "neutral" },
  ]);
  renderStatusItems($("#renderCapability"), [
    { label: render.can_render_qmd ? "Quarto ready" : "Quarto unavailable", status: render.can_render_qmd ? "completed" : "unavailable" },
    { label: render.can_render_rmd ? "R Markdown ready" : "R Markdown unavailable", status: render.can_render_rmd ? "completed" : "unavailable" },
  ]);
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
    setStateChip($("#renderResultState"), "Idle", "neutral");
    $("#renderResultSummary").textContent = "No render has been run yet.";
    $("#renderResultPath").textContent = "";
    for (const id of ["renderOpenSourceButton", "renderReviewArtifactButton", "renderShowProblemsButton", "renderShowPlotsButton"]) {
      $(`#${id}`).disabled = true;
    }
    return;
  }
  card.classList.remove("hidden");
  card.classList.add(render.ok ? "success" : "error");
  $("#renderResultTitle").textContent = render.tool ? `Last Render · ${render.tool}` : "Last Render";
  setStateChip($("#renderResultState"), render.ok ? "Completed" : prettyStatus(render.phase || "failed"), render.ok ? "completed" : "failed");
  $("#renderResultSummary").textContent = render.ok
    ? render.artifactAvailable
      ? render.fileAvailable === false
        ? `Rendered ${render.sourcePath || "document"}, but the saved file is missing.`
        : `Rendered ${render.sourcePath || "document"}; source details are ${render.provenanceComplete ? "available" : "incomplete"}.`
      : `Rendered ${render.sourcePath || "document"}; saved-output details are unavailable.`
    : `${render.message || "Render failed."}`;
  $("#renderResultPath").textContent = render.ok
    ? `Saved to ${render.outputPath || "an unavailable location"}`
    : `Source: ${render.sourcePath || "unknown"}`;
  $("#renderOpenSourceButton").disabled = !render.sourcePath;
  $("#renderReviewArtifactButton").disabled = !render.artifactAvailable;
  $("#renderShowProblemsButton").disabled = !latestRenderProblem();
  $("#renderShowPlotsButton").disabled = !state.plots.some((plot) => plot.source_path === render.sourcePath);
}

function prettyEnvironmentOperationStatus(status) {
  return {
    requested: "Requested",
    approved: "Starting",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    rejected: "Rejected",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
    stale: "Needs refresh",
  }[status] || "Status unavailable";
}

function environmentOperationTone(status) {
  if (!isDesktop) return mockEnvironmentOperationTone(status);
  if (status === "completed") return "success";
  if (status === "approved") return "warning";
  if (["requested", "running"].includes(status)) return "warning";
  if (["failed", "rejected", "cancelled", "interrupted", "stale"].includes(status)) return "error";
  return "";
}

function environmentOperationLabel(requestName) {
  return {
    "environment.initialize": "Initialize renv",
    "environment.restore": "Restore lockfile",
    "environment.snapshot": "Snapshot lockfile",
    "environment.package_install": "Install package",
    "environment.package_update": "Update package",
    "environment.package_remove": "Remove package",
  }[requestName] || requestName || "Environment operation";
}

function parseEnvironmentOperationPayload(value, fallback = null) {
  try {
    return JSON.parse(value || "null") || fallback;
  } catch {
    return fallback;
  }
}

function mockProblemRepairTurnEvidence(turn) {
  const promptEvent = turn?.events?.find((event) => event.event_type === "agent.user_prompt");
  const proposalEvent = turn?.events?.find((event) =>
    event.event_type === "tool.call_completed" && event.tool === "propose_file_edit"
  );
  const details = parseJsonObject(promptEvent?.details_json) || {};
  const proposal = parseJsonObject(proposalEvent?.body);
  return {
    created: Boolean(turn),
    mode: turn?.mode || null,
    task_kind: details.task_kind || null,
    capability_route: details.capability_route || null,
    auto_approve: details.auto_approve ?? null,
    context: details.editor_context || null,
    proposal_created: Boolean(proposalEvent),
    proposal_operation: proposal?.operation || null,
    proposal_path: proposal?.path || null,
  };
}

function setPreviewEditorSelection(start, end) {
  const documentState = activeDocument();
  if (!documentState) return false;
  documentState.cursorStart = Math.max(0, Math.min(start, documentState.content.length));
  documentState.cursorEnd = Math.max(0, Math.min(end, documentState.content.length));
  applyDocumentSelection(documentState);
  return documentState.cursorEnd > documentState.cursorStart;
}

async function runConsoleRepairEntryMockProbe(entry) {
  const turnsBefore = mockAgentTurns.length;
  const sourceBefore = mockProjects[state.project.root]?.contents?.["analysis.R"] || null;
  const actionBefore = {
    label: entry.button.textContent,
    disabled: entry.button.disabled,
    action: entry.button.dataset.repairAction || null,
    run_id: entry.runId,
  };
  const clickHandler = entry.button.onclick;
  if (typeof clickHandler === "function") {
    await Promise.all([clickHandler(), clickHandler()]);
  }
  const turnsAfter = mockAgentTurns.length;
  const turn = mockAgentTurns[0] || null;
  const turnEvidence = mockProblemRepairTurnEvidence(turn);
  const dockAfterClick = document.querySelector("[data-dock-tab].active")?.dataset.dockTab || null;

  const retryRunId = "run_console_repair_refresh_retry";
  const documentVersion = activeDocument()?.versionId ?? 0;
  recordMockRun({
    runId: retryRunId,
    origin: "user",
    status: "failed",
    code: "summary(qc)",
    sourcePath: "analysis.R",
    executionMode: "selection",
    documentVersion,
    errorMessage: "object 'qc' not found",
    errorCall: "summary(qc)",
    sourceRange: { start_line: 2, start_column: 1, end_line: 2, end_column: 12 },
    errorRange: { start_line: 2, start_column: 1, end_line: 2, end_column: 12 },
  });
  const retryEntry = addConsoleExecutionError("Repair refresh retry probe", { runId: retryRunId });
  mockProblemListFailureOnce = true;
  const firstRefreshSucceeded = await loadRunData({ quiet: true });
  const failedRefreshState = {
    refresh_failed: firstRefreshSucceeded === false,
    label: retryEntry.button.textContent,
    disabled: retryEntry.button.disabled,
  };
  await retryConsoleRepairContext(retryEntry);
  const refreshRecovery = {
    matched_after_retry: retryEntry.problem?.run_id === retryRunId,
    label: retryEntry.button.textContent,
    disabled: retryEntry.button.disabled,
  };
  retryEntry.element.remove();
  state.consoleRepairEntries.delete(retryEntry.id);

  const missingEntry = addConsoleExecutionError("Missing durable repair probe", {
    runId: "run_console_repair_missing",
  });
  await loadRunData({ quiet: true });
  const missingInitial = {
    label: missingEntry.button.textContent,
    disabled: missingEntry.button.disabled,
  };
  await retryConsoleRepairContext(missingEntry);
  const missingExhausted = {
    label: missingEntry.button.textContent,
    disabled: missingEntry.button.disabled,
    no_turn_created: mockAgentTurns.length === turnsAfter,
  };
  missingEntry.element.remove();
  state.consoleRepairEntries.delete(missingEntry.id);

  state.projectRefreshSequence += 1;
  syncConsoleRepairEntries();
  const staleGuard = {
    disabled: entry.button.disabled,
    label: entry.button.textContent,
    no_additional_turn: mockAgentTurns.length === turnsAfter,
  };

  return {
    action_before: actionBefore,
    direct_console_click: {
      turn_delta: turnsAfter - turnsBefore,
      task_kind: turnEvidence.task_kind,
      mode: turnEvidence.mode,
      run_id: turnEvidence.context?.run_context?.run_id || null,
      diagnostic_run_id: turnEvidence.context?.diagnostic?.run_id || null,
      diagnostic_range: turnEvidence.context?.diagnostic ? {
        start_line: turnEvidence.context.diagnostic.line_number,
        start_column: turnEvidence.context.diagnostic.column_number,
        end_line: turnEvidence.context.diagnostic.end_line_number,
        end_column: turnEvidence.context.diagnostic.end_column_number,
        kind: turnEvidence.context.diagnostic.range_kind,
      } : null,
      selection_text: turnEvidence.context?.selection_text || null,
      proposal_created: turnEvidence.proposal_created,
      did_not_navigate_problems: dockAfterClick !== "problems",
      source_unchanged_before_accept: sourceBefore === mockProjects[state.project.root]?.contents?.["analysis.R"],
    },
    duplicate_click_guarded: turnsAfter - turnsBefore === 1,
    refresh_recovery: {
      failed: failedRefreshState,
      recovered: refreshRecovery,
    },
    missing_context_recovery: {
      initial: missingInitial,
      exhausted: missingExhausted,
    },
    project_switch_guard: staleGuard,
  };
}

async function runProblemRepairMockProbe(fileProblem, consoleProblem, parseProblem) {
  const projectRoot = state.project.root;
  const alternateProjectRoot = mockPlatformFixture.alternateProjectRoot;
  const projectSourceBefore = mockProjects[projectRoot].contents["analysis.R"];
  const parseSourceBefore = mockProjects[projectRoot].contents["parse-error.R"];

  const parseTurnCountBefore = mockAgentTurns.length;
  await fixProblemWithAgent(parseProblem);
  const parseTurn = mockAgentTurns[0] || null;
  const parseEvidence = mockProblemRepairTurnEvidence(parseTurn);
  const parseTurnCount = mockAgentTurns.length;

  const fileTurnCountBefore = mockAgentTurns.length;

  await fixProblemWithAgent(fileProblem);
  const fileTurn = mockAgentTurns[0] || null;
  const fileEvidence = mockProblemRepairTurnEvidence(fileTurn);
  const fileTurnCount = mockAgentTurns.length;

  await fixProblemWithAgent(consoleProblem);
  const consoleTurn = mockAgentTurns[0] || null;
  const consoleEvidence = mockProblemRepairTurnEvidence(consoleTurn);
  const consoleTurnCount = mockAgentTurns.length;

  await openDocument(fileProblem.source_path);
  setPreviewEditorSelection(0, 0);
  const noRangeProblem = {
    ...fileProblem,
    line_number: null,
    column_number: null,
    end_line_number: null,
    end_column_number: null,
    range_kind: null,
  };
  const manualBefore = mockAgentTurns.length;
  await fixProblemWithAgent(noRangeProblem);
  const manualFirstActionBlocked = mockAgentTurns.length === manualBefore;
  const manualDocument = activeDocument();
  const manualStart = manualDocument?.content.indexOf("summary(qc)") ?? -1;
  if (manualStart >= 0) setPreviewEditorSelection(manualStart, manualStart + "summary(qc)".length);
  await fixProblemWithAgent(noRangeProblem);
  const manualTurn = mockAgentTurns[0] || null;
  const manualEvidence = mockProblemRepairTurnEvidence(manualTurn);
  const manualSecondActionCreatedTurn = mockAgentTurns.length === manualBefore + 1;

  const foreignBefore = mockAgentTurns.length;
  await fixProblemWithAgent({ ...fileProblem, project_root: alternateProjectRoot });
  const foreignProjectBlocked = mockAgentTurns.length === foreignBefore;

  await openDocument(fileProblem.source_path);
  const documentState = activeDocument();
  const documentSnapshot = documentState ? {
    content: documentState.content,
    savedContent: documentState.savedContent,
    versionId: documentState.versionId,
    cursorStart: documentState.cursorStart,
    cursorEnd: documentState.cursorEnd,
  } : null;
  if (documentState) {
    documentState.content = documentState.content.replace("summary(qc)", "summary(qc_stale)");
    documentState.versionId = Number(documentState.versionId || 0) + 1;
    documentState.cursorStart = 0;
    documentState.cursorEnd = 0;
    renderActiveDocument();
  }
  const staleBefore = mockAgentTurns.length;
  await fixProblemWithAgent(fileProblem);
  const staleSourceBlocked = mockAgentTurns.length === staleBefore;
  if (documentState && documentSnapshot) {
    Object.assign(documentState, documentSnapshot);
    renderActiveDocument();
  }

  const failureBefore = mockAgentTurns.length;
  mockAgentRunFailureOnce = "Mock Agent repair request failed before a turn was created.";
  await fixProblemWithAgent(fileProblem);
  const failedRequestRecovered = mockAgentTurns.length === failureBefore
    && !state.agentBusy
    && state.agentDiagnostic === null
    && state.agentProblemRunContext === null;

  const switchBefore = mockAgentTurns.length;
  mockProblemPreparationProjectSwitchOnce = true;
  await fixProblemWithAgent(fileProblem);
  const switchedProjectRoot = state.project.root;
  const projectSwitchBlocked = mockAgentTurns.length === switchBefore
    && switchedProjectRoot === alternateProjectRoot;
  mockLastProject = projectRoot;
  state.project = mockProjectState(projectRoot);
  state.projectRefreshSequence += 1;

  const settingsSnapshot = structuredClone(mockAgentLlmSettings);
  const routeModelId = (mockAgentLlmSettings.persisted_capability_routes || [])
    .find((route) => route.capability === "agent.act")?.model_id
    || (mockAgentLlmSettings.persisted_capability_routes || [])
      .find((route) => route.capability === "agent.chat")?.model_id;
  const routeModel = mockAgentLlmSettings.models.find((model) => model.id === routeModelId);
  if (routeModel) routeModel.capabilities.function_call = agentCapability("no", "user_declared");
  rebuildMockAgentLlmSettings();
  state.agentLlm.settings = structuredClone(mockAgentLlmSettings);
  syncAgentComposerState();
  const routeBefore = mockAgentTurns.length;
  await fixProblemWithAgent(fileProblem);
  const routeBlocker = {
    no_turn: mockAgentTurns.length === routeBefore,
    dialog_open: !$("#agentLlmDialog").classList.contains("hidden"),
    active_view: state.agentLlm.activeView,
    expanded_capability: state.agentLlm.routingExpandedCapability,
  };
  closeAgentLlmDialog();
  mockAgentLlmSettings = rebuildMockAgentLlmSettings(settingsSnapshot);
  state.agentLlm.settings = structuredClone(mockAgentLlmSettings);
  syncAgentComposerState();

  const activeSource = state.documents["analysis.R"]?.content;
  return {
    parse_token: {
      ...parseEvidence,
      turn_created_once: parseTurnCount === parseTurnCountBefore + 1,
      exact_selection: parseEvidence.context?.selection_text || null,
      diagnostic_range: parseEvidence.context?.diagnostic ? {
        start_line: parseEvidence.context.diagnostic.line_number,
        start_column: parseEvidence.context.diagnostic.column_number,
        end_line: parseEvidence.context.diagnostic.end_line_number,
        end_column: parseEvidence.context.diagnostic.end_column_number,
        kind: parseEvidence.context.diagnostic.range_kind,
      } : null,
      run_id: parseEvidence.context?.run_context?.run_id || null,
      source_unchanged_before_accept:
        parseSourceBefore === mockProjects[projectRoot].contents["parse-error.R"],
    },
    file: {
      ...fileEvidence,
      turn_created_once: fileTurnCount === fileTurnCountBefore + 1,
      exact_selection: fileEvidence.context?.selection_text || null,
      diagnostic_range: fileEvidence.context?.diagnostic ? {
        start_line: fileEvidence.context.diagnostic.line_number,
        start_column: fileEvidence.context.diagnostic.column_number,
        end_line: fileEvidence.context.diagnostic.end_line_number,
        end_column: fileEvidence.context.diagnostic.end_column_number,
        kind: fileEvidence.context.diagnostic.range_kind,
      } : null,
      run_id: fileEvidence.context?.run_context?.run_id || null,
      traceback: fileEvidence.context?.diagnostic?.traceback || [],
    },
    console: {
      ...consoleEvidence,
      turn_created_once: consoleTurnCount === fileTurnCount + 1,
      active_path: consoleEvidence.context?.active_path ?? null,
      source_path: consoleEvidence.context?.diagnostic?.source_path || null,
      run_id: consoleEvidence.context?.run_context?.run_id || null,
    },
    manual_selection: {
      first_action_created_no_turn: manualFirstActionBlocked,
      second_action_created_turn: manualSecondActionCreatedTurn && manualEvidence.created,
      task_kind: manualEvidence.task_kind,
      range_kind: manualEvidence.context?.diagnostic?.range_kind || null,
      selection_text: manualEvidence.context?.selection_text || null,
      proposal_created: manualEvidence.proposal_created,
    },
    guards: {
      foreign_project_blocked: foreignProjectBlocked,
      stale_source_blocked: staleSourceBlocked,
      failed_request_recovered: failedRequestRecovered,
      project_switch_blocked: projectSwitchBlocked,
    },
    route_blocker: routeBlocker,
    source_unchanged_before_accept: projectSourceBefore === mockProjects[projectRoot].contents["analysis.R"]
      && activeSource === projectSourceBefore,
  };
}

async function runDataViewerRefreshMockProbe() {
  const projectRoot = state.project.root;
  const alternateProjectRoot = mockPlatformFixture.alternateProjectRoot;
  state.objects = [
    { name: "qc_paged", classes: ["data.frame"], dimensions: [60, 3], size_bytes: 6184, typeof: "list" },
  ];
  await inspectEnvironmentObject("qc_paged", { force: true });
  state.dataViewer.rowLimit = 25;
  state.dataViewer.query = "S";
  state.dataViewer.sortColumn = 1;
  state.dataViewer.sortDirection = "desc";
  $("#dataViewerFilter").value = "S";
  await loadDataViewPage({ rowOffset: 25, columnOffset: 0 });
  const before = {
    token: state.selectedDataObjectDetail?.view_token || null,
    state_revision: state.dataViewer.workspace?.state_revision ?? null,
    row_offset: state.selectedDataPage?.row_offset ?? null,
    query: state.selectedDataPage?.query ?? null,
    sort_column: state.selectedDataPage?.sort_column ?? null,
    sort_direction: state.selectedDataPage?.sort_direction ?? null,
  };
  const inspectCountBefore = mockDataViewerInspectCount;
  const readCountBefore = mockDataViewerReadCount;

  await executeCode({
    code: "qc_paged <- qc_paged\nstop(\"refresh probe\")",
    type: "console",
    sourcePath: "<console>",
    documentVersion: null,
    range: null,
  });
  const after = {
    token: state.selectedDataObjectDetail?.view_token || null,
    state_revision: state.dataViewer.workspace?.state_revision ?? null,
    row_offset: state.selectedDataPage?.row_offset ?? null,
    query: state.selectedDataPage?.query ?? null,
    sort_column: state.selectedDataPage?.sort_column ?? null,
    sort_direction: state.selectedDataPage?.sort_direction ?? null,
    error_code: state.dataViewer.error?.error_code || null,
  };
  const automaticRefresh = {
    token_changed: Boolean(before.token && after.token && before.token !== after.token),
    revision_advanced: Number(after.state_revision) > Number(before.state_revision),
    inspect_delta: mockDataViewerInspectCount - inspectCountBefore,
    read_delta: mockDataViewerReadCount - readCountBefore,
    query_preserved: after.query === before.query,
    sort_preserved: after.sort_column === before.sort_column
      && after.sort_direction === before.sort_direction,
    window_preserved: after.row_offset === before.row_offset,
    no_stale_error: after.error_code === null,
  };

  state.revision.state_revision += 1;
  state.objects = state.objects.filter((object) => object.name !== "qc_paged");
  await refreshEnvironment({ quiet: true });
  const disappearedObjectCleared = state.selectedObjectName === null
    && state.selectedDataObjectDetail === null
    && state.selectedDataPage === null;

  mockLastProject = projectRoot;
  state.project = mockProjectState(projectRoot);
  state.objects = [
    { name: "qc", classes: ["data.frame"], dimensions: [12, 3], size_bytes: 2184, typeof: "list" },
  ];
  await inspectEnvironmentObject("qc", { force: true });
  const lateInspection = inspectEnvironmentObject("qc", {
    force: true,
    preserveViewerState: true,
    expectedProjectRoot: projectRoot,
    expectedProjectRefreshSequence: state.projectRefreshSequence,
  });
  mockLastProject = alternateProjectRoot;
  state.project = mockProjectState(alternateProjectRoot);
  state.projectRefreshSequence += 1;
  state.objects = [];
  clearEnvironmentObjectSelection();
  await lateInspection;
  const foreignResponseIgnored = state.project.root === alternateProjectRoot
    && state.selectedObjectName === null
    && state.selectedDataObjectDetail === null
    && state.selectedDataPage === null;

  return {
    before,
    after,
    automatic_refresh: automaticRefresh,
    disappeared_object_cleared: disappearedObjectCleared,
    foreign_project_response_ignored: foreignResponseIgnored,
  };
}

async function maybeApplyPreviewScenario() {
  if (state.previewScenarioApplied || isDesktop) return;
  const scenario = previewParams.get("preview");
  if (!["agent-first-direct", "interface-shell", "console-logs", "git-review", "wp2-data-viewer", "wp3-artifacts", "environment-lockfile", "environment-package", "local-help", "installed-help", "console-help", "project-references", "lint-quick-fix", "agent-help-link", "editor-refactor", "editor-format", "evidence-claims", "usability-problems", "usability-save", "model-settings"].includes(scenario)) return;
  state.previewScenarioApplied = true;
  if (scenario === "model-settings") {
    const modelSettingsPreviewState = previewParams.get("state") || "default";
    if (modelSettingsPreviewState === "empty") {
      mockAgentLlmSystemCredentials.clear();
      mockAgentLlmSettings = rebuildMockAgentLlmSettings({
        schema_version: 2,
        revision: 1,
        providers: [],
        models: [],
        persisted_capability_routes: [],
        capability_routes: [],
        selected_model: null,
        user_environ: { path: "", source: "system" },
        validation_error: null,
      });
    } else if (modelSettingsPreviewState === "key-missing") {
      mockAgentLlmSystemCredentials.delete(mockAgentLlmSettings.providers[0].id);
      mockAgentLlmSettings.providers[0].credential_status = "not_detected";
      mockAgentLlmSettings.providers[0].credential_source = "none";
      rebuildMockAgentLlmSettings();
    } else if (modelSettingsPreviewState === "storage-unavailable") {
      mockAgentLlmSettings.providers[0].credential_status = "unavailable";
      mockAgentLlmSettings.providers[0].credential_source = "unavailable";
      rebuildMockAgentLlmSettings();
    } else if (modelSettingsPreviewState === "disabled-models") {
      mockAgentLlmSettings.models = mockAgentLlmSettings.models.map((model) => ({ ...model, enabled: false }));
      rebuildMockAgentLlmSettings();
    } else if (modelSettingsPreviewState === "no-models") {
      mockAgentLlmSettings.models = [];
      rebuildMockAgentLlmSettings();
    } else if (modelSettingsPreviewState === "ready-to-test") {
      mockAgentLlmSettings.models = mockAgentLlmSettings.models.map((model) => ({ ...model, last_test: null }));
      rebuildMockAgentLlmSettings();
    } else if (modelSettingsPreviewState === "connection-error") {
      mockAgentLlmSettings.models[0].last_test = {
        status: "error",
        checked_at: new Date().toISOString(),
        latency_ms: null,
        error_class: "network",
        message: "Preview connection failure.",
      };
      rebuildMockAgentLlmSettings();
    } else if (modelSettingsPreviewState === "long-name") {
      mockAgentLlmSettings.providers[0].display_name = "DeepSeek Research Gateway With A Deliberately Long Provider Name";
      mockAgentLlmSettings.models[0].display_name = "DeepSeek V4 Flash With Extended Reasoning And A Deliberately Long Model Name";
      rebuildMockAgentLlmSettings();
    }
    await loadAgentLlmSettings();
    openAgentLlmDialog();
    if (previewParams.get("state") === "wizard") openAgentLlmProviderWizard();
    if (previewParams.get("state") === "model") openAgentLlmModelDialog(state.agentLlm.selectedModelEditorId);
    if (previewParams.get("state") === "add-model") openAgentLlmModelDialog(null);
    if (previewParams.get("state") === "advanced") {
      switchAgentLlmView("connections");
      $("#agentLlmProviderAdvanced").open = true;
    }
    if (previewParams.get("state") === "routing") {
      state.agentLlm.routingExpandedCapability = "agent.chat";
      switchAgentLlmView("routing");
      renderAgentLlmDialog();
    }
    if (previewParams.get("state") === "add-model") {
      window.setTimeout(() => recordPreviewLayoutEvidence(), 140);
    } else {
      requestAnimationFrame(() => recordPreviewLayoutEvidence());
    }
    return;
  }
  if (scenario === "interface-shell") {
    state.posture = "human";
    applyPostureLayout();
    applyWorkbenchLayout("code");
    $("#projectName").textContent = "D:/研究项目/单细胞 RNA-seq 质量控制与差异分析";
    $("#plotCount").textContent = "12";
    $("#problemCount").textContent = "3";
    await openDocument("examples/editor-intelligence.R");
    await openDocument("reports/claim-review-demo.qmd");
    $("#projectName").textContent = "D:/研究项目/单细胞 RNA-seq 质量控制与差异分析";
    requestAnimationFrame(() => recordPreviewLayoutEvidence());
    return;
  }
  if (scenario === "evidence-claims") {
    seedMockEvidenceClaims();
    state.evidenceClaimPreviewProbe = await runEvidenceClaimMockIsolationProbe();
    if (previewParams.get("state") === "create-error") {
      mockEvidenceClaimCreateFailure = "The selected Evidence entry is no longer available.";
    }
    state.artifacts = structuredClone(mockArtifacts.filter((artifact) => artifact.project_root === mockLastProject));
    applyWorkbenchLayout("analyze");
    await switchContextTab("evidence");
    await loadEvidenceEntries();
    switchEvidenceTab("claims");
    await loadEvidenceClaims();
    if (previewParams.get("state") === "form" || previewParams.get("state") === "create-error") $("#evidenceClaimNew").click();
    requestAnimationFrame(() => recordPreviewLayoutEvidence());
    return;
  }
  if (scenario === "agent-first-direct") {
    const previewState = previewParams.get("state") || "default";
    state.posture = "agent";
    state.agentSurface = "direct";
    if (previewState === "task-rail") {
      state.agentMode = "ask";
      const askTurn = createMockAgentTurn({
        prompt: "Summarize the current project context.",
        mode: "ask",
        model: "mock-read-only",
      });
      askTurn.status = "completed";
      askTurn.prompt_preview = "";
      askTurn.final_message = "";
      askTurn.error_message = null;
      const askConversation = mockAgentConversations.find((item) => item.conversation_id === askTurn.conversation_id);
      if (askConversation) askConversation.title = "";

      const planTurn = createMockAgentTurn({
        prompt: "Plan a reproducible 单细胞 RNA-seq quality-control workflow with deliberately long context that must stay inside the Task Rail row without widening the page.",
        mode: "plan",
        model: "mock-read-only",
      });
      const actTurn = createMockAgentTurn({
        prompt: "Apply the reviewed source edit.",
        mode: "act",
        model: "mock-tool-capable",
        autoApprove: true,
      });
      planTurn.status = "running";
      planTurn.finished_at = null;
      planTurn.final_message = null;
      actTurn.status = "failed";
      actTurn.finished_at = new Date().toISOString();
      actTurn.final_message = null;
      actTurn.error_message = "The reviewed edit could not be applied.";
      await loadAgentData();
    } else if (previewState === "conversation-switch") {
      const runningTurn = createMockAgentTurn({
        prompt: "Plan a long-running analysis in the first conversation.",
        mode: "plan",
        model: "mock-read-only",
      });
      runningTurn.status = "running";
      runningTurn.finished_at = null;
      runningTurn.final_message = null;
      const emptyConversation = createMockAgentConversation();
      state.selectedConversationId = emptyConversation.conversation_id;
      await loadAgentData();
    } else if (previewState === "parallel-turns") {
      const firstTurn = createMockAgentTurn({
        prompt: "Inspect the current project structure in the first conversation.",
        mode: "ask",
        model: "mock-read-only",
      });
      firstTurn.status = "running";
      firstTurn.finished_at = null;
      firstTurn.final_message = null;
      const secondTurn = createMockAgentTurn({
        prompt: "Plan an independent reproducibility review in the second conversation.",
        mode: "plan",
        model: "mock-read-only",
      });
      secondTurn.status = "running";
      secondTurn.finished_at = null;
      secondTurn.final_message = null;
      state.selectedConversationId = secondTurn.conversation_id;
      await loadAgentData();
    } else if (!["empty", "outputs-empty"].includes(previewState)) {
      const approvalPreview = previewState === "approval";
      const fileProposalPreview = previewState === "file-proposal";
      state.agentMode = approvalPreview ? "act" : "ask";
      await invoke("run_agent", {
        prompt: fileProposalPreview
          ? "Review @analysis.R and propose a concise QC summary at the current cursor."
          : "Review the current QC analysis and identify the next decision.",
        mode: state.agentMode,
      });
      await loadAgentData();
    }
    applyPostureLayout();
    $("#agentInput").value = previewState === "empty"
      ? ""
      : "Compare the flagged samples with the current thresholds";
    if (previewState === "paths") {
      recordMockRun({
        runId: "run_extended_path_display",
        origin: "user",
        status: "completed",
        code: "summary(qc)",
        sourcePath: "//?/E:/Research/analysis.R",
        executionMode: "file",
        documentVersion: 1,
      });
      recordMockRun({
        runId: "run_internal_lockfile_refresh",
        origin: "system",
        status: "completed",
        code: 'getOption("rho.bridge.env")$rho_list_lockfile_packages("//?/E:/Research")',
        requestType: "workspace.environment_query",
        operationClass: "read_only",
      });
      await loadRunData();
      switchAgentSurface("monitor");
    } else if (previewState === "outputs-empty") {
      switchAgentSurface("outputs");
    } else if (["outputs", "outputs-plot", "outputs-pruned", "outputs-artifact", "outputs-generated"].includes(previewState)) {
      const run = recordMockRun({
        runId: "run_agent_output_review",
        origin: "agent",
        status: "completed",
        code: "plot(qc$library_size, qc$mitochondrial_percent)",
        sourcePath: "examples/single-cell-qc/03-visualize-qc.R",
        executionMode: "file",
        documentVersion: 1,
      });
      const plot = {
        plot_id: "plot_agent_output_review",
        run_id: run.run_id,
        project_root: mockLastProject,
        source_path: run.source_path,
        execution_mode: "file",
        document_version: 1,
        workspace_id: "desktop_mock",
        state_revision: state.revision.state_revision,
        project_revision: state.revision.project_revision,
        media_type: "image/png",
        payload_json: JSON.stringify(previewState === "outputs-pruned" ? { "rho/pruned": true } : { "rho/mock-image": MOCK_PLOT_DATA_URL }),
        provenance_complete: true,
        created_at: run.started_at,
      };
      mockPlots.unshift(plot);
      if (previewState === "outputs-generated") {
        mockUpsertProjectFile(mockLastProject, "results/qc-summary.csv", "sample,score\nA,0.92\n", { trackInTree: false, kind: "artifact" });
        mockUpsertProjectFile(mockLastProject, "results/qc-figure.png", "mock-png", { trackInTree: false, kind: "artifact" });
        createMockArtifactRecord({
          artifactKind: "generated_file",
          runId: run.run_id,
          outputPath: "results/qc-summary.csv",
          sourcePath: run.source_path,
          executionMode: run.execution_mode,
          documentVersion: run.document_version,
          mediaType: "text/csv",
          metadata: { discovery: "project_file_delta", change_kind: "created", size_bytes: 20 },
        });
        createMockArtifactRecord({
          artifactKind: "generated_file",
          runId: run.run_id,
          outputPath: "results/qc-figure.png",
          sourcePath: run.source_path,
          executionMode: run.execution_mode,
          documentVersion: run.document_version,
          mediaType: "image/png",
          metadata: { discovery: "project_file_delta", change_kind: "created", size_bytes: 8 },
        });
      }
      await loadRunData();
      if (previewState === "outputs-artifact") {
        await invoke("export_plot_artifact", { request: { plot_id: plot.plot_id, path: "artifacts/qc-review.png" } });
        await loadRunData();
      }
      switchAgentSurface("outputs");
      if (previewState === "outputs-plot") await openAgentOutput("plot", plot.plot_id);
    } else if (previewState === "file") {
      await openDocument("analysis.R");
    } else if (previewState === "run" || previewState === "artifact") {
      const previewRun = await invoke("execute_r", {
        request: {
          code: "summary(qc)",
          source_path: "analysis.R",
          execution_mode: "file",
          document_version: 1,
        },
      });
      await loadRunData();
      state.activeRunId = previewRun?.run_id || state.runs[0]?.run_id || null;
      state.agentReviewRunId = previewRun?.run_id || state.runs[0]?.run_id || null;
      if (previewState === "artifact") {
        const plot = activePlotRecord();
        if (plot) {
          const detail = await invoke("export_plot_artifact", {
            request: { plot_id: plot.plot_id, path: "artifacts/agent-review.png" },
          });
          state.selectedArtifactId = detail?.artifact?.artifact_id || null;
          state.selectedArtifactDetail = detail || null;
          openAgentWorkSurface("artifact");
        }
      } else {
        openAgentWorkSurface("run");
      }
    } else if (["review-plot", "review-running", "review-failed", "review-no-evidence"].includes(previewState)) {
      const failedReview = previewState === "review-failed";
      const run = recordMockRun({
        runId: "run_agent_qc_plot",
        origin: "agent",
        status: previewState === "review-running" ? "running" : failedReview ? "failed" : "completed",
        code: "ggplot(qc, aes(library_size, mitochondrial_percent)) + geom_point()",
        sourcePath: "examples/single-cell-qc/03-visualize-qc.R",
        executionMode: "file",
        documentVersion: 1,
        errorMessage: failedReview ? "object 'mitochondrial_percent' not found" : null,
        errorCall: failedReview ? "geom_point()" : null,
      });
      if (previewState === "review-running") {
        run.finished_at = null;
        run.value_text = null;
      }
      if (previewState === "review-plot") {
        run.stdout = "12 cells plotted";
        run.value_text = "<ggplot>";
        mockPlots.unshift({
          plot_id: "plot_agent_qc_review",
          run_id: run.run_id,
          project_root: mockLastProject,
          source_path: run.source_path,
          execution_mode: "file",
          document_version: 1,
          workspace_id: "desktop_mock",
          state_revision: state.revision.state_revision,
          project_revision: state.revision.project_revision,
          media_type: "image/png",
          payload_json: JSON.stringify({ "image/png": MOCK_PNG_BASE64 }),
          provenance_complete: true,
          created_at: run.started_at,
        });
      }
      recordMockRun({
        runId: "run_workspace_refresh",
        origin: "system",
        status: "running",
        requestType: "workspace.snapshot",
        operationClass: "read_only",
      });
      await loadRunData();
      state.agentReviewRunId = run.run_id;
      switchAgentSurface("monitor");
    } else if (previewState === "audit" || previewState === "audit-failure") {
      state.auditResult = previewState === "audit-failure"
        ? {
          scope: "project",
          status: "error",
          findings: [],
          coverage: { files_scanned: 1, runs_considered: 0, artifacts_considered: 0 },
          truncated: true,
          truncation_reasons: ["A source file could not be inspected."],
        }
        : {
          scope: "project",
          status: "findings",
          coverage: { files_scanned: 4, runs_considered: 2, artifacts_considered: 1 },
          findings: [{
            category: "randomness",
            severity: "warning",
            rule_id: "rho.repro.v1.randomness.rng_without_seed",
            summary: "Random analysis does not declare a seed.",
            evidence: [{ kind: "source_range", path: "analysis.R", line: 5, excerpt: "x <- rnorm(100)" }],
            limitations: [],
          }],
          truncated: false,
          truncation_reasons: [],
        };
      openAgentWorkSurface("audit");
    }
    setTimeout(recordPreviewLayoutEvidence, 0);
    return;
  }
  if (scenario === "git-review") {
    seedMockGitReview();
    await loadGitStatus();
    applyWorkbenchLayout("analyze");
    await switchContextTab("git");
    const gitPreviewState = previewParams.get("state");
    if (gitPreviewState === "stale") {
      mockGitRevisionSequence += 1;
    } else if (gitPreviewState === "failure") {
      mockGitFailureCommand = "git_diff";
      await loadGitReview({ preserveSelection: false });
      mockGitFailureCommand = null;
    }
    requestAnimationFrame(() => recordPreviewLayoutEvidence());
    return;
  }
  if (scenario === "environment-lockfile") {
    applyWorkbenchLayout("analyze");
    await loadPackageInventories();
    switchEnvironmentPackageTab("lockfile");
    requestAnimationFrame(() => recordPreviewLayoutEvidence());
    return;
  }
  if (scenario === "environment-package") {
    applyWorkbenchLayout("analyze");
    await switchContextTab("environment");
    await loadPackageInventories();
    switchEnvironmentPackageTab("lockfile");
    const previewState = previewParams.get("state") || "form";
    const operation = previewParams.get("operation") || "update_package";
    const packageName = previewParams.get("package") || "ggplot2";
    if (previewState === "form") {
      openPackageManagementDialog(operation, packageName, $("#environmentManagePackageButton"));
    } else {
      const request = createMockEnvironmentOperationRequest(operation, { package: packageName });
      if (["stale", "failed", "interrupted", "running", "rejected"].includes(previewState)) {
        request.status = previewState;
        request.reason = {
          stale: "Workspace or project revision changed before confirmation.",
          failed: "Repository was unavailable; partial library writes may exist.",
          interrupted: "Operation was interrupted; refresh the project library before recovery.",
          rejected: "Package operation was rejected without changing the project library.",
        }[previewState] || null;
      }
      state.environmentOperations = [...mockEnvironmentOperationRequests];
      renderEnvironmentOperationCard();
      openEnvironmentOperationDialog(request.request_id, $("#environmentManagePackageButton"));
    }
    requestAnimationFrame(() => recordPreviewLayoutEvidence());
    return;
  }
  if (scenario === "local-help") {
    await showLocalHelp(previewParams.get("topic") || "lm", previewParams.get("package") || null);
    requestAnimationFrame(() => recordPreviewLayoutEvidence());
    return;
  }
  if (scenario === "installed-help") {
    await showLocalHelp(previewParams.get("topic") || "lm", previewParams.get("package") || "stats");
    const requestedView = previewParams.get("view");
    if (["overview", "arguments", "examples", "vignettes"].includes(requestedView)) {
      setInstalledHelpView(requestedView);
    }
    setTimeout(recordPreviewLayoutEvidence, 0);
    return;
  }
  if (scenario === "console-help") {
    await executeCode({
      code: `?${previewParams.get("topic") || "mean"}`,
      type: "console",
      sourcePath: "<console>",
      documentVersion: null,
      range: null,
    });
    setTimeout(recordPreviewLayoutEvidence, 0);
    return;
  }
  if (scenario === "project-references") {
    await showProjectReferences(previewParams.get("symbol") || "flag_low_quality");
    requestAnimationFrame(() => recordPreviewLayoutEvidence());
    return;
  }
  if (scenario === "lint-quick-fix") {
    applyWorkbenchLayout("analyze");
    await openDocument(previewParams.get("path") || "examples/editor-intelligence.R");
    await lintCurrentFile();
    switchDockTab("problems");
    setTimeout(recordPreviewLayoutEvidence, 0);
    return;
  }
  if (scenario === "agent-help-link") {
    applyWorkbenchLayout("agent");
    await showLocalHelp("lm", "stats");
    const helpState = previewParams.get("state") || "linked";
    if (helpState === "attached") {
      attachLocalHelpToAgent();
    } else if (helpState === "linked" || helpState === "partial" || helpState === "mismatch") {
      const context = normalizedAgentLocalHelpContext();
      if (context) {
        if (helpState === "partial") {
          context.incomplete = true;
          context.notices = ["example_byte_limit"];
        }
        if (helpState === "mismatch") context.project_root = "D:/other-project";
      }
      const linkedTurn = createMockAgentTurn({
        prompt: "Explain this API using the installed Help context.",
        mode: "ask",
        model: "DeepSeek V4 Flash",
        editorContext: { project_root: state.project.root, local_help: context },
      });
      linkedTurn.final_message = helpState === "partial"
        ? "The installed Help identifies stats::lm, but this bounded record is partial; inspect the missing sections before relying on the explanation."
        : "The attached installed Help identifies stats::lm and its usage. I can explain the API, while the Local Help block below remains the source record to inspect.";
      const linkedAnswer = linkedTurn.events.find((event) => event.event_type === "chat.message_completed");
      if (linkedAnswer) linkedAnswer.body = linkedTurn.final_message;
      await loadAgentData();
    } else if (helpState === "model-only") {
      createMockAgentTurn({
        prompt: "Explain this API from your general knowledge.",
        mode: "ask",
        model: "DeepSeek V4 Flash",
        editorContext: { project_root: state.project.root, local_help: null },
      });
      await loadAgentData();
    }
    switchAgentSurface("direct");
    setTimeout(recordPreviewLayoutEvidence, 0);
    return;
  }
  if (scenario === "editor-refactor") {
    state.posture = "human";
    state.humanPreset = "code";
    applyPostureLayout();
    await openDocument("examples/editor-intelligence.R");
    const refactorState = previewParams.get("state") || "rename";
    if (refactorState === "extract") {
      const documentState = activeDocument();
      const start = documentState.content.indexOf("example_value");
      const lineEnd = documentState.content.indexOf("\n", start);
      documentState.cursorStart = start;
      documentState.cursorEnd = lineEnd < 0 ? documentState.content.length : lineEnd;
      applyDocumentSelection(documentState);
      await requestExtractFunction({ functionName: "median_value", returnFocus: $("#editorExtractButton") });
    } else {
      await requestRenameSymbol({ oldName: "flag_low_quality", newName: "flag_low_quality_qc", returnFocus: $("#editorRenameButton") });
      if (refactorState === "stale" && state.refactor.proposal) {
        const target = state.refactor.proposal.targets[0];
        replaceRefactorDocumentContent(target, `${target.before}\n# intervening editor change\n`);
        renderActiveDocument();
        await applyRefactorProposal();
      } else if (refactorState === "applied" && state.refactor.proposal) {
        await applyRefactorProposal();
      }
    }
    requestAnimationFrame(() => recordPreviewLayoutEvidence());
    return;
  }
  if (scenario === "editor-format") {
    state.posture = "human";
    state.humanPreset = "code";
    applyPostureLayout();
    await openDocument("examples/editor-formatting.R");
    const formatState = previewParams.get("state") || "formatted";
    if (formatState === "stale") {
      await requestFormatDocument({ returnFocus: $("#editorFormatButton") });
      if (state.refactor.proposal) {
        const target = state.refactor.proposal.targets[0];
        replaceRefactorDocumentContent(target, `${target.before}\n# intervening editor change\n`);
        renderActiveDocument();
        await applyRefactorProposal();
      }
    } else {
      await requestFormatDocument({ returnFocus: $("#editorFormatButton") });
      if (formatState === "applied" && state.refactor.proposal) {
        await applyRefactorProposal();
      } else if (formatState === "undo" && state.refactor.proposal) {
        await applyRefactorProposal();
        await undoRefactorProposal();
      }
    }
    requestAnimationFrame(() => recordPreviewLayoutEvidence());
    return;
  }
  applyWorkbenchLayout("analyze");
  if (scenario === "console-logs") {
    addTerminalCommand("summary(iris$Sepal.Length)");
    addTerminalOutput("   Min. 1st Qu.  Median    Mean 3rd Qu.    Max.\n  4.300   5.100   5.800   5.843   6.400   7.900");
    addTerminalCommand("mean(iris$Sepal.Length)");
    addTerminalOutput("[1] 5.843333");
    addLog("SYSTEM", "R version 4.6.1 · R session ready");
    addLog("AGENT", "R work completed");
    if (previewParams.get("state") === "repair-entry") {
      await openDocument("analysis.R");
      const parseCode = "summary(qc，)";
      const parseDocumentContent = `# Project analysis\n${parseCode}\n`;
      const parseDocument = activeDocument();
      if (parseDocument) {
        parseDocument.content = parseDocumentContent;
        parseDocument.savedContent = parseDocumentContent;
        parseDocument.versionId = Number(parseDocument.versionId || 0) + 1;
        parseDocument.cursorStart = 0;
        parseDocument.cursorEnd = 0;
        mockProjects[state.project.root].contents["analysis.R"] = parseDocumentContent;
        renderActiveDocument();
      }
      const renderMockConsoleFailure = (runId) => {
        const documentVersion = activeDocument()?.versionId ?? 0;
        recordMockRun({
          runId,
          origin: "user",
          status: "failed",
          code: parseCode,
          sourcePath: "analysis.R",
          executionMode: "selection",
          documentVersion,
          errorMessage: "<text>:1:11: unexpected input",
          sourceRange: { start_line: 2, start_column: 1, end_line: 2, end_column: 13 },
          errorRange: {
            start_line: 2,
            start_column: 11,
            end_line: 2,
            end_column: 12,
            range_kind: "r_parse_token",
          },
        });
        renderExecution({
          execution_id: runId,
          execution: {
            ok: false,
            kind: "execute",
            error: { message: "<text>:1:11: unexpected input", call: null },
            traceback: [],
          },
        }, {
          type: "selection",
          sourcePath: "analysis.R",
          documentVersion,
          sourceRange: { start_line: 2, start_column: 1, end_line: 2, end_column: 13 },
        });
        return Array.from(state.consoleRepairEntries.values()).at(-1);
      };

      const probeEntry = renderMockConsoleFailure("run_console_repair_probe");
      await loadRunData({ quiet: true });
      state.consoleRepairPreviewProbe = await runConsoleRepairEntryMockProbe(probeEntry);

      renderMockConsoleFailure("run_console_repair_visible");
      await loadRunData({ quiet: true });
      $("#toastRegion").replaceChildren();
      applyWorkbenchLayout("analyze");
    }
    switchDockTab("console");
    requestAnimationFrame(() => recordPreviewLayoutEvidence());
    return;
  }
  if (scenario === "usability-problems") {
    const parseSource = "value <- c(1， 2)\n";
    mockUpsertProjectFile(mockLastProject, "parse-error.R", parseSource, {
      trackInTree: true,
      kind: "source",
    });
    state.project = mockProjectState(mockLastProject);
    recordMockRun({
      runId: "run_parse_problem",
      origin: "user",
      status: "failed",
      code: parseSource,
      sourcePath: "parse-error.R",
      executionMode: "file",
      documentVersion: 1,
      errorMessage: "<text>:1:13: unexpected input",
      sourceRange: { start_line: 1, start_column: 1, end_line: 2, end_column: 1 },
      errorRange: {
        start_line: 1,
        start_column: 13,
        end_line: 1,
        end_column: 14,
        range_kind: "r_parse_token",
      },
    });
    recordMockRun({
      runId: "run_console_problem",
      origin: "user",
      status: "failed",
      code: "summary(mitochondrial_percent)",
      sourcePath: "<console>",
      executionMode: "console",
      errorMessage: "object 'mitochondrial_percent' not found",
      errorCall: "summary(mitochondrial_percent)",
      traceback: ["summary(mitochondrial_percent)", "eval(ei, envir)"],
    });
    recordMockRun({
      runId: "run_file_problem",
      origin: "user",
      status: "failed",
      code: "summary(qc)",
      sourcePath: "analysis.R",
      executionMode: "selection",
      documentVersion: 0,
      errorMessage: "object 'qc' not found",
      errorCall: "summary(qc)",
      traceback: ["summary(qc)", "eval(ei, envir)"],
      sourceRange: { start_line: 2, start_column: 1, end_line: 2, end_column: 12 },
      errorRange: { start_line: 2, start_column: 1, end_line: 2, end_column: 12 },
    });
    recordMockRun({
      runId: "run_missing_problem",
      origin: "user",
      status: "failed",
      code: "summary(removed_data)",
      sourcePath: "deleted-analysis.R",
      executionMode: "file",
      errorMessage: "source file was removed",
    });
    state.problems = mockProblemList().filter((problem) =>
      ["run_parse_problem", "run_console_problem", "run_file_problem", "run_missing_problem"].includes(problem.run_id)
    );
    renderProblems();
    switchDockTab("problems");
    if (previewParams.get("state") === "repair-probe") {
      const fileProblem = state.problems.find((problem) => problem.run_id === "run_file_problem");
      const consoleProblem = state.problems.find((problem) => problem.run_id === "run_console_problem");
      const parseProblem = state.problems.find((problem) => problem.run_id === "run_parse_problem");
      state.problemRepairPreviewProbe = await runProblemRepairMockProbe(fileProblem, consoleProblem, parseProblem);
      state.problems = mockProblemList().filter((problem) =>
        ["run_parse_problem", "run_console_problem", "run_file_problem", "run_missing_problem"].includes(problem.run_id)
      );
      applyWorkbenchLayout("analyze");
      renderProblems();
      switchDockTab("problems");
    }
    requestAnimationFrame(() => recordPreviewLayoutEvidence());
    return;
  }
  if (scenario === "usability-save") {
    state.posture = "human";
    state.humanPreset = "code";
    applyPostureLayout();
    await openDocument("analysis.R");
    const documentState = activeDocument();
    replaceRefactorDocumentContent(
      { path: documentState.path, before: documentState.content, savedContent: documentState.savedContent },
      `${documentState.content.trimEnd()}\n# Unsaved shortcut review\n`,
    );
    documentState.cursorStart = documentState.content.length;
    documentState.cursorEnd = documentState.content.length;
    renderActiveDocument();
    requestAnimationFrame(() => recordPreviewLayoutEvidence());
    return;
  }
  if (scenario === "wp2-data-viewer") {
    if (previewParams.get("state") === "refresh-probe") {
      state.dataViewerRefreshPreviewProbe = await runDataViewerRefreshMockProbe();
    } else {
      await inspectEnvironmentObject(previewParams.get("object") || "qc");
    }
    requestAnimationFrame(() => recordPreviewLayoutEvidence());
    return;
  }
  if (scenario === "wp3-artifacts" && previewParams.get("state") === "invalid-plot") {
    state.plots = [{
      plot_id: "plot_invalid_preview",
      run_id: "run_invalid_preview",
      project_root: mockLastProject,
      source_path: "analysis.R",
      execution_mode: "file",
      document_version: 1,
      workspace_id: "desktop_mock",
      state_revision: state.revision.state_revision,
      project_revision: state.revision.project_revision,
      media_type: "image/png",
      payload_json: "{invalid plot payload",
      provenance_complete: true,
      created_at: new Date().toISOString(),
    }];
    state.selectedPlotId = state.plots[0].plot_id;
    renderPlots();
    switchDockTab("plots");
    requestAnimationFrame(() => recordPreviewLayoutEvidence());
    return;
  }
  if (scenario === "wp3-artifacts" && previewParams.get("state") === "console-plots") {
    await invoke("execute_r", { request: { code: "plot(1:10)", source_path: "<console>", execution_mode: "console" } });
    await invoke("execute_r", { request: { code: "hist(rnorm(100))", source_path: "<console>", execution_mode: "console" } });
    await loadRunData();
    switchDockTab("plots");
    requestAnimationFrame(() => recordPreviewLayoutEvidence());
    return;
  }
  await invoke("execute_r", {
    request: {
      code: "plot(qc$reads, qc$detected)",
      source_path: "analysis.R",
      execution_mode: "file",
      document_version: 1,
    },
  });
  await loadRunData();
  await inspectEnvironmentObject(previewParams.get("object") || "qc");
  const page = state.selectedDataPage;
  if (page) {
    const tableDetail = await invoke("export_data_view_artifact", {
      request: {
        path: "artifacts/qc-table.csv",
        format: "csv",
        object_name: page.object_name,
        view_token: page.view_token,
        view_kind: page.view_kind,
        view_key: page.view_key,
        row_offset: page.row_offset,
        row_limit: page.row_limit,
        column_offset: page.column_offset,
        column_limit: page.column_limit,
        query: page.query,
        sort_column: page.sort_column,
        sort_direction: page.sort_direction,
        workspace: currentViewerWorkspace(),
      },
    });
    state.selectedArtifactId = tableDetail?.artifact?.artifact_id || null;
    state.selectedArtifactDetail = tableDetail || null;
  }
  await invoke("render_document", {
    request: {
      path: "report.Rmd",
      document_version: 3,
    },
  });
  const plot = activePlotRecord();
  if (plot) {
    const plotDetail = await invoke("export_plot_artifact", {
      request: { plot_id: plot.plot_id, path: "artifacts/qc-plot.png" },
    });
    state.selectedArtifactId = plotDetail?.artifact?.artifact_id || state.selectedArtifactId;
    state.selectedArtifactDetail = plotDetail || state.selectedArtifactDetail;
  }
  const missingArtifact = mockArtifacts.find((artifact) => artifact.artifact_kind === "render_output") || null;
  if (missingArtifact) {
    const project = mockProjects[missingArtifact.project_root] || mockProjects[mockLastProject];
    if (project?.contents) delete project.contents[missingArtifact.output_path];
    state.selectedArtifactId = missingArtifact.artifact_id;
  }
  await loadRunData();
  switchDockTab("plots");
  requestAnimationFrame(() => recordPreviewLayoutEvidence());
}

function rectEvidence(element) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    right: Math.round(rect.right),
    bottom: Math.round(rect.bottom),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function rectsOverlap(a, b) {
  if (!a || !b) return false;
  return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
}

function recordPreviewLayoutEvidence() {
  const scenario = previewParams.get("preview");
  if (!["agent-first-direct", "interface-shell", "console-logs", "git-review", "wp2-data-viewer", "wp3-artifacts", "environment-lockfile", "environment-package", "local-help", "installed-help", "console-help", "project-references", "lint-quick-fix", "agent-help-link", "editor-refactor", "editor-format", "evidence-claims", "usability-problems", "model-settings"].includes(scenario)) return;
  let target = $("#previewEvidence");
  if (!target) {
    target = document.createElement("pre");
    target.id = "previewEvidence";
    target.hidden = true;
    document.body.append(target);
  }
  if (scenario === "console-logs") {
    const lastEntry = $("#consoleOutput .terminal-entry:last-child");
    const lastRepairEntry = $("#consoleOutput .console-error-entry:last-child");
    const lastRepairAction = lastRepairEntry?.querySelector(".console-repair-action") || null;
    const transcript = rectEvidence($("#consoleOutput"));
    const prompt = rectEvidence($(".console-input"));
    const tabs = rectEvidence($(".dock-tabs"));
    const repairEntry = rectEvidence(lastRepairEntry);
    const repairAction = rectEvidence(lastRepairAction);
    const evidence = {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      active_dock_tab: document.querySelector("[data-dock-tab].active")?.dataset.dockTab || null,
      counts: {
        terminal_entries: $$("#consoleOutput .terminal-entry").length,
        log_entries: $$("#logsOutput .log-entry").length,
        repair_entries: $$("#consoleOutput .console-error-entry").length,
      },
      repair_actions: $$("#consoleOutput .console-repair-action").map((button) => ({
        label: button.textContent,
        disabled: button.disabled,
        action: button.dataset.repairAction || null,
      })),
      panels: {
        console_hidden: $("#consolePanel").classList.contains("hidden"),
        logs_hidden: $("#logsPanel").classList.contains("hidden"),
      },
      overlaps: {
        last_entry_with_prompt: rectsOverlap(rectEvidence(lastEntry), prompt),
        repair_entry_with_prompt: rectsOverlap(repairEntry, prompt),
        repair_message_with_action: rectsOverlap(
          rectEvidence(lastRepairEntry?.querySelector(".console-error-message")),
          repairAction,
        ),
      },
      ordering: {
        prompt_after_transcript: Boolean(transcript && prompt && prompt.top >= transcript.bottom),
      },
      document_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      repair_probe: state.consoleRepairPreviewProbe,
      rects: { transcript, prompt, tabs, repair_entry: repairEntry, repair_action: repairAction },
    };
    target.textContent = JSON.stringify(evidence);
    return;
  }
  if (scenario === "model-settings") {
    const dialog = rectEvidence($("#agentLlmDialog .agent-llm-surface"));
    const shell = rectEvidence($("#agentLlmShell"));
    const rail = rectEvidence($(".agent-llm-provider-rail"));
    const detail = rectEvidence($("#agentLlmProviderDetail"));
    target.textContent = JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      state: previewParams.get("state") || "default",
      counts: {
        providers: $$(".agent-llm-provider-card").length,
        visible_models: $$(".agent-llm-connection-model-card").length,
      },
      disclosures: {
        provider_advanced_open: $("#agentLlmProviderAdvanced").open,
        provider_danger_open: $("#agentLlmProviderDanger").open,
        wizard_open: !$("#agentLlmProviderWizard").classList.contains("hidden"),
        model_editor_open: !$("#agentLlmModelDialog").classList.contains("hidden"),
        model_manual_open: $("#agentLlmModelManualFields").open,
        wizard_manual_open: $("#agentLlmWizardManualModel").open,
      },
      discovery: {
        model_status: state.agentLlm.modelDiscovery.status,
        wizard_status: state.agentLlm.wizardDiscovery.status,
        model_options: $("#agentLlmModelDiscoveredModel").options.length - 1,
        wizard_options: $("#agentLlmWizardDiscoveredModel").options.length - 1,
      },
      credential_inputs_empty: [$("#agentLlmCredential"), $("#agentLlmWizardCredential")]
        .every((input) => !input.value),
      overflow: {
        document_x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        dialog_x: Boolean(dialog && dialog.width > window.innerWidth),
      },
      overlap: { rail_with_detail: rectsOverlap(rail, detail) },
      rects: { dialog, shell, rail, detail },
    });
    return;
  }
  if (scenario === "usability-problems") {
    target.textContent = JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      state: previewParams.get("state") || "default",
      active_dock_tab: document.querySelector("[data-dock-tab].active")?.dataset.dockTab || null,
      problem_count: groupedProblems().length,
      action_labels: $$("#problemList .problem-actions button").map((button) => button.textContent),
      source_unavailable_count: $$("#problemList .problem-source-unavailable").length,
      repair_probe: state.problemRepairPreviewProbe,
      document_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    });
    return;
  }
  if (scenario === "interface-shell") {
    const topbar = rectEvidence($(".topbar"));
    const project = rectEvidence($("#projectSwitcher"));
    const tabs = $$(".document-tab").map(rectEvidence);
    const editor = rectEvidence($(".editor-region"));
    target.textContent = JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      posture: state.posture,
      human_preset: state.humanPreset,
      overflow: {
        document_x: document.documentElement.scrollWidth > window.innerWidth,
        topbar_x: $(".topbar").scrollWidth > $(".topbar").clientWidth,
      },
      labels: {
        project_truncated: $("#projectName").scrollWidth > $("#projectName").clientWidth,
        document_tabs: $$(".document-tab").map((tab) => tab.textContent.trim()),
      },
      counts: { plots: $("#plotCount").textContent, problems: $("#problemCount").textContent },
      selections: {
        document: $$(".document-tab-main").map((tab) => tab.getAttribute("aria-selected")),
        dock: document.querySelector('[data-dock-tab][aria-selected="true"]')?.dataset.dockTab || null,
        context: document.querySelector('[data-context-tab][aria-selected="true"]')?.dataset.contextTab || null,
      },
      panels: {
        left: Number($("#leftResizeHandle").getAttribute("aria-valuenow")),
        right: Number($("#rightResizeHandle").getAttribute("aria-valuenow")),
        dock: Number($("#dockResizeHandle").getAttribute("aria-valuenow")),
        dock_expanded: $("#toggleDockMaximize").dataset.expanded === "true",
      },
      rects: { topbar, project, tabs, editor },
    });
    return;
  }
  if (scenario === "evidence-claims") {
    const panel = rectEvidence($("#evidencePanel"));
    const list = rectEvidence($("#evidenceClaimList"));
    target.textContent = JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      active_context_tab: document.querySelector("[data-context-tab].active")?.dataset.contextTab || null,
      evidence_tab: state.evidenceTab,
      claims: state.evidenceClaims.length,
      statuses: Array.from(state.evidenceClaimReviews.values()).map((review) => review.status),
      form_open: !$("#evidenceClaimForm").classList.contains("hidden"),
      project_isolation: state.evidenceClaimPreviewProbe,
      document_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      list_outside_panel: Boolean(panel && list && (list.left < panel.left || list.right > panel.right)),
      rects: { panel, list },
    });
    return;
  }
  if (scenario === "git-review") {
    const panel = rectEvidence($("#gitPanel"));
    const diff = rectEvidence($("#gitDiffReview"));
    target.textContent = JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      active_context_tab: document.querySelector("[data-context-tab].active")?.dataset.contextTab || null,
      counts: {
        working: state.gitReview.working.length,
        staged: state.gitReview.staged.length,
        hunks: state.gitReview.diff?.hunks?.length || 0,
      },
      selected: {
        path: state.gitReview.selectedPath,
        staged: state.gitReview.selectedStaged,
        revision: state.gitReview.diff?.revision || null,
      },
      visible: {
        panel: !$("#gitPanel").classList.contains("hidden"),
        restore: Boolean($("#gitFileActions .danger")),
        hunk_action: Boolean($("#gitHunkList .git-hunk-action")),
      },
      status: { loading: state.gitReview.loading, error: state.gitReview.error },
      overlaps: {
        diff_outside_panel: Boolean(panel && diff && diff.width > 0 && (diff.left < panel.left || diff.right > panel.right)),
      },
    });
    return;
  }
  if (scenario === "environment-lockfile") {
    const section = rectEvidence($(".package-list-section"));
    const tabs = rectEvidence($(".package-tabs"));
    const search = rectEvidence($("#packageFilter"));
    const list = rectEvidence($("#packageList"));
    target.textContent = JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      active_context_tab: document.querySelector("[data-context-tab].active")?.dataset.contextTab || null,
      active_package_tab: state.environmentPackageTab,
      lockfile_state: state.lockfilePackages?.lockfile?.state || null,
      dependency_role_state: state.lockfilePackages?.dependency_roles?.state || null,
      counts: state.lockfilePackages?.counts || null,
      rows: $$("#packageList .package-row.lockfile").length,
      document_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      overlaps: {
        tabs_with_search: rectsOverlap(tabs, search),
        search_with_list: rectsOverlap(search, list),
      },
      rects: { section, tabs, search, list },
    });
    return;
  }
  if (scenario === "environment-package") {
    const management = rectEvidence($("#packageManagementDialog .product-dialog-surface"));
    const review = rectEvidence($("#environmentOperationDialog .product-dialog-surface"));
    const packageList = rectEvidence($("#packageList"));
    const activeRequest = state.environmentOperations.find((item) => item.request_id === state.environmentOperationDialog.requestId) || null;
    target.textContent = JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      active_context_tab: document.querySelector("[data-context-tab].active")?.dataset.contextTab || null,
      package_tab: state.environmentPackageTab,
      management_open: !$("#packageManagementDialog").classList.contains("hidden"),
      review_open: !$("#environmentOperationDialog").classList.contains("hidden"),
      request: activeRequest ? { request_name: activeRequest.request_name, status: activeRequest.status } : null,
      document_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      overlaps: {
        management_outside_viewport: Boolean(management && (management.left < 0 || management.right > window.innerWidth)),
        review_outside_viewport: Boolean(review && (review.left < 0 || review.right > window.innerWidth)),
      },
      rects: { management, review, package_list: packageList },
    });
    return;
  }
  if (scenario === "local-help") {
    const panel = rectEvidence($("#localHelpPanel"));
    const content = rectEvidence($("#localHelpContent"));
    target.textContent = JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      active_context_tab: document.querySelector("[data-context-tab].active")?.dataset.contextTab || null,
      status: state.localHelp.status,
      record: state.localHelp.record ? {
        package: state.localHelp.record.package,
        topic: state.localHelp.record.help_topic,
        ambiguous: state.localHelp.record.ambiguous,
        truncated: state.localHelp.record.truncated,
        source_available: Boolean(state.localHelp.record.source_path),
      } : null,
      document_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      content_outside_panel: Boolean(panel && content && (content.left < panel.left || content.right > panel.right)),
      rects: { panel, content },
    });
    return;
  }
  if (scenario === "installed-help") {
    const panel = rectEvidence($("#localHelpPanel"));
    const content = rectEvidence($("#localHelpContent"));
    const example = state.installedHelp.record?.example || null;
    const helpRuns = state.runs.filter((run) => run.execution_mode === "help_example");
    target.textContent = JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      active_context_tab: document.querySelector("[data-context-tab].active")?.dataset.contextTab || null,
      location: {
        status: state.localHelp.status,
        package: state.localHelp.record?.package || null,
        help_record_visible: Boolean(state.localHelp.record?.help_record),
      },
      documentation: {
        status: state.installedHelp.status,
        found: Boolean(state.installedHelp.record?.found),
        active_view: state.installedHelp.activeView,
        incomplete: Boolean(state.installedHelp.record?.incomplete),
        truncated: Boolean(state.installedHelp.record?.truncated),
        example_visible: Boolean(example?.code),
        example_executable: Boolean(example?.executable),
      },
      execution: {
        confirmation_open: !$("#genericDialog").classList.contains("hidden"),
        help_example_runs: helpRuns.length,
        latest_status: helpRuns[0]?.status || null,
        latest_code: helpRuns[0]?.code || null,
        problems: state.problems.filter((problem) => problem.execution_mode === "help_example").length,
      },
      document_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      content_outside_panel: Boolean(panel && content && (content.left < panel.left || content.right > panel.right)),
      rects: { panel, content },
    });
    return;
  }
  if (scenario === "console-help") {
    const helpRun = state.runs.find((run) => run.execution_mode === "console" && /^\s*\?/.test(run.code || ""));
    target.textContent = JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      active_context_tab: document.querySelector("[data-context-tab].active")?.dataset.contextTab || null,
      location: {
        status: state.localHelp.status,
        package: state.localHelp.record?.package || null,
        topic: state.localHelp.record?.help_topic || null,
      },
      documentation: {
        status: state.installedHelp.status,
        found: Boolean(state.installedHelp.record?.found),
      },
      execution: {
        run_recorded: Boolean(helpRun),
        command_visible: $$("#consoleOutput .terminal-entry.command").some((row) => row.textContent.includes("?")),
        plots: state.plots.length,
      },
      document_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    });
    return;
  }
  if (scenario === "project-references") {
    const panel = rectEvidence($("#projectReferencesPanel"));
    const content = rectEvidence($("#projectReferencesContent"));
    target.textContent = JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      active_context_tab: document.querySelector("[data-context-tab].active")?.dataset.contextTab || null,
      status: state.projectReferences.status,
      record: state.projectReferences.record ? {
        name: state.projectReferences.record.name,
        matched_count: state.projectReferences.record.matched_count,
        returned_count: state.projectReferences.record.references?.length || 0,
        incomplete: state.projectReferences.record.incomplete,
        truncated: state.projectReferences.record.truncated,
      } : null,
      heading_focused: document.activeElement === $("#projectReferencesHeading"),
      document_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      content_outside_panel: Boolean(panel && content && (content.left < panel.left || content.right > panel.right)),
      rects: { panel, content },
    });
    return;
  }
  if (scenario === "lint-quick-fix") {
    const panel = rectEvidence($("#problemsPanel"));
    const list = rectEvidence($("#problemList"));
    target.textContent = JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      active_dock_tab: document.querySelector("[data-dock-tab].active")?.dataset.dockTab || null,
      lint_status: state.lint.status,
      diagnostics: state.lint.response?.diagnostics?.length || 0,
      groups: groupedProblems().length,
      review_actions: $$("#problemList .problem-actions button").filter((button) => button.textContent === "Review quick fix").length,
      dialog_open: !$("#lintQuickFixDialog").classList.contains("hidden"),
      document_dirty: Boolean(activeDocument() && documentIsDirty(activeDocument())),
      active_path: state.activeDocument,
      document_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      list_outside_panel: Boolean(panel && list && (list.left < panel.left || list.right > panel.right)),
      rects: { panel, list },
    });
    return;
  }
  if (scenario === "agent-help-link") {
    const evidence = rectEvidence($(".agent-help-evidence"));
    target.textContent = JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scenario,
      active_context_tab: document.querySelector("[data-context-tab].active")?.dataset.contextTab || null,
      help_status: state.localHelp.status,
      attachment_visible: !$("#agentHelpContextBadge").classList.contains("hidden"),
      linked_answer: Boolean(evidence),
      model_only_has_evidence: Boolean(evidence) && previewParams.get("state") === "model-only",
      partial: Boolean(localHelpContextFromTurn(state.selectedTurnDetail)?.incomplete
        || localHelpContextFromTurn(state.selectedTurnDetail)?.truncated),
      mismatch_hidden: !evidence && previewParams.get("state") === "mismatch",
      document_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      rects: { evidence },
    });
    return;
  }
  if (["editor-refactor", "editor-format"].includes(scenario)) {
    const surface = rectEvidence($("#refactorReviewDialog .refactor-review-surface"));
    const files = rectEvidence($("#refactorReviewFiles"));
    target.textContent = JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scenario,
      status: state.refactor.status,
      operation: state.refactor.proposal?.operation || null,
      targets: state.refactor.proposal?.targets.length || 0,
      error: state.refactor.error,
      dialog_open: !$("#refactorReviewDialog").classList.contains("hidden"),
      dirty_files: Object.values(state.documents).filter(documentIsDirty).map((document) => document.path),
      apply_visible: !$("#refactorReviewApply").classList.contains("hidden"),
      undo_visible: !$("#refactorReviewUndo").classList.contains("hidden"),
      document_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      files_outside_surface: Boolean(surface && files && (files.left < surface.left || files.right > surface.right)),
      rects: { surface, files },
    });
    return;
  }
  if (scenario === "agent-first-direct") {
    const taskRail = rectEvidence($("#taskRail"));
    const taskRailList = $("#taskRailList");
    const agentFlow = rectEvidence($("#agentPanel"));
    const workSurface = rectEvidence($(".workspace"));
    const composer = rectEvidence($(".agent-composer"));
    const taskRailItems = $$("#taskRailList .task-rail-item").map((item) => {
      const modeIcon = item.querySelector(".task-mode-icon");
      const statusDot = item.querySelector(".status-dot");
      const preview = item.querySelector(".task-rail-preview");
      return {
        conversation_id: item.dataset.conversationId || null,
        turn_id: item.dataset.turnId || null,
        mode: modeIcon?.dataset.mode || null,
        mode_label: modeIcon?.getAttribute("aria-label") || null,
        mode_title: modeIcon?.title || null,
        icon_href: modeIcon?.querySelector("use")?.getAttribute("href") || null,
        icon_hidden: modeIcon?.querySelector("svg")?.getAttribute("aria-hidden") || null,
        status: statusDot?.dataset.status || null,
        status_label: statusDot?.getAttribute("aria-label") || null,
        status_title: statusDot?.title || null,
        active: item.getAttribute("aria-current") === "true",
        item_label: item.getAttribute("aria-label"),
        preview: preview?.textContent || null,
        preview_overflow: Boolean(preview && preview.scrollWidth > preview.clientWidth),
        mode_color: modeIcon ? getComputedStyle(modeIcon).color : null,
        mode_background: modeIcon ? getComputedStyle(modeIcon).backgroundColor : null,
        status_color: statusDot ? getComputedStyle(statusDot).backgroundColor : null,
      };
    });
    target.textContent = JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      posture: state.posture,
      surface: state.agentSurface,
      work_surface: state.agentWorkSurface,
      mode: state.agentMode,
      counts: {
        tasks: state.agentConversations.length,
        conversations: state.agentConversations.length,
        active: activeAgentConversations().length,
        running: activeAgentConversations().filter((conversation) => conversation.status === "running").length,
        waiting: activeAgentConversations().filter((conversation) => conversation.status === "waiting").length,
      },
      selected_conversation_id: state.selectedConversationId,
      composer_disabled: $("#agentInput").disabled,
      new_conversation_disabled: $("#taskRailNew").disabled,
      agent_header: $("#agentState").textContent,
      cancel_visible: !$("#agentCancelButton").classList.contains("hidden"),
      visible: {
        task_rail: Boolean(taskRail && taskRail.width > 0 && taskRail.height > 0),
        editor: Boolean(workSurface && workSurface.width > 0 && workSurface.height > 0),
        execution_dock: getComputedStyle($(".execution-dock")).display !== "none",
        review_workspace: !$("#agentReviewWorkspace").classList.contains("hidden"),
        outputs: !$("#agentOutputsPanel").classList.contains("hidden"),
        reviewed_plot: Boolean($("#agentReviewWorkspaceContent .agent-review-plot-stage img")),
        human_layout_presets: getComputedStyle($(".work-modes")).display !== "none",
        act_authorization: !$(".act-authorization").classList.contains("hidden"),
        approval: !$("#approvalPanel").classList.contains("hidden"),
        file_proposal: !$("#fileEditPanel").classList.contains("hidden"),
      },
      states: {
        turn: $("#agentTimeline .timeline-heading-row .state-chip")?.textContent || null,
        approval: $("#approvalPanel").dataset.state || null,
        file_proposal: $("#fileEditPanel").dataset.state || null,
        output_count: $$("#agentOutputsList .agent-output-card").length,
        output_titles: $$("#agentOutputsList .agent-output-body strong").map((element) => element.textContent),
      },
      widths: {
        task_rail: taskRail?.width || 0,
        agent_flow: agentFlow?.width || 0,
        work_surface: workSurface?.width || 0,
      },
      task_rail: {
        items: taskRailItems,
        list_overflow: Boolean(taskRailList && taskRailList.scrollWidth > taskRailList.clientWidth),
        list_scroll_width: taskRailList?.scrollWidth || 0,
        list_client_width: taskRailList?.clientWidth || 0,
      },
      overlaps: {
        composer_with_work_surface: rectsOverlap(composer, workSurface),
        approval_with_composer: rectsOverlap(rectEvidence($("#approvalPanel")), composer),
        file_proposal_with_composer: rectsOverlap(rectEvidence($("#fileEditPanel")), composer),
      },
      document_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    });
    return;
  }
  if (scenario === "wp3-artifacts") {
    const history = rectEvidence($("#plotHistory"));
    const plotStage = rectEvidence($(".plot-stage"));
    const plotNavigator = rectEvidence($(".plot-navigator"));
    const artifactPanel = rectEvidence($(".artifact-panel"));
    const artifactList = rectEvidence($("#artifactRecordList"));
    const artifactDetail = rectEvidence($("#artifactDetailCard"));
    const evidence = {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      active_dock_tab: document.querySelector("[data-dock-tab].active")?.dataset.dockTab || null,
      counts: {
        plots: state.plots.length,
        artifacts: state.artifacts.length,
      },
      plot_surface: {
        state: $("#plotEmpty").classList.contains("hidden") ? "preview" : $("#plotEmpty").dataset.state,
        title: $("#plotEmpty strong").textContent,
        navigator_titles: $$("#plotHistory .plot-history-content strong").map((element) => element.textContent),
        saved_outputs_open: $("#artifactPanel").open,
      },
      selected_artifact: state.selectedArtifactDetail?.artifact
        ? {
          kind: state.selectedArtifactDetail.artifact.artifact_kind,
          output_path: state.selectedArtifactDetail.artifact.output_path,
          file_available: state.selectedArtifactDetail.file_available,
          provenance_complete: state.selectedArtifactDetail.artifact.provenance_complete,
        }
        : null,
      overlaps: {
        history_with_artifact_panel: rectsOverlap(history, artifactPanel),
        artifact_list_with_detail: rectsOverlap(artifactList, artifactDetail),
      },
      rects: { history, plotStage, plotNavigator, artifactPanel, artifactList, artifactDetail },
    };
    target.textContent = JSON.stringify(evidence);
    return;
  }
  const search = rectEvidence($("#environmentSearch"));
  const preview = rectEvidence($("#objectPreview"));
  const viewer = rectEvidence($("#dataViewer"));
  const actions = rectEvidence($(".data-viewer-actions"));
  const table = rectEvidence($("#dataViewerTable"));
  const evidence = {
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    active_context_tab: document.querySelector("[data-context-tab].active")?.dataset.contextTab || null,
    overlaps: {
      search_with_preview: rectsOverlap(search, preview),
      actions_with_table: rectsOverlap(actions, table),
    },
    refresh_probe: state.dataViewerRefreshPreviewProbe,
    rects: { search, preview, viewer, actions, table },
  };
  target.textContent = JSON.stringify(evidence);
}

function latestEnvironmentOperation() {
  return state.environmentOperations[0] || null;
}

function formatEnvironmentOperationSummary(request) {
  if (!request) return "No environment operation has been requested yet.";
  const reason = request.reason
    ? ` ${userFacingError(request.reason, "Review the current environment and refresh this preview before trying again.")}`
    : "";
  if (request.status === "requested") {
    return request.request_name?.startsWith("environment.package_")
      ? "Preview ready. Review the package, project library, repositories, and partial-write warning before running."
      : "Preview ready. Review the package changes before updating the project environment.";
  }
  if (request.status === "completed") return `${environmentOperationLabel(request.request_name)} finished.${reason}`;
  if (request.status === "approved") return `${environmentOperationLabel(request.request_name)} approved. Starting Workspace R execution.${reason}`;
  if (request.status === "running") return `${environmentOperationLabel(request.request_name)} is running.${reason}`;
  return `${environmentOperationLabel(request.request_name)} ${prettyEnvironmentOperationStatus(request.status).toLowerCase()}.${reason}`;
}

function formatEnvironmentOperationMeta(request) {
  if (!request) return "";
  return displayPath(request.project_root || "");
}

function renderEnvironmentOperationCard() {
  const request = latestEnvironmentOperation();
  const card = $("#environmentOperationCard");
  const buttons = [
    $("#environmentInitButton"),
    $("#environmentRestoreButton"),
    $("#environmentSnapshotButton"),
    $("#environmentManagePackageButton"),
  ];
  const dialogBusy = state.environmentOperationDialog.busy;
  const enabled = !state.busy && !dialogBusy && state.projectStatus === "ready" && Boolean(state.project.root);
  for (const button of buttons) button.disabled = !enabled;
  card.className = "environment-op-card";
  if (!request) {
    card.classList.add("hidden");
    $("#environmentOperationTitle").textContent = "Environment Operation";
    setStateChip($("#environmentOperationState"), "Idle", "neutral");
    $("#environmentOperationSummary").textContent = "No environment operation has been requested yet.";
    $("#environmentOperationMeta").textContent = "";
    $("#environmentOperationReviewButton").disabled = true;
    return;
  }
  card.classList.remove("hidden");
  const tone = environmentOperationTone(request.status);
  if (tone) card.classList.add(tone);
  $("#environmentOperationTitle").textContent = environmentOperationLabel(request.request_name);
  setStateChip($("#environmentOperationState"), prettyEnvironmentOperationStatus(request.status), request.status);
  $("#environmentOperationSummary").textContent = formatEnvironmentOperationSummary(request);
  $("#environmentOperationMeta").textContent = formatEnvironmentOperationMeta(request);
  $("#environmentOperationReviewButton").disabled = dialogBusy;
}

function formatEnvironmentOperationArguments(request) {
  const args = parseEnvironmentOperationPayload(request?.arguments_json, {});
  return [
    `Action: ${environmentOperationLabel(request?.request_name)}`,
    `Project: ${displayPath(request?.project_root || args.project_root) || "unknown"}`,
    args.package ? `Package: ${args.package}` : null,
    args.project_library ? "Package library: Current project library" : null,
    args.bioconductor ? `Bioconductor: ${args.bioconductor}` : null,
    `Repositories: ${(args.repositories && Object.keys(args.repositories).length) ? Object.values(args.repositories).join(", ") : "project defaults"}`,
  ].filter(Boolean).join("\n");
}

function formatEnvironmentOperationPreview(request) {
  const payload = parseEnvironmentOperationPayload(request?.preview_json, {});
  const preview = payload?.preview || {};
  const renv = preview.renv || {};
  const renvStatus = preview.renv_status || {};
  const diff = preview.diff || {};
  if (preview.package) {
    return [
      `Project: ${displayPath(preview.project_dir || request?.project_root) || "unknown"}`,
      `Planned change: ${{ install_package: "Install", update_package: "Update", remove_package: "Remove" }[preview.operation] || "Change"} ${preview.package}`,
      `Installed version: ${preview.installed_version || "not installed"}`,
      `Lockfile version: ${preview.locked_version || "not locked"}`,
      "Package library: Current project library",
      `Warnings: ${(preview.warnings || []).join(" | ") || "none"}`,
    ].join("\n");
  }
  const diffLines = (diff.values || []).map((item) =>
    `${item.name}: lockfile ${item.lockfile_version || "missing"}, installed ${item.library_version || "missing"}`
  );
  return [
    `Project: ${displayPath(preview.project_dir || request?.project_root) || "unknown"}`,
    `Environment status: ${{ active: "Ready", present: "Package versions recorded", absent: "Package versions are not recorded" }[renv.status] || (renvStatus.ok ? "Ready" : "Needs attention")}`,
    `Lockfile and library: ${{ synchronized: "In sync", drifted: "Different", no_lockfile: "No lockfile" }[renv.synchronization] || (renvStatus.synchronized ? "In sync" : "Different")}`,
    `Warnings: ${(renvStatus.warnings || []).join(" | ") || "none"}`,
    `Messages: ${(renvStatus.messages || []).join(" | ") || "none"}`,
    `Changes: ${diffLines.length ? diffLines.join("\n") : "no package differences detected"}`,
  ].join("\n");
}

function renderEnvironmentOperationDialog() {
  const dialog = $("#environmentOperationDialog");
  const request = state.environmentOperations.find((item) => item.request_id === state.environmentOperationDialog.requestId) || null;
  if (!request) {
    dialog.classList.add("hidden");
    return;
  }
  dialog.classList.remove("hidden");
  $("#environmentOperationDialogTitle").textContent = environmentOperationLabel(request.request_name);
  setStateChip($("#environmentOperationDialogState"), prettyEnvironmentOperationStatus(request.status), request.status);
  $("#environmentOperationDialogNote").textContent = state.environmentOperationDialog.busy
    ? (state.environmentOperationDialog.phase || "Workspace R operation is starting. Please wait for the recorded result.")
    : request.request_name?.startsWith("environment.package_")
      ? "Review the package, project library, repositories, and partial-write warning before changing the project environment."
      : "Review the requested package-environment action and changes before continuing.";
  $("#environmentOperationArguments").textContent = formatEnvironmentOperationArguments(request);
  $("#environmentOperationPreview").textContent = formatEnvironmentOperationPreview(request);
  const error = $("#environmentOperationDialogError");
  if (request.reason) {
    const reason = request.status === "stale"
      ? `This request is no longer current. ${request.reason} Refresh the preview before approving again.`
      : userFacingError(request.reason, "This environment change could not be completed. Refresh the preview and try again.");
    error.textContent = reason;
    error.classList.remove("hidden");
  } else {
    error.textContent = "";
    error.classList.add("hidden");
  }
  const pending = request.status === "requested";
  $("#environmentOperationApprove").disabled = !pending || state.environmentOperationDialog.busy;
  $("#environmentOperationReject").disabled = !pending || state.environmentOperationDialog.busy;
  $("#environmentOperationCancel").textContent = pending ? "Cancel" : "Close";
  $("#environmentOperationCancel").disabled = state.environmentOperationDialog.busy;
}

function closeEnvironmentOperationDialog() {
  stopEnvironmentOperationPolling();
  $("#environmentOperationDialog").classList.add("hidden");
  state.environmentOperationDialog.requestId = null;
  state.environmentOperationDialog.phase = "";
  const returnFocus = state.environmentOperationDialog.returnFocus;
  state.environmentOperationDialog.returnFocus = null;
  if (returnFocus?.focus) returnFocus.focus();
}

function openEnvironmentOperationDialog(requestId, trigger = null) {
  state.environmentOperationDialog.requestId = requestId;
  state.environmentOperationDialog.returnFocus = trigger || document.activeElement;
  renderEnvironmentOperationDialog();
}

async function loadEnvironmentOperationData({ quiet = false } = {}) {
  try {
    state.environmentOperations = await invoke("list_environment_operation_requests", { limit: 20 });
    renderEnvironmentOperationCard();
    renderEnvironmentOperationDialog();
    return true;
  } catch (error) {
    if (!quiet) toast(reportUiFailure("load environment operations", error, "Package and environment actions could not be loaded. Refresh Environment and try again."), true);
    return false;
  }
}

function stopEnvironmentOperationPolling() {
  if (state.environmentOperationPollTimer) {
    clearInterval(state.environmentOperationPollTimer);
    state.environmentOperationPollTimer = null;
  }
}

function startEnvironmentOperationPolling(requestId) {
  stopEnvironmentOperationPolling();
  state.environmentOperationPollTimer = setInterval(async () => {
    const loaded = await loadEnvironmentOperationData({ quiet: true });
    if (!loaded) return;
    const current = state.environmentOperations.find((item) => item.request_id === requestId);
    if (current && !["requested", "approved", "running"].includes(current.status)) {
      stopEnvironmentOperationPolling();
      if (state.environmentOperationDialog.requestId === requestId) {
        state.environmentOperationDialog.busy = false;
        state.environmentOperationDialog.phase = "";
        renderEnvironmentOperationCard();
        renderEnvironmentOperationDialog();
      }
    }
  }, 1000);
}

async function beginEnvironmentOperation(operation, options = {}) {
  if (state.busy || state.environmentOperationDialog.busy) return;
  state.environmentOperationDialog.busy = true;
  renderEnvironmentOperationCard();
  renderEnvironmentOperationDialog();
  try {
    const request = await invoke("request_environment_operation_preview", {
      request: {
        operation,
        repositories: options.repositories ?? null,
        bioconductor: options.bioconductor ?? null,
        package: options.package ?? null,
      },
    });
    await loadEnvironmentOperationData();
    openEnvironmentOperationDialog(request.request_id, options.returnFocus || document.activeElement);
    return { ok: true, request };
  } catch (error) {
    const message = reportUiFailure("preview environment operation", error, "Rho could not prepare this environment change. Review the package or project environment and try again.");
    toast(message, true);
    return { ok: false, error: message };
  } finally {
    state.environmentOperationDialog.busy = false;
    renderEnvironmentOperationCard();
    renderEnvironmentOperationDialog();
  }
}

async function respondEnvironmentOperation(decision) {
  const requestId = state.environmentOperationDialog.requestId;
  if (!requestId) return;
  state.environmentOperationDialog.busy = true;
  state.environmentOperationDialog.phase = decision === "approve"
    ? "Approval recorded. Starting Workspace R execution..."
    : decision === "cancel" ? "Cancelling environment operation..." : "Recording rejection...";
  renderEnvironmentOperationCard();
  renderEnvironmentOperationDialog();
  if (decision === "approve") startEnvironmentOperationPolling(requestId);
  let result = null;
  let commandError = null;
  try {
    result = await invoke("respond_environment_operation", {
      request: { request_id: requestId, decision, reason: null },
    });
    if (result?.workspace) updateIdentity(result.workspace);
  } catch (error) {
    commandError = error;
  }

  const reloaded = await loadEnvironmentOperationData({ quiet: true });
  stopEnvironmentOperationPolling();
  const current = state.environmentOperations.find((item) => item.request_id === requestId) || null;
  if (commandError) {
    if (reloaded && current && current.status !== "requested") {
      renderEnvironmentOperationDialog();
      toast(`Environment request is now ${prettyEnvironmentOperationStatus(current.status).toLowerCase()}. Review its status in the dialog.`, true);
    } else {
      toast(reportUiFailure("respond to environment operation", commandError, "The environment decision could not be completed. Refresh Environment before trying again."), true);
    }
  } else {
    const refreshFailures = [];
    try { await loadRunData({ quiet: true }); } catch { refreshFailures.push("run history"); }
    try { if (await refreshEnvironment({ quiet: true }) === false) refreshFailures.push("R environment"); } catch { refreshFailures.push("R environment"); }
    renderEnvironmentOperationDialog();
    if (refreshFailures.length) toast(`Environment request ${result?.status === "stale" ? "became stale" : "was processed"}, but ${refreshFailures.join(" and ")} could not be refreshed.`, true);
    if (decision !== "approve" && current?.status !== "requested") closeEnvironmentOperationDialog();
  }
  state.environmentOperationDialog.busy = false;
  state.environmentOperationDialog.phase = "";
  renderEnvironmentOperationCard();
  renderEnvironmentOperationDialog();
}

function previewSummary(detail) {
  if (!detail) return "Select an object to inspect its preview.";
  const preview = detail.preview || {};
  const lines = [
    `${detail.name} · ${stringValues(detail.classes).join("/") || detail.typeof || "object"}`,
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
    lines.push("For this object type, the preview shows structure only.");
  }
  if (detail.structure) lines.push("", detail.structure);
  return lines.filter((line) => line !== null && line !== undefined).join("\n");
}

function workspaceViewerIdentityChanged(before, after) {
  if (!before || !after) return Boolean(before || after);
  return ["kernel_instance_id", "state_revision", "project_revision"].some((key) =>
    String(before[key] ?? "") !== String(after[key] ?? "")
  );
}

function viewerProjectRequestIsCurrent(projectRoot, projectRefreshSequence) {
  return state.project.root === projectRoot
    && state.projectRefreshSequence === projectRefreshSequence;
}

function captureDataViewerState() {
  const view = selectedDataView();
  return {
    viewKind: view?.kind || state.dataViewer.viewKind || null,
    viewKey: view?.key || state.dataViewer.viewKey || null,
    rowOffset: state.dataViewer.rowOffset,
    rowLimit: state.dataViewer.rowLimit,
    columnOffset: state.dataViewer.columnOffset,
    columnLimit: state.dataViewer.columnLimit,
    query: state.dataViewer.query,
    sortColumn: state.dataViewer.sortColumn,
    sortDirection: state.dataViewer.sortDirection,
  };
}

function boundedViewerOffset(offset, total, limit) {
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeLimit = Math.max(1, Number(limit) || 1);
  if (safeTotal === 0) return 0;
  return Math.min(safeOffset, Math.floor((safeTotal - 1) / safeLimit) * safeLimit);
}

function clearEnvironmentObjectSelection({ preserveName = false, message = null } = {}) {
  state.dataViewer.inspectionRequestId += 1;
  state.dataViewer.pageRequestId += 1;
  clearTimeout(state.dataViewer.queryTimer);
  state.dataViewer.queryTimer = null;
  state.objectInspection = null;
  if (!preserveName) state.selectedObjectName = null;
  state.selectedObjectDetail = null;
  state.selectedDataObjectDetail = null;
  state.selectedDataPage = null;
  state.dataViewer.loadingPage = false;
  state.dataViewer.rowOffset = 0;
  state.dataViewer.columnOffset = 0;
  state.dataViewer.workspace = null;
  state.dataViewer.query = null;
  state.dataViewer.error = message
    ? { message, error_code: "viewer_refresh_failed" }
    : null;
  state.dataViewer.viewKind = null;
  state.dataViewer.viewKey = null;
  state.dataViewer.sortColumn = null;
  state.dataViewer.sortDirection = null;
  if ($("#dataViewerFilter")) $("#dataViewerFilter").value = "";
}

function currentViewerWorkspace() {
  return state.dataViewer.workspace || {
    kernel_instance_id: state.revision.kernel_instance_id ?? null,
    state_revision: state.revision.state_revision ?? null,
    project_revision: state.revision.project_revision ?? null,
  };
}

function selectedDataView(detail = state.selectedDataObjectDetail) {
  if (!detail?.views?.length) return null;
  const selected = state.dataViewer.viewKind && state.dataViewer.viewKey
    ? `${state.dataViewer.viewKind}:${state.dataViewer.viewKey}`
    : $("#dataViewerViewSelect")?.value || "";
  return detail.views.find((view) => `${view.kind}:${view.key}` === selected) || detail.views[0];
}

function dataViewerWindowMeta(page) {
  if (!page) return "No data loaded yet.";
  const rowStart = page.total_rows ? (page.row_offset || 0) + 1 : 0;
  const rowEnd = Math.min(page.total_rows || 0, (page.row_offset || 0) + (page.rows?.length || 0));
  const columnStart = page.total_columns ? (page.column_offset || 0) + 1 : 0;
  const columnEnd = Math.min(page.total_columns || 0, (page.column_offset || 0) + (page.columns?.length || 0));
  return [
    `${stringValues(page.class).join("/") || "object"} · ${page.dimensions?.join(" × ") || "shape unknown"}`,
    `rows ${rowStart}-${rowEnd} of ${page.total_rows || 0}`,
    page.query ? `${page.total_rows || 0} matches from ${page.source_total_rows || 0} rows` : null,
    `cols ${columnStart}-${columnEnd} of ${page.total_columns || 0}`,
    page.truncated ? "Showing part of the data" : null,
  ].filter(Boolean).join(" · ");
}

function packageManagementInputValid(value) {
  return /^[A-Za-z][A-Za-z0-9.]{0,127}$/.test(value);
}

function renderPackageManagementDialog() {
  const busy = state.packageManagementDialog.busy;
  $("#packageManagementOperation").disabled = busy;
  $("#packageManagementName").disabled = busy;
  $("#packageManagementPreview").disabled = busy;
  $("#packageManagementCancel").disabled = busy;
  const projectLibrary = state.environment?.renv?.project_library;
  $("#packageManagementLibrary").textContent = projectLibrary
    ? "This change will use the current project's package library. Preview checks the library and repositories again."
    : "Preview checks the project package library and repositories before continuing.";
}

function openPackageManagementDialog(operation = "install_package", packageName = "", trigger = null) {
  state.packageManagementDialog.returnFocus = trigger || document.activeElement;
  $("#packageManagementOperation").value = operation;
  $("#packageManagementName").value = packageName;
  $("#packageManagementError").textContent = "";
  $("#packageManagementError").classList.add("hidden");
  $("#packageManagementDialog").classList.remove("hidden");
  renderPackageManagementDialog();
  $("#packageManagementName").focus();
}

function closePackageManagementDialog({ restoreFocus = true } = {}) {
  $("#packageManagementDialog").classList.add("hidden");
  const returnFocus = state.packageManagementDialog.returnFocus;
  state.packageManagementDialog.returnFocus = null;
  if (restoreFocus && returnFocus?.focus) returnFocus.focus();
}

async function submitPackageManagement(event) {
  event.preventDefault();
  if (state.packageManagementDialog.busy) return;
  const operation = $("#packageManagementOperation").value;
  const packageName = $("#packageManagementName").value.trim();
  const error = $("#packageManagementError");
  if (!packageManagementInputValid(packageName)) {
    error.textContent = "Enter one valid R package name.";
    error.classList.remove("hidden");
    $("#packageManagementName").focus();
    return;
  }
  state.packageManagementDialog.busy = true;
  error.classList.add("hidden");
  renderPackageManagementDialog();
  const returnFocus = state.packageManagementDialog.returnFocus;
  const result = await beginEnvironmentOperation(operation, { package: packageName, returnFocus });
  state.packageManagementDialog.busy = false;
  renderPackageManagementDialog();
  if (result.ok) {
    closePackageManagementDialog({ restoreFocus: false });
  } else {
    error.textContent = userFacingError(result.error, "The package change could not be prepared. Review the package name and try again.");
    error.classList.remove("hidden");
  }
}

function dataViewerCellPresentation(value, state) {
  if (state === "na") return { text: "NA", className: "missing", label: "Missing value NA" };
  if (state === "nan") return { text: "NaN", className: "non-finite", label: "Not a number" };
  if (state === "pos_inf") return { text: "Inf", className: "non-finite", label: "Positive infinity" };
  if (state === "neg_inf") return { text: "-Inf", className: "non-finite", label: "Negative infinity" };
  if (state === "empty") return { text: '""', className: "empty-value", label: "Empty string" };
  return { text: value === null || value === undefined ? "NA" : String(value), className: "", label: null };
}

function renderDataViewer() {
  const viewer = $("#dataViewer");
  const table = $("#dataViewerTable");
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  const detail = state.selectedDataObjectDetail;
  const page = state.selectedDataPage;
  const supported = Boolean(detail?.ok && detail?.views?.length);

  viewer.classList.toggle("hidden", !supported);
  $("#objectPreviewBody").classList.toggle("hidden", supported);

  if (!supported) {
    $("#dataViewerStatus").textContent = detail?.message
      ? userFacingError(detail.message, "This object cannot be shown as a table.")
      : "Select a table-like object to preview its data.";
    $("#dataViewerMeta").textContent = "";
    $("#dataViewerViewSelect").replaceChildren();
    thead.replaceChildren();
    tbody.replaceChildren();
    $("#dataViewerExportButton").disabled = true;
    return;
  }

  const selectedView = selectedDataView(detail);
  const selector = $("#dataViewerViewSelect");
  selector.replaceChildren();
  for (const view of detail.views) {
    const option = document.createElement("option");
    option.value = `${view.kind}:${view.key}`;
    option.textContent = `${view.label || view.key} · ${view.rows} × ${view.columns}`;
    option.selected = Boolean(selectedView && view.kind === selectedView.kind && view.key === selectedView.key);
    selector.append(option);
  }
  if (selectedView) {
    state.dataViewer.viewKind = selectedView.kind;
    state.dataViewer.viewKey = selectedView.key;
    selector.value = `${selectedView.kind}:${selectedView.key}`;
  }

  $("#dataViewerStatus").textContent = state.dataViewer.error?.message
    ? userFacingError(state.dataViewer.error.message, "The source changed; refresh this object before continuing.")
    : (state.dataViewer.loadingPage
      ? "Searching Workspace R..."
      : page
        ? (page.total_rows === 0
          ? "No rows match this search."
          : (page.truncated ? "Showing part of the data." : "Showing data from the current R session."))
        : "Choose a view to load its first page.");
  $("#dataViewerStatus").classList.toggle("error", Boolean(state.dataViewer.error));
  $("#dataViewerMeta").textContent = dataViewerWindowMeta(page);
  $("#dataViewerExportButton").disabled = !page || state.dataViewer.loadingPage;

  const rowPrevDisabled = state.dataViewer.loadingPage || !page || (page.row_offset || 0) <= 0;
  const rowNextDisabled = state.dataViewer.loadingPage || !page || ((page.row_offset || 0) + (page.rows?.length || 0) >= (page.total_rows || 0));
  const columnPrevDisabled = state.dataViewer.loadingPage || !page || (page.column_offset || 0) <= 0;
  const columnNextDisabled = state.dataViewer.loadingPage || !page || ((page.column_offset || 0) + (page.columns?.length || 0) >= (page.total_columns || 0));
  $("#dataViewerRowPrev").disabled = rowPrevDisabled;
  $("#dataViewerRowNext").disabled = rowNextDisabled;
  $("#dataViewerColumnPrev").disabled = columnPrevDisabled;
  $("#dataViewerColumnNext").disabled = columnNextDisabled;
  selector.disabled = state.dataViewer.loadingPage;
  $("#dataViewerFilter").disabled = state.dataViewer.loadingPage;

  thead.replaceChildren();
  tbody.replaceChildren();
  if (!page) return;

  const headerRow = document.createElement("tr");
  const rowHeader = document.createElement("th");
  rowHeader.textContent = "#";
  rowHeader.tabIndex = 0;
  headerRow.append(rowHeader);
  for (const column of page.columns || []) {
    const cell = document.createElement("th");
    cell.tabIndex = 0;
    const sorted = state.dataViewer.sortColumn === column.index;
    const label = document.createElement("span");
    label.className = "data-viewer-column-name";
    label.textContent = `${column.label || column.name || ""}${sorted ? (state.dataViewer.sortDirection === "asc" ? " ▲" : " ▼") : ""}`;
    const type = document.createElement("span");
    type.className = "data-viewer-column-type";
    type.textContent = column.type || "value";
    cell.append(label, type);
    cell.setAttribute("aria-sort", sorted ? (state.dataViewer.sortDirection === "asc" ? "ascending" : "descending") : "none");
    cell.style.cursor = "pointer";
    const classes = (column.classes || []).join("/") || column.type || "value";
    const missing = Number(column.page_missing_count || 0);
    cell.title = `${classes} · ${missing.toLocaleString()} missing on page · Click to sort`;
    cell.addEventListener("click", () => {
      if (state.dataViewer.sortColumn === column.index) {
        if (state.dataViewer.sortDirection === "asc") {
          state.dataViewer.sortDirection = "desc";
        } else if (state.dataViewer.sortDirection === "desc") {
          state.dataViewer.sortColumn = null;
          state.dataViewer.sortDirection = null;
        }
      } else {
        state.dataViewer.sortColumn = column.index;
        state.dataViewer.sortDirection = "asc";
      }
      state.dataViewer.rowOffset = 0;
      loadDataViewPage({ rowOffset: 0 });
    });
    headerRow.append(cell);
  }
  thead.append(headerRow);

  for (const row of page.rows || []) {
    const tr = document.createElement("tr");
    const label = document.createElement("th");
    label.scope = "row";
    label.tabIndex = 0;
    label.textContent = row.row_name || "";
    tr.append(label);
    (row.cells || []).forEach((cellValue, columnIndex) => {
      const cell = document.createElement("td");
      cell.tabIndex = 0;
      const column = page.columns?.[columnIndex] || {};
      const fallbackState = cellValue === null || cellValue === undefined ? "na" : cellValue === "" ? "empty" : "value";
      const cellState = row.cell_states?.[columnIndex] || fallbackState;
      const presentation = dataViewerCellPresentation(cellValue, cellState);
      cell.textContent = presentation.text;
      cell.dataset.cellState = cellState;
      if (presentation.className) cell.classList.add(presentation.className);
      if (["integer", "double", "complex"].includes(column.type)) cell.classList.add("numeric-value");
      if (column.type === "logical") cell.classList.add("logical-value");
      if (presentation.label) cell.setAttribute("aria-label", presentation.label);
      tr.append(cell);
    });
    tbody.append(tr);
  }
}

function dataViewerDelimitedText(page, delimiter = ",") {
  if (!page) return "";
  const quote = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    if (!text.includes("\"") && !text.includes("\n") && !text.includes("\r") && !text.includes(delimiter)) return text;
    return `"${text.replaceAll("\"", "\"\"")}"`;
  };
  const lines = [];
  lines.push([quote("row_name"), ...(page.columns || []).map((column) => quote(column.label || column.name || ""))].join(delimiter));
  for (const row of page.rows || []) {
    lines.push([quote(row.row_name || ""), ...(row.cells || []).map((cell) => quote(cell))].join(delimiter));
  }
  return `${lines.join("\r\n")}\r\n`;
}

async function exportVisibleDataView() {
  const page = state.selectedDataPage;
  if (!page) {
    toast("Load one bounded page before exporting.", true);
    return;
  }
  const view = selectedDataView();
  const defaultPath = defaultDataViewExportPath(page, view);
  const path = await promptForPath({
    title: "Export table page",
    message: "Export the current bounded page to a project-relative .csv or .tsv path.",
    defaultValue: defaultPath,
    validate: (v) => v.endsWith(".csv") || v.endsWith(".tsv"),
    formatHint: "report.csv",
  });
  if (!path) return;
  const normalized = String(path).trim().replace(/\\/g, "/");
  if (!normalized) return;
  const format = normalized.toLowerCase().endsWith(".tsv")
    ? "tsv"
    : normalized.toLowerCase().endsWith(".csv")
      ? "csv"
      : null;
  if (!format) {
    toast("Export path must end with .csv or .tsv.", true);
    return;
  }
  try {
    const safePath = validateProjectRelativePath(normalized);
    const detail = await invoke("export_data_view_artifact", {
      request: {
        path: safePath,
        format,
        object_name: page.object_name,
        view_token: page.view_token,
        view_kind: page.view_kind,
        view_key: page.view_key,
        row_offset: page.row_offset,
        row_limit: page.row_limit,
        column_offset: page.column_offset,
        column_limit: page.column_limit,
        query: page.query,
        sort_column: page.sort_column,
        sort_direction: page.sort_direction,
        workspace: currentViewerWorkspace(),
      },
    });
    state.selectedArtifactId = detail?.artifact?.artifact_id || null;
    state.selectedArtifactDetail = detail || null;
    await refreshProject();
    await loadRunData();
    switchDockTab("plots");
    toast(`Exported the visible page to ${safePath}.`);
  } catch (error) {
    toast(reportUiFailure("export visible data page", error, "The visible data page could not be exported. Review the output path and try again."), true);
  }
}

async function exportActivePlot() {
  const plot = activePlotRecord();
  if (!plot) {
    toast("Run code that produces a plot before exporting.", true);
    return;
  }
  const path = await promptForPath({
    title: "Export plot as PNG",
    message: "Export the selected plot to a project-relative .png path.",
    defaultValue: defaultPlotExportPath(plot),
    validate: (v) => v.endsWith(".png"),
    formatHint: "plot.png",
  });
  if (!path) return;
  try {
    const normalized = validateProjectRelativePath(path);
    if (!normalized.toLowerCase().endsWith(".png")) {
      toast("Plot export path must end with .png.", true);
      return;
    }
    const detail = await invoke("export_plot_artifact", {
      request: { plot_id: plot.plot_id, path: normalized },
    });
    state.selectedArtifactId = detail?.artifact?.artifact_id || null;
    state.selectedArtifactDetail = detail || null;
    await refreshProject();
    await loadRunData();
    switchDockTab("plots");
    toast(`Exported the selected plot to ${normalized}.`);
  } catch (error) {
    toast(reportUiFailure("export plot", error, "The plot could not be exported. Review the output path and try again."), true);
  }
}

async function clearArtifacts(sessionOnly) {
  const scope = sessionOnly ? "this session" : "this project";
  if (!await confirmAction({
    title: "Delete output records",
    message: `Delete output records from ${scope}? Output files are not deleted.`,
    confirmLabel: "Delete records",
    destructive: true,
  })) return;
  try {
    await invoke("clear_artifact_records", { session_only: sessionOnly });
    state.selectedArtifactId = null;
    state.selectedArtifactDetail = null;
    await loadRunData();
    toast(`Deleted output records from ${scope}. Output files were left in place.`);
  } catch (error) {
    toast(reportUiFailure("delete output records", error, "The output records could not be deleted. Refresh Outputs and try again."), true);
  }
}

async function loadDataViewPage(options = {}) {
  const projectRoot = options.expectedProjectRoot ?? state.project.root;
  const projectRefreshSequence = options.expectedProjectRefreshSequence
    ?? state.projectRefreshSequence;
  const inspectionRequestId = options.expectedInspectionRequestId
    ?? state.dataViewer.inspectionRequestId;
  if (!viewerProjectRequestIsCurrent(projectRoot, projectRefreshSequence)
      || inspectionRequestId !== state.dataViewer.inspectionRequestId) return null;

  const detail = state.selectedDataObjectDetail;
  const view = options.view || selectedDataView(detail);
  if (!detail?.ok || !view) {
    state.selectedDataPage = null;
    renderEnvironment();
    return null;
  }
  state.dataViewer.viewKind = view.kind;
  state.dataViewer.viewKey = view.key;
  const pageRequestId = ++state.dataViewer.pageRequestId;
  const requestIsCurrent = () => pageRequestId === state.dataViewer.pageRequestId
    && inspectionRequestId === state.dataViewer.inspectionRequestId
    && viewerProjectRequestIsCurrent(projectRoot, projectRefreshSequence)
    && state.selectedObjectName === detail.name;
  state.dataViewer.loadingPage = true;
  state.dataViewer.error = null;
  if (typeof options.rowOffset === "number") state.dataViewer.rowOffset = Math.max(0, options.rowOffset);
  if (typeof options.columnOffset === "number") state.dataViewer.columnOffset = Math.max(0, options.columnOffset);
  const requestedRowOffset = state.dataViewer.rowOffset;
  const requestedColumnOffset = state.dataViewer.columnOffset;
  renderDataViewer();
  try {
    const response = await invoke("read_data_view", {
      request: {
        object_name: detail.name,
        view_token: detail.view_token,
        view_kind: view.kind,
        view_key: view.key,
        row_offset: requestedRowOffset,
        row_limit: state.dataViewer.rowLimit,
        column_offset: requestedColumnOffset,
        column_limit: state.dataViewer.columnLimit,
        query: state.dataViewer.query,
        sort_column: state.dataViewer.sortColumn,
        sort_direction: state.dataViewer.sortDirection,
        workspace: currentViewerWorkspace(),
      },
    });
    if (pageRequestId !== state.dataViewer.pageRequestId) return null;
    if (!requestIsCurrent()) return null;
    updateIdentity(response.workspace);
    state.dataViewer.workspace = { ...response.workspace };
    if (response.execution && !response.execution.ok) {
      const errorCode = response.execution.error_code || "viewer_read_failed";
      if (options.recoverIncompatibleSort === true
          && state.dataViewer.sortColumn !== null
          && ["invalid_sort", "unsupported_sort_column"].includes(errorCode)) {
        state.dataViewer.sortColumn = null;
        state.dataViewer.sortDirection = null;
        state.dataViewer.rowOffset = 0;
        return loadDataViewPage({
          ...options,
          view,
          rowOffset: 0,
          columnOffset: requestedColumnOffset,
          recoverIncompatibleSort: false,
          expectedProjectRoot: projectRoot,
          expectedProjectRefreshSequence: projectRefreshSequence,
          expectedInspectionRequestId: inspectionRequestId,
        });
      }
      state.selectedDataPage = null;
      state.dataViewer.error = {
        message: response.execution.message,
        error_code: errorCode,
      };
      renderEnvironment();
      return null;
    }

    const page = response.execution?.page || null;
    if (page) {
      const clampedRowOffset = boundedViewerOffset(
        requestedRowOffset,
        page.total_rows,
        state.dataViewer.rowLimit,
      );
      const clampedColumnOffset = boundedViewerOffset(
        requestedColumnOffset,
        page.total_columns,
        state.dataViewer.columnLimit,
      );
      if ((clampedRowOffset !== requestedRowOffset
          || clampedColumnOffset !== requestedColumnOffset)
          && options.recoverWindow !== false) {
        return loadDataViewPage({
          ...options,
          view,
          rowOffset: clampedRowOffset,
          columnOffset: clampedColumnOffset,
          recoverWindow: false,
          expectedProjectRoot: projectRoot,
          expectedProjectRefreshSequence: projectRefreshSequence,
          expectedInspectionRequestId: inspectionRequestId,
        });
      }
    }

    state.selectedDataPage = page;
    if (page) {
      state.dataViewer.rowOffset = page.row_offset ?? requestedRowOffset;
      state.dataViewer.columnOffset = page.column_offset ?? requestedColumnOffset;
      state.dataViewer.query = page.query ?? null;
      state.dataViewer.sortColumn = page.sort_column ?? null;
      state.dataViewer.sortDirection = page.sort_direction ?? null;
      $("#dataViewerFilter").value = state.dataViewer.query || "";
    }
    renderEnvironment();
    return state.selectedDataPage;
  } catch (error) {
    if (pageRequestId !== state.dataViewer.pageRequestId) return null;
    if (!requestIsCurrent()) return null;
    state.selectedDataPage = null;
    state.dataViewer.error = { message: String(error), error_code: "stale_view_revision" };
    renderEnvironment();
    return null;
  } finally {
    if (requestIsCurrent()) {
      state.dataViewer.loadingPage = false;
      renderDataViewer();
    }
  }
}

async function inspectEnvironmentObject(name, options = {}) {
  const force = Boolean(options.force);
  const preserveViewerState = Boolean(options.preserveViewerState);
  const projectRoot = options.expectedProjectRoot ?? state.project.root;
  const projectRefreshSequence = options.expectedProjectRefreshSequence
    ?? state.projectRefreshSequence;
  if (!viewerProjectRequestIsCurrent(projectRoot, projectRefreshSequence)) return null;

  const preserved = preserveViewerState ? captureDataViewerState() : null;
  state.selectedObjectName = name;
  if (!force && (state.selectedObjectDetail?.name === name
      || state.selectedDataObjectDetail?.name === name)) {
    renderEnvironment();
    return state.selectedDataObjectDetail || state.selectedObjectDetail;
  }
  if (!force && state.objectInspection?.name === name) return state.objectInspection.promise;

  const inspectionRequestId = ++state.dataViewer.inspectionRequestId;
  const requestIsCurrent = () => inspectionRequestId === state.dataViewer.inspectionRequestId
    && viewerProjectRequestIsCurrent(projectRoot, projectRefreshSequence)
    && state.selectedObjectName === name;
  state.selectedObjectDetail = null;
  state.selectedDataObjectDetail = null;
  state.selectedDataPage = null;
  state.dataViewer.pageRequestId += 1;
  clearTimeout(state.dataViewer.queryTimer);
  state.dataViewer.queryTimer = null;
  state.dataViewer.loadingPage = false;
  state.dataViewer.workspace = null;
  state.dataViewer.error = null;
  state.dataViewer.rowOffset = preserved?.rowOffset ?? 0;
  state.dataViewer.rowLimit = preserved?.rowLimit ?? state.dataViewer.rowLimit;
  state.dataViewer.columnOffset = preserved?.columnOffset ?? 0;
  state.dataViewer.columnLimit = preserved?.columnLimit ?? state.dataViewer.columnLimit;
  state.dataViewer.query = preserved?.query ?? null;
  state.dataViewer.viewKind = preserved?.viewKind ?? null;
  state.dataViewer.viewKey = preserved?.viewKey ?? null;
  state.dataViewer.sortColumn = preserved?.sortColumn ?? null;
  state.dataViewer.sortDirection = preserved?.sortDirection ?? null;
  $("#dataViewerFilter").value = state.dataViewer.query || "";
  renderEnvironment();

  const promise = (async () => {
    let dataResponse = null;
    let dataError = null;
    try {
      dataResponse = await invoke("inspect_data_object", { request: { object_name: name } });
    } catch (error) {
      dataError = error;
    }
    if (!requestIsCurrent()) return null;

    if (dataResponse) {
      updateIdentity(dataResponse.workspace);
      state.dataViewer.workspace = { ...dataResponse.workspace };
      state.selectedDataObjectDetail = dataResponse.execution || null;
      if (dataResponse.execution?.ok && dataResponse.execution?.views?.length) {
        state.selectedObjectDetail = null;
        const view = dataResponse.execution.views.find((candidate) =>
          candidate.kind === preserved?.viewKind && candidate.key === preserved?.viewKey
        ) || dataResponse.execution.views[0];
        state.dataViewer.viewKind = view.kind;
        state.dataViewer.viewKey = view.key;
        state.dataViewer.rowOffset = boundedViewerOffset(
          state.dataViewer.rowOffset,
          view.rows,
          state.dataViewer.rowLimit,
        );
        state.dataViewer.columnOffset = boundedViewerOffset(
          state.dataViewer.columnOffset,
          view.columns,
          state.dataViewer.columnLimit,
        );
        if (state.dataViewer.sortColumn !== null
            && state.dataViewer.sortColumn >= Number(view.columns || 0)) {
          state.dataViewer.sortColumn = null;
          state.dataViewer.sortDirection = null;
          state.dataViewer.rowOffset = 0;
        }
        renderEnvironment();
        await loadDataViewPage({
          view,
          rowOffset: state.dataViewer.rowOffset,
          columnOffset: state.dataViewer.columnOffset,
          expectedProjectRoot: projectRoot,
          expectedProjectRefreshSequence: projectRefreshSequence,
          expectedInspectionRequestId: inspectionRequestId,
          recoverIncompatibleSort: preserveViewerState,
        });
        return requestIsCurrent() ? state.selectedDataObjectDetail : null;
      }
    }

    try {
      const fallback = await invoke("inspect_object", { request: { name } });
      if (!requestIsCurrent()) return null;
      updateIdentity(fallback.workspace);
      state.dataViewer.workspace = { ...fallback.workspace };
      state.selectedObjectDetail = fallback.execution || null;
      if (dataError) {
        state.selectedDataObjectDetail = {
          ok: false,
          message: String(dataError),
          error_code: "viewer_unavailable",
          name,
        };
      }
      renderEnvironment();
      return state.selectedObjectDetail;
    } catch (error) {
      if (!requestIsCurrent()) return null;
      toast(reportUiFailure("inspect R object", error, "This object could not be inspected. Refresh Environment and try again."), true);
      state.selectedObjectDetail = null;
      state.selectedDataObjectDetail = {
        ok: false,
        message: String(dataError || error),
        error_code: "viewer_unavailable",
        name,
      };
      renderEnvironment();
      return null;
    }
  })().finally(() => {
    if (state.objectInspection?.requestId === inspectionRequestId) state.objectInspection = null;
  });
  state.objectInspection = { name, requestId: inspectionRequestId, promise };
  return promise;
}

function projectPathForSource(sourcePath) {
  if (!sourcePath || !state.project.root) return null;
  const normalize = (value) => String(value).replace(/\\/g, "/").replace(/\/+$/, "");
  const root = normalize(state.project.root);
  const source = normalize(sourcePath);
  const prefix = `${root}/`;
  if (!source.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const relative = source.slice(prefix.length);
  return state.project.files.find((file) => file.path.toLowerCase() === relative.toLowerCase())?.path || null;
}

function documentOffsetAtLine(documentState, line, column = 1) {
  const lines = documentState.content.split("\n");
  const targetLine = Math.max(1, Math.min(Number(line) || 1, lines.length));
  const prefix = lines.slice(0, targetLine - 1).reduce((length, value) => length + value.length + 1, 0);
  return prefix + Math.max(0, Math.min((Number(column) || 1) - 1, lines[targetLine - 1].length));
}

function openFunctionSourceViewer(detail) {
  const source = detail.function_source;
  const path = `@function/${encodeURIComponent(detail.name)}.R`;
  const location = source.path
    ? `# Defined in ${source.path}${source.line ? `:${source.line}` : ""}\n\n`
    : "";
  const content = `${location}${source.definition || `${detail.name} <- <source unavailable>`}`;
  state.documents[path] = {
    path,
    displayName: `${detail.name} (Function)`,
    content,
    savedContent: content,
    language: "r",
    versionId: 0,
    lastExecutedRange: null,
    cursorStart: 0,
    cursorEnd: 0,
    conflictDiskContent: null,
    readOnly: true,
    transient: true,
  };
  state.activeDocument = path;
  renderActiveDocument();
  requestAnimationFrame(() => layoutEditor());
}

async function openEnvironmentObject(name) {
  const detail = await inspectEnvironmentObject(name);
  if (!detail?.function_source) return;
  const projectPath = projectPathForSource(detail.function_source.path);
  if (projectPath) {
    await openDocument(projectPath);
    const documentState = activeDocument();
    if (documentState && detail.function_source.line) {
      const offset = documentOffsetAtLine(
        documentState,
        detail.function_source.line,
        detail.function_source.column,
      );
      documentState.cursorStart = offset;
      documentState.cursorEnd = offset;
      applyDocumentSelection(documentState);
    }
    return;
  }
  openFunctionSourceViewer(detail);
}

function renderEnvironment() {
  renderEnvironmentSummary();
  const query = ($("#variablesSearch")?.value || $("#environmentSearch").value).trim().toLowerCase();
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
    const classes = stringValues(object.classes);
    symbol.textContent = (classes[0] || object.typeof || "R").slice(0, 1).toUpperCase();
    const label = document.createElement("span");
    label.textContent = object.name;
    name.append(symbol, label);
    const type = document.createElement("span");
    type.className = "object-type";
    type.textContent = object.dimensions?.length ? object.dimensions.join(" × ") : classes[0] || object.typeof;
    const size = document.createElement("span");
    size.className = "object-size";
    size.textContent = formatBytes(object.size_bytes || 0);
    row.append(name, type, size);
    row.addEventListener("click", () => {
      inspectEnvironmentObject(object.name);
    });
    row.addEventListener("dblclick", () => {
      openEnvironmentObject(object.name);
    });
    $("#environmentList").append(row);
  }
  $("#objectCount").textContent = String(state.objects.length);
  $("#objectCountLabel").textContent = `${state.objects.length} object${state.objects.length === 1 ? "" : "s"}`;
  const selectedName = state.selectedDataObjectDetail?.name || state.selectedObjectDetail?.name || "Object Preview";
  $("#objectPreviewTitle").textContent = selectedName;
  $("#objectPreviewMeta").textContent = state.selectedDataObjectDetail?.display_kind
    || state.selectedObjectDetail?.preview_kind
    || "Preview";
  $("#objectPreviewBody").textContent = state.selectedObjectDetail
    ? previewSummary(state.selectedObjectDetail)
    : (state.selectedDataObjectDetail?.message || "Select an object to inspect its preview.");
  renderDataViewer();
}

let _renderPollTimer = null;
let _activeRenderJobId = null;
let _renderPollBusy = false;

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

  stopRenderPoll();

  const statusEl = $("#renderJobStatus");
  const cancelBtn = $("#renderCancelButton");
  const renderBtn = $("#renderDocumentButton");
  renderBtn.disabled = true;
  cancelBtn.disabled = false;
  cancelBtn.classList.remove("hidden");
  statusEl.classList.remove("hidden");
  statusEl.textContent = "Rendering\u2026";
  statusEl.style.background = "var(--accent-pale)";
  statusEl.style.color = "var(--accent-strong)";

  try {
    const { job_id } = await invoke("render_document_job", {
      path,
      document_version: documentState?.versionId ?? null,
    });
    _activeRenderJobId = job_id;
    startRenderPoll(job_id, path);
  } catch (error) {
    statusEl.classList.add("hidden");
    cancelBtn.classList.add("hidden");
    renderBtn.disabled = false;
    const friendlyError = reportUiFailure("render document", error, "The document render could not be started. Review Problems and try again.");
    updateLastRender({
      ok: false,
      tool: null,
      sourcePath: path,
      outputPath: null,
      phase: "transport",
      message: friendlyError,
    });
    addProblem(friendlyError, "", {
      sourcePath: path,
      executionMode: "render",
    });
    toast(friendlyError, true);
    renderEnvironmentSummary();
  }
}

function startRenderPoll(jobId, path) {
  const statusEl = $("#renderJobStatus");
  const cancelBtn = $("#renderCancelButton");
  const renderBtn = $("#renderDocumentButton");

  const poll = async () => {
    if (_renderPollBusy || _activeRenderJobId !== jobId) return;
    _renderPollBusy = true;
    try {
      let job = await invoke("render_job_status", { job_id: jobId });
      if (["submitted", "running"].includes(job.status)) {
        const artifact = await findCompletedRenderArtifact(job);
        if (artifact) {
          job = {
            ...job,
            status: "completed",
            artifact_id: artifact.artifact?.artifact_id || job.artifact_id,
            output_path: artifact.artifact?.output_path || job.output_path,
            media_type: artifact.artifact?.media_type || job.media_type,
            provenance_complete: artifact.artifact?.provenance_complete ?? job.provenance_complete,
          };
        }
      }
      if (job.status === "completed") {
        stopRenderPoll();
        statusEl.textContent = "Done";
        statusEl.style.background = "#d4edda";
        statusEl.style.color = "#155724";
        renderBtn.disabled = false;
        cancelBtn.classList.add("hidden");
        await Promise.all([loadRunData(), refreshEnvironment()]);
        let artifactDetail = null;
        if (job.artifact_id) {
          try {
            artifactDetail = await invoke("get_artifact_record", { artifactId: job.artifact_id });
          } catch (error) {
          addLog("SYSTEM", `Saved render-output details are unavailable: ${error}`);
          }
        }
        if (artifactDetail?.artifact) {
          state.selectedArtifactId = artifactDetail.artifact.artifact_id;
          state.selectedArtifactDetail = artifactDetail;
        }
        updateLastRender({
          ok: true,
          tool: job.tool || null,
          sourcePath: path,
          outputPath: artifactDetail?.artifact?.output_path || job.output_path || null,
          runId: job.job_id,
          artifactId: job.artifact_id || null,
          artifactAvailable: Boolean(artifactDetail?.artifact),
          provenanceComplete: Boolean(artifactDetail?.artifact?.provenance_complete),
          fileAvailable: artifactDetail?.file_available ?? null,
          mediaType: artifactDetail?.artifact?.media_type || job.media_type || null,
        });
        toast(artifactDetail?.artifact ? "Render completed · saved output ready" : "Render completed");
        renderEnvironmentSummary();
        setTimeout(() => statusEl.classList.add("hidden"), 3000);
        return;
      }
      if (job.status === "failed") {
        stopRenderPoll();
        statusEl.textContent = "Failed";
        statusEl.style.background = "#f8d7da";
        statusEl.style.color = "#721c24";
        renderBtn.disabled = false;
        cancelBtn.classList.add("hidden");
        const msg = job.message || "Render failed";
        updateLastRender({
          ok: false,
          tool: null,
          sourcePath: path,
          outputPath: null,
          phase: "render",
          message: msg,
        });
        addProblem(msg, "", {
          sourcePath: path,
          executionMode: "render",
        });
        toast(msg, true);
        renderEnvironmentSummary();
        setTimeout(() => statusEl.classList.add("hidden"), 5000);
        return;
      }
      if (job.status === "interrupted") {
        stopRenderPoll();
        statusEl.textContent = "Cancelled";
        statusEl.style.background = "#f1f3f3";
        statusEl.style.color = "var(--muted)";
        renderBtn.disabled = false;
        cancelBtn.classList.add("hidden");
        const message = job.message || "Render cancelled.";
        updateLastRender({
          ok: false,
          tool: null,
          sourcePath: path,
          outputPath: null,
          phase: "interrupted",
          message,
        });
        toast(message);
        await Promise.all([loadRunData(), refreshEnvironment()]);
        renderEnvironmentSummary();
        setTimeout(() => statusEl.classList.add("hidden"), 4000);
        return;
      }
      const cancelling = job.status === "cancel_requested";
      statusEl.textContent = cancelling ? "Cancelling\u2026" : "Rendering\u2026";
      cancelBtn.disabled = cancelling;
    } catch (err) {
      stopRenderPoll();
      statusEl.classList.add("hidden");
      renderBtn.disabled = false;
      cancelBtn.classList.add("hidden");
      const message = `Render status is unavailable: ${err}`;
      updateLastRender({
        ok: false,
        tool: null,
        sourcePath: path,
        outputPath: null,
        phase: "status",
        message,
      });
      toast(message, true);
      renderEnvironmentSummary();
    } finally {
      _renderPollBusy = false;
    }
  };
  void poll();
  _renderPollTimer = setInterval(poll, 2000);
}

async function findCompletedRenderArtifact(job) {
  if (!job?.job_id || !isDesktop) return null;
  try {
    const detail = await invoke("get_artifact_record", {
      artifactId: `artifact_${job.job_id}_render`,
    });
    if (!detail?.artifact || detail.artifact.run_id !== job.job_id) return null;
    if (detail.run && detail.run.status !== "completed") return null;
    return detail;
  } catch {
    return null;
  }
}

function stopRenderPoll() {
  if (_renderPollTimer) {
    clearInterval(_renderPollTimer);
    _renderPollTimer = null;
  }
  _activeRenderJobId = null;
  _renderPollBusy = false;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function buildAgentEditorContext(options = {}) {
  const {
    diagnostic = state.agentDiagnostic,
    runContext = state.agentProblemRunContext,
  } = options;
  syncDocumentFromEditor({ render: false, persist: false });
  const documentState = diagnostic?.source_path === "<console>" ? null : activeDocument();
  const files = state.project.files.map((file) => file.path).slice(0, 500);
  if (!documentState) {
    return {
      project_root: state.project.root,
      files,
      active_path: null,
      context_source: state.agentContextSource,
      context_path: state.agentContextPath,
      local_help: state.agentLocalHelpContext,
      diagnostic,
      run_context: runContext,
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
    local_help: state.agentLocalHelpContext,
    diagnostic,
    run_context: runContext,
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

function localHelpContextFromTurn(detail) {
  const event = detail?.events?.find((item) => item.event_type === "agent.user_prompt");
  const context = parseJsonObject(event?.details_json)?.editor_context?.local_help;
  if (!context || context.kind !== "rho.local_help_context.v1"
    || !context.project_root || context.project_root !== state.project.root
    || !context.name || !context.package || !context.help_topic || !context.help_record
    || String(context.name).length > 128 || String(context.package).length > 128
    || String(context.help_topic).length > 128 || String(context.help_record).length > 1000) return null;
  return context;
}

async function openAgentLocalHelpContext(context) {
  if (!context) return;
  try {
    await showLocalHelp(context.name, context.package);
    toast(`Opened ${context.package}::${context.help_topic} Local Help.`);
  } catch (error) {
    toast(reportUiFailure("open Agent Local Help", error, "Local Help could not be opened. Refresh Help and try again."), true);
  }
}

function appendAgentLocalHelpEvidence(container, detail) {
  const context = localHelpContextFromTurn(detail);
  if (!context) return;
  const block = document.createElement("aside");
  block.className = "agent-help-evidence";
  const header = document.createElement("div");
  header.className = "agent-help-evidence-header";
  const title = document.createElement("strong");
  title.textContent = "Local Help context";
  const badge = document.createElement("span");
  badge.className = "revision-badge";
  badge.textContent = context.incomplete || context.truncated ? "partial" : "resolved";
  header.append(title, badge);
  const identity = document.createElement("p");
  identity.className = "agent-help-evidence-identity";
  identity.textContent = `${context.package}::${context.help_topic}${context.package_version ? ` · ${context.package_version}` : ""}`;
  const record = document.createElement("code");
  record.textContent = context.help_record;
  const note = document.createElement("p");
  note.textContent = context.incomplete || context.truncated
    ? "The answer received a bounded installed Help record; inspect the partial state before relying on missing sections."
    : "This is installed documentation context supplied to this turn, separate from the model's explanation.";
  const open = document.createElement("button");
  open.type = "button";
  open.textContent = "Open Help";
  open.addEventListener("click", (event) => {
    event.stopPropagation();
    openAgentLocalHelpContext(context);
  });
  block.append(header, identity, record, note, open);
  container.append(block);
}

function selectedFileEditProposal() {
  const detail = state.selectedTurnDetail;
  if (!detail?.events?.length) return null;
  const event = [...detail.events].reverse().find((item) =>
    item.event_type === "tool.call_completed" && item.tool === "propose_file_edit"
  );
  if (!event) return null;
  let proposal = parseJsonObject(event.body);
  if (proposal?.kind !== "rho.file_edit_proposal") {
    const toolEvent = parseJsonObject(event.details_json);
    if (toolEvent?.success !== true || !toolEvent.arguments) return null;
    proposal = { kind: "rho.file_edit_proposal", ...toolEvent.arguments };
  }
  if (typeof proposal.path !== "string"
    || typeof proposal.content !== "string"
    || !["replace_selection", "insert_at_cursor", "append", "create"].includes(proposal.operation)) {
    return null;
  }
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
  const panel = $("#fileEditPanel");
  panel.classList.toggle("hidden", !visible);
  if (!visible) {
    delete panel.dataset.proposalKey;
    return;
  }
  const proposalChanged = panel.dataset.proposalKey !== proposal.key;
  panel.dataset.proposalKey = proposal.key;
  if (proposalChanged) panel.open = true;
  panel.dataset.state = decision || "waiting";
  $("#fileEditPanelTitle").textContent = `${fileEditOperationLabel(proposal.operation)} proposal`;
  $("#fileEditPath").textContent = proposal.path;
  $("#fileEditPath").title = proposal.path;
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
  const undoAvailable = accepted
    && state.fileEditUndo?.key === proposal.key
    && state.fileEditUndoVerifiedKey === proposal.key;
  renderFileEditDecisionNote(decision, undoAvailable);
  $("#fileEditAccept").classList.toggle("hidden", accepted || rejected);
  $("#fileEditReject").classList.toggle("hidden", accepted || rejected);
  $("#fileEditUndo").classList.toggle("hidden", !undoAvailable);
}

async function verifyFileEditUndo() {
  const undo = state.fileEditUndo;
  if (!undo) return;
  const key = undo.key;
  try {
    const current = await projectFileContent(undo.path);
    if (state.fileEditUndo?.key !== key) return;
    if (current !== undo.afterContent) {
      state.fileEditUndo = null;
      state.fileEditUndoVerifiedKey = null;
      renderFileEditPanel();
      return;
    }
    state.fileEditUndoVerifiedKey = key;
    renderFileEditPanel();
  } catch {
    if (state.fileEditUndo?.key !== key) return;
    state.fileEditUndo = null;
    state.fileEditUndoVerifiedKey = null;
    renderFileEditPanel();
  }
}

function maybeAutoApplyFileEditProposal() {
  const proposal = state.fileEditProposal;
  if (!proposal
    || state.fileEditDecisions.has(proposal.key)
    || !state.actAuthorizedTurnIds.has(proposal.turnId)
    || state.fileEditAutoApplyAttempts.has(proposal.key)
    || proposal.editorContext?.project_root !== state.project.root) return;
  state.fileEditAutoApplyAttempts.add(proposal.key);
  acceptFileEditProposal({ automatic: true });
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

async function acceptFileEditProposal({ automatic = false } = {}) {
  const proposal = state.fileEditProposal;
  if (!proposal || state.fileEditApplyBusy) return;
  const button = $("#fileEditAccept");
  state.fileEditApplyBusy = true;
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
    state.fileEditUndoVerifiedKey = null;
    state.fileEditDecisions.set(proposal.key, "accepted");
    persistFileEditDecisions();
    scheduleSessionSave();
    $("#fileEditPanel").open = false;
    renderFileEditPanel();
    void verifyFileEditUndo();
    toast(`${automatic ? "Automatically applied" : "Applied"} Agent edit to ${proposal.path}.`);
  } catch (error) {
    state.internalProjectWrites.delete(proposal.path);
    toast(reportUiFailure("apply Agent file edit", error, "The proposed edit could not be applied. Refresh the project and review the proposal again."), true);
  } finally {
    state.fileEditApplyBusy = false;
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
    state.fileEditUndoVerifiedKey = null;
    persistFileEditDecisions();
    scheduleSessionSave();
    renderFileEditPanel();
    renderProjectFiles();
    renderDocumentTabs();
    toast(`Undid Agent edit in ${undo.path}.`);
  } catch (error) {
    toast(reportUiFailure("undo Agent file edit", error, "The Agent edit could not be undone. The current file was left unchanged."), true);
  } finally {
    button.disabled = false;
  }
}

function hideAgentFileMentions() {
  state.agentFileMention = { items: [], index: 0, start: -1, end: -1, mode: "mention", contextSource: null };
  $("#agentFileMentions").classList.add("hidden");
  $("#agentFileMentions").replaceChildren();
}

async function insertAgentFileMention(path) {
  const { start, end, contextSource } = state.agentFileMention;
  if (contextSource === "open_file") {
    hideAgentFileMentions();
    closeAgentContextMenu();
    await openDocument(path);
    return;
  }
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

async function sendAgentPrompt(options = {}) {
  const taskKind = options.taskKind || "agent_turn";
  const mode = options.mode || state.agentMode;
  const prompt = $("#agentInput").value.trim();
  if (!prompt) return null;
  const admission = agentTurnAdmissionState(mode, taskKind);
  if (admission.reason) {
    toast(admission.reason, true);
    return null;
  }
  const selectedModelId = state.agentLlm.selectedModelId || state.agentLlm.settings?.selected_model_id || null;
  if (!selectedModelId) {
    toast(agentSendDisabledReason() || "No Agent model is selected.", true);
    return null;
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
    const authorizeChanges = taskKind === "agent_turn" && mode === "act" && state.actAutoApprove;
    const selectedConversation = state.agentConversations.find(
      (conversation) => conversation.conversation_id === state.selectedConversationId,
    ) || null;
    const conversationId = taskKind === "agent_turn" && !selectedConversation?.legacy_unthreaded
      ? state.selectedConversationId
      : null;
    const response = await invoke("run_agent", {
      prompt,
      mode,
      taskKind,
      autoApprove: authorizeChanges,
      editorContext,
      conversationId,
    });
    if (authorizeChanges && response?.turn_id) state.actAuthorizedTurnIds.add(response.turn_id);
    resetAgentContext();
    resetAgentLocalHelpContext();
    state.activeAgentTurnId = response?.turn_id || null;
    state.selectedConversationId = response?.conversation_id || state.selectedConversationId;
    state.selectedTurnId = response?.turn_id || state.selectedTurnId;
    state.selectedTurnDetail = null;
    state.agentSubmissionPending = false;
    await Promise.all([loadAgentData(), loadRunData()]);
    return response;
  } catch (error) {
    const message = String(error);
    $("#agentState").textContent = "Failed";
    $("#agentStateDot").className = "agent-state-dot error";
    setAgentInputBusy(false);
    toast(message, true);
    return null;
  }
}

function switchDockTab(name) {
  $$("[data-dock-tab]").forEach((button) => {
    const selected = button.dataset.dockTab === name;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  ["console", "logs", "plots", "problems"].forEach((tab) => $(`#${tab}Panel`).classList.toggle("hidden", tab !== name));
  if (name === "console") {
    requestAnimationFrame(() => {
      const input = $("#consoleInput");
      if (!input.disabled && !$("#consolePanel").classList.contains("hidden")) input.focus();
    });
  }
}

function switchContextTab(name) {
  $$("[data-context-tab]").forEach((button) => {
    const selected = button.dataset.contextTab === name;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  document.querySelector(`[data-context-tab="${name}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  $("#agentPanel").classList.toggle("hidden", name !== "agent");
  $("#environmentPanel").classList.toggle("hidden", name !== "environment");
  $("#evidencePanel").classList.toggle("hidden", name !== "evidence");
  $("#gitPanel").classList.toggle("hidden", name !== "git");
  $("#localHelpPanel").classList.toggle("hidden", name !== "help");
  $("#projectReferencesPanel").classList.toggle("hidden", name !== "references");
  $("#chunksPanel").classList.toggle("hidden", name !== "chunks");
  $("#auditPanel").classList.add("hidden");
  if (name === "evidence") loadEvidenceEntries();
  if (name === "git") return loadGitStatus().then(() => loadGitReview());
  return Promise.resolve();
}

function normalizeHumanPreset(value) {
  return ["code", "analyze", "agent"].includes(value) ? value : "code";
}

function applyWorkbenchLayout(layout) {
  const normalized = normalizeHumanPreset(layout);
  state.humanPreset = normalized;
  $(".app-shell").classList.toggle("layout-code", normalized === "code");
  $$("[data-layout]").forEach((button) => {
    const selected = button.dataset.layout === normalized;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  if (normalized === "agent") switchContextTab("agent");
  if (normalized === "analyze") switchContextTab("environment");
  if (normalized === "agent") setAgentComposerHeight(Number($("#agentComposerResizeHandle").getAttribute("aria-valuenow")), false);
  requestAnimationFrame(() => layoutEditor());
}

function normalizedArtifactDetail() {
  return state.selectedArtifactDetail?.artifact || state.selectedArtifactDetail || null;
}

function reviewWorkSurfaceKind() {
  if (state.auditLoading || state.auditResult) return "audit";
  if (state.agentSelectedOutput?.kind === "plot" && state.plots.some((plot) => plot.plot_id === state.agentSelectedOutput.id)) return "plot";
  if (normalizedArtifactDetail()) return "artifact";
  return "run";
}

function syncAgentWorkSurfaceLayout() {
  const shell = $(".app-shell");
  const isAgent = state.posture === "agent";
  const kind = ["file", "run", "plot", "artifact", "audit"].includes(state.agentWorkSurface)
    ? state.agentWorkSurface
    : "none";
  const isReview = ["run", "plot", "artifact", "audit"].includes(kind);

  shell.classList.toggle("agent-work-open", isAgent && kind !== "none");
  shell.classList.toggle("agent-work-file", isAgent && kind === "file");
  shell.classList.toggle("agent-work-review", isAgent && isReview);
  shell.classList.toggle("has-task-rail", isAgent && kind === "none" && state.agentConversations.length > 0);
  shell.dataset.agentWorkSurface = isAgent ? kind : "none";

  $("#taskRail").classList.toggle("hidden", !(isAgent && kind === "none" && state.agentConversations.length > 0));
  $("#agentFileSurfaceHeader").classList.toggle("hidden", !(isAgent && kind === "file"));
  $("#agentReviewWorkspace").classList.toggle("hidden", !(isAgent && isReview));
  $("#agentFileSurfaceTitle").textContent = displayPath(state.activeDocument) || "No file selected";
  $("#agentReviewSurfaceClose").textContent = ["plot", "artifact"].includes(kind) ? "Back to Outputs" : "Back to Task";
  $("#agentReviewSurfaceClose").setAttribute("aria-label", ["plot", "artifact"].includes(kind) ? "Close review and return to Outputs" : "Close review and return to Task");
  if (isAgent && isReview) renderAgentReviewWorkspace();
  requestAnimationFrame(() => layoutEditor());
}

function openAgentWorkSurface(kind) {
  if (state.posture !== "agent") return;
  if (kind === "run" && !state.runs.some((run) => run.run_id === state.agentReviewRunId)) {
    state.agentReviewRunId = state.activeRunId || state.runs[0]?.run_id || null;
  }
  state.agentWorkSurface = kind;
  state.agentSurface = kind === "file" ? "direct" : "review";
  applyAgentSurface(state.agentSurface);
  syncAgentWorkSurfaceLayout();
  if (kind === "run") loadAgentReviewRunDetail(state.agentReviewRunId);
  scheduleSessionSave();
}

function closeAgentWorkSurface() {
  const returnToOutputs = ["plot", "artifact"].includes(state.agentWorkSurface);
  state.agentWorkSurface = "none";
  state.agentSelectedOutput = null;
  state.agentSurface = returnToOutputs ? "outputs" : "direct";
  applyAgentSurface(state.agentSurface);
  syncAgentWorkSurfaceLayout();
  scheduleSessionSave();
  if (returnToOutputs) $("#agentOutputsList .agent-output-card.active")?.focus();
  else $("#agentInput").focus();
}

function appendAgentReviewSection(container, label, value) {
  if (value === null || value === undefined || value === "") return;
  const section = document.createElement("section");
  section.className = "review-section";
  const heading = document.createElement("strong");
  heading.textContent = label;
  const content = document.createElement("pre");
  content.textContent = String(value);
  section.append(heading, content);
  container.append(section);
}

async function loadAgentReviewRunDetail(runId) {
  state.agentReviewRunDetail = null;
  state.agentReviewRunError = null;
  if (!runId) return;
  state.agentReviewRunLoading = true;
  renderAgentReviewWorkspace();
  try {
    const detail = await invoke("get_run_detail", { runId });
    if (state.agentReviewRunId !== runId) return;
    state.agentReviewRunDetail = detail || null;
    if (!detail) state.agentReviewRunError = "Detailed execution output is no longer available.";
  } catch (error) {
    if (state.agentReviewRunId !== runId) return;
    state.agentReviewRunError = reportUiFailure("load Agent run review", error, "Detailed execution output is unavailable.");
  } finally {
    if (state.agentReviewRunId === runId) {
      state.agentReviewRunLoading = false;
      renderAgentReviewWorkspace();
    }
  }
}

function appendAgentReviewGroup(container, title) {
  const group = document.createElement("section");
  group.className = "agent-review-group";
  const heading = document.createElement("h3");
  heading.textContent = title;
  group.append(heading);
  container.append(group);
  return group;
}

function appendRunPlotEvidence(container, plot) {
  const card = document.createElement("article");
  card.className = "agent-review-evidence-card plot-evidence";
  const heading = document.createElement("strong");
  heading.textContent = "Plot produced";
  const meta = document.createElement("p");
  meta.textContent = `${plotSourceLabel(plot)} · ${humanExecutionMode(plot)}`;
  card.append(heading, meta);
  const payload = parseJsonObject(plot.payload_json);
  const source = plotImageSource(payload);
  if (source) {
    const image = document.createElement("img");
    image.alt = `Plot produced by ${plotSourceLabel(plot).toLowerCase()}`;
    image.src = source;
    image.addEventListener("error", () => {
      const error = document.createElement("p");
      error.textContent = "Plot record exists, but its preview could not be decoded.";
      image.replaceWith(error);
    });
    card.append(image);
  } else {
    const limitation = document.createElement("p");
    limitation.className = "agent-review-limitation";
    limitation.textContent = payload["rho/pruned"]
      ? "Rho no longer stores this preview, but the plot remains in history."
      : "The plot remains in history, but its preview is unavailable.";
    card.append(limitation);
  }
  container.append(card);
}

function renderAgentRunReview(content, run) {
  const detail = state.agentReviewRunDetail?.run_id === run.run_id ? state.agentReviewRunDetail : null;
  const record = detail || run;
  const evidence = runEvidence(run.run_id);

  const overview = document.createElement("div");
  overview.className = "agent-review-overview";
  const title = document.createElement("strong");
  title.textContent = humanRunTitle(run);
  const status = createStateChip(prettyStatus(run.status), run.status);
  const summary = document.createElement("p");
  summary.textContent = `${prettyOrigin(run.origin)} · ${displayPath(run.source_path) || "Console / workspace"} · ${formatTimestamp(run.started_at)}`;
  overview.append(title, status, summary);
  content.append(overview);

  const request = appendAgentReviewGroup(content, "Requested work");
  appendAgentReviewSection(request, "Action", humanRunTitle(run));
  appendAgentReviewSection(request, "Source", displayPath(run.source_path) || "Console / workspace");
  appendAgentReviewSection(request, "Run scope", humanExecutionMode(run));
  appendAgentReviewSection(request, "R code", record.code || run.code_preview);

  const outcome = appendAgentReviewGroup(content, "What happened");
  appendAgentReviewSection(outcome, "Outcome", prettyStatus(run.status));
  appendAgentReviewSection(outcome, "Output", [record.stdout, record.value_text].filter(Boolean).join("\n"));
  appendAgentReviewSection(outcome, "Messages", stringValues(record.messages).join("\n"));
  appendAgentReviewSection(outcome, "Warnings", stringValues(record.warnings).join("\n"));
  appendAgentReviewSection(outcome, "Error", record.error_message || run.error_message);
  const traceback = stringValues(record.traceback).join("\n");
  if (traceback) {
    const details = document.createElement("details");
    details.className = "agent-review-traceback";
    const summary = document.createElement("summary");
    summary.textContent = "Technical error details";
    details.append(summary);
    appendAgentReviewSection(details, "Traceback", traceback);
    outcome.append(details);
  }
  if (state.agentReviewRunLoading) {
    const loading = document.createElement("p");
    loading.className = "agent-review-loading";
    loading.setAttribute("role", "status");
    loading.textContent = "Loading detailed execution output...";
    outcome.append(loading);
  }

  const evidenceGroup = appendAgentReviewGroup(content, "Review evidence");
  for (const plot of evidence.plots) appendRunPlotEvidence(evidenceGroup, plot);
  for (const artifact of evidence.artifacts) {
    const card = document.createElement("article");
    card.className = "agent-review-evidence-card";
    const label = document.createElement("strong");
    label.textContent = artifactKindLabel(artifact.artifact_kind);
    const path = document.createElement("p");
    path.textContent = displayPath(artifact.output_path) || "Output path unavailable";
    card.append(label, path);
    evidenceGroup.append(card);
  }
  for (const problem of evidence.problems) {
    const card = document.createElement("article");
    card.className = "agent-review-evidence-card problem-evidence";
    const label = document.createElement("strong");
    label.textContent = `${problem.severity || "Problem"}: ${problem.message || "Execution problem"}`;
    const source = document.createElement("p");
    source.textContent = displayPath(problem.source_path) || "No source recorded";
    card.append(label, source);
    evidenceGroup.append(card);
  }
  if (run.source_path && state.project.files.some((file) => file.path === run.source_path)) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "agent-review-source-action";
    open.textContent = `Open ${displayPath(run.source_path)}`;
    open.addEventListener("click", () => openDocument(run.source_path));
    evidenceGroup.append(open);
  }

  const limitations = [];
  if (["queued", "running", "waiting"].includes(run.status)) limitations.push("This run is still in progress; its outcome and evidence may change.");
  if (state.agentReviewRunError) limitations.push(state.agentReviewRunError);
  if (!state.agentReviewRunLoading && !evidence.plots.length && !evidence.artifacts.length && !evidence.problems.length) limitations.push("No durable Plot, saved output, or Problem is linked to this run.");
  if (evidence.plots.some((plot) => !plot.provenance_complete) || evidence.artifacts.some((artifact) => !artifact.provenance_complete)) limitations.push("Some output source details are unavailable.");
  if (limitations.length) {
    const group = appendAgentReviewGroup(content, "Limitations");
    for (const text of limitations) {
      const item = document.createElement("p");
      item.className = "agent-review-limitation";
      item.textContent = text;
      group.append(item);
    }
  }

  const timing = appendAgentReviewGroup(content, "Source and timing");
  appendAgentReviewSection(timing, "Started by", prettyOrigin(run.origin));
  appendAgentReviewSection(timing, "Started", formatTimestamp(run.started_at));
  appendAgentReviewSection(timing, "Finished", run.finished_at ? formatTimestamp(run.finished_at) : "Not finished");
}

const AUDIT_STATUS_PRESENTATION = {
  running: { label: "Checking", description: "Reviewing project files, runs, and saved outputs." },
  complete: { label: "No issues found", description: "The available checks completed within the reviewed coverage." },
  findings: { label: "Needs attention", description: "Some items may make this project harder to reproduce." },
  incomplete: { label: "Check incomplete", description: "Some required files or records could not be reviewed." },
  unavailable: { label: "Not available", description: "The project check is not available for this project." },
  error: { label: "Check failed", description: "The project could not be checked. No conclusion was reached." },
};

const AUDIT_CATEGORY_LABELS = {
  evidence: "Results and evidence",
  portability: "Project portability",
  randomness: "Randomness",
  packages: "Package environment",
  runs: "Run history",
  other: "Other checks",
};

const AUDIT_RULE_PRESENTATION = {
  "rho.repro.v1.evidence.run.env_snapshot_missing": ["Environment was not recorded", "A run has no saved record of the R and package environment used.", "Rerun important work after confirming the project environment."],
  "rho.repro.v1.evidence.run.source_revision_missing": ["Source version was not recorded", "A run is not linked to the saved source version that produced it.", "Open the related run and confirm which code was executed."],
  "rho.repro.v1.evidence.artifact.producing_run_missing": ["Saved output has no producing run", "A saved output is not linked to the run that created it.", "Regenerate the output from a recorded run when provenance matters."],
  "rho.repro.v1.evidence.artifact.provenance_incomplete": ["Saved output has incomplete history", "A saved output is missing source or environment information.", "Review the output and regenerate it from the current project if needed."],
  "rho.repro.v1.evidence.artifact.file_missing": ["Saved output file is missing", "The output remains in project history, but its file is no longer available.", "Restore the file or regenerate the output."],
  "rho.repro.v1.evidence.env.snapshot_incomplete": ["Environment record is incomplete", "A recorded environment does not contain all information needed for review.", "Refresh the project environment evidence before sharing results."],
  "rho.repro.v1.evidence.env.lockfile_drift": ["Package lockfile has changed", "The recorded environment no longer matches the project lockfile.", "Review Environment and update or restore the lockfile intentionally."],
  "rho.repro.v1.evidence.env.lockfile_missing": ["Package lockfile is missing", "The project has no renv.lock file to record package versions.", "Initialize renv when the project needs a reproducible package environment."],
  "rho.repro.v1.portability.absolute_path.windows": ["Windows-specific path", "Source code refers to a location tied to one Windows machine.", "Use a project-relative path or a configurable input location."],
  "rho.repro.v1.portability.absolute_path.posix": ["System-specific path", "Source code refers to an absolute location that may not exist elsewhere.", "Use a project-relative path or a configurable input location."],
  "rho.repro.v1.portability.home_path.literal": ["Home-folder path", "Source code depends on a file under one user's home folder.", "Move the input into the project or make its location configurable."],
  "rho.repro.v1.portability.setwd.literal": ["Working directory changed in code", "The analysis changes its working directory to a fixed location.", "Open the intended Rho project and use project-relative paths."],
  "rho.repro.v1.randomness.rng_without_seed": ["Random result may change", "Random-number generation was found without a nearby fixed seed.", "Set a deliberate seed before the random analysis when repeatability matters."],
  "rho.repro.v1.packages.not_recorded": ["Package is not in the environment record", "Source code uses a package that is absent from the recorded environment.", "Refresh Environment and record the package dependency."],
  "rho.repro.v1.packages.installed_not_locked": ["Installed package is not locked", "A package is available now but is not recorded in renv.lock.", "Review and snapshot the intended package environment."],
  "rho.repro.v1.packages.locked_not_installed": ["Locked package is not installed", "renv.lock expects a package that is unavailable in the current environment.", "Review Environment and restore the lockfile deliberately."],
  "rho.repro.v1.packages.version_drift": ["Package versions differ", "The installed package version differs from the locked version.", "Choose whether to restore or update the project environment."],
  "rho.repro.v1.runs.failed": ["A run failed", "A recorded analysis ended with an error.", "Open the related run, review the error, and rerun only after correcting it."],
  "rho.repro.v1.runs.cancelled": ["A run was cancelled", "A recorded analysis was cancelled before completion.", "Confirm whether a completed replacement run is needed."],
  "rho.repro.v1.runs.interrupted": ["A run was interrupted", "A recorded analysis stopped before completion.", "Confirm whether a completed replacement run is needed."],
  "rho.repro.v1.runs.artifact_incomplete_run": ["Output came from an incomplete run", "A saved output is linked to a run that did not complete successfully.", "Review the output carefully and regenerate it from a successful run."],
};

function auditStatusPresentation(status) {
  return AUDIT_STATUS_PRESENTATION[status] || { label: "Review needed", description: "The project check returned an unfamiliar state." };
}

function auditCategoryLabel(category) {
  return AUDIT_CATEGORY_LABELS[category] || AUDIT_CATEGORY_LABELS.other;
}

function auditFindingPresentation(finding) {
  const [title, description, nextStep] = AUDIT_RULE_PRESENTATION[finding?.rule_id] || [
    "Review needed",
    "A project check found something that may affect reproducibility.",
    "Review the linked source or record before relying on this result.",
  ];
  return { title, description, nextStep };
}

function auditRelativePath(path) {
  const shown = displayPath(path);
  const root = displayPath(state.project.root).replace(/\/+$/, "");
  if (root && shown.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return shown.slice(root.length + 1);
  return shown;
}

function auditEvidenceLabel(item) {
  const path = auditRelativePath(String(item.path || ""));
  if (item.kind === "source_range") return path ? `Open ${path}${item.line ? `:${item.line}` : ""}` : "Source location";
  if (item.kind === "file_path") return path ? `File: ${path}` : "Project file";
  if (item.kind === "artifact_id") return path ? `Saved output: ${path}` : "Saved output";
  if (item.kind === "run_id") {
    const run = state.runs.find((candidate) => candidate.run_id === item.run_id);
    return run ? `Run: ${humanRunTitle(run)}` : "Related run";
  }
  if (item.kind === "snapshot_id") return "Environment record";
  return path ? `Evidence: ${path}` : "Supporting evidence";
}

async function openAuditSourceEvidence(path, item) {
  await openDocument(path);
  if (state.activeDocument !== path || !item.line) return;
  const line = Math.max(1, Number(item.line) || 1);
  const column = Math.max(1, Number(item.column) || 1);
  if (state.editor.mode === "monaco" && state.editor.editor) {
    const model = state.editor.editor.getModel();
    const boundedLine = Math.min(line, model?.getLineCount() || line);
    const boundedColumn = Math.min(column, model?.getLineMaxColumn(boundedLine) || column);
    state.editor.editor.revealLineInCenter(boundedLine);
    state.editor.editor.setPosition({ lineNumber: boundedLine, column: boundedColumn });
    state.editor.editor.focus();
    return;
  }
  const editor = fallbackEditor();
  const lines = editor.value.split("\n");
  const boundedLine = Math.min(line, lines.length);
  const offset = lines.slice(0, boundedLine - 1).reduce((total, value) => total + value.length + 1, 0)
    + Math.min(column - 1, lines[boundedLine - 1]?.length || 0);
  editor.setSelectionRange(offset, offset);
  editor.focus();
}

function appendAuditEvidence(container, evidence) {
  const evidenceRow = document.createElement("div");
  evidenceRow.className = "audit-evidence-links";
  for (const item of evidence || []) {
    const path = auditRelativePath(String(item.path || ""));
    const canOpenPath = path && state.project.files.some((file) => file.path.replace(/\\/g, "/") === path.replace(/\\/g, "/"));
    const canOpenRun = item.kind === "run_id" && state.posture === "agent" && state.runs.some((run) => run.run_id === item.run_id);
    const element = document.createElement(canOpenPath || canOpenRun ? "button" : "span");
    if (canOpenPath) {
      element.type = "button";
      element.setAttribute("aria-label", `Open project check evidence ${path}`);
      element.addEventListener("click", () => openAuditSourceEvidence(path, item));
    } else if (canOpenRun) {
      element.type = "button";
      element.addEventListener("click", () => {
        state.agentReviewRunId = item.run_id;
        openAgentWorkSurface("run");
      });
    }
    element.textContent = auditEvidenceLabel(item);
    evidenceRow.append(element);
    if (item.kind === "source_range" && item.excerpt) {
      const excerpt = document.createElement("code");
      excerpt.className = "audit-evidence-excerpt";
      excerpt.textContent = item.excerpt;
      evidenceRow.append(excerpt);
    } else if (item.kind === "run_id" && item.excerpt) {
      const excerpt = document.createElement("span");
      excerpt.className = "audit-evidence-note";
      excerpt.textContent = `Error: ${item.excerpt}`;
      evidenceRow.append(excerpt);
    }
  }
  if (evidenceRow.childElementCount) container.append(evidenceRow);
}

function createAuditFindingCard(finding) {
  const presentation = auditFindingPresentation(finding);
  const card = document.createElement("article");
  card.className = `audit-finding-card severity-${finding.severity || "warning"}`;
  const heading = document.createElement("div");
  heading.className = "audit-finding-heading";
  const title = document.createElement("strong");
  title.textContent = presentation.title;
  const severity = {
    error: ["Important", "failed"],
    warning: ["Review", "warning"],
    info: ["Note", "neutral"],
  }[finding.severity] || ["Review", "warning"];
  heading.append(title, createStateChip(severity[0], severity[1]));
  const description = document.createElement("p");
  description.textContent = presentation.description;
  const next = document.createElement("p");
  next.className = "audit-next-step";
  next.textContent = `Next: ${presentation.nextStep}`;
  card.append(heading, description, next);
  appendAuditEvidence(card, finding.evidence);
  if (finding.limitations?.length) {
    const limitation = document.createElement("p");
    limitation.className = "audit-finding-limitation";
    limitation.textContent = "Some supporting evidence could not be checked completely.";
    card.append(limitation);
  }
  return card;
}

function appendAuditFindingGroups(container, findings) {
  const groups = findings.reduce((all, finding) => {
    const category = AUDIT_CATEGORY_LABELS[finding.category] ? finding.category : "other";
    (all[category] ||= []).push(finding);
    return all;
  }, {});
  for (const category of ["evidence", "portability", "randomness", "packages", "runs", "other"]) {
    const items = groups[category] || [];
    if (!items.length) continue;
    const group = document.createElement("section");
    group.className = "audit-finding-group";
    const heading = document.createElement("h3");
    heading.textContent = auditCategoryLabel(category);
    const count = document.createElement("span");
    count.textContent = String(items.length);
    heading.append(count);
    group.append(heading, ...items.map(createAuditFindingCard));
    container.append(group);
  }
}

function auditCountLabel(value, singular, plural = `${singular}s`) {
  const count = Number(value) || 0;
  return `${count} ${count === 1 ? singular : plural}`;
}

function auditCoverageText(coverage = {}, currentProjectOnly = false) {
  if (currentProjectOnly) {
    const reviewed = `Reviewed ${auditCountLabel(coverage.files_scanned, "current project file")}.`;
    return coverage.files_skipped
      ? `${reviewed} ${auditCountLabel(coverage.files_skipped, "file")} could not be reviewed.`
      : reviewed;
  }
  const reviewed = `Reviewed ${auditCountLabel(coverage.files_scanned, "file")}, ${auditCountLabel(coverage.runs_considered, "run")}, and ${auditCountLabel(coverage.artifacts_considered, "saved output")}.`;
  if (!coverage.files_skipped) return reviewed;
  return `${reviewed} ${auditCountLabel(coverage.files_skipped, "file")} could not be reviewed.`;
}

function renderAgentAuditWorkspace(content) {
  const result = state.auditResult;
  if (state.auditLoading) {
    content.innerHTML = '<div class="agent-review-empty" role="status">Checking project...</div>';
    return;
  }
  if (state.auditBlockedFiles.length) {
    const paths = state.auditBlockedFiles.map(displayPath).join(", ");
    const empty = document.createElement("div");
    empty.className = "agent-review-empty";
    empty.setAttribute("role", "status");
    empty.textContent = `Save the modified source ${state.auditBlockedFiles.length === 1 ? "file" : "files"} before checking: ${paths}. Then run Check project again.`;
    content.replaceChildren(empty);
    return;
  }
  if (!result) {
    content.innerHTML = '<div class="agent-review-empty">Check the project to review reproducibility risks.</div>';
    return;
  }
  const summary = document.createElement("div");
  summary.className = "agent-review-summary";
  const coverage = result.coverage || {};
  const status = auditStatusPresentation(result.status);
  const currentProjectOnly = result.scope === "project_current";
  appendAgentReviewSection(summary, "Result", status.label);
  appendAgentReviewSection(summary, "What this means", status.description);
  appendAgentReviewSection(summary, "Reviewed", auditCoverageText(coverage, currentProjectOnly));
  if (currentProjectOnly) appendAgentReviewSection(summary, "Scope", "Current project directory only; historical runs and saved outputs are excluded.");
  if (result.truncated) appendAgentReviewSection(summary, "Coverage limitation", "Some project information could not be reviewed, so this result is incomplete.");
  content.append(summary);

  const findings = result.findings || [];
  if (!findings.length) {
    const empty = document.createElement("div");
    empty.className = "agent-review-empty";
    empty.textContent = result.status === "error" ? (result.ui_message || "The project check did not complete.") : "No issues were found in the reviewed project information.";
    content.append(empty);
    return;
  }
  appendAuditFindingGroups(content, findings);
}

function renderAgentPlotWorkspace(content, plot) {
  const review = document.createElement("div");
  review.className = "agent-review-plot";
  const stage = document.createElement("div");
  stage.className = "agent-review-plot-stage";
  const payload = parseJsonObject(plot.payload_json);
  const source = plotImageSource(payload);
  if (source) {
    const image = document.createElement("img");
    image.src = source;
    image.alt = `Review ${plotSourceLabel(plot).toLowerCase()}`;
    image.addEventListener("error", () => {
      stage.textContent = "The Plot record exists, but its preview could not be decoded.";
      stage.classList.add("agent-review-limitation");
    });
    stage.append(image);
  } else {
    const limitation = document.createElement("p");
    limitation.className = "agent-review-limitation";
    limitation.textContent = payload["rho/pruned"]
      ? "Rho removed this preview to save space. The Plot remains in history."
      : "The Plot remains in history, but its preview is unavailable.";
    stage.append(limitation);
  }
  review.append(stage);

  const meta = document.createElement("div");
  meta.className = "agent-review-output-meta";
  appendAgentReviewSection(meta, "Created from", displayPath(plot.source_path) || "Console / workspace");
  appendAgentReviewSection(meta, "Created", formatTimestamp(plot.created_at));
  appendAgentReviewSection(meta, "Review state", plotReviewState(plot));
  review.append(meta);

  const actions = document.createElement("div");
  actions.className = "agent-review-actions";
  if (plot.run_id && state.runs.some((run) => run.run_id === plot.run_id)) {
    const run = document.createElement("button");
    run.type = "button";
    run.textContent = "Open producing run";
    run.addEventListener("click", () => {
      state.agentReviewRunId = plot.run_id;
      openAgentWorkSurface("run");
    });
    actions.append(run);
  }
  if (plot.source_path && state.project.files.some((file) => file.path === plot.source_path)) {
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = `Open ${displayPath(plot.source_path)}`;
    open.addEventListener("click", () => openDocument(plot.source_path));
    actions.append(open);
  }
  if (actions.childElementCount) review.append(actions);
  content.append(review);
}

function renderAgentReviewWorkspace() {
  const kind = state.agentWorkSurface;
  const content = $("#agentReviewWorkspaceContent");
  content.replaceChildren();
  $("#agentReviewKind").textContent = kind === "audit" ? "Project check" : kind === "plot" ? "Plot" : kind === "artifact" ? "Saved output" : "Run";

  if (kind === "audit") {
    $("#agentReviewWorkspaceTitle").textContent = "Project reproducibility check";
    renderAgentAuditWorkspace(content);
    return;
  }

  if (kind === "plot") {
    const plot = state.plots.find((item) => item.plot_id === state.agentSelectedOutput?.id)
      || state.plots.find((item) => item.plot_id === state.selectedPlotId);
    $("#agentReviewWorkspaceTitle").textContent = plot
      ? `Plot ${Math.max(0, state.plots.findIndex((item) => item.plot_id === plot.plot_id)) + 1}`
      : "Plot review";
    if (!plot) {
      content.innerHTML = '<div class="agent-review-empty">This Plot is no longer available in the active project.</div>';
      return;
    }
    renderAgentPlotWorkspace(content, plot);
    return;
  }

  const summary = document.createElement("div");
  summary.className = "agent-review-summary";
  if (kind === "artifact") {
    const artifact = normalizedArtifactDetail();
    const detail = state.selectedArtifactDetail;
    $("#agentReviewWorkspaceTitle").textContent = displayPath(artifact?.output_path) || "Saved output review";
    if (!artifact) {
      content.innerHTML = '<div class="agent-review-empty">Select a saved output to review.</div>';
      return;
    }
    appendAgentReviewSection(summary, "Output", artifactKindLabel(artifact.artifact_kind) + " / " + displayPath(artifact.output_path));
    appendAgentReviewSection(summary, "Created", formatTimestamp(artifact.created_at));
    const producingRun = artifact.run_id ? state.runs.find((run) => run.run_id === artifact.run_id) : null;
    appendAgentReviewSection(summary, "Produced by", producingRun ? humanRunTitle(producingRun) : "Workspace R");
    if (detail?.file_status === "missing" || detail?.file_available === false) {
      appendAgentReviewSection(summary, "Availability", "Recorded in history; the file is not in the current project.");
    } else if (detail?.file_status === "unsupported") {
      appendAgentReviewSection(summary, "Availability", "File exists in the project, but this format is not supported for preview.");
    } else if (detail?.file_status === "available") {
      appendAgentReviewSection(summary, "Availability", "Available in the current project.");
    }
    if (artifact.incomplete_reason && !["source_path_unavailable", "document_version_unavailable"].includes(artifact.incomplete_reason)) {
      appendAgentReviewSection(summary, "Review note", artifact.incomplete_reason);
    }
    if (detail?.detail_error) appendAgentReviewSection(summary, "Preview note", detail.detail_error);
    const actions = document.createElement("div");
    actions.className = "agent-review-actions";
    if (artifact.run_id && state.runs.some((run) => run.run_id === artifact.run_id)) {
      const run = document.createElement("button");
      run.type = "button";
      run.textContent = "Open producing run";
      run.addEventListener("click", () => {
        state.agentReviewRunId = artifact.run_id;
        openAgentWorkSurface("run");
      });
      actions.append(run);
    }
    if (artifact.source_path && state.project.files.some((file) => file.path === artifact.source_path)) {
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = `Open ${displayPath(artifact.source_path)}`;
      open.addEventListener("click", () => openDocument(artifact.source_path));
      actions.append(open);
    }
    if (actions.childElementCount) summary.append(actions);
  } else {
    const run = state.runs.find((item) => item.run_id === state.agentReviewRunId);
    $("#agentReviewWorkspaceTitle").textContent = run ? humanRunTitle(run) : "Run review";
    if (!run) {
      content.innerHTML = '<div class="agent-review-empty">Select a run from Runs to review it.</div>';
      return;
    }
    renderAgentRunReview(content, run);
    return;
  }
  content.append(summary);
  if (kind === "artifact" && normalizedArtifactDetail()?.output_path && state.selectedArtifactDetail?.file_status === "available") {
    openAgentArtifactPreview(content, normalizedArtifactDetail());
  } else if (kind === "artifact" && state.selectedArtifactDetail?.file_status === "unsupported") {
    const limitation = document.createElement("p");
    limitation.className = "agent-review-limitation";
    limitation.textContent = "The file is available, but this format does not have a Viewer yet.";
    content.append(limitation);
  }
}

async function openAgentArtifactPreview(container, artifact) {
  const existing = container.querySelector(".agent-inline-viewer");
  if (existing) { existing.remove(); return; }
  const wrapper = document.createElement("section");
  wrapper.className = "agent-inline-viewer agent-review-plot";
  const status = document.createElement("p");
  status.className = "agent-review-loading";
  status.textContent = "Loading output preview...";
  wrapper.append(status);
  container.append(wrapper);
  try {
    const result = await invoke("viewer_read_file", { path: artifact.output_path });
    if (result.project_root !== state.project.root) throw new Error("The project changed while loading this output.");
    wrapper.replaceChildren();
    if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(result.media_type)) {
      const image = document.createElement("img");
      image.className = "agent-inline-output-image";
      image.alt = pathFileName(artifact.output_path);
      image.src = "data:" + result.media_type + ";base64," + result.content;
      wrapper.append(image);
    } else if (result.media_type === "text/html") {
      const frame = document.createElement("iframe");
      frame.className = "agent-inline-viewer-frame";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.srcdoc = viewerSandboxHtml(result.content);
      wrapper.append(frame);
    } else if (result.media_type === "text/markdown") {
      const article = document.createElement("article");
      article.className = "viewer-markdown";
      article.innerHTML = viewerSafeMarkdown(result.content);
      wrapper.append(article);
    } else if (["text/x-r", "text/x-r-markdown", "text/plain", "application/json"].includes(result.media_type)) {
      const code = document.createElement("pre");
      code.className = "agent-inline-output-code";
      code.textContent = result.content;
      wrapper.append(code);
    } else {
      const parsed = viewerRenderTable(result.content, result.media_type === "text/tab-separated-values" ? "tsv" : "csv");
      const table = document.createElement("div");
      table.className = "viewer-table-wrap";
      table.append(parsed.table);
      wrapper.append(table);
    }
  } catch (error) {
    wrapper.replaceChildren(Object.assign(document.createElement("p"), { className: "agent-review-limitation", textContent: reportUiFailure("open output preview", error, "The saved output preview is unavailable.") }));
  }
}

function applyPostureLayout() {
  const shell = $(".app-shell");
  const isAgent = state.posture === "agent";

  if (isAgent && state.viewer.open) closeViewer();

  shell.classList.toggle("agent-first", isAgent);
  document.body.classList.toggle("agent-posture", isAgent);
  shell.classList.toggle("layout-code", !isAgent && state.humanPreset === "code");

  $$('[data-posture]').forEach((button) => {
    const selected = button.dataset.posture === state.posture;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  // Human-first layout buttons are only active in human posture
  $$("[data-layout]").forEach((button) => {
    button.disabled = isAgent;
    if (!isAgent) button.classList.toggle("active", button.dataset.layout === state.humanPreset);
  });

  // Rearrange panels for agent-first
  if (isAgent) {
    switchContextTab("agent");
    $(".sidebar > .panel-tabs").classList.add("hidden");
    $(".sidebar > .side-content").classList.add("hidden");
    $("#agentSurfaceTabs").classList.remove("hidden");
    applyAgentSurface(state.agentSurface);
    renderTaskRail();
    syncAgentWorkSurfaceLayout();
  } else {
    state.agentWorkSurface = "none";
    $("#taskRail").classList.add("hidden");
    $(".sidebar > .panel-tabs").classList.remove("hidden");
    $(".sidebar > .side-content").classList.remove("hidden");
    $("#agentSurfaceTabs").classList.add("hidden");
    applyWorkbenchLayout(state.humanPreset);
    syncAgentWorkSurfaceLayout();
  }

  postMessage({ postureUpdated: { posture: state.posture, surface: state.agentSurface } });

  requestAnimationFrame(() => layoutEditor());
}

$$('[data-posture]').forEach((button) => button.addEventListener("click", async () => {
  if (button.dataset.posture === state.posture) return;
  state.posture = button.dataset.posture;
  applyPostureLayout();
  if (state.posture === "human") {
    await loadRunData();
  }
  scheduleSessionSave();
}));

function switchAgentSurface(name) {
  state.agentSurface = name;
  if (["direct", "monitor", "outputs"].includes(name)) state.agentWorkSurface = "none";
  if (name === "review") state.agentWorkSurface = reviewWorkSurfaceKind();
  applyAgentSurface(name);
  syncAgentWorkSurfaceLayout();
  scheduleSessionSave();
}

function applyAgentSurface(name) {
  $$("[data-agent-surface]").forEach((button) => {
    const selected = button.dataset.agentSurface === name;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  });

  // Show/hide panels based on surface
  const isDirect = name === "direct";
  const isMonitor = name === "monitor";
  const isOutputs = name === "outputs";
  const isReview = name === "review";

  $("#agentPanel").classList.toggle("hidden", !(isDirect || (isReview && state.posture === "agent")));
  $(".context-tabs").classList.toggle("hidden", !isDirect);
  $("#agentMonitorPanel").classList.toggle("hidden", !isMonitor);
  $("#agentOutputsPanel").classList.toggle("hidden", !isOutputs);
  $("#agentReviewPanel").classList.toggle("hidden", !(isReview && state.posture !== "agent"));

  if (isMonitor) renderMonitorPanel();
  if (isOutputs) renderAgentOutputs();
  if (isReview) {
    renderReviewPanel();
    if (state.posture === "agent") renderAgentReviewWorkspace();
  }
}

$$("[data-agent-surface]").forEach((button) => button.addEventListener("click", () => {
  switchAgentSurface(button.dataset.agentSurface);
}));

function agentOutputKey(kind, id) {
  return `${kind}:${id || ""}`;
}

async function openAgentOutput(kind, id) {
  if (kind === "plot") {
    const plot = state.plots.find((item) => item.plot_id === id);
    if (!plot) {
      toast("This Plot is no longer available in the active project.", true);
      renderAgentOutputs();
      return;
    }
    state.selectedPlotId = id;
    state.agentSelectedOutput = { kind, id };
    openAgentWorkSurface("plot");
    return;
  }

  const artifact = state.artifacts.find((item) => item.artifact_id === id);
  if (!artifact) {
    toast("This saved output is no longer available in the active project.", true);
    renderAgentOutputs();
    return;
  }
  state.selectedArtifactId = id;
  state.agentSelectedOutput = { kind: "artifact", id };
  try {
    const detail = await invoke("get_artifact_record", { artifactId: id });
    state.selectedArtifactDetail = detail || { artifact, file_available: null };
  } catch (error) {
    state.selectedArtifactDetail = { artifact, file_available: false, detail_error: String(error) };
  }
  openAgentWorkSurface("artifact");
}

function renderAgentOutputs() {
  const list = $("#agentOutputsList");
  if (!list) return;
  const viewport = capturePanelViewport(list, "data-output-key");
  list.replaceChildren();
  const entries = [
    ...state.plots.map((plot, index) => ({ kind: "plot", id: plot.plot_id, record: plot, title: `Plot ${index + 1}`, createdAt: plot.created_at })),
    ...state.artifacts.map((artifact) => ({ kind: "artifact", id: artifact.artifact_id, record: artifact, title: pathFileName(artifact.output_path), createdAt: artifact.created_at })),
  ].sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  $("#agentOutputCount").textContent = String(entries.length);
  const summary = $("#agentOutputsSummary");
  if (summary) summary.textContent = `${entries.length} ${entries.length === 1 ? "output" : "outputs"} available for review`;

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "agent-output-empty";
    empty.textContent = "No outputs yet. Plots and saved results produced in this project will appear here.";
    list.append(empty);
    restorePanelViewport(list, viewport, "data-output-key");
    return;
  }

  for (const entry of entries) {
    const card = document.createElement("button");
    card.type = "button";
    card.dataset.outputKey = agentOutputKey(entry.kind, entry.id);
    const selected = agentOutputKey(entry.kind, entry.id) === agentOutputKey(state.agentSelectedOutput?.kind, state.agentSelectedOutput?.id);
    card.className = `agent-output-card${selected ? " active" : ""}`;
    card.setAttribute("aria-label", `Review ${entry.title}`);
    card.setAttribute("aria-current", selected ? "true" : "false");

    const preview = document.createElement("span");
    preview.className = "agent-output-preview";
    if (entry.kind === "plot") {
      const source = plotImageSource(parseJsonObject(entry.record.payload_json));
      if (source) {
        const image = document.createElement("img");
        image.src = source;
        image.alt = "";
        preview.append(image);
      } else {
        preview.innerHTML = '<svg class="ui-icon" aria-hidden="true"><use href="#icon-image"></use></svg>';
      }
    } else {
      preview.innerHTML = '<svg class="ui-icon" aria-hidden="true"><use href="#icon-file-text"></use></svg>';
    }

    const body = document.createElement("span");
    body.className = "agent-output-body";
    const kind = document.createElement("span");
    kind.className = "agent-output-kind";
    kind.textContent = entry.kind === "plot" ? "Plot" : artifactFileTypeLabel(entry.record);
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const source = document.createElement("p");
    source.textContent = entry.kind === "plot" ? plotSourceLabel(entry.record) : artifactListSourceLabel(entry.record);
    const status = document.createElement("p");
    status.textContent = entry.kind === "plot"
      ? `${plotReviewState(entry.record)} · ${formatTimestamp(entry.createdAt)}`
      : formatTimestamp(entry.createdAt);
    body.append(kind, title, source, status);
    card.append(preview, body);
    card.addEventListener("click", () => openAgentOutput(entry.kind, entry.id));
    list.append(card);
  }
  restorePanelViewport(list, viewport, "data-output-key");
}

function renderMonitorPanel() {
  const list = $("#monitorRunList");
  const viewport = capturePanelViewport(list, "data-run-id");
  list.replaceChildren();

  const visibleRuns = state.runs.slice(0, 12);
  const scientificRuns = visibleRuns.filter((run) => !isBackgroundRun(run));
  const backgroundRuns = visibleRuns.filter(isBackgroundRun);

  const appendRuns = (headingText, runs, quiet = false) => {
    if (!runs.length) return;
    const heading = document.createElement("div");
    heading.className = `monitor-run-group${quiet ? " quiet" : ""}`;
    heading.textContent = headingText;
    list.append(heading);
    for (const run of runs) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `monitor-run-item${quiet ? " background" : ""}`;
      item.dataset.runId = run.run_id;
      const marker = createStateMarker(run.status, prettyStatus(run.status));
      const body = document.createElement("span");
      body.className = "monitor-run-body";
      const title = document.createElement("strong");
      title.textContent = humanRunTitle(run);
      const meta = document.createElement("small");
      meta.textContent = [prettyOrigin(run.origin), displayPath(run.source_path), runEvidenceLabel(run.run_id), formatTimestamp(run.started_at)].filter(Boolean).join(" · ");
      body.append(title, meta);
      item.append(marker, body, createStateChip(prettyStatus(run.status), run.status));
      item.setAttribute("aria-label", `Review ${humanRunTitle(run)}`);
      item.addEventListener("click", () => {
        state.agentReviewRunId = run.run_id;
        openAgentWorkSurface("run");
      });
      list.append(item);
    }
  };

  appendRuns("Scientific work", scientificRuns);
  appendRuns("Background activity", backgroundRuns, true);

  if (!visibleRuns.length) {
    list.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:12px">No runs yet.</div>';
  }
  restorePanelViewport(list, viewport, "data-run-id");
}

function renderReviewPanel() {
  const content = $("#reviewContent");
  content.replaceChildren();

  // Show selected run or artifact detail
  const run = state.runs.find((r) => r.run_id === state.activeRunId);
  if (run) {
    $("#reviewTitle").textContent = humanRunTitle(run);
    addReviewSection(content, "Status", prettyStatus(run.status));
    addReviewSection(content, "Started by", prettyOrigin(run.origin));
    addReviewSection(content, "Action", humanRunTitle(run));
    if (run.source_path) addReviewSection(content, "Source", displayPath(run.source_path));
    return;
  }

  // Show selected artifact detail
  if (state.selectedArtifactDetail) {
    const a = normalizedArtifactDetail();
    $("#reviewTitle").textContent = a?.output_path ? pathFileName(a.output_path) : "Saved output";
    addReviewSection(content, "Kind", artifactKindLabel(a?.artifact_kind));
    if (a?.output_path) addReviewSection(content, "Saved to", displayPath(a.output_path));
    if (a?.source_path) addReviewSection(content, "Created from", displayPath(a.source_path));
    addReviewSection(content, "Source details", a?.provenance_complete ? "Available" : "Incomplete");
    if (a?.incomplete_reason) addReviewSection(content, "Needs attention", a.incomplete_reason);
    return;
  }

  content.innerHTML = '<div style="color:var(--muted);font-size:12px">Select a run or saved output to inspect.</div>';
}

function addReviewSection(container, label, value) {
  const section = document.createElement("div");
  section.className = "review-section";
  const strong = document.createElement("strong");
  strong.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = String(value);
  section.append(strong, pre);
  container.append(section);
}

$("#monitorInterrupt").addEventListener("click", () => invoke("interrupt_r"));
$("#monitorRestart").addEventListener("click", () => invoke("restart_workspace_r"));
$("#agentFileSurfaceClose").addEventListener("click", closeAgentWorkSurface);
$("#agentReviewSurfaceClose").addEventListener("click", closeAgentWorkSurface);
$("#agentOpenFileButton").addEventListener("click", () => {
  if (state.posture !== "agent") return;
  switchAgentSurface("direct");
  showAgentProjectFilePicker("open_file");
});

// ── Reproducibility Audit ──

const AUDIT_REQUEST_TIMEOUT_MS = 30_000;

function dirtyAuditSourcePaths() {
  return Object.values(state.documents)
    .filter((documentState) => /\.(?:r|rmd|qmd|rnw)$/i.test(documentState.path || "") && documentIsDirty(documentState))
    .map((documentState) => documentState.path)
    .sort((left, right) => left.localeCompare(right));
}

function invokeAuditWithTimeout() {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("Project reproducibility check timed out")),
      AUDIT_REQUEST_TIMEOUT_MS,
    );
  });
  return Promise.race([
    invoke("audit_reproducibility", { scope: "project_current" }),
    timeout,
  ]).finally(() => clearTimeout(timeoutId));
}

function openHumanProjectCheck() {
  applyWorkbenchLayout("analyze");
  $$('[data-context-tab]').forEach((button) => {
    button.classList.remove("active");
    button.setAttribute("aria-selected", "false");
  });
  $("#environmentPanel").classList.add("hidden");
  $("#auditPanel").classList.remove("hidden");
}

$("#auditProjectButton").addEventListener("click", async () => {
  syncDocumentFromEditor({ render: false, persist: false });
  const requestSequence = ++state.auditRequestSequence;
  const projectRoot = state.project.root;
  state.auditResult = null;
  state.auditBlockedFiles = dirtyAuditSourcePaths();
  state.auditLoading = state.auditBlockedFiles.length === 0;
  if (state.posture === "agent") openAgentWorkSurface("audit");
  else openHumanProjectCheck();
  renderAuditPanel();
  if (state.posture === "agent") renderAgentReviewWorkspace();
  if (state.auditBlockedFiles.length) return;
  try {
    const result = await invokeAuditWithTimeout();
    if (requestSequence !== state.auditRequestSequence || projectRoot !== state.project.root) return;
    state.auditResult = result;
  } catch (e) {
    if (requestSequence !== state.auditRequestSequence || projectRoot !== state.project.root) return;
    const uiMessage = reportUiFailure("check project reproducibility", e, "The project check did not finish. Try again.");
    state.auditResult = { status: "error", findings: [], coverage: {}, truncated: true, truncation_reasons: [String(e)], ui_message: uiMessage };
  } finally {
    if (requestSequence !== state.auditRequestSequence || projectRoot !== state.project.root) return;
    state.auditLoading = false;
    renderAuditPanel();
    if (state.posture === "agent") renderAgentReviewWorkspace();
  }
});

$("#auditCloseButton").addEventListener("click", () => {
  if (state.posture === "agent") closeAgentWorkSurface();
  else switchContextTab("environment");
});

async function lintCurrentFile() {
  const doc = activeDocument();
  if (!doc || !doc.path) return;
  syncDocumentFromEditor({ render: false, persist: false });
  if (documentIsDirty(doc)) {
    state.problems = state.problems.filter((problem) => problem.origin !== "lintr");
    state.lint = {
      status: "error",
      response: null,
      proposal: null,
      projectRoot: state.project.root,
      error: "Save the active file before checking code so diagnostics match the saved source.",
    };
    addProblem(state.lint.error, "", {
      origin: "lintr",
      runId: `lintr:unsaved:${doc.path}`,
      diagnosticId: `lintr:unsaved:${doc.path}`,
      sourcePath: doc.path,
      documentVersion: doc.versionId,
      severity: "error",
      rule: "saved_source_required",
      producer: "lintr",
      projectRoot: state.project.root,
    });
    toast("Save the active file before checking code so diagnostics match the saved source.", true);
    return;
  }
  const button = $("#editorCheckCodeButton");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  state.lint = { status: "running", response: null, proposal: null, projectRoot: state.project.root, error: null };
  renderProblems();
  try {
    const result = await invoke("editor_lint_file", { path: doc.path, documentVersion: doc.versionId ?? 0 });
    state.lint = {
      status: result.error ? (result.provider?.available ? "error" : "unavailable") : result.incomplete ? "incomplete" : "complete",
      response: result,
      proposal: null,
      projectRoot: state.project.root,
      error: result.error || null,
    };
    // Remove previous lint problems
    state.problems = state.problems.filter((p) => p.origin !== "lintr");
    const lints = result.diagnostics || [];
    for (const lint of lints) {
      addProblem(lint.message, lint.linter || "", {
        origin: "lintr",
        status: lint.severity === "error" ? "failed" : "completed",
        sourcePath: lint.source_path || doc.path,
        runId: lint.diagnostic_id,
        documentVersion: lint.document_version,
        diagnosticId: lint.diagnostic_id,
        lineNumber: lint.line_number,
        columnNumber: lint.column_number,
        endLineNumber: lint.end_line_number,
        endColumnNumber: lint.end_column_number,
        severity: lint.severity,
        rule: lint.rule,
        producer: lint.producer,
        producerVersion: lint.producer_version,
        scanScope: lint.scan_scope,
        quickFix: lint.quick_fix,
        projectRoot: state.project.root,
      });
    }
    if (result.error) {
      addProblem(result.error, "", {
        origin: "lintr",
        runId: `lintr:error:${doc.path}:${doc.versionId ?? 0}`,
        diagnosticId: `lintr:error:${doc.path}:${doc.versionId ?? 0}`,
        sourcePath: result.source_path || doc.path,
        documentVersion: result.document_version ?? doc.versionId,
        severity: "error",
        rule: result.notices?.includes("provider_unavailable") ? "provider_unavailable" : "provider_error",
        producer: result.provider?.name || "lintr",
        producerVersion: result.provider?.version || null,
        scanScope: result.scan_scope || "file",
        projectRoot: state.project.root,
      });
    }
    renderProblems();
  } catch (e) {
    state.problems = state.problems.filter((p) => p.origin !== "lintr");
    state.lint = { status: "error", response: null, proposal: null, projectRoot: state.project.root, error: String(e) };
    addProblem(state.lint.error, "", {
      origin: "lintr",
      runId: `lintr:exception:${doc.path}:${doc.versionId ?? 0}`,
      diagnosticId: `lintr:exception:${doc.path}:${doc.versionId ?? 0}`,
      sourcePath: doc.path,
      documentVersion: doc.versionId,
      severity: "error",
      rule: "provider_exception",
      producer: "lintr",
      projectRoot: state.project.root,
    });
    renderProblems();
  } finally {
    button.removeAttribute("aria-busy");
    updateEditorChrome();
  }
}

$("#editorCheckCodeButton").addEventListener("click", lintCurrentFile);
$("#clearLintResultsButton").addEventListener("click", clearLintResults);
$("#lintQuickFixApply").addEventListener("click", applyLintQuickFix);
$("#lintQuickFixCancel").addEventListener("click", closeLintQuickFix);
$("#lintQuickFixClose").addEventListener("click", closeLintQuickFix);
$("[data-refactor-close=\"true\"]").addEventListener("click", closeRefactorReview);
$("#refactorReviewClose").addEventListener("click", closeRefactorReview);
$("#refactorReviewCancel").addEventListener("click", closeRefactorReview);
$("#refactorReviewApply").addEventListener("click", applyRefactorProposal);
$("#refactorReviewUndo").addEventListener("click", undoRefactorProposal);
$$('[data-lint-fix-close="true"]').forEach((element) => element.addEventListener("click", closeLintQuickFix));

function renderAuditPanel() {
  if (state.auditLoading) {
    $("#auditStatus").textContent = auditStatusPresentation("running").label;
    $("#auditStatus").className = "audit-status-badge status-findings";
    $("#auditCoverage").textContent = "Reviewing the current project directory...";
    $("#auditFindings").innerHTML = '<div class="audit-empty" role="status">Checking project...</div>';
    $("#auditTruncated").classList.add("hidden");
    return;
  }
  if (state.auditBlockedFiles.length) {
    $("#auditStatus").textContent = auditStatusPresentation("incomplete").label;
    $("#auditStatus").className = "audit-status-badge status-incomplete";
    $("#auditStatus").dataset.status = "incomplete";
    $("#auditCoverage").textContent = "Unsaved source is not included in project checks.";
    const paths = state.auditBlockedFiles.map(displayPath).join(", ");
    const empty = document.createElement("div");
    empty.className = "audit-empty";
    empty.setAttribute("role", "status");
    empty.textContent = `Save the modified source ${state.auditBlockedFiles.length === 1 ? "file" : "files"} before checking: ${paths}. Then run Check project again.`;
    $("#auditFindings").replaceChildren(empty);
    $("#auditTruncated").classList.add("hidden");
    return;
  }
  const r = state.auditResult;
  if (!r) return;

  const statusColors = { complete: "complete", findings: "findings", incomplete: "incomplete", unavailable: "unavailable", error: "error" };
  $("#auditStatus").textContent = auditStatusPresentation(r.status).label;
  $("#auditStatus").className = "audit-status-badge status-" + (statusColors[r.status] || "findings");
  $("#auditStatus").dataset.status = r.status || "unknown";

  const cov = r.coverage || {};
  $("#auditCoverage").textContent = `${auditStatusPresentation(r.status).description} ${auditCoverageText(cov)}`;

  const findings = r.findings || [];
  const findingsContainer = $("#auditFindings");
  findingsContainer.replaceChildren();
  if (findings.length === 0) {
    const empty = document.createElement("div");
    empty.className = "audit-empty";
    empty.textContent = r.status === "error" ? (r.ui_message || "The project check did not complete.") : "No issues were found in the reviewed project information.";
    findingsContainer.append(empty);
  } else {
    appendAuditFindingGroups(findingsContainer, findings);
  }

  if (r.truncated) {
    $("#auditTruncated").classList.remove("hidden");
    $("#auditTruncated").textContent = "Some project information could not be reviewed. This check is incomplete.";
  } else {
    $("#auditTruncated").classList.add("hidden");
  }
}

function closeWorkbenchMenus(except = null) {
  $$('[data-menu-trigger]').forEach((trigger) => {
    const name = trigger.dataset.menuTrigger;
    const keepOpen = name === except;
    trigger.setAttribute("aria-expanded", String(keepOpen));
    $(`[data-menu="${name}"]`).hidden = !keepOpen;
  });
}

function syncFallbackEditorChange() {
  syncDocumentFromEditor({ render: true, persist: true });
  updateEditorChrome();
}

const FALLBACK_HISTORY_LIMIT = 100;
const FALLBACK_HISTORY_COALESCE_MS = 750;

function fallbackEditorHistoryKey(path = activeDocument()?.path) {
  return path ? `${state.project.root}\u0000${path}` : null;
}

function fallbackEditorSnapshot() {
  const editor = fallbackEditor();
  return {
    value: editor.value,
    start: editor.selectionStart,
    end: editor.selectionEnd,
  };
}

function ensureFallbackEditorHistory(documentState = activeDocument()) {
  if (!documentState) return null;
  const historyKey = fallbackEditorHistoryKey(documentState.path);
  const snapshot = fallbackEditorSnapshot();
  let history = state.editor.fallbackHistories.get(historyKey);
  if (!history || history.current.value !== snapshot.value) {
    history = {
      undo: [],
      redo: [],
      current: snapshot,
      lastInputType: null,
      lastInputAt: 0,
    };
    state.editor.fallbackHistories.set(historyKey, history);
  } else {
    history.current = snapshot;
  }
  return history;
}

function recordFallbackEditorChange(inputType = "programmatic", coalesce = false) {
  const documentState = activeDocument();
  if (!documentState) return;
  const historyKey = fallbackEditorHistoryKey(documentState.path);
  let history = state.editor.fallbackHistories.get(historyKey);
  if (!history) {
    history = {
      undo: [],
      redo: [],
      current: {
        value: documentState.content,
        start: documentState.cursorStart ?? 0,
        end: documentState.cursorEnd ?? documentState.cursorStart ?? 0,
      },
      lastInputType: null,
      lastInputAt: 0,
    };
    state.editor.fallbackHistories.set(historyKey, history);
  }
  const next = fallbackEditorSnapshot();
  if (next.value === history.current.value) {
    history.current = next;
    return;
  }
  const now = performance.now();
  const continueInput = coalesce
    && history.lastInputType === inputType
    && now - history.lastInputAt <= FALLBACK_HISTORY_COALESCE_MS;
  if (!continueInput) {
    history.undo.push(history.current);
    if (history.undo.length > FALLBACK_HISTORY_LIMIT) history.undo.shift();
  }
  history.current = next;
  history.redo = [];
  history.lastInputType = coalesce ? inputType : null;
  history.lastInputAt = coalesce ? now : 0;
}

function restoreFallbackEditorHistory(direction) {
  const history = ensureFallbackEditorHistory();
  if (!history) return;
  const source = direction === "undo" ? history.undo : history.redo;
  const destination = direction === "undo" ? history.redo : history.undo;
  const snapshot = source.pop();
  if (!snapshot) return;
  destination.push(history.current);
  if (destination.length > FALLBACK_HISTORY_LIMIT) destination.shift();
  history.current = snapshot;
  history.lastInputType = null;
  history.lastInputAt = 0;
  const editor = fallbackEditor();
  editor.value = snapshot.value;
  editor.setSelectionRange(snapshot.start, snapshot.end);
  syncFallbackEditorChange();
}

function toggleFallbackLineComment() {
  const editor = fallbackEditor();
  const value = editor.value;
  const selectionStart = editor.selectionStart;
  const selectionEnd = editor.selectionEnd;
  const blockStart = value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  let blockEnd = value.indexOf("\n", selectionEnd);
  if (blockEnd < 0) blockEnd = value.length;
  if (selectionEnd > selectionStart && value[selectionEnd - 1] === "\n") blockEnd = selectionEnd - 1;
  const lines = value.slice(blockStart, blockEnd).split("\n");
  const nonEmpty = lines.filter((line) => line.trim());
  const uncomment = nonEmpty.length > 0 && nonEmpty.every((line) => /^\s*#/.test(line));
  const replacement = lines.map((line) => {
    if (!line.trim()) return line;
    return uncomment ? line.replace(/^(\s*)# ?/, "$1") : line.replace(/^(\s*)/, "$1# ");
  }).join("\n");
  editor.setRangeText(replacement, blockStart, blockEnd, "select");
  recordFallbackEditorChange("toggle-line-comment");
  syncFallbackEditorChange();
}

async function findInFallbackEditor(replace = false) {
  const editor = fallbackEditor();
  const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  const query = await showInputDialog({
    title: replace ? "Replace in file" : "Find in file",
    message: "Search the active basic-editor document.",
    label: "Find",
    defaultValue: selected,
    validate: (value) => Boolean(value),
  });
  if (!query) {
    editor.focus();
    return;
  }
  let match = editor.value.indexOf(query, editor.selectionEnd);
  if (match < 0) match = editor.value.indexOf(query);
  if (match < 0) {
    toast(`No match found for ${query}.`, true);
    editor.focus();
    return;
  }
  editor.focus();
  editor.setSelectionRange(match, match + query.length);
  if (!replace) return;
  const replacement = await showInputDialog({
    title: "Replace in file",
    message: `Replace the selected match for ${query}.`,
    label: "Replace with",
    defaultValue: query,
  });
  if (replacement === null) {
    editor.focus();
    return;
  }
  editor.setRangeText(replacement, match, match + query.length, "select");
  recordFallbackEditorChange("replace");
  syncFallbackEditorChange();
  editor.focus();
}

function runEditorCommand(command) {
  if (!activeDocument()) return;
  if (state.editor.mode === "monaco" && state.editor.editor) {
    const monacoCommand = {
      undo: "undo",
      redo: "redo",
      find: "actions.find",
      replace: "editor.action.startFindReplaceAction",
      "select-all": "editor.action.selectAll",
      "toggle-line-comment": "editor.action.commentLine",
    }[command];
    if (monacoCommand) state.editor.editor.trigger("rho-workbench", monacoCommand, null);
    state.editor.editor.focus();
    return;
  }
  const editor = fallbackEditor();
  editor.focus();
  if (command === "undo" || command === "redo") {
    restoreFallbackEditorHistory(command);
  } else if (command === "find" || command === "replace") {
    findInFallbackEditor(command === "replace");
  } else if (command === "select-all") {
    editor.select();
  } else if (command === "toggle-line-comment") {
    toggleFallbackLineComment();
  }
}

function focusActiveEditor() {
  if (!activeDocument()) return;
  if (state.editor.mode === "monaco" && state.editor.editor) state.editor.editor.focus();
  else fallbackEditor().focus();
}

function resetWorkbenchPanelSizes() {
  setPanelSize("left", panelDefaults.left);
  setPanelSize("right", panelDefaults.right);
  setPanelSize("dock", panelDefaults.dock);
  const button = $("#toggleDockMaximize");
  button.dataset.expanded = "false";
  delete button.dataset.previousHeight;
  button.querySelector("use").setAttribute("href", "#icon-maximize-2");
  button.title = "Expand execution panel";
  button.setAttribute("aria-label", "Expand execution panel");
}

function updateWorkbenchMenuState() {
  const documentState = activeDocument();
  const hasDocument = Boolean(documentState);
  const projectReady = state.projectStatus === "ready";
  const setDisabled = (command, disabled) => {
    const item = $(`[data-menu-command="${command}"]`);
    if (item) item.disabled = Boolean(disabled);
  };
  setDisabled("new-file", !projectReady);
  setDisabled("save-file", !hasDocument || Boolean(documentState?.readOnly));
  setDisabled("close-file", !hasDocument);
  for (const command of ["undo", "redo", "find", "replace", "select-all", "toggle-line-comment"]) {
    setDisabled(command, !hasDocument);
  }
  setDisabled("format-document", $("#editorFormatButton").disabled);
  setDisabled("run-selection", $("#editorRunButton").disabled);
  setDisabled("run-file", $("#editorRunFileButton").disabled);
  setDisabled("render-document", $("#renderDocumentButton").disabled);
  const previewable = Boolean(documentState && /\.(md|html|csv|tsv)$/i.test(documentState.path));
  if (previewable) setDisabled("render-document", false);
  const renderMenu = $('[data-menu-command="render-document"]');
  if (renderMenu) renderMenu.textContent = previewable ? "Preview Active Document" : "Render Active Document";
  setDisabled("interrupt", $("#interruptButton").disabled);
  setDisabled("restart", $("#restartButton").disabled);
  setDisabled("focus-editor", !hasDocument);
  setDisabled("focus-console", !projectReady);
}

function runWorkbenchMenuCommand(command) {
  const actions = {
    "open-project": () => $("#projectSwitcher").click(),
    "new-file": () => $(".new-tab").click(),
    "save-file": () => saveActiveDocument(),
    "close-file": () => state.activeDocument && closeDocument(state.activeDocument),
    "format-document": () => $("#editorFormatButton").click(),
    undo: () => runEditorCommand("undo"),
    redo: () => runEditorCommand("redo"),
    find: () => runEditorCommand("find"),
    replace: () => runEditorCommand("replace"),
    "select-all": () => runEditorCommand("select-all"),
    "toggle-line-comment": () => runEditorCommand("toggle-line-comment"),
    "run-selection": () => $("#editorRunButton").click(),
    "run-file": () => $("#editorRunFileButton").click(),
    interrupt: () => $("#interruptButton").click(),
    restart: () => $("#restartButton").click(),
    "focus-editor": () => focusActiveEditor(),
    "focus-console": () => switchDockTab("console"),
    "show-logs": () => switchDockTab("logs"),
    "show-plots": () => switchDockTab("plots"),
    "show-problems": () => switchDockTab("problems"),
    "reset-panel-sizes": () => resetWorkbenchPanelSizes(),
    "check-updates": () => openUpdateDialog(),
    "about-rho": () => openAboutDialog(),
    "render-document": () => {
      const button = $("#renderDocumentButton");
      if (activeDocumentCanRender()) {
        if (button.disabled) toast($("#renderDocumentHint").textContent, true);
        else button.click();
      } else if (activeDocument() && /\.(md|html|csv|tsv)$/i.test(activeDocument().path)) {
        openViewerForActiveDocument();
      } else {
        toast($("#renderDocumentHint").textContent, true);
      }
    },
  };
  actions[command]?.();
}

function productDialogElements(kind) {
  const dialog = kind === "about" ? $("#aboutDialog") : $("#updateDialog");
  return { dialog, surface: dialog.querySelector(".product-dialog-surface") };
}

function openProductDialog(kind) {
  if (state.product.dialog && state.product.dialog !== kind) closeProductDialog(state.product.dialog, false);
  state.product.returnFocus = document.activeElement;
  state.product.dialog = kind;
  const { dialog, surface } = productDialogElements(kind);
  dialog.classList.remove("hidden");
  surface.focus();
}

function closeProductDialog(kind = state.product.dialog, restoreFocus = true) {
  if (!kind) return;
  productDialogElements(kind).dialog.classList.add("hidden");
  state.product.dialog = null;
  if (restoreFocus && state.product.returnFocus?.focus) state.product.returnFocus.focus();
}

function setDefinitionList(element, entries) {
  element.replaceChildren();
  for (const [term, description] of entries) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = description || "Unavailable";
    element.append(dt, dd);
  }
}

async function loadAppInfo() {
  if (!state.product.appInfo) state.product.appInfo = await invoke("app_info");
  return state.product.appInfo;
}

function appDiagnostics(info) {
  const runtime = info.runtime || {};
  const diagnosticRscript = String(runtime.rscript || "Not started")
    .replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/]+/i, "$1<user>");
  return [
    `Rho: ${info.version}`,
    `Channel: ${info.channel}`,
    `Build: ${info.commit || "unknown"}`,
    `Platform: ${info.platform}`,
    `R: ${runtime.r_version || "Not started"}`,
    `Rscript: ${diagnosticRscript}`,
    `Agent runtime: ${runtime.agent_available == null ? "Not started" : runtime.agent_available ? "available" : "unavailable"}`,
    `aisdk: ${runtime.aisdk_version || "Unavailable"}`,
  ].join("\n");
}

async function openAboutDialog() {
  openProductDialog("about");
  $("#aboutVersion").textContent = "Rho";
  $("#aboutChannel").textContent = "loading";
  setDefinitionList($("#aboutDetails"), [["Application", "Loading..."]]);
  try {
    const info = await loadAppInfo();
    const runtime = info.runtime || {};
    $("#aboutVersion").textContent = `Rho ${info.version}`;
    $("#aboutChannel").textContent = info.channel;
    setDefinitionList($("#aboutDetails"), [
      ["Platform", info.platform],
      ["R session", runtime.r_version || "Not started"],
      ["Assistant", runtime.agent_available == null ? "Not checked" : runtime.agent_available ? "Available" : "Unavailable"],
    ]);
  } catch (error) {
    console.error("[load About information]", error);
    setDefinitionList($("#aboutDetails"), [["Application information", "Could not be loaded. Copy diagnostics for support."]]);
  }
}

function updateFailureMessage(error) {
  const message = String(error);
  if (message.includes("UPDATE_PLATFORM_UNAVAILABLE")) return "This release does not include an installer for this Mac yet.";
  if (message.includes("UPDATE_HTTP")) return "The update service returned an unexpected response.";
  if (message.includes("UPDATE_INVALID")) return "The update service returned invalid release information.";
  return "Rho could not reach the update service. Check your connection or proxy and try again.";
}

function renderUpdateResult(result) {
  state.product.updateResult = result;
  const available = result.status === "update_available";
  const current = result.status === "up_to_date";
  const title = available ? `Rho ${result.available_version} is available` : current ? "Rho is up to date" : "This build is newer than the update feed";
  $("#updateStatusIcon").className = "update-status-icon";
  $("#updateStatusIcon").textContent = available ? "!" : "OK";
  $("#updateStatusTitle").textContent = title;
  $("#updateStatusMessage").textContent = available
    ? result.summary
    : current
      ? `Rho ${result.installed_version} is current for the ${result.channel} channel.`
      : `Rho ${result.installed_version} is newer than ${result.available_version}, the latest version in the ${result.channel} feed.`;
  $("#updateVersions").textContent = `Installed ${result.installed_version} · Published ${result.available_version} · ${new Date(result.published_at).toLocaleDateString()}`;
  $("#updateVersions").classList.remove("hidden");
  $("#updateRetry").classList.add("hidden");
  $("#updateView").classList.toggle("hidden", !available);
  $("#updateDone").disabled = false;
}

function renderUpdateFailure(error) {
  state.product.updateResult = null;
  $("#updateStatusIcon").className = "update-status-icon error";
  $("#updateStatusIcon").textContent = "!";
  $("#updateStatusTitle").textContent = "Could not check for updates";
  $("#updateStatusMessage").textContent = updateFailureMessage(error);
  $("#updateVersions").classList.add("hidden");
  $("#updateRetry").classList.remove("hidden");
  $("#updateView").classList.add("hidden");
  $("#updateDone").disabled = false;
}

async function checkForUpdates({ background = false } = {}) {
  if (state.product.updateBusy) return;
  state.product.updateBusy = true;
  if (!background) {
    openProductDialog("update");
    $("#updateStatusIcon").className = "update-status-icon";
    $("#updateStatusIcon").textContent = "...";
    $("#updateStatusTitle").textContent = "Checking for updates...";
    $("#updateStatusMessage").textContent = "Contacting the Rho update service.";
    $("#updateVersions").classList.add("hidden");
    $("#updateRetry").classList.add("hidden");
    $("#updateView").classList.add("hidden");
    $("#updateDone").disabled = true;
  }
  localStorage.setItem("rho.update.lastCheck", String(Date.now()));
  try {
    const result = await invoke("check_for_updates");
    if (!background) renderUpdateResult(result);
    if (background && result.status === "update_available" && localStorage.getItem("rho.update.dismissed") !== result.available_version) {
      actionToast(`Rho ${result.available_version} is available.`, "View Update", async () => {
        await invoke("open_rho_website", { url: result.release_page_url });
      }, () => localStorage.setItem("rho.update.dismissed", result.available_version));
    }
  } catch (error) {
    if (!background) renderUpdateFailure(error);
  } finally {
    state.product.updateBusy = false;
  }
}

function openUpdateDialog() {
  checkForUpdates();
}

function maybeCheckForUpdates() {
  const lastCheck = Number(localStorage.getItem("rho.update.lastCheck")) || 0;
  if (Date.now() - lastCheck >= 24 * 60 * 60 * 1000) setTimeout(() => checkForUpdates({ background: true }), 1500);
}

const panelDefaults = {
  left: 214,
  right: 362,
  dock: 260,
};

function agentComposerLimits() {
  const height = $("#agentPanel").getBoundingClientRect().height;
  return [118, Math.max(118, height > 0 ? height - 180 : 480)];
}

function setAgentComposerHeight(requested, persist = true) {
  const limits = agentComposerLimits();
  const value = Math.round(clamp(Number(requested) || 154, limits[0], limits[1]));
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
    startingHeight = Number(handle.getAttribute("aria-valuenow")) || 154;
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
  handle.addEventListener("dblclick", () => setAgentComposerHeight(154));
  handle.addEventListener("keydown", (event) => {
    const amount = event.shiftKey ? 40 : 12;
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const current = Number(handle.getAttribute("aria-valuenow")) || 154;
    setAgentComposerHeight(current + (event.key === "ArrowUp" ? amount : -amount));
  });
  const stored = Number(localStorage.getItem("rho.agentComposerHeight"));
  $("#agentPanel").style.setProperty("--agent-composer-height", `${Number.isFinite(stored) && stored > 0 ? stored : 154}px`);
  handle.setAttribute("aria-valuenow", String(Number.isFinite(stored) && stored > 0 ? stored : 154));
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
  const currentLimits = panelLimits();
  for (const currentPanel of ["left", "right", "dock"]) {
    const currentHandle = currentPanel === "left"
      ? $("#leftResizeHandle")
      : currentPanel === "right"
        ? $("#rightResizeHandle")
        : $("#dockResizeHandle");
    currentHandle.setAttribute("aria-valuemin", String(Math.round(currentLimits[currentPanel][0])));
    currentHandle.setAttribute("aria-valuemax", String(Math.round(currentLimits[currentPanel][1])));
  }
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
  const icon = button.querySelector("use");
  const expanded = button.dataset.expanded === "true";
  if (expanded) {
    const previous = Number(button.dataset.previousHeight) || panelDefaults.dock;
    setPanelSize("dock", previous);
    button.dataset.expanded = "false";
    icon.setAttribute("href", "#icon-maximize-2");
    button.title = "Expand execution panel";
    button.setAttribute("aria-label", "Expand execution panel");
    return;
  }
  button.dataset.previousHeight = $("#dockResizeHandle").getAttribute("aria-valuenow");
  setPanelSize("dock", panelLimits().dock[1]);
  button.dataset.expanded = "true";
  icon.setAttribute("href", "#icon-minimize-2");
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

function actionToast(message, label, action, dismiss = null) {
  const element = document.createElement("div");
  element.className = "toast";
  const text = document.createElement("div");
  text.textContent = message;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "toast-action";
  button.textContent = label;
  button.addEventListener("click", async () => {
    try { await action(); } catch (error) { toast(reportUiFailure("complete requested action", error, "The requested action could not be completed. Refresh the view and try again."), true); }
    element.remove();
  });
  element.append(text, button);
  if (dismiss) {
    const dismissButton = document.createElement("button");
    dismissButton.type = "button";
    dismissButton.className = "toast-action secondary";
    dismissButton.textContent = "Dismiss";
    dismissButton.addEventListener("click", () => {
      dismiss();
      element.remove();
    });
    element.append(dismissButton);
  }
  $("#toastRegion").append(element);
  setTimeout(() => element.remove(), 12000);
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
    if (changedPaths.length) {
      await loadGitStatus();
      if (!$("#gitPanel").classList.contains("hidden")) await loadGitReview();
    }
  });
}

function workbenchMenuItems(name) {
  return $$(`[data-menu="${name}"] [role="menuitem"]`).filter((item) => !item.disabled);
}

function focusWorkbenchMenuEdge(name, edge = "first") {
  const items = workbenchMenuItems(name);
  const item = edge === "last" ? items.at(-1) : items[0];
  if (item) requestAnimationFrame(() => item.focus());
}

function moveWorkbenchMenuFocus(item, delta) {
  const name = item.closest("[data-menu]")?.dataset.menu;
  const items = workbenchMenuItems(name);
  const current = items.indexOf(item);
  if (current < 0 || !items.length) return;
  items[(current + delta + items.length) % items.length].focus();
}

function switchWorkbenchMenu(item, delta) {
  const triggers = $$('[data-menu-trigger]');
  const currentName = item.closest("[data-menu]")?.dataset.menu;
  const current = triggers.findIndex((trigger) => trigger.dataset.menuTrigger === currentName);
  if (current < 0 || !triggers.length) return;
  const trigger = triggers[(current + delta + triggers.length) % triggers.length];
  updateWorkbenchMenuState();
  closeWorkbenchMenus(trigger.dataset.menuTrigger);
  focusWorkbenchMenuEdge(trigger.dataset.menuTrigger);
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
    const reload = await confirmAction({
      title: "File changed on disk",
      message: `${path} changed on disk while you have unsaved edits.`,
      confirmLabel: "Reload disk version",
      cancelLabel: "Keep local draft",
    });
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
    toast(reportUiFailure("reload changed file", error, `The changed file ${path} could not be reloaded. Your editor content is preserved.`), true);
  }
}

async function hydrateProject(response) {
  state.projectRefreshSequence += 1;
  state.objects = [];
  state.environment = null;
  clearEnvironmentObjectSelection();
  clearAgentLlmCredentialInput();
  state.agentLlm.operation = { state: "idle", message: "" };
  state.agentLlm.wizardOperation = { state: "idle", message: "" };
  state.agentLlm.modelOperation = { state: "idle", message: "" };
  closeAgentContextMenu();
  hideAgentFileMentions();
  clearAgentEditHighlight();
  resetAgentContext();
  resetAgentLocalHelpContext();
  $("#refactorReviewDialog").classList.add("hidden");
  state.refactor = { status: "idle", proposal: null, undo: null, error: null, returnFocus: null };
  state.localHelp = { status: "empty", record: null, error: null };
  state.installedHelp = { status: "empty", record: null, error: null, activeView: "overview", running: false };
  state.fileEditProposal = null;
  state.fileEditUndo = null;
  state.fileEditUndoVerifiedKey = null;
  state.agentConversations = [];
  state.agentTurns = [];
  state.pendingApprovals = [];
  state.selectedConversationId = null;
  state.selectedTurnId = null;
  state.selectedTurnDetail = null;
  state.agentActivityExpanded.clear();
  state.actAuthorizedTurnIds.clear();
  state.fileEditAutoApplyAttempts.clear();
  state.fileEditApplyBusy = false;
  state.agentWorkSurface = "none";
  state.auditResult = null;
  state.auditLoading = false;
  state.auditBlockedFiles = [];
  state.auditRequestSequence += 1;
  state.activeRunId = null;
  state.agentReviewRunId = null;
  state.agentReviewRunDetail = null;
  state.agentReviewRunLoading = false;
  state.agentReviewRunError = null;
  state.selectedArtifactId = null;
  state.selectedArtifactDetail = null;
  state.selectedPlotId = null;
  state.viewer = { ...state.viewer, open: false, busy: false, path: null, content: "", sourceContent: "", error: null, notice: null };
  $("#artifactPanel").open = false;
  state.documents = {};
  state.closedDrafts = {};
  state.expandedDirectories.clear();
  state.collapsedDirectories.clear();
  state.activeDocument = null;
  state.runs = [];
  state.problems = [];
  state.plots = [];
  state.artifacts = [];
  state.selectedPlotId = null;
  state.selectedArtifactId = null;
  renderRuns();
  renderProblems();
  renderPlots();
  renderAgentOutputs();
  state.editor.models.forEach((model) => model.dispose());
  state.editor.models.clear();
  state.project = response.project || { root: "", files: [], truncated: false };
  state.gitStatus = null;
  resetGitReview(state.project.root);
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
  state.humanPreset = normalizeHumanPreset(session.human_preset);
  if (session.posture) {
    state.posture = session.posture;
    state.agentSurface = state.posture === "agent" ? "direct" : (session.agent_surface || "direct");
  }
  setProjectStatus("ready");
  void loadProjectSkills();
  const sessionDocuments = session.open_documents || [];
  const activeDocumentPath = session.active_document;
  const target = activeDocumentPath && state.project.files.some((file) => file.path === activeDocumentPath)
    ? activeDocumentPath
    : sessionDocuments[0]?.path || state.project.files[0]?.path || null;
  if (target) {
    await openDocument(target, {
      sessionEntry: sessionDocuments.find((entry) => entry.path === target) || null,
      revealWorkSurface: false,
    });
  } else {
    renderActiveDocument();
  }
  applyPostureLayout();
  const deferredDocuments = sessionDocuments.filter((entry) => entry.path !== target);
  if (deferredDocuments.length) {
    const restoreSequence = state.projectRefreshSequence;
    void (async () => {
      for (const entry of deferredDocuments) {
        if (restoreSequence !== state.projectRefreshSequence) return;
        await openDocument(entry.path, { sessionEntry: entry, revealWorkSurface: false, preserveActive: true });
      }
      if (restoreSequence === state.projectRefreshSequence && target && state.documents[target]) {
        await openDocument(target, { revealWorkSurface: false });
      }
    })();
  }
}

function setStartupBusy(busy) {
  state.startupBusy = busy;
  $$("#startupActions button").forEach((button) => { button.disabled = busy; });
}

function showStartupProgress(title, message) {
  $("#startupProgress").classList.remove("hidden");
  $("#startupIssue").classList.add("hidden");
  $("#startupActions").classList.add("hidden");
  $("#startupTitle").textContent = title;
  $("#startupMessage").textContent = message;
}

function renderStartupIssue(issue) {
  const fallback = {
    title: "Rho could not start",
    message: "Retry startup or open the diagnostic log for more information.",
    actions: ["retry", "copy_diagnostics", "open_log", "exit"],
  };
  const value = { ...fallback, ...(issue || {}) };
  const actions = new Set(value.actions || fallback.actions);
  state.startupView = { ...(state.startupView || {}), issue: value };
  $("#startupProgress").classList.add("hidden");
  $("#startupIssue").classList.remove("hidden");
  $("#startupIssueTitle").textContent = value.title;
  $("#startupIssueMessage").textContent = value.message;
  $("#startupActions").classList.remove("hidden");
  $("#startupRetry").classList.toggle("hidden", !actions.has("retry"));
  $("#startupChooseR").classList.toggle("hidden", !actions.has("choose_rscript"));
  $("#startupCopyDiagnostics").classList.toggle("hidden", !actions.has("copy_diagnostics"));
  $("#startupOpenLog").classList.toggle("hidden", !actions.has("open_log"));
  $("#startupExit").classList.toggle("hidden", !actions.has("exit"));
  setStartupBusy(false);
}

function revealWorkbench() {
  $("#startupGate").classList.add("hidden");
  $("#appShell").classList.remove("hidden");
  $("#appShell").setAttribute("aria-hidden", "false");
}

async function finishWorkbenchStartup(startupView) {
  showStartupProgress("Starting the R session", "Opening R for this project...");
  try {
    if (!state.startupPrepared) {
      initializePanelLayout();
      await initializeEditor();
      await listenForProjectChanges();
      state.startupPrepared = true;
    }
    revealWorkbench();
    setKernelStatus("starting", "Starting R");
    const status = await invoke("workspace_start");
    state.agentRuntime = status.agent_runtime || startupView?.runtime?.agent_runtime || null;
    updateIdentity(status.workspace);
    $("#rVersion").textContent = status.r_version || "R";
    setKernelStatus("idle", "R idle");
    addLog("SYSTEM", `${status.r_version} · R session ready`);
    void invoke("agent_runtime_retry")
      .then((runtime) => {
        state.agentRuntime = runtime;
        updateAgentHeader();
        renderAgentTimeline();
        addLog("SYSTEM", "Agent runtime check completed");
      })
      .catch((error) => addLog("SYSTEM", `Agent runtime check failed: ${String(error)}`, "warning"));
    maybeCheckForUpdates();
    const agentSettings = loadAgentLlmSettings();
    const response = await invoke("project_restore_session");
    await agentSettings;
    if (response.status === "ready") {
      await hydrateProject(response);
    } else if (response.status === "blocked") {
      toast(userFacingError(response.blocker?.message, "The saved project could not be restored. Choose another project to continue."), true);
    } else if (response.status === "failed_restored" || response.status === "fatal") {
      toast(userFacingError(response.message, "The saved project could not be restored. Choose another project to continue."), true);
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
    await Promise.all([
      loadRunData(),
      loadEnvironmentOperationData(),
      loadAgentData(),
      refreshEnvironment(),
    ]);
    await maybeApplyPreviewScenario();
    if (isDesktop && tauriEvent?.listen) {
      tauriEvent.listen("rho://agent-turn-updated", async () => {
        await Promise.all([loadAgentData(), loadRunData(), loadEnvironmentOperationData(), refreshEnvironment()]);
      }).catch(() => {});
    }
  } catch (error) {
    if ($("#startupGate").classList.contains("hidden")) {
      setKernelStatus("error", "R unavailable");
      addLog("SYSTEM", String(error), "error");
      addProblem(userFacingError(error, "The project session stopped unexpectedly. Restart R to continue."));
      toast(reportUiFailure("finish workbench startup", error, "The project session stopped unexpectedly. Restart R to continue."), true);
      return;
    }
    renderStartupIssue({
      code: "ARK_START_FAILED",
      title: "The R session could not start",
      message: "R is available, but the project session did not open. Retry or copy diagnostics.",
      actions: ["retry", "copy_diagnostics", "open_log", "exit"],
    });
  }
}

async function runStartup(command = "startup_bootstrap") {
  if (state.startupBusy) return;
  setStartupBusy(true);
  showStartupProgress(
    "Preparing Rho",
    command === "startup_choose_rscript" ? "Checking the selected R installation..." : "Checking the local R environment...",
  );
  try {
    const view = await invoke(command);
    state.startupView = view;
    if (view?.phase === "runtime_ready" && !view.issue) {
      await finishWorkbenchStartup(view);
      return;
    }
    renderStartupIssue(view?.issue);
  } catch (error) {
    renderStartupIssue({
      title: "Rho could not check its runtime",
      message: "Retry startup or copy diagnostics for support.",
      actions: ["retry", "choose_rscript", "copy_diagnostics", "open_log", "exit"],
    });
  } finally {
    setStartupBusy(false);
  }
}

async function initialize() {
  await runStartup();
}

$("#startupRetry").addEventListener("click", () => runStartup("startup_bootstrap"));
$("#startupChooseR").addEventListener("click", () => runStartup("startup_choose_rscript"));
$("#startupCopyDiagnostics").addEventListener("click", async () => {
  try {
    await copyText(await invoke("startup_diagnostics"));
    $("#startupCopyDiagnostics").textContent = "Copied";
    setTimeout(() => { $("#startupCopyDiagnostics").textContent = "Copy diagnostics"; }, 1600);
  } catch (error) {
    console.error("[copy startup diagnostics]", error);
    renderStartupIssue({ ...state.startupView?.issue, message: "Diagnostics could not be copied. Open the log folder or retry startup." });
  }
});
$("#startupOpenLog").addEventListener("click", async () => {
  try { await invoke("startup_open_log_directory"); }
  catch (error) {
    console.error("[open startup log folder]", error);
    renderStartupIssue({ ...state.startupView?.issue, message: "The log folder could not be opened. Copy diagnostics or retry startup." });
  }
});
$("#startupExit").addEventListener("click", () => window.close());

$("#runButton").addEventListener("click", runSelectionOrCurrentLine);
$("#editorRunButton").addEventListener("click", runSelectionOrCurrentLine);
$("#editorRunFileButton").addEventListener("click", runActiveFile);
$("#editorRenameButton").addEventListener("click", () => requestRenameSymbol({ returnFocus: $("#editorRenameButton") }));
$("#editorExtractButton").addEventListener("click", () => requestExtractFunction({ returnFocus: $("#editorExtractButton") }));
$("#editorFormatButton").addEventListener("click", () => requestFormatDocument({ returnFocus: $("#editorFormatButton") }));
$("#saveFileButton").addEventListener("click", saveActiveDocument);
$(".new-tab").addEventListener("click", createDocument);
$("#projectSwitcher").addEventListener("click", async () => {
  try {
    await flushSessionSnapshot();
    const response = await invoke("project_pick_directory");
    if (response.status === "cancelled") return;
    if (response.status === "blocked") {
      toast(userFacingError(response.blocker?.message, "This project cannot be opened. The current project remains active."), true);
      return;
    }
    if (response.status === "failed_restored" || response.status === "fatal") {
      toast(userFacingError(response.message, "The project could not be switched. The current project remains active."), true);
      return;
    }
    if (response.status === "unavailable") {
      setProjectStatus("unavailable", response.unavailable || null);
      renderActiveDocument();
      return;
    }
    await hydrateProject(response);
    void Promise.all([
      loadAgentData({ quiet: true }),
      loadRunData({ quiet: true }),
      refreshEnvironment({ quiet: true }),
    ]);
  } catch (error) {
    toast(reportUiFailure("switch project", error, "The project could not be switched. The current project remains active."), true);
  }
});
$("#projectBannerAction").addEventListener("click", () => $("#projectSwitcher").click());
$("#consoleTerminal").addEventListener("click", (event) => {
  if (event.target === $("#consoleTerminal") || event.target === $("#consoleOutput")) {
    $("#consoleInput").focus();
  }
});
$("#consoleRunButton").addEventListener("click", () => {
  const value = $("#consoleInput").value;
  rememberConsoleCommand(value);
  $("#consoleInput").value = "";
  executeCode({ code: value, type: "console", sourcePath: "<console>", documentVersion: null, range: null });
});
$("#consoleInput").addEventListener("input", (event) => {
  state.consoleHistoryIndex = -1;
  state.consoleDraft = event.target.value;
});
$("#consoleInput").addEventListener("keydown", (event) => {
  if (event.key === "ArrowUp") {
    event.preventDefault();
    browseConsoleHistory(-1);
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    browseConsoleHistory(1);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    $("#consoleRunButton").click();
  }
});
$("#editor").addEventListener("input", (event) => {
  clearAgentEditHighlight();
  recordFallbackEditorChange(event.inputType || "input", true);
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
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === "Enter") {
    event.preventDefault();
    runActiveFile();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    runSelectionOrCurrentLine();
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    const editor = event.currentTarget;
    const start = editor.selectionStart;
    editor.setRangeText("  ", start, editor.selectionEnd, "end");
    recordFallbackEditorChange("insert-tab");
    updateEditorChrome();
    syncDocumentFromEditor({ render: true, persist: true });
  }
});

$$("[data-dock-tab]").forEach((button) => button.addEventListener("click", () => switchDockTab(button.dataset.dockTab)));
$$("[data-context-tab]").forEach((button) => button.addEventListener("click", () => {
  const name = button.dataset.contextTab;
  applyWorkbenchLayout(name === "agent" ? "agent" : "analyze");
  if (name !== "agent") switchContextTab(name);
}));
$("#gitBranch").addEventListener("click", () => {
  applyWorkbenchLayout("analyze");
  switchContextTab("git");
});
$("#gitRefreshButton").addEventListener("click", async () => {
  await loadGitStatus();
  await loadGitReview();
});
$("#gitCommitForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("#gitCommitMessage").value.trim();
  if (!message) {
    toast("Enter a commit message for the staged changes.", true);
    $("#gitCommitMessage").focus();
    return;
  }
  await runGitMutation(
    "git_commit",
    { message, expectedStagedRevision: state.gitReview.stagedRevision },
    "Committed reviewed changes",
  );
  $("#gitCommitMessage").value = "";
});
$$("[data-side-tab]").forEach((button) => button.addEventListener("click", () => {
  $$("[data-side-tab]").forEach((value) => {
    const selected = value === button;
    value.classList.toggle("active", selected);
    value.setAttribute("aria-selected", String(selected));
  });
  $("#filesPanel").classList.toggle("hidden", button.dataset.sideTab !== "files");
  $("#runsPanel").classList.toggle("hidden", button.dataset.sideTab !== "runs");
}));
$$("[data-agent-mode]").forEach((button) => button.addEventListener("click", () => {
  state.agentMode = button.dataset.agentMode;
  syncAgentComposerState();
  $("#agentModeControl").removeAttribute("open");
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
$("#agentLlmRetrySettings").addEventListener("click", () => void retryAgentLlmSettings());
$("#agentLlmDialog").addEventListener("click", (event) => {
  if (event.target?.dataset?.agentLlmClose === "true") closeAgentLlmDialog();
});
$("#agentLlmDialog").addEventListener("keydown", (event) => {
  if (state.agentLlm.wizardOpen || state.agentLlm.modelDialogOpen) return;
  trapAgentLlmDialogFocus(event, $("#agentLlmDialog"), closeAgentLlmDialog);
});
$("#environmentOperationClose").addEventListener("click", closeEnvironmentOperationDialog);
$("#environmentOperationDialog").addEventListener("click", (event) => {
  if (event.target?.dataset?.environmentOperationClose === "true") closeEnvironmentOperationDialog();
});
$("#aboutClose").addEventListener("click", () => closeProductDialog("about"));
$("#updateClose").addEventListener("click", () => closeProductDialog("update"));
$("#updateDone").addEventListener("click", () => closeProductDialog("update"));
$$('[data-product-dialog-close]').forEach((scrim) => scrim.addEventListener("click", () => closeProductDialog(scrim.dataset.productDialogClose)));
$("#aboutCopyDiagnostics").addEventListener("click", async () => {
  try {
    await copyText(appDiagnostics(await loadAppInfo()));
    toast("Copied Rho diagnostics.");
  } catch (error) {
    toast(reportUiFailure("copy diagnostics", error, "Diagnostics could not be copied. Open the log folder instead."), true);
  }
});
$("#aboutWebsite").addEventListener("click", async () => invoke("open_rho_website", { url: (await loadAppInfo()).website_url }));
$("#aboutSource").addEventListener("click", async () => invoke("open_rho_website", { url: (await loadAppInfo()).source_url }));
$("#updateRetry").addEventListener("click", () => checkForUpdates());
$("#updateView").addEventListener("click", async () => {
  const result = state.product.updateResult;
  if (!result) return;
  localStorage.setItem("rho.update.dismissed", result.available_version);
  await invoke("open_rho_website", { url: result.release_page_url });
});
$("#agentLlmAddProvider").addEventListener("click", openAgentLlmProviderWizard);
$$('[data-agent-llm-view]').forEach((tab) => {
  tab.addEventListener("click", () => switchAgentLlmView(tab.dataset.agentLlmView, { focus: true }));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = Array.from($$('[data-agent-llm-view]'));
    const current = tabs.indexOf(event.currentTarget);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? tabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    switchAgentLlmView(tabs[next].dataset.agentLlmView, { focus: true });
  });
});
$("#agentLlmCustomRouteType").addEventListener("change", () => renderAgentLlmCustomRouteModels());
$("#agentLlmCustomRouteRequired").addEventListener("input", () => renderAgentLlmCustomRouteModels());
$("#agentLlmSaveCustomRoute").addEventListener("click", saveAgentLlmCustomRoute);
$("#agentLlmLibraryAddModel").addEventListener("click", () => {
  if (state.agentLlm.settings?.providers?.length) openAgentLlmModelDialog(null);
  else openAgentLlmProviderWizard();
});
$("#agentLlmLibraryEditModel").addEventListener("click", () => openAgentLlmModelDialog(state.agentLlm.selectedModelEditorId));
$("#agentLlmLibraryTestModel").addEventListener("click", testAgentModelConnection);
$("#agentLlmSaveProvider").addEventListener("click", saveAgentProvider);
$("#agentLlmDeleteProvider").addEventListener("click", deleteAgentProvider);
$("#agentLlmAddModel").addEventListener("click", () => openAgentLlmModelDialog(null));
$("#agentLlmEditModel").addEventListener("click", () => openAgentLlmModelDialog(state.agentLlm.selectedModelEditorId));
$("#agentLlmRefreshModels").addEventListener("click", () => {
  void discoverAgentLlmModels($("#agentLlmModelProvider").value, "model");
});
$("#agentLlmModelDiscoveredModel").addEventListener("change", () => applyAgentLlmDiscoveredModel("model"));
$("#agentLlmModelProvider").addEventListener("change", () => {
  clearAgentLlmCredentialInput();
  const providerId = $("#agentLlmModelProvider").value;
  if (!state.agentLlm.editingModelId) {
    $("#agentLlmModelDisplayName").value = "";
    $("#agentLlmModelId").value = "";
    $("#agentLlmModelType").value = "language";
    $("#agentLlmModelToolCalling").value = "unknown";
    $("#agentLlmModelReasoning").value = "unknown";
    $("#agentLlmModelVisionInput").value = "unknown";
    for (const selector of [
      "#agentLlmModelImageOutput", "#agentLlmModelImageEdit", "#agentLlmModelAudioInput",
      "#agentLlmModelAudioOutput", "#agentLlmModelStructuredOutput", "#agentLlmModelWebSearch",
    ]) $(selector).value = "unknown";
    $("#agentLlmModelManualFields").open = false;
  }
  resetAgentLlmDiscovery("model", providerId);
  void discoverAgentLlmModels(providerId, "model");
});
$("#agentLlmModelId").addEventListener("input", () => {
  $("#agentLlmModelDiscoveredModel").value = "";
});
$("#agentLlmSaveModel").addEventListener("click", saveAgentModel);
$("#agentLlmDeleteModel").addEventListener("click", deleteAgentModel);
$("#agentLlmModelClose").addEventListener("click", closeAgentLlmModelDialog);
$("#agentLlmModelCancel").addEventListener("click", closeAgentLlmModelDialog);
$("#agentLlmModelDialog").addEventListener("click", (event) => {
  if (event.target?.dataset?.agentLlmModelClose === "true") closeAgentLlmModelDialog();
});
$("#agentLlmModelDialog").addEventListener("keydown", (event) => {
  trapAgentLlmDialogFocus(event, $("#agentLlmModelDialog"), closeAgentLlmModelDialog);
});
$("#agentLlmTestModel").addEventListener("click", testAgentModelConnection);
$("#agentLlmCancelTest").addEventListener("click", cancelAgentModelTest);
$("#agentLlmSelectDefault").addEventListener("click", selectAgentDefaultModel);
$("#agentLlmSaveCredential").addEventListener("click", saveAgentLlmCredential);
$("#agentLlmDeleteCredential").addEventListener("click", deleteAgentLlmCredential);
$("#agentLlmProviderWizard").addEventListener("click", (event) => {
  if (event.target?.dataset?.agentLlmWizardClose === "true") {
    closeAgentLlmProviderWizard();
    return;
  }
  const button = event.target.closest?.("button");
  if (!button || !$("#agentLlmProviderWizard").contains(button)) return;
  if (button.dataset.providerPreset) {
    clearAgentLlmCredentialInput();
    $("#agentLlmWizardProviderKind").value = button.dataset.providerPreset;
    $("#agentLlmWizardBaseUrl").value = "";
    syncAgentLlmWizardProviderFields({ resetName: true });
    $("#agentLlmWizardProviderGrid [aria-checked=\"true\"]")?.focus();
  } else if (["agentLlmWizardClose", "agentLlmWizardCancel"].includes(button.id)) closeAgentLlmProviderWizard();
  else if (button.id === "agentLlmWizardContinue") void advanceAgentLlmProviderWizard();
  else if (button.id === "agentLlmWizardBack") {
    state.agentLlm.wizardStep = "connection";
    resetAgentLlmDiscovery("wizard", null);
    setAgentLlmOperationState("idle", "", "wizard");
    renderAgentLlmWizardStep();
    $("#agentLlmWizardProviderName").focus();
  } else if (button.id === "agentLlmWizardRefreshModels") {
    void discoverAgentLlmModels(state.agentLlm.wizardProviderId, "wizard");
  } else if (button.id === "agentLlmWizardFinish") void finishAgentLlmProviderWizard();
  else if (button.id === "agentLlmWizardFinishLater") finishAgentLlmProviderWizardLater();
});
$("#agentLlmProviderWizard").addEventListener("change", (event) => {
  if (event.target.id === "agentLlmWizardProviderKind") {
    clearAgentLlmCredentialInput();
    syncAgentLlmWizardProviderFields({ resetName: true });
  } else if (event.target.id === "agentLlmWizardApiKeyRequired") {
    clearAgentLlmCredentialInput();
    syncAgentLlmWizardProviderFields();
  } else if (event.target.id === "agentLlmWizardDiscoveredModel") {
    applyAgentLlmDiscoveredModel("wizard");
  }
});
$("#agentLlmProviderWizard").addEventListener("input", (event) => {
  if (event.target.id === "agentLlmWizardModelId") $("#agentLlmWizardDiscoveredModel").value = "";
});
$("#agentLlmProviderWizard").addEventListener("keydown", (event) => {
  const preset = event.target.closest?.("[data-provider-preset]");
  if (preset && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const choices = Array.from($("#agentLlmWizardProviderGrid").querySelectorAll("[data-provider-preset]"));
    const current = choices.indexOf(preset);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? choices.length - 1
        : (current + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + choices.length) % choices.length;
    choices[next]?.click();
    return;
  }
  trapAgentLlmDialogFocus(event, $("#agentLlmProviderWizard"), closeAgentLlmProviderWizard);
});
$("#agentLlmProviderKind").addEventListener("change", () => {
  clearAgentLlmCredentialInput();
  const local = $("#agentLlmProviderKind").value === "local_openai_compatible";
  $("#agentLlmProviderApiKeyRequired").checked = !local;
  renderAgentCredentialFields();
});
$("#agentLlmProviderApiKeyRequired").addEventListener("change", () => {
  clearAgentLlmCredentialInput();
  renderAgentCredentialFields();
});
$$("[data-layout]").forEach((button) => button.addEventListener("click", () => {
  applyWorkbenchLayout(button.dataset.layout);
  scheduleSessionSave();
}));

$("#agentSendButton").addEventListener("click", sendAgentPrompt);
$("#agentRuntimeRetryButton").addEventListener("click", async () => {
  const button = $("#agentRuntimeRetryButton");
  button.disabled = true;
  try {
    state.agentRuntime = await invoke("agent_runtime_retry");
    updateAgentHeader();
    renderAgentTimeline();
    toast(
      state.agentRuntime.available
        ? "Agent runtime is ready."
        : userFacingError(state.agentRuntime.error, "The assistant connection is still unavailable. Review model settings and try again."),
      !state.agentRuntime.available,
    );
  } catch (error) {
    toast(reportUiFailure("retry Agent runtime", error, "The assistant connection could not be retried. Review model settings and try again."), true);
  } finally {
    button.disabled = false;
  }
});
$("#agentCancelButton").addEventListener("click", async () => {
  const turnId = state.activeAgentTurnId;
  if (!turnId) return;
  $("#agentCancelButton").disabled = true;
  try {
    await invoke("cancel_agent_turn", { turnId });
    await Promise.all([loadAgentData(), loadRunData()]);
  } catch (error) {
    toast(reportUiFailure("cancel Agent task", error, "The Agent task could not be stopped. Check its current status before trying again."), true);
  } finally {
    $("#agentCancelButton").disabled = false;
  }
});
$("#clearAgentHistoryButton").addEventListener("click", async () => {
  if (!await confirmAction({
    title: "Delete conversation history",
    message: "Delete all Agent conversation history for this project? This cannot be undone.",
    confirmLabel: "Delete history",
    destructive: true,
  })) return;
  try {
    await invoke("clear_agent_history");
    state.agentConversations = [];
    state.selectedConversationId = null;
    state.selectedTurnId = null;
    state.selectedTurnDetail = null;
    state.agentActivityExpanded.clear();
    state.fileEditProposal = null;
    state.fileEditUndo = null;
    state.fileEditUndoVerifiedKey = null;
    state.actAuthorizedTurnIds.clear();
    state.fileEditAutoApplyAttempts.clear();
    state.fileEditDecisions = new Map();
    clearFileEditDecisions();
    clearAgentEditHighlight();
    await Promise.all([loadAgentData(), loadRunData()]);
    toast("Deleted Agent history for this project.");
  } catch (error) {
    toast(reportUiFailure("delete Agent history", error, "Conversation history could not be deleted. Refresh Activity and try again."), true);
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
$("#agentContextNewFile").addEventListener("click", async () => {
  const value = await promptForPath({
    title: "New project file",
    message: "Enter a project-relative path.",
    defaultValue: "report.qmd",
  });
  if (!value) {
    closeAgentContextMenu();
    return;
  }
  try {
    const path = validateProjectRelativePath(value);
    insertAgentReference(path, { source: "new_file" });
    closeAgentContextMenu();
  } catch (error) {
    toast(reportUiFailure("validate new Agent context file", error, "That file path cannot be used in this project. Enter a project-relative path."), true);
  }
});
$("#refreshEnvironment").addEventListener("click", refreshEnvironment);
$("#packageFilter").addEventListener("input", renderPackageList);
$$('[data-package-tab]').forEach((button) => button.addEventListener("click", () => switchEnvironmentPackageTab(button.dataset.packageTab)));
$("#viewInstalledPackages").addEventListener("click", (event) => openPackageInventoryDialog("installed", event.currentTarget));
$("#viewLockfilePackages").addEventListener("click", (event) => openPackageInventoryDialog("lockfile", event.currentTarget));
$("#packageInventoryClose").addEventListener("click", closePackageInventoryDialog);
$("[data-package-inventory-close]").addEventListener("click", closePackageInventoryDialog);
$("#environmentSearch").addEventListener("input", renderEnvironment);
$("#variablesSearch").addEventListener("input", renderEnvironment);
initEvidencePanel();
initChunkPanel();
window.addEventListener("beforeunload", stopRenderPoll);
$("#environmentInitButton").addEventListener("click", () => beginEnvironmentOperation("initialize"));
$("#environmentRestoreButton").addEventListener("click", () => beginEnvironmentOperation("restore"));
$("#environmentSnapshotButton").addEventListener("click", () => beginEnvironmentOperation("snapshot"));
$("#environmentManagePackageButton").addEventListener("click", (event) => openPackageManagementDialog("install_package", "", event.currentTarget));
$("#packageManagementForm").addEventListener("submit", submitPackageManagement);
$("#packageManagementClose").addEventListener("click", () => closePackageManagementDialog());
$("#packageManagementCancel").addEventListener("click", () => closePackageManagementDialog());
$("[data-package-management-close]").addEventListener("click", () => closePackageManagementDialog());
$("#dataViewerViewSelect").addEventListener("change", () => {
  const [viewKind, ...viewKeyParts] = $("#dataViewerViewSelect").value.split(":");
  state.dataViewer.viewKind = viewKind || null;
  state.dataViewer.viewKey = viewKeyParts.join(":") || null;
  state.dataViewer.rowOffset = 0;
  state.dataViewer.columnOffset = 0;
  state.dataViewer.sortColumn = null;
  state.dataViewer.sortDirection = null;
  loadDataViewPage({ rowOffset: 0, columnOffset: 0 });
});
$("#agentHelpContextRemove").addEventListener("click", (event) => {
  event.stopPropagation();
  resetAgentLocalHelpContext();
  toast("Removed Local Help context from the next Agent question.");
});
$("#dataViewerFilter").addEventListener("input", () => {
  state.dataViewer.query = $("#dataViewerFilter").value;
  state.dataViewer.rowOffset = 0;
  state.dataViewer.error = null;
  clearTimeout(state.dataViewer.queryTimer);
  state.dataViewer.queryTimer = setTimeout(() => {
    state.dataViewer.queryTimer = null;
    loadDataViewPage({ rowOffset: 0 });
  }, 250);
});
$("#dataViewerPageSize").addEventListener("change", () => {
  const size = parseInt($("#dataViewerPageSize").value, 10);
  state.dataViewer.rowLimit = size;
  state.dataViewer.rowOffset = 0;
  loadDataViewPage({ rowOffset: 0 });
});
$("#dataViewerRowPrev").addEventListener("click", () => {
  loadDataViewPage({ rowOffset: Math.max(0, state.dataViewer.rowOffset - state.dataViewer.rowLimit) });
});
$("#dataViewerRowNext").addEventListener("click", () => {
  loadDataViewPage({ rowOffset: state.dataViewer.rowOffset + state.dataViewer.rowLimit });
});
$("#dataViewerColumnPrev").addEventListener("click", () => {
  loadDataViewPage({ columnOffset: Math.max(0, state.dataViewer.columnOffset - state.dataViewer.columnLimit) });
});
$("#dataViewerColumnNext").addEventListener("click", () => {
  loadDataViewPage({ columnOffset: state.dataViewer.columnOffset + state.dataViewer.columnLimit });
});
$("#dataViewerExportButton").addEventListener("click", exportVisibleDataView);

// Keyboard navigation for data viewer table
$("#dataViewerTable").addEventListener("keydown", (event) => {
  const table = $("#dataViewerTable");
  const focusable = table.querySelectorAll("td, th");
  if (!focusable.length || !table.closest(":not(.hidden)")) return;
  const current = document.activeElement;
  const index = Array.from(focusable).indexOf(current);
  if (index < 0) return;
  const cols = table.querySelector("tr")?.querySelectorAll("th, td")?.length || 1;
  let next = index;
  if (event.key === "ArrowRight") next = Math.min(index + 1, focusable.length - 1);
  else if (event.key === "ArrowLeft") next = Math.max(index - 1, 0);
  else if (event.key === "ArrowDown") next = Math.min(index + cols, focusable.length - 1);
  else if (event.key === "ArrowUp") next = Math.max(index - cols, 0);
  else if (event.key === "Home") next = index - (index % cols);
  else if (event.key === "End") next = Math.min(index - (index % cols) + cols - 1, focusable.length - 1);
  else if (event.key === "Tab") {
    event.preventDefault();
    if (event.shiftKey) {
      next = index > 0 ? index - 1 : focusable.length - 1;
    } else {
      next = index < focusable.length - 1 ? index + 1 : 0;
    }
  }
  else return;
  event.preventDefault();
  focusable[next].focus();
});

$("#environmentOperationReviewButton").addEventListener("click", async () => {
  const request = latestEnvironmentOperation();
  if (!request) return;
  openEnvironmentOperationDialog(request.request_id, document.activeElement);
});
$("#environmentOperationApprove").addEventListener("click", () => respondEnvironmentOperation("approve"));
$("#environmentOperationReject").addEventListener("click", () => respondEnvironmentOperation("reject"));
$("#environmentOperationCancel").addEventListener("click", () => {
  const request = state.environmentOperations.find((item) => item.request_id === state.environmentOperationDialog.requestId) || null;
  if (request?.status === "requested") respondEnvironmentOperation("cancel");
  else closeEnvironmentOperationDialog();
});
$("#renderDocumentButton").addEventListener("click", renderActiveDocumentFile);
$("#renderCancelButton").addEventListener("click", async () => {
  const jobId = _activeRenderJobId;
  if (!jobId) return;
  const button = $("#renderCancelButton");
  button.disabled = true;
  $("#renderJobStatus").textContent = "Cancelling\u2026";
  try {
    await invoke("cancel_render_job", { job_id: jobId });
  } catch (error) {
    button.disabled = false;
    toast(reportUiFailure("stop document render", error, "The render could not be stopped. Check its current status before trying again."), true);
  }
});
$("#renderOpenSourceButton").addEventListener("click", async () => {
  if (!state.lastRender?.sourcePath) return;
  await openDocument(state.lastRender.sourcePath);
});
$("#renderReviewArtifactButton").addEventListener("click", async () => {
  const artifactId = state.lastRender?.artifactId;
  if (!state.lastRender?.artifactAvailable || !artifactId) return;
  try {
    const detail = await invoke("get_artifact_record", { artifactId });
    if (!detail?.artifact) throw new Error("Saved render output is unavailable");
    state.selectedArtifactId = detail.artifact.artifact_id;
    state.selectedArtifactDetail = detail;
    switchDockTab("plots");
    $("#artifactPanel").open = true;
    renderArtifactRecords();
    if (state.posture === "agent") openAgentWorkSurface("artifact");
  } catch (error) {
    state.lastRender.artifactAvailable = false;
    renderLastRenderCard();
    toast(reportUiFailure("open rendered output", error, "The saved report is unavailable. Refresh Outputs or render the document again."), true);
  }
});
$("#renderShowProblemsButton").addEventListener("click", () => {
  if (!latestRenderProblem()) return;
  switchDockTab("problems");
});
$("#renderShowPlotsButton").addEventListener("click", () => {
  if (!state.lastRender?.sourcePath) return;
  switchDockTab("plots");
});
$("#viewerClose").addEventListener("click", closeViewer);
$("#viewerOpenSource").addEventListener("click", async () => {
  if (state.viewer.sourcePath) {
    await openDocument(state.viewer.sourcePath);
    closeViewer();
  }
});
$$('[data-viewer-mode]').forEach((button) => button.addEventListener("click", () => {
  state.viewer.mode = button.dataset.viewerMode;
  renderViewer();
}));
$("#plotOpenViewerButton").addEventListener("click", openSelectedOutputInViewer);
$("#artifactOpenViewerButton").addEventListener("click", openSelectedOutputInViewer);
$("#plotsShortcut").addEventListener("click", () => switchDockTab("plots"));
$("#artifactsShortcut").addEventListener("click", () => {
  switchDockTab("plots");
  $("#artifactPanel").open = true;
});
$("#plotExportButton").addEventListener("click", exportActivePlot);
async function prunePlotPayloads(sessionOnly) {
  const scope = sessionOnly ? "this session" : "this project";
  if (!await confirmAction({
    title: "Free preview storage",
    message: `Free preview storage for ${scope}? Plot history rows stay in place and exported files are not deleted.`,
    confirmLabel: "Free preview storage",
  })) return;
  try {
    const result = await invoke("prune_plot_payloads", { session_only: sessionOnly });
    await loadRunData();
    toast(`Freed previews for ${scope}. ${result?.pruned_count || 0} plot preview${result?.pruned_count === 1 ? " is" : "s are"} no longer stored.`);
  } catch (error) {
    toast(reportUiFailure("free plot preview storage", error, "Plot preview storage could not be freed. Refresh Plots and try again."), true);
  }
}
async function clearPlots(sessionOnly) {
  const scope = sessionOnly ? "this session" : "this project";
  if (!await confirmAction({
    title: "Delete plot history",
    message: `Delete plot history from ${scope}? Exported files are not deleted.`,
    confirmLabel: "Delete plot history",
    destructive: true,
  })) return;
  try {
    await invoke("clear_plot_artifacts", { session_only: sessionOnly });
    await loadRunData();
    toast(`Deleted plot history from ${scope}. Exported files were left in place.`);
  } catch (error) {
    toast(reportUiFailure("delete plot history", error, "Plot history could not be deleted. Refresh Plots and try again."), true);
  }
}
$("#pruneSessionPlotsButton").addEventListener("click", () => prunePlotPayloads(true));
$("#pruneProjectPlotsButton").addEventListener("click", () => prunePlotPayloads(false));
$("#clearSessionPlotsButton").addEventListener("click", () => clearPlots(true));
$("#clearProjectPlotsButton").addEventListener("click", () => clearPlots(false));
$("#clearSessionArtifactsButton").addEventListener("click", () => clearArtifacts(true));
$("#clearProjectArtifactsButton").addEventListener("click", () => clearArtifacts(false));
$("#artifactOpenSourceButton").addEventListener("click", async () => {
  const sourcePath = state.selectedArtifactDetail?.artifact?.source_path;
  if (!sourcePath) return;
  try {
    await openDocument(sourcePath);
  } catch (error) {
    toast(reportUiFailure("open output source", error, "The source document could not be opened. Refresh the project and try again."), true);
  }
});
$$('[data-plot-scope]').forEach((button) => button.addEventListener("click", async () => {
  state.plotScope = button.dataset.plotScope;
  await loadRunData();
}));
$("#toggleDockMaximize").addEventListener("click", toggleDockMaximize);
$$('[data-menu-trigger]').forEach((trigger) => trigger.addEventListener("click", (event) => {
  event.stopPropagation();
  const name = trigger.dataset.menuTrigger;
  updateWorkbenchMenuState();
  closeWorkbenchMenus(trigger.getAttribute("aria-expanded") === "true" ? null : name);
}));
$$('[data-menu-trigger]').forEach((trigger) => trigger.addEventListener("keydown", (event) => {
  if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
  event.preventDefault();
  const name = trigger.dataset.menuTrigger;
  updateWorkbenchMenuState();
  closeWorkbenchMenus(name);
  focusWorkbenchMenuEdge(name, event.key === "ArrowUp" ? "last" : "first");
}));
$$('[data-menu-command]').forEach((item) => item.addEventListener("click", () => {
  closeWorkbenchMenus();
  runWorkbenchMenuCommand(item.dataset.menuCommand);
}));
$$('[data-menu-command]').forEach((item) => item.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveWorkbenchMenuFocus(item, 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveWorkbenchMenuFocus(item, -1);
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    focusWorkbenchMenuEdge(item.closest("[data-menu]").dataset.menu, event.key === "End" ? "last" : "first");
  } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    event.preventDefault();
    switchWorkbenchMenu(item, event.key === "ArrowRight" ? 1 : -1);
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    const name = item.closest("[data-menu]").dataset.menu;
    closeWorkbenchMenus();
    $(`[data-menu-trigger="${name}"]`).focus();
  }
}));
document.addEventListener("click", (event) => {
  if (event.target.closest("#packageInventoryDialog") && event.target.closest("[data-package-inventory-close]")) {
    closePackageInventoryDialog();
  }
  if (!event.target.closest(".menu-item")) closeWorkbenchMenus();
  if (!event.target.closest("#agentContextButton") && !event.target.closest("#agentContextMenu")) {
    closeAgentContextMenu();
  }
  if (!event.target.closest("#agentModelSelector") && !event.target.closest("#agentModelSelectorMenu")) {
    closeAgentModelSelector();
  }
  if (!event.target.closest("#agentModeControl")) {
    $("#agentModeControl").removeAttribute("open");
  }
  if (!event.target.closest("#agentInput") && !event.target.closest("#agentFileMentions")) {
    hideAgentFileMentions();
  }
  if (!event.target.closest("#environmentOperationDialog") && $("#environmentOperationDialog").classList.contains("hidden")) {
    state.environmentOperationDialog.returnFocus = null;
  }
  if (!event.target.closest("#packageManagementDialog") && $("#packageManagementDialog").classList.contains("hidden")) {
    state.packageManagementDialog.returnFocus = null;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.packageInventoryDialog.open) {
    event.preventDefault();
    closePackageInventoryDialog();
  }
});
document.addEventListener("keydown", (event) => {
  const shortcutCommand = event.defaultPrevented ? null : workbenchShortcutCommand(event);
  if (shortcutCommand) {
    if (workbenchShortcutOwnedByInput(event.target) || workbenchShortcutOwnedByDialog()) return;
    event.preventDefault();
    runWorkbenchMenuCommand(shortcutCommand);
    return;
  }
  if (event.key === "Tab" && state.product.dialog) {
    const { surface } = productDialogElements(state.product.dialog);
    const focusable = Array.from(surface.querySelectorAll('button:not([disabled]):not(.hidden), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    if (focusable.length) {
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }
  if (event.key === "Escape") {
    closeWorkbenchMenus();
    hideAgentFileMentions();
    closeAgentModelSelector();
    closeAgentLlmDialog();
    closePackageManagementDialog();
    closeEnvironmentOperationDialog();
    closeProductDialog();
    clearAgentEditHighlight();
  }
});
document.addEventListener("contextmenu", (event) => {
  if (event.defaultPrevented || keepsNativeContextMenu(event.target)) return;
  event.preventDefault();
});
window.addEventListener("resize", () => {
  for (const panel of ["left", "right", "dock"]) {
    const handle = panel === "left" ? $("#leftResizeHandle") : panel === "right" ? $("#rightResizeHandle") : $("#dockResizeHandle");
    setPanelSize(panel, Number(handle.getAttribute("aria-valuenow")), false);
  }
  if (state.agentLlm.selectorOpen) positionAgentModelMenu();
  layoutEditor();
});
$("#interruptButton").addEventListener("click", async () => {
  try {
    const response = state.activeRunId
      ? await invoke("cancel_run", { runId: state.activeRunId })
      : await invoke("interrupt_r");
    addLog("SYSTEM", "Interrupt requested");
    if (response?.run_id) state.activeRunId = response.run_id;
    await loadRunData();
  } catch (error) {
    toast(reportUiFailure("interrupt R session", error, "The R session could not be interrupted. Check the current run before trying again."), true);
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
    clearEnvironmentObjectSelection();
    renderEnvironment();
    addLog("SYSTEM", "R session restarted and ready");
    await loadRunData();
  } catch (error) {
    setKernelStatus("error", "R unavailable");
    toast(reportUiFailure("restart R session", error, "The R session could not be restarted. Retry or review diagnostics if the problem continues."), true);
  }
});

initialize();
