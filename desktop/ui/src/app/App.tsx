import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";

import {
  StudioExternalStore,
  SurfaceExternalStore,
  RuntimeExternalStore,
  UiExternalStore,
  commandsForPlacement,
  createUiKernelTransport,
} from "../transport";
import type {
  LayoutAxis,
  LayoutBasis,
  LayoutChild,
  LayoutNode,
  RuntimeDescriptor,
  RuntimeExecutionResult,
  RuntimeInstanceRequest,
  RuntimeRegistrySnapshot,
  SceneEdit,
  StudioRuntimeSnapshot,
  SurfaceInstance,
  SurfaceInstanceRequest,
  UiKernelTransport,
} from "../transport";

interface AppProps {
  readonly transport?: UiKernelTransport;
}

const defaultTransport = createUiKernelTransport();
const defaultStore = new UiExternalStore(defaultTransport);
const defaultSurfaceStore = new SurfaceExternalStore(defaultTransport);
const defaultStudioStore = new StudioExternalStore(defaultTransport);
const defaultRuntimeStore = new RuntimeExternalStore(defaultTransport);

function instanceRequest(
  instance: SurfaceInstance,
  projectRevision: number,
): SurfaceInstanceRequest {
  return {
    project_id: instance.project_id,
    instance_id: instance.instance_id,
    activation_generation: instance.activation_generation,
    expected_project_revision: projectRevision,
    expected_surface_revision: instance.surface_revision,
  };
}

function runtimeRequest(
  runtime: RuntimeDescriptor,
  projectRevision: number,
): RuntimeInstanceRequest {
  return {
    project_id: runtime.project_id,
    runtime_provider_id: runtime.runtime_provider_id,
    runtime_instance_id: runtime.runtime_instance_id,
    activation_generation: runtime.activation_generation,
    expected_project_revision: projectRevision,
    expected_state_revision: runtime.state_revision,
  };
}

function basisStyle(basis: LayoutBasis, axis: LayoutAxis): CSSProperties {
  switch (basis.kind) {
    case "auto": return { flex: "1 1 auto" };
    case "intrinsic": return { flex: "0 0 auto" };
    case "fixed": return { flex: `0 0 ${basis.logical_pixels}px` };
    case "fraction": return { flex: `${basis.weight} 1 0` };
    case "minmax":
      return {
        flex: `${basis.weight} 1 0`,
        ...(axis === "horizontal"
          ? { minWidth: `${basis.min_logical_pixels}px`, maxWidth: `${basis.max_logical_pixels}px` }
          : { minHeight: `${basis.min_logical_pixels}px`, maxHeight: `${basis.max_logical_pixels}px` }),
      };
  }
}

function minimumExtent(basis: LayoutBasis): number {
  switch (basis.kind) {
    case "intrinsic": return 48;
    case "fixed": return basis.logical_pixels;
    case "minmax": return basis.min_logical_pixels;
    case "auto":
    case "fraction": return 176;
  }
}

function useContainerExtent(axis: LayoutAxis) {
  const ref = useRef<HTMLDivElement>(null);
  const [extent, setExtent] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const element = ref.current;
    if (element == null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry != null) {
        setExtent(axis === "horizontal" ? entry.contentRect.width : entry.contentRect.height);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [axis]);
  return { ref, extent };
}

interface ResizeHandleProps {
  readonly axis: LayoutAxis;
  readonly containerId: string;
  readonly beforeIndex: number;
  readonly commit: (edit: SceneEdit) => void;
}

function ResizeHandle({ axis, containerId, beforeIndex, commit }: ResizeHandleProps) {
  const drag = useRef<{
    start: number;
    before: number;
    after: number;
    pending: number;
    frame: number | null;
    beforeElement: HTMLElement;
    afterElement: HTMLElement;
  } | null>(null);

  const preview = () => {
    const current = drag.current;
    if (current == null) return;
    current.frame = null;
    const before = Math.max(56, current.before + current.pending);
    const after = Math.max(56, current.after - (before - current.before));
    current.beforeElement.style.flex = `0 0 ${before}px`;
    current.afterElement.style.flex = `0 0 ${after}px`;
  };
  const boundaryEdit = (before: number, after: number): SceneEdit => ({
    kind: "resize_boundary",
    container_node_id: containerId,
    before_child_index: beforeIndex,
    before_basis: { kind: "fixed", logical_pixels: Math.max(56, Math.round(before)) },
    after_basis: { kind: "fixed", logical_pixels: Math.max(56, Math.round(after)) },
  });
  const extentOf = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return axis === "horizontal" ? rect.width : rect.height;
  };

  return (
    <button
      className={`rho-resize-handle rho-resize-${axis}`}
      type="button"
      aria-label={`Resize boundary ${beforeIndex + 1}`}
      onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => {
        const beforeElement = event.currentTarget.previousElementSibling as HTMLElement | null;
        const afterElement = event.currentTarget.nextElementSibling as HTMLElement | null;
        if (beforeElement == null || afterElement == null) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          start: axis === "horizontal" ? event.clientX : event.clientY,
          before: extentOf(beforeElement),
          after: extentOf(afterElement),
          pending: 0,
          frame: null,
          beforeElement,
          afterElement,
        };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current == null) return;
        current.pending = (axis === "horizontal" ? event.clientX : event.clientY) - current.start;
        if (current.frame == null) current.frame = requestAnimationFrame(preview);
      }}
      onPointerUp={(event) => {
        const current = drag.current;
        if (current == null) return;
        if (current.frame != null) cancelAnimationFrame(current.frame);
        preview();
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        commit(boundaryEdit(extentOf(current.beforeElement), extentOf(current.afterElement)));
      }}
      onPointerCancel={(event) => {
        const current = drag.current;
        if (current == null) return;
        if (current.frame != null) cancelAnimationFrame(current.frame);
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onKeyDown={(event) => {
        const delta = axis === "horizontal"
          ? event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0
          : event.key === "ArrowUp" ? -16 : event.key === "ArrowDown" ? 16 : 0;
        if (delta === 0) return;
        const beforeElement = event.currentTarget.previousElementSibling as HTMLElement | null;
        const afterElement = event.currentTarget.nextElementSibling as HTMLElement | null;
        if (beforeElement == null || afterElement == null) return;
        event.preventDefault();
        const before = extentOf(beforeElement);
        const after = extentOf(afterElement);
        const clamped = Math.max(-before + 56, Math.min(after - 56, delta));
        commit(boundaryEdit(before + clamped, after - clamped));
      }}
    ><span aria-hidden="true" /></button>
  );
}

interface SurfaceViewProps {
  readonly instance: SurfaceInstance;
  readonly focused: boolean;
  readonly setFocus: () => void;
  readonly remove: () => void;
  readonly duplicate: () => void;
  readonly persistDraft: (draft: string) => void;
  readonly draftCache: Map<string, string>;
  readonly runtimes: RuntimeRegistrySnapshot | null;
  readonly attachRuntime: (runtime: RuntimeDescriptor) => Promise<void>;
  readonly detachRuntime: () => Promise<void>;
  readonly executeRuntime: (
    runtime: RuntimeDescriptor,
    code: string,
  ) => Promise<RuntimeExecutionResult>;
  readonly interruptRuntime: (runtime: RuntimeDescriptor) => Promise<void>;
  readonly restartRuntime: (runtime: RuntimeDescriptor) => Promise<void>;
  readonly persistConsole: (viewState: ConsoleViewState) => Promise<void>;
  readonly reportError: (error: unknown) => void;
}

interface ConsoleOutputRecord {
  readonly execution_id: string;
  readonly runtime_instance_id: string;
  readonly code: string;
  readonly events: RuntimeExecutionResult["events"];
}

interface ConsoleViewState {
  readonly draft: string;
  readonly history: readonly string[];
  readonly history_cursor: number | null;
  readonly filter: string;
  readonly scroll_top: number;
  readonly outputs: readonly ConsoleOutputRecord[];
}

function initialConsoleState(instance: SurfaceInstance): ConsoleViewState {
  const candidate = instance.view_state;
  if (typeof candidate !== "object" || candidate == null) {
    return { draft: "", history: [], history_cursor: null, filter: "", scroll_top: 0, outputs: [] };
  }
  const value = candidate as Partial<ConsoleViewState>;
  return {
    draft: typeof value.draft === "string" ? value.draft : "",
    history: Array.isArray(value.history)
      ? value.history.filter((item): item is string => typeof item === "string").slice(-100)
      : [],
    history_cursor: typeof value.history_cursor === "number" ? value.history_cursor : null,
    filter: typeof value.filter === "string" ? value.filter : "",
    scroll_top: typeof value.scroll_top === "number" ? value.scroll_top : 0,
    outputs: Array.isArray(value.outputs) ? value.outputs.slice(-100) as ConsoleOutputRecord[] : [],
  };
}

function outputText(output: ConsoleOutputRecord): string {
  return `${output.code}\n${output.events.map((event) =>
    typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload)
  ).join("\n")}`;
}

function initialDraft(instance: SurfaceInstance, cache: Map<string, string>): string {
  const cached = cache.get(instance.instance_id);
  if (cached != null) return cached;
  if (
    typeof instance.view_state === "object" && instance.view_state != null &&
    "draft" in instance.view_state && typeof instance.view_state.draft === "string"
  ) return instance.view_state.draft;
  return "";
}

function SurfaceView({
  instance, focused, setFocus, remove, duplicate, persistDraft, draftCache,
  runtimes, attachRuntime, detachRuntime, executeRuntime, interruptRuntime,
  restartRuntime, persistConsole, reportError,
}: SurfaceViewProps) {
  const [draft, setDraft] = useState(() => initialDraft(instance, draftCache));
  const [consoleState, setConsoleState] = useState(() => initialConsoleState(instance));
  const [consoleRunning, setConsoleRunning] = useState(false);
  const runtime = instance.runtime_binding;
  const resource = instance.resource_binding;
  const isStrip = instance.surface_id === "rho.status";
  const title = instance.surface_id === "rho.console" ? "R Console"
    : instance.surface_id === "rho.file" ? (instance.mode_id === "preview" ? "File preview" : "Source editor")
    : instance.surface_id === "rho.status" ? "Runtime status"
    : instance.surface_id === "rho.check" ? "Project checks" : "Surface Playground";
  const attached = runtimes?.instances.find((candidate) =>
    candidate.runtime_instance_id === runtime?.runtime_instance_id &&
    candidate.activation_generation === runtime.activation_generation
  ) ?? null;
  const filteredOutputs = consoleState.outputs.filter((output) =>
    !consoleState.filter.trim() || outputText(output).toLowerCase().includes(consoleState.filter.trim().toLowerCase())
  );
  const commitConsole = (next: ConsoleViewState) => {
    setConsoleState(next);
    void persistConsole(next).catch(reportError);
  };
  const submitConsole = async () => {
    const code = consoleState.draft.trim();
    if (attached == null || !code || consoleRunning) return;
    setConsoleRunning(true);
    try {
      const result = await executeRuntime(attached, code);
      const next: ConsoleViewState = {
        ...consoleState,
        draft: "",
        history: [...consoleState.history, code].slice(-100),
        history_cursor: null,
        outputs: [...consoleState.outputs, {
          execution_id: result.execution_id,
          runtime_instance_id: result.runtime_instance_id,
          code,
          events: result.events,
        }].slice(-100),
      };
      commitConsole(next);
    } catch (error: unknown) {
      reportError(error);
    } finally {
      setConsoleRunning(false);
    }
  };
  return (
    <article
      className={`rho-surface rho-surface-${instance.lifecycle_state} ${focused ? "rho-surface-focused" : ""} ${isStrip ? "rho-surface-strip" : ""}`}
      data-instance-id={instance.instance_id}
      data-surface-id={instance.surface_id}
      onPointerDown={setFocus}
    >
      <header className="rho-surface-chrome">
        <div><span className="rho-eyebrow">{instance.surface_id}</span><strong>{title}</strong></div>
        <div className="rho-surface-actions" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" onClick={duplicate}>Duplicate</button>
          <button type="button" onClick={remove} aria-label={`Remove ${instance.instance_id} from layout`}>×</button>
        </div>
      </header>
      {instance.surface_id === "rho.console" && (
        <div className="rho-console-surface">
          <div className="rho-console-runtime-bar">
            <select
              aria-label={`Runtime for ${instance.instance_id}`}
              value={attached?.runtime_instance_id ?? ""}
              disabled={consoleRunning}
              onChange={(event) => {
                const selected = runtimes?.instances.find((candidate) =>
                  candidate.runtime_instance_id === event.target.value
                );
                const operation = selected == null ? detachRuntime() : attachRuntime(selected);
                void operation.catch(reportError);
              }}
            >
              <option value="">Attach runtime…</option>
              {runtimes?.instances.filter((candidate) =>
                candidate.attach_capabilities.includes("console.attach")
              ).map((candidate) => (
                <option value={candidate.runtime_instance_id} key={candidate.runtime_instance_id}>
                  {candidate.display_label} · {candidate.status}
                </option>
              ))}
            </select>
            <span className={`rho-runtime-state rho-runtime-${attached?.status ?? "unbound"}`}>
              {attached?.status ?? "unbound"}
            </span>
            <button type="button" disabled={attached == null || consoleRunning} onClick={() => {
              if (attached != null) void interruptRuntime(attached).catch(reportError);
            }}>Interrupt</button>
            <button type="button" disabled={attached == null || consoleRunning} onClick={() => {
              if (attached != null) void restartRuntime(attached).catch(reportError);
            }}>Restart</button>
          </div>
          <div
            className="rho-console-output"
            ref={(element) => {
              if (element != null && Math.abs(element.scrollTop - consoleState.scroll_top) > 1) {
                element.scrollTop = consoleState.scroll_top;
              }
            }}
            onBlur={(event) => {
              const scrollTop = event.currentTarget.scrollTop;
              if (scrollTop !== consoleState.scroll_top) {
                commitConsole({ ...consoleState, scroll_top: scrollTop });
              }
            }}
            tabIndex={0}
          >
            {filteredOutputs.length === 0 && <p className="rho-console-empty">No output in this Console.</p>}
            {filteredOutputs.map((output) => (
              <section className="rho-console-entry" key={output.execution_id}>
                <header><span>{output.runtime_instance_id}</span><span>{instance.instance_id}</span></header>
                <code>&gt; {output.code}</code>
                {output.events.map((event) => <pre key={event.sequence}>{
                  typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload, null, 2)
                }</pre>)}
              </section>
            ))}
          </div>
          <div className="rho-console-composer">
            <input
              aria-label={`Filter output ${instance.instance_id}`}
              className="rho-console-filter"
              value={consoleState.filter}
              onChange={(event) => setConsoleState({ ...consoleState, filter: event.target.value })}
              onBlur={() => void persistConsole(consoleState).catch(reportError)}
              placeholder="Filter this Console"
            />
            <textarea
              aria-label={`Code for ${instance.instance_id}`}
              value={consoleState.draft}
              disabled={attached == null || consoleRunning}
              onChange={(event) => setConsoleState({ ...consoleState, draft: event.target.value, history_cursor: null })}
              onBlur={() => void persistConsole(consoleState).catch(reportError)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submitConsole();
                  return;
                }
                if ((event.key === "ArrowUp" || event.key === "ArrowDown") && consoleState.history.length > 0) {
                  event.preventDefault();
                  const current = consoleState.history_cursor ?? consoleState.history.length;
                  const cursor = event.key === "ArrowUp"
                    ? Math.max(0, current - 1)
                    : Math.min(consoleState.history.length, current + 1);
                  setConsoleState({
                    ...consoleState,
                    history_cursor: cursor === consoleState.history.length ? null : cursor,
                    draft: cursor === consoleState.history.length ? "" : consoleState.history[cursor] ?? "",
                  });
                }
              }}
              placeholder={attached == null ? "Attach this Console to a Runtime" : "R code…"}
            />
            <button type="button" disabled={attached == null || !consoleState.draft.trim() || consoleRunning} onClick={() => void submitConsole()}>
              {consoleRunning ? "Running…" : "Run"}
            </button>
          </div>
        </div>
      )}
      {instance.surface_id === "rho.file" && (
        <div className="rho-file-surface"><span className="rho-file-mode">{instance.mode_id ?? "default"}</span><code>{resource?.resource_id ?? "No resource bound"}</code><p>{instance.mode_id === "preview" ? "Rendered output evolves independently." : "Source buffer evolves independently."}</p></div>
      )}
      {instance.surface_id === "rho.status" && (
        <div className="rho-status-surface"><span className="rho-status-dot rho-status-ready" /> Workspace runtime ready <code>{runtime?.runtime_instance_id ?? "workspace"}</code></div>
      )}
      {instance.surface_id === "rho.surface-playground" && (
        <label className="rho-playground-draft">
          Independent draft <small>{instance.instance_id.slice(-12)}</small>
          <input
            aria-label={`Local draft ${instance.instance_id}`}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              draftCache.set(instance.instance_id, event.target.value);
            }}
            onBlur={() => persistDraft(draft)}
            placeholder="This view owns its state…"
          />
        </label>
      )}
      {!isStrip && <footer className="rho-surface-meta"><span>{instance.mode_id ?? "default"}</span><span>rev {instance.surface_revision}</span><span>{runtime == null ? "unbound" : runtime.runtime_instance_id}</span></footer>}
    </article>
  );
}

interface TreeProps {
  readonly node: LayoutNode;
  readonly instances: ReadonlyMap<string, SurfaceInstance>;
  readonly studio: StudioRuntimeSnapshot;
  readonly commit: (edit: SceneEdit) => void;
  readonly surfaceView: (instance: SurfaceInstance) => ReactNode;
}

function LayoutTree({ node, instances, studio, commit, surfaceView }: TreeProps) {
  if (node.kind === "surface") {
    const instance = instances.get(node.instance_id);
    return instance == null ? <div className="rho-missing-surface">Unavailable Surface {node.instance_id}</div> : surfaceView(instance);
  }
  if (node.kind === "stack") {
    return (
      <section className="rho-stack" data-node-id={node.node_id}>
        <div className="rho-stack-tabs" role="tablist" aria-label="Surface stack">
          {node.instances.map((id) => (
            <button
              type="button" role="tab" aria-selected={id === node.active_instance_id} key={id}
              onClick={() => commit({ kind: "set_stack_active", stack_node_id: node.node_id, instance_id: id })}
            >{instances.get(id)?.surface_id.replace("rho.", "") ?? id}</button>
          ))}
        </div>
        <div className="rho-stack-panes">
          {node.instances.map((id) => (
            <div className="rho-stack-pane" key={id} hidden={id !== node.active_instance_id}>
              {instances.get(id) == null ? <div>Unavailable Surface {id}</div> : surfaceView(instances.get(id)!)}
            </div>
          ))}
        </div>
      </section>
    );
  }
  return <AdaptiveContainer node={node} instances={instances} studio={studio} commit={commit} surfaceView={surfaceView} />;
}

function AdaptiveContainer({ node, instances, studio, commit, surfaceView }: TreeProps & {
  readonly node: Extract<LayoutNode, { kind: "container" }>;
}) {
  const { ref, extent } = useContainerExtent(node.axis);
  const [forcedOpen, setForcedOpen] = useState<ReadonlySet<number>>(() => new Set());
  const candidates = node.children
    .map((child, index) => ({ child, index }))
    .filter(({ child, index }) => child.collapse_priority != null && !forcedOpen.has(index))
    .sort((left, right) => (left.child.collapse_priority ?? 65_535) - (right.child.collapse_priority ?? 65_535));
  let desired = node.children.reduce((sum, child) => sum + minimumExtent(child.basis), 0);
  const collapsed = new Set<number>();
  for (const candidate of candidates) {
    if (desired <= extent) break;
    collapsed.add(candidate.index);
    desired -= minimumExtent(candidate.child.basis);
  }
  const visibleCount = node.children.length - collapsed.size;
  return (
    <section ref={ref} className={`rho-layout-container rho-axis-${node.axis}`} data-node-id={node.node_id} data-layout-revision={studio.scene.layout_revision}>
      {node.children.map((child, index) => {
        const isCollapsed = collapsed.has(index);
        const next = node.children[index + 1];
        const showHandle = !isCollapsed && next != null && !collapsed.has(index + 1) && child.resizable && next.resizable && visibleCount > 1;
        return (
          <ContainerChild
            key={child.child.node_id} child={child} index={index} collapsed={isCollapsed} axis={node.axis}
            handle={showHandle ? <ResizeHandle axis={node.axis} containerId={node.node_id} beforeIndex={index} commit={commit} /> : null}
          >
            <LayoutTree node={child.child} instances={instances} studio={studio} commit={commit} surfaceView={surfaceView} />
          </ContainerChild>
        );
      })}
      {collapsed.size > 0 && (
        <nav className="rho-collapse-rail" aria-label="Collapsed layout regions">
          {[...collapsed].map((index) => <button type="button" key={node.children[index]!.child.node_id} onClick={() => setForcedOpen((current) => new Set([...current, index]))}>Restore {node.children[index]!.child.node_id.replace("node:", "")}</button>)}
        </nav>
      )}
    </section>
  );
}

function ContainerChild({ child, index, collapsed, axis, handle, children }: {
  readonly child: LayoutChild;
  readonly index: number;
  readonly collapsed: boolean;
  readonly axis: LayoutAxis;
  readonly handle: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <>
      <div
        className={`rho-layout-child ${collapsed ? "rho-layout-child-collapsed" : ""}`}
        data-child-index={index}
        data-collapse-priority={child.collapse_priority ?? undefined}
        style={collapsed ? { flex: "0 0 0", minWidth: 0, minHeight: 0 } : basisStyle(child.basis, axis)}
      >{children}</div>
      {handle}
    </>
  );
}

function NodeOutline({ node, commit }: { readonly node: LayoutNode; readonly commit: (edit: SceneEdit) => void }) {
  if (node.kind === "surface") return <code>{node.instance_id}</code>;
  if (node.kind === "stack") return <span><strong>Stack</strong> <small>{node.instances.length} tabs</small></span>;
  return (
    <div>
      <div className="rho-outline-row">
        <strong>{node.axis === "horizontal" ? "Row" : "Column"}</strong>
        <button type="button" onClick={() => commit({ kind: "set_container_axis", container_node_id: node.node_id, axis: node.axis === "horizontal" ? "vertical" : "horizontal" })}>Flip</button>
        <button type="button" onClick={() => commit({ kind: "distribute_container", container_node_id: node.node_id })}>Equalize</button>
      </div>
      <ol>{node.children.map((child, index) => (
        <li key={child.child.node_id}>
          <div className="rho-child-policy">
            <span>{child.basis.kind}</span>
            <span>{child.collapse_priority == null ? "always open" : `collapse P${child.collapse_priority}`}</span>
            {child.collapse_priority == null ? (
              <button type="button" onClick={() => commit({ kind: "set_collapse_priority", container_node_id: node.node_id, child_index: index, collapse_priority: 1 })}>Adaptive</button>
            ) : (
              <>
                <button type="button" onClick={() => commit({ kind: "set_collapse_priority", container_node_id: node.node_id, child_index: index, collapse_priority: Math.min(65_535, child.collapse_priority! + 1) })}>Later</button>
                <button type="button" onClick={() => commit({ kind: "set_collapse_priority", container_node_id: node.node_id, child_index: index, collapse_priority: null })}>Pin</button>
              </>
            )}
          </div>
          <NodeOutline node={child.child} commit={commit} />
        </li>
      ))}</ol>
    </div>
  );
}

export function App({ transport }: AppProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const draftCache = useRef(new Map<string, string>()).current;
  const store = useMemo(() => transport == null ? defaultStore : new UiExternalStore(transport), [transport]);
  const surfaceStore = useMemo(() => transport == null ? defaultSurfaceStore : new SurfaceExternalStore(transport), [transport]);
  const studioStore = useMemo(() => transport == null ? defaultStudioStore : new StudioExternalStore(transport), [transport]);
  const runtimeStore = useMemo(() => transport == null ? defaultRuntimeStore : new RuntimeExternalStore(transport), [transport]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const surfaceState = useSyncExternalStore(surfaceStore.subscribe, surfaceStore.getSnapshot, surfaceStore.getSnapshot);
  const studioState = useSyncExternalStore(studioStore.subscribe, studioStore.getSnapshot, studioStore.getSnapshot);
  const runtimeState = useSyncExternalStore(runtimeStore.subscribe, runtimeStore.getSnapshot, runtimeStore.getSnapshot);
  const snapshot = state.status === "ready" ? state.snapshot : null;
  const surfaces = surfaceState.status === "ready" ? surfaceState.snapshot : null;
  const studio = studioState.status === "ready" ? studioState.snapshot : null;
  const runtimes = runtimeState.status === "ready" ? runtimeState.snapshot : null;
  const instances = useMemo(() => new Map(surfaces?.catalog.instances.map((instance) => [instance.instance_id, instance]) ?? []), [surfaces]);
  const primaryCommands = useMemo(() => snapshot == null ? [] : commandsForPlacement(snapshot, "primary_candidate"), [snapshot]);
  const run = (operation: Promise<unknown>) => {
    setActionError(null);
    void operation.catch((error: unknown) => setActionError(error instanceof Error && error.message.trim() ? error.message.slice(0, 512) : "Studio operation failed."));
  };
  const commit = (edit: SceneEdit) => {
    if (studio == null) return;
    run(studioStore.apply({
      project_id: studio.project_id,
      expected_project_revision: studio.project_revision,
      expected_layout_revision: studio.scene.layout_revision,
      edit,
    }));
  };
  const revisionRequest = () => studio == null ? null : {
    project_id: studio.project_id,
    expected_project_revision: studio.project_revision,
    expected_layout_revision: studio.scene.layout_revision,
  };
  const duplicate = async (instance: SurfaceInstance) => {
    if (surfaces == null || studio == null) return;
    const before = new Set(surfaces.catalog.instances.map((candidate) => candidate.instance_id));
    const opened = await surfaceStore.open({
      surface_id: instance.surface_id,
      project_id: surfaces.project_id,
      mode_id: instance.mode_id,
      resource_binding: instance.resource_binding,
      runtime_binding: instance.runtime_binding,
      view_group_id: instance.view_group_id,
      view_state: instance.view_state,
      instance_disposition: "new_instance",
      placement_intent: "beside",
      expected_project_revision: surfaces.project_revision,
      expected_layout_revision: studio.scene.layout_revision,
    });
    const created = opened.catalog.instances.find((candidate) => !before.has(candidate.instance_id));
    if (created == null) throw new Error("Surface Runtime did not return the duplicated instance.");
    if (studio.scene.root.kind !== "container") return;
    await studioStore.apply({
      project_id: studio.project_id,
      expected_project_revision: studio.project_revision,
      expected_layout_revision: studio.scene.layout_revision,
      edit: {
        kind: "insert_surface",
        target_container_node_id: studio.scene.root.node_id,
        child_index: studio.scene.root.children.length,
        instance_id: created.instance_id,
        basis: { kind: "fraction", weight: 1 },
      },
    });
  };
  const openConsole = async (runtime: RuntimeDescriptor) => {
    if (surfaces == null || studio == null) return;
    const before = new Set(surfaces.catalog.instances.map((candidate) => candidate.instance_id));
    const opened = await surfaceStore.open({
      surface_id: "rho.console",
      project_id: surfaces.project_id,
      mode_id: null,
      resource_binding: null,
      runtime_binding: {
        runtime_provider_id: runtime.runtime_provider_id,
        runtime_instance_id: runtime.runtime_instance_id,
        runtime_kind: runtime.runtime_kind,
        project_id: runtime.project_id,
        activation_generation: runtime.activation_generation,
        state_revision: runtime.state_revision,
        attach_capabilities: runtime.attach_capabilities,
      },
      view_group_id: null,
      view_state: {
        draft: "",
        history: [],
        history_cursor: null,
        filter: "",
        scroll_top: 0,
        outputs: [],
      },
      instance_disposition: "new_instance",
      placement_intent: "beside",
      expected_project_revision: surfaces.project_revision,
      expected_layout_revision: studio.scene.layout_revision,
    });
    const created = opened.catalog.instances.find((candidate) => !before.has(candidate.instance_id));
    if (created == null) throw new Error("Surface Runtime did not return the new Console.");
    if (studio.scene.root.kind !== "container") return;
    await studioStore.apply({
      project_id: studio.project_id,
      expected_project_revision: studio.project_revision,
      expected_layout_revision: studio.scene.layout_revision,
      edit: {
        kind: "insert_surface",
        target_container_node_id: studio.scene.root.node_id,
        child_index: studio.scene.root.children.length,
        instance_id: created.instance_id,
        basis: { kind: "fraction", weight: 1 },
      },
    });
  };
  const surfaceView = (instance: SurfaceInstance) => (
    <SurfaceView
      key={instance.instance_id}
      instance={instance}
      focused={studio?.scene.focused_surface_instance_id === instance.instance_id}
      setFocus={() => {
        if (studio?.scene.focused_surface_instance_id !== instance.instance_id) {
          commit({ kind: "set_focus", instance_id: instance.instance_id });
        }
      }}
      remove={() => commit({ kind: "close_surface_placement", instance_id: instance.instance_id })}
      duplicate={() => run(duplicate(instance))}
      draftCache={draftCache}
      persistDraft={(draft) => {
        if (surfaces == null) return;
        run(surfaceStore.update({ target: instanceRequest(instance, surfaces.project_revision), mutation: { kind: "set_view_state", view_state: { draft } } }));
      }}
      runtimes={runtimes}
      attachRuntime={async (runtime) => {
        if (surfaces == null || runtimes == null) return;
        await runtimeStore.attach({
          runtime: runtimeRequest(runtime, runtimes.project_revision),
          surface: instanceRequest(instance, surfaces.project_revision),
        });
        await surfaceStore.refresh();
      }}
      detachRuntime={async () => {
        if (surfaces == null) return;
        await runtimeStore.detach({
          surface: instanceRequest(instance, surfaces.project_revision),
        });
        await surfaceStore.refresh();
      }}
      executeRuntime={async (runtime, code) => {
        if (runtimes == null) throw new Error("Runtime Registry is not ready.");
        const result = await runtimeStore.execute({
          runtime: runtimeRequest(runtime, runtimes.project_revision),
          console_instance_id: instance.instance_id,
          expected_console_revision: instance.surface_revision,
          code,
        });
        await runtimeStore.refresh();
        return result;
      }}
      interruptRuntime={async (runtime) => {
        if (runtimes == null) return;
        await runtimeStore.interrupt(runtimeRequest(runtime, runtimes.project_revision));
      }}
      restartRuntime={async (runtime) => {
        if (runtimes == null) return;
        await runtimeStore.restart(runtimeRequest(runtime, runtimes.project_revision));
        await surfaceStore.refresh();
      }}
      persistConsole={async (viewState) => {
        if (surfaces == null) return;
        await surfaceStore.update({
          target: instanceRequest(instance, surfaces.project_revision),
          mutation: { kind: "set_view_state", view_state: viewState },
        });
      }}
      reportError={(error) => setActionError(
        error instanceof Error && error.message.trim()
          ? error.message.slice(0, 512)
          : "Runtime operation failed.",
      )}
    />
  );
  const evidence = useMemo(() => ({
    ready: snapshot != null && surfaces != null && studio != null && runtimes != null,
    source: state.status === "ready" ? state.source : null,
    project: snapshot?.project.display_path ?? null,
    layoutRevision: studio?.scene.layout_revision ?? null,
    studioInstances: studio == null ? [] : [...instances.keys()],
    unplaced: studio?.unplaced_instance_ids ?? [],
    recursiveLayout: studio?.scene.root.kind ?? null,
    runtimeInstances: runtimes?.instances.map((runtime) => ({
      id: runtime.runtime_instance_id,
      generation: runtime.activation_generation,
      status: runtime.status,
    })) ?? [],
  }), [instances, runtimes, snapshot, state, studio, surfaces]);
  useEffect(() => {
    document.documentElement.dataset.rsrReady = String(evidence.ready);
  }, [evidence.ready]);

  return (
    <main className="rho-studio-shell">
      <header className="rho-studio-bar">
        <div className="rho-mark" aria-label="Rho"><span className="rho-mark-glyph">R</span><span>Rho</span></div>
        <div className="rho-project-identity"><span className="rho-eyebrow">Studio scene</span><strong>{snapshot?.project.display_label ?? "Loading…"}</strong></div>
        <div className="rho-command-projection" aria-label="Contextual commands">
          {primaryCommands.filter((command) => command.availability.state === "available").slice(0, 1).map((command) => <span className="rho-primary-command" key={command.definition.command_id}>{command.definition.label}</span>)}
          <span className="rho-command-count">{snapshot?.command_registry.registrations.length ?? 0} commands</span>
        </div>
        <div className="rho-studio-history">
          <button type="button" disabled={!studio?.can_undo} onClick={() => { const request = revisionRequest(); if (request != null) run(studioStore.undo(request)); }}>Undo</button>
          <button type="button" disabled={!studio?.can_redo} onClick={() => { const request = revisionRequest(); if (request != null) run(studioStore.redo(request)); }}>Redo</button>
        </div>
        <div className="rho-foundation-status"><span className={`rho-status-dot rho-status-${snapshot?.context.workspace_health ?? state.status}`} /><span>{snapshot?.health.workspace.label ?? "Connecting"}</span></div>
      </header>
      <div className="rho-studio-workspace">
        <aside className="rho-studio-inspector">
          <header><span className="rho-eyebrow">Composition</span><strong>Layout inspector</strong></header>
          {snapshot?.health.agent.state !== "ready" && snapshot?.health.agent.label != null && (
            <div className="rho-agent-health" role="status">
              <strong>{snapshot.health.agent.label}</strong>
              {snapshot.health.agent.detail != null && <small>{snapshot.health.agent.detail}</small>}
            </div>
          )}
          {studio != null && (
            <>
              <div className="rho-inspector-actions">
                <button type="button" onClick={() => commit({ kind: "normalize" })}>Normalize</button>
                {studio.scene.root.kind === "container" && <button type="button" onClick={() => commit({ kind: "distribute_container", container_node_id: studio.scene.root.node_id })}>Distribute root</button>}
              </div>
              <ol className="rho-layout-outline"><li><NodeOutline node={studio.scene.root} commit={commit} /></li></ol>
              <section className="rho-inventory">
                <span className="rho-eyebrow">Unplaced instances</span>
                {studio.unplaced_instance_ids.length === 0 && <p>Every live Surface is placed.</p>}
                {studio.unplaced_instance_ids.map((id) => {
                  const instance = instances.get(id);
                  return (
                    <div key={id} className="rho-inventory-item">
                      <div><strong>{instance?.surface_id ?? id}</strong><small>{instance?.mode_id ?? "default"}</small></div>
                      <button
                        type="button"
                        disabled={studio.scene.root.kind !== "container"}
                        onClick={() => {
                          if (studio.scene.root.kind !== "container") return;
                          commit({
                            kind: "insert_surface",
                            target_container_node_id: studio.scene.root.node_id,
                            child_index: studio.scene.root.children.length,
                            instance_id: id,
                            basis: instance?.surface_id === "rho.status" ? { kind: "intrinsic" } : { kind: "fraction", weight: 1 },
                          });
                        }}
                      >Place</button>
                    </div>
                  );
                })}
              </section>
            </>
          )}
          {runtimes != null && (
            <section className="rho-runtime-inventory">
              <div className="rho-runtime-inventory-heading">
                <span className="rho-eyebrow">Runtime registry</span>
                {runtimes.providers.some((provider) => provider.definition.create_supported) && (
                  <button type="button" onClick={() => {
                    const provider = runtimes.providers.find((candidate) => candidate.definition.create_supported);
                    if (provider == null) return;
                    run(runtimeStore.create({
                      project_id: runtimes.project_id,
                      runtime_provider_id: provider.definition.runtime_provider_id,
                      expected_project_revision: runtimes.project_revision,
                      expected_snapshot_revision: runtimes.snapshot_revision,
                      display_label: null,
                    }));
                  }}>+ Runtime</button>
                )}
              </div>
              {runtimes.instances.map((runtime) => (
                <article className="rho-runtime-card" data-runtime-id={runtime.runtime_instance_id} key={runtime.runtime_instance_id}>
                  <div>
                    <span className={`rho-runtime-dot rho-runtime-${runtime.status}`} />
                    <strong>{runtime.display_label}</strong>
                    <small>{runtime.runtime_instance_id} · gen {runtime.activation_generation}</small>
                  </div>
                  <div className="rho-runtime-actions">
                    <button type="button" onClick={() => run(openConsole(runtime))}>Console</button>
                    <button type="button" onClick={() => run(runtimeStore.interrupt(runtimeRequest(runtime, runtimes.project_revision)))}>Interrupt</button>
                    <button type="button" onClick={() => run(runtimeStore.restart(runtimeRequest(runtime, runtimes.project_revision)))}>Restart</button>
                    {!runtime.primary_scientific_runtime && (
                      <button type="button" onClick={() => run(runtimeStore.stop(runtimeRequest(runtime, runtimes.project_revision)))}>Stop</button>
                    )}
                  </div>
                </article>
              ))}
            </section>
          )}
        </aside>
        <section className="rho-studio-canvas" aria-label="Studio layout canvas">
          {state.status === "failed" && <p role="alert">{state.message}</p>}
          {surfaceState.status === "failed" && <p role="alert">{surfaceState.message}</p>}
          {studioState.status === "failed" && <p role="alert">{studioState.message}</p>}
          {runtimeState.status === "failed" && <p role="alert">{runtimeState.message}</p>}
          {actionError != null && <p className="rho-action-error" role="alert">{actionError}</p>}
          {studio == null || surfaces == null
            ? <div className="rho-studio-loading">Loading the broker-owned Studio scene…</div>
            : <LayoutTree node={studio.scene.root} instances={instances} studio={studio} commit={commit} surfaceView={surfaceView} />}
        </section>
      </div>
      <pre id="rsrPreviewEvidence" hidden>{JSON.stringify(evidence)}</pre>
    </main>
  );
}
