import {
  Actions,
  DockLocation,
  Model as FlexModel,
  Orientation,
  RowNode,
  TabNode,
  TabSetNode,
} from "flexlayout-react";
import type { Action, IJsonModel, Node } from "flexlayout-react";
import { immutable, Model, readonlySet } from "./shared/model";
import { builtinPanels, isBuiltinPanel, panelNames } from "./builtin-panels";
import type { PanelInstance } from "./builtin-panels";
export { panelNames } from "./builtin-panels";
export const directions = {
  Left: DockLocation.LEFT,
  Right: DockLocation.RIGHT,
  Above: DockLocation.TOP,
  Below: DockLocation.BOTTOM,
  "Join as Tab": DockLocation.CENTER,
};
export type Direction = keyof typeof directions;
export interface Placement {
  group?: string;
  neighbors: string[];
}
export function defaultLayout(width = 1440): IJsonModel {
  const files = width < 1360 ? 200 : 220,
    right = width < 1360 ? 320 : 360;
  const group = (id: string, weight: number, minWidth = 200) => ({
    type: "tabset" as const,
    id: `${id}-group`,
    weight,
    minWidth,
    children: [
      {
        type: "tab" as const,
        id,
        name: panelNames[id],
        component: id,
        minWidth,
      },
    ],
  });
  return {
    global: {
      tabMinHeight: 0,
      tabEnablePopout: false,
      tabEnableRename: false,
      tabEnableClose: true,
      tabSetMinHeight: 58,
      tabSetMinWidth: 200,
      tabSetEnableDeleteWhenEmpty: true,
      tabSetEnableTabScrollbar: true,
      tabSetEnableTabWrap: false,
    },
    layout: {
      type: "row",
      id: "workspace",
      children: [
        group("files", files, 180),
        {
          type: "row",
          id: "editing-region",
          weight: Math.max(480, width - files - right - 28),
          children: [group("editor", 60, 240), group("console", 40, 240)],
        },
        {
          type: "row",
          id: "inspection-region",
          weight: right,
          children: [group("objects", 35), group("plots", 65)],
        },
      ],
    },
  };
}
export function regionName(node: Node, excluding?: string): string {
  if (node.getId() === excluding) return "";
  return node instanceof TabNode
    ? node.getName()
    : node.getChildren().map(child => regionName(child, excluding)).filter(Boolean).join(" + ");
}
export interface LayoutSnapshot {
  readonly knownViews: Readonly<Record<string, Omit<PanelInstance, "id">>>;
  readonly closedViews: ReadonlySet<string>;
  readonly closeVersion: number;
  readonly activeViewIds: readonly string[];
  readonly activeViews: readonly PanelInstance[];
  readonly activeTabId: string | null;
  readonly empty: boolean;
  readonly canUndo: boolean;
  readonly error: string;
}

export class PanelLayout extends Model<LayoutSnapshot> {
  private currentModel: FlexModel;
  private history: IJsonModel[] = [];
  private placements: Record<string, Placement> = {};
  private knownViews: Record<string, Omit<PanelInstance, "id">> = {};
  private closedViews = new Set<string>();
  private closeVersion = 0;
  private error = "";
  private stopped = false;
  private before?: IJsonModel;
  private resizeBefore?: IJsonModel;
  constructor(private options: { changed?: () => void; width?: number } = {}) {
    super();
    this.currentModel = FlexModel.fromJson(defaultLayout(options.width));
    this.currentModel.setSplitterSize(6);
    this.listen();
    this.rememberOpenViews();
  }
  /** FlexLayout is exposed only to its UI adapter; other modules use commands. */
  get model() { return this.currentModel; }
  protected readSnapshot(): LayoutSnapshot {
    const activeViews: PanelInstance[] = [];
    const maximized = this.model.getMaximizedTabset();
    this.model.visitNodes((node) => {
      if (!(node instanceof TabSetNode) || (maximized && maximized !== node) || node.getConfig()?.collapsed) return;
      const tab = node.getSelectedNode();
      if (tab instanceof TabNode && isBuiltinPanel(tab.getComponent() ?? ""))
        activeViews.push(this.instance(tab)!);
    });
    return {
      knownViews: immutable(structuredClone(this.knownViews)),
      closedViews: readonlySet(this.closedViews),
      closeVersion: this.closeVersion,
      activeViewIds: Object.freeze(activeViews.map((view) => view.id)),
      activeViews: Object.freeze(activeViews),
      activeTabId: this.activeTab?.getId() ?? null,
      empty: this.empty,
      canUndo: this.history.length > 0,
      error: this.error,
    };
  }
  instance(node: TabNode): PanelInstance | null {
    const component = node.getComponent() ?? "";
    return isBuiltinPanel(component) ? immutable({ id: node.getId(), component, name: node.getName(), config: structuredClone(node.getConfig()) }) : null;
  }
  has(id: string) { return this.model.getNodeById(id) instanceof TabNode; }
  isClosed(id: string) { return this.closedViews.has(id); }
  dismissError() { this.error = ""; this.publish(); }
  restore(data: unknown) {
    const value = data as { layout?: IJsonModel; layoutHistory?: IJsonModel[]; viewPlacements?: Record<string, Placement>; knownViews?: Record<string, Omit<PanelInstance, "id">> } | null;
    this.error = "";
    this.stopped = false;
    this.before = this.resizeBefore = undefined;
    this.placements = {};
    for (const [id, place] of Object.entries(value?.viewPlacements ?? {}))
      if (place && Array.isArray(place.neighbors))
        this.placements[id] = { group: typeof place.group === "string" ? place.group : undefined, neighbors: place.neighbors.filter((neighbor) => typeof neighbor === "string") };
    this.knownViews = {};
    for (const [id, view] of Object.entries(value?.knownViews ?? {}))
      if (view && typeof view.name === "string" && isBuiltinPanel(view.component))
        this.knownViews[id] = Object.freeze({ component: view.component, name: view.name, config: view.config });
    try {
      const saved = value?.layout;
      if (saved && (!saved.layout || JSON.stringify(saved).length > 100000))
        throw new Error("invalid layout");
      this.currentModel = FlexModel.fromJson(saved ?? defaultLayout(this.options.width));
      this.model.doAction(
        Actions.updateModelAttributes({
          tabMinHeight: 0,
          tabEnableClose: true,
          tabEnablePopout: false,
          tabSetEnableDeleteWhenEmpty: true,
        }),
      );
      this.model.visitNodes((n) => {
        if (!(n instanceof TabNode)) return;
        if (
          !isBuiltinPanel(n.getComponent() ?? "")
        ) {
          this.model.doAction(Actions.deleteTab(n.getId()));
          this.error =
            "An unavailable view was closed. Other views and drafts were retained.";
          return;
        }
        this.model.doAction(
          Actions.updateNodeAttributes(n.getId(), {
            enableClose: true,
            ...(n.getId() === n.getComponent()
              ? { name: panelNames[n.getComponent()!] }
              : {}),
          }),
        );
      });
      // Current saved layouts may contain the old height-only collapse state.
      // Reapply the same user's intent on the actual sibling axis.
      this.model.visitNodes((node) => {
        if (!(node instanceof TabSetNode) || !node.getConfig()?.collapsed || node.getConfig()?.collapseRestore) return;
        const config = node.getConfig();
        this.model.doAction(Actions.updateNodeAttributes(node.getId(), {
          minHeight: 58, maxHeight: 99999, weight: config.previousWeight ?? node.getWeight(),
          config: { ...config, collapsed: false },
        }));
        this.model.doAction(Actions.group(this.collapseActions(node, true)));
      });
    } catch {
      this.currentModel = FlexModel.fromJson(defaultLayout(this.options.width));
      this.error =
        "Layout could not be restored. Default layout loaded; drafts are retained.";
    }
    this.history = (value?.layoutHistory ?? []).filter((item) => item && typeof item === "object" && item.layout && JSON.stringify(item).length <= 100000).slice(-20);
    this.closedViews = new Set(Object.keys(this.knownViews).filter((id) => !this.has(id)));
    this.closeVersion++;
    this.model.setSplitterSize(6);
    this.listen();
    this.rememberOpenViews();
    this.publish();
  }
  serialize() {
    return { layout: this.model.toJson(), layoutHistory: this.history.map((item) => structuredClone(item)), viewPlacements: structuredClone(this.placements), knownViews: structuredClone(this.knownViews) };
  }
  resetState() {
    this.restore(null);
  }
  private listen() {
    const watched = this.model;
    this.model.addChangeListener({
      onBeforeAction: (action) => {
        if (watched !== this.model || this.stopped) return;
        this.before = this.model.toJson();
        if (action.type === Actions.DELETE_TAB) this.remember(action.data.node);
        if (action.type === Actions.DELETE_TABSET)
          this.model
            .getNodeById(action.data.node)
            ?.getChildren()
            .forEach((n) => this.remember(n.getId()));
      },
      onAfterAction: (action) => {
        if (watched !== this.model || this.stopped) return;
        const geometry = ![
          Actions.SELECT_TAB,
          Actions.SET_ACTIVE_TABSET,
        ].includes(action.type);
        if (geometry && action.isAdjusting()) this.resizeBefore ??= this.before;
        else if (geometry && this.before) {
          this.pushHistory(this.resizeBefore ?? this.before);
          this.resizeBefore = undefined;
        }
        this.changed();
      },
    });
  }
  private pushHistory(value: IJsonModel) {
    if (JSON.stringify(value) !== JSON.stringify(this.model.toJson()))
      this.history = [...this.history.slice(-19), value];
  }
  private remember(id: string) {
    const node = this.model.getNodeById(id),
      parent = node?.getParent();
    if (node instanceof TabNode) {
      this.placements[id] = {
        group: parent?.getId(),
        neighbors:
          parent
            ?.getChildren()
            .filter((n) => n !== node)
            .map((n) => n.getId()) ?? [],
      };
      this.closedViews.add(id);
      this.closeVersion++;
    }
  }
  private rememberOpenViews() {
    this.model.visitNodes((n) => {
      if (n instanceof TabNode)
        if (isBuiltinPanel(n.getComponent() ?? "")) {
          this.knownViews[n.getId()] = Object.freeze({
            component: n.getComponent()! as PanelInstance["component"],
            name: n.getName(),
            config: n.getConfig(),
          });
          this.closedViews.delete(n.getId());
        }
    });
    for (const id of Object.keys(this.knownViews))
      if (!this.has(id) && !this.closedViews.has(id)) { this.closedViews.add(id); this.closeVersion++; }
  }
  private changed = () => {
    this.rememberOpenViews();
    this.publish();
    this.options.changed?.();
  };
  get empty() {
    let count = 0;
    this.model.visitNodes((n) => {
      if (n instanceof TabNode) count++;
    });
    return count === 0;
  }
  private get activeTab() {
    const group = this.model.getActiveTabset();
    return group?.getConfig()?.collapsed ? undefined : group?.getSelectedNode();
  }
  undo() {
    const json = this.history.pop();
    if (json) {
      this.currentModel = FlexModel.fromJson(json, this.model);
      this.listen();
      this.changed();
    }
  }
  reset() {
    const before = this.model.toJson();
    this.currentModel = FlexModel.fromJson(defaultLayout(this.options.width), this.model);
    this.pushHistory(before);
    this.listen();
    this.changed();
  }
  close(id: string) {
    this.model.doAction(Actions.deleteTab(id));
  }
  closeActive() {
    const id = this.activeTab?.getId();
    if (id) this.close(id);
  }
  closeGroup(id: string) { this.model.doAction(Actions.deleteTabset(id)); }
  maximizeGroup(id: string) { this.model.doAction(this.prepareAction(Actions.maximizeToggle(id))); }
  maximizeActive() {
    const id = this.model.getActiveTabset()?.getId();
    if (id) this.maximizeGroup(id);
  }
  rename(id: string, name: string) {
    const saved = this.knownViews[id];
    if (saved) this.knownViews[id] = Object.freeze({ ...saved, name });
    if (this.has(id)) this.model.doAction(Actions.renameTab(id, name));
    else this.changed();
  }
  isCollapsed(id: string) { const group = this.model.getNodeById(id)?.getParent(); return group instanceof TabSetNode && !!group.getConfig()?.collapsed; }
  restoreView(component: string, id: string, name?: string, config?: unknown) {
    if (!this.has(id)) { this.show(component, id, name, config); return; }
    if (!isBuiltinPanel(component)) return;
    const title = name ?? builtinPanels[component].name;
    this.knownViews[id] = Object.freeze({ component, name: title, config });
    this.model.doAction(Actions.updateNodeAttributes(id, { name: title, config }));
  }
  show(
    component: string,
    id = component,
    name = panelNames[component],
    config?: unknown,
  ) {
    if (!isBuiltinPanel(component)) return;
    const definition = builtinPanels[component];
    if (definition.instances === "single") id = component;
    name ??= definition.name;
    this.closedViews.delete(id);
    this.knownViews[id] = Object.freeze({ component, name, config });
    if (this.model.getNodeById(id)) this.model.doAction(Actions.selectTab(id));
    else {
      const place = this.placements[id];
      const remembered = place?.group
        ? this.model.getNodeById(place.group)
        : undefined;
      const neighbor = place?.neighbors
        .map((key) => this.model.getNodeById(key)?.getParent())
        .find((n) => n instanceof TabSetNode);
      const preferred = this.model.getNodeById(
        definition.preferredGroup,
      );
      const width = this.model.getRootRow()?.getRect().width || this.options.width || 1440;
      const agentDock = component === "agent" && !remembered && !neighbor && width >= 1100;
      const comparison =
        (component === "plots" && id !== "plots" && !remembered && !neighbor) || agentDock;
      const target =
        (comparison ? this.model.getRootRow() : undefined) ??
        remembered ??
        neighbor ??
        preferred ??
        this.model.getActiveTabset() ??
        this.model.getFirstTabSet() ??
        this.model.getRootRow();
      if (!target) return;
      const add = Actions.addTab(
        {
          type: "tab",
          id,
          name,
          component,
          config,
          minWidth: definition.minWidth,
          ...(component === "agent" ? { minHeight: 360 } : {}),
        },
        target.getId(),
        comparison ? DockLocation.RIGHT : DockLocation.CENTER,
        -1,
        true,
      );
      this.model.doAction(
        component === "document" && this.model.getNodeById("editor")
          ? Actions.group([add, Actions.deleteTab("editor")])
          : add,
      );
      if (agentDock) {
        const group = this.model.getNodeById(id)?.getParent();
        if (group instanceof TabSetNode) {
          const siblings = this.model.getRootRow()?.getChildren().filter(node => node !== group) ?? [];
          const total = siblings.reduce((sum, node) => sum + (node instanceof RowNode || node instanceof TabSetNode ? node.getWeight() : 0), 0);
          const fraction = Math.min(0.4, 440 / width);
          this.model.doAction(Actions.updateNodeAttributes(group.getId(), { weight: total * fraction / (1 - fraction) }));
        }
      }
    }
    const parent = this.model.getNodeById(id)?.getParent();
    if (parent instanceof TabSetNode && parent.getConfig()?.collapsed)
      this.collapse(parent);
  }
  prepareAction = (action: Action) => {
    if (action.type === Actions.MAXIMIZE_TOGGLE) {
      const node = this.model.getNodeById(action.data.node);
      if (node instanceof TabSetNode) {
        const config = node.getConfig() ?? {};
        if (config.collapsed && !node.isMaximized())
          return Actions.group([
            ...this.collapseActions(node, false, true),
            action,
          ]);
        if (config.restoreCollapsed && node.isMaximized())
          return Actions.group([
            ...this.collapseActions(node, true),
            action,
          ]);
      }
    }
    return action;
  };
  private collapseActions(node: TabSetNode, collapsed: boolean, restoreCollapsed = false): Action[] {
    const config = node.getConfig() ?? {};
    const side = node.getParent()?.getOrientation() === Orientation.HORZ;
    const saved = config.collapseRestore ?? {
      minWidth: node.getAttrMinWidth(), maxWidth: node.getAttrMaxWidth(),
      minHeight: node.getAttrMinHeight(), maxHeight: node.getAttrMaxHeight(),
      enableTabStrip: node.isEnableTabStrip(), weight: node.getWeight(),
      tabs: Object.fromEntries(node.getChildren().map(tab => [tab.getId(), {
        minWidth: (tab as TabNode).getMinWidth(), minHeight: (tab as TabNode).getMinHeight(),
      }])),
    };
    const actions = node.getChildren().map(tab => Actions.updateNodeAttributes(tab.getId(),
      collapsed ? { ...(side ? { minWidth: 0 } : { minHeight: 0 }) } : saved.tabs[tab.getId()] ?? {}));
    actions.push(Actions.updateNodeAttributes(node.getId(), collapsed ? {
      ...(side ? { minWidth: 38, maxWidth: 38, enableTabStrip: false } : { minHeight: 0, maxHeight: 0 }),
      config: { ...config, collapsed: true, collapseAxis: side ? "width" : "height", collapseRestore: saved, restoreCollapsed: false },
    } : {
      minWidth: saved.minWidth, maxWidth: saved.maxWidth, minHeight: saved.minHeight, maxHeight: saved.maxHeight,
      enableTabStrip: saved.enableTabStrip, weight: saved.weight,
      config: { ...config, collapsed: false, collapseRestore: restoreCollapsed ? saved : undefined, restoreCollapsed },
    }));
    return actions;
  }
  collapse(node: TabSetNode) {
    const config = node.getConfig() ?? {},
      collapsed = !config.collapsed;
    const actions = node.isMaximized()
      ? [Actions.maximizeToggle(node.getId())]
      : [];
    actions.push(...this.collapseActions(node, collapsed));
    this.model.doAction(Actions.group(actions));
  }
  targets(from: string) {
    const targets: {
      id: string;
      name: string;
      kind: "Group" | "Parent region" | "Workspace";
    }[] = [];
    const remainingGroups = (node: Node): number => node.getId() === from ? 0 : node instanceof TabSetNode
      ? Number(!!regionName(node, from)) : node.getChildren().reduce((n, child) => n + remainingGroups(child), 0);
    this.model.visitNodes((n) => {
      if (n instanceof TabSetNode)
        targets.push({ id: n.getId(), name: regionName(n, from), kind: "Group" });
      if (n instanceof RowNode && remainingGroups(n) > 1)
        targets.push({
          id: n.getId(),
          name:
            n === this.model.getRootRow() ? "Entire workspace" : regionName(n, from),
          kind: n === this.model.getRootRow() ? "Workspace" : "Parent region",
        });
    });
    return targets.filter((t) => t.id !== from && t.name);
  }
  /** Parent edges at the junction between children have their own drop area.
   * Panel-edge drops elsewhere remain with FlexLayout's ordinary tab targets. */
  parentDropZones(from: string) {
    const zones: { target: string; name: string; direction: Direction; x: number; y: number; width: number; height: number }[] = [];
    for (const target of this.targets(from).filter(t => t.kind === "Parent region")) {
      const node = this.model.getNodeById(target.id)!;
      const rect = node.getRect(), children = node.getChildren();
      if (!rect.width || !rect.height) continue;
      for (let i = 1; i < children.length; i++) {
        const before = children[i - 1].getRect(), after = children[i].getRect();
        const stacked = Math.abs(after.y - before.y) > Math.abs(after.x - before.x);
        const seam = stacked ? (before.y + before.height + after.y) / 2 : (before.x + before.width + after.x) / 2;
        for (const direction of (stacked ? ["Left", "Right"] : ["Above", "Below"]) as Direction[]) {
          if (!this.preview(from, target.id, direction)) continue;
          zones.push({ target: target.id, name: target.name, direction,
            x: stacked ? (direction === "Left" ? rect.x : rect.x + rect.width - 28) : seam - 24,
            y: stacked ? seam - 24 : (direction === "Above" ? rect.y : rect.y + rect.height - 28),
            width: stacked ? 28 : 48, height: stacked ? 48 : 28 });
        }
      }
    }
    return zones;
  }
  preview(from: string, to: string, direction: Direction): FlexModel | null {
    const source = this.model.getNodeById(from),
      target = this.model.getNodeById(to);
    if (
      !source ||
      !target ||
      source === target ||
      (direction === "Join as Tab" && !(target instanceof TabSetNode))
    )
      return null;
    if (source.getParent() === target && target.getChildren().length === 1)
      return null;
    // Moving the source frees its old space. Let FlexLayout redistribute the
    // complete layout instead of rejecting a split from the target's old size.
    try {
      const preview = FlexModel.fromJson(this.model.toJson());
      preview.doAction(
        Actions.moveNode(from, to, directions[direction], -1, true),
      );
      return preview.getNodeById(from) ? preview : null;
    } catch {
      return null;
    }
  }
  move(from: string, to: string, direction: Direction) {
    if (!this.preview(from, to, direction)) return false;
    this.model.doAction(
      Actions.moveNode(from, to, directions[direction], -1, true),
    );
    return true;
  }
  stop() { this.stopped = true; this.dispose(); }
}
