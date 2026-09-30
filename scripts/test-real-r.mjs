import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

assert.ok(["", "--agent", "--plugin-recovery"].includes(process.argv.slice(2).join(" ")), "Use no arguments, --agent or --plugin-recovery");
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
run("cargo", ["test", "-p", "rho-r-engine", "--test", "real_r", "--locked", "--offline", "--no-run"], { env, stdio: "inherit" });
run("cargo", ["test", "-p", "rho-r-engine", "--test", "real_r", "--locked", "--offline", "--", "--ignored", "--nocapture"], { env, stdio: "inherit", timeout: 120_000 });
console.log("Verified ordinary R engine and shared R helpers. Provider/Host composition and recovery use their separate retained-package suites.");
