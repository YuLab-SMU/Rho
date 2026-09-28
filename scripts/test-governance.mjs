import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DocumentationMapError,
  checkDocumentationIndexes,
  documentationImpact,
  generateDocumentationIndexes,
  validateDocumentationMap,
} from "./governance.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "governance.mjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rho-doc-map-"));
  const registry = {
    schema_version: 1,
    pages: [
      { id: "DOCS", title: "Documentation map", document: "docs/README.md", area: "documentation" },
      { id: "CORE", title: "Core runtime", document: "docs/CORE.md", area: "core" },
      { id: "UI", title: "Desktop UI", document: "docs/UI.md", area: "ui" },
    ],
  };
  const sourceMap = {
    schema_version: 1,
    checks: {
      "check-core": { command: ["node", "scripts/check core.mjs"], tier: "L1" },
      "check-shared": { command: ["node", "scripts/check-shared.mjs"], tier: "L0" },
      "check-ui": { command: ["npm", "test", "--", "ui"], tier: "L1" },
    },
    areas: {
      core: { sources: ["src/core/**", "Cargo.toml"], checks: ["check-core", "check-shared"] },
      documentation: { sources: ["docs/**", "governance/**"], checks: [] },
      ui: { sources: ["desktop/ui/**", "Cargo.toml"], checks: ["check-ui", "check-shared"] },
    },
  };
  const write = (name, content) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write("governance/registry.json", `${JSON.stringify(registry, null, 2)}\n`);
  write("governance/source-map.json", `${JSON.stringify(sourceMap, null, 2)}\n`);
  for (const page of registry.pages) write(page.document, `# ${page.title}\n`);
  write("src/core/lib.rs", "fn core() {}\n");
  write("desktop/ui/main.ts", "export {};\n");
  write("Cargo.toml", "[workspace]\n");
  return { root, registry, sourceMap, write };
}

function withFixture(callback) {
  const value = fixture();
  try { callback(value); } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
}

function mapError(callback, pattern) {
  assert.throws(callback, (error) => error instanceof DocumentationMapError && error.errors.some((item) => pattern.test(item)));
}

function rewrite(value, name, data) {
  value.write(name, `${JSON.stringify(data, null, 2)}\n`);
}

withFixture((value) => {
  const context = validateDocumentationMap(value.root);
  assert.deepEqual(context.pages.map((page) => page.id), ["CORE", "DOCS", "UI"]);
  mapError(() => checkDocumentationIndexes(value.root), /generated file is missing/u);
  assert.deepEqual(generateDocumentationIndexes(value.root).generated, ["docs/INDEX.md", "docs/SOURCE-INDEX.md"]);
  checkDocumentationIndexes(value.root);
  assert.match(
    fs.readFileSync(path.join(value.root, "docs/SOURCE-INDEX.md"), "utf8"),
    /\["node","scripts\/check core\.mjs"\]/u,
  );
  const impact = documentationImpact(context, ["unknown.txt", "src/core/lib.rs", "Cargo.toml"]);
  assert.deepEqual(impact.areas, ["core", "ui"]);
  assert.deepEqual(impact.pages, ["CORE", "UI"]);
  assert.deepEqual(impact.checks.map((check) => check.id), ["check-core", "check-shared", "check-ui"]);
  assert.deepEqual(impact.unmapped, ["unknown.txt"]);
  fs.appendFileSync(path.join(value.root, "docs/INDEX.md"), "stale\n");
  mapError(() => checkDocumentationIndexes(value.root), /generated file is stale/u);
});

for (const [mutate, pattern] of [
  [(value) => { value.registry.schema_version = 2; }, /schema_version must be 1/u],
  [(value) => { value.registry.pages.push({ ...value.registry.pages[0] }); }, /duplicate page id DOCS/u],
  [(value) => { value.registry.pages[0].area = "missing"; }, /references unknown area missing/u],
  [(value) => { value.registry.pages[0].max_lines = 0; }, /max_lines must be a positive integer/u],
  [(value) => { value.registry.pages[0].max_lines = 1; value.write(value.registry.pages[0].document, "a\nb\n"); }, /exceeds max_lines 1/u],
  [(value) => { value.registry.pages[0].max_lines = 1; value.write(value.registry.pages[0].document, "a\nb"); }, /exceeds max_lines 1/u],
  [(value) => { value.sourceMap.areas.core.checks.push("missing"); }, /references unknown check missing/u],
  [(value) => { delete value.sourceMap.checks["check-core"].tier; }, /missing field tier/u],
  [(value) => { value.sourceMap.checks["check-core"].tier = "fast"; }, /tier must be L0, L1, L2 or L3/u],
  [(value) => { value.sourceMap.checks["check-core"].sources = []; }, /sources must not be empty/u],
  [(value) => { value.sourceMap.checks["check-core"].sources = ["../outside/**"]; }, /invalid path/u],
  [(value) => { value.sourceMap.checks["check-core"].sources = ["removed/**"]; }, /pattern matches no file/u],
  [(value) => { value.sourceMap.areas.core.sources.push("removed/**"); }, /pattern matches no file/u],
  [(value) => { value.sourceMap.areas.core.sources.push("Cargo.toml"); }, /duplicate value Cargo\.toml/u],
]) withFixture((value) => {
  mutate(value);
  rewrite(value, "governance/registry.json", value.registry);
  rewrite(value, "governance/source-map.json", value.sourceMap);
  mapError(() => validateDocumentationMap(value.root), pattern);
});

for (const content of ["", "a", "a\n"]) withFixture((value) => {
  value.registry.pages[0].max_lines = 1;
  value.write(value.registry.pages[0].document, content);
  rewrite(value, "governance/registry.json", value.registry);
  assert.doesNotThrow(() => validateDocumentationMap(value.root));
});

withFixture((value) => {
  fs.unlinkSync(path.join(value.root, "docs/README.md"));
  mapError(() => validateDocumentationMap(value.root), /document does not exist/u);
});

withFixture((value) => {
  value.sourceMap.checks["check-core"].sources = ["src/core/**"];
  value.sourceMap.checks["check-shared"].tier = "L2";
  value.sourceMap.checks["check-ui"].tier = "L3";
  rewrite(value, "governance/source-map.json", value.sourceMap);
  const context = validateDocumentationMap(value.root);
  const iteration = documentationImpact(context, ["src/core/lib.rs", "Cargo.toml"]);
  assert.deepEqual(iteration.checks.map(c => c.id), ["check-core"]);
  assert.deepEqual(iteration.deferred, [{id: "check-shared", tier: "L2"}, {id: "check-ui", tier: "L3"}]);
  assert.ok(iteration.deferred.every(c => !Object.hasOwn(c, "command")));
  assert.deepEqual(documentationImpact(context, ["Cargo.toml"]).checks, []);
  assert.deepEqual(documentationImpact(context, ["src/core/lib.rs", "Cargo.toml"], "milestone").checks.map(c => c.id), ["check-core", "check-shared"]);
  assert.deepEqual(documentationImpact(context, ["src/core/lib.rs", "Cargo.toml"], "audit").checks.map(c => c.id), ["check-core", "check-shared", "check-ui"]);
  mapError(() => documentationImpact(context, [], "everything"), /Unknown phase/u);
});

withFixture((value) => {
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: value.root, encoding: "utf8" });
  let result = run(["generate", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).generated, ["docs/INDEX.md", "docs/SOURCE-INDEX.md"]);
  result = run(["check"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Documentation map valid/u);
  result = run(["impact", "--changed", "src/core/lib.rs", "Cargo.toml", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).areas, ["core", "ui"]);
  assert.equal(JSON.parse(result.stdout).phase, "iteration");
  result = run(["impact", "--changed", "src/core/lib.rs", "--phase", "milestone", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).phase, "milestone");
  for (const args of [["check", "--phase", "audit"], ["impact", "--changed", "src/core/lib.rs", "--phase", "typo"]]) {
    assert.notEqual(run(args).status, 0);
  }

  fs.rmSync(path.join(value.root, ".git"), { recursive: true, force: true });
  for (const args of [["init", "-q"], ["config", "user.email", "docs@example.invalid"],
    ["config", "user.name", "Docs"], ["add", "."], ["commit", "-qm", "fixture"]]) {
    const git = spawnSync("git", args, { cwd: value.root, encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
  }
  fs.appendFileSync(path.join(value.root, "src/core/lib.rs"), "fn changed() {}\n");
  value.write("unmapped/new.txt", "new\n");
  result = run(["impact", "--changed-auto", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).unmapped, ["unmapped/new.txt"]);
});

// Regression for the real map: a local Agent edit formerly listed every plugin
// suite, including independent builds and the workspace audit.
{
  const context = validateDocumentationMap(path.resolve(path.dirname(SCRIPT), '..'));
  const agent = documentationImpact(context, ['plugins/agent/backend/src/server.rs']);
  assert.ok(agent.checks.some(c => c.id === 'plugins.agent-backend'));
  assert.ok(!agent.checks.some(c => ['plugins.agent-owner', 'plugins.agent-store', 'plugins.agent-engine'].includes(c.id)));
  assert.ok(agent.checks.every(c => ['L0', 'L1'].includes(c.tier)));
  assert.ok(!agent.checks.some(c => c.id.startsWith('plugins.files-') || c.command.includes('--workspace')));
  assert.ok(agent.deferred.some(c => c.id === 'plugins.agent-host'));
  const milestone = documentationImpact(context, ['plugins/agent/backend/src/server.rs'], 'milestone');
  assert.ok(milestone.checks.some(c => c.id === 'plugins.agent-host'));
  assert.ok(!milestone.checks.some(c => c.command.includes('--workspace')));
  const files = documentationImpact(context, ['plugins/files/backend/src/lib.rs']);
  assert.ok(!files.checks.some(c => c.id === 'plugins.agent-backend'));
  const tooling = documentationImpact(context, ['scripts/test-governance.mjs']);
  assert.deepEqual(tooling.checks.map(c => c.id), ['docs.tool']);
  const runner = documentationImpact(context, ['scripts/test-agent-plugin.mjs']);
  assert.deepEqual(runner.checks.map(c => c.id), ['plugins.agent-workflow']);
}
console.log("Documentation indexes, source integrity, phase separation, and scoped impact mapping passed");
