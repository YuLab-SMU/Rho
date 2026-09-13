// Engine, Application and Host query evidence. Real R acceptance remains separate.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
assert.ok(args.every(arg => ["--real-model", "--real-sources"].includes(arg)), "Only --real-model and --real-sources are supported");
const sources = args.includes("--real-sources");
const real = args.includes("--real-model") || sources;
if (real) {
  for (const name of ["RHO_COMPONENT_MODEL_BASE_URL", "RHO_COMPONENT_MODEL_ID", "RHO_COMPONENT_MODEL_KEY_ENV"]) {
    assert.ok(process.env[name], `Explicit model probe requires ${name}`);
  }
  assert.ok(process.env[process.env.RHO_COMPONENT_MODEL_KEY_ENV], "Selected credential reference is unavailable");
}
if (sources) for (const name of ["RHO_ARK", "RHO_R_HOME"]) assert.ok(process.env[name], `Real source checks require ${name}`);
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
await run("application", ["cargo", "test", "-p", "rho-sqlite", "--test", "component_agents", "--locked"]);
await run("host", ["cargo", "test", "-p", "rho-host", "--test", "component_agents", "--locked"]);
await run("recovery", ["cargo", "test", "-p", "rho-host", "--test", "component_recovery", "--locked"]);
await run("boundaries", ["node", "scripts/test-architecture.mjs"]);
await run("dependencies", ["cargo", "tree", "-p", "rho-agents", "--locked", "--edges", "normal", "--prefix", "none"], false);
const dependencies = fs.readFileSync(path.join(directory, "dependencies.log"), "utf8");
for (const forbidden of ["sqlx", "rig-sqlite", "lancedb", "fastembed", "ort", "datafusion", "rig-memory", "rmcp"]) {
  assert.ok(!new RegExp(`^${forbidden} v`, "m").test(dependencies), `Unexpected active integration: ${forbidden}`);
}
if (real) {
  await run("real-model", ["cargo", "run", "-p", "rho-agents", "--example", "provider_probe", "--locked"]);
  await run("real-host", ["cargo", "run", "-p", "rho-host", "--example", "component_agent_probe", "--locked"]);
  if (sources) {
    await run("real-sources", ["cargo", "run", "-p", "rho-host", "--example", "component_source_probe", "--locked"]);
    await run("real-documents", ["cargo", "test", "-p", "rho-host", "--test", "component_mutations_real_r", "real_model_captured_document", "--locked", "--", "--ignored", "--nocapture", "--test-threads=1"]);
  }
}
const summary = { phase: "P3-documents", fakeProtocol: "passed", applicationAdmission: "passed", hostQueryIntegration: "passed", realModel: real ? "passed" : "not_run",
  realProjectRead: real ? "passed" : "not_run", realRSources: sources ? "passed" : "not_run", realDocuments: sources ? "passed" : "not_run", evidence: directory };
fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
