import {
  Component,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { Actions, Layout, Model, TabNode, TabSetNode } from "flexlayout-react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Modal } from "./primitives";
import { directions, PanelLayout, regionName } from "./layout-model";
import type { Direction } from "./layout-model";
import type { Studio } from "./studio";
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
      <div className="dock-calculation">
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
export function LayoutHost({
  studio,
  registry,
  onLayout,
}: {
  studio: Studio;
  registry: (node: TabNode) => ReactNode;
  onLayout: (layout: PanelLayout) => void;
}) {
  useSyncExternalStore(
    (fn) => studio.subscribeChannels(["layout", "documents"], fn),
    () => studio.channelSnapshot(["layout", "documents"]),
  );
  const layout = useMemo(
    () => new PanelLayout(studio),
    [studio, studio.project],
  );
  const [moving, setMoving] = useState<string | null>(null),
    [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState(""),
    [direction, setDirection] = useState<Direction>("Left");
  onLayout(layout);
  const dragChoice = useRef<{ target: string; direction: Direction } | null>(
    null,
  );
  const clear = () => {
    dragChoice.current = null;
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
  const region = target ? layout.model.getNodeById(target)?.getRect() : null;
  return (
    <div
      className="layout-host"
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
        if (!(e.target as HTMLElement).closest(".parent-dock-targets")) {
          dragChoice.current = null;
          setTarget("");
        }
      }}
    >
      {layout.empty ? (
        <div className="empty workspace-empty">
          <h2>Make room for your work</h2>
          <button onClick={() => studio.openFile?.()}>Open File…</button>
          <button className="primary" onClick={() => studio.documents.create()}>
            New R File
          </button>
          <button onClick={() => studio.openPanels?.()}>Show Panels</button>
        </div>
      ) : (
        <Layout
          model={layout.model}
          factory={(node) => <PanelBoundary>{registry(node)}</PanelBoundary>}
          realtimeResize
          tabDragSpeed={0}
          keyMap={{ closeTab: undefined }}
          invalidateTabContentOnParentRender={false}
          onAction={layout.prepareAction}
          onRenderTab={(node, values) => {
            const document = studio.documents.items.get(node.getId());
            values.content = (
              <span data-rho-view={node.getId()}>
                {document?.name ?? node.getName()}
                {document?.dirty && !document.draft.readonly ? " •" : ""}
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
                        setTarget(node.getId());
                      }}
                    >
                      Move To…
                    </Menu.Item>
                    <Menu.Item
                      onSelect={() =>
                        layout.model.doAction(
                          layout.prepareAction(
                            Actions.maximizeToggle(node.getId()),
                          ),
                        )
                      }
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
                      onSelect={() =>
                        layout.model.doAction(
                          Actions.deleteTabset(node.getId()),
                        )
                      }
                    >
                      Close Group ({node.getChildren().length} views)
                    </Menu.Item>
                    <Menu.Item
                      disabled={!layout.history.length}
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
      {dragging && (
        <div
          className="parent-dock-targets"
          aria-label="Parent docking targets"
        >
          {layout
            .targets(dragging)
            .filter((t) => t.kind !== "Group")
            .map((t) => (
              <div className="dock-target-row" key={t.id}>
                <span>
                  {t.kind}: {t.name}
                </span>
                {Object.keys(directions)
                  .filter((d) => d !== "Join as Tab")
                  .map((d) => {
                    const valid = !!layout.preview(
                      dragging,
                      t.id,
                      d as Direction,
                    );
                    return (
                      <button
                        key={d}
                        disabled={!valid}
                        title={
                          valid
                            ? `Move ${d.toLowerCase()} of ${t.name}`
                            : "Not enough room for this split"
                        }
                        onDragOver={(e) => {
                          if (!valid) return;
                          e.preventDefault();
                          e.stopPropagation();
                          const rect = e.currentTarget.getBoundingClientRect(),
                            previous = dragChoice.current;
                          if (
                            previous &&
                            (previous.target !== t.id ||
                              previous.direction !== d) &&
                            (e.clientX < rect.left + 4 ||
                              e.clientX > rect.right - 4 ||
                              e.clientY < rect.top + 4 ||
                              e.clientY > rect.bottom - 4)
                          )
                            return;
                          dragChoice.current = {
                            target: t.id,
                            direction: d as Direction,
                          };
                          setTarget(t.id);
                          setDirection(d as Direction);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (dragChoice.current)
                            layout.move(
                              dragging,
                              dragChoice.current.target,
                              dragChoice.current.direction,
                            );
                          clear();
                        }}
                      >
                        {d}
                      </button>
                    );
                  })}
              </div>
            ))}
        </div>
      )}
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
              {layout.targets(moving).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.kind}: {t.name}
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
              Choose another destination; this split has too little space or
              leaves the view in the same position.
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
