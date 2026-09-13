// Explicit real-service acceptance: 7 profiles + 2 repair workflows, three repeats.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const profiles = ["objects", "packages", "plots", "environment", "workspace"];
const cases = [
  ...profiles.map(profile => ({ id: profile, profile, command: ["cargo", "run", "-p", "rho-host", "--example", "component_source_probe", "--locked", "--", `--profile=${profile}`] })),
  ...[
    ["documents", "documents", "real_model_captured_document_edit_save_and_run"],
    ["project", "project", "real_model_project_document_edit_save_and_run"],
    ["repair-document", "documents", "real_model_captured_document_failure_and_repair"],
    ["repair-plot", "documents", "real_model_repairs_document_and_reads_its_produced_plot"],
  ].map(([id, profile, test]) => ({ id, profile, command: ["cargo", "test", "-p", "rho-host", "--test", "component_mutations_real_r", test, "--locked", "--", "--ignored", "--exact", "--nocapture"] })),
];
const args = process.argv.slice(2);
const selected = args.find(arg => arg.startsWith("--case="))?.slice(7);
assert.ok(args.every(arg => arg === "--run" || arg === "--self-test" || arg.startsWith("--case=")), "Use --run [--case=ID] or --self-test");
assert.ok(!selected || cases.some(test => test.id === selected), "Unknown matrix case");
assert.equal(cases.length * 3, 27);
assert.equal(new Set(cases.map(test => test.profile)).size, 7);
assert.equal(new Set(cases.map(test => test.id)).size, 9);
if (args.includes("--self-test")) {
  assert.ok(cases.every(test => test.command.includes("--locked")));
  console.log("Matrix definition: seven profiles, two complete repair workflows, three repeats, 27 scenarios; no model requests.");
  process.exit(0);
}
if (!args.includes("--run")) {
  console.log("Explicit execution requires --run and configured R/model environment. Cases:", cases.map(test => test.id).join(", "));
  process.exit(0);
}
for (const key of ["RHO_ARK", "RHO_R_HOME", "RHO_COMPONENT_MODEL_BASE_URL", "RHO_COMPONENT_MODEL_ID", "RHO_COMPONENT_MODEL_KEY_ENV"]) {
  assert.ok(process.env[key], `Missing ${key}`);
}
assert.ok(process.env[process.env.RHO_COMPONENT_MODEL_KEY_ENV], "Selected credential reference is unavailable");

function fingerprint() {
  const names = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "crates", "r", "Cargo.toml", "Cargo.lock"], { cwd: root }).toString().split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const name of names) { hash.update(name); hash.update("\0"); hash.update(fs.readFileSync(path.join(root, name))); }
  hash.update(fs.readFileSync(import.meta.filename));
  return hash.digest("hex");
}
const source = fingerprint();
const directory = path.join(root, "target", "component-matrix", new Date().toISOString().replaceAll(":", "-"));
fs.mkdirSync(directory, { recursive: true });
const report = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(),
  backendSourceSha256: source,
  model: { protocol: process.env.RHO_COMPONENT_MODEL_PROTOCOL ?? "openai_completions", baseUrl: process.env.RHO_COMPONENT_MODEL_BASE_URL, id: process.env.RHO_COMPONENT_MODEL_ID, credentialEnvironment: process.env.RHO_COMPONENT_MODEL_KEY_ENV },
  expectedScenarios: 27, selectedCase: selected ?? null, attempts: [],
  matrixComplete: false, allPassed: false,
  note: "Backend scenario evidence only; UI review, UI performance and full workspace regression are separate gates. Synthetic diagnostics are additional model calls.",
};
const save = () => fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify(report, null, 2) + "\n");
async function run(command, logPath) {
  const log = fs.createWriteStream(logPath);
  const child = spawn(command[0], command.slice(1), { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  for (const output of [child.stdout, child.stderr]) output.on("data", data => log.write(data));
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  await new Promise(resolve => log.end(resolve));
  return code;
}
save();
for (const command of [
  ["cargo", "build", "-p", "rho-host", "--example", "component_source_probe", "--locked"],
  ["cargo", "test", "-p", "rho-host", "--test", "component_mutations_real_r", "--locked", "--no-run"],
]) {
  const code = await run(command, path.join(directory, command[1] === "build" ? "build-source.log" : "build-documents.log"));
  assert.equal(code, 0, `Preflight build failed: ${directory}`);
}
for (const test of cases.filter(test => !selected || test.id === selected)) {
  for (let repetition = 1; repetition <= 3; repetition++) {
    assert.equal(fingerprint(), source, "Backend/fixture source changed during the fixed-version matrix");
    const started = Date.now(), file = `${test.id}-${repetition}.log`;
    const code = await run(test.command, path.join(directory, file));
    const attempt = { id: test.id, profile: test.profile, repetition, passed: code === 0, exitCode: code, elapsedMs: Date.now() - started, log: file };
    report.attempts.push(attempt); save();
    console.log(JSON.stringify(attempt));
  }
}
assert.equal(fingerprint(), source, "Backend/fixture source changed during the final matrix attempt");
report.matrixComplete = report.attempts.length === report.expectedScenarios;
report.allPassed = report.matrixComplete && report.attempts.every(attempt => attempt.passed);
save();
console.log(JSON.stringify({ report: path.join(directory, "summary.json"), matrixComplete: report.matrixComplete, allPassed: report.allPassed }));
process.exitCode = report.attempts.every(attempt => attempt.passed) ? 0 : 1;
