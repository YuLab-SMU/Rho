import { describe, expect, it } from "vitest";

import fixture from "../contracts/generated/rsr-contract-fixtures.json";
import {
  createTauriKernelTransport,
  type KernelTransport,
  type SetUiSelectionRequest,
} from "./kernel-generated";
import { createMockUiKernelTransport } from "./mock";
import type { UiKernelSnapshot } from "./kernel-generated";

function fixtureSnapshot(): UiKernelSnapshot {
  return structuredClone(fixture.kernel_snapshot) as unknown as UiKernelSnapshot;
}

describe("UI Kernel generated transport", () => {
  it("owns exact snapshot and selection commands", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const snapshot = fixtureSnapshot();
    const transport = createTauriKernelTransport(
      async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push(args === undefined ? { command } : { command, args });
        return snapshot as T;
      },
    );
    const request = {
      project_id: snapshot.project.project_id,
      expected_project_revision: snapshot.context.project_revision,
      expected_snapshot_revision: snapshot.snapshot_revision,
      selection: { kind: "run", run_id: "run:fixture" },
    } as const satisfies SetUiSelectionRequest;
    await expect(transport.loadSnapshot()).resolves.toStrictEqual(snapshot);
    await expect(transport.setSelection(request)).resolves.toStrictEqual(snapshot);
    expect(calls).toEqual([
      { command: "ui_kernel_snapshot" },
      { command: "ui_set_selection", args: { request } },
    ]);
  });

  it("fails closed on unsupported snapshot identity", async () => {
    const snapshot = { ...fixtureSnapshot(), contract_major: 2 };
    const transport = createTauriKernelTransport(async <T,>() => snapshot as T);
    await expect(transport.loadSnapshot()).rejects.toThrow("Unsupported UI Kernel contract");
  });

  it("keeps the browser mock assignable to the narrow generated facet", async () => {
    const transport: KernelTransport = createMockUiKernelTransport();
    const snapshot = await transport.loadSnapshot();
    await expect(transport.setSelection({
      project_id: snapshot.project.project_id,
      expected_project_revision: snapshot.context.project_revision,
      expected_snapshot_revision: snapshot.snapshot_revision,
      selection: null,
    })).resolves.toMatchObject({ contract: "rho.ui.kernel.snapshot.v1" });
    await expect(transport.setSelection({
      project_id: snapshot.project.project_id,
      expected_project_revision: snapshot.context.project_revision,
      expected_snapshot_revision: snapshot.snapshot_revision,
      selection: null,
    })).rejects.toThrow("stale");
  });
});
