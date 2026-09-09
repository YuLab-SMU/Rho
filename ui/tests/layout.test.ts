import { expect, it } from "vitest";
import { Actions, TabSetNode } from "flexlayout-react";
import { PanelLayout, defaultLayout } from "../src/layout-model";
function fixture() {
  return { l: new PanelLayout() };
}
it("reclaims every closed group and reopens one view without resetting the workspace", () => {
  const { l } = fixture();
  for (const id of ["editor", "console", "objects", "plots", "files"])
    l.close(id);
  expect(l.empty).toBe(true);
  l.show("console");
  expect(l.empty).toBe(false);
  expect(l.model.getNodeById("files")).toBeUndefined();
});
it.each(["Left", "Right", "Above", "Below"] as const)(
  "previews and commits parent docking %s without altering the live model during preview",
  (direction) => {
    const { l } = fixture(),
      before = l.model.toJson();
    const preview = l.preview("plots", "editing-region", direction);
    expect(preview).not.toBeNull();
    expect(l.model.toJson()).toEqual(before);
    expect(l.move("plots", "editing-region", direction)).toBe(true);
    expect(l.model.getNodeById("plots")).toBeTruthy();
    l.undo();
    expect(l.model.toJson()).toEqual(before);
  },
);
it("preserves a closed document's identity and bounds layout history", () => {
  const { l } = fixture();
  const d = { id: "document:1", name: "analysis.R" };
  l.show("document", d.id, d.name);
  expect(l.model.getNodeById("editor")).toBeUndefined();
  l.close(d.id);
  expect(l.getSnapshot().knownViews[d.id].name).toBe(d.name);
  expect(l.isClosed(d.id)).toBe(true);
  l.show("document", d.id, d.name);
  const group = l.model.getNodeById(d.id)!.getParent() as TabSetNode;
  for (let i = 0; i < 24; i++) l.collapse(group);
  expect(l.serialize().layoutHistory).toHaveLength(20);
});
it("coalesces resizing into one history step", () => {
  const { l } = fixture();
  l.model.doAction(
    Actions.adjustWeights("editing-region", [55, 45]).setAdjusting(true),
  );
  l.model.doAction(
    Actions.adjustWeights("editing-region", [50, 50]).setAdjusting(true),
  );
  expect(l.serialize().layoutHistory).toHaveLength(0);
  l.model.doAction(Actions.adjustWeights("editing-region", [50, 50]));
  expect(l.serialize().layoutHistory).toHaveLength(1);
});
it("uses new defaults only for new workspaces", () => {
  const { l } = fixture();
  const saved = defaultLayout(1280);
  saved.layout.children.pop();
  l.restore({ layout: saved });
  expect(l.model.getNodeById("plots")).toBeUndefined();
});

it("restores Packages through the same registry as visible panels and remembers closed views", () => {
  const { l } = fixture();
  l.show("packages");
  l.close("packages");
  const restored = new PanelLayout();
  restored.restore(l.serialize());
  expect(restored.getSnapshot().knownViews.packages.component).toBe("packages");
  expect(restored.isClosed("packages")).toBe(true);
  restored.show("packages");
  expect(restored.has("packages")).toBe(true);
  expect(restored.isClosed("packages")).toBe(false);
});

it("reports only selected, expanded views, including maximized visibility", () => {
  const { l } = fixture();
  expect(l.getSnapshot().activeViewIds).toContain("plots");
  l.show("plots", "plots:comparison", "Comparison 1");
  const comparison = l.model.getNodeById("plots:comparison")!.getParent() as TabSetNode;
  l.model.doAction(Actions.maximizeToggle(comparison.getId()));
  expect(l.getSnapshot().activeViewIds).toEqual(["plots:comparison"]);
  l.model.doAction(Actions.maximizeToggle(comparison.getId()));
  l.collapse(comparison);
  expect(l.getSnapshot().activeViewIds).not.toContain("plots:comparison");
});

it("ignores a retired layout model's late UI action after restoring another project", () => {
  const { l } = fixture(), retired = l.model;
  l.restore({ layout: defaultLayout(1280) });
  const before = l.serialize();
  retired.doAction(Actions.deleteTab("plots"));
  expect(l.serialize()).toEqual(before);
  expect(l.isClosed("plots")).toBe(false);
});

it("names parent destinations after the remaining panels when Agent leaves its own column", () => {
  const l = new PanelLayout({ width: 1060 });
  l.show("agent");
  expect(l.move("agent", "plots-group", "Right")).toBe(true);
  const before = l.model.toJson();
  const targets = l.targets("agent");
  expect(targets.find(t => t.id === "inspection-region")?.name).toBe("Objects + Plots");
  expect(targets.filter(t => t.kind === "Parent region").map(t => t.name)).not.toContain("Plots");
  expect(targets.some(t => t.name.includes("Agent"))).toBe(false);
  const preview = l.preview("agent", "inspection-region", "Right");
  expect(preview).not.toBeNull();
  expect(l.model.toJson()).toEqual(before);
  expect(l.move("agent", "inspection-region", "Right")).toBe(true);
  const column = l.model.getNodeById("objects")!.getParent()!.getParent();
  expect(l.model.getNodeById("plots")!.getParent()!.getParent()).toBe(column);
  expect(l.model.getNodeById("agent")!.getParent()!.getParent()).toBe(column!.getParent());
  l.undo();
  expect(l.model.toJson()).toEqual(before);
});
