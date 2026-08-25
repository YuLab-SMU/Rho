import { describe, expect, it } from "vitest";

import fixture from "../contracts/generated/rsr-contract-fixtures.json";
import {
  createTauriKernelTransport,
  type AppInfo,
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
    const app = {
      version: "0.4.1-dev.16",
      channel: "development",
      commit: "fixture-commit",
      platform: "macos-aarch64",
      executable_path: "/Applications/Rho.app/Contents/MacOS/rho-desktop",
      frontend_entry: "assets/index-fixture.js",
      website_url: "https://yulab-smu.top/Rho/",
      source_url: "https://github.com/YuLab-SMU/Rho",
      runtime: {
        rscript: "/opt/R/bin/Rscript",
        r_version: "4.5.1",
        agent_available: true,
        aisdk_version: null,
      },
    } as const satisfies AppInfo;
    const transport = createTauriKernelTransport(
      async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push(args === undefined ? { command } : { command, args });
        return (command === "app_info" ? app : snapshot) as T;
      },
    );
    const request = {
      project_id: snapshot.project.project_id,
      expected_project_revision: snapshot.context.project_revision,
      expected_snapshot_revision: snapshot.snapshot_revision,
      selection: { kind: "run", run_id: "run:fixture" },
    } as const satisfies SetUiSelectionRequest;
    await expect(transport.appInfo()).resolves.toStrictEqual(app);
    await expect(transport.loadSnapshot()).resolves.toStrictEqual(snapshot);
    await expect(transport.setSelection(request)).resolves.toStrictEqual(snapshot);
    expect(calls).toEqual([
      { command: "app_info" },
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
    await expect(transport.appInfo()).resolves.toMatchObject({
      channel: "development",
      runtime: { agent_available: true },
    });
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
