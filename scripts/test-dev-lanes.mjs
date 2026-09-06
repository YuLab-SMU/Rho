import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "dev-lanes.mjs");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(root, relativePath, content) {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function lanes(cwd, args, { expectFailure = false } = {}) {
  try {
    const stdout = execFileSync("node", [script, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    assert.equal(expectFailure, false, `expected failure: ${args.join(" ")}`);
    return { status: 0, stdout };
  } catch (error) {
    if (!expectFailure) throw error;
    assert.equal(error.status, 1, `expected exit 1: ${args.join(" ")}\n${error.stderr}`);
    return { status: error.status, stdout: (error.stdout ?? "").trim(), stderr: error.stderr ?? "" };
  }
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rho-dev-lanes-"));
const repository = path.join(temporary, "repository");
const runtimeWorktree = path.join(temporary, "runtime-worktree");
const agentWorktree = path.join(temporary, "agent-worktree");
const leasesDir = path.join(repository, ".git", "rho-dev-lanes");

try {
  fs.mkdirSync(repository);
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.name", "Rho dev-lanes fixture"]);
  git(repository, ["config", "user.email", "rho-fixture@example.invalid"]);
  write(repository, "src/runtime/a.ts", "export const runtime = 'base';\n");
  write(repository, "src/agent/b.ts", "export const agent = 'base';\n");
  write(repository, "src/shared/value.ts", "export const value = 'base';\n");
  write(repository, "Cargo.lock", "baseline lock\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "baseline"]);
  const base = git(repository, ["rev-parse", "HEAD"]);

  git(repository, ["worktree", "add", "-b", "lane-runtime", runtimeWorktree, base]);
  git(repository, ["worktree", "add", "-b", "lane-agent", agentWorktree, base]);

  // start writes leases into the shared git common dir
  const started = JSON.parse(lanes(runtimeWorktree, [
    "start", "--id", "runtime-x", "--own", "src/runtime/**", "--base", base, "--json",
  ]).stdout);
  assert.equal(started.base_commit, base);
  assert.equal(started.lane, "feature");
  assert.ok(started.shared_write_paths.includes("Cargo.lock"), "shared authority defaults recorded");
  assert.ok(started.shared_write_paths.includes("next/host/src/lib.rs"));
  assert.ok(!started.shared_write_paths.some((entry) => entry.startsWith("desktop/")));
  assert.ok(fs.existsSync(path.join(leasesDir, "runtime-x.json")), "lease lives in the git common dir");

  lanes(agentWorktree, ["start", "--id", "agent-x", "--own", "src/agent/**"]);

  // the registry is visible from every linked worktree
  const listed = JSON.parse(lanes(agentWorktree, ["list", "--json"]).stdout);
  assert.deepEqual(listed.map(({ id }) => id), ["agent-x", "runtime-x"]);
  assert.equal(listed.find(({ id }) => id === "runtime-x").stale, false);

  // no collisions between disjoint active lanes
  const clean = JSON.parse(lanes(repository, ["check", "--json"]).stdout);
  assert.deepEqual(clean.collisions, []);

  // overlapping start is a hard reject and writes no lease
  const overlap = lanes(repository, ["start", "--id", "collide", "--own", "src/**"], { expectFailure: true });
  assert.match(overlap.stderr, /overlaps active lanes/u);
  assert.equal(fs.existsSync(path.join(leasesDir, "collide.json")), false);

  // per-lane changed-file classification
  const owned = JSON.parse(lanes(runtimeWorktree, [
    "check", "--id", "runtime-x", "--changed", "src/runtime/new.ts", "--json",
  ]).stdout);
  assert.deepEqual(owned.undeclared_paths, []);
  const forbidden = lanes(runtimeWorktree, [
    "check", "--id", "runtime-x", "--changed", "Cargo.lock", "--json",
  ], { expectFailure: true });
  assert.deepEqual(JSON.parse(forbidden.stdout).forbidden_shared_paths, ["Cargo.lock"]);
  const undeclared = lanes(runtimeWorktree, [
    "check", "--id", "runtime-x", "--changed", "src/other.ts", "--json",
  ], { expectFailure: true });
  assert.deepEqual(JSON.parse(undeclared.stdout).undeclared_paths, ["src/other.ts"]);

  // the single integration lane may write shared authority files
  lanes(repository, ["start", "--id", "integ", "--integration", "--own", "docs/**"]);
  const integration = JSON.parse(lanes(repository, [
    "check", "--id", "integ", "--changed", "Cargo.lock", "--json",
  ]).stdout);
  assert.deepEqual(integration.integration_lane_paths, ["Cargo.lock"]);
  assert.deepEqual(integration.forbidden_shared_paths, []);
  lanes(repository, ["start", "--id", "integ-2", "--integration", "--own", "docs/more/**"], { expectFailure: true });

  // argument validation
  lanes(repository, ["start", "--id", "runtime-x", "--own", "src/z/**"], { expectFailure: true });
  lanes(repository, ["start", "--id", "no-own"], { expectFailure: true });
  lanes(repository, ["start", "--id", "Bad_Id", "--own", "src/z/**"], { expectFailure: true });

  // --changed-auto classifies committed, modified, and untracked work; the
  // leading space in the first porcelain status code must survive parsing
  write(runtimeWorktree, "Cargo.lock", "lane-edited lock\n");
  write(runtimeWorktree, "src/agent/b.ts", "export const agent = 'crossed';\n");
  write(runtimeWorktree, "src/runtime/a.ts", "export const runtime = 'typed-output';\n");
  write(runtimeWorktree, "src/runtime/new.ts", "export const fresh = true;\n");
  const auto = lanes(runtimeWorktree, ["check", "--id", "runtime-x", "--changed-auto", "--json"], {
    expectFailure: true,
  });
  const autoResult = JSON.parse(auto.stdout);
  assert.deepEqual(autoResult.forbidden_shared_paths, ["Cargo.lock"]);
  assert.deepEqual(autoResult.undeclared_paths, ["src/agent/b.ts"]);
  assert.ok(!autoResult.undeclared_paths.includes("src/runtime/a.ts"));
  assert.ok(!autoResult.undeclared_paths.includes("src/runtime/new.ts"));

  // merge-check reports textual conflicts and clean merges
  git(repository, ["switch", "-c", "conflict-a"]);
  write(repository, "src/shared/value.ts", "export const value = 'a';\n");
  git(repository, ["commit", "-am", "conflict a"]);
  git(repository, ["switch", "-c", "conflict-b", "main"]);
  write(repository, "src/shared/value.ts", "export const value = 'b';\n");
  git(repository, ["commit", "-am", "conflict b"]);
  const conflict = lanes(repository, [
    "merge-check", "--source", "conflict-b", "--into", "conflict-a", "--json",
  ], { expectFailure: true });
  assert.deepEqual(JSON.parse(conflict.stdout).conflicted_files, ["src/shared/value.ts"]);
  git(repository, ["switch", "-c", "disjoint", "main"]);
  write(repository, "src/runtime/a.ts", "export const runtime = 'disjoint';\n");
  git(repository, ["commit", "-am", "disjoint"]);
  const cleanMerge = JSON.parse(lanes(repository, [
    "merge-check", "--source", "disjoint", "--into", "conflict-a", "--json",
  ]).stdout);
  assert.equal(cleanMerge.clean, true);
  git(repository, ["switch", "main"]);

  // finish removes the lease; unknown ids fail check
  lanes(runtimeWorktree, ["finish", "--id", "runtime-x"]);
  assert.equal(fs.existsSync(path.join(leasesDir, "runtime-x.json")), false);
  assert.deepEqual(JSON.parse(lanes(repository, ["list", "--json"]).stdout).map(({ id }) => id), ["agent-x", "integ"]);
  const unknown = lanes(repository, ["check", "--id", "runtime-x", "--json"], { expectFailure: true });
  assert.equal(JSON.parse(unknown.stdout).unknown_work_package, true);
  lanes(repository, ["finish", "--id", "runtime-x"], { expectFailure: true });

  // back-to-back concurrent starts write two intact leases
  await Promise.all([
    execFileAsync("node", [script, "start", "--id", "para-1", "--own", "src/p1/**"], { cwd: repository }),
    execFileAsync("node", [script, "start", "--id", "para-2", "--own", "src/p2/**"], { cwd: repository }),
  ]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(leasesDir, "para-1.json"), "utf8")).id, "para-1");
  assert.equal(JSON.parse(fs.readFileSync(path.join(leasesDir, "para-2.json"), "utf8")).id, "para-2");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log("Dev lanes enforce disjoint ownership, shared-authority writes, and merge conflicts across worktrees");
