#!/usr/bin/env node

// Lightweight parallel-development lane registry. Lane leases live in the git
// common dir (shared by every linked worktree, never committed) and only
// three conditions are hard rejects: real owned-path overlap between active
// lanes, feature-lane writes to shared authority files, and textual merge
// conflicts before integration. Overlap semantics live in the standalone
// path-ownership module.

import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { checkOverlap, normalizePath } from "./path-ownership.mjs";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

// Shared authority files are single-writer (integration lane) by default. A
// lane that explicitly --owns one of these paths is exempt, and the overlap
// check then prevents any second lane from owning it.
const SHARED_AUTHORITY_PATHS = [
  "Cargo.lock",
  "desktop/package-lock.json",
  "desktop/src-tauri/tauri.conf.json",
  "desktop/src-tauri/src/main.rs",
  "desktop/ui/src/app/App.tsx",
];

class LaneError extends Error {}

function git(cwd, args) {
  return gitRaw(cwd, args).trim();
}

function gitRaw(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new LaneError(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  }
  return result.stdout;
}

function resolveRepository(cwd) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const commonDir = path.resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]));
  return { root, lanesDir: path.join(commonDir, "rho-dev-lanes") };
}

function leasePath(lanesDir, id) {
  return path.join(lanesDir, `${id}.json`);
}

export function loadLanes(lanesDir) {
  if (!fs.existsSync(lanesDir)) return [];
  const lanes = [];
  for (const entry of fs.readdirSync(lanesDir)) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(lanesDir, entry);
    let lease;
    try {
      lease = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new LaneError(`corrupt lane lease ${entry}: ${error.message}`);
    }
    lanes.push(lease);
  }
  return lanes.sort((left, right) => left.id.localeCompare(right.id));
}

function writeLease(lanesDir, lease) {
  fs.mkdirSync(lanesDir, { recursive: true });
  const destination = leasePath(lanesDir, lease.id);
  const temporary = path.join(lanesDir, `.${lease.id}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(lease, null, 2)}\n`);
  fs.renameSync(temporary, destination);
}

function resolveBase(root, base) {
  if (base == null) return git(root, ["rev-parse", "HEAD"]);
  return git(root, ["rev-parse", "--verify", `${base}^{commit}`]);
}

function changedFiles(root, lane, explicit, auto) {
  const files = [...explicit];
  if (auto) {
    const committed = gitRaw(root, ["diff", "--name-only", "-z", `${lane.base_commit}..HEAD`]);
    files.push(...committed.split("\0").filter(Boolean));
    // -z output keeps the leading space of the first XY status code; trimming
    // here would corrupt the first entry's path.
    const status = gitRaw(root, [
      "status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z",
    ]);
    for (const entry of status.split("\0")) {
      if (entry.length > 3) files.push(entry.slice(3));
    }
  }
  return [...new Set(files.map(normalizePath))].sort();
}

function commandStart(repository, options) {
  if (options.id == null || !ID_PATTERN.test(options.id)) {
    throw new LaneError(`start requires --id matching ${ID_PATTERN.source}`);
  }
  if (options.own.length === 0) throw new LaneError("start requires at least one --own <glob>");
  const lanes = loadLanes(repository.lanesDir);
  if (lanes.some(({ id }) => id === options.id)) {
    throw new LaneError(`lane ${options.id} is already active; finish it first`);
  }
  if (options.integration && lanes.some(({ lane, status }) => lane === "integration" && status === "active")) {
    throw new LaneError("an integration lane is already active; only one may exist at a time");
  }
  const candidate = {
    schema_version: 1,
    id: options.id,
    lane: options.integration ? "integration" : "feature",
    status: "active",
    base_commit: resolveBase(repository.root, options.base),
    owned_paths: options.own.map(normalizePath).sort(),
    shared_write_paths: [...new Set([...SHARED_AUTHORITY_PATHS, ...options.share.map(normalizePath)])].sort(),
    worktree: repository.root,
    note: options.note,
    created_at: new Date().toISOString(),
  };
  const overlap = checkOverlap([...lanes, candidate], { root: repository.root });
  const collisions = overlap.collisions.filter(({ packages }) => packages.includes(candidate.id));
  if (collisions.length > 0) {
    throw new LaneError(
      `lane ${candidate.id} overlaps active lanes:\n${collisions
        .map((collision) => `- ${collision.packages.join(" / ")}: ${collision.patterns[0] ?? collision.files[0]}`)
        .join("\n")}`,
    );
  }
  writeLease(repository.lanesDir, candidate);
  return candidate;
}

function commandCheck(repository, options) {
  const lanes = loadLanes(repository.lanesDir);
  const target = options.id == null ? null : lanes.find(({ id }) => id === options.id);
  const changed = target == null && options.id != null
    ? options.changed
    : changedFiles(repository.root, target ?? { base_commit: "HEAD" }, options.changed, options.changedAuto);
  const result = checkOverlap(lanes, {
    root: repository.root,
    workPackageId: options.id,
    changed,
    baseCommit: options.base,
  });
  return {
    result,
    failed: result.unknown_work_package ||
      result.base_mismatch != null ||
      result.collisions.length > 0 ||
      result.undeclared_paths.length > 0 ||
      result.forbidden_shared_paths.length > 0,
  };
}

function commandList(repository) {
  return loadLanes(repository.lanesDir).map((lease) => ({
    ...lease,
    stale: typeof lease.worktree === "string" && !fs.existsSync(lease.worktree),
  }));
}

function commandFinish(repository, options) {
  if (options.id == null) throw new LaneError("finish requires --id <lane>");
  const file = leasePath(repository.lanesDir, options.id);
  if (!fs.existsSync(file)) throw new LaneError(`lane ${options.id} is not active`);
  fs.unlinkSync(file);
  return { id: options.id, finished: true };
}

function commandMergeCheck(repository, options) {
  if (options.source == null) throw new LaneError("merge-check requires --source <ref>");
  const into = options.into ?? "HEAD";
  const result = spawnSync("git", ["merge-tree", "--write-tree", into, options.source], {
    cwd: repository.root,
    encoding: "utf8",
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new LaneError(`git merge-tree failed: ${(result.stderr ?? "").trim()}`);
  }
  const conflicted = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\d{6} [0-9a-f]{40,64} \d\t(.+)$/u);
    if (match != null) conflicted.push(match[1]);
  }
  return { into, source: options.source, clean: result.status === 0, conflicted_files: [...new Set(conflicted)].sort() };
}

const USAGE = `Usage: node scripts/dev-lanes.mjs <command> [options]

Commands:
  start --id <lane> --own <glob>... [--base <sha>] [--share <glob>...] [--integration] [--note <text>] [--json]
  check [--id <lane>] [--changed <file>...] [--changed-auto] [--base <sha>] [--json]
  list [--json]
  finish --id <lane> [--json]
  merge-check --source <ref> [--into <ref>] [--json]

Lane leases live in the git common dir and are shared by every linked worktree.
Shared authority paths (integration-lane single writer): ${SHARED_AUTHORITY_PATHS.join(", ")}
`;

function parseArguments(argv) {
  const command = argv[0];
  if (command == null || !new Set(["start", "check", "list", "finish", "merge-check"]).has(command)) {
    throw new LaneError(USAGE);
  }
  const options = {
    id: null,
    base: null,
    own: [],
    share: [],
    changed: [],
    changedAuto: false,
    integration: false,
    note: null,
    source: null,
    into: null,
    json: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--id") options.id = argv[++index];
    else if (argument === "--base") options.base = argv[++index];
    else if (argument === "--own") options.own.push(argv[++index]);
    else if (argument === "--share") options.share.push(argv[++index]);
    else if (argument === "--changed") options.changed.push(argv[++index]);
    else if (argument === "--changed-auto") options.changedAuto = true;
    else if (argument === "--integration") options.integration = true;
    else if (argument === "--note") options.note = argv[++index];
    else if (argument === "--source") options.source = argv[++index];
    else if (argument === "--into") options.into = argv[++index];
    else if (argument === "--json") options.json = true;
    else throw new LaneError(`Unknown argument: ${argument}\n${USAGE}`);
  }
  return { command, options };
}

function emit(value, options, human) {
  if (options.json || human == null) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    process.stdout.write(human(value));
  }
}

function humanList(lanes) {
  if (lanes.length === 0) return "No active development lanes.\n";
  return lanes.map((lane) => [
    `${lane.id} [${lane.lane}] base=${lane.base_commit.slice(0, 12)} owned=${lane.owned_paths.length} patterns`,
    `  worktree: ${lane.worktree}${lane.stale ? " (stale)" : ""}`,
    `  owned: ${lane.owned_paths.join(", ")}`,
  ].join("\n")).join("\n") + "\n";
}

export function runCli(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  const repository = resolveRepository(process.cwd());
  if (command === "start") {
    const lease = commandStart(repository, options);
    emit(lease, options, (value) =>
      `lane ${value.id} started (${value.lane}, base=${value.base_commit.slice(0, 12)}, owned=${value.owned_paths.length} patterns)\n`);
  } else if (command === "check") {
    const { result, failed } = commandCheck(repository, options);
    emit(result, options);
    if (failed) process.exitCode = 1;
  } else if (command === "list") {
    emit(commandList(repository), options, humanList);
  } else if (command === "finish") {
    const result = commandFinish(repository, options);
    emit(result, options, (value) => `lane ${value.id} finished\n`);
  } else if (command === "merge-check") {
    const result = commandMergeCheck(repository, options);
    emit(result, options, (value) => value.clean
      ? `clean merge: ${value.source} into ${value.into}\n`
      : `merge conflicts (${value.source} into ${value.into}):\n${value.conflicted_files.map((file) => `- ${file}`).join("\n")}\n`);
    if (!result.clean) process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] == null ? null : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    const message = error instanceof LaneError ? error.message : (error.stack ?? error.message);
    process.stderr.write(`dev-lanes: ${message}\n`);
    process.exitCode = 1;
  }
}
