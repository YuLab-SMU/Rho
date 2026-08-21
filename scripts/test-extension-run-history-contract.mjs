import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateRunHistoryContract({ rust, frontend }) {
  assert.match(
    rust,
    /async fn list_runs\(\s*limit: Option<usize>,\s*state: State<'_, AppState>,\s*\) -> Result<Vec<RunSummary>, String>/,
    "list_runs Tauri signature changed",
  );
  assert.match(
    rust,
    /PluginId::new\("org\.yulab\.rho\.run-history"\)/,
    "Run History plugin ID changed",
  );
  assert.match(
    rust,
    /CapabilityId::new\("source\.project\.run-history"\)/,
    "Run History source capability changed",
  );
  assert.match(
    rust,
    /CapabilityId::new\("service\.broker\.runs"\)/,
    "Runs broker capability changed",
  );
  assert.match(
    rust,
    /\.list_runs\(&self\.project_root, arguments\.limit\)/,
    "candidate source no longer delegates exact project/limit to Store::list_runs",
  );
  assert.match(
    rust,
    /validate_project_current\(&result\.scope\)/,
    "candidate Run History no longer validates the completion generation",
  );
  assert.equal(
    (frontend.match(/if \(command === "list_runs"\)/g) ?? []).length,
    1,
    "browser mock must define exactly one list_runs handler",
  );
  assert.match(
    frontend,
    /mockRuns\.slice\(0, args\.limit \?\? 50\)/,
    "browser mock must preserve explicit zero and default only null/undefined limit",
  );
  assert.match(
    frontend,
    /invoke\("list_runs", \{ limit: 50 \}\)/,
    "Runs consumer command or argument changed",
  );
}

function fixtures() {
  return {
    rust: `
async fn list_runs(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<RunSummary>, String> {}
PluginId::new("org.yulab.rho.run-history");
CapabilityId::new("source.project.run-history");
CapabilityId::new("service.broker.runs");
store.list_runs(&self.project_root, arguments.limit);
validate_project_current(&result.scope);
`,
    frontend: `
if (command === "list_runs") {
  return structuredClone(mockRuns.slice(0, args.limit ?? 50));
}
invoke("list_runs", { limit: 50 });
`,
  };
}

function runSelfTests() {
  const valid = fixtures();
  validateRunHistoryContract(valid);
  for (const [name, mutate] of [
    ["plugin ID", (value) => { value.rust = value.rust.replace("org.yulab.rho.run-history", "wrong"); }],
    ["source capability", (value) => { value.rust = value.rust.replace("source.project.run-history", "source.wrong"); }],
    ["Store authority", (value) => { value.rust = value.rust.replace("store.list_runs(&self.project_root, arguments.limit);", "vec![];"); }],
    ["generation guard", (value) => { value.rust = value.rust.replace("validate_project_current(&result.scope);", ""); }],
    ["zero limit", (value) => { value.frontend = value.frontend.replace("args.limit ?? 50", "args.limit || 50"); }],
  ]) {
    const value = fixtures();
    mutate(value);
    assert.throws(() => validateRunHistoryContract(value), undefined, name);
  }
}

if (process.argv.includes("--test")) {
  runSelfTests();
} else {
  validateRunHistoryContract({
    rust: [
      read("desktop/src-tauri/src/main.rs"),
      read("desktop/src-tauri/src/commands/runs.rs"),
    ].join("\n"),
    frontend: read("desktop/dist/app.js"),
  });
}

console.log("extension Run History contract passed");
