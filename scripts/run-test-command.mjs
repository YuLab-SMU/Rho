#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

function usage() {
  return "usage: node scripts/run-test-command.mjs --timeout-seconds <n> [--label <text>] -- <program> [args...]";
}

const argv = process.argv.slice(2);
let timeoutSeconds = null;
let label = "test command";
let separator = -1;
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (argument === "--") {
    separator = index;
    break;
  }
  if (argument === "--timeout-seconds") {
    timeoutSeconds = Number(argv[++index]);
  } else if (argument === "--label") {
    label = argv[++index] ?? "";
  } else {
    throw new Error(`${usage()}\nunknown argument: ${argument}`);
  }
}
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || separator < 0) {
  throw new Error(usage());
}
const [program, ...args] = argv.slice(separator + 1);
if (program == null) throw new Error(usage());

const started = Date.now();
const child = spawn(program, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  detached: process.platform !== "win32",
});
let timedOut = false;
let forced = null;
const stopTree = (signal) => {
  if (child.pid == null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`\n[TIMEOUT] ${label} exceeded ${timeoutSeconds}s; terminating its process tree`);
  stopTree("SIGTERM");
  forced = setTimeout(() => stopTree("SIGKILL"), 2_000);
  forced.unref();
}, timeoutSeconds * 1_000);
timer.unref();

const forward = (signal) => {
  stopTree(signal);
};
process.once("SIGINT", forward);
process.once("SIGTERM", forward);

child.once("error", (error) => {
  clearTimeout(timer);
  if (forced != null) clearTimeout(forced);
  console.error(`${label} failed to start: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  clearTimeout(timer);
  if (forced != null) clearTimeout(forced);
  process.removeListener("SIGINT", forward);
  process.removeListener("SIGTERM", forward);
  const elapsed = ((Date.now() - started) / 1_000).toFixed(1);
  if (timedOut) {
    console.error(`[FAIL] ${label} timed out after ${elapsed}s`);
    process.exitCode = 124;
  } else if (code !== 0) {
    console.error(`[FAIL] ${label} exited ${code ?? signal} after ${elapsed}s`);
    process.exitCode = code ?? 1;
  } else {
    console.log(`[PASS] ${label} (${elapsed}s)`);
  }
});
