import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";

import {
  ResourceExternalStore,
  StudioExternalStore,
  SurfaceExternalStore,
  RuntimeExternalStore,
  UiExternalStore,
  UiProfileExternalStore,
  commandsForPlacement,
  createUiKernelTransport,
} from "../transport";
import type {
  LayoutAxis,
  LayoutBasis,
  LayoutChild,
  LayoutNode,
  ResourceContent,
  ResourceDescriptor,
  ResourceReadConsistency,
  ResourceRegistrySnapshot,
  ResourceTarget,
  RuntimeDescriptor,
  RuntimeExecutionResult,
  RuntimeInstanceRequest,
  RuntimeRegistrySnapshot,
  SceneEdit,
  StudioRuntimeSnapshot,
  SurfaceInstance,
  SurfaceInstanceRequest,
  UiKernelTransport,
  VibeBlockContent,
  VibePage,
} from "../transport";
import DOMPurify from "dompurify";
import { marked } from "marked";

interface AppProps {
  readonly transport?: UiKernelTransport;
}

const defaultTransport = createUiKernelTransport();
const defaultStore = new UiExternalStore(defaultTransport);
const defaultSurfaceStore = new SurfaceExternalStore(defaultTransport);
const defaultStudioStore = new StudioExternalStore(defaultTransport);
const defaultRuntimeStore = new RuntimeExternalStore(defaultTransport);
const defaultResourceStore = new ResourceExternalStore(defaultTransport);
const defaultProfileStore = new UiProfileExternalStore(defaultTransport);

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

function resourceTarget(
  descriptor: ResourceDescriptor,
  projectRevision: number,
  resourceRevision = descriptor.resource_revision,
): ResourceTarget {
  return {
    project_id: descriptor.project_id,
    resource_provider_id: descriptor.resource_provider_id,
    resource_kind: descriptor.resource_kind,
    resource_id: descriptor.resource_id,
    expected_project_revision: projectRevision,
    expected_resource_revision: resourceRevision,
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
  readonly resources: ResourceRegistrySnapshot | null;
  readonly readResource: FileResourceViewProps["read"];
  readonly updateResourceDraft: FileResourceViewProps["updateDraft"];
  readonly saveResource: FileResourceViewProps["save"];
  readonly reloadResource: FileResourceViewProps["reload"];
  readonly renameResource: FileResourceViewProps["rename"];
  readonly deleteResource: FileResourceViewProps["removeResource"];
  readonly refreshResourceBinding: FileResourceViewProps["refreshBinding"];
  readonly setViewGroup: FileResourceViewProps["setViewGroup"];
  readonly persistFileViewState: FileResourceViewProps["persistViewState"];
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

interface FileResourceViewProps {
  readonly instance: SurfaceInstance;
  readonly registry: ResourceRegistrySnapshot | null;
  readonly read: (
    descriptor: ResourceDescriptor,
    consistency: ResourceReadConsistency,
    resourceRevision: number,
  ) => Promise<ResourceContent>;
  readonly updateDraft: (content: ResourceContent, value: string) => Promise<ResourceContent>;
  readonly save: (content: ResourceContent) => Promise<ResourceContent>;
  readonly reload: (content: ResourceContent, discardDirty: boolean) => Promise<ResourceContent>;
  readonly rename: (content: ResourceContent | null, nextId: string) => Promise<void>;
  readonly removeResource: (
    content: ResourceContent | null,
    discardDirty: boolean,
  ) => Promise<void>;
  readonly refreshBinding: (descriptor: ResourceDescriptor) => Promise<void>;
  readonly setViewGroup: (viewGroupId: string | null) => Promise<void>;
  readonly persistViewState: (viewState: unknown) => Promise<void>;
  readonly reportError: (error: unknown) => void;
}

function fileViewState(instance: SurfaceInstance) {
  const candidate = typeof instance.view_state === "object" && instance.view_state != null
    ? instance.view_state as Record<string, unknown>
    : {};
  return {
    cursorStart: typeof candidate.cursor_start === "number" ? candidate.cursor_start : 0,
    cursorEnd: typeof candidate.cursor_end === "number" ? candidate.cursor_end : 0,
    scrollTop: typeof candidate.scroll_top === "number" ? candidate.scroll_top : 0,
  };
}

function resourceMarkup(content: ResourceContent): { html?: string; text?: string; image?: string } {
  const mediaType = content.descriptor.media_type ?? "text/plain";
  if (content.content_encoding === "base64" && mediaType.startsWith("image/")) {
    return { image: `data:${mediaType};base64,${content.content}` };
  }
  if (mediaType === "text/markdown" || mediaType === "text/x-r-markdown") {
    const rendered = marked.parse(content.content, { async: false }) as string;
    return { html: DOMPurify.sanitize(rendered) };
  }
  if (mediaType === "text/html") {
    return { html: DOMPurify.sanitize(content.content) };
  }
  return { text: content.content };
}

function FileResourceView({
  instance, registry, read, updateDraft, save, reload, rename, removeResource,
  refreshBinding, setViewGroup, persistViewState, reportError,
}: FileResourceViewProps) {
  const binding = instance.resource_binding;
  const descriptor = registry?.resources.find((candidate) =>
    candidate.resource_provider_id === binding?.resource_provider_id &&
    candidate.resource_kind === binding?.resource_kind &&
    candidate.resource_id === binding.resource_id
  ) ?? null;
  const source = instance.surface_id === "rho.file-source";
  const [content, setContent] = useState<ResourceContent | null>(null);
  const [editorValue, setEditorValue] = useState("");
  const [localDirty, setLocalDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewGroup, setViewGroupInput] = useState(instance.view_group_id ?? "");
  const [renamePath, setRenamePath] = useState(binding?.resource_id ?? "");
  const view = fileViewState(instance);
  const bindingRevision = binding?.resource_revision ?? descriptor?.resource_revision ?? 0;
  const staleBinding = descriptor != null && bindingRevision !== descriptor.resource_revision;
  const sourceRefreshRevision = source ? registry?.snapshot_revision ?? 0 : 0;

  useEffect(() => {
    if (descriptor == null || binding == null || descriptor.status !== "ready") return;
    let active = true;
    setError(null);
    void read(
      descriptor,
      source ? "shared_document" : "immutable_snapshot",
      bindingRevision,
    ).then((next) => {
      if (!active) return;
      setContent(next);
      if (!localDirty) setEditorValue(next.content);
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : "Resource read failed.");
    });
    return () => { active = false; };
  }, [binding?.resource_id, bindingRevision, descriptor?.status, read, source, sourceRefreshRevision]);

  useEffect(() => {
    setViewGroupInput(instance.view_group_id ?? "");
  }, [instance.view_group_id]);
  useEffect(() => {
    setRenamePath(binding?.resource_id ?? "");
  }, [binding?.resource_id]);

  const commitDraft = async () => {
    if (!source || content == null || !localDirty) return;
    try {
      const next = await updateDraft(content, editorValue);
      setContent(next);
      setEditorValue(next.content);
      setLocalDirty(false);
    } catch (cause: unknown) {
      reportError(cause);
    }
  };
  const mode = instance.mode_id ?? (source ? "source" : "preview");
  const outline = editorValue.split("\n").flatMap((line, index) => {
    const match = line.match(/^\s*(?:#+\s+(.+)|([A-Za-z.][\w.]*)\s*<-\s*function\b)/u);
    return match == null ? [] : [{ line: index + 1, label: match[1] ?? match[2] ?? line.trim() }];
  });
  const markup = !source && content != null ? resourceMarkup(content) : null;

  return (
    <div className="rho-file-resource">
      <div className="rho-resource-toolbar">
        <span className={`rho-resource-state rho-resource-${descriptor?.status ?? "missing"}`}>
          {descriptor?.status ?? "unresolved"}
        </span>
        <code>{binding?.resource_id ?? "No Resource bound"}</code>
        {content?.dirty && <span className="rho-resource-dirty">unsaved</span>}
        {(content?.stale || staleBinding) && <span className="rho-resource-stale">stale</span>}
        <span>resource r{descriptor?.resource_revision ?? "—"}</span>
        {content != null && <span>document r{content.document_revision}</span>}
        {staleBinding && descriptor != null && (
          <button type="button" onClick={() => void refreshBinding(descriptor).catch(reportError)}>
            Refresh view
          </button>
        )}
      </div>
      <div className="rho-resource-linking">
        <label>View group <input value={viewGroup} onChange={(event) => setViewGroupInput(event.target.value)} placeholder="independent" /></label>
        <button type="button" onClick={() => void setViewGroup(viewGroup.trim() || null).catch(reportError)}>Apply</button>
        <label>Path <input value={renamePath} onChange={(event) => setRenamePath(event.target.value)} /></label>
        <button type="button" disabled={binding == null || renamePath === binding.resource_id} onClick={() => {
          void rename(content, renamePath).catch(reportError);
        }}>Rename</button>
        <button type="button" disabled={binding == null} onClick={() => {
          void removeResource(content, false).catch(reportError);
        }}>Delete</button>
        {content?.dirty && <button type="button" onClick={() => {
          void removeResource(content, true).catch(reportError);
        }}>Discard &amp; delete</button>}
      </div>
      {descriptor?.status === "missing" && <div className="rho-resource-placeholder">This Resource no longer exists. Its Surface placement remains.</div>}
      {descriptor?.status === "unsupported" && <div className="rho-resource-placeholder">No compatible provider claims this Resource.</div>}
      {error != null && <p className="rho-resource-error" role="alert">{error}</p>}
      {source && mode === "source" && descriptor?.status === "ready" && (
        <textarea
          className="rho-source-editor"
          aria-label={`Source ${binding?.resource_id ?? instance.instance_id}`}
          value={editorValue}
          onChange={(event) => { setEditorValue(event.target.value); setLocalDirty(true); }}
          onBlur={(event) => {
            void commitDraft();
            void persistViewState({
              cursor_start: event.currentTarget.selectionStart,
              cursor_end: event.currentTarget.selectionEnd,
              scroll_top: event.currentTarget.scrollTop,
            }).catch(reportError);
          }}
          ref={(element) => {
            if (element == null || document.activeElement === element) return;
            if (Math.abs(element.scrollTop - view.scrollTop) > 1) element.scrollTop = view.scrollTop;
          }}
          spellCheck={false}
        />
      )}
      {source && mode === "diff" && (
        <div className="rho-file-analysis"><strong>Working document</strong><p>{content?.dirty ? "The shared document differs from its disk revision." : "No unsaved difference."}</p><pre>{editorValue}</pre></div>
      )}
      {source && mode === "outline" && (
        <ol className="rho-file-outline">{outline.length === 0 ? <li>No structural symbols found.</li> : outline.map((item) => <li key={`${item.line}:${item.label}`}><span>{item.line}</span>{item.label}</li>)}</ol>
      )}
      {!source && content != null && (
        <div className="rho-file-preview-body">
          {markup?.image != null && <img src={markup.image} alt={content.descriptor.label} />}
          {markup?.html != null && <div className="rho-rendered-document" dangerouslySetInnerHTML={{ __html: markup.html }} />}
          {markup?.text != null && <pre>{markup.text}</pre>}
        </div>
      )}
      {source && content != null && (
        <div className="rho-resource-actions">
          <button type="button" disabled={!content.dirty || localDirty} onClick={() => {
            void save(content).then((next) => { setContent(next); setEditorValue(next.content); }).catch(reportError);
          }}>Save</button>
          <button type="button" onClick={() => {
            void reload(content, content.dirty).then((next) => { setContent(next); setEditorValue(next.content); setLocalDirty(false); }).catch(reportError);
          }}>{content.dirty ? "Discard & reload" : "Reload"}</button>
        </div>
      )}
    </div>
  );
}

function SurfaceView({
  instance, focused, setFocus, remove, duplicate, persistDraft, draftCache,
  runtimes, attachRuntime, detachRuntime, executeRuntime, interruptRuntime,
  restartRuntime, persistConsole, resources, readResource, updateResourceDraft,
  saveResource, reloadResource, renameResource, deleteResource,
  refreshResourceBinding, setViewGroup, persistFileViewState, reportError,
}: SurfaceViewProps) {
  const [draft, setDraft] = useState(() => initialDraft(instance, draftCache));
  const [consoleState, setConsoleState] = useState(() => initialConsoleState(instance));
  const [consoleRunning, setConsoleRunning] = useState(false);
  const runtime = instance.runtime_binding;
  const isStrip = instance.surface_id === "rho.status";
  const title = instance.surface_id === "rho.console" ? "R Console"
    : instance.surface_id === "rho.file-preview" ? "File preview"
    : instance.surface_id === "rho.file-source" ? "Source editor"
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
      {(instance.surface_id === "rho.file-source" || instance.surface_id === "rho.file-preview") && (
        <FileResourceView
          instance={instance}
          registry={resources}
          read={readResource}
          updateDraft={updateResourceDraft}
          save={saveResource}
          reload={reloadResource}
          rename={renameResource}
          removeResource={deleteResource}
          refreshBinding={refreshResourceBinding}
          setViewGroup={setViewGroup}
          persistViewState={persistFileViewState}
          reportError={reportError}
        />
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

function VibeBlock({
  content,
  instances,
  surfaceView,
}: {
  readonly content: VibeBlockContent;
  readonly instances: ReadonlyMap<string, SurfaceInstance>;
  readonly surfaceView: (instance: SurfaceInstance) => ReactNode;
}) {
  switch (content.kind) {
    case "rich_text":
      return <div className="rho-vibe-prose">{content.text}</div>;
    case "callout":
      return <aside className={`rho-vibe-callout rho-vibe-callout-${content.tone}`}>{content.text}</aside>;
    case "divider":
      return <hr className="rho-vibe-divider" />;
    case "file_excerpt":
      return <div className="rho-vibe-reference"><span>File excerpt</span><code>{content.resource.resource_id}:{content.start_line}–{content.end_line}</code></div>;
    case "artifact_ref":
      return <div className="rho-vibe-reference"><span>Artifact</span><strong>{content.label}</strong><code>{content.artifact_id}</code></div>;
    case "finding_ref":
      return <div className="rho-vibe-reference"><span>Finding</span><strong>{content.label}</strong><code>{content.finding_id}</code></div>;
    case "task_ref":
      return <div className="rho-vibe-reference"><span>Task</span><strong>{content.label}</strong><code>{content.task_id}</code></div>;
    case "command_ref":
      return <button className="rho-vibe-command" type="button"><span>Command</span><strong>{content.label}</strong><code>{content.command_id}</code></button>;
    case "surface_ref": {
      const instance = instances.get(content.instance_id);
      if (instance == null) {
        return <div className="rho-vibe-missing">Surface {content.instance_id} is unavailable. Its place in the Page is preserved.</div>;
      }
      return content.live
        ? <div className="rho-vibe-live-surface">{surfaceView(instance)}</div>
        : <div className="rho-vibe-reference"><span>Surface snapshot</span><code>{content.instance_id}</code></div>;
    }
  }
}

function VibeCanvas({
  page,
  instances,
  surfaceView,
}: {
  readonly page: VibePage;
  readonly instances: ReadonlyMap<string, SurfaceInstance>;
  readonly surfaceView: (instance: SurfaceInstance) => ReactNode;
}) {
  return (
    <article className="rho-vibe-page" data-page-id={page.page_id}>
      <header className="rho-vibe-page-header">
        <span className="rho-eyebrow">Vibe page</span>
        <h1>{page.label}</h1>
        <p>A persistent composition of narrative, evidence, commands, and live Surfaces.</p>
      </header>
      {page.sections.map((section) => (
        <section className="rho-vibe-section" data-layout={String(section.layout.kind ?? "flow")} key={section.section_id}>
          {section.heading != null && <h2>{section.heading}</h2>}
          <div className="rho-vibe-blocks">
            {section.blocks.map((block) => (
              <div className={`rho-vibe-block rho-vibe-block-${block.content.kind}`} key={block.block_id}>
                <VibeBlock content={block.content} instances={instances} surfaceView={surfaceView} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </article>
  );
}

export function App({ transport }: AppProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [resourcePath, setResourcePath] = useState("analysis.R");
  const [commandQuery, setCommandQuery] = useState("");
  const [commandSearchOpen, setCommandSearchOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const draftCache = useRef(new Map<string, string>()).current;
  const store = useMemo(() => transport == null ? defaultStore : new UiExternalStore(transport), [transport]);
  const surfaceStore = useMemo(() => transport == null ? defaultSurfaceStore : new SurfaceExternalStore(transport), [transport]);
  const studioStore = useMemo(() => transport == null ? defaultStudioStore : new StudioExternalStore(transport), [transport]);
  const runtimeStore = useMemo(() => transport == null ? defaultRuntimeStore : new RuntimeExternalStore(transport), [transport]);
  const resourceStore = useMemo(() => transport == null ? defaultResourceStore : new ResourceExternalStore(transport), [transport]);
  const profileStore = useMemo(() => transport == null ? defaultProfileStore : new UiProfileExternalStore(transport), [transport]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const surfaceState = useSyncExternalStore(surfaceStore.subscribe, surfaceStore.getSnapshot, surfaceStore.getSnapshot);
  const studioState = useSyncExternalStore(studioStore.subscribe, studioStore.getSnapshot, studioStore.getSnapshot);
  const runtimeState = useSyncExternalStore(runtimeStore.subscribe, runtimeStore.getSnapshot, runtimeStore.getSnapshot);
  const resourceState = useSyncExternalStore(resourceStore.subscribe, resourceStore.getSnapshot, resourceStore.getSnapshot);
  const profileState = useSyncExternalStore(profileStore.subscribe, profileStore.getSnapshot, profileStore.getSnapshot);
  const snapshot = state.status === "ready" ? state.snapshot : null;
  const surfaces = surfaceState.status === "ready" ? surfaceState.snapshot : null;
  const studio = studioState.status === "ready" ? studioState.snapshot : null;
  const runtimes = runtimeState.status === "ready" ? runtimeState.snapshot : null;
  const resources = resourceState.status === "ready" ? resourceState.snapshot : null;
  const profileSnapshot = profileState.status === "ready" ? profileState.snapshot : null;
  const profile = profileSnapshot?.profile ?? null;
  useEffect(() => {
    if (profile?.active_mode === "vibe") setInspectorOpen(false);
  }, [profile?.active_mode]);
  const instances = useMemo(() => new Map(surfaces?.catalog.instances.map((instance) => [instance.instance_id, instance]) ?? []), [surfaces]);
  const primaryCommands = useMemo(() => snapshot == null ? [] : commandsForPlacement(snapshot, "primary_candidate"), [snapshot]);
  const paletteCommands = useMemo(() => snapshot == null ? [] : commandsForPlacement(snapshot, "palette").filter((command) => {
    const query = commandQuery.trim().toLocaleLowerCase();
    return query.length === 0 || command.definition.label.toLocaleLowerCase().includes(query) ||
      command.definition.command_id.toLocaleLowerCase().includes(query);
  }), [commandQuery, snapshot]);
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
  const profileRevisionRequest = () => profile == null ? null : {
    project_id: profile.project_id,
    expected_profile_revision: profile.revision,
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
  const openResource = async (
    descriptor: ResourceDescriptor,
    surfaceId: "rho.file-source" | "rho.file-preview",
    modeId: "source" | "preview" | "diff" | "outline",
  ) => {
    if (surfaces == null || studio == null) return;
    if (descriptor.status !== "ready") {
      throw new Error(`Resource ${descriptor.resource_id} is ${descriptor.status}.`);
    }
    const before = new Set(surfaces.catalog.instances.map((candidate) => candidate.instance_id));
    const opened = await surfaceStore.open({
      surface_id: surfaceId,
      project_id: surfaces.project_id,
      mode_id: modeId,
      resource_binding: {
        resource_provider_id: descriptor.resource_provider_id,
        resource_kind: descriptor.resource_kind,
        resource_id: descriptor.resource_id,
        resource_revision: descriptor.resource_revision,
      },
      runtime_binding: null,
      view_group_id: null,
      view_state: { cursor_start: 0, cursor_end: 0, scroll_top: 0 },
      instance_disposition: "new_instance",
      placement_intent: "beside",
      expected_project_revision: surfaces.project_revision,
      expected_layout_revision: studio.scene.layout_revision,
    });
    const created = opened.catalog.instances.find((candidate) => !before.has(candidate.instance_id));
    if (created == null) throw new Error("Surface Runtime did not return the new file view.");
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
  const surfaceView = (instance: SurfaceInstance) => {
    const boundDescriptor = resources?.resources.find((descriptor) =>
      descriptor.resource_provider_id === instance.resource_binding?.resource_provider_id &&
      descriptor.resource_kind === instance.resource_binding?.resource_kind &&
      descriptor.resource_id === instance.resource_binding.resource_id
    ) ?? null;
    return <SurfaceView
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
      resources={resources}
      readResource={async (descriptor, consistency, resourceRevision) => {
        if (resources == null) throw new Error("Resource Registry is not ready.");
        return resourceStore.read({
          target: resourceTarget(descriptor, resources.project_revision, resourceRevision),
          consistency,
        });
      }}
      updateResourceDraft={async (content, value) => {
        if (resources == null) throw new Error("Resource Registry is not ready.");
        return resourceStore.updateDraft({
          target: resourceTarget(content.descriptor, resources.project_revision),
          expected_document_revision: content.document_revision,
          content: value,
        });
      }}
      saveResource={async (content) => {
        if (resources == null) throw new Error("Resource Registry is not ready.");
        return resourceStore.save({
          target: resourceTarget(content.descriptor, resources.project_revision),
          expected_document_revision: content.document_revision,
        });
      }}
      reloadResource={async (content, discardDirty) => {
        if (resources == null) throw new Error("Resource Registry is not ready.");
        return resourceStore.reload({
          target: resourceTarget(content.descriptor, resources.project_revision),
          expected_document_revision: content.document_revision,
          discard_dirty: discardDirty,
        });
      }}
      renameResource={async (content, nextId) => {
        if (resources == null || boundDescriptor == null) {
          throw new Error("Bound Resource is unavailable.");
        }
        await resourceStore.rename({
          target: resourceTarget(boundDescriptor, resources.project_revision),
          expected_document_revision: content?.document_revision ?? null,
          new_resource_id: nextId,
        });
        await surfaceStore.refresh();
      }}
      deleteResource={async (content, discardDirty) => {
        if (resources == null || boundDescriptor == null) {
          throw new Error("Bound Resource is unavailable.");
        }
        await resourceStore.delete({
          target: resourceTarget(boundDescriptor, resources.project_revision),
          expected_document_revision: content?.document_revision ?? null,
          discard_dirty: discardDirty,
        });
      }}
      refreshResourceBinding={async (descriptor) => {
        if (surfaces == null) throw new Error("Surface Runtime is not ready.");
        await surfaceStore.update({
          target: instanceRequest(instance, surfaces.project_revision),
          mutation: {
            kind: "bind_resource",
            binding: {
              resource_provider_id: descriptor.resource_provider_id,
              resource_kind: descriptor.resource_kind,
              resource_id: descriptor.resource_id,
              resource_revision: descriptor.resource_revision,
            },
          },
        });
      }}
      setViewGroup={async (viewGroupId) => {
        if (surfaces == null) throw new Error("Surface Runtime is not ready.");
        await surfaceStore.update({
          target: instanceRequest(instance, surfaces.project_revision),
          mutation: { kind: "set_view_group", view_group_id: viewGroupId },
        });
      }}
      persistFileViewState={async (viewState) => {
        if (surfaces == null) throw new Error("Surface Runtime is not ready.");
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
    />;
  };
  const activeVibePage = profile?.vibe_pages.find(
    (page) => page.page_id === profile.active_vibe_page_id,
  ) ?? null;
  const evidence = useMemo(() => ({
    ready: snapshot != null && surfaces != null && studio != null && runtimes != null && resources != null && profile != null,
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
    resourceInstances: resources?.resources.map((resource) => ({
      id: resource.resource_id,
      revision: resource.resource_revision,
      status: resource.status,
    })) ?? [],
    profileRevision: profile?.revision ?? null,
    activeMode: profile?.active_mode ?? null,
    activeScene: profile?.active_studio_scene_id ?? null,
    activePage: profile?.active_vibe_page_id ?? null,
    profileLoadStatus: profileSnapshot?.load_status ?? null,
  }), [instances, profile, profileSnapshot, resources, runtimes, snapshot, state, studio, surfaces]);
  useEffect(() => {
    document.documentElement.dataset.rsrReady = String(evidence.ready);
  }, [evidence.ready]);

  return (
    <main className="rho-studio-shell">
      <header className="rho-studio-bar">
        <div className="rho-mark" aria-label="Rho"><span className="rho-mark-glyph">R</span><span>Rho</span></div>
        <div className="rho-project-identity"><span className="rho-eyebrow">Project</span><strong>{snapshot?.project.display_label ?? "Loading…"}</strong></div>
        <div className="rho-mode-switch" aria-label="Workspace mode">
          {(["studio", "vibe"] as const).map((mode) => (
            <button
              type="button"
              aria-pressed={profile?.active_mode === mode}
              disabled={profile == null}
              key={mode}
              onClick={() => {
                const target = profileRevisionRequest();
                if (target != null && profile?.active_mode !== mode) {
                  run(profileStore.setMode({ target, mode }));
                }
              }}
            >{mode === "studio" ? "Studio" : "Vibe"}</button>
          ))}
        </div>
        <div className="rho-profile-context">
          {profile?.active_mode === "vibe" ? (
            <select
              aria-label="Active Vibe Page"
              value={profile.active_vibe_page_id ?? ""}
              onChange={(event) => {
                const target = profileRevisionRequest();
                if (target != null) run(profileStore.selectPage({ target, page_id: event.target.value }));
              }}
            >{profile.vibe_pages.map((page) => <option value={page.page_id} key={page.page_id}>{page.label}</option>)}</select>
          ) : (
            <select
              aria-label="Active Studio Scene"
              value={profile?.active_studio_scene_id ?? ""}
              onChange={(event) => {
                const target = profileRevisionRequest();
                if (target != null) run(profileStore.selectScene({ target, scene_id: event.target.value }));
              }}
            >{profile?.studio_scenes.map((scene) => <option value={scene.scene_id} key={scene.scene_id}>{scene.label}</option>)}</select>
          )}
          {profile?.active_mode !== "vibe" && (
            <details className="rho-scene-menu">
              <summary aria-label="Scene actions">•••</summary>
              <div>
                <button type="button" disabled={profile == null || studio == null} onClick={() => {
                  const target = profileRevisionRequest();
                  const scene = profile?.studio_scenes.find((candidate) => candidate.scene_id === profile.active_studio_scene_id);
                  if (target != null && scene != null) run(profileStore.duplicateScene({ target, scene_id: scene.scene_id, label: `${scene.label} copy` }));
                }}>Duplicate</button>
                <button type="button" disabled={profile == null || studio == null} onClick={() => {
                  const target = profileRevisionRequest();
                  if (target != null && profile?.active_studio_scene_id != null) run(profileStore.saveScene({ target, scene_id: profile.active_studio_scene_id }));
                }}>Save</button>
                <button type="button" disabled={profile == null} onClick={() => {
                  const target = profileRevisionRequest();
                  const scene = profile?.studio_scenes.find((candidate) => candidate.scene_id === profile.active_studio_scene_id);
                  const label = scene == null ? null : window.prompt("Scene name", scene.label)?.trim();
                  if (target != null && scene != null && label) run(profileStore.renameScene({ target, scene_id: scene.scene_id, label }));
                }}>Rename</button>
                <button type="button" disabled={(profile?.studio_scenes.length ?? 0) < 2} onClick={() => {
                  const target = profileRevisionRequest();
                  if (target != null && profile?.active_studio_scene_id != null) run(profileStore.deleteScene({ target, scene_id: profile.active_studio_scene_id }));
                }}>Delete</button>
                <button type="button" disabled={profile == null} onClick={() => {
                  const target = profileRevisionRequest();
                  if (target != null && profile?.active_studio_scene_id != null) run(profileStore.resetScene({ target, scene_id: profile.active_studio_scene_id }));
                }}>Reset to Rho Studio</button>
                <span className="rho-menu-separator" />
                <button type="button" disabled={!studio?.can_undo} onClick={() => { const request = revisionRequest(); if (request != null) run(studioStore.undo(request)); }}>Undo</button>
                <button type="button" disabled={!studio?.can_redo} onClick={() => { const request = revisionRequest(); if (request != null) run(studioStore.redo(request)); }}>Redo</button>
              </div>
            </details>
          )}
        </div>
        <div className="rho-command-search">
          <input
            aria-label="Search commands"
            placeholder="Search commands…"
            value={commandQuery}
            onChange={(event) => setCommandQuery(event.target.value)}
            onFocus={() => setCommandSearchOpen(true)}
            onBlur={() => window.setTimeout(() => setCommandSearchOpen(false), 120)}
          />
          <span className="rho-command-count">{snapshot?.command_registry.registrations.length ?? 0} commands</span>
          {commandSearchOpen && (
            <div className="rho-command-results" role="listbox">
              {paletteCommands.slice(0, 8).map((command) => (
                <button type="button" role="option" disabled={command.availability.state !== "available"} key={command.definition.command_id}>
                  <strong>{command.definition.label}</strong><code>{command.definition.command_id}</code>
                </button>
              ))}
              {paletteCommands.length === 0 && <p>No matching command</p>}
            </div>
          )}
        </div>
        <div className="rho-command-projection" aria-label="Primary contextual command">
          {primaryCommands.filter((command) => command.availability.state === "available").slice(0, 1).map((command) => <span key={command.definition.command_id}>{command.definition.label}</span>)}
        </div>
        <div className="rho-foundation-status"><span className={`rho-status-dot rho-status-${snapshot?.context.workspace_health ?? state.status}`} /><span>{snapshot?.health.workspace.label ?? "Connecting"}</span></div>
        <button className="rho-primary-action" type="button" aria-pressed={inspectorOpen} onClick={() => setInspectorOpen((open) => !open)}>{inspectorOpen ? "Done" : "Compose"}</button>
      </header>
      <div className={`rho-studio-workspace ${inspectorOpen ? "rho-inspector-open" : "rho-inspector-closed"}`}>
        {inspectorOpen && <aside className="rho-studio-inspector">
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
          {resources != null && (
            <section className="rho-resource-inventory">
              <div className="rho-resource-inventory-heading">
                <span className="rho-eyebrow">Resource registry</span>
                <span>{resources.resources.length} resolved</span>
              </div>
              <form onSubmit={(event) => {
                event.preventDefault();
                const provider = resources.providers.find((candidate) =>
                  candidate.definition.resource_kinds.includes("project_file")
                );
                if (provider == null) return;
                run(resourceStore.resolve({
                  project_id: resources.project_id,
                  resource_provider_id: provider.definition.resource_provider_id,
                  resource_kind: "project_file",
                  resource_id: resourcePath,
                  expected_project_revision: resources.project_revision,
                  expected_snapshot_revision: resources.snapshot_revision,
                }));
              }}>
                <input aria-label="Resolve project Resource" value={resourcePath} onChange={(event) => setResourcePath(event.target.value)} />
                <button type="submit">Resolve</button>
              </form>
              {resources.resources.map((resource) => (
                <article className="rho-resource-card" data-resource-id={resource.resource_id} key={`${resource.resource_provider_id}:${resource.resource_id}`}>
                  <div>
                    <span className={`rho-resource-dot rho-resource-${resource.status}`} />
                    <strong>{resource.label}</strong>
                    <small>{resource.resource_id} · r{resource.resource_revision}</small>
                  </div>
                  <div className="rho-resource-open-actions">
                    <button type="button" disabled={resource.status !== "ready" || !resource.capabilities.includes("resource.read.document")} onClick={() => run(openResource(resource, "rho.file-source", "source"))}>Source</button>
                    <button type="button" disabled={resource.status !== "ready" || !resource.capabilities.includes("resource.preview")} onClick={() => run(openResource(resource, "rho.file-preview", "preview"))}>Preview</button>
                    <button type="button" disabled={resource.status !== "ready" || !resource.capabilities.includes("resource.read.document")} onClick={() => run(openResource(resource, "rho.file-source", "diff"))}>Diff</button>
                    <button type="button" disabled={resource.status !== "ready" || !resource.capabilities.includes("resource.read.document")} onClick={() => run(openResource(resource, "rho.file-source", "outline"))}>Outline</button>
                  </div>
                </article>
              ))}
            </section>
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
        </aside>}
        <section className={`rho-studio-canvas rho-canvas-${profile?.active_mode ?? "loading"}`} aria-label={profile?.active_mode === "vibe" ? "Vibe page canvas" : "Studio layout canvas"}>
          {state.status === "failed" && <p role="alert">{state.message}</p>}
          {surfaceState.status === "failed" && <p role="alert">{surfaceState.message}</p>}
          {studioState.status === "failed" && <p role="alert">{studioState.message}</p>}
          {runtimeState.status === "failed" && <p role="alert">{runtimeState.message}</p>}
          {resourceState.status === "failed" && <p role="alert">{resourceState.message}</p>}
          {profileState.status === "failed" && <p role="alert">{profileState.message}</p>}
          {profileSnapshot?.recovery_detail != null && (
            <div className="rho-profile-recovery" role="status">
              <div><strong>UI Profile recovered from backup</strong><code>{profileSnapshot.recovery_detail}</code></div>
              <button type="button" onClick={() => void navigator.clipboard?.writeText(profileSnapshot.recovery_detail ?? "")}>Copy diagnostics</button>
            </div>
          )}
          {actionError != null && <p className="rho-action-error" role="alert">{actionError}</p>}
          {profile == null || surfaces == null || studio == null
            ? <div className="rho-studio-loading">Loading the project UI Profile…</div>
            : profile.active_mode === "vibe"
              ? activeVibePage == null
                ? <div className="rho-studio-loading">The active Vibe Page is unavailable.</div>
                : <VibeCanvas page={activeVibePage} instances={instances} surfaceView={surfaceView} />
              : <LayoutTree node={studio.scene.root} instances={instances} studio={studio} commit={commit} surfaceView={surfaceView} />}
        </section>
      </div>
      <pre id="rsrPreviewEvidence" hidden>{JSON.stringify(evidence)}</pre>
    </main>
  );
}
