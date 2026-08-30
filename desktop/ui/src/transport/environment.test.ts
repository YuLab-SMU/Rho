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
            : command === "toolchain_initialize"
              ? null
            : command === "resource_monitor_snapshot"
              ? { status: "healthy", selected_target_id: "local", targets: [] }
              : command === "compute_target_list"
                ? { selected_target_id: "local", targets: [] }
                : command === "remote_connection_probe"
                  ? { status: "ready", authenticated: true, fingerprints: [] }
                  : command === "configure_ssh_target"
                    ? { project_selected: true, target: { target_id: "hpc" }, probe: { status: "ready" } }
                    : []) as T;
      },
    );

    await expect(transport.listInstalledPackages(200)).resolves.toEqual({ packages: [] });
    await expect(transport.listEnvironmentOperationRequests(50)).resolves.toEqual([]);
    await expect(transport.toolchainDoctor()).resolves.toMatchObject({ status: "ready" });
    await expect(transport.initializeToolchain({ confirmed: true })).resolves.toBeUndefined();
    await expect(transport.resourceMonitorSnapshot()).resolves.toMatchObject({ status: "healthy" });
    await expect(transport.computeTargetList()).resolves.toMatchObject({ selected_target_id: "local" });
    const probeRequest = {
      host: "hpc.example.edu", port: 2329, username: "user", password: null,
      identity_file: null, confirmed_fingerprint: null,
    };
    await expect(transport.remoteConnectionProbe(probeRequest)).resolves.toMatchObject({ authenticated: true });
    const configureRequest = {
      target_id: "hpc", host: "hpc.example.edu", port: 2329, username: "user",
      password: null, confirmed_fingerprint: "SHA256:test", remote_root: "/project",
      capabilities: ["cpu"], install_managed_key: false, identity_file: "/key",
      select_for_project: true,
    };
    await expect(transport.configureSshTarget(configureRequest)).resolves.toMatchObject({ project_selected: true });
    expect(calls).toEqual([
      { command: "list_installed_packages", args: { limit: 200 } },
      {
        command: "list_environment_operation_requests",
        args: { limit: 50, status: null },
      },
      { command: "toolchain_doctor" },
      { command: "toolchain_initialize", args: { request: { confirmed: true } } },
      { command: "resource_monitor_snapshot" },
      { command: "compute_target_list" },
      { command: "remote_connection_probe", args: { request: probeRequest } },
      { command: "configure_ssh_target", args: { request: configureRequest } },
    ]);
  });
});
