import {
  Actions,
  DockLocation,
  Model,
  RowNode,
  TabNode,
  TabSetNode,
} from "flexlayout-react";
import type { Action, IJsonModel, Node } from "flexlayout-react";
import type { Studio } from "./studio";
export const panelNames: Record<string, string> = {
  files: "Files",
  editor: "Editor",
  console: "Console",
  objects: "Objects",
  packages: "Packages",
  plots: "Plots",
};
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
export function defaultLayout(
  width = typeof window === "undefined" ? 1440 : window.innerWidth,
): IJsonModel {
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
export function regionName(node: Node): string {
  return node instanceof TabNode
    ? node.getName()
    : node.getChildren().map(regionName).filter(Boolean).join(" + ");
}
export class PanelLayout {
  model: Model;
  history: IJsonModel[] = [];
  private before?: IJsonModel;
  private resizeBefore?: IJsonModel;
  constructor(private studio: Studio) {
    try {
      const saved = studio.layout as IJsonModel | null;
      if (saved && (!saved.layout || JSON.stringify(saved).length > 100000))
        throw new Error("invalid layout");
      this.model = Model.fromJson(saved ?? defaultLayout());
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
          !panelNames[n.getComponent() ?? ""] &&
          !["document", "viewer"].includes(n.getComponent() ?? "")
        ) {
          this.model.doAction(Actions.deleteTab(n.getId()));
          studio.error =
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
    } catch {
      this.model = Model.fromJson(defaultLayout());
      studio.error =
        "Layout could not be restored. Default layout loaded; drafts are retained.";
    }
    this.history = studio.layoutHistory;
    this.model.setSplitterSize(6);
    this.listen();
  }
  private listen() {
    this.model.addChangeListener({
      onBeforeAction: (action) => {
        this.before = this.model.toJson();
        if (action.type === Actions.DELETE_TAB) this.remember(action.data.node);
        if (action.type === Actions.DELETE_TABSET)
          this.model
            .getNodeById(action.data.node)
            ?.getChildren()
            .forEach((n) => this.remember(n.getId()));
      },
      onAfterAction: (action) => {
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
      this.studio.viewPlacements[id] = {
        group: parent?.getId(),
        neighbors:
          parent
            ?.getChildren()
            .filter((n) => n !== node)
            .map((n) => n.getId()) ?? [],
      };
      this.studio.closedViews.add(id);
      this.studio.viewCloseVersion++;
    }
  }
  changed = () => {
    this.studio.layoutHistory = this.history;
    this.model.visitNodes((n) => {
      if (n instanceof TabNode)
        this.studio.knownViews[n.getId()] = {
          component: n.getComponent()!,
          name: n.getName(),
          config: n.getConfig(),
        };
    });
    this.studio.layout = this.model.toJson();
    this.studio.persist();
    this.studio.emit("layout", "shell");
  };
  get empty() {
    let count = 0;
    this.model.visitNodes((n) => {
      if (n instanceof TabNode) count++;
    });
    return count === 0;
  }
  get activeTab() {
    return this.model.getActiveTabset()?.getSelectedNode();
  }
  undo() {
    const json = this.history.pop();
    if (json) {
      this.model = Model.fromJson(json, this.model);
      this.listen();
      this.changed();
    }
  }
  reset() {
    const before = this.model.toJson();
    this.model = Model.fromJson(defaultLayout(), this.model);
    this.pushHistory(before);
    this.listen();
    this.changed();
  }
  close(id: string) {
    this.model.doAction(Actions.deleteTab(id));
  }
  show(
    component: string,
    id = component,
    name = panelNames[component],
    config?: unknown,
  ) {
    this.studio.closedViews.delete(id);
    this.studio.knownViews[id] = { component, name, config };
    if (this.model.getNodeById(id)) this.model.doAction(Actions.selectTab(id));
    else {
      const place = this.studio.viewPlacements[id];
      const remembered = place?.group
        ? this.model.getNodeById(place.group)
        : undefined;
      const neighbor = place?.neighbors
        .map((key) => this.model.getNodeById(key)?.getParent())
        .find((n) => n instanceof TabSetNode);
      const preferred = this.model.getNodeById(
        component === "document"
          ? "editor-group"
          : component === "viewer" || component === "packages"
            ? "objects-group"
            : `${component}-group`,
      );
      const comparison =
        component === "plots" && id !== "plots" && !remembered && !neighbor;
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
          minWidth: ["editor", "document", "console"].includes(component)
            ? 240
            : component === "files"
              ? 180
              : 200,
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
            Actions.updateNodeAttributes(node.getId(), {
              minHeight: 58,
              maxHeight: 99999,
              config: { ...config, collapsed: false, restoreCollapsed: true },
            }),
            action,
          ]);
        if (config.restoreCollapsed && node.isMaximized())
          return Actions.group([
            Actions.updateNodeAttributes(node.getId(), {
              minHeight: 0,
              maxHeight: 0,
              config: { ...config, collapsed: true, restoreCollapsed: false },
            }),
            action,
          ]);
      }
    }
    return action;
  };
  collapse(node: TabSetNode) {
    const config = node.getConfig() ?? {},
      collapsed = !config.collapsed;
    const actions = node.isMaximized()
      ? [Actions.maximizeToggle(node.getId())]
      : [];
    actions.push(
      Actions.updateNodeAttributes(
        node.getId(),
        collapsed
          ? {
              minHeight: 0,
              maxHeight: 0,
              config: {
                ...config,
                collapsed,
                previousWeight: node.getWeight(),
              },
            }
          : {
              minHeight: 58,
              maxHeight: 99999,
              weight: config.previousWeight ?? 50,
              config: { ...config, collapsed },
            },
      ),
    );
    this.model.doAction(Actions.group(actions));
  }
  targets(from: string) {
    const targets: {
      id: string;
      name: string;
      kind: "Group" | "Parent region" | "Workspace";
    }[] = [];
    this.model.visitNodes((n) => {
      if (n instanceof TabSetNode)
        targets.push({ id: n.getId(), name: regionName(n), kind: "Group" });
      if (n instanceof RowNode)
        targets.push({
          id: n.getId(),
          name:
            n === this.model.getRootRow() ? "Entire workspace" : regionName(n),
          kind: n === this.model.getRootRow() ? "Workspace" : "Parent region",
        });
    });
    return targets.filter((t) => t.id !== from && t.name);
  }
  preview(from: string, to: string, direction: Direction): Model | null {
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
    const rect = target.getRect(),
      vertical = direction === "Above" || direction === "Below";
    if (
      rect.width > 0 &&
      direction !== "Join as Tab" &&
      (vertical ? rect.height < 198 : rect.width < 406)
    )
      return null;
    try {
      const preview = Model.fromJson(this.model.toJson());
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
}
