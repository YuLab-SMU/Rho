import { Actions, Model, Orientation, RowNode, TabNode, TabSetNode } from "flexlayout-react";
import type { Action, IJsonRowNode, IJsonTabSetNode, Node } from "flexlayout-react";
import type { PluginWindowNode } from "../../sdk/plugin-protocol/index.js";

const generatedNodeIds = new WeakMap<Model, Map<string, string>>();
function documentNodeId(model: Model, node: Node): string {
  const id = node.getId();
  if (!id.startsWith("#")) return id;
  // FlexLayout's generated row ids begin with '#', outside public NodeId syntax.
  // Map them once per model; no plugin view identity ever goes through this map.
  let ids = generatedNodeIds.get(model);
  if (!ids) { ids = new Map(); generatedNodeIds.set(model, ids); }
  let mapped = ids.get(id);
  if (!mapped) { mapped = `layout-${crypto.randomUUID()}`; ids.set(id, mapped); }
  return mapped;
}

/** The docking library is only a presentation adapter. Its component names,
 * generated wrappers and geometry never identify a scientific provider. */
export function pluginLayoutModel(layout: PluginWindowNode, names: ReadonlyMap<string, string> = new Map()): Model {
  const temporary = () => `layout-${crypto.randomUUID()}`;
  type Direction = "horizontal" | "vertical";
  const opposite = (direction: Direction): Direction => direction === "horizontal" ? "vertical" : "horizontal";
  const node = (value: PluginWindowNode, direction: Direction, weight = 100): IJsonRowNode | IJsonTabSetNode => {
    if (value.kind === "empty") return { type: "tabset", id: temporary(), weight, config: { empty: true }, children: [] };
    if (value.kind === "tabs") return {
      type: "tabset", id: value.id, weight,
      selected: value.selected === null ? -1 : value.views.indexOf(value.selected),
      children: value.views.map(id => ({ type: "tab", id, component: "plugin-view", name: names.get(id) ?? id })),
    };
    if (value.direction !== direction) return { type: "row", id: temporary(), weight, children: [node(value, opposite(direction))] };
    return { type: "row", id: value.id, weight,
      children: value.children.map((child, index) => node(child, opposite(direction), value.weights[index])) };
  };
  const direction = layout.kind === "split" ? layout.direction : "horizontal";
  const converted = node(layout, direction);
  const model = Model.fromJson({
    global: { rootOrientationVertical: direction === "vertical", tabEnablePopout: false, tabEnableRename: false,
      tabEnableClose: true, tabEnablePin: false, tabSetEnableDeleteWhenEmpty: false, tabSetEnableTabScrollbar: true,
      tabSetEnableTabWrap: false, tabSetMinWidth: 100, tabSetMinHeight: 58 },
    layout: converted.type === "row" ? converted as IJsonRowNode : { type: "row", id: temporary(), children: [converted] },
  });
  model.setSplitterSize(6);
  model.setOnCreateTabSet(() => ({ id: temporary() }));
  return model;
}

/** Same-axis splits can be flattened by docking. Preserve all view and tab-group
 * identities and proportional geometry; no empty group is a request to open a view. */
export function pluginLayoutDocument(model: Model): PluginWindowNode {
  const node = (value: Node): PluginWindowNode => {
    if (value instanceof TabSetNode) {
      const views = value.getChildren().map(child => {
        if (!(child instanceof TabNode) || child.getComponent() !== "plugin-view") throw new Error("Unexpected window content.");
        return child.getId();
      });
      if (!views.length && value.getConfig()?.empty) return { kind: "empty" };
      const selected = value.getSelectedNode();
      return { kind: "tabs", id: documentNodeId(model, value), selected: selected?.getId() ?? null, views };
    }
    if (!(value instanceof RowNode)) throw new Error("Unexpected window layout node.");
    const children = value.getChildren();
    if (!children.length) return { kind: "empty" };
    if (children.length === 1) return node(children[0]);
    return { kind: "split", id: documentNodeId(model, value), direction: value.getOrientation() === Orientation.HORZ ? "horizontal" : "vertical",
      weights: children.map(child => {
        if (!(child instanceof RowNode || child instanceof TabSetNode)) throw new Error("Unexpected split child.");
        return child.getWeight();
      }), children: children.map(node) };
  };
  const root = model.getRootRow();
  return root ? node(root) : { kind: "empty" };
}

export function pluginLayoutViews(layout: PluginWindowNode): string[] {
  return layout.kind === "tabs" ? [...layout.views] : layout.kind === "split" ? layout.children.flatMap(pluginLayoutViews) : [];
}

/** Async title observations are not layout edits. In particular an old dock may
 * receive a title while a newer native scene is being presented; persisting that
 * cosmetic notification would try to write its old composition over the scene. */
export function pluginLayoutActionChangesDocument(action: Action): boolean {
  return action.type !== Actions.UPDATE_NODE_ATTRIBUTES || Object.keys(action.data.json ?? {}).some(key => key !== 'name');
}

/** Names are presentation metadata; changing them never changes a view identity. */
export function namePluginLayoutViews(model: Model, names: ReadonlyMap<string, string>) {
  for (const [id, title] of names) {
    const node = model.getNodeById(id);
    if (node instanceof TabNode && node.getName() !== title)
      model.doAction(Actions.updateNodeAttributes(id, { name: title }));
  }
}
