#!/usr/bin/env node

// Two-speed local validation for Rho development:
// - quick: explicit focused UI/Rust checks for the implementation loop;
// - rsr-final: the existing RSR matrix split into resumable named gates.
// Final evidence is reusable only while the repository fingerprint and gate
// command are unchanged. State lives under ignored target/.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PACKAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

class CheckpointError extends Error {}

function execute(program, args, { cwd, inherit = false } = {}) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error != null) throw new CheckpointError(`${program} failed to start: ${result.error.message}`);
  return result;
}

function commandOutput(program, args, cwd) {
  const result = execute(program, args, { cwd });
  if (result.status !== 0) {
    throw new CheckpointError(
      `${program} ${args.join(" ")} failed: ${(result.stderr ?? result.stdout ?? "").trim()}`,
    );
  }
  return result.stdout;
}

function repositoryRoot(cwd) {
  return commandOutput("git", ["rev-parse", "--show-toplevel"], cwd).trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function repositoryFingerprint(root) {
  const hash = createHash("sha256");
  hash.update("rho-dev-checkpoint-v2\0");
  const files = commandOutput(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    root,
  ).split("\0").filter(Boolean).sort();
  for (const relative of files) {
    const absolute = path.join(root, relative);
    hash.update(`path\0${relative}\0`);
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update("missing\0");
      continue;
    }
    hash.update(`mode\0${stat.mode & 0o111}\0`);
    if (stat.isSymbolicLink()) hash.update(`symlink\0${fs.readlinkSync(absolute)}`);
    else if (stat.isDirectory()) hash.update(`repository\0${repositoryFingerprint(absolute)}`);
    else hash.update(fs.readFileSync(absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function parseRsrCheckScripts(packageJson) {
  const command = packageJson?.scripts?.["rsr:check"];
  if (typeof command !== "string" || command.trim() === "") {
    throw new CheckpointError("desktop/package.json must define a non-empty rsr:check script");
  }
  return command.split(/\s*&&\s*/u).map((segment) => {
    const match = /^npm run ([A-Za-z0-9:_-]+)$/u.exec(segment.trim());
    if (match == null) {
      throw new CheckpointError(`unsupported rsr:check segment: ${segment.trim()}`);
    }
    return match[1];
  });
}

function gate(name, program, args) {
  return { name, program, args };
}

export function buildRsrGates(root, { stableUi = false } = {}) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "desktop", "package.json"), "utf8"));
  const gates = parseRsrCheckScripts(packageJson).map((script) => {
    const args = ["--prefix", "desktop", "run", script];
    if (stableUi && script === "rsr:test") args.push("--", "--maxWorkers=1");
    return gate(script, "npm", args);
  });
  gates.push(gate("git:diff-check", "git", ["diff", "--check"]));
  return gates;
}

export function commandDigest(item) {
  return sha256(JSON.stringify([item.program, item.args]));
}

export function planGates(gates, state, fingerprint) {
  const reusable = state?.schema_version === 2 && state.repository_fingerprint === fingerprint;
  return gates.map((item) => {
    const digest = commandDigest(item);
    const completed = reusable && state.completed?.[item.name]?.command_sha256 === digest;
    return { ...item, command_sha256: digest, completed };
  });
}

function normalizeUiTest(root, value) {
  const desktop = path.join(root, "desktop");
  const absolute = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(desktop, value.replace(/^desktop\//u, ""));
  const relative = path.relative(desktop, absolute).split(path.sep).join("/");
  if (relative.startsWith("../") || relative === "..") {
    throw new CheckpointError(`UI test must be inside desktop/: ${value}`);
  }
  if (!fs.existsSync(absolute)) throw new CheckpointError(`UI test does not exist: ${value}`);
  return relative;
}

function parseCargoTest(value) {
  const separator = value.indexOf("=");
  const packageName = separator === -1 ? value : value.slice(0, separator);
  const filter = separator === -1 ? null : value.slice(separator + 1);
  if (!PACKAGE_PATTERN.test(packageName) || filter === "") {
    throw new CheckpointError(`--cargo-test expects <package> or <package>=<filter>: ${value}`);
  }
  return { packageName, filter };
}

function buildQuickGates(root, options) {
  const gates = [];
  const uiTests = options.uiTests.map((value) => normalizeUiTest(root, value));
  if (options.ui || uiTests.length > 0) {
    gates.push(gate("ui:typecheck", "npm", ["--prefix", "desktop", "run", "rsr:typecheck"]));
    gates.push(gate("ui:lint", "npm", ["--prefix", "desktop", "run", "rsr:lint"]));
    if (uiTests.length > 0) {
      gates.push(gate(
        "ui:focused-tests",
        "npm",
        ["--prefix", "desktop", "run", "rsr:test", "--", ...uiTests, "--maxWorkers=1"],
      ));
    }
  }
  for (const packageName of options.cargoChecks) {
    if (!PACKAGE_PATTERN.test(packageName)) {
      throw new CheckpointError(`invalid --cargo-check package: ${packageName}`);
    }
    gates.push(gate(`cargo:check:${packageName}`, "cargo", ["check", "-p", packageName, "--locked"]));
  }
  for (const value of options.cargoTests) {
    const { packageName, filter } = parseCargoTest(value);
    const args = ["test", "-p", packageName, "--locked"];
    if (filter != null) args.push(filter);
    gates.push(gate(`cargo:test:${value}`, "cargo", args));
  }
  if (gates.length === 0) {
    throw new CheckpointError(
      "quick requires --ui, --ui-test <path>, --cargo-check <package>, or --cargo-test <package>[=<filter>]",
    );
  }
  gates.push(gate("git:diff-check", "git", ["diff", "--check"]));
  return gates;
}

function shellDisplay(item) {
  const quote = (value) => /^[A-Za-z0-9_./:=+-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
  return [item.program, ...item.args].map(quote).join(" ");
}

function statePath(root) {
  return path.join(root, "target", "dev-checkpoint", "rsr-final.json");
}

function loadState(root) {
  const file = statePath(root);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new CheckpointError(`checkpoint state is corrupt; run clear: ${error.message}`);
  }
}

function writeState(root, state) {
  const file = statePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function freshState(fingerprint) {
  return {
    schema_version: 2,
    repository_fingerprint: fingerprint,
    started_at: new Date().toISOString(),
    completed: {},
  };
}

function runGate(item, root) {
  const started = Date.now();
  console.log(`\n[RUN ] ${item.name}: ${shellDisplay(item)}`);
  const result = execute(item.program, item.args, { cwd: root, inherit: true });
  const elapsed = Date.now() - started;
  if (result.status !== 0) {
    throw new CheckpointError(`${item.name} failed after ${(elapsed / 1000).toFixed(1)}s (exit ${result.status})`);
  }
  console.log(`[PASS] ${item.name} (${(elapsed / 1000).toFixed(1)}s)`);
  return elapsed;
}

function runQuick(root, options) {
  const gates = buildQuickGates(root, options);
  for (const item of gates) {
    if (options.dryRun) console.log(`[PLAN] ${item.name}: ${shellDisplay(item)}`);
    else runGate(item, root);
  }
  if (options.ui && options.uiTests.length === 0) {
    console.log("[NOTE] no focused UI test selected; this quick pass covers static checks only");
  }
}

function runRsrFinal(root, options) {
  const fingerprint = repositoryFingerprint(root);
  const previous = loadState(root);
  const state = previous?.schema_version === 2 && previous.repository_fingerprint === fingerprint
    ? previous
    : freshState(fingerprint);
  if (previous != null && previous.repository_fingerprint !== fingerprint) {
    console.log("[RESET] repository source changed; prior final checkpoint is not reusable");
  }
  const plan = planGates(buildRsrGates(root, options), state, fingerprint);
  for (const item of plan) {
    if (item.completed) {
      console.log(`[SKIP] ${item.name}: unchanged snapshot and command`);
      continue;
    }
    if (options.dryRun) {
      console.log(`[PLAN] ${item.name}: ${shellDisplay(item)}`);
      continue;
    }
    const elapsed = runGate(item, root);
    const after = repositoryFingerprint(root);
    if (after !== fingerprint) {
      throw new CheckpointError(
        `${item.name} changed tracked or untracked source; review the delta before starting a new final checkpoint`,
      );
    }
    state.completed[item.name] = {
      command_sha256: item.command_sha256,
      completed_at: new Date().toISOString(),
      elapsed_ms: elapsed,
    };
    writeState(root, state);
  }
  if (!options.dryRun) console.log(`\nRSR final checkpoint complete for ${fingerprint.slice(0, 12)}`);
}

function showStatus(root, options) {
  const fingerprint = repositoryFingerprint(root);
  const state = loadState(root);
  const plan = planGates(buildRsrGates(root, options), state, fingerprint);
  console.log(`Repository fingerprint: ${fingerprint}`);
  console.log(`Saved checkpoint: ${state == null ? "none" : state.repository_fingerprint}`);
  for (const item of plan) console.log(`${item.completed ? "PASS" : "PENDING"} ${item.name}`);
}

function clearState(root) {
  const file = statePath(root);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  console.log(`Cleared ${path.relative(root, file)}`);
}

function usage() {
  return `Usage:
  node scripts/dev-checkpoint.mjs quick [selectors] [--dry-run]
  node scripts/dev-checkpoint.mjs rsr-final [--stable-ui] [--dry-run]
  node scripts/dev-checkpoint.mjs status [--stable-ui]
  node scripts/dev-checkpoint.mjs clear

Quick selectors:
  --ui                              Typecheck and lint the RSR frontend
  --ui-test <desktop-relative path> Add a focused Vitest file (repeatable)
  --cargo-check <package>           Run cargo check for one package (repeatable)
  --cargo-test <package>[=<filter>] Run a focused Cargo test (repeatable)

rsr-final resumes successful rsr:check gates only for the exact unchanged
repository snapshot. --stable-ui serializes the broad Vitest gate.`;
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {
    command,
    ui: false,
    uiTests: [],
    cargoChecks: [],
    cargoTests: [],
    stableUi: false,
    dryRun: false,
  };
  const values = new Map([
    ["--ui-test", options.uiTests],
    ["--cargo-check", options.cargoChecks],
    ["--cargo-test", options.cargoTests],
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--ui") options.ui = true;
    else if (argument === "--stable-ui") options.stableUi = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (values.has(argument)) {
      const value = rest[index + 1];
      if (value == null || value.startsWith("--")) throw new CheckpointError(`${argument} requires a value`);
      values.get(argument).push(value);
      index += 1;
    } else {
      throw new CheckpointError(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const root = repositoryRoot(process.cwd());
    if (options.command === "quick") runQuick(root, options);
    else if (options.command === "rsr-final") runRsrFinal(root, options);
    else if (options.command === "status") showStatus(root, options);
    else if (options.command === "clear") clearState(root);
    else throw new CheckpointError(usage());
  } catch (error) {
    console.error(`dev-checkpoint: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === SCRIPT_PATH) main();
