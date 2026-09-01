import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(repositoryRoot, "scripts/generate-check-bindings.mjs");
const generatedPath = path.join(repositoryRoot, "desktop/ui/src/transport/generated/check.ts");
const commands = ["check_project_run", "check_result"];

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

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rho-check-bindings-test-"));
try {
  const first = path.join(temporaryDirectory, "first.ts");
  const second = path.join(temporaryDirectory, "second.ts");
  generate(first);
  generate(second);
  const firstBytes = fs.readFileSync(first);
  assert.deepEqual(firstBytes, fs.readFileSync(second), "two clean Check generations differ");
  assert.deepEqual(firstBytes, fs.readFileSync(generatedPath), "checked-in Check bindings are stale");
  fs.appendFileSync(first, "// stale fixture\n");
  assert.throws(() => generate(first, true), /Command failed/);

  const generated = fs.readFileSync(generatedPath, "utf8");
  const tauri = fs.readFileSync(path.join(repositoryRoot, "desktop/ui/src/transport/tauri.ts"), "utf8");
  const types = fs.readFileSync(path.join(repositoryRoot, "desktop/ui/src/transport/types.ts"), "utf8");
  const facet = fs.readFileSync(path.join(repositoryRoot, "desktop/ui/src/transport/check.ts"), "utf8");
  const mock = fs.readFileSync(path.join(repositoryRoot, "desktop/ui/src/transport/mock.ts"), "utf8");

  assert.match(generated, /import type \{ ProjectId, SurfaceOriginV1 \} from "\.\/surface-studio"/);
  assert.match(generated, /checkProjectRun: \(request: CheckRunRequest\)/);
  assert.match(generated, /checkResult: \(request: CheckResultRequest\)/);
  assert.match(generated, /column: number \| null/);
  assert.match(generated, /activation_generation: number/);
  assert.match(generated, /references: FindingReferenceV1\[\]/);
  assert.match(facet, /readonly contract: "rho\.ui\.check-result\.v1"/);
  assert.match(facet, /readonly contract: "rho\.ui\.check-project\.snapshot\.v1"/);
  assert.match(facet, /export interface CheckTransport/);
  assert.match(tauri, /\.\.\.createTauriCheckTransport\(invoke\)/);
  for (const command of commands) {
    assert.equal(count(generated, `"${command}"`), 1);
    assert.equal(count(tauri, `"${command}"`), 0);
  }
  for (const name of [
    "CheckSeverity",
    "CheckResultStatus",
    "FindingReference",
    "CheckFinding",
    "CheckProjectSnapshot",
    "CheckResult",
    "CheckRunRequest",
    "CheckResultRequest",
    "CheckRunResponse",
  ]) {
    assert.doesNotMatch(types, new RegExp(`export (?:interface|type) ${name}\\b`));
  }
  for (const method of ["runCheckProject", "loadCheckResult"]) {
    assert.match(facet, new RegExp(`\\b${method}\\b`));
    assert.match(mock, new RegExp(`\\b${method}\\b`));
  }
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log("Check generated binding contract passed");
