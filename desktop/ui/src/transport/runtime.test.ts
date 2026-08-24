import { describe, expect, it } from "vitest";

import { createMockUiKernelTransport } from "./mock";
import {
  createTauriRuntimeTransport,
  type RuntimeCreateRequest,
  type RuntimeExecuteRequest,
  type RuntimeInstanceRequest,
  type RuntimeRegistrySnapshot,
  type RuntimeTransport,
} from "./runtime";

const snapshot = {
  contract: "rho.ui.runtime-registry.snapshot.v1",
  contract_major: 1,
  snapshot_revision: 5,
  project_id: "project-a",
  project_revision: 7,
  providers: [],
  instances: [],
} satisfies RuntimeRegistrySnapshot;

const instanceRequest = {
  project_id: "project-a",
  runtime_provider_id: "rho.ark-r",
  runtime_instance_id: "runtime.workspace-r",
  activation_generation: 3,
  expected_project_revision: 7,
  expected_state_revision: 11,
} satisfies RuntimeInstanceRequest;

describe("Runtime generated transport", () => {
  it("owns all six command identities and preserves exact request nesting", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, ...(args === undefined ? {} : { args }) });
      if (command === "runtime_execution_start") {
        return {
          execution: {
            execution_id: "execution.1",
            project_root: "/project-a",
            run_id: null,
            runtime_provider_id: "rho.ark-r",
            runtime_instance_id: "runtime.workspace-r",
            runtime_activation_generation: 3,
            console_instance_id: "console.main",
            submitted_code: "summary(model)",
            workspace_id: null,
            source_path: null,
            execution_mode: null,
            document_version: null,
            status: "admitted",
            terminal_reason: null,
            output_state: "collecting",
            last_sequence: 0,
            output_bytes: 0,
            started_at: "2026-08-24T00:00:00Z",
            finished_at: null,
          },
          committed_through: 0,
        } as T;
      }
      return snapshot as T;
    };
    const transport = createTauriRuntimeTransport(invoke);
    const createRequest = {
      project_id: "project-a",
      runtime_provider_id: "rho.ark-r",
      expected_project_revision: 7,
      expected_snapshot_revision: 5,
      display_label: null,
    } satisfies RuntimeCreateRequest;
    const executeRequest = {
      runtime: instanceRequest,
      console_instance_id: "console.main",
      expected_console_revision: 13,
      code: "summary(model)",
    } satisfies RuntimeExecuteRequest;

    await transport.loadRuntimes();
    await transport.createRuntime(createRequest);
    await transport.interruptRuntime(instanceRequest);
    await transport.restartRuntime(instanceRequest);
    await transport.stopRuntime(instanceRequest);
    await transport.startRuntimeExecution(executeRequest);

    expect(calls).toEqual([
      { command: "runtime_list" },
      { command: "runtime_create", args: { request: createRequest } },
      { command: "runtime_interrupt", args: { request: instanceRequest } },
      { command: "runtime_restart", args: { request: instanceRequest } },
      { command: "runtime_stop", args: { request: instanceRequest } },
      { command: "runtime_execution_start", args: { request: executeRequest } },
    ]);
  });

  it("preserves Tauri rejection semantics", async () => {
    const transport = createTauriRuntimeTransport(async () => {
      throw new Error("stale runtime");
    });
    await expect(transport.restartRuntime(instanceRequest)).rejects.toThrow("stale runtime");
  });

  it("keeps the browser mock assignable to the narrow domain facet", async () => {
    const transport: RuntimeTransport = createMockUiKernelTransport();
    const current = await transport.loadRuntimes();
    expect(current.contract).toBe("rho.ui.runtime-registry.snapshot.v1");
    expect(current.instances.length).toBeGreaterThan(0);
  });
});
