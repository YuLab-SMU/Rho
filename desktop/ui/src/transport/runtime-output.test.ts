import { describe, expect, it } from "vitest";
import type { Channel } from "@tauri-apps/api/core";

import { createMockUiKernelTransport } from "./mock";
import {
  createTauriRuntimeOutputTransport,
  type RuntimeOutputPolicyView,
  type RuntimeOutputFollowFrame,
  type RuntimeOutputTransport,
} from "./runtime-output";

const policyView: RuntimeOutputPolicyView = {
  policy: {
    project_root: "/project-a",
    revision: 3,
    max_runtime_output_bytes_per_execution: 1024,
    runtime_output_project_warning_bytes: 2048,
    max_runtime_execution_rows: 10,
    auto_prune_enabled: false,
    updated_at: "2026-08-24T00:00:00Z",
  },
  project_output_bytes: 512,
  project_execution_count: 1,
  warning_active: false,
};

describe("Runtime Output domain transport", () => {
  it("uses generated command identities and normalizes ergonomic optional arguments", async () => {
    const calls: Array<{ readonly command: string; readonly args?: Record<string, unknown> }> = [];
    const channel = { onmessage: () => undefined } as unknown as Channel<RuntimeOutputFollowFrame>;
    const transport = createTauriRuntimeOutputTransport(
      async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push(args === undefined ? { command } : { command, args });
        if (command === "runtime_output_policy_get" || command === "runtime_output_policy_update") {
          return policyView as T;
        }
        return null as T;
      },
      () => channel,
    );

    await transport.getRuntimeExecution("execution.1");
    await transport.listRuntimeExecutions(25, {
      started_at: "2026-08-24T00:00:00Z",
      execution_id: "execution.0",
    });
    await transport.loadRuntimeOutputPage({ execution_id: "execution.1" });
    await transport.searchRuntimeOutput({ query: "model" });
    await transport.getRuntimeOutputPolicy();
    await transport.updateRuntimeOutputPolicy({
      expected_revision: 3,
      max_runtime_output_bytes_per_execution: null,
      runtime_output_project_warning_bytes: null,
      max_runtime_execution_rows: null,
      auto_prune_enabled: false,
    });
    await transport.createRuntimeOutputReference("execution.1");
    await transport.pruneRuntimeOutput("execution.1");
    await transport.deleteRuntimeExecution("execution.1");
    await transport.followRuntimeOutput("execution.1", 7, () => undefined);

    expect(calls.map(({ command }) => command)).toEqual([
      "runtime_execution_get",
      "runtime_execution_list",
      "runtime_output_page",
      "runtime_output_search",
      "runtime_output_policy_get",
      "runtime_output_policy_update",
      "runtime_output_reference",
      "runtime_output_prune",
      "runtime_execution_delete",
      "runtime_output_follow",
    ]);
    expect(calls[2]?.args).toEqual({
      request: {
        execution_id: "execution.1",
        before_sequence: null,
        page_size: null,
        byte_limit: null,
      },
    });
    expect(calls[3]?.args).toEqual({
      request: {
        query: "model",
        console_instance_id: null,
        started_after: null,
        limit: null,
      },
    });
    expect(calls[6]?.args).toEqual({
      request: {
        execution_id: "execution.1",
        start_sequence: null,
        end_sequence: null,
      },
    });
    expect(calls[9]?.args?.channel).toBeDefined();
  });

  it("fails closed if a backend enables the unsupported automatic-prune mode", async () => {
    const transport = createTauriRuntimeOutputTransport(async <T,>() => ({
      ...policyView,
      policy: { ...policyView.policy, auto_prune_enabled: true },
    }) as T);

    await expect(transport.getRuntimeOutputPolicy()).rejects.toThrow(
      "Runtime output automatic pruning is not supported",
    );
  });

  it("keeps browser/mock mode assignable to the same narrow domain interface", async () => {
    const transport: RuntimeOutputTransport = createMockUiKernelTransport();
    await expect(transport.getRuntimeOutputPolicy()).resolves.toMatchObject({
      policy: { auto_prune_enabled: false },
    });
    await expect(transport.searchRuntimeOutput({ query: "mock" })).resolves.toMatchObject({
      query: "mock",
    });
  });
});
