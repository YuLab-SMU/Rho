import { describe, expect, it } from "vitest";

import fixture from "../contracts/generated/rsr-contract-fixtures.json";
import {
  computeStudioDrop,
  computeStudioEmergence,
  findStudioInstancePlacement,
} from "./studio-model";
import type { LayoutChild, LayoutNode, SceneState } from "./types";

const scene = fixture.scenes[0] as unknown as SceneState;

function allocateFactory() {
  let next = 0;
  return () => `layout-node:test-${(next += 1)}`;
}

function childKind(node: LayoutNode, index: number): LayoutNode | undefined {
  return node.kind === "container" ? node.children[index]?.child : undefined;
}

describe("computeStudioDrop", () => {
  it("stacks onto a lone surface at center, converting it to a stack", () => {
    const next = computeStudioDrop(scene, "instance:console-a", {
      nodeId: "node:file",
      instanceId: "instance:file-source",
      zone: "center",
    }, allocateFactory());
    expect(next).not.toBeNull();
    const center = childKind(next!.root, 1);
    expect(center?.kind).toBe("container");
    const first = childKind(center!, 0);
    expect(first?.kind).toBe("stack");
    if (first?.kind !== "stack") return;
    expect(first.instances).toEqual(["instance:file-source", "instance:console-a"]);
    expect(first.active_instance_id).toBe("instance:console-a");
  });

  it("inserts beside the target when the parent axis matches the drop edge", () => {
    const next = computeStudioDrop(scene, "instance:console-a", {
      nodeId: "node:navigator",
      instanceId: "instance:navigator",
      zone: "right",
    }, allocateFactory());
    expect(next).not.toBeNull();
    if (next!.root.kind !== "container") throw new Error("root must stay a container");
    const order = next!.root.children.map((child) =>
      child.child.kind === "surface"
        ? child.child.instance_id
        : child.child.kind === "stack"
          ? `stack:${child.child.instances.join("+")}`
          : `container:${child.child.children.length}`);
    expect(order).toEqual([
      "instance:navigator",
      "instance:console-a",
      "container:2",
      "instance:environment",
    ]);
    // The vacated console stack normalizes to a lone surface.
    const center = next!.root.children[2]!.child;
    if (center.kind !== "container") throw new Error("center must stay a container");
    const consoles = center.children[1]!.child;
    expect(consoles.kind === "surface" && consoles.instance_id === "instance:console-b").toBe(true);
  });

  it("wraps the target in a new split when the parent axis differs", () => {
    const next = computeStudioDrop(scene, "instance:console-a", {
      nodeId: "node:navigator",
      instanceId: "instance:navigator",
      zone: "top",
    }, allocateFactory());
    expect(next).not.toBeNull();
    const first = childKind(next!.root, 0);
    expect(first?.kind).toBe("container");
    if (first?.kind !== "container") return;
    expect(first.axis).toBe("vertical");
    expect(first.children[0]?.child.kind === "surface" && first.children[0].child.instance_id === "instance:console-a").toBe(true);
    expect(first.children[1]?.child.kind === "surface" && first.children[1].child.instance_id === "instance:navigator").toBe(true);
  });

  it("reorders tabs inside one stack through a center drop", () => {
    const next = computeStudioDrop(scene, "instance:console-a", {
      nodeId: "node:consoles",
      instanceId: "instance:console-b",
      zone: "center",
    }, allocateFactory());
    expect(next).not.toBeNull();
    const center = childKind(next!.root, 1);
    const consoles = center != null && center.kind === "container" ? center.children[1]!.child : null;
    expect(consoles?.kind).toBe("stack");
    if (consoles?.kind !== "stack") return;
    expect(consoles.instances).toEqual(["instance:console-b", "instance:console-a"]);
    expect(consoles.active_instance_id).toBe("instance:console-a");
  });

  it("inserts a tab at the exact side of its target and rejects structural no-ops", () => {
    const before = computeStudioDrop(scene, "instance:console-b", {
      nodeId: "node:consoles",
      instanceId: "instance:console-a",
      zone: "tab-before",
    }, allocateFactory());
    expect(before).not.toBeNull();
    const center = childKind(before!.root, 1);
    const consoles = center != null && center.kind === "container" ? center.children[1]!.child : null;
    expect(consoles?.kind).toBe("stack");
    if (consoles?.kind !== "stack") return;
    expect(consoles.instances).toEqual(["instance:console-b", "instance:console-a"]);
    expect(consoles.active_instance_id).toBe("instance:console-b");

    expect(computeStudioDrop(scene, "instance:console-a", {
      nodeId: "node:consoles",
      instanceId: "instance:console-b",
      zone: "tab-before",
    }, allocateFactory())).toBeNull();
  });

  it("inserts into another Stack before the exact hovered tab", () => {
    const next = computeStudioDrop(scene, "instance:console-a", {
      nodeId: "node:context",
      instanceId: "instance:environment",
      zone: "tab-before",
    }, allocateFactory());
    expect(next).not.toBeNull();
    const context = childKind(next!.root, 2);
    expect(context?.kind).toBe("stack");
    if (context?.kind !== "stack") return;
    expect(context.instances).toEqual(["instance:console-a", "instance:environment"]);
    expect(context.active_instance_id).toBe("instance:console-a");
  });

  it("tears the active tab out against its own Stack edge", () => {
    const next = computeStudioDrop(scene, "instance:console-a", {
      nodeId: "node:consoles",
      instanceId: "instance:console-a",
      zone: "left",
    }, allocateFactory());
    expect(next).not.toBeNull();
    const center = childKind(next!.root, 1);
    const consoles = center != null && center.kind === "container" ? center.children[1]!.child : null;
    expect(consoles?.kind).toBe("container");
    if (consoles?.kind !== "container") return;
    expect(consoles.axis).toBe("horizontal");
    expect(consoles.children.map((child) =>
      child.child.kind === "surface" ? child.child.instance_id : child.child.kind
    )).toEqual(["instance:console-a", "instance:console-b"]);
  });

  it("stacks onto a stack pane, appending to its tabs", () => {
    const next = computeStudioDrop(scene, "instance:console-a", {
      nodeId: "node:context",
      instanceId: "instance:environment",
      zone: "center",
    }, allocateFactory());
    expect(next).not.toBeNull();
    const context = childKind(next!.root, 2);
    expect(context?.kind).toBe("stack");
    if (context?.kind !== "stack") return;
    expect(context.instances).toEqual(["instance:environment", "instance:console-a"]);
    expect(context.active_instance_id).toBe("instance:console-a");
  });

  it("rejects self drops and unplaced instances", () => {
    expect(computeStudioDrop(scene, "instance:console-a", {
      nodeId: "node:consoles",
      instanceId: "instance:console-a",
      zone: "center",
    }, allocateFactory())).toBeNull();
    expect(computeStudioDrop(scene, "instance:status", {
      nodeId: "node:file",
      instanceId: "instance:file-source",
      zone: "center",
    }, allocateFactory())).toBeNull();
  });

  it("wraps a lone-surface root in a new split root", () => {
    const lone: SceneState = {
      scene_id: "scene:lone",
      project_id: "project:fixture",
      label: "Lone",
      layout_revision: 1,
      root: { kind: "surface", node_id: "node:lone", instance_id: "instance:a" },
      focused_surface_instance_id: null,
      utility_tray: null,
    };
    const placed: SceneState = structuredClone(lone);
    // Pretend instance:b is placed elsewhere by starting from a two-surface scene.
    const two: SceneState = {
      ...placed,
      root: {
        kind: "container",
        node_id: "node:root",
        axis: "horizontal",
        children: [
          { child: lone.root, basis: { kind: "fraction", weight: 1 }, resizable: true, collapse_priority: null },
          { child: { kind: "surface", node_id: "node:other", instance_id: "instance:b" }, basis: { kind: "fraction", weight: 1 }, resizable: true, collapse_priority: null },
        ],
      },
    };
    // Drag b onto the whole pane a's left edge: parent axis already matches,
    // so it inserts before a.
    const beside = computeStudioDrop(two, "instance:b", {
      nodeId: "node:lone",
      instanceId: "instance:a",
      zone: "left",
    }, allocateFactory());
    expect(beside).not.toBeNull();
    if (beside!.root.kind !== "container") throw new Error("root must stay a container");
    expect(beside!.root.children.map((child) => child.child.kind === "surface" ? child.child.instance_id : child.child.kind)).toEqual([
      "instance:b",
      "instance:a",
    ]);
    // A genuine axis mismatch wraps only the target pane; the root keeps its axis.
    const rotated = computeStudioDrop(two, "instance:a", {
      nodeId: "node:other",
      instanceId: "instance:b",
      zone: "top",
    }, allocateFactory());
    expect(rotated).not.toBeNull();
    if (rotated!.root.kind !== "container") throw new Error("root must stay a container");
    expect(rotated!.root.axis).toBe("horizontal");
    expect(rotated!.root.children).toHaveLength(1);
    const wrapped = rotated!.root.children[0]!.child;
    expect(wrapped.kind).toBe("container");
    if (wrapped.kind !== "container") return;
    expect(wrapped.axis).toBe("vertical");
    expect(wrapped.children[0]?.child.kind === "surface" && wrapped.children[0].child.instance_id === "instance:a").toBe(true);
    expect(wrapped.children[1]?.child.kind === "surface" && wrapped.children[1].child.instance_id === "instance:b").toBe(true);
  });
});

describe("component emergence placement", () => {
  it("finds visible and inactive Stack placements exactly", () => {
    expect(findStudioInstancePlacement(scene, "instance:file-source")).toEqual({
      nodeId: "node:file",
      kind: "surface",
      active: true,
    });
    expect(findStudioInstancePlacement(scene, "instance:console-a")).toEqual({
      nodeId: "node:consoles",
      kind: "stack",
      active: true,
    });
    expect(findStudioInstancePlacement(scene, "instance:console-b")).toEqual({
      nodeId: "node:consoles",
      kind: "stack",
      active: false,
    });
    expect(findStudioInstancePlacement(scene, "instance:status")).toBeNull();
  });

  it("places an unplaced requirement below Source with focused 7:3 sizing", () => {
    const withoutConsoles = structuredClone(scene);
    if (withoutConsoles.root.kind !== "container") throw new Error("root must be a container");
    const center = withoutConsoles.root.children[1]?.child;
    if (center?.kind !== "container") throw new Error("center must be a container");
    (center.children as LayoutChild[]).splice(1, 1);

    const next = computeStudioEmergence(
      withoutConsoles,
      "instance:console-a",
      "instance:file-source",
      allocateFactory(),
    );
    expect(next).not.toBeNull();
    const nextCenter = childKind(next!.root, 1);
    if (nextCenter?.kind !== "container") throw new Error("center must stay a container");
    expect(nextCenter.axis).toBe("vertical");
    expect(nextCenter.children.map((child) =>
      child.child.kind === "surface" ? child.child.instance_id : child.child.kind
    )).toEqual(["instance:file-source", "instance:console-a"]);
    expect(nextCenter.children[0]?.basis).toEqual({ kind: "fraction", weight: 7 });
    expect(nextCenter.children[1]?.basis).toEqual({
      kind: "minmax",
      min_logical_pixels: 160,
      max_logical_pixels: 1_400,
      weight: 3,
    });
  });

  it("wraps only the invoking pane when its parent axis differs", () => {
    const next = computeStudioEmergence(
      scene,
      "instance:status",
      "instance:navigator",
      allocateFactory(),
    );
    expect(next).not.toBeNull();
    const first = childKind(next!.root, 0);
    expect(first?.kind).toBe("container");
    if (first?.kind !== "container") return;
    expect(first.axis).toBe("vertical");
    expect(first.children[0]?.basis).toEqual({ kind: "fraction", weight: 7 });
    expect(first.children[1]?.basis).toMatchObject({ kind: "minmax", weight: 3 });
  });

  it("moves an already placed requirement below the invoking Source", () => {
    const next = computeStudioEmergence(
      scene,
      "instance:console-a",
      "instance:file-source",
      allocateFactory(),
    );
    expect(next).not.toBeNull();
    const center = childKind(next!.root, 1);
    if (center?.kind !== "container") throw new Error("center must stay a container");
    expect(center.children).toHaveLength(3);
    expect(center.children[0]?.child.kind === "surface" &&
      center.children[0].child.instance_id === "instance:file-source").toBe(true);
    expect(center.children[1]?.child.kind === "surface" &&
      center.children[1].child.instance_id === "instance:console-a").toBe(true);
    expect(findStudioInstancePlacement(next!, "instance:console-b")?.active).toBe(true);
  });

  it("wraps a lone invoking root and rejects missing or self requirements", () => {
    const lone: SceneState = {
      scene_id: "scene:lone",
      project_id: "project:fixture",
      label: "Lone",
      layout_revision: 1,
      root: { kind: "surface", node_id: "node:lone", instance_id: "instance:source" },
      focused_surface_instance_id: "instance:source",
      utility_tray: null,
    };
    const next = computeStudioEmergence(
      lone,
      "instance:console",
      "instance:source",
      allocateFactory(),
    );
    expect(next?.root.kind).toBe("container");
    if (next?.root.kind !== "container") return;
    expect(next.root.axis).toBe("vertical");
    expect(next.root.children.map((child) => child.basis)).toEqual([
      { kind: "fraction", weight: 7 },
      { kind: "minmax", min_logical_pixels: 160, max_logical_pixels: 1_400, weight: 3 },
    ]);
    expect(computeStudioEmergence(lone, "instance:source", "instance:source", allocateFactory())).toBeNull();
    expect(computeStudioEmergence(lone, "instance:console", "instance:missing", allocateFactory())).toBeNull();
  });
});
