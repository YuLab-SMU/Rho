#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "rho-clean-git-"));
const gitDir = path.join(temporary, "snapshot.git");
run("git", ["init", "--quiet", "--bare", gitDir], {}, 60_000);
const listed = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root },
)
  .stdout.toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter(
    (relative) =>
      existsSync(path.join(root, relative)) &&
      !relative.startsWith("programs/") &&
      !relative.startsWith("target/") &&
      !relative.startsWith("desktop/dist/") &&
      !relative.startsWith("fuzz/target/") &&
      !relative.includes("/artifacts/") &&
      !relative.startsWith("test/release/") &&
      relative !== "test/security/platform/matrix-report.json",
  )
  .sort();
const pathspec = Buffer.from(`${listed.join("\0")}\0`);
const gitEnvironment = {
  GIT_DIR: gitDir,
  GIT_WORK_TREE: root,
  GIT_AUTHOR_NAME: "Rho Release Gate",
  GIT_AUTHOR_EMAIL: "release-gate@localhost",
  GIT_COMMITTER_NAME: "Rho Release Gate",
  GIT_COMMITTER_EMAIL: "release-gate@localhost",
};
run(
  "git",
  ["add", "--pathspec-from-file=-", "--pathspec-file-nul"],
  gitEnvironment,
  120_000,
  pathspec,
);
run("git", ["commit", "--quiet", "-m", "clean source snapshot"], gitEnvironment, 120_000);
const commit = run("git", ["rev-parse", "HEAD"], gitEnvironment, 60_000).stdout.trim();
const status = run(
  "git",
  ["status", "--porcelain", "--untracked-files=no"],
  gitEnvironment,
  60_000,
).stdout.trim();
if (status) throw new Error(`alternate clean source snapshot is dirty: ${status}`);

const checks = [];
for (const [name, command, args, timeout] of [
  ["rust_workspace", "cargo", ["test", "--workspace", "--locked"], 1_800_000],
  ["frontend", npmCommand(), ["--prefix", "desktop", "run", "rsr:check:full"], 900_000],
  [
    "r_runtimes",
    "Rscript",
    ["-e", "testthat::test_local('r/rho.agent'); testthat::test_local('r/rho.bridge')"],
    600_000,
  ],
  ["governance", "node", ["scripts/governance.mjs", "check"], 120_000],
  ["candidate", "node", ["scripts/candidate-release.mjs", "--test", "true"], 600_000],
]) {
  const result = run(command, args, {}, timeout);
  checks.push({ name, passed: result.status === 0 });
}
const report = {
  schema: "rho.release.clean-snapshot-gate.v1",
  result: checks.every((check) => check.passed) ? "pass" : "fail",
  temporary_commit: commit,
  tracked_source_files: listed.length,
  clean_status: true,
  checks,
};
const directory = path.join(root, "test/release");
await mkdir(directory, { recursive: true });
const output = path.join(directory, "clean-snapshot-gate.json");
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
await rm(temporary, { recursive: true, force: true });
if (report.result !== "pass") process.exit(1);
console.log(`Clean source snapshot gate passed at temporary commit ${commit.slice(0, 12)}; ${checks.length} checks; ${path.relative(root, output)}`);

function run(command, args, extraEnvironment, timeout, input = undefined) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: input ? undefined : "utf8",
    input,
    timeout,
    env: { ...process.env, ...extraEnvironment },
  });
  if (result.status !== 0) {
    const stdout = Buffer.isBuffer(result.stdout)
      ? result.stdout.toString("utf8")
      : result.stdout;
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : result.stderr;
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${stderr || stdout}`);
  }
  return result;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
