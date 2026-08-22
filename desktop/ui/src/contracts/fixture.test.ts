import { describe, expect, it } from "vitest";

import fixture from "./generated/rsr-contract-fixtures.json";

describe("Rust-generated RSR contract fixture", () => {
  it("projects the contract identity and safety budgets", () => {
    expect(fixture.contract).toBe("rho.ui.contract.fixture.v1");
    expect(fixture.contract_major).toBe(1);
    expect(fixture.limits.max_layout_depth).toBeGreaterThan(1);
    expect(fixture.limits.max_command_registry_bytes).toBe(1024 * 1024);
    expect(fixture.limits.max_surface_placements).toBeGreaterThan(
      fixture.limits.max_vibe_live_surfaces,
    );
    expect(fixture.limits.vibe_grid_columns).toBe(12);
  });

  it("keeps visual instances independent from resource and runtime identity", () => {
    const consoles = fixture.instances.filter((instance) => instance.surface_id === "rho.console");
    expect(consoles).toHaveLength(2);
    expect(consoles[0]?.instance_id).not.toBe(consoles[1]?.instance_id);
    expect(consoles[0]?.runtime_binding?.runtime_instance_id).toBe(
      consoles[1]?.runtime_binding?.runtime_instance_id,
    );

    const files = fixture.instances.filter((instance) =>
      instance.surface_id === "rho.file-source" || instance.surface_id === "rho.file-preview"
    );
    expect(files).toHaveLength(2);
    expect(files[0]?.resource_binding).toEqual(files[1]?.resource_binding);
    expect(files[0]?.mode_id).not.toBe(files[1]?.mode_id);
    expect(files[0]?.surface_id).not.toBe(files[1]?.surface_id);
  });

  it("contains asymmetric Studio and ordered Vibe examples", () => {
    const scene = fixture.scenes[0];
    expect(scene?.root.kind).toBe("container");
    if (scene?.root.kind !== "container") throw new Error("fixture scene root changed");
    expect(scene.root.children[0]?.basis).toEqual({ kind: "fraction", weight: 7 });
    expect(JSON.stringify(scene)).toContain('"kind":"intrinsic"');

    const page = fixture.pages[0];
    expect(page?.sections[0]?.layout.kind).toBe("grid");
    expect(page?.sections[0]?.blocks.map((block) => block.block_id)).toEqual([
      "block:narrative",
      "block:check",
    ]);
  });

  it("contains one bounded command/context snapshot with exact plugin origin", () => {
    const snapshot = fixture.kernel_snapshot;
    expect(snapshot.contract).toBe("rho.ui.kernel.snapshot.v1");
    expect(snapshot.project.project_id).toBe(snapshot.context.project_id);
    expect(snapshot.health.agent.state).toBe(snapshot.context.agent_health);
    expect(snapshot.context.active_operations).toHaveLength(1);
    const plugin = snapshot.command_registry.registrations.find(
      (registration) => registration.definition.command_id === "ui.command.fixture-inspect",
    );
    expect(plugin?.activation_generation).toBe(3);
    expect(plugin?.definition.origin.kind).toBe("workspace_plugin");
    expect(plugin?.availability).toEqual({
      state: "unavailable",
      reason: "The fixture plugin host is unavailable.",
    });
  });

  it("contains a generation-bound multi-instance Surface Runtime snapshot", () => {
    const snapshot = fixture.surface_runtime_snapshot;
    expect(snapshot.contract).toBe("rho.ui.surface-runtime.snapshot.v1");
    expect(snapshot.project_id).toBe(fixture.kernel_snapshot.project.project_id);
    const factory = snapshot.catalog.factories.find(
      (candidate) => candidate.definition.surface_id === "rho.surface-playground",
    );
    expect(factory?.activation_generation).toBe(1);
    expect(factory?.definition.instance_policy).toBe("multi_instance");
    const instances = snapshot.catalog.instances.filter(
      (instance) => instance.surface_id === "rho.surface-playground",
    );
    expect(instances).toHaveLength(2);
    expect(instances[0]?.resource_binding).toEqual(instances[1]?.resource_binding);
    expect(instances[0]?.instance_id).not.toBe(instances[1]?.instance_id);
  });

  it("contains an attachable Runtime Registry without exposing Agent R", () => {
    const registry = fixture.runtime_registry_snapshot;
    expect(registry.contract).toBe("rho.ui.runtime-registry.snapshot.v1");
    expect(registry.project_id).toBe(fixture.kernel_snapshot.project.project_id);
    expect(registry.providers[0]?.definition.runtime_provider_id).toBe("rho.ark-r");
    expect(registry.providers[0]?.definition.create_supported).toBe(true);
    expect(registry.instances.map((runtime) => runtime.runtime_instance_id)).toEqual([
      "runtime:workspace-r",
    ]);
    expect(JSON.stringify(registry).toLowerCase()).not.toContain("agent r");
  });
});
