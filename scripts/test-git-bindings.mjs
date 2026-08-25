import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(repositoryRoot, "scripts/generate-git-bindings.mjs");
const generatedPath = path.join(repositoryRoot, "desktop/ui/src/transport/generated/git.ts");
const commands = ["git_status", "git_log"];

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

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rho-git-bindings-test-"));
try {
  const first = path.join(temporaryDirectory, "first.ts");
  const second = path.join(temporaryDirectory, "second.ts");
  generate(first);
  generate(second);
  const firstBytes = fs.readFileSync(first);
  assert.deepEqual(firstBytes, fs.readFileSync(second), "two clean Git generations differ");
  assert.deepEqual(firstBytes, fs.readFileSync(generatedPath), "checked-in Git bindings are stale");
  fs.appendFileSync(first, "// stale fixture\n");
  assert.throws(() => generate(first, true), /Command failed/);

  const generated = fs.readFileSync(generatedPath, "utf8");
  const tauri = fs.readFileSync(path.join(repositoryRoot, "desktop/ui/src/transport/tauri.ts"), "utf8");
  const facet = fs.readFileSync(path.join(repositoryRoot, "desktop/ui/src/transport/git.ts"), "utf8");
  assert.match(generated, /gitStatus: \(\)/);
  assert.match(generated, /gitLog: \(limit: number \| null\)/);
  assert.match(generated, /untracked: number/);
  assert.match(generated, /message: string/);
  assert.match(facet, /export interface GitReadTransport/);
  assert.match(tauri, /const gitTransport = createTauriGitReadTransport\(invoke\)/);
  for (const command of commands) {
    assert.equal(count(generated, `"${command}"`), 1);
    assert.equal(count(tauri, `"${command}"`), 0);
  }
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log("Git generated read contract passed");
