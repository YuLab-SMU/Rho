import { describe, expect, it } from "vitest";

import {
  createTauriAgentRuntimeTransport,
  type AgentRuntimeDiagnostics,
  type AgentRuntimeTransport,
} from "./agent-runtime";
import { createMockUiKernelTransport } from "./mock";

const diagnostics = {
  available: true,
  status: "degraded",
  rscript: "/opt/R/4.6.1/bin/Rscript",
  r_version: "4.6.1",
  aisdk_version: "1.5.0",
  provider_adapters_available: false,
  provider_health: "dependency_unavailable",
  dependencies: [{
    package: "aisdk.providers",
    status: "missing",
    installed_version: null,
    required_version: "0.1.0",
    resolved_path: null,
    detail: "Registered Provider adapters are unavailable.",
    remediation: "Install the reviewed Agent dependency without changing Workspace R.",
  }],
  error: "Agent Provider adapters need attention.",
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
      dependencies: expect.arrayContaining([
        expect.objectContaining({ package: "aisdk", status: "incompatible_version" }),
      ]),
    });
  });
});
