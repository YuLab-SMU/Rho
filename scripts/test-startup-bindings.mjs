import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(repositoryRoot, "scripts/generate-startup-bindings.mjs");
const generatedPath = path.join(repositoryRoot, "desktop/ui/src/transport/generated/startup.ts");
const commands = ["startup_bootstrap", "startup_choose_rscript", "workspace_start"];

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

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rho-startup-bindings-test-"));
try {
  const first = path.join(temporaryDirectory, "first.ts");
  const second = path.join(temporaryDirectory, "second.ts");
  generate(first);
  generate(second);
  const firstBytes = fs.readFileSync(first);
  assert.deepEqual(firstBytes, fs.readFileSync(second), "two clean Startup generations differ");
  assert.deepEqual(firstBytes, fs.readFileSync(generatedPath), "checked-in Startup bindings are stale");
  fs.appendFileSync(first, "// stale fixture\n");
  assert.throws(() => generate(first, true), /Command failed/);

  const generated = fs.readFileSync(generatedPath, "utf8");
  const tauri = fs.readFileSync(path.join(repositoryRoot, "desktop/ui/src/transport/tauri.ts"), "utf8");
  const facet = fs.readFileSync(path.join(repositoryRoot, "desktop/ui/src/transport/startup.ts"), "utf8");
  assert.match(generated, /startupBootstrap: \(\)/);
  assert.match(generated, /startupChooseRscript: \(\)/);
  assert.match(generated, /workspaceStart: \(\)/);
  assert.match(generated, /severity: StartupSeverity/);
  assert.match(generated, /kernel_pid: number \| null/);
  assert.match(generated, /workspace: unknown/);
  assert.match(facet, /export interface StartupTransport/);
  assert.match(tauri, /const startupTransport = createTauriStartupTransport\(invoke\)/);
  for (const command of commands) {
    assert.equal(count(generated, `"${command}"`), 1);
    assert.equal(count(tauri, `"${command}"`), 0);
  }
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log("Startup generated binding contract passed");
