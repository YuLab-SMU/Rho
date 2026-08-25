import { describe, expect, it } from "vitest";

import fixture from "../../contracts/generated/rsr-contract-fixtures.json";
import type { LayoutNode } from "../../transport";
import { findLayoutPlacement } from "./LegacySceneLayout";

function fixtureRoot(): LayoutNode {
  return structuredClone(
    fixture.studio_runtime_snapshot.scene.root,
  ) as unknown as LayoutNode;
}

describe("legacy Scene layout adapter", () => {
  it("finds nested surfaces and active/inactive stack members without changing Scene truth", () => {
    const root = fixtureRoot();
    const before = structuredClone(root);

    expect(findLayoutPlacement(root, "instance:navigator")).toEqual({ kind: "surface" });
    expect(findLayoutPlacement(root, "instance:console-a")).toEqual({
      kind: "stack",
      nodeId: "node:consoles",
      active: true,
    });
    expect(findLayoutPlacement(root, "instance:console-b")).toEqual({
      kind: "stack",
      nodeId: "node:consoles",
      active: false,
    });
    expect(findLayoutPlacement(root, "instance:missing")).toBeNull();
    expect(root).toEqual(before);
  });
});
