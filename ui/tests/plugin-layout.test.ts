import { expect, it } from "vitest";
import { Actions, DockLocation, Orientation, RowNode, TabSetNode } from "flexlayout-react";
import type { PluginWindowNode } from "../../sdk/plugin-protocol/index.js";
import { pluginLayoutDocument, pluginLayoutModel, pluginLayoutViews, pluginLayoutActionChangesDocument } from "../src/plugin-layout";

const tabs = (id: string, ...views: string[]): PluginWindowNode => ({ kind: "tabs", id, selected: views[0] ?? null, views });
it("late title observations cannot save an old composition over a selected scenario", () => {
  expect(pluginLayoutActionChangesDocument(Actions.updateNodeAttributes('retained', { name: 'Observed title' }))).toBe(false);
  expect(pluginLayoutActionChangesDocument(Actions.selectTab('retained'))).toBe(true);
  expect(pluginLayoutActionChangesDocument(Actions.moveNode('retained', 'destination', DockLocation.CENTER, -1, true))).toBe(true);
  expect(pluginLayoutActionChangesDocument(Actions.updateNodeAttributes('group', { weight: 40 }))).toBe(true);
});
it("round trips exact view identities, Unicode labels and empty groups without default panels", () => {
  const source: PluginWindowNode = { kind: "split", id: "root", direction: "vertical", weights: [3, 2],
    children: [tabs("top", "old-revision", "user-revision"), tabs("bottom")] };
  const model = pluginLayoutModel(source, new Map([["old-revision", "中文 α"]]));
  expect(pluginLayoutDocument(model)).toEqual(source);
  expect(model.getNodeById("old-revision")?.toJson()).toMatchObject({ name: "中文 α", component: "plugin-view" });
  expect(pluginLayoutViews(pluginLayoutDocument(model))).toEqual(["old-revision", "user-revision"]);
  expect(pluginLayoutDocument(pluginLayoutModel({ kind: "empty" }))).toEqual({ kind: "empty" });
  const unselected: PluginWindowNode = { kind: "tabs", id: "unselected", views: ["retained"], selected: null };
  expect(pluginLayoutDocument(pluginLayoutModel(unselected))).toEqual(unselected);
});
it("preserves repeated split directions and relative weights through docking normalization", () => {
  const source: PluginWindowNode = { kind: "split", id: "root", direction: "horizontal", weights: [40, 60], children: [
    tabs("left", "one"), { kind: "split", id: "right", direction: "horizontal", weights: [1, 2], children: [tabs("middle", "two"), tabs("end", "three")] },
  ] };
  const model = pluginLayoutModel(source);
  // Even when FlexLayout flattens redundant split wrappers, it must not turn the
  // second horizontal region into a vertical stack or change the view identities.
  for (const id of ["left", "middle", "end"]) {
    const group = model.getNodeById(id) as TabSetNode;
    expect(group.getParent()?.getOrientation()).toBe(Orientation.HORZ);
  }
  const proportions = (node: RowNode | TabSetNode, share = 1): Record<string, number> => {
    if (node instanceof TabSetNode) return { [node.getId()]: share };
    const children = node.getChildren() as (RowNode | TabSetNode)[], total = children.reduce((sum, child) => sum + child.getWeight(), 0);
    return Object.assign({}, ...children.map(child => proportions(child, share * child.getWeight() / total)));
  };
  const weights = proportions(model.getRootRow()!);
  expect(weights.left).toBeCloseTo(.4); expect(weights.middle).toBeCloseTo(.2); expect(weights.end).toBeCloseTo(.4);
  model.doAction(Actions.moveNode("two", "left", DockLocation.CENTER, -1, true));
  const saved = pluginLayoutDocument(model);
  expect(pluginLayoutViews(saved).sort()).toEqual(["one", "three", "two"]);
  expect(pluginLayoutDocument(pluginLayoutModel(saved))).toEqual(saved);
});
it("selecting and moving a view only changes presentation and preserves other empty destinations", () => {
  const model = pluginLayoutModel({ kind: "split", id: "root", direction: "horizontal", weights: [1, 1],
    children: [tabs("main", "first", "second"), tabs("destination")] });
  model.doAction(Actions.selectTab("second"));
  expect(pluginLayoutDocument(model)).toMatchObject({ children: [{ selected: "second" }, { views: [] }] });
  model.doAction(Actions.moveNode("second", "destination", DockLocation.CENTER, -1, true));
  expect(pluginLayoutDocument(model)).toMatchObject({ children: [{ views: ["first"] }, { views: ["second"], selected: "second" }] });
  expect(pluginLayoutViews(pluginLayoutDocument(model))).toEqual(["first", "second"]);
});
it("newly docked groups and generated split rows have stable public identities", () => {
  const model = pluginLayoutModel({ kind: "split", id: "root", direction: "horizontal", weights: [1, 1],
    children: [tabs("main", "first", "second"), tabs("side", "third")] });
  model.doAction(Actions.moveNode("second", "side", DockLocation.BOTTOM, -1, true));
  const saved = pluginLayoutDocument(model);
  expect(pluginLayoutDocument(model)).toEqual(saved);
  const visit = (node: PluginWindowNode) => {
    if (node.kind === "empty") return;
    expect(node.id).toMatch(/^[A-Za-z0-9._:/-]{1,160}$/);
    if (node.kind === "split") node.children.forEach(visit);
  };
  visit(saved);
  expect(pluginLayoutDocument(pluginLayoutModel(saved))).toEqual(saved);
  expect(pluginLayoutViews(saved).sort()).toEqual(["first", "second", "third"]);
});
