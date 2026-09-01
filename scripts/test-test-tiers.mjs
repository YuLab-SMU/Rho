#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { documentationImpact, validateDocumentationMap } from "./governance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "desktop/package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};
const required = (name) => {
  const value = scripts[name];
  assert.equal(typeof value, "string", `missing npm test tier ${name}`);
  assert.ok(value.length > 0, `empty npm test tier ${name}`);
  return value;
};

const inner = required("rsr:check");
for (const fastGate of [
  "rsr:typecheck",
  "rsr:lint",
  "rsr:test:bindings:static",
  "rsr:test:commands",
  "rsr:test:generated-transport-boundary",
  "rsr:test:contract",
  "rsr:test:fast",
]) {
  assert.match(inner, new RegExp(`npm run ${fastGate}(?: |$)`, "u"), `inner tier lost ${fastGate}`);
}
for (const slowGate of [
  "rsr:test:bindings ",
  "rsr:test &&",
  "rsr:build",
  "rsr:test:browser",
  "rsr:test:interactions",
  "rsr:test:visual-acceptance",
  "rsr:test:production-invariants",
]) {
  assert.ok(!inner.includes(slowGate), `inner tier must not include ${slowGate.trim()}`);
}

const full = required("rsr:check:full");
for (const gate of ["rsr:test:bindings", "rsr:test", "rsr:build", "rsr:test:assets"]) {
  assert.match(full, new RegExp(`npm run ${gate}(?: |$)`, "u"), `pre-handoff tier lost ${gate}`);
}
for (const acceptanceGate of ["rsr:test:browser", "rsr:test:interactions", "rsr:test:visual-acceptance"]) {
  assert.ok(!full.includes(acceptanceGate), `pre-handoff tier must not include ${acceptanceGate}`);
}

const acceptance = required("rsr:acceptance");
for (const gate of ["rsr:test:browser", "rsr:test:interactions", "rsr:test:visual-acceptance"]) {
  assert.match(acceptance, new RegExp(`npm run ${gate}(?: |$)`, "u"), `acceptance tier lost ${gate}`);
}
const release = required("rsr:release");
assert.match(release, /npm run rsr:check:full/u);
assert.match(release, /npm run rsr:test:production-invariants/u);
assert.match(release, /npm run rsr:acceptance/u);
assert.match(release, /npm run rsr:test:release-contracts/u);

const fastConfig = fs.readFileSync(path.join(root, "desktop/ui/vitest.fast.config.mts"), "utf8");
for (const demotedSuite of [
  "src/app/App.test.tsx",
  "src/app/agent/AgentSurface.test.tsx",
  "src/acceptance/**",
]) {
  assert.ok(fastConfig.includes(demotedSuite), `fast Vitest tier must exclude ${demotedSuite}`);
}
assert.ok(
  !fs.existsSync(path.join(root, "scripts/test-rsr-cutover.mjs")),
  "historical RSR cutover proof must not return to the active test inventory",
);

const sourceMap = validateDocumentationMap(root);
const checksFor = (file) => documentationImpact(sourceMap, [file]).checks.map(({ id }) => id);
assert.deepEqual(checksFor("desktop/ui/src/app/App.tsx"), ["frontend"]);
assert.deepEqual(checksFor("desktop/src-tauri/src/main.rs"), ["frontend.contracts", "rust.desktop"]);
assert.deepEqual(checksFor("crates/rho-agent-host/src/lib.rs"), ["rust.agent"]);
assert.deepEqual(checksFor("crates/rho-execution/src/lib.rs"), ["rust.execution"]);

console.log("Test tiers keep focused feedback separate from integration, acceptance, and release evidence");
