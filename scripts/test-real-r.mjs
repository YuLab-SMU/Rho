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
run("cargo", ["test", "--manifest-path", "Cargo.toml", "-p", "rho-host", "--test", "real_r",
  "--locked", "--no-run"], { env, stdio: "inherit" });
run("cargo", ["test", "--manifest-path", "Cargo.toml", "-p", "rho-host", "--test", "real_r",
  "--locked", "--", "--ignored", "--nocapture"], { env, stdio: "inherit", timeout: 120_000 });
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
  assert.deepEqual(query.operation, output.operation);
  assert.deepEqual(fs.readFileSync(database), before);
  await verifySession(binary, ["--database", path.join(project, "session.sqlite"),
    "--ark", ark, "--r-home", rHome, "--project", project]);
  console.log("Verified real Ark/R session state, R errors with partial effects, confirmed cancellation, kernel exit, CLI invoke and read-only result query.");
} finally {
  fs.rmSync(project, { recursive: true, force: true });
}
