import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
if (process.argv.includes("--agent")) {
  assert.deepEqual(process.argv.slice(2), ["--agent"], "Use --agent alone for the focused Agent boundary check");
  run("node", ["scripts/test-agent-plugin-real-r.mjs"], { env, stdio: "inherit", timeout: 900_000 });
  process.exit(0);
}
if (process.argv.includes("--plugin-recovery")) {
  assert.deepEqual(process.argv.slice(2), ["--plugin-recovery"], "Use --plugin-recovery alone for the focused native check");
  assert.ok(process.env.RHO_CHECKPOINT_HELPER && fs.existsSync(process.env.RHO_CHECKPOINT_HELPER),
    "Set RHO_CHECKPOINT_HELPER to an already built, verified native component for this R");
  run("cargo", ["test", "-p", "rho-r-engine", "--test", "recovery_real_r", "--locked", "--offline", "--no-run"], { env, stdio: "inherit" });
  run("cargo", ["test", "-p", "rho-r-engine", "--test", "recovery_real_r", "--locked", "--offline", "--", "--ignored", "--nocapture"],
    { env, stdio: "inherit", timeout: 300_000 });
  console.log("Verified ordinary-provider native recovery, exact sessions, graph aliases, bounded payload reads and retained original evidence.");
  process.exit(0);
}
run(path.join(rHome, "bin", `Rscript${extension}`), ["--vanilla", "scripts/test-r-tools.R"], { env, stdio: "inherit" });
run(path.join(rHome, "bin", `Rscript${extension}`), ["--vanilla", "scripts/test-r-read-help.R"], { env, stdio: "inherit" });
run(path.join(rHome, "bin", `Rscript${extension}`), ["--vanilla", "scripts/test-r-packages.R"], { env, stdio: "inherit" });
for (const script of ["scripts/test-r-objects.R", "scripts/test-r-package-index.R"]) run(path.join(rHome, "bin", `Rscript${extension}`), ["--vanilla", script], { env, stdio: "inherit" });
run("cargo", ["test", "--manifest-path", "Cargo.toml", "-p", "rho-host", "--test", "real_r",
  "--locked", "--no-run"], { env, stdio: "inherit" });
run("cargo", ["test", "--manifest-path", "Cargo.toml", "-p", "rho-host", "--test", "real_r",
  "--locked", "--", "--ignored", "--nocapture"], { env, stdio: "inherit", timeout: 120_000 });
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
  "recovery_copy_protects_its_library", "--no-run"], { env: instanceEnv, stdio: "inherit" });
run("cargo", ["test", "--manifest-path", "Cargo.toml", "-p", "rho-host", "--lib", "--locked",
  "recovery_copy_protects_its_library", "--", "--ignored", "--nocapture"], { env: instanceEnv, stdio: "inherit", timeout: 120_000 });
console.log("Verified remaining native Host R/recovery fixtures. Fixed CLI/R transport checks are retired; ordinary-plugin acceptance is separate.");
