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
