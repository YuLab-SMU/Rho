#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "desktop");
const dist = join(desktop, "dist");
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");
const filesUnder = (directory, base = directory) => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const absolute = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(absolute, base) : [relative(base, absolute).replaceAll("\\", "/")];
  })
  .sort();

const tauri = JSON.parse(read("desktop/src-tauri/tauri.conf.json"));
assert.equal(tauri.build.frontendDist, "../dist");
assert.equal(tauri.build.beforeBuildCommand, "npm run rsr:build");
assert.equal(tauri.app.withGlobalTauri, false);
const csp = tauri.app.security.csp;
assert.equal(typeof csp, "object");
assert.equal(csp["default-src"], "'self' customprotocol: asset:");
assert.equal(csp["connect-src"], "ipc: http://ipc.localhost");
assert.equal(csp["object-src"], "'none'");
assert.equal(csp["frame-src"], "'none'");
for (const [directive, value] of Object.entries(csp)) {
  assert.doesNotMatch(value, /(?:https?:\/\/)(?!ipc\.localhost|asset\.localhost)/u, `${directive} allows a remote host`);
  assert.doesNotMatch(value, /\*/u, `${directive} contains a wildcard`);
}

const inventory = filesUnder(dist);
assert.deepEqual(inventory.filter((file) => file.endsWith(".html")), ["index.html"]);
assert.ok(inventory.includes("asset-manifest.json"));
assert.ok(inventory.some((file) => file.startsWith("assets/") && file.endsWith(".js")));
assert.ok(inventory.some((file) => file.startsWith("assets/") && file.endsWith(".css")));
for (const dependency of ["dompurify", "katex", "marked", "monaco", "papaparse"]) {
  assert.equal(
    read(`desktop/dist/licenses/${dependency}/LICENSE`),
    read(`desktop/legal/licenses/${dependency}/LICENSE`),
    `${dependency} generated license differs from its reviewed source`,
  );
}

const index = read("desktop/dist/index.html");
assert.match(index, /<script type="module" crossorigin src="\.\/assets\/index-[A-Za-z0-9_-]+\.js"><\/script>/u);
assert.match(index, /<link rel="stylesheet" crossorigin href="\.\/assets\/index-[A-Za-z0-9_-]+\.css">/u);
assert.doesNotMatch(index, /https?:\/\//u);
const manifest = JSON.parse(read("desktop/dist/asset-manifest.json"));
assert.equal(manifest["index.html"].isEntry, true);
assert.equal(manifest["index.html"].src, "index.html");

const generatedProgram = inventory
  .filter((file) => /\.(?:js|css|html)$/u.test(file))
  .map((file) => readFileSync(join(dist, file), "utf8"))
  .join("\n");
assert.doesNotMatch(generatedProgram, /AGENT_UX_SUCCESS_FIXTURE/u);
for (const marker of ["Autonomous goal loop", "Goal-driven scientific work"]) {
  assert.match(generatedProgram, new RegExp(marker, "u"), `production bundle is missing ${marker}`);
}

const app = read("desktop/ui/src/app/App.tsx");
for (const marker of ["createStartupController", "StartupLedgerView", "WorkbenchRoot"]) {
  assert.match(app, new RegExp(marker, "u"), `production App is missing ${marker}`);
}
assert.doesNotMatch(app, /AGENT_UX_SUCCESS_FIXTURE|AgentSurfaceVNext/u);
assert.doesNotMatch(read("desktop/ui/src/app/agent/AgentSurface.tsx"), /className=["']rho-agent-mode["']/u);

const transport = read("desktop/ui/src/transport/index.ts");
assert.match(transport, /isTauri\(\)/u);
assert.doesNotMatch(transport, /window\.__TAURI__/u);
assert.doesNotMatch(read("desktop/ui/src/transport/types.ts"), /\bexecuteRuntime\s*\(/u);
assert.doesNotMatch(read("desktop/src-tauri/src/main.rs"), /runtime_registry::runtime_execute/u);
assert.equal(statSync(dist).isDirectory(), true);

console.log("Production invariants passed: local bundle, CSP, licenses, Workbench root, Agent transport, and authority boundaries");
