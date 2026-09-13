// Explicit diagnostic relay: record image manifests, never headers, keys or prompt bodies.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
assert.ok(args.every(arg => arg === "--run"), "Use --run with an explicitly configured Anthropic service");
if (!args.includes("--run")) {
  console.log("Build component_source_probe, configure R/model environment, then use --run for three image-only probes through a local diagnostic relay.");
  process.exit(0);
}
assert.equal(process.env.RHO_COMPONENT_MODEL_PROTOCOL, "anthropic");
let upstream;
try { upstream = new URL(process.env.RHO_COMPONENT_MODEL_BASE_URL); }
catch { throw new Error("Model service URL is invalid"); }
assert.equal(upstream.protocol, "https:");
assert.equal(upstream.pathname, "/", "This diagnostic expects a root service URL");
assert.ok(!upstream.username && !upstream.password && !upstream.search && !upstream.hash);
const secret = process.env[process.env.RHO_COMPONENT_MODEL_KEY_ENV];
assert.ok(secret, "Configured credential is unavailable");
const binary = path.join(root, "target/debug/examples/component_source_probe");
assert.ok(fs.existsSync(binary), "Build the source probe first");
const directory = path.join(root, "target/component-image-wire", new Date().toISOString().replaceAll(":", "-"));
fs.mkdirSync(directory, { recursive: true });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const report = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(),
  binarySha256: sha(fs.readFileSync(binary)), upstream: upstream.origin,
  model: process.env.RHO_COMPONENT_MODEL_ID, attempts: [],
};
const save = () => fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify(report, null, 2) + "\n");
let sequence = 0, repetition = 0;
const server = http.createServer(async (incoming, outgoing) => {
  if (incoming.method !== "POST" || incoming.url !== "/v1/messages" || incoming.headers["x-api-key"] !== secret) {
    outgoing.writeHead(403).end(); return;
  }
  const id = ++sequence;
  let bytes = Buffer.alloc(0);
  for await (const chunk of incoming) {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length > 8 * 1024 * 1024) { outgoing.writeHead(413).end(); return; }
  }
  let body;
  try { body = JSON.parse(bytes); } catch { outgoing.writeHead(400).end(); return; }
  const images = [], declared = new Set();
  for (const message of body.messages ?? []) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === "text") for (const match of block.text.matchAll(/sha256:[a-f0-9]{64}/g)) declared.add(match[0]);
      if (block.type === "image") {
        const image = block.source?.type === "base64" ? Buffer.from(block.source.data, "base64") : null;
        const png = image?.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        images.push({ sourceType: block.source?.type, mimeType: block.source?.media_type,
          bytes: image?.length, sha256: image ? `sha256:${sha(image)}` : null,
          width: png && image.length >= 24 ? image.readUInt32BE(16) : null,
          height: png && image.length >= 24 ? image.readUInt32BE(20) : null });
      }
    }
  }
  const manifest = { id, repetition, requestBytes: bytes.length, model: body.model, stream: body.stream,
    contentTypes: (body.messages ?? []).map(message => Array.isArray(message.content) ? message.content.map(block => block.type) : ["text"]),
    tools: body.tools?.length ?? 0, images: images.map(image => ({ ...image, matchesDeclaredHash: declared.has(image.sha256) })) };
  fs.appendFileSync(path.join(directory, "requests.jsonl"), JSON.stringify(manifest) + "\n");
  const headers = { ...incoming.headers, host: upstream.host };
  delete headers.connection;
  const request = https.request(new URL(incoming.url, upstream), { method: "POST", headers }, response => {
    fs.appendFileSync(path.join(directory, "responses.jsonl"), JSON.stringify({ id, status: response.statusCode }) + "\n");
    const responseHeaders = { ...response.headers };
    delete responseHeaders.connection;
    outgoing.writeHead(response.statusCode, responseHeaders);
    response.pipe(outgoing);
  });
  request.setTimeout(125_000, () => request.destroy());
  request.on("error", error => {
    fs.appendFileSync(path.join(directory, "responses.jsonl"), JSON.stringify({ id, transportCode: error.code ?? "unknown" }) + "\n");
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  });
  outgoing.on("close", () => { if (!outgoing.writableEnded) request.destroy(); });
  request.end(bytes);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const relay = `http://127.0.0.1:${server.address().port}`;
save();
try {
  for (repetition = 1; repetition <= 3; repetition++) {
    const started = Date.now(), logName = `plots-${repetition}.log`;
    const output = fs.createWriteStream(path.join(directory, logName));
    const child = spawn(binary, ["--profile=plots"], {
      cwd: root, env: { ...process.env, RHO_COMPONENT_MODEL_BASE_URL: relay }, stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => output.write(chunk));
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    await new Promise(resolve => output.end(resolve));
    const attempt = { repetition, exitCode: code, elapsedMs: Date.now() - started, log: logName };
    report.attempts.push(attempt); save(); console.log(JSON.stringify(attempt));
  }
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify({ report: path.join(directory, "summary.json"), passed: report.attempts.filter(attempt => attempt.exitCode === 0).length }));
process.exitCode = report.attempts.every(attempt => attempt.exitCode === 0) ? 0 : 1;
