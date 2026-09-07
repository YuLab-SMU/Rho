import { Component, useMemo, useSyncExternalStore } from "react";
import type { ErrorInfo, ReactNode } from "react";
import {
  Actions,
  DockLocation,
  Layout,
  Model,
  TabNode,
  TabSetNode,
} from "flexlayout-react";
import type { Action, IJsonModel } from "flexlayout-react";
import type { Studio } from "./studio";

export const panelNames: Record<string, string> = {
  editor: "编辑器",
  console: "R Console",
  objects: "Workspace 对象",
  plots: "图表",
  files: "项目文件",
};
export function defaultLayout(): IJsonModel {
  return {
    global: {
      tabMinHeight: 0,
      tabEnablePopout: false,
      tabSetMinHeight: 58,
      tabSetMinWidth: 200,
      tabSetEnableDeleteWhenEmpty: false,
      tabSetEnableTabScrollbar: true,
      tabSetEnableTabWrap: false,
    },
    layout: {
      type: "row",
      children: [
        {
          type: "row",
          weight: 62.5,
          children: [
            {
              type: "tabset",
              id: "editor-group",
              weight: 57,
              minWidth: 240,
              children: [
                {
                  type: "tab",
                  id: "editor",
                  name: "编辑器",
                  component: "editor",
                  minWidth: 240,
                },
              ],
            },
            {
              type: "tabset",
              id: "console-group",
              weight: 43,
              minWidth: 240,
              children: [
                {
                  type: "tab",
                  id: "console",
                  name: "R Console",
                  component: "console",
                  minWidth: 240,
                },
              ],
            },
          ],
        },
        {
          type: "row",
          weight: 37.5,
          children: [
            {
              type: "tabset",
              id: "objects-group",
              weight: 36,
              children: [
                {
                  type: "tab",
                  id: "objects",
                  name: "Workspace 对象",
                  component: "objects",
                },
              ],
            },
            {
              type: "tabset",
              id: "plots-group",
              weight: 64,
              children: [
                { type: "tab", id: "plots", name: "图表", component: "plots" },
              ],
            },
          ],
        },
      ],
    },
  };
}
export class PanelLayout {
  model: Model;
  constructor(private studio: Studio) {
    try {
      const saved = studio.layout as IJsonModel | null;
      if (saved && (!saved.layout || JSON.stringify(saved).length > 100000))
        throw new Error("invalid layout");
      this.model = Model.fromJson(saved ?? defaultLayout());
      this.model.visitNodes((n) => {
        if (
          n instanceof TabNode &&
          !panelNames[n.getComponent() ?? ""] &&
          n.getComponent() !== "document" &&
          n.getComponent() !== "viewer"
        )
          throw new Error("unknown panel");
      });
    } catch {
      this.model = Model.fromJson(defaultLayout());
      studio.error = "布局损坏，已恢复默认布局；草稿仍保留。";
    }
  }
  changed = () => {
    this.studio.layout = this.model.toJson();
    this.studio.persist();
    this.studio.emit();
  };
  show(
    component: string,
    id = component,
    name = panelNames[component],
    config?: unknown,
  ) {
    if (this.model.getNodeById(id)) this.model.doAction(Actions.selectTab(id));
    else {
      const preferred =
        component === "document"
          ? this.model.getNodeById("editor-group")
          : component === "viewer"
            ? this.model.getNodeById("objects-group")
            : null;
      const target =
        preferred ??
        this.model.getActiveTabset() ??
        this.model.getFirstTabSet();
      if (!target) return;
      this.model.doAction(
        Actions.addTab(
          {
            type: "tab",
            id,
            name,
            component,
            config,
            minWidth: ["editor", "document", "console"].includes(component)
              ? 240
              : 200,
          },
          target.getId(),
          DockLocation.CENTER,
          -1,
          true,
        ),
      );
    }
    const tab = this.model.getNodeById(id);
    if (tab?.getParent() instanceof TabSetNode) {
      const parent = tab.getParent() as TabSetNode;
      if (parent.getConfig()?.collapsed) this.collapse(parent);
    }
    this.changed();
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
    const config = node.getConfig() ?? {};
    if (node.isMaximized())
      this.model.doAction(Actions.maximizeToggle(node.getId()));
    if (config.collapsed) {
      this.model.doAction(
        Actions.updateNodeAttributes(node.getId(), {
          minHeight: 58,
          maxHeight: 99999,
          weight: config.previousWeight ?? 50,
          config: { ...config, collapsed: false, restoreCollapsed: false },
        }),
      );
    } else {
      this.model.doAction(
        Actions.updateNodeAttributes(node.getId(), {
          minHeight: 0,
          maxHeight: 0,
          config: {
            ...config,
            collapsed: true,
            restoreCollapsed: false,
            previousWeight: node.getWeight(),
          },
        }),
      );
    }
    this.changed();
  }
}

class PanelBoundary extends Component<
  { children: ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {}
  render() {
    return this.state.error ? (
      <div className="empty">
        <p>面板无法显示：{this.state.error}</p>
        <button onClick={() => this.setState({ error: "" })}>
          重新打开面板
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}

export function LayoutHost({
  studio,
  registry,
  onLayout,
}: {
  studio: Studio;
  registry: (node: TabNode) => ReactNode;
  onLayout: (layout: PanelLayout) => void;
}) {
  useSyncExternalStore(studio.subscribe, studio.snapshot);
  const layout = useMemo(
    () => new PanelLayout(studio),
    [studio, studio.project],
  );
  onLayout(layout);
  return (
    <div className="layout-host">
      <Layout
        model={layout.model}
        factory={(node) => <PanelBoundary>{registry(node)}</PanelBoundary>}
        realtimeResize
        onModelChange={layout.changed}
        onAction={layout.prepareAction}
        onRenderTab={(node, values) => {
          const document = studio.documents.items.get(node.getId());
          if (document)
            values.content = (
              <span>
                {document.name}
                {document.dirty && !document.draft.readonly ? " •" : ""}
              </span>
            );
        }}
        onRenderTabSet={(node, values) => {
          if (node instanceof TabSetNode)
            values.buttons.unshift(
              <button
                className="icon-button"
                key="collapse"
                aria-label={
                  node.getConfig()?.collapsed ? "展开面板组" : "收起面板组"
                }
                title={
                  node.getConfig()?.collapsed ? "展开面板组" : "收起面板组"
                }
                onClick={() => layout.collapse(node)}
              >
                {node.getConfig()?.collapsed ? "⌄" : "−"}
              </button>,
            );
        }}
      />
    </div>
  );
}
