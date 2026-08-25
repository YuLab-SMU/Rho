import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(repositoryRoot, "scripts/generate-history-bindings.mjs");
const generatedPath = path.join(repositoryRoot, "desktop/ui/src/transport/generated/history.ts");
const commands = [
  "list_runs",
  "list_artifact_records",
  "list_problems",
  "list_plot_artifacts",
  "read_plot_artifact",
];

function count(text, needle) {
  return text.split(needle).length - 1;
}

function generate(outputPath, check = false) {
  const args = [generator, "--output", outputPath];
  if (check) args.push("--check");
  execFileSync(process.execPath, args, {
    cwd: repositoryRoot,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rho-history-bindings-test-"));
try {
  const first = path.join(temporaryDirectory, "first.ts");
  const second = path.join(temporaryDirectory, "second.ts");
  generate(first);
  generate(second);
  const firstBytes = fs.readFileSync(first);
  assert.deepEqual(firstBytes, fs.readFileSync(second), "two clean History generations differ");
  assert.deepEqual(firstBytes, fs.readFileSync(generatedPath), "checked-in History bindings are stale");
  fs.appendFileSync(first, "// stale fixture\n");
  assert.throws(() => generate(first, true), /Command failed/);

  const generated = fs.readFileSync(generatedPath, "utf8");
  const tauri = fs.readFileSync(path.join(repositoryRoot, "desktop/ui/src/transport/tauri.ts"), "utf8");
  const types = fs.readFileSync(path.join(repositoryRoot, "desktop/ui/src/transport/types.ts"), "utf8");
  const facet = fs.readFileSync(path.join(repositoryRoot, "desktop/ui/src/transport/history.ts"), "utf8");
  assert.match(generated, /listRuns: \(limit: number \| null\)/);
  assert.match(generated, /document_version: number \| null/);
  assert.match(generated, /project_revision_after: number \| null/);
  assert.match(generated, /line_number: number \| null/);
  assert.match(facet, /export interface HistoryReadTransport/);
  assert.match(tauri, /const historyTransport = createTauriHistoryReadTransport\(invoke\)/);
  for (const command of commands) {
    assert.equal(count(generated, `"${command}"`), 1);
    assert.equal(count(tauri, `"${command}"`), 0);
  }
  assert.doesNotMatch(types, /export interface PlotImageView\b/);
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log("History and artifact generated read contract passed");
