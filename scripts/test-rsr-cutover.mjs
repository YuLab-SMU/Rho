import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(repositoryRoot, "desktop");
const distRoot = join(desktopRoot, "dist");

function read(path) {
  return readFileSync(join(repositoryRoot, path), "utf8");
}

function filesUnder(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(root, path) : [relative(root, path).replaceAll("\\", "/")];
  }).sort();
}

const tauri = JSON.parse(read("desktop/src-tauri/tauri.conf.json"));
assert.equal(tauri.build.frontendDist, "../dist");
assert.equal(tauri.build.beforeBuildCommand, "npm run rsr:build");
assert.equal(tauri.app.withGlobalTauri, false);
assert.equal(typeof tauri.app.security.csp, "object");
assert.equal(tauri.app.security.csp["default-src"], "'self' customprotocol: asset:");
assert.equal(tauri.app.security.csp["connect-src"], "ipc: http://ipc.localhost");
assert.equal(tauri.app.security.csp["object-src"], "'none'");
assert.equal(tauri.app.security.csp["frame-src"], "'none'");
for (const [directive, value] of Object.entries(tauri.app.security.csp)) {
  assert.doesNotMatch(value, /(?:https?:\/\/)(?!ipc\.localhost|asset\.localhost)/u, `${directive} must not allow remote hosts`);
  assert.doesNotMatch(value, /\*/u, `${directive} must not contain a wildcard`);
}

const packageJson = JSON.parse(read("desktop/package.json"));
assert.equal(packageJson.scripts["rsr:build"], "vite build --config ui/vite.config.mts");
assert.match(packageJson.scripts["rsr:check"], /rsr:test:cutover/u);
assert.doesNotMatch(packageJson.description, /current Rho shell/u);

const inventory = filesUnder(distRoot);
assert.deepEqual(
  inventory.filter((path) => path.endsWith(".html")),
  ["index.html"],
  "the generated frontend must have one HTML entry",
);
assert.ok(inventory.includes("asset-manifest.json"));
assert.equal(inventory.filter((path) => path.startsWith("assets/") && path.endsWith(".js")).length >= 1, true);
assert.equal(inventory.filter((path) => path.startsWith("assets/") && path.endsWith(".css")).length >= 1, true);
for (const obsolete of ["app.js", "styles.css", "assets/demo-plot.png", "vendor/lucide/LICENSE"]) {
  assert.equal(inventory.includes(obsolete), false, `legacy asset must be absent: ${obsolete}`);
}
for (const dependency of ["dompurify", "katex", "marked", "monaco", "papaparse"]) {
  const source = read(`desktop/legal/licenses/${dependency}/LICENSE`);
  const generated = read(`desktop/dist/licenses/${dependency}/LICENSE`);
  assert.equal(generated, source, `${dependency} license must be copied from the reviewed source asset`);
}

const index = read("desktop/dist/index.html");
assert.match(index, /<script type="module" crossorigin src="\.\/assets\/index-[A-Za-z0-9_-]+\.js"><\/script>/u);
assert.match(index, /<link rel="stylesheet" crossorigin href="\.\/assets\/index-[A-Za-z0-9_-]+\.css">/u);
assert.doesNotMatch(index, /(?:app\.js|styles\.css|https?:\/\/)/u);

const manifest = JSON.parse(read("desktop/dist/asset-manifest.json"));
assert.equal(manifest["index.html"].isEntry, true);
assert.equal(manifest["index.html"].src, "index.html");
const generatedProgram = inventory
  .filter((path) => path.endsWith(".js") || path.endsWith(".css") || path.endsWith(".html"))
  .map((path) => readFileSync(join(distRoot, path), "utf8"))
  .join("\n");
for (const obsoleteSymbol of [
  "setShellPosture",
  "data-layout-posture",
  "workbench-main",
  "agentTaskRail",
  "panel-size-control",
]) {
  assert.doesNotMatch(generatedProgram, new RegExp(obsoleteSymbol, "u"), `legacy shell symbol must be absent: ${obsoleteSymbol}`);
}

const transport = read("desktop/ui/src/transport/index.ts");
assert.match(transport, /isTauri\(\)/u);
assert.doesNotMatch(transport, /window\.__TAURI__/u);
assert.doesNotMatch(
  read("desktop/ui/src/transport/tauri.ts"),
  /["']runtime_execute["']/u,
  "the production frontend must use journal-backed runtime_execution_start/follow instead of buffered runtime_execute",
);
assert.doesNotMatch(
  read("desktop/ui/src/transport/types.ts"),
  /\bexecuteRuntime\s*\(/u,
  "the frontend transport contract must not expose the buffered execution path",
);
assert.doesNotMatch(
  read("desktop/src-tauri/src/main.rs"),
  /runtime_registry::runtime_execute/u,
  "the desktop invoke surface must not ship two Runtime output authorities",
);
assert.equal(statSync(distRoot).isDirectory(), true);

console.log("RSR production cutover contract passed");
