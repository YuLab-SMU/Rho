import { describe, expect, it } from "vitest";

import {
  createTauriAgentRuntimeTransport,
  type AgentRuntimeDiagnostics,
  type AgentRuntimeTransport,
} from "./agent-runtime";
import { createMockUiKernelTransport } from "./mock";

const diagnostics = {
  available: true,
  status: "ready",
  active_agent_id: "claude-code-acp",
  active_agent_label: "Claude Code",
  protocol: "acp/1",
  executable: "/usr/local/bin/claude-code-acp",
  candidates: [{
    agent_id: "claude-code-acp",
    display_name: "Claude Code",
    status: "ready",
    protocol: "acp/1",
    executable: "/usr/local/bin/claude-code-acp",
    detail: "External ACP Agent executable discovered.",
  }],
  error: null,
} satisfies AgentRuntimeDiagnostics;

describe("Agent runtime generated transport", () => {
  it("owns both no-argument command identities", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const transport = createTauriAgentRuntimeTransport(
      async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push(args === undefined ? { command } : { command, args });
        return diagnostics as T;
      },
    );

    await expect(transport.getAgentRuntimeDiagnostics()).resolves.toBe(diagnostics);
    await expect(transport.retryAgentRuntime()).resolves.toBe(diagnostics);
    expect(calls).toEqual([
      { command: "agent_runtime_status" },
      { command: "agent_runtime_retry" },
    ]);
  });

  it("preserves probe rejection", async () => {
    const transport = createTauriAgentRuntimeTransport(async () => {
      throw new Error("Agent dependency probe failed");
    });
    await expect(transport.retryAgentRuntime()).rejects.toThrow("dependency probe failed");
  });

  it("keeps browser/mock mode assignable to the narrow runtime facet", async () => {
    const transport: AgentRuntimeTransport = createMockUiKernelTransport();
    await expect(transport.getAgentRuntimeDiagnostics()).resolves.toMatchObject({
      available: false,
      status: "needs_attention",
      active_agent_id: null,
      candidates: [],
    });
  });
});
