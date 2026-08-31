import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRsrGates,
  commandDigest,
  parseRsrCheckScripts,
  planGates,
  repositoryFingerprint,
} from "./dev-checkpoint.mjs";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "dev-checkpoint.mjs");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(root, relative, content) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

assert.deepEqual(parseRsrCheckScripts({
  scripts: { "rsr:check": "npm run rsr:typecheck && npm run rsr:test && npm run rsr:build" },
}), ["rsr:typecheck", "rsr:test", "rsr:build"]);
assert.throws(
  () => parseRsrCheckScripts({ scripts: { "rsr:check": "npm run rsr:test && echo unsafe" } }),
  /unsupported rsr:check segment/u,
);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rho-dev-checkpoint-"));
try {
  git(temporary, ["init", "-b", "main"]);
  git(temporary, ["config", "user.name", "Rho checkpoint fixture"]);
  git(temporary, ["config", "user.email", "rho-fixture@example.invalid"]);
  write(temporary, ".gitignore", "target/\n");
  write(temporary, "tracked.txt", "baseline\n");
  write(temporary, "desktop/package.json", JSON.stringify({
    scripts: {
      "rsr:check": "npm run rsr:typecheck && npm run rsr:test:fast",
      "rsr:check:full": "npm run rsr:typecheck && npm run rsr:test && npm run rsr:build",
    },
  }));
  write(temporary, "desktop/ui/src/example.test.ts", "export {};\n");
  git(temporary, ["add", "."]);
  git(temporary, ["commit", "-m", "baseline"]);

  const baseline = repositoryFingerprint(temporary);
  write(temporary, "tracked.txt", "committed change\n");
  const beforeCommit = repositoryFingerprint(temporary);
  git(temporary, ["add", "tracked.txt"]);
  git(temporary, ["commit", "-m", "content change"]);
  assert.equal(
    repositoryFingerprint(temporary),
    beforeCommit,
    "committing unchanged working-tree content must preserve the checkpoint",
  );
  write(temporary, "tracked.txt", "baseline\n");
  git(temporary, ["add", "tracked.txt"]);
  git(temporary, ["commit", "-m", "restore content"]);
  assert.equal(repositoryFingerprint(temporary), baseline, "fingerprints describe content, not commit history");

  write(temporary, "target/ignored.txt", "ignored\n");
  write(temporary, "test/probe/target/release/probe", "nested ignored artifact\n");
  assert.equal(
    repositoryFingerprint(temporary),
    baseline,
    "root and nested build artifacts must not invalidate a checkpoint",
  );
  write(temporary, "tracked.txt", "changed\n");
  assert.notEqual(repositoryFingerprint(temporary), baseline, "tracked changes invalidate a checkpoint");
  write(temporary, "tracked.txt", "baseline\n");
  write(temporary, "untracked.txt", "new source\n");
  assert.notEqual(repositoryFingerprint(temporary), baseline, "untracked source invalidates a checkpoint");
  fs.unlinkSync(path.join(temporary, "untracked.txt"));
  assert.equal(repositoryFingerprint(temporary), baseline);

  const parallel = buildRsrGates(temporary);
  const stable = buildRsrGates(temporary, { stableUi: true });
  assert.deepEqual(parallel.map(({ name }) => name), [
    "rsr:typecheck", "rsr:test", "rsr:build", "git:diff-check",
  ]);
  assert.equal(commandDigest(parallel[0]), commandDigest(stable[0]));
  assert.notEqual(commandDigest(parallel[1]), commandDigest(stable[1]));
  assert.equal(commandDigest(parallel[2]), commandDigest(stable[2]));

  const state = {
    schema_version: 3,
    repository_fingerprint: baseline,
    completed: Object.fromEntries(parallel.map((item) => [
      item.name,
      { command_sha256: commandDigest(item) },
    ])),
  };
  assert.ok(planGates(parallel, state, baseline).every(({ completed }) => completed));
  const stablePlan = planGates(stable, state, baseline);
  assert.deepEqual(
    stablePlan.filter(({ completed }) => !completed).map(({ name }) => name),
    ["rsr:test"],
    "serial retry invalidates only the changed Vitest command",
  );
  assert.ok(planGates(parallel, state, "different").every(({ completed }) => !completed));

  const dryRun = execFileSync(
    "node",
    [script, "quick", "--ui-test", "ui/src/example.test.ts", "--dry-run"],
    { cwd: temporary, encoding: "utf8" },
  );
  assert.match(dryRun, /ui:focused-tests/u);
  assert.match(dryRun, /--maxWorkers=1/u);
  assert.match(dryRun, /git:diff-check/u);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log("Dev checkpoints separate focused checks and safely resume unchanged RSR final gates");
