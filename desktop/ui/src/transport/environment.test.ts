import { describe, expect, it } from "vitest";

import { createTauriEnvironmentReadTransport } from "./environment";

describe("Environment generated read transport", () => {
  it("owns exact inventory and operation-request commands", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const transport = createTauriEnvironmentReadTransport(
      async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push(args === undefined ? { command } : { command, args });
        return (command === "list_installed_packages"
          ? { packages: [] }
          : command === "toolchain_doctor"
            ? { status: "ready", configured: true, checks: [] }
            : command === "resource_monitor_snapshot"
              ? { status: "healthy", selected_target_id: "local", targets: [] }
              : []) as T;
      },
    );

    await expect(transport.listInstalledPackages(200)).resolves.toEqual({ packages: [] });
    await expect(transport.listEnvironmentOperationRequests(50)).resolves.toEqual([]);
    await expect(transport.toolchainDoctor()).resolves.toMatchObject({ status: "ready" });
    await expect(transport.resourceMonitorSnapshot()).resolves.toMatchObject({ status: "healthy" });
    expect(calls).toEqual([
      { command: "list_installed_packages", args: { limit: 200 } },
      {
        command: "list_environment_operation_requests",
        args: { limit: 50, status: null },
      },
      { command: "toolchain_doctor" },
      { command: "resource_monitor_snapshot" },
    ]);
  });
});
