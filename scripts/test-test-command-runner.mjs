#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(root, "scripts/run-test-command.mjs");
const run = (seconds, source) => spawnSync(
  process.execPath,
  [runner, "--timeout-seconds", String(seconds), "--label", "runner self-test", "--", process.execPath, "-e", source],
  { cwd: root, encoding: "utf8", timeout: 10_000 },
);

const success = run(2, "process.exit(0)");
assert.equal(success.status, 0, success.stderr);
assert.match(success.stdout, /\[PASS\] runner self-test/u);

const started = Date.now();
const timeout = run(0.2, "setTimeout(() => {}, 10_000)");
assert.equal(timeout.status, 124, `${timeout.stdout}\n${timeout.stderr}`);
assert.ok(Date.now() - started < 5_000, "timeout runner did not terminate its child promptly");
assert.match(timeout.stderr, /\[TIMEOUT\].*terminating its process tree/u);

console.log("Test command runner bounds wall time and terminates timed-out process trees");
