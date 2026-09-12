import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifySession } from "./verify-session.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = process.platform === "win32" ? ".exe" : "";
const ark = process.env.RHO_ARK || path.resolve(root, "target/debug", `ark${extension}`);
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: command === "cargo" ? 900_000 : 120_000, ...options });
  assert.equal(result.status, 0, `${command} failed: ${result.error?.message || result.stderr || result.signal}`);
  return result.stdout;
};
assert.ok(fs.existsSync(ark), "Set RHO_ARK to an installed Ark executable.");
const rHome = process.env.RHO_R_HOME || run("Rscript", ["--vanilla", "-e", "cat(R.home())"]).trim();
const env = { ...process.env, RHO_ARK: ark, RHO_R_HOME: rHome };
run(path.join(rHome, "bin", `Rscript${extension}`), ["--vanilla", "scripts/test-r-tools.R"], { env, stdio: "inherit" });
run(path.join(rHome, "bin", `Rscript${extension}`), ["--vanilla", "scripts/test-r-read-help.R"], { env, stdio: "inherit" });
run(path.join(rHome, "bin", `Rscript${extension}`), ["--vanilla", "scripts/test-r-packages.R"], { env, stdio: "inherit" });
for (const script of ["scripts/test-r-objects.R", "scripts/test-r-package-index.R"]) run(path.join(rHome, "bin", `Rscript${extension}`), ["--vanilla", script], { env, stdio: "inherit" });
run("cargo", ["test", "--manifest-path", "Cargo.toml", "-p", "rho-host", "--test", "real_r",
  "--locked", "--no-run"], { env, stdio: "inherit" });
run("cargo", ["test", "--manifest-path", "Cargo.toml", "-p", "rho-host", "--test", "real_r",
  "--locked", "--", "--ignored", "--nocapture"], { env, stdio: "inherit", timeout: 120_000 });
run("cargo", ["test", "-p", "rho-host", "--test", "component_sources_real_r", "--locked", "--", "--ignored"], { env, stdio: "inherit", timeout: 120_000 });
// The two-installation case in this file needs RHO_ALT_* and stays opt-in.
const checkpointHelper = run("node", ["scripts/test-r-checkpoints.mjs", "--print-library"], { env }).trim();
const instanceEnv = { ...env, RHO_CHECKPOINT_HELPER: checkpointHelper };
run("cargo", ["test", "--manifest-path", "Cargo.toml", "-p", "rho-host", "--test", "runtime_instances",
  "--locked", "--no-run"], { env: instanceEnv, stdio: "inherit" });
run("cargo", ["test", "--manifest-path", "Cargo.toml", "-p", "rho-host", "--test", "runtime_instances",
  "--locked", "--", "--ignored", "--nocapture",
  "real_instances_restore_and_clean_restart_without_cross_session_effects"],
  { env: instanceEnv, stdio: "inherit", timeout: 300_000 });
run("cargo", ["test", "--manifest-path", "Cargo.toml", "-p", "rho-host", "--lib", "--locked",
  "recovery_copy_protects_its_library", "--", "--ignored", "--nocapture"], { env: instanceEnv, stdio: "inherit", timeout: 120_000 });
run("cargo", ["build", "--manifest-path", "Cargo.toml", "-p", "rho-cli", "--locked"], { stdio: "inherit" });
const metadata = JSON.parse(run("cargo", ["metadata", "--manifest-path", "Cargo.toml", "--no-deps", "--format-version", "1", "--locked"]));
const binary = path.join(metadata.target_directory, "debug", `rho${extension}`);
const project = fs.mkdtempSync(path.join(os.tmpdir(), "rho-real-cli-"));
try {
  const database = path.join(project, "next.sqlite");
  const output = JSON.parse(run(binary, ["--database", database, "--ark", ark, "--r-home", rHome,
    "--project", project, "invoke", "--client-request-id", "real-cli-once",
    "--code", "x <- 21; cat('native R ready\\n'); x * 2"]));
  assert.equal(output.runtime, "ark");
  assert.equal(output.operation.status, "succeeded");
  assert.equal(output.operation.output.value, 42);
  const id = output.operation.operation.operation_id;
  const before = fs.readFileSync(database);
  const query = JSON.parse(run(binary, ["--database", database, "get-operation", id]));
  const { next_reads: originalReads, ...originalRecord } = output.operation;
  const { next_reads: queriedReads, ...queriedRecord } = query.operation;
  assert.deepEqual(queriedRecord, originalRecord);
  assert.equal(queriedReads.length, 1);
  assert.equal(queriedReads[0].capability.id, "operation.get");
  assert.equal(queriedReads[0].arguments.operation_id, id);
  assert.ok(originalReads.some(read => read.capability.id === "workspace.output_events"));
  assert.deepEqual(fs.readFileSync(database), before);
  await verifySession(binary, ["--database", path.join(project, "session.sqlite"),
    "--ark", ark, "--r-home", rHome, "--project", project]);
  console.log("Verified real Ark/R session state, R errors with partial effects, confirmed cancellation, kernel exit, CLI invoke and read-only result query.");
} finally {
  fs.rmSync(project, { recursive: true, force: true });
}
