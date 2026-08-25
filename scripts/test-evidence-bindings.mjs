import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(repositoryRoot, "scripts/generate-evidence-bindings.mjs");
const generatedPath = path.join(repositoryRoot, "desktop/ui/src/transport/generated/evidence.ts");
const command = "list_evidence_claims";

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

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rho-evidence-bindings-test-"));
try {
  const first = path.join(temporaryDirectory, "first.ts");
  const second = path.join(temporaryDirectory, "second.ts");
  generate(first);
  generate(second);
  const firstBytes = fs.readFileSync(first);
  assert.deepEqual(firstBytes, fs.readFileSync(second), "two clean Evidence generations differ");
  assert.deepEqual(firstBytes, fs.readFileSync(generatedPath), "checked-in Evidence bindings are stale");
  fs.appendFileSync(first, "// stale fixture\n");
  assert.throws(() => generate(first, true), /Command failed/);

  const generated = fs.readFileSync(generatedPath, "utf8");
  const tauri = fs.readFileSync(path.join(repositoryRoot, "desktop/ui/src/transport/tauri.ts"), "utf8");
  const facet = fs.readFileSync(path.join(repositoryRoot, "desktop/ui/src/transport/evidence.ts"), "utf8");
  assert.match(generated, /listEvidenceClaims: \(limit: number \| null\)/);
  assert.match(generated, /start_line: number \| null/);
  assert.match(generated, /linked_evidence_ids: number\[\]/);
  assert.match(facet, /export interface EvidenceReadTransport/);
  assert.match(tauri, /const evidenceTransport = createTauriEvidenceReadTransport\(invoke\)/);
  assert.equal(count(generated, `"${command}"`), 1);
  assert.equal(count(tauri, `"${command}"`), 0);
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log("Evidence generated read contract passed");
