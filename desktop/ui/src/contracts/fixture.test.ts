import { describe, expect, it } from "vitest";

import fixture from "./generated/rsr-contract-fixtures.json";

describe("Rust-generated RSR contract fixture", () => {
  it("projects the contract identity and safety budgets", () => {
    expect(fixture.contract).toBe("rho.ui.contract.fixture.v1");
    expect(fixture.contract_major).toBe(1);
    expect(fixture.limits.max_layout_depth).toBeGreaterThan(1);
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

    const files = fixture.instances.filter((instance) => instance.surface_id === "rho.file");
    expect(files).toHaveLength(2);
    expect(files[0]?.resource_binding).toEqual(files[1]?.resource_binding);
    expect(files[0]?.mode_id).not.toBe(files[1]?.mode_id);
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
});
