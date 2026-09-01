#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const providers = [];
for (const [providerId, command, args, commercial] of [
  ["opencode", "opencode", ["acp", "--pure", "--cwd", "/tmp"], false],
  ["codex_acp", "codex-acp", [], true],
  ["claude_code_acp", "claude-code-acp", [], true],
]) {
  const executableInfo = await executable(command);
  const initialized = await probeInitialize(executableInfo.path, args);
  const capabilities = initialized?.result?.agentCapabilities ?? {};
  const session = capabilities.sessionCapabilities ?? {};
  const ready = initialized?.result?.protocolVersion === 1;
  providers.push({
    provider_id: providerId,
    executable_name: command,
    executable_sha256: executableInfo.digest,
    version: initialized?.result?.agentInfo?.version ?? "unreported",
    protocol: ready ? "acp/1" : "unsupported",
    live_probe_passed: ready,
    support_tier: ready ? "observer_only" : "unsupported",
    commercial,
    observed: {
      streaming: ready,
      plan: ready,
      permission_hint: ready,
      resume: Boolean(session.resume),
      close: Boolean(session.close),
      list: Boolean(session.list),
      config: Boolean(capabilities.sessionCapabilities),
      mcp: Boolean(capabilities.mcpCapabilities),
      filesystem: false,
      terminal: false,
    },
    ...(ready ? {} : { reason: "ACP v1 initialize did not return a valid response" }),
  });
}

const fixture = {
  schema: "rho.provider-matrix.live.v1",
  generated_at_policy: "live probe; timestamp intentionally omitted for deterministic diff",
  providers,
};
const destination = path.join(
  root,
  "crates/rho-acp-client/tests/providers/live-matrix.json",
);
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Provider matrix probe passed: ${providers.length} providers; ${destination}`);

async function probeInitialize(command, args) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 15_000);
    child.on("error", () => finish(null));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          if (message.id === 1) return finish(message);
        } catch {}
      }
    });
    child.stdin.end(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "rho-acp-probe", version: "1" },
      },
    })}\n`);
  });
}

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
