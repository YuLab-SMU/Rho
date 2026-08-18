import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateP13Contract({ desktop, server, frontend, agent }) {
  for (const [pattern, message] of [
    [/PluginId::new\("org\.yulab\.rho\.workspace-snapshot-tool"\)/, "Workspace Snapshot plugin ID changed"],
    [/CapabilityId::new\("tool\.workspace\.snapshot"\)/, "Workspace Snapshot tool capability changed"],
    [/CapabilityId::new\("service\.broker\.workspace-probe"\)/, "Workspace probe broker capability changed"],
    [/PluginId::new\("org\.yulab\.rho\.project-file-viewer"\)/, "Project File Viewer plugin ID changed"],
    [/CapabilityId::new\("ui\.viewer\.project-file"\)/, "Project File Viewer capability changed"],
    [/enum WorkspaceOperation\s*\{\s*Snapshot\s*\{/, "Workspace Snapshot no longer uses a typed operation"],
    [/call_workspace_tool\(&workspace_snapshot_tool_capability_id\(\), request\)/, "Tauri snapshot no longer enters the Workspace tool registry"],
    [/validate_workspace_current\(&result\.scope\)/, "Workspace Snapshot completion generation is not validated"],
    [/resolve_project_file_viewer\(&project_file_viewer_capability_id\(\)\)/, "Viewer contribution is not resolved from application scope"],
    [/read_viewer_file\(&root, &path\)/, "Viewer host no longer delegates to the containment authority"],
  ]) {
    assert.match(desktop, pattern, message);
  }
  assert.match(
    desktop,
    /dispatch_workspace_request_with_execution_id\(\s*"workspace\.snapshot"/,
    "Workspace broker no longer preserves the existing request type",
  );
  assert.match(
    server,
    /"workspace\.snapshot" => Ok\(\(\s*OperationClass::Probe,\s*format!\("\{bridge\}\$rho_workspace_snapshot\(envir = \.GlobalEnv\)"\)/,
    "rho-server no longer owns the fixed Workspace Snapshot bridge expression",
  );
  assert.match(
    server,
    /dispatch_workspace_snapshot_adapter\(\s*request_type,\s*payload,\s*&execution_id,/,
    "Agent Workspace lane no longer delegates only snapshot requests to the adapter",
  );
  assert.match(
    server,
    /async fn dispatch_workspace_snapshot_adapter[\s\S]{0,800}request_type != "workspace\.snapshot"[\s\S]{0,500}\.snapshot\(payload\.clone\(\), execution_id\.to_string\(\)\)/,
    "Workspace Snapshot adapter no longer preserves exact request selection and execution identity",
  );
  const viewerPlugin = desktop.match(/impl InternalPlugin for ProjectFileViewerPlugin \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(viewerPlugin, /project_root|project_path|AppHandle|State<'_/, "Viewer plugin retained project or Tauri authority");
  const snapshotHandler = desktop.match(/impl WorkspaceToolHandler for WorkspaceSnapshotToolHandler \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(snapshotHandler, /rho_workspace_snapshot|\.GlobalEnv|bridge_expression/, "Workspace plugin generated a raw R expression");

  assert.equal((frontend.match(/if \(command === "snapshot_workspace"\)/g) ?? []).length, 1, "browser mock must define exactly one snapshot_workspace handler");
  assert.equal((frontend.match(/if \(command === "viewer_read_file"\)/g) ?? []).length, 1, "browser mock must define exactly one viewer_read_file handler");
  assert.match(frontend, /invoke\("snapshot_workspace"\)/, "snapshot_workspace consumer changed");
  assert.match(frontend, /invoke\("viewer_read_file", \{ path:/, "viewer_read_file consumer changed");
  assert.match(frontend, /contract: "rho\.viewer_file\.v1"/, "viewer mock protocol changed");
  assert.match(frontend, /png: "image\/png"/, "viewer mock lost image media parity");
  assert.match(frontend, /contentEncoding = mediaType\.startsWith\("image\/"\) \? "base64" : "utf-8"/, "viewer mock lost encoding parity");
  if (agent != null) {
    assert.match(agent, /name = "get_workspace_snapshot"/, "Agent tool name changed");
    assert.match(agent, /rho_broker_tool_request\("workspace\.snapshot", args\)/, "Agent Workspace request type changed");
  }
}

function fixtures() {
  return {
    desktop: `
PluginId::new("org.yulab.rho.workspace-snapshot-tool");
CapabilityId::new("tool.workspace.snapshot");
CapabilityId::new("service.broker.workspace-probe");
PluginId::new("org.yulab.rho.project-file-viewer");
CapabilityId::new("ui.viewer.project-file");
enum WorkspaceOperation { Snapshot { expected_workspace: ExpectedWorkspace } }
call_workspace_tool(&workspace_snapshot_tool_capability_id(), request);
validate_workspace_current(&result.scope);
resolve_project_file_viewer(&project_file_viewer_capability_id());
read_viewer_file(&root, &path);
dispatch_workspace_request_with_execution_id("workspace.snapshot", &payload);
impl InternalPlugin for ProjectFileViewerPlugin {
  fn activate() { register_project_file_viewer(); }
}
impl WorkspaceToolHandler for WorkspaceSnapshotToolHandler {
  fn call() { broker.call(); }
}
`,
    server: `
"workspace.snapshot" => Ok((
  OperationClass::Probe,
  format!("{bridge}$rho_workspace_snapshot(envir = .GlobalEnv)"),
)),
dispatch_workspace_snapshot_adapter(request_type, payload, &execution_id, adapter);
async fn dispatch_workspace_snapshot_adapter() {
  if request_type != "workspace.snapshot" { return None; }
  adapter.snapshot(payload.clone(), execution_id.to_string()).await;
}
`,
    frontend: `
if (command === "snapshot_workspace") return {};
const contentEncoding = mediaType.startsWith("image/") ? "base64" : "utf-8";
if (command === "viewer_read_file") return { contract: "rho.viewer_file.v1", png: "image/png", contentEncoding };
invoke("snapshot_workspace");
invoke("viewer_read_file", { path: input.path });
`,
    agent: `name = "get_workspace_snapshot"\nrho_broker_tool_request("workspace.snapshot", args)`,
  };
}

function runSelfTests() {
  validateP13Contract(fixtures());
  for (const [name, mutate] of [
    ["snapshot plugin", (value) => { value.desktop = value.desktop.replace("org.yulab.rho.workspace-snapshot-tool", "wrong"); }],
    ["typed operation", (value) => { value.desktop = value.desktop.replace("enum WorkspaceOperation", "enum UntypedOperation"); }],
    ["raw expression", (value) => { value.desktop = value.desktop.replace("broker.call();", "rho_workspace_snapshot(envir = .GlobalEnv);"); }],
    ["broker expression", (value) => { value.server = value.server.replace("rho_workspace_snapshot", "plugin_expression"); }],
    ["viewer root", (value) => { value.desktop = value.desktop.replace("register_project_file_viewer();", "register_project_file_viewer(project_root);"); }],
    ["duplicate mock", (value) => { value.frontend += '\nif (command === "viewer_read_file") return {};'; }],
    ["Agent tool", (value) => { value.agent = value.agent.replace("get_workspace_snapshot", "snapshot_v2"); }],
  ]) {
    const value = fixtures();
    mutate(value);
    assert.throws(() => validateP13Contract(value), undefined, name);
  }
}

if (process.argv.includes("--test")) {
  runSelfTests();
} else {
  validateP13Contract({
    desktop: read("desktop/src-tauri/src/main.rs"),
    server: read("crates/rho-server/src/coordinator.rs"),
    frontend: read("desktop/dist/app.js"),
    agent: fs.existsSync("R/rho.agent/R/aisdk_adapter.R")
      ? read("R/rho.agent/R/aisdk_adapter.R")
      : null,
  });
}

console.log("extension P1-3 contract passed");
