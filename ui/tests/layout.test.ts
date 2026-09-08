import { expect, it } from "vitest";
import { Actions, TabSetNode } from "flexlayout-react";
import { PanelLayout, defaultLayout } from "../src/layout-model";
import { Studio } from "../src/studio";
import { HostClient } from "../src/host-client";
function fixture() {
  const s = new Studio(new HostClient("test"));
  s.persist = () => {};
  return { s, l: new PanelLayout(s) };
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
it("preserves document identity and bounds layout history", () => {
  const { s, l } = fixture();
  s.showPanel = l.show.bind(l);
  const d = s.documents.create();
  expect(l.model.getNodeById("editor")).toBeUndefined();
  l.close(d.id);
  expect(s.documents.items.get(d.id)).toBe(d);
  l.show("document", d.id, d.name);
  const group = l.model.getNodeById(d.id)!.getParent() as TabSetNode;
  for (let i = 0; i < 24; i++) l.collapse(group);
  expect(l.history).toHaveLength(20);
});
it("coalesces resizing into one history step", () => {
  const { l } = fixture();
  l.model.doAction(
    Actions.adjustWeights("editing-region", [55, 45]).setAdjusting(true),
  );
  l.model.doAction(
    Actions.adjustWeights("editing-region", [50, 50]).setAdjusting(true),
  );
  expect(l.history).toHaveLength(0);
  l.model.doAction(Actions.adjustWeights("editing-region", [50, 50]));
  expect(l.history).toHaveLength(1);
});
it("uses new defaults only for new workspaces", () => {
  const { s } = fixture();
  const saved = defaultLayout(1280);
  saved.layout.children.pop();
  s.layout = saved;
  const l = new PanelLayout(s);
  expect(l.model.getNodeById("plots")).toBeUndefined();
});
