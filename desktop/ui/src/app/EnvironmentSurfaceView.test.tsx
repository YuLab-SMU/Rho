import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SurfaceInstance, UiKernelTransport } from "../transport";
import type { ResourceMonitorView } from "../transport/environment";
import { EnvironmentSurfaceView, EnvironmentTaskbarPanel } from "./EnvironmentSurfaceView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function resourceSurface(): SurfaceInstance {
  return {
    instance_id: "surface-instance:resources",
    surface_id: "rho.environment",
    project_id: "project:test",
    origin: { kind: "application", component_id: "rho.environment" },
    activation_generation: 1,
    surface_revision: 1,
    mode_id: "resources",
    resource_binding: null,
    runtime_binding: null,
    view_group_id: null,
    view_state: null,
    lifecycle_state: "active",
  };
}

const snapshot: ResourceMonitorView = {
  status: "critical",
  selected_target_id: "lab-gpu",
  observed_at: "2026-09-01T00:00:00Z",
  configured: true,
  rho_toml_sha256: "a".repeat(64),
  target_registry_sha256: "b".repeat(64),
  thresholds: {
    cpu_warning_basis_points: 8500,
    cpu_critical_basis_points: 9500,
    memory_available_warning_basis_points: 2000,
    memory_available_critical_basis_points: 1000,
    disk_available_warning_basis_points: 1500,
    disk_available_critical_basis_points: 500,
    gpu_warning_basis_points: 9000,
    gpu_critical_basis_points: 9800,
  },
  targets: [{
    target_id: "lab-gpu",
    selected: true,
    host_kind: "ssh",
    isolation_kind: "docker",
    environment_identity: "docker:registry/rho@sha256:abc",
    capabilities: ["cpu", "gpu"],
    status: "critical",
    admission_allowed: false,
    governance_reasons: ["Memory is under critical pressure"],
    device: {
      device_id: "device-lab",
      host_name: "gnode01",
      operating_system: "linux",
      architecture: "x86_64",
      observed_at: "2026-09-01T00:00:00Z",
      cpu_logical_count: 64,
      metrics: [{
        resource_id: "device-lab:memory",
        kind: "memory",
        label: "Memory",
        unit: "bytes",
        capacity: "68719476736",
        available: "3435973836",
        utilization_basis_points: 9500,
        pressure: "critical",
        detail: "3.2 GiB available",
      }],
    },
    error: null,
  }, {
    target_id: "local",
    selected: false,
    host_kind: "local",
    isolation_kind: "native",
    environment_identity: "native",
    capabilities: ["cpu"],
    status: "healthy",
    admission_allowed: true,
    governance_reasons: ["All observed governed resources are within threshold"],
    device: null,
    error: null,
  }],
  total_targets: 2,
  truncated: false,
};

describe("Environment resource governance", () => {
  it("projects target, device, metric pressure, and admission guards", async () => {
    const transport = {
      resourceMonitorSnapshot: vi.fn(async () => snapshot),
      loadDomainSurface: vi.fn(),
      subscribeInvalidated: vi.fn(() => () => undefined),
    } as unknown as UiKernelTransport;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(<EnvironmentSurfaceView
        instance={resourceSurface()}
        transport={transport}
        persist={vi.fn(async () => undefined)}
        reportError={vi.fn()}
      />);
      await settle();
    });

    expect(transport.resourceMonitorSnapshot).toHaveBeenCalledOnce();
    expect(transport.loadDomainSurface).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Resource governance");
    expect(host.textContent).toContain("lab-gpu");
    expect(host.textContent).toContain("gnode01");
    expect(host.textContent).toContain("Resource admission guarded");
    expect(host.textContent).toContain("Memory is under critical pressure");
    expect(host.querySelector("progress")?.getAttribute("value")).toBe("9500");
  });

  it("shows detected startup R and initializes an unmanaged project without config editing", async () => {
    let configured = false;
    const initialize = vi.fn(async () => { configured = true; });
    const transport = {
      toolchainDoctor: vi.fn(async () => configured ? {
        status: "ready", configured: true, rho_toml_sha256: "a".repeat(64), target_id: "local",
        target_registry_sha256: null, host_kind: "local", isolation_kind: "native",
        r_version: "4.5.2", rscript: "/opt/R/4.5.2/bin/Rscript", python_version: null, python: null, checks: [],
      } : {
        status: "unmanaged", configured: false, rho_toml_sha256: null, target_id: "local",
        target_registry_sha256: null, host_kind: "local", isolation_kind: "native",
        r_version: "4.5.2", rscript: "/opt/R/4.5.2/bin/Rscript", python_version: null, python: null,
        checks: [{ id: "workspace-r", status: "ready", detail: "Detected R 4.5.2" }],
      }),
      initializeToolchain: initialize,
      subscribeInvalidated: vi.fn(() => () => undefined),
    } as unknown as UiKernelTransport;
    const instance = { ...resourceSurface(), mode_id: "toolchains" };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(<EnvironmentSurfaceView instance={instance} transport={transport} persist={vi.fn()} reportError={vi.fn()} />);
      await settle();
    });
    expect(host.textContent).toContain("R 4.5.2");
    expect(host.textContent).toContain("No manual configuration file editing is required");
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Set up automatically")!.click();
      await settle();
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Confirm setup")!.click();
      await settle();
    });
    expect(initialize).toHaveBeenCalledWith({ confirmed: true });
    expect(host.textContent).toContain("Exact project environments are ready");
  });

  it("configures an SSH Slurm target without requiring a terminal", async () => {
    const probe = vi.fn(async (request: { readonly confirmed_fingerprint: string | null }) => request.confirmed_fingerprint == null
      ? {
          status: "host_key_confirmation_required", fingerprints: [{ algorithm: "ED25519", sha256: "SHA256:test" }],
          authenticated: false, host_name: null, home_directory: null, slurm_version: null, partitions: [], helper_available: false,
          message: "Confirm one discovered host fingerprint before authentication.",
        }
      : {
          status: "ready", fingerprints: [{ algorithm: "ED25519", sha256: "SHA256:test" }],
          authenticated: true, host_name: "master", home_directory: "/home/user", slurm_version: "slurm 19.05.2",
          partitions: [{ partition: "gpu_batch", available: "up", nodes: "1", gres: "gpu:3", cpus: "2/46/0/48" }],
          helper_available: true, message: "SSH and the Rho remote Helper are ready.",
        });
    const configure = vi.fn(async () => ({
      target: {
        target_id: "lab-hpc", selected: true, host_kind: "ssh", host: "172.16.153.230", port: 2329,
        username: "user", remote_root: "/project", isolation_kind: "native", capabilities: ["cpu", "gpu"],
        identity_file: "/rho/ssh/lab-hpc/id_ed25519", identity_available: true,
      },
      probe: await probe({ confirmed_fingerprint: "SHA256:test" }),
      project_selected: true,
    }));
    const transport = {
      computeTargetList: vi.fn(async () => ({
        selected_target_id: "local", targets_yaml: "/rho/targets.yaml",
        targets: [{ target_id: "local", selected: true, host_kind: "local", host: null, port: null, username: null, remote_root: null, isolation_kind: "native", capabilities: ["cpu"], identity_file: null, identity_available: true }],
      })),
      remoteConnectionProbe: probe,
      configureSshTarget: configure,
      subscribeInvalidated: vi.fn(() => () => undefined),
    } as unknown as UiKernelTransport;
    const instance = { ...resourceSurface(), mode_id: "connections" };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(<EnvironmentSurfaceView instance={instance} transport={transport} persist={vi.fn()} reportError={vi.fn()} />);
      await settle();
    });
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const enter = async (label: string, value: string) => {
      const input = [...host.querySelectorAll<HTMLInputElement>("label input")]
        .find((candidate) => candidate.closest("label")?.textContent?.startsWith(label))!;
      await act(async () => {
        setInput.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await settle();
      });
    };
    await enter("Address", "172.16.153.230");
    await enter("SSH port", "2329");
    await enter("Username", "user");
    await enter("Password", "one-time-secret");
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Connect automatically")!.click();
      await settle();
    });
    expect(host.textContent).toContain("slurm 19.05.2");
    expect(host.textContent).toContain("gpu_batch · 1 node(s) · gpu:3");
    expect(host.textContent).toContain("Rho remote Helper ready");
    expect(configure).toHaveBeenCalledOnce();
    expect(host.querySelector<HTMLInputElement>("input[type='password']")?.value).toBe("");
  });

  it("turns the status bar into a live three-metric Environment panel", async () => {
    const transport = {
      resourceMonitorSnapshot: vi.fn(async () => snapshot),
      subscribeInvalidated: vi.fn(() => () => undefined),
    } as unknown as UiKernelTransport;
    const openResources = vi.fn();
    const openDiagnostics = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(<EnvironmentTaskbarPanel
        transport={transport}
        workspaceState="ready"
        workspaceLabel="Workspace R ready"
        agentState="degraded"
        agentLabel="Agent runtime needs attention"
        activeOperations={2}
        openResources={openResources}
        openConnections={vi.fn()}
        openDiagnostics={openDiagnostics}
        diagnosticsAvailable
      />);
      await settle();
    });

    expect([...host.querySelectorAll(".rho-environment-taskbar-metric")]
      .map((metric) => metric.textContent)).toEqual(["CPU—", "RAM95%", "Disk—"]);
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[aria-label='Environment realtime information']")!.click();
      await settle();
    });
    expect(host.textContent).toContain("Environment realtime");
    expect(host.textContent).toContain("Workspace R ready");
    expect(host.textContent).toContain("Agent runtime needs attention");
    expect(host.textContent).toContain("2 active operations");
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>(".rho-environment-taskbar-popover footer button")]
        .find((button) => button.textContent === "Open Environment Resources")!.click();
    });
    expect(openResources).toHaveBeenCalledOnce();
  });
});
