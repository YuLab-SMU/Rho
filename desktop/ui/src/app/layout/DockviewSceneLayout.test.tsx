import { Orientation } from "dockview-react";
import { describe, expect, it } from "vitest";

import fixture from "../../contracts/generated/rsr-contract-fixtures.json";
import type { LayoutNode, SurfaceInstance } from "../../transport";
import {
  adaptiveCollapsedRegions,
  dockviewToScene,
  resizeDockviewBoundary,
  sceneToDockview,
} from "./DockviewSceneLayout";

function fixtureRoot(): LayoutNode {
  return structuredClone(fixture.studio_runtime_snapshot.scene.root) as unknown as LayoutNode;
}

function fixtureInstances(): ReadonlyMap<string, SurfaceInstance> {
  return new Map(
    fixture.surface_runtime_snapshot.catalog.instances.map((instance) => [
      instance.instance_id,
      structuredClone(instance) as unknown as SurfaceInstance,
    ]),
  );
}

function allocator() {
  let next = 0;
  return () => `allocated:${next++}`;
}

describe("controlled Dockview Scene adapter", () => {
  it("round-trips recursive containers, one-member stacks, node ids and Rho policies", () => {
    const root = fixtureRoot();
    const before = structuredClone(root);
    const serialized = sceneToDockview(root, fixtureInstances(), { width: 1_440, height: 900 });

    expect(serialized).not.toBeNull();
    expect(serialized!.grid.orientation).toBe(Orientation.HORIZONTAL);
    expect(Object.keys(serialized!.panels).sort()).toEqual([
      "instance:console-a",
      "instance:console-b",
      "instance:environment",
      "instance:file-source",
      "instance:navigator",
    ]);
    expect(dockviewToScene(serialized!, root, allocator())).toEqual(root);
    expect(root).toEqual(before);
  });

  it("uses a transparent grid shim when adjacent Rho containers repeat an axis", () => {
    const root: LayoutNode = {
      kind: "container",
      node_id: "root",
      axis: "horizontal",
      children: [{
        child: {
          kind: "container",
          node_id: "nested",
          axis: "horizontal",
          children: [
            {
              child: { kind: "surface", node_id: "a", instance_id: "instance:navigator" },
              basis: { kind: "fraction", weight: 1 },
              resizable: true,
              collapse_priority: null,
            },
            {
              child: { kind: "surface", node_id: "b", instance_id: "instance:file-source" },
              basis: { kind: "fraction", weight: 2 },
              resizable: false,
              collapse_priority: 4,
            },
          ],
        },
        basis: { kind: "fraction", weight: 1 },
        resizable: true,
        collapse_priority: null,
      }],
    };
    const serialized = sceneToDockview(root, fixtureInstances());
    expect(serialized).not.toBeNull();
    const rootChildren = serialized!.grid.root.data as Array<{ type: string; data: unknown }>;
    expect(rootChildren[0]).toMatchObject({ type: "branch", data: [{ type: "branch" }] });
    expect(dockviewToScene(serialized!, root, allocator())).toEqual(root);
  });

  it("rejects unknown, duplicate and omitted Surface placements before a Scene edit exists", () => {
    const root = fixtureRoot();
    const unknown = sceneToDockview(root, fixtureInstances())!;
    const firstLeaf = ((unknown.grid.root.data as Array<{ data: unknown }>)[0]!.data) as {
      views: string[];
    };
    firstLeaf.views[0] = "instance:foreign";
    expect(() => dockviewToScene(unknown, root, allocator())).toThrow("unknown Surface");

    const omitted = sceneToDockview(root, fixtureInstances())!;
    const nested = omitted.grid.root.data as Array<{ data: unknown }>;
    nested.pop();
    expect(() => dockviewToScene(omitted, root, allocator())).toThrow("omitted");

    const duplicated = sceneToDockview(root, fixtureInstances())!;
    const duplicateLeaf = ((duplicated.grid.root.data as Array<{ data: unknown }>)[0]!.data) as {
      views: string[];
    };
    duplicateLeaf.views.push("instance:navigator");
    expect(() => dockviewToScene(duplicated, root, allocator())).toThrow("duplicated Surface");
  });

  it("turns sash geometry into fixed Rho bases without mutating the observation", () => {
    const root = fixtureRoot();
    const serialized = sceneToDockview(root, fixtureInstances())!;
    const before = structuredClone(serialized);
    const resized = resizeDockviewBoundary(serialized, 0, 0, 64);
    expect(resized).not.toBeNull();
    expect(serialized).toEqual(before);

    const converted = dockviewToScene(resized!, root, allocator(), "resize");
    expect(converted.kind).toBe("container");
    if (converted.kind !== "container") return;
    expect(converted.children[0]?.basis).toMatchObject({ kind: "fixed" });
    expect(converted.children[1]?.basis).toMatchObject({ kind: "fixed" });
    const beforePixels = (converted.children[0]!.basis as { logical_pixels: number }).logical_pixels;
    const afterPixels = (converted.children[1]!.basis as { logical_pixels: number }).logical_pixels;
    expect(beforePixels + afterPixels).toBe(240 + 1_232);
  });

  it("keeps adaptive collapse view-only, priority ordered and explicitly restorable", () => {
    const root = fixtureRoot();
    const instances = fixtureInstances();
    expect(adaptiveCollapsedRegions(root, instances, { width: 3_000, height: 1_500 })).toEqual([]);

    const narrow = adaptiveCollapsedRegions(root, instances, { width: 400, height: 500 });
    expect(narrow.map(({ label }) => label)).toEqual(["Environment", "Navigator"]);
    const contextKey = narrow[0]!.key;
    const forced = adaptiveCollapsedRegions(
      root,
      instances,
      { width: 400, height: 500 },
      new Set([contextKey]),
    );
    expect(forced.map(({ label }) => label)).toEqual(["Navigator"]);
    expect(root).toEqual(fixtureRoot());
  });
});
