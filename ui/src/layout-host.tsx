import {
  Component,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { Layout, Model, TabNode, TabSetNode } from "flexlayout-react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Modal } from "./primitives";
import { directions, PanelLayout, regionName } from "./layout-model";
import type { Direction } from "./layout-model";
import { Icon } from "./icons";
import { renderBuiltinPanel } from "./builtin-panel-renderers";
export { PanelLayout, panelNames, defaultLayout } from "./layout-model";
class PanelBoundary extends Component<
  { children: ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="empty">
        <p>View unavailable: {this.state.error}</p>
        <button onClick={() => this.setState({ error: "" })}>Retry View</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function DockPreview({ model, source }: { model: Model; source: string }) {
  const [rect, setRect] = useState({ x: 0, y: 0, width: 0, height: 0 });
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const r = model.getNodeById(source)?.getParent()?.getRect();
      if (r) setRect({ x: r.x, y: r.y, width: r.width, height: r.height });
    });
    return () => cancelAnimationFrame(frame);
  }, [model, source]);
  return (
    <div className="dock-preview">
      <div className="dock-calculation" aria-hidden="true">
        <Layout model={model} factory={() => null} />
      </div>
      <div
        className="dock-destination"
        style={{
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
        }}
      />
    </div>
  );
}
function LayoutContent({ layout, node }: { layout: PanelLayout; node: TabNode }) {
  useSyncExternalStore(layout.subscribe, layout.getSnapshot);
  const group = node.getParent(), view = layout.instance(node);
  if (group instanceof TabSetNode && group.getConfig()?.collapsed) {
    return group.getConfig()?.collapseAxis === "width" ? (
      <button className="collapsed-side-rail" aria-label={`Restore Group: ${regionName(group)}`}
        title={`Restore ${regionName(group)}`} onClick={() => layout.collapse(group)}>
        <span aria-hidden="true">›</span><span>{regionName(group)}</span>
      </button>
    ) : null;
  }
  return view ? renderBuiltinPanel(view) : <div className="empty">View unavailable</div>;
}
export function LayoutHost({
  layout,
  documentTabs,
  navigation,
}: {
  layout: PanelLayout;
  documentTabs: ReadonlyMap<string, { readonly name: string; readonly dirty: boolean; readonly readonly: boolean }>;
  navigation: { openFile(): void; createDocument(): void; openPanels(): void };
}) {
  useSyncExternalStore(layout.subscribe, layout.getSnapshot);
  const [moving, setMoving] = useState<string | null>(null),
    [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState(""),
    [direction, setDirection] = useState<Direction>("Left");
  const clear = () => {
    setDragging(null);
    setTarget("");
  };
  useEffect(() => {
    const cancel = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear();
    };
    window.addEventListener("keydown", cancel);
    window.addEventListener("blur", clear);
    window.addEventListener("dragend", clear);
    return () => {
      window.removeEventListener("keydown", cancel);
      window.removeEventListener("blur", clear);
      window.removeEventListener("dragend", clear);
    };
  }, []);
  const source = moving ?? dragging;
  const preview = useMemo(
    () => (source && target ? layout.preview(source, target, direction) : null),
    [source, target, direction, layout, layout.model],
  );
  const zones = dragging ? layout.parentDropZones(dragging) : [];
  const region = target ? layout.model.getNodeById(target)?.getRect() : null;
  return (
    <div
      className={`layout-host${dragging && target ? " parent-drop-active" : ""}`}
      onDragStartCapture={(e) => {
        const el = (e.target as HTMLElement).closest('[role="tab"]');
        const id =
          el?.querySelector<HTMLElement>("[data-rho-view]")?.dataset.rhoView;
        if (id) {
          setDragging(id);
          setTarget("");
        }
      }}
      onDragEnd={clear}
      onDragOverCapture={(e) => {
        if (!(e.target as HTMLElement).closest(".parent-dock-zone")) {
          setTarget("");
        }
      }}
    >
      {layout.empty ? (
        <div className="empty workspace-empty">
          <h2>Make room for your work</h2>
          <button onClick={() => navigation.openFile()}>Open File…</button>
          <button className="primary" onClick={() => navigation.createDocument()}>
            New R File
          </button>
          <button onClick={() => navigation.openPanels()}>Show Panels</button>
        </div>
      ) : (
        <Layout
          model={layout.model}
          factory={(node) => {
            return <PanelBoundary><LayoutContent layout={layout} node={node} /></PanelBoundary>;
          }}
          realtimeResize
          tabDragSpeed={0}
          keyMap={{ closeTab: undefined }}
          invalidateTabContentOnParentRender={false}
          onAction={layout.prepareAction}
          onRenderTab={(node, values) => {
            const document = documentTabs.get(node.getId());
            values.content = (
              <span data-rho-view={node.getId()}>
                {document?.name ?? node.getName()}
                {document?.dirty && !document.readonly ? " •" : ""}
              </span>
            );
          }}
          onRenderTabSet={(node, values) => {
            if (!(node instanceof TabSetNode)) return;
            values.buttons.unshift(
              <button
                key="collapse"
                className="icon-button"
                aria-label={
                  node.getConfig()?.collapsed
                    ? "Restore Group"
                    : "Collapse Group"
                }
                title={
                  node.getConfig()?.collapsed
                    ? "Restore Group"
                    : "Collapse Group"
                }
                onClick={() => layout.collapse(node)}
              >
                {node.getConfig()?.collapsed ? "⌄" : "−"}
              </button>,
              <Menu.Root key="group-menu">
                <Menu.Trigger
                  className="icon-button"
                  aria-label={`Group Actions: ${regionName(node)}`}
                >
                  •••
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Content className="menu" align="end">
                    <Menu.Label className="menu-label">
                      {regionName(node)}
                    </Menu.Label>
                    <Menu.Item
                      disabled={!node.getSelectedNode()}
                      onSelect={() => {
                        setMoving(node.getSelectedNode()!.getId());
                        setTarget("");
                      }}
                    >
                      Move To…
                    </Menu.Item>
                    <Menu.Item
                      onSelect={() => layout.maximizeGroup(node.getId())}
                    >
                      Maximize / Restore Group
                    </Menu.Item>
                    <Menu.Item
                      onSelect={() =>
                        layout.close(node.getSelectedNode()!.getId())
                      }
                    >
                      Close View
                    </Menu.Item>
                    <Menu.Item
                      onSelect={() => layout.closeGroup(node.getId())}
                    >
                      Close Group ({node.getChildren().length} views)
                    </Menu.Item>
                    <Menu.Item
                      disabled={!layout.getSnapshot().canUndo}
                      onSelect={() => layout.undo()}
                    >
                      Undo Layout Change
                    </Menu.Item>
                  </Menu.Content>
                </Menu.Portal>
              </Menu.Root>,
            );
          }}
        />
      )}
      {source && region && preview && (
        <div
          className="dock-region"
          style={{
            left: region.x,
            top: region.y,
            width: region.width,
            height: region.height,
          }}
        />
      )}
      {source && preview && <DockPreview model={preview} source={source} />}
      {dragging && zones.map((zone, index) => {
        const active = target === zone.target && direction === zone.direction;
        const label = `${zone.direction}${zone.direction === "Left" || zone.direction === "Right" ? " of" : ""} ${zone.name}`;
        return <button key={`${zone.target}:${zone.direction}:${index}`}
          className={`parent-dock-zone dock-${zone.direction.toLowerCase()}${active ? " active" : ""}`}
          aria-label={`Move ${regionName(layout.model.getNodeById(dragging)!)} ${label[0].toLowerCase()}${label.slice(1)}`}
          data-region={zone.name} data-direction={zone.direction}
          style={{ left: zone.x, top: zone.y, width: zone.width, height: zone.height }}
          onDragOver={e => {
            e.preventDefault(); e.stopPropagation();
            setTarget(zone.target); setDirection(zone.direction);
          }}
          onDrop={e => {
            e.preventDefault(); e.stopPropagation();
            // Use the actual drop target, never an earlier hover choice.
            layout.move(dragging, zone.target, zone.direction); clear();
          }}>
          <Icon name="chevron" size={16} />
          {active && <span className="parent-dock-label">{label}</span>}
        </button>;
      })}
      {moving && (
        <Modal
          title={`Move ${regionName(layout.model.getNodeById(moving)!)}`}
          description="Choose the whole destination region, then the placement."
          onClose={() => {
            setMoving(null);
            setTarget("");
          }}
        >
          <label>
            Target Region
            <select
              aria-label="Target Region"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="" disabled>Choose a region…</option>
              {layout.targets(moving).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.kind === "Parent region" ? "Region" : t.kind}: {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Placement
            <select
              aria-label="Placement"
              value={direction}
              onChange={(e) => setDirection(e.target.value as Direction)}
            >
              {Object.keys(directions).map((d) => (
                <option
                  key={d}
                  disabled={!layout.preview(moving, target, d as Direction)}
                >
                  {d}
                </option>
              ))}
            </select>
          </label>
          {!preview && (
            <p>
              Choose a destination and placement.
            </p>
          )}
          <button
            className="primary"
            disabled={!preview}
            onClick={() => {
              layout.move(moving, target, direction);
              setMoving(null);
              setTarget("");
            }}
          >
            Move View
          </button>
        </Modal>
      )}
    </div>
  );
}
