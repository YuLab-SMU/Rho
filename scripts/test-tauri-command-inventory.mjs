import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const EXPECTED_HANDLER_DIGEST = "022bb6634bc601b9f963db4f6c85c3d6e3e2b65f81217000c9ba80a8eb26705b";

const RUN_COMMANDS = [
  "audit_reproducibility",
  "compare_runs",
  "get_run_detail",
  "list_problems",
  "list_runs",
];

const PLUGIN_COMMANDS = [
  "get_plugin_permission_request",
  "invoke_plugin_command",
  "list_plugin_contributions",
  "list_plugin_grants",
  "list_plugin_permission_requests",
  "list_workspace_plugins",
  "open_plugin_viewer",
  "request_workspace_plugin_enable",
  "respond_plugin_permission",
  "revoke_plugin_grant",
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

function occurrences(value, pattern) {
  return value.match(pattern)?.length ?? 0;
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

  const runSource = sources.find(({ name }) => name.endsWith("commands/runs.rs"));
  assert.ok(runSource, "Runs command module is missing");
  assert.deepEqual(
    commandDefinitions([runSource]).map(({ name }) => name).sort(),
    RUN_COMMANDS,
    "Runs command module ownership changed",
  );
  for (const command of RUN_COMMANDS) {
    assert.equal(
      occurrences(frontend, new RegExp(`command === ["']${command}["']`, "g")),
      1,
      `browser mock must define exactly one ${command} handler`,
    );
  }

  const pluginSource = sources.find(({ name }) => name.endsWith("commands/plugins.rs"));
  assert.ok(pluginSource, "Workspace Plugins command module is missing");
  assert.deepEqual(
    commandDefinitions([pluginSource]).map(({ name }) => name).sort(),
    PLUGIN_COMMANDS,
    "Workspace Plugins command module ownership changed",
  );
  for (const command of PLUGIN_COMMANDS) {
    assert.equal(
      occurrences(frontend, new RegExp(`command === ["']${command}["']`, "g")),
      1,
      `browser mock must define exactly one ${command} handler`,
    );
  }

  return { commands: definitionNames.length, sources: sources.length };
}

function fixtures() {
  const pluginHandlers = PLUGIN_COMMANDS.map(
    (command) => `  commands::plugins::${command},`,
  ).join("\n");
  const main = `
#[tauri::command]
async fn app_info() {}
.invoke_handler(tauri::generate_handler![
  app_info,
${pluginHandlers}
  commands::runs::list_runs,
  commands::runs::list_problems,
  commands::runs::get_run_detail,
  commands::runs::compare_runs,
  commands::runs::audit_reproducibility,
])`;
  const runs = RUN_COMMANDS.map(
    (command) => `#[tauri::command]\npub(crate) async fn ${command}() {}`,
  ).join("\n");
  return {
    sources: [
      { name: "main.rs", text: main },
      { name: "commands/runs.rs", text: runs },
      { name: "commands/plugins.rs", text: PLUGIN_COMMANDS.map(
        (command) => `#[tauri::command]\npub(crate) async fn ${command}() {}`,
      ).join("\n") },
    ],
    main,
    frontend: RUN_COMMANDS.map(
      (command) => `if (command === "${command}") return {};`,
    ).concat(PLUGIN_COMMANDS.map(
      (command) => `if (command === "${command}") return {};`,
    )).join("\n"),
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
  missingMock.frontend = missingMock.frontend.replace(
    'if (command === "compare_runs") return {};',
    "",
  );
  assert.throws(
    () => validateCommandInventory(missingMock),
    /browser mock must define exactly one compare_runs handler/,
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
  const sourceRoot = path.join("desktop", "src-tauri", "src");
  const files = rustFiles(sourceRoot);
  const sources = files.map((name) => ({ name, text: fs.readFileSync(name, "utf8") }));
  const main = fs.readFileSync(path.join(sourceRoot, "main.rs"), "utf8");
  const frontend = fs.readFileSync(path.join("desktop", "dist", "app.js"), "utf8");
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
