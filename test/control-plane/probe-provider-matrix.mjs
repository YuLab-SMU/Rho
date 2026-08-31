#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const providers = [];

const opencode = await executable("opencode");
const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: 1, clientCapabilities: {} },
});
const opencodeProbe = spawnSync(
  opencode.path,
  ["acp", "--pure", "--cwd", "/tmp"],
  { input: `${initialize}\n`, encoding: "utf8", timeout: 15_000 },
);
let opencodeInitialize = null;
try {
  opencodeInitialize = JSON.parse(opencodeProbe.stdout.trim());
} catch {}
providers.push({
  provider_id: "opencode",
  executable_name: "opencode",
  executable_sha256: opencode.digest,
  version: run(opencode.path, ["--version"]).trim(),
  protocol: opencodeInitialize?.result?.protocolVersion === 1 ? "acp/1" : "unsupported",
  live_probe_passed: opencodeProbe.status === 0 && opencodeInitialize?.result?.protocolVersion === 1,
  support_tier: "observer_only",
  observed: {
    streaming: true,
    plan: false,
    permission_hint: true,
    resume: Boolean(opencodeInitialize?.result?.agentCapabilities?.sessionCapabilities?.resume),
    close: Boolean(opencodeInitialize?.result?.agentCapabilities?.sessionCapabilities?.close),
    list: Boolean(opencodeInitialize?.result?.agentCapabilities?.sessionCapabilities?.list),
    config: false,
    mcp: Boolean(opencodeInitialize?.result?.agentCapabilities?.mcpCapabilities),
    filesystem: false,
    terminal: false,
  },
});

for (const [providerId, command, commercial] of [
  ["pi", "pi", false],
  ["claude_code", "claude", true],
]) {
  const executableInfo = await executable(command);
  const help = run(executableInfo.path, ["--help"]);
  const version = run(executableInfo.path, ["--version"]).trim();
  const exposesAcp = /\bacp\b/i.test(help) && !/no acp/i.test(help);
  providers.push({
    provider_id: providerId,
    executable_name: command,
    executable_sha256: executableInfo.digest,
    version,
    protocol: exposesAcp ? "acp/1-unverified" : "unsupported",
    live_probe_passed: false,
    support_tier: "unsupported",
    commercial,
    observed: {
      streaming: false,
      plan: false,
      permission_hint: false,
      resume: false,
      close: false,
      list: false,
      config: false,
      mcp: false,
      filesystem: false,
      terminal: false,
    },
    reason: "No stable local stdio ACP v1 initialize behavior; not exposed to Rho",
  });
}

const fixture = {
  schema: "rho.provider-matrix.live.v1",
  generated_at_policy: "live probe; timestamp intentionally omitted for deterministic diff",
  providers,
};
const destination = path.join(
  root,
  "crates/rho-agent-host/tests/providers/live-matrix.json",
);
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Provider matrix probe passed: ${providers.length} providers; ${destination}`);

async function executable(command) {
  const found = run("which", [command]).trim();
  if (!found) throw new Error(`${command} not installed`);
  const resolved = await realpath(found);
  const bytes = await readFile(resolved);
  return {
    path: resolved,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}
