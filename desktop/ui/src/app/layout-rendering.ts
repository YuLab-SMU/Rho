import type { LayoutChild } from "../transport/types";

export function residualSpaceRecipient(
  children: readonly LayoutChild[],
  collapsed: ReadonlySet<number>,
): number | null {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (
      child != null &&
      !collapsed.has(index) &&
      child.resizable &&
      child.basis.kind !== "intrinsic"
    ) return index;
  }
  return null;
}
