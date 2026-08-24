import { describe, expect, it } from "vitest";

import type { LayoutChild } from "../transport/types";
import { residualSpaceRecipient } from "./layout-rendering";

function child(
  nodeId: string,
  basis: LayoutChild["basis"],
  resizable = true,
): LayoutChild {
  return {
    basis,
    collapse_priority: null,
    resizable,
    child: { kind: "surface", node_id: nodeId, instance_id: `instance:${nodeId}` },
  };
}

describe("adaptive layout residual space", () => {
  it("assigns otherwise unused space to the last visible resizable work child", () => {
    const children = [
      child("navigator", { kind: "fixed", logical_pixels: 260 }),
      child("source", { kind: "fixed", logical_pixels: 380 }),
      child("console", { kind: "fixed", logical_pixels: 370 }),
    ];
    expect(residualSpaceRecipient(children, new Set())).toBe(2);
  });

  it("never stretches intrinsic, collapsed or non-resizable children", () => {
    const children = [
      child("source", { kind: "fixed", logical_pixels: 640 }),
      child("console", { kind: "fixed", logical_pixels: 360 }),
      child("status", { kind: "intrinsic" }),
    ];
    expect(residualSpaceRecipient(children, new Set())).toBe(1);
    expect(residualSpaceRecipient(children, new Set([1]))).toBe(0);
    expect(residualSpaceRecipient([
      child("source", { kind: "fixed", logical_pixels: 640 }, false),
      child("status", { kind: "intrinsic" }),
    ], new Set())).toBeNull();
  });
});
