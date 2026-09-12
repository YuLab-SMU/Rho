// P0 protocol evidence only. Host integration acceptance is added in later phases.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
assert.ok(args.every(arg => arg === "--real-model"), "Only --real-model is supported");
const real = args.includes("--real-model");
if (real) {
  for (const name of ["RHO_COMPONENT_MODEL_BASE_URL", "RHO_COMPONENT_MODEL_ID", "RHO_COMPONENT_MODEL_KEY_ENV"]) {
    assert.ok(process.env[name], `Explicit model probe requires ${name}`);
  }
  assert.ok(process.env[process.env.RHO_COMPONENT_MODEL_KEY_ENV], "Selected credential reference is unavailable");
}
const directory = path.join(root, "target", "component-agent-probe", new Date().toISOString().replaceAll(":", "-"));
fs.mkdirSync(directory, { recursive: true });
async function run(label, command, echo = true) {
  const log = fs.createWriteStream(path.join(directory, `${label}.log`));
  const child = spawn(command[0], command.slice(1), { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  for (const output of [child.stdout, child.stderr]) {
    output.on("data", data => { log.write(data); if (echo) process.stdout.write(data); });
  }
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  await new Promise(resolve => log.end(resolve));
  assert.equal(code, 0, `${label} failed; evidence: ${directory}`);
}
await run("protocol", ["cargo", "test", "-p", "rho-agents", "--locked"]);
await run("boundaries", ["node", "scripts/test-architecture.mjs"]);
await run("dependencies", ["cargo", "tree", "-p", "rho-agents", "--locked", "--edges", "normal", "--prefix", "none"], false);
const dependencies = fs.readFileSync(path.join(directory, "dependencies.log"), "utf8");
for (const forbidden of ["sqlx", "rig-sqlite", "lancedb", "fastembed", "ort", "datafusion", "rig-memory", "rmcp"]) {
  assert.ok(!new RegExp(`^${forbidden} v`, "m").test(dependencies), `Unexpected active integration: ${forbidden}`);
}
if (real) await run("real-model", ["cargo", "run", "-p", "rho-agents", "--example", "provider_probe", "--locked"]);
const summary = { phase: "P0", fakeProtocol: "passed", realModel: real ? "passed" : "not_run",
  liveScientificIntegration: "not_run", evidence: directory };
fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
