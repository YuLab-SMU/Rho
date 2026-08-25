import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_HANDLER_DIGEST = "61fa2ca83e2972ec245604826af7fa2873dd37356ba3b5e5dfbe5c7f7bc3577d";
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RUN_COMMANDS = [
  "audit_reproducibility",
  "compare_runs",
  "get_run_detail",
  "list_problems",
  "list_runs",
  "retry_run",
];

const ARTIFACT_COMMANDS = [
  "clear_artifact_records",
  "clear_plot_artifacts",
  "export_data_view_artifact",
  "export_plot_artifact",
  "get_artifact_record",
  "get_project_retention_summary",
  "list_artifact_records",
  "list_plot_artifacts",
  "prune_plot_payloads",
  "read_plot_artifact",
];

const EVIDENCE_COMMANDS = [
  "create_evidence_claim",
  "create_evidence_entry",
  "delete_evidence_claim",
  "delete_evidence_entry",
  "get_evidence_entry",
  "list_evidence_claims",
  "list_evidence_entries",
  "resolve_doi",
  "review_evidence_claim",
];

const ENVIRONMENT_COMMANDS = [
  "get_environment_operation_request",
  "list_environment_operation_requests",
  "list_installed_packages",
  "list_lockfile_packages",
  "request_environment_operation_preview",
  "respond_environment_operation",
];

const EDITOR_COMMANDS = [
  "editor_discover_chunks",
  "editor_find_project_references",
  "editor_format_source",
  "editor_function_documentation",
  "editor_function_help",
  "editor_goto_definition",
  "editor_lint_file",
  "editor_package_functions",
];

const PROJECT_COMMANDS = [
  "list_project_skills",
  "project_create_file",
  "project_delete_file",
  "project_mark_files_changed",
  "project_open",
  "project_pick_directory",
  "project_read_file",
  "project_restore_session",
  "project_save_session",
  "project_state",
  "project_write_file",
  "viewer_read_file",
];

const AGENT_LLM_COMMANDS = [
  "agent_llm_cancel_test",
  "agent_llm_catalog",
  "agent_llm_declare_model_capabilities",
  "agent_llm_delete_capability_route",
  "agent_llm_delete_credential",
  "agent_llm_delete_model",
  "agent_llm_delete_provider",
  "agent_llm_discover_models",
  "agent_llm_refresh_credentials",
  "agent_llm_save_capability_route",
  "agent_llm_save_model",
  "agent_llm_save_provider",
  "agent_llm_select_model",
  "agent_llm_set_context_capacity",
  "agent_llm_set_credential",
  "agent_llm_settings",
  "agent_llm_test_model",
];

const AGENT_CONVERSATION_COMMANDS = [
  "create_agent_conversation",
  "delete_agent_conversation",
  "list_agent_conversations",
  "list_agent_turns",
];

const STARTUP_COMMANDS = [
  "agent_runtime_retry",
  "agent_runtime_status",
  "startup_bootstrap",
  "startup_choose_rscript",
  "startup_diagnostics",
  "startup_open_log_directory",
  "startup_status",
  "workspace_start",
  "workspace_status",
];

const RENDER_COMMANDS = [
  "cancel_render_job",
  "render_document",
  "render_document_job",
  "render_job_status",
];

const WORKSPACE_COMMANDS = [
  "execute_r",
  "inspect_data_object",
  "inspect_object",
  "read_data_view",
  "snapshot_workspace",
];

const PLUGIN_COMMANDS = [
  "accept_workspace_plugin_update",
  "disable_workspace_plugin",
  "get_plugin_panel_document",
  "get_plugin_permission_request",
  "get_workspace_plugin_transition",
  "invoke_plugin_command",
  "list_plugin_contributions",
  "list_plugin_grants",
  "list_plugin_permission_requests",
  "list_workspace_plugins",
  "open_plugin_viewer",
  "request_workspace_plugin_enable",
  "respond_plugin_permission",
  "restore_workspace_plugin",
  "retry_workspace_plugin",
  "revoke_plugin_grant",
  "rollback_workspace_plugin",
  "uninstall_workspace_plugin",
];

function rustFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".rs")) files.push(entryPath);
    }
  };
  visit(root);
  return files.sort();
}

function commandDefinitions(sources) {
  const definitions = [];
  const pattern = /#\[tauri::command(?:\([^\]]*\))?\]\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const source of sources) {
    for (const match of source.text.matchAll(pattern)) {
      definitions.push({ name: match[1], source: source.name });
    }
  }
  return definitions;
}

function handlerCommands(main) {
  const match = main.match(/\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/);
  assert.ok(match, "Tauri generate_handler inventory is missing");
  return match[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split("::").at(-1));
}

function handlerDigest(commands) {
  return crypto.createHash("sha256").update(commands.join("\n")).digest("hex");
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function difference(left, right) {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((value) => !rightSet.has(value)).sort();
}

function frontendCommands(frontend) {
  return [...frontend.matchAll(/\binvoke(?:<[^>]+>)?\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g)]
    .map((match) => match[1]);
}

export function validateCommandInventory({ sources, main, frontend, expectedHandlerDigest }) {
  const definitions = commandDefinitions(sources);
  const definitionNames = definitions.map(({ name }) => name);
  const handlers = handlerCommands(main);

  assert.deepEqual(
    duplicates(definitionNames),
    [],
    "Tauri command names must be unique across Rust modules",
  );
  assert.deepEqual(
    duplicates(handlers),
    [],
    "Tauri generate_handler entries must be unique",
  );
  assert.deepEqual(
    difference(definitionNames, handlers),
    [],
    "Every #[tauri::command] definition must be registered",
  );
  assert.deepEqual(
    difference(handlers, definitionNames),
    [],
    "Every generate_handler entry must resolve to a #[tauri::command] definition",
  );
  if (expectedHandlerDigest) {
    assert.equal(
      handlerDigest(handlers),
      expectedHandlerDigest,
      "Tauri command registration identity or order changed",
    );
  }
  assert.deepEqual(
    difference(frontendCommands(frontend), handlers),
    [],
    "Every command used by the module transport must be registered by Tauri",
  );

  const runSource = sources.find(({ name }) => name.endsWith("commands/runs.rs"));
  assert.ok(runSource, "Runs command module is missing");
  assert.deepEqual(
    commandDefinitions([runSource]).map(({ name }) => name).sort(),
    RUN_COMMANDS,
    "Runs command module ownership changed",
  );

  const pluginSource = sources.find(({ name }) => name.endsWith("commands/plugins.rs"));
  assert.ok(pluginSource, "Workspace Plugins command module is missing");
  assert.deepEqual(
    commandDefinitions([pluginSource]).map(({ name }) => name).sort(),
    PLUGIN_COMMANDS,
    "Workspace Plugins command module ownership changed",
  );

  const artifactSource = sources.find(({ name }) => name.endsWith("commands/artifacts.rs"));
  assert.ok(artifactSource, "Artifact command module is missing");
  assert.deepEqual(
    commandDefinitions([artifactSource]).map(({ name }) => name).sort(),
    ARTIFACT_COMMANDS,
    "Artifact command module ownership changed",
  );

  const evidenceSource = sources.find(({ name }) => name.endsWith("commands/evidence.rs"));
  assert.ok(evidenceSource, "Evidence command module is missing");
  assert.deepEqual(
    commandDefinitions([evidenceSource]).map(({ name }) => name).sort(),
    EVIDENCE_COMMANDS,
    "Evidence command module ownership changed",
  );

  const environmentSource = sources.find(({ name }) => name.endsWith("commands/environment.rs"));
  assert.ok(environmentSource, "Environment command module is missing");
  assert.deepEqual(
    commandDefinitions([environmentSource]).map(({ name }) => name).sort(),
    ENVIRONMENT_COMMANDS,
    "Environment command module ownership changed",
  );

  const editorSource = sources.find(({ name }) => name.endsWith("commands/editor.rs"));
  assert.ok(editorSource, "Editor command module is missing");
  assert.deepEqual(
    commandDefinitions([editorSource]).map(({ name }) => name).sort(),
    EDITOR_COMMANDS,
    "Editor command module ownership changed",
  );

  const projectSource = sources.find(({ name }) => name.endsWith("commands/project_session.rs"));
  assert.ok(projectSource, "Project command module is missing");
  assert.deepEqual(
    commandDefinitions([projectSource]).map(({ name }) => name).sort(),
    PROJECT_COMMANDS,
    "Project command module ownership changed",
  );

  const agentLlmSource = sources.find(({ name }) => name.endsWith("commands/agent_llm.rs"));
  assert.ok(agentLlmSource, "Agent LLM command module is missing");
  assert.deepEqual(
    commandDefinitions([agentLlmSource]).map(({ name }) => name).sort(),
    AGENT_LLM_COMMANDS,
    "Agent LLM command module ownership changed",
  );

  const agentConversationSource = sources.find(
    ({ name }) => name.endsWith("commands/agent_conversation.rs"),
  );
  assert.ok(agentConversationSource, "Agent conversation command module is missing");
  assert.deepEqual(
    commandDefinitions([agentConversationSource]).map(({ name }) => name).sort(),
    AGENT_CONVERSATION_COMMANDS,
    "Agent conversation command module ownership changed",
  );

  const startupSource = sources.find(({ name }) => name.endsWith("commands/startup.rs"));
  assert.ok(startupSource, "Startup command module is missing");
  assert.deepEqual(
    commandDefinitions([startupSource]).map(({ name }) => name).sort(),
    STARTUP_COMMANDS,
    "Startup command module ownership changed",
  );

  const renderSource = sources.find(({ name }) => name.endsWith("commands/render.rs"));
  assert.ok(renderSource, "Render command module is missing");
  assert.deepEqual(
    commandDefinitions([renderSource]).map(({ name }) => name).sort(),
    RENDER_COMMANDS,
    "Render command module ownership changed",
  );

  const workspaceSource = sources.find(({ name }) => name.endsWith("commands/workspace.rs"));
  assert.ok(workspaceSource, "Workspace command module is missing");
  assert.deepEqual(
    commandDefinitions([workspaceSource]).map(({ name }) => name).sort(),
    WORKSPACE_COMMANDS,
    "Workspace command module ownership changed",
  );

  return { commands: definitionNames.length, sources: sources.length };
}

function fixtures() {
  const artifactHandlers = ARTIFACT_COMMANDS.map(
    (command) => `  commands::artifacts::${command},`,
  ).join("\n");
  const evidenceHandlers = EVIDENCE_COMMANDS.map(
    (command) => `  commands::evidence::${command},`,
  ).join("\n");
  const environmentHandlers = ENVIRONMENT_COMMANDS.map(
    (command) => `  commands::environment::${command},`,
  ).join("\n");
  const editorHandlers = EDITOR_COMMANDS.map(
    (command) => `  commands::editor::${command},`,
  ).join("\n");
  const projectHandlers = PROJECT_COMMANDS.map(
    (command) => `  commands::project_session::${command},`,
  ).join("\n");
  const agentLlmHandlers = AGENT_LLM_COMMANDS.map(
    (command) => `  commands::agent_llm::${command},`,
  ).join("\n");
  const agentConversationHandlers = AGENT_CONVERSATION_COMMANDS.map(
    (command) => `  commands::agent_conversation::${command},`,
  ).join("\n");
  const startupHandlers = STARTUP_COMMANDS.map(
    (command) => `  commands::startup::${command},`,
  ).join("\n");
  const renderHandlers = RENDER_COMMANDS.map(
    (command) => `  commands::render::${command},`,
  ).join("\n");
  const workspaceHandlers = WORKSPACE_COMMANDS.map(
    (command) => `  commands::workspace::${command},`,
  ).join("\n");
  const pluginHandlers = PLUGIN_COMMANDS.map(
    (command) => `  commands::plugins::${command},`,
  ).join("\n");
  const main = `
#[tauri::command]
async fn app_info() {}
.invoke_handler(tauri::generate_handler![
  app_info,
${pluginHandlers}
${artifactHandlers}
${evidenceHandlers}
${environmentHandlers}
${editorHandlers}
${projectHandlers}
${agentLlmHandlers}
${agentConversationHandlers}
${startupHandlers}
${renderHandlers}
${workspaceHandlers}
  commands::runs::list_runs,
  commands::runs::list_problems,
  commands::runs::get_run_detail,
  commands::runs::compare_runs,
  commands::runs::audit_reproducibility,
  commands::runs::retry_run,
])`;
  const runs = RUN_COMMANDS.map(
    (command) => `#[tauri::command]\npub(crate) async fn ${command}() {}`,
  ).join("\n");
  return {
    sources: [
      { name: "main.rs", text: main },
      { name: "commands/runs.rs", text: runs },
      { name: "commands/artifacts.rs", text: ARTIFACT_COMMANDS.map(
        (command) => `#[tauri::command]\npub(crate) async fn ${command}() {}`,
      ).join("\n") },
      { name: "commands/evidence.rs", text: EVIDENCE_COMMANDS.map(
        (command) => `#[tauri::command]\npub(crate) async fn ${command}() {}`,
      ).join("\n") },
      { name: "commands/environment.rs", text: ENVIRONMENT_COMMANDS.map(
        (command) => `#[tauri::command]\npub(crate) async fn ${command}() {}`,
      ).join("\n") },
      { name: "commands/editor.rs", text: EDITOR_COMMANDS.map(
        (command) => `#[tauri::command]\npub(crate) async fn ${command}() {}`,
      ).join("\n") },
      { name: "commands/project_session.rs", text: PROJECT_COMMANDS.map(
        (command) => `#[tauri::command]\npub(crate) async fn ${command}() {}`,
      ).join("\n") },
      { name: "commands/agent_llm.rs", text: AGENT_LLM_COMMANDS.map(
        (command) => `#[tauri::command]\npub(crate) async fn ${command}() {}`,
      ).join("\n") },
      { name: "commands/agent_conversation.rs", text: AGENT_CONVERSATION_COMMANDS.map(
        (command) => `#[tauri::command]\npub(crate) async fn ${command}() {}`,
      ).join("\n") },
      { name: "commands/startup.rs", text: STARTUP_COMMANDS.map(
        (command) => `#[tauri::command]\npub(crate) async fn ${command}() {}`,
      ).join("\n") },
      { name: "commands/render.rs", text: RENDER_COMMANDS.map(
        (command) => `#[tauri::command]\npub(crate) async fn ${command}() {}`,
      ).join("\n") },
      { name: "commands/workspace.rs", text: WORKSPACE_COMMANDS.map(
        (command) => `#[tauri::command]\npub(crate) async fn ${command}() {}`,
      ).join("\n") },
      { name: "commands/plugins.rs", text: PLUGIN_COMMANDS.map(
        (command) => `#[tauri::command]\npub(crate) async fn ${command}() {}`,
      ).join("\n") },
    ],
    main,
    frontend: [
      ...RUN_COMMANDS,
      ...ARTIFACT_COMMANDS,
      ...EVIDENCE_COMMANDS,
      ...ENVIRONMENT_COMMANDS,
      ...EDITOR_COMMANDS,
      ...PROJECT_COMMANDS,
      ...AGENT_LLM_COMMANDS,
      ...AGENT_CONVERSATION_COMMANDS,
      ...STARTUP_COMMANDS,
      ...RENDER_COMMANDS,
      ...WORKSPACE_COMMANDS,
      ...PLUGIN_COMMANDS,
    ].map(
      (command) => `invoke("${command}");`,
    ).join("\n"),
  };
}

function runSelfTests() {
  const valid = fixtures();
  const expectedHandlerDigest = handlerDigest(handlerCommands(valid.main));
  validateCommandInventory({ ...valid, expectedHandlerDigest });

  const missingHandler = fixtures();
  missingHandler.main = missingHandler.main.replace("  commands::runs::list_problems,\n", "");
  missingHandler.sources[0].text = missingHandler.main;
  assert.throws(
    () => validateCommandInventory(missingHandler),
    /Every #\[tauri::command\] definition must be registered/,
  );

  const duplicateHandler = fixtures();
  duplicateHandler.main = duplicateHandler.main.replace(
    "  app_info,",
    "  app_info,\n  app_info,",
  );
  duplicateHandler.sources[0].text = duplicateHandler.main;
  assert.throws(
    () => validateCommandInventory(duplicateHandler),
    /generate_handler entries must be unique/,
  );

  const missingMock = fixtures();
  missingMock.frontend += '\ninvoke("unknown_command");';
  assert.throws(
    () => validateCommandInventory(missingMock),
    /module transport must be registered by Tauri/,
  );

  const reordered = fixtures();
  reordered.main = reordered.main.replace(
    "  commands::runs::list_runs,\n  commands::runs::list_problems,",
    "  commands::runs::list_problems,\n  commands::runs::list_runs,",
  );
  reordered.sources[0].text = reordered.main;
  assert.throws(
    () => validateCommandInventory({ ...reordered, expectedHandlerDigest }),
    /registration identity or order changed/,
  );
}

if (process.argv.includes("--test")) {
  runSelfTests();
  console.log("Tauri command inventory self-tests passed");
} else {
  const sourceRoot = path.join(REPOSITORY_ROOT, "desktop", "src-tauri", "src");
  const files = rustFiles(sourceRoot);
  const sources = files.map((name) => ({ name, text: fs.readFileSync(name, "utf8") }));
  const main = fs.readFileSync(path.join(sourceRoot, "main.rs"), "utf8");
  const frontend = fs.readFileSync(
    path.join(REPOSITORY_ROOT, "desktop", "ui", "src", "transport", "tauri.ts"),
    "utf8",
  );
  const result = validateCommandInventory({
    sources,
    main,
    frontend,
    expectedHandlerDigest: EXPECTED_HANDLER_DIGEST,
  });
  console.log(
    `Tauri command inventory passed: ${result.commands} commands across ${result.sources} Rust files`,
  );
}
