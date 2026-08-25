import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkOverlap } from "./architecture-program.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(root, relativePath, content) {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(
  git(repositoryRoot, ["ls-files", "--", "desktop/dist"]),
  "",
  "desktop/dist must not be committed source",
);
git(repositoryRoot, ["check-ignore", "-q", "desktop/dist/index.html"]);
const tauri = JSON.parse(fs.readFileSync(
  path.join(repositoryRoot, "desktop/src-tauri/tauri.conf.json"),
  "utf8",
));
const frontend = JSON.parse(fs.readFileSync(
  path.join(repositoryRoot, "desktop/package.json"),
  "utf8",
));
assert.equal(tauri.build.beforeBuildCommand, "npm run rsr:build");
assert.equal(tauri.build.frontendDist, "../dist");
assert.equal(frontend.scripts["rsr:build"], "vite build --config ui/vite.config.mts");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rho-worktree-integration-"));
const repository = path.join(temporary, "repository");
const runtimeWorktree = path.join(temporary, "runtime-worktree");
const agentWorktree = path.join(temporary, "agent-worktree");

try {
  fs.mkdirSync(repository);
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.name", "Rho integration fixture"]);
  git(repository, ["config", "user.email", "rho-fixture@example.invalid"]);
  write(repository, "src/runtime.ts", "export const runtime = 'base';\n");
  write(repository, "src/agent.ts", "export const agent = 'base';\n");
  write(repository, "Cargo.lock", "baseline lock\n");
  write(repository, "NEWS.md", "# Fixture NEWS\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "baseline"]);
  const base = git(repository, ["rev-parse", "HEAD"]);

  git(repository, ["worktree", "add", "-b", "runtime-package", runtimeWorktree, base]);
  git(repository, ["worktree", "add", "-b", "agent-package", agentWorktree, base]);
  write(runtimeWorktree, "src/runtime.ts", "export const runtime = 'typed-output';\n");
  git(runtimeWorktree, ["add", "src/runtime.ts"]);
  git(runtimeWorktree, ["commit", "-m", "runtime package"]);
  write(agentWorktree, "src/agent.ts", "export const agent = 'context-receipt';\n");
  git(agentWorktree, ["add", "src/agent.ts"]);
  git(agentWorktree, ["commit", "-m", "agent package"]);

  assert.equal(git(repository, ["diff", "--name-only", `${base}..runtime-package`]), "src/runtime.ts");
  assert.equal(git(repository, ["diff", "--name-only", `${base}..agent-package`]), "src/agent.ts");
  const mergedTree = git(repository, [
    "merge-tree",
    "--write-tree",
    "runtime-package",
    "agent-package",
  ]);
  assert.match(mergedTree, /^[0-9a-f]{40,64}$/u);

  git(repository, ["switch", "-c", "integration", "runtime-package"]);
  git(repository, ["merge", "--no-ff", "agent-package", "-m", "integrate feature packages"]);
  write(repository, "Cargo.lock", "integration-owned lock\n");
  write(repository, "NEWS.md", "# Fixture NEWS\n\nRuntime and Agent packages integrated.\n");
  git(repository, ["add", "Cargo.lock", "NEWS.md"]);
  git(repository, ["commit", "-m", "integration-owned shared files"]);
  assert.deepEqual(
    git(repository, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).split("\n"),
    ["Cargo.lock", "NEWS.md"],
  );
  const mergeCommit = git(repository, ["rev-parse", "HEAD^"]);
  assert.equal(git(repository, ["rev-list", "--parents", "-n", "1", mergeCommit]).split(" ").length, 3);

  write(repository, "src/shared/value.ts", "export {};\n");
  const collision = checkOverlap([
    { id: "AM-W1-01", status: "active", owned_paths: ["src/shared/**"] },
    { id: "AM-W2-01", status: "active", owned_paths: ["src/**"] },
  ], { root: repository });
  assert.equal(collision.collisions.length, 1);
  assert.deepEqual(collision.collisions[0].packages, ["AM-W1-01", "AM-W2-01"]);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log("Disjoint Runtime/Agent worktrees merge cleanly and shared files stay integration-owned");
