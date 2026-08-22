import {
  useCallback,
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
  AgentConversationSummary,
  AgentFileMutationResponse,
  AgentMode,
  AgentRuntimeDiagnostics,
  AgentTurnDetail,
  AgentTurnSummary,
  CheckEvidence,
  CheckResult,
  DomainSurfaceData,
  LayoutAxis,
  LayoutBasis,
  LayoutChild,
  LayoutNode,
  PluginSurfaceBlock,
  PluginSurfaceDocumentRequest,
  PluginSurfaceEventKind,
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
  SurfaceFactoryRegistration,
  SurfaceInstanceRequest,
  UiKernelTransport,
  WorkspacePreparation,
} from "../transport";
import { VibePageEditor } from "./VibePageEditor";
import { SourceEditor } from "./SourceEditor";
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

type PreparationState =
  | { readonly status: "preparing" }
  | { readonly status: "ready"; readonly result: WorkspacePreparation }
  | { readonly status: "needs_attention"; readonly result: WorkspacePreparation };

export function App({ transport }: AppProps) {
  const resolvedTransport = transport ?? defaultTransport;
  const [preparation, setPreparation] = useState<PreparationState>({ status: "preparing" });
  const generation = useRef(0);
  const prepare = useCallback((chooseRscript = false) => {
    const currentGeneration = generation.current + 1;
    generation.current = currentGeneration;
    setPreparation({ status: "preparing" });
    void resolvedTransport.prepareWorkspace(chooseRscript).then((result) => {
      if (generation.current !== currentGeneration) return;
      setPreparation(result.status === "ready"
        ? { status: "ready", result }
        : { status: "needs_attention", result });
    }).catch((error: unknown) => {
      if (generation.current !== currentGeneration) return;
      const detail = error instanceof Error ? error.message : String(error);
      setPreparation({
        status: "needs_attention",
        result: {
          status: "needs_attention",
          phase: "preparation_failed",
          workspace_ready: false,
          restored_project_status: null,
          issue: {
            code: "PREPARATION_FAILED",
            title: "Rho could not prepare the workspace",
            message: "Retry startup or select a valid Rscript executable.",
            technical_detail: detail.slice(0, 2_048),
          },
        },
      });
    });
  }, [resolvedTransport]);
  useEffect(() => {
    prepare();
    return () => { generation.current += 1; };
  }, [prepare]);
  useEffect(() => {
    if (preparation.status !== "ready") {
      document.documentElement.dataset.rsrReady = "false";
    }
  }, [preparation.status]);

  if (preparation.status === "preparing") {
    return (
      <main className="rho-preparation-shell" aria-busy="true">
        <section className="rho-preparation-card">
          <div className="rho-mark" aria-label="Rho"><span className="rho-mark-glyph">R</span><span>Rho</span></div>
          <span className="rho-preparation-spinner" aria-hidden="true" />
          <div><strong>Preparing the project runtime</strong><p>Starting Workspace R, restoring the project, and reconciling its Surfaces…</p></div>
        </section>
      </main>
    );
  }
  if (preparation.status === "needs_attention") {
    const issue = preparation.result.issue;
    return (
      <main className="rho-preparation-shell">
        <section className="rho-preparation-card rho-preparation-issue" role="alert">
          <div className="rho-mark" aria-label="Rho"><span className="rho-mark-glyph">R</span><span>Rho</span></div>
          <div>
            <span className="rho-eyebrow">{issue?.code ?? preparation.result.phase}</span>
            <h1>{issue?.title ?? "The project runtime needs attention"}</h1>
            <p>{issue?.message ?? "Retry startup to continue."}</p>
            {issue?.technical_detail != null && <details><summary>Technical details</summary><pre>{issue.technical_detail}</pre></details>}
            <div className="rho-preparation-actions">
              <button type="button" onClick={() => prepare()}>Retry</button>
              <button type="button" onClick={() => prepare(true)}>Choose Rscript</button>
            </div>
          </div>
        </section>
      </main>
    );
  }
  return <WorkbenchApp transport={resolvedTransport} />;
}

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
  const handle = useRef<HTMLButtonElement>(null);
  const [logicalValue, setLogicalValue] = useState<number | null>(null);
  const [logicalMaximum, setLogicalMaximum] = useState<number | null>(null);
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
      ref={handle}
      className={`rho-resize-handle rho-resize-${axis}`}
      type="button"
      role="separator"
      aria-orientation={axis === "horizontal" ? "vertical" : "horizontal"}
      aria-valuemin={56}
      aria-valuemax={logicalMaximum == null ? undefined : Math.round(logicalMaximum)}
      aria-valuenow={logicalValue == null ? undefined : Math.round(logicalValue)}
      aria-valuetext={logicalValue == null ? "Focus to measure this boundary" : `${Math.round(logicalValue)} logical pixels before the boundary`}
      aria-label={`Resize boundary ${beforeIndex + 1}`}
      onFocus={() => {
        const beforeElement = handle.current?.previousElementSibling as HTMLElement | null;
        const afterElement = handle.current?.nextElementSibling as HTMLElement | null;
        if (beforeElement != null && afterElement != null) {
          const before = extentOf(beforeElement);
          const after = extentOf(afterElement);
          setLogicalValue(before);
          setLogicalMaximum(Math.max(56, before + after - 56));
        }
      }}
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
        const before = extentOf(current.beforeElement);
        const after = extentOf(current.afterElement);
        setLogicalValue(before);
        setLogicalMaximum(Math.max(56, before + after - 56));
        commit(boundaryEdit(before, after));
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
        const beforeElement = event.currentTarget.previousElementSibling as HTMLElement | null;
        const afterElement = event.currentTarget.nextElementSibling as HTMLElement | null;
        if (beforeElement == null || afterElement == null) return;
        const before = extentOf(beforeElement);
        const after = extentOf(afterElement);
        const step = event.shiftKey ? 64 : 16;
        const delta = event.key === "Home" ? -before + 56
          : event.key === "End" ? after - 56
          : event.key === "PageUp" ? -64
          : event.key === "PageDown" ? 64
          : axis === "horizontal"
            ? event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0
            : event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        if (delta === 0) return;
        event.preventDefault();
        const clamped = Math.max(-before + 56, Math.min(after - 56, delta));
        const nextBefore = before + clamped;
        setLogicalValue(nextBefore);
        setLogicalMaximum(Math.max(56, before + after - 56));
        commit(boundaryEdit(nextBefore, after - clamped));
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
  readonly suspend: () => Promise<void>;
  readonly resume: () => Promise<void>;
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
  readonly pluginTransport: UiKernelTransport;
  readonly pluginDocumentRequest: PluginSurfaceDocumentRequest | null;
  readonly projectRevision: number;
  readonly openCheckEvidence: (path: string) => Promise<void>;
  readonly agentHealth: { readonly state: string; readonly label: string; readonly detail: string | null } | null;
  readonly persistAgentViewState: (viewState: AgentSurfaceViewState) => Promise<void>;
  readonly persistSurfaceViewState: (viewState: unknown) => Promise<void>;
  readonly pinAgentTask: (turn: AgentTurnSummary) => Promise<void>;
  readonly applyAgentFileProposal: (
    turn: AgentTurnSummary,
    eventId: number,
    proposal: AgentFileProposal,
  ) => Promise<{ readonly response: AgentFileMutationResponse; readonly beforeContent: string }>;
  readonly undoAgentFileProposal: (request: AgentFileUndoState) => Promise<void>;
  readonly embedded: boolean;
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
        <SourceEditor
          ariaLabel={`Source ${binding?.resource_id ?? instance.instance_id}`}
          value={editorValue}
          viewState={{
            cursor_start: view.cursorStart,
            cursor_end: view.cursorEnd,
            scroll_top: view.scrollTop,
          }}
          onChange={(value) => { setEditorValue(value); setLocalDirty(true); }}
          onBlur={(nextView) => {
            void commitDraft();
            void persistViewState(nextView).catch(reportError);
          }}
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

function PluginField({
  block,
  dispatch,
}: {
  readonly block: Extract<PluginSurfaceBlock, { kind: "field" }>;
  readonly dispatch: (controlId: string, kind: PluginSurfaceEventKind, value: string) => void;
}) {
  const [value, setValue] = useState(block.value);
  useEffect(() => setValue(block.value), [block.value]);
  return (
    <label className="rho-plugin-field">
      <span>{block.label}</span>
      <input
        value={value}
        placeholder={block.placeholder ?? ""}
        disabled={block.disabled || block.busy}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          if (value !== block.value) dispatch(block.control_id, "change", value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") dispatch(block.control_id, "submit", value);
        }}
      />
    </label>
  );
}

function PluginSurfaceBlocks({
  blocks,
  dispatch,
  path = "root",
}: {
  readonly blocks: readonly PluginSurfaceBlock[];
  readonly dispatch: (controlId: string, kind: PluginSurfaceEventKind, value: string) => void;
  readonly path?: string;
}) {
  return <>{blocks.map((block, index) => {
    const key = `${path}:${index}:${block.kind}`;
    switch (block.kind) {
      case "row":
      case "column":
        return <div className={`rho-plugin-${block.kind}`} key={key}><PluginSurfaceBlocks blocks={block.blocks} dispatch={dispatch} path={key} /></div>;
      case "grid":
        return <div className="rho-plugin-grid" style={{ gridTemplateColumns: `repeat(${block.columns}, minmax(0, 1fr))` }} key={key}>{block.blocks.map((item, itemIndex) => <div style={{ gridColumn: `span ${item.column_span}` }} key={`${key}:${itemIndex}`}><PluginSurfaceBlocks blocks={[item.block]} dispatch={dispatch} path={`${key}:${itemIndex}`} /></div>)}</div>;
      case "tabs": {
        const active = block.tabs.find((tab) => tab.tab_id === block.active_tab_id) ?? block.tabs[0];
        return <section className="rho-plugin-tabs" key={key}><div role="tablist">{block.tabs.map((tab) => <span role="tab" aria-selected={tab.tab_id === active?.tab_id} key={tab.tab_id}>{tab.label}</span>)}</div>{active != null && <PluginSurfaceBlocks blocks={active.blocks} dispatch={dispatch} path={`${key}:${active.tab_id}`} />}</section>;
      }
      case "group":
        return <section className="rho-plugin-group" key={key}>{block.label != null && <h4>{block.label}</h4>}<PluginSurfaceBlocks blocks={block.blocks} dispatch={dispatch} path={key} /></section>;
      case "text": return <p className="rho-plugin-text" dir="auto" key={key}>{block.text}</p>;
      case "code": return <pre className="rho-plugin-code" dir="auto" data-language={block.language ?? undefined} key={key}><code>{block.code}</code></pre>;
      case "key_value": return <dl className="rho-plugin-key-value" key={key}>{block.items.map((item, itemIndex) => <div dir="auto" key={`${key}:${itemIndex}`}><dt>{item.key}</dt><dd>{item.value}</dd></div>)}</dl>;
      case "table": return <div className="rho-plugin-table-wrap" key={key}><table><thead><tr>{block.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={`${key}:${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${key}:${rowIndex}:${cellIndex}`}>{cell}</td>)}</tr>)}</tbody></table></div>;
      case "notice": return <div className={`rho-plugin-notice rho-plugin-notice-${block.tone}`} role="status" key={key}>{block.text}</div>;
      case "artifact_image_ref": return <figure className="rho-plugin-artifact" key={key}><div aria-hidden="true">Artifact image</div><figcaption>{block.alt} · <code>{block.artifact_id}</code></figcaption></figure>;
      case "field": return <PluginField block={block} dispatch={dispatch} key={key} />;
      case "select": return <label className="rho-plugin-field" key={key}><span>{block.label}</span><select value={block.value} disabled={block.disabled || block.busy} onChange={(event) => dispatch(block.control_id, "change", event.target.value)}>{block.options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>;
      case "command_button": return <button className="rho-plugin-command" type="button" disabled={block.disabled || block.busy} onClick={() => dispatch(block.control_id, "activate", "")} key={key}>{block.label}</button>;
    }
  })}</>;
}

function PluginSurfaceView({
  request,
  transport,
  reportError,
}: {
  readonly request: PluginSurfaceDocumentRequest;
  readonly transport: UiKernelTransport;
  readonly reportError: (error: unknown) => void;
}) {
  const [document, setDocument] = useState<Awaited<ReturnType<UiKernelTransport["loadPluginSurfaceDocument"]>>["document"] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "busy" | "failed">("loading");
  const load = () => {
    setStatus((current) => current === "busy" ? current : "loading");
    void transport.loadPluginSurfaceDocument(request).then((view) => {
      setDocument(view.document);
      setStatus("ready");
    }).catch((error: unknown) => {
      setStatus("failed");
      reportError(error);
    });
  };
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (active) load();
    };
    refresh();
    const unsubscribe = transport.subscribePluginSurfacesInvalidated(refresh);
    return () => { active = false; unsubscribe(); };
  }, [
    request.target.instance_id,
    request.target.expected_project_revision,
    request.target.expected_surface_revision,
    request.expected_layout_revision,
    request.expected_page_revision,
    transport,
  ]);
  const dispatch = (controlId: string, eventKind: PluginSurfaceEventKind, value: string) => {
    if (document == null || status === "busy") return;
    setStatus("busy");
    void transport.dispatchPluginSurfaceEvent({
      ...request,
      expected_document_revision: document.revision,
      control_id: controlId,
      event_kind: eventKind,
      value,
    }).then((result) => {
      if (result.document != null) setDocument(result.document);
      setStatus(result.status === "queued" ? "loading" : "ready");
    }).catch((error: unknown) => {
      setStatus("failed");
      reportError(error);
    });
  };
  if (document == null) return <div className={`rho-plugin-surface-state rho-plugin-surface-${status}`}>{status === "failed" ? "Plugin Surface unavailable" : "Loading plugin Surface…"}</div>;
  return <section className={`rho-plugin-surface-document rho-plugin-surface-${status}`} aria-busy={status === "busy"}><header><span>Workspace plugin</span><strong>{document.title}</strong><small>document r{document.revision}</small></header><PluginSurfaceBlocks blocks={document.blocks} dispatch={dispatch} /></section>;
}

function checkResultId(instance: SurfaceInstance): string | null {
  if (typeof instance.view_state !== "object" || instance.view_state == null) return null;
  const value = (instance.view_state as Record<string, unknown>).check_result_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function checkOriginLabel(finding: CheckResult["findings"][number]): string {
  if (finding.origin.kind === "application") return "Rho core";
  return `Workspace rule pack · ${finding.origin.plugin_id} · g${finding.activation_generation}`;
}

function evidenceLabel(evidence: CheckEvidence): string {
  switch (evidence.kind) {
    case "source_range": return `${evidence.path}:${evidence.line}${evidence.column == null ? "" : `:${evidence.column}`}`;
    case "project_file": return evidence.path;
    case "run_ref": return `Run ${evidence.run_id}`;
    case "environment_ref": return `Environment ${evidence.snapshot_id}`;
    case "note": return evidence.text;
  }
}

function CheckResultView({
  instance,
  projectRevision,
  transport,
  openEvidence,
  reportError,
}: {
  readonly instance: SurfaceInstance;
  readonly projectRevision: number;
  readonly transport: UiKernelTransport;
  readonly openEvidence: (path: string) => Promise<void>;
  readonly reportError: (error: unknown) => void;
}) {
  const resultId = checkResultId(instance);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [status, setStatus] = useState<"empty" | "loading" | "ready" | "failed">(
    resultId == null ? "empty" : "loading",
  );
  useEffect(() => {
    if (resultId == null) {
      setResult(null);
      setStatus("empty");
      return;
    }
    let active = true;
    const load = () => {
      setStatus("loading");
      void transport.loadCheckResult({
        project_id: instance.project_id,
        expected_project_revision: projectRevision,
        result_id: resultId,
      }).then((next) => {
        if (!active) return;
        setResult(next);
        setStatus("ready");
      }).catch((error: unknown) => {
        if (!active) return;
        setStatus("failed");
        reportError(error);
      });
    };
    load();
    const unsubscribe = transport.subscribeCheckResultsInvalidated(load);
    return () => { active = false; unsubscribe(); };
  }, [instance.project_id, projectRevision, reportError, resultId, transport]);
  if (status === "empty") {
    return <div className="rho-check-empty">Run <strong>Check project</strong> to create an immutable result.</div>;
  }
  if (result == null) {
    return <div className={`rho-check-empty rho-check-${status}`}>{status === "failed" ? "This Check result is no longer available. Run Check project again." : "Loading Check result…"}</div>;
  }
  return (
    <section className="rho-check-result" data-result-id={result.result_id}>
      <header className="rho-check-summary">
        <div><span className={`rho-check-status rho-check-status-${result.status}`}>{result.status}</span><strong>{result.findings.length} findings</strong></div>
        <dl>
          <div><dt>Files</dt><dd>{result.coverage.files_scanned}</dd></div>
          <div><dt>Core rules</dt><dd>{result.coverage.core_rules}</dd></div>
          <div><dt>Rule packs</dt><dd>{result.coverage.plugin_rule_packs}</dd></div>
        </dl>
        <small>Snapshot <code>{result.snapshot.snapshot_id}</code> · {result.generated_at}</small>
      </header>
      {result.limitations.length > 0 && <div className="rho-check-limitations" role="status"><strong>Coverage limitations</strong>{result.limitations.map((item) => <p key={item}>{item}</p>)}</div>}
      <div className="rho-check-findings">
        {result.findings.map((finding, index) => (
          <article className={`rho-check-finding rho-check-finding-${finding.severity}`} key={`${finding.rule_id}:${index}`}>
            <header><span>{finding.category}</span><span>{checkOriginLabel(finding)}</span></header>
            <h3>{finding.title}</h3>
            <p>{finding.summary}</p>
            <div className="rho-check-remediation"><strong>What to do</strong><span>{finding.remediation}</span></div>
            <div className="rho-check-evidence">
              {finding.evidence.map((evidence, evidenceIndex) => {
                const path = evidence.kind === "source_range" || evidence.kind === "project_file" ? evidence.path : null;
                return path == null
                  ? <span key={evidenceIndex}>{evidenceLabel(evidence)}</span>
                  : <button type="button" onClick={() => void openEvidence(path).catch(reportError)} key={evidenceIndex}>{evidenceLabel(evidence)}</button>;
              })}
            </div>
            <footer><code>{finding.rule_id}</code><span>v{finding.rule_version}</span></footer>
          </article>
        ))}
        {result.findings.length === 0 && <div className="rho-check-clean">No findings in this captured project revision.</div>}
      </div>
    </section>
  );
}

interface AgentSurfaceViewState {
  readonly conversation_id: string | null;
  readonly mode: AgentMode;
  readonly composer: string;
  readonly auto_approve: boolean;
  readonly file_decisions: Readonly<Record<string, "rejected">>;
}

interface AgentFileProposal {
  readonly path: string;
  readonly operation: "replace_selection" | "insert_at_cursor" | "append" | "create";
  readonly content: string;
}

interface AgentFileUndoState {
  readonly turn_id: string;
  readonly proposal_event_id: number;
  readonly path: string;
  readonly expected_after_sha256: string;
  readonly before_content: string;
  readonly created: boolean;
}

function parseAgentFileProposal(event: AgentTurnDetail["events"][number]): AgentFileProposal | null {
  if (event.event_type !== "tool.call_completed" || event.tool !== "propose_file_edit") return null;
  const parse = (value: string | null) => {
    if (value == null) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed != null ? parsed as Record<string, unknown> : null;
    } catch { return null; }
  };
  let proposal = parse(event.body);
  if (proposal?.kind !== "rho.file_edit_proposal") {
    const details = parse(event.details_json);
    const argumentsValue = details?.success === true && typeof details.arguments === "object" && details.arguments != null
      ? details.arguments as Record<string, unknown>
      : null;
    proposal = argumentsValue == null ? null : { kind: "rho.file_edit_proposal", ...argumentsValue };
  }
  const operation = proposal?.operation;
  if (
    typeof proposal?.path !== "string" || typeof proposal.content !== "string" ||
    (operation !== "replace_selection" && operation !== "insert_at_cursor" && operation !== "append" && operation !== "create")
  ) return null;
  return { path: proposal.path, operation, content: proposal.content };
}

function agentFileProposalOutcome(detail: AgentTurnDetail, proposalEventId: number) {
  for (const event of detail.events) {
    if (!event.event_type.startsWith("file_edit.")) continue;
    try {
      const envelope = JSON.parse(event.details_json) as Record<string, unknown>;
      if (Number(envelope.proposal_event_id) !== proposalEventId) continue;
      if (event.event_type === "file_edit.applied") return "applied";
      if (event.event_type === "file_edit.undone") return "undone";
      if (event.event_type.includes("stale")) return "stale";
      if (event.event_type.includes("failed") || event.event_type.includes("cancelled")) return "not applied";
    } catch { /* malformed diagnostics stay visible as raw events */ }
  }
  return null;
}

function initialAgentSurfaceState(instance: SurfaceInstance): AgentSurfaceViewState {
  const candidate = typeof instance.view_state === "object" && instance.view_state != null
    ? instance.view_state as Record<string, unknown>
    : {};
  const mode = candidate.mode;
  return {
    conversation_id: typeof candidate.conversation_id === "string"
      ? candidate.conversation_id
      : null,
    mode: mode === "plan" || mode === "act" ? mode : "ask",
    composer: typeof candidate.composer === "string" ? candidate.composer : "",
    auto_approve: candidate.auto_approve === true,
    file_decisions: typeof candidate.file_decisions === "object" && candidate.file_decisions != null
      ? candidate.file_decisions as Readonly<Record<string, "rejected">>
      : {},
  };
}

function AgentSurfaceView({
  instance,
  transport,
  health,
  persist,
  pinTask,
  applyFileProposal,
  undoFileProposal,
  reportError,
}: {
  readonly instance: SurfaceInstance;
  readonly transport: UiKernelTransport;
  readonly health: SurfaceViewProps["agentHealth"];
  readonly persist: (viewState: AgentSurfaceViewState) => Promise<void>;
  readonly pinTask: (turn: AgentTurnSummary) => Promise<void>;
  readonly applyFileProposal: SurfaceViewProps["applyAgentFileProposal"];
  readonly undoFileProposal: SurfaceViewProps["undoAgentFileProposal"];
  readonly reportError: (error: unknown) => void;
}) {
  const [view, setView] = useState(() => initialAgentSurfaceState(instance));
  const viewRef = useRef(view);
  const [conversations, setConversations] = useState<readonly AgentConversationSummary[]>([]);
  const [turns, setTurns] = useState<readonly AgentTurnSummary[]>([]);
  const [details, setDetails] = useState<ReadonlyMap<string, AgentTurnDetail>>(() => new Map());
  const [busy, setBusy] = useState(false);
  const [fileUndo, setFileUndo] = useState<AgentFileUndoState | null>(null);
  const [loading, setLoading] = useState(true);
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<AgentRuntimeDiagnostics | null>(null);

  const refresh = useCallback(async (preferredConversationId = viewRef.current.conversation_id) => {
    const nextConversations = await transport.listAgentConversations(50);
    const selected = nextConversations.some(
      (conversation) => conversation.conversation_id === preferredConversationId,
    ) ? preferredConversationId : nextConversations[0]?.conversation_id ?? null;
    const nextTurns = selected == null ? [] : await transport.listAgentTurns(selected, 50);
    const loadedDetails = await Promise.all(nextTurns.slice(0, 20).map(async (turn) => [
      turn.turn_id,
      await transport.getAgentTurnDetail(turn.turn_id),
    ] as const));
    setConversations(nextConversations);
    setTurns(nextTurns);
    setDetails(new Map(loadedDetails.flatMap(([turnId, detail]) =>
      detail == null ? [] : [[turnId, detail] as const]
    )));
    if (selected !== viewRef.current.conversation_id) {
      const next = { ...viewRef.current, conversation_id: selected };
      viewRef.current = next;
      setView(next);
      if (selected != null) await persist(next);
    }
    setLoading(false);
  }, [persist, transport]);

  useEffect(() => {
    const next = initialAgentSurfaceState(instance);
    viewRef.current = next;
    setView(next);
  }, [instance.instance_id]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        await refresh();
      } catch (error: unknown) {
        if (active) reportError(error);
      }
    };
    void load();
    const unsubscribe = transport.subscribeAgentInvalidated(() => void load());
    return () => { active = false; unsubscribe(); };
  }, [refresh, reportError, transport]);

  useEffect(() => {
    let active = true;
    void transport.getAgentRuntimeDiagnostics()
      .then((diagnostics) => { if (active) setRuntimeDiagnostics(diagnostics); })
      .catch((error: unknown) => { if (active) reportError(error); });
    return () => { active = false; };
  }, [health?.state, reportError, transport]);

  const commitView = (next: AgentSurfaceViewState, durable = true) => {
    viewRef.current = next;
    setView(next);
    if (durable) void persist(next).catch(reportError);
  };
  const selectConversation = async (conversationId: string) => {
    const next = { ...view, conversation_id: conversationId };
    viewRef.current = next;
    setView(next);
    await persist(next);
    await refresh(conversationId);
  };
  const newConversation = async () => {
    setBusy(true);
    try {
      const conversation = await transport.createAgentConversation();
      await selectConversation(conversation.conversation_id);
    } catch (error: unknown) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    const prompt = view.composer.trim();
    if (!prompt || busy || health?.state !== "ready") return;
    setBusy(true);
    try {
      const response = await transport.runAgent({
        prompt,
        mode: view.mode,
        task_kind: "agent_turn",
        model_id: null,
        auto_approve: view.auto_approve,
        editor_context: null,
        conversation_id: view.conversation_id,
      });
      const next = { ...view, conversation_id: response.conversation_id, composer: "" };
      viewRef.current = next;
      setView(next);
      await persist(next);
      await refresh(response.conversation_id);
    } catch (error: unknown) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };
  const displayMode = instance.mode_id ?? "conversation";
  const activeTurn = turns.find((turn) => turn.status === "running" || turn.status === "waiting");
  const diagnosticsText = runtimeDiagnostics == null ? "Agent runtime diagnostics are loading." : [
    "R",
    `  executable: ${runtimeDiagnostics.rscript ?? "not resolved"}`,
    `  version:    ${runtimeDiagnostics.r_version ?? "unknown"}`,
    "",
    "Agent runtime",
    ...runtimeDiagnostics.dependencies.flatMap((dependency) => [
      `  ${dependency.package}:`,
      `    installed: ${dependency.installed_version ?? "missing"}`,
      `    required:  >= ${dependency.required_version}`,
      `    status:    ${dependency.status}`,
      `    path:      ${dependency.resolved_path ?? "not resolved"}`,
      ...(dependency.detail == null ? [] : [`    detail:    ${dependency.detail}`]),
      ...(dependency.remediation == null ? [] : [`    fix:       ${dependency.remediation}`]),
    ]),
    "",
    `Provider adapters: ${runtimeDiagnostics.provider_adapters_available ? "ready" : "unavailable"}`,
    `Provider health:   ${runtimeDiagnostics.provider_health}`,
    "Workspace R remains independent and available when healthy.",
  ].join("\n");

  return (
    <section className={`rho-agent-surface rho-agent-${displayMode}`}>
      {health?.state !== "ready" && (
        <div className="rho-agent-degraded" role="status">
          <strong>{health?.label ?? "Agent runtime unavailable"}</strong>
          {health?.detail != null && <p>{health.detail}</p>}
          <details className="rho-agent-runtime-diagnostics">
            <summary>Dependency details</summary>
            <pre>{diagnosticsText}</pre>
            <button type="button" onClick={() => {
              void navigator.clipboard.writeText(diagnosticsText).catch(reportError);
            }}>Copy diagnostics</button>
          </details>
          <button type="button" disabled={busy} onClick={() => {
            setBusy(true);
            void transport.retryAgentRuntime()
              .then((diagnostics) => { setRuntimeDiagnostics(diagnostics); return refresh(); })
              .catch(reportError)
              .finally(() => setBusy(false));
          }}>Retry Agent runtime</button>
        </div>
      )}
      <header className="rho-agent-toolbar">
        <select
          aria-label={`Conversation for ${instance.instance_id}`}
          value={view.conversation_id ?? ""}
          disabled={busy}
          onChange={(event) => void selectConversation(event.target.value).catch(reportError)}
        >
          <option value="">No conversation</option>
          {conversations.map((conversation) => (
            <option value={conversation.conversation_id} key={conversation.conversation_id}>
              {conversation.title} · {conversation.turn_count}
            </option>
          ))}
        </select>
        <button type="button" disabled={busy} onClick={() => void newConversation()}>New</button>
        {activeTurn != null && (
          <button type="button" disabled={busy} onClick={() => {
            setBusy(true);
            void transport.cancelAgentTurn(activeTurn.turn_id)
              .then(() => refresh())
              .catch(reportError)
              .finally(() => setBusy(false));
          }}>Cancel</button>
        )}
      </header>
      {displayMode !== "composer" && (
        <div className="rho-agent-timeline" aria-busy={loading}>
          {loading && <p>Loading conversation…</p>}
          {!loading && turns.length === 0 && <p className="rho-agent-empty">This conversation is ready for its first turn.</p>}
          {turns.map((turn) => {
            const detail = details.get(turn.turn_id);
            const proposals = detail?.events.flatMap((event) => {
              const proposal = parseAgentFileProposal(event);
              return proposal == null ? [] : [{ event, proposal }];
            }) ?? [];
            return (
              <article className={`rho-agent-turn rho-agent-turn-${turn.status}`} data-turn-id={turn.turn_id} key={turn.turn_id}>
                <header><strong>{turn.mode.toUpperCase()}</strong><span>{turn.status}</span><code>{turn.model}</code></header>
                <p className="rho-agent-prompt">{turn.prompt_preview}</p>
                {turn.final_message != null && <p className="rho-agent-answer">{turn.final_message}</p>}
                {turn.error_message != null && <p className="rho-agent-turn-error">{turn.error_message}</p>}
                {detail?.events.filter((event) => event.code != null).map((event) => (
                  <details className="rho-agent-code-review" key={event.id}>
                    <summary>{event.title}</summary><pre>{event.code}</pre>
                  </details>
                ))}
                {proposals.map(({ event, proposal }) => {
                  const key = `${turn.turn_id}:${event.id}`;
                  const outcome = detail == null ? null : agentFileProposalOutcome(detail, event.id);
                  const rejected = view.file_decisions[key] === "rejected";
                  return (
                    <section className="rho-agent-file-proposal" data-proposal-key={key} key={key}>
                      <header><strong>{proposal.operation.replaceAll("_", " ")}</strong><code>{proposal.path}</code></header>
                      <pre>{proposal.content}</pre>
                      {outcome != null && <span className="rho-agent-file-outcome">{outcome}</span>}
                      {rejected && outcome == null && <span className="rho-agent-file-outcome">rejected in this view</span>}
                      {outcome == null && !rejected && (
                        <div>
                          <button type="button" disabled={busy || turn.status === "running" || turn.status === "waiting"} onClick={() => {
                            setBusy(true);
                            void applyFileProposal(turn, event.id, proposal)
                              .then(({ response, beforeContent }) => {
                                if (response.after_sha256 != null) {
                                  setFileUndo({
                                    turn_id: turn.turn_id,
                                    proposal_event_id: event.id,
                                    path: proposal.path,
                                    expected_after_sha256: response.after_sha256,
                                    before_content: beforeContent,
                                    created: proposal.operation === "create",
                                  });
                                }
                                return refresh();
                              })
                              .catch(reportError)
                              .finally(() => setBusy(false));
                          }}>Apply</button>
                          <button type="button" onClick={() => commitView({
                            ...view,
                            file_decisions: { ...view.file_decisions, [key]: "rejected" },
                          })}>Reject</button>
                        </div>
                      )}
                      {fileUndo?.turn_id === turn.turn_id && fileUndo.proposal_event_id === event.id && (
                        <button type="button" disabled={busy} onClick={() => {
                          setBusy(true);
                          void undoFileProposal(fileUndo)
                            .then(() => { setFileUndo(null); return refresh(); })
                            .catch(reportError)
                            .finally(() => setBusy(false));
                        }}>Undo applied edit</button>
                      )}
                    </section>
                  );
                })}
                {detail?.approvals.filter((approval) => approval.status === "waiting").map((approval) => (
                  <div className="rho-agent-approval" key={approval.request_id}>
                    <strong>{approval.tool}</strong><pre>{approval.code ?? approval.arguments_json}</pre>
                    <button type="button" onClick={() => void transport.respondAgentApproval({ request_id: approval.request_id, decision: "approve", reason: null }).then(() => refresh()).catch(reportError)}>Approve</button>
                    <button type="button" onClick={() => void transport.respondAgentApproval({ request_id: approval.request_id, decision: "reject", reason: "Rejected in Agent Surface" }).then(() => refresh()).catch(reportError)}>Reject</button>
                  </div>
                ))}
                <footer>
                  <button type="button" onClick={() => void pinTask(turn).catch(reportError)}>Pin to Vibe</button>
                  {(turn.status === "failed" || turn.status === "cancelled") && <button type="button" onClick={() => void transport.retryAgentTurn(turn.turn_id).then(() => refresh()).catch(reportError)}>Retry</button>}
                </footer>
              </article>
            );
          })}
        </div>
      )}
      {displayMode !== "activity" && (
        <div className="rho-agent-composer">
          <div className="rho-agent-mode" role="group" aria-label="Agent mode">
            {(["ask", "plan", "act"] as const).map((mode) => (
              <button type="button" aria-pressed={view.mode === mode} key={mode} onClick={() => commitView({ ...view, mode })}>{mode}</button>
            ))}
          </div>
          <textarea
            aria-label={`Agent prompt ${instance.instance_id}`}
            value={view.composer}
            disabled={busy}
            onChange={(event) => commitView({ ...view, composer: event.target.value }, false)}
            onBlur={() => void persist(view).catch(reportError)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="Ask Rho about this project…"
          />
          <label className="rho-agent-auto-approve">
            <input type="checkbox" checked={view.auto_approve} disabled={view.mode !== "act"} onChange={(event) => commitView({ ...view, auto_approve: event.target.checked })} />
            Auto-approve Act tools
          </label>
          <button type="button" disabled={busy || health?.state !== "ready" || !view.composer.trim()} onClick={() => void submit()}>{busy ? "Working…" : "Send"}</button>
        </div>
      )}
    </section>
  );
}

const DOMAIN_SURFACE_IDS = new Set([
  "rho.environment", "rho.evidence", "rho.git", "rho.runs", "rho.artifacts",
  "rho.problems", "rho.plots", "rho.logs", "rho.render-jobs", "rho.help",
]);

function DomainSurfaceView({
  instance,
  transport,
  persist,
  reportError,
}: {
  readonly instance: SurfaceInstance;
  readonly transport: UiKernelTransport;
  readonly persist: (viewState: unknown) => Promise<void>;
  readonly reportError: (error: unknown) => void;
}) {
  const initialFilter = typeof instance.view_state === "object" && instance.view_state != null &&
      "filter" in instance.view_state && typeof instance.view_state.filter === "string"
    ? instance.view_state.filter
    : "";
  const [filter, setFilter] = useState(initialFilter);
  const [data, setData] = useState<DomainSurfaceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await transport.loadDomainSurface(instance.surface_id));
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Domain Surface could not load.");
    }
  }, [instance.surface_id, transport]);
  useEffect(() => {
    void load();
    return transport.subscribeInvalidated(() => void load());
  }, [load, transport]);
  const items = data?.items.filter((item) => {
    const query = filter.trim().toLowerCase();
    return !query || `${item.title} ${item.subtitle ?? ""} ${item.status ?? ""}`.toLowerCase().includes(query);
  }) ?? [];
  const strip = instance.surface_id === "rho.logs" || instance.surface_id === "rho.problems";
  return (
    <section className={`rho-domain-surface ${strip ? "rho-domain-strip" : ""}`}>
      <header>
        <div><strong>{data?.summary ?? "Loading…"}</strong><small>{instance.mode_id ?? "default"}</small></div>
        {!strip && <input
          aria-label={`Filter ${instance.surface_id}`}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onBlur={() => void persist({ filter }).catch(reportError)}
          placeholder="Filter this view…"
        />}
        <button type="button" onClick={() => void load()}>Refresh</button>
      </header>
      {error != null && <p className="rho-domain-error" role="alert">{error}</p>}
      <div className="rho-domain-records">
        {items.length === 0 && error == null && <p>No records in this view.</p>}
        {items.map((item) => (
          <article data-domain-id={item.id} key={item.id}>
            <span className={`rho-domain-state rho-domain-${item.status ?? "neutral"}`}>{item.status ?? "record"}</span>
            <strong>{item.title}</strong>
            {item.subtitle != null && <small>{item.subtitle}</small>}
            {!strip && item.detail != null && <details><summary>Details</summary><pre>{item.detail}</pre></details>}
            {!strip && instance.surface_id === "rho.runs" && (item.status === "failed" || item.status === "cancelled") && (
              <button type="button" disabled={busyId === item.id} onClick={() => {
                setBusyId(item.id);
                void transport.retryRun(item.id).then(load).catch(reportError).finally(() => setBusyId(null));
              }}>Retry run</button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function SurfaceView({
  instance, focused, setFocus, remove, duplicate, suspend, resume, persistDraft, draftCache,
  runtimes, attachRuntime, detachRuntime, executeRuntime, interruptRuntime,
  restartRuntime, persistConsole, resources, readResource, updateResourceDraft,
  saveResource, reloadResource, renameResource, deleteResource,
  refreshResourceBinding, setViewGroup, persistFileViewState, reportError,
  pluginTransport, pluginDocumentRequest, projectRevision, openCheckEvidence,
  agentHealth, persistAgentViewState, persistSurfaceViewState, pinAgentTask,
  applyAgentFileProposal, undoAgentFileProposal,
  embedded,
}: SurfaceViewProps) {
  const [draft, setDraft] = useState(() => initialDraft(instance, draftCache));
  const [consoleState, setConsoleState] = useState(() => initialConsoleState(instance));
  const [consoleRunning, setConsoleRunning] = useState(false);
  const runtime = instance.runtime_binding;
  const isStrip = instance.surface_id === "rho.status" || instance.surface_id === "rho.logs" || instance.surface_id === "rho.problems";
  const title = instance.surface_id === "rho.console" ? "R Console"
    : instance.surface_id === "rho.file-preview" ? "File preview"
    : instance.surface_id === "rho.file-source" ? "Source editor"
    : instance.surface_id === "rho.status" ? "Runtime status"
    : instance.surface_id === "rho.check-result" ? "Check result"
    : instance.surface_id === "rho.agent" ? "Agent"
    : instance.surface_id === "rho.surface-playground" ? "Surface Playground"
    : instance.surface_id.replace("rho.", "").replaceAll("-", " ");
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
      onPointerDown={embedded ? undefined : setFocus}
    >
      <header className="rho-surface-chrome">
        <div><span className="rho-eyebrow">{instance.surface_id}</span><strong>{title}</strong></div>
        {!embedded && <div className="rho-surface-actions" onPointerDown={(event) => event.stopPropagation()}>
          {instance.lifecycle_state === "active" || instance.lifecycle_state === "hidden"
            ? <button type="button" onClick={() => void suspend().catch(reportError)}>Pause</button>
            : instance.lifecycle_state === "suspended"
              ? <button type="button" onClick={() => void resume().catch(reportError)}>Resume</button>
              : null}
          <button type="button" onClick={duplicate}>Duplicate</button>
          <button type="button" onClick={remove} aria-label={`Remove ${instance.instance_id} from layout`}>×</button>
        </div>}
      </header>
      {instance.lifecycle_state === "suspended" ? (
        <section className="rho-surface-lifecycle-state" role="status">
          <strong>Surface paused</strong>
          <p>Its durable binding is preserved; heavy renderer and derived plugin payloads were released.</p>
          <button type="button" onClick={() => void resume().catch(reportError)}>Resume Surface</button>
        </section>
      ) : instance.lifecycle_state === "failed" ? (
        <section className="rho-surface-lifecycle-state rho-surface-lifecycle-failed" role="alert">
          <strong>Surface failed</strong>
          <p>The failed projection is isolated. Its project, Resource, Runtime, and sibling Surfaces remain available.</p>
        </section>
      ) : instance.lifecycle_state === "placeholder" ? (
        <section className="rho-surface-lifecycle-state rho-surface-lifecycle-placeholder" role="status">
          <strong>Surface provider unavailable</strong>
          <p>The exact placement and binding are preserved without rendering stale plugin or Runtime content.</p>
        </section>
      ) : <>
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
      {instance.surface_id === "rho.check-result" && (
        <CheckResultView
          instance={instance}
          projectRevision={projectRevision}
          transport={pluginTransport}
          openEvidence={openCheckEvidence}
          reportError={reportError}
        />
      )}
      {instance.surface_id === "rho.agent" && (
        <AgentSurfaceView
          instance={instance}
          transport={pluginTransport}
          health={agentHealth}
          persist={persistAgentViewState}
          pinTask={pinAgentTask}
          applyFileProposal={applyAgentFileProposal}
          undoFileProposal={undoAgentFileProposal}
          reportError={reportError}
        />
      )}
      {DOMAIN_SURFACE_IDS.has(instance.surface_id) && (
        <DomainSurfaceView
          instance={instance}
          transport={pluginTransport}
          persist={persistSurfaceViewState}
          reportError={reportError}
        />
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
      {instance.origin.kind === "workspace_plugin" && pluginDocumentRequest != null && (
        <PluginSurfaceView
          request={pluginDocumentRequest}
          transport={pluginTransport}
          reportError={reportError}
        />
      )}
      {!isStrip && <footer className="rho-surface-meta"><span>{instance.mode_id ?? "default"}</span><span>rev {instance.surface_revision}</span><span>{runtime == null ? "unbound" : runtime.runtime_instance_id}</span></footer>}
      </>}
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
              id={`${node.node_id}:${id}:tab`}
              type="button"
              role="tab"
              aria-controls={`${node.node_id}:${id}:panel`}
              aria-selected={id === node.active_instance_id}
              tabIndex={id === node.active_instance_id ? 0 : -1}
              key={id}
              onClick={() => commit({ kind: "set_stack_active", stack_node_id: node.node_id, instance_id: id })}
              onKeyDown={(event) => {
                const current = node.instances.indexOf(id);
                const next = event.key === "Home" ? 0
                  : event.key === "End" ? node.instances.length - 1
                  : event.key === "ArrowLeft" ? (current - 1 + node.instances.length) % node.instances.length
                  : event.key === "ArrowRight" ? (current + 1) % node.instances.length
                  : current;
                if (next === current) return;
                event.preventDefault();
                const instanceId = node.instances[next];
                if (instanceId == null) return;
                commit({ kind: "set_stack_active", stack_node_id: node.node_id, instance_id: instanceId });
                event.currentTarget.parentElement
                  ?.querySelectorAll<HTMLButtonElement>("[role='tab']")[next]
                  ?.focus();
              }}
            >{instances.get(id)?.surface_id.replace("rho.", "") ?? id}</button>
          ))}
        </div>
        <div className="rho-stack-panes">
          <div
            id={`${node.node_id}:${node.active_instance_id}:panel`}
            className="rho-stack-pane"
            role="tabpanel"
            aria-labelledby={`${node.node_id}:${node.active_instance_id}:tab`}
          >
            {instances.get(node.active_instance_id) == null
              ? <div>Unavailable Surface {node.active_instance_id}</div>
              : surfaceView(instances.get(node.active_instance_id)!)}
          </div>
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

function WorkbenchApp({ transport }: AppProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [resourcePath, setResourcePath] = useState("analysis.R");
  const [commandQuery, setCommandQuery] = useState("");
  const [commandSearchOpen, setCommandSearchOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const draftCache = useRef(new Map<string, string>()).current;
  const pluginTransport = transport ?? defaultTransport;
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
  const openFactory = async (
    factory: SurfaceFactoryRegistration,
    viewStateOverride?: unknown,
  ) => {
    if (surfaces == null || studio == null) {
      throw new Error("Surface Runtime is not ready.");
    }
    const definition = factory.definition;
    const before = new Set(surfaces.catalog.instances.map((candidate) => candidate.instance_id));
    const primaryRuntime = runtimes?.instances.find((runtime) => runtime.primary_scientific_runtime);
    const consoleBinding = definition.surface_id === "rho.console" && primaryRuntime != null
      ? {
          runtime_provider_id: primaryRuntime.runtime_provider_id,
          runtime_instance_id: primaryRuntime.runtime_instance_id,
          runtime_kind: primaryRuntime.runtime_kind,
          project_id: primaryRuntime.project_id,
          activation_generation: primaryRuntime.activation_generation,
          state_revision: primaryRuntime.state_revision,
          attach_capabilities: primaryRuntime.attach_capabilities,
        }
      : null;
    const defaultViewState = definition.surface_id === "rho.agent"
      ? { conversation_id: null, mode: "ask", composer: "", auto_approve: false }
      : definition.surface_id === "rho.console"
        ? { draft: "", history: [], history_cursor: null, filter: "", scroll_top: 0, outputs: [] }
        : {};
    const opened = await surfaceStore.open({
      surface_id: definition.surface_id,
      project_id: surfaces.project_id,
      mode_id: definition.modes[0]?.mode_id ?? null,
      resource_binding: null,
      runtime_binding: consoleBinding,
      view_group_id: null,
      view_state: viewStateOverride ?? defaultViewState,
      instance_disposition: "new_instance",
      placement_intent: "current",
      expected_project_revision: surfaces.project_revision,
      expected_layout_revision: studio.scene.layout_revision,
    });
    const created = opened.catalog.instances.find((candidate) => !before.has(candidate.instance_id));
    if (created == null) throw new Error(`${definition.label} did not create a Surface instance.`);
    if (profile?.active_mode === "studio" && studio.scene.root.kind === "container") {
      await studioStore.apply({
        project_id: studio.project_id,
        expected_project_revision: studio.project_revision,
        expected_layout_revision: studio.scene.layout_revision,
        edit: {
          kind: "insert_surface",
          target_container_node_id: studio.scene.root.node_id,
          child_index: studio.scene.root.children.length,
          instance_id: created.instance_id,
          basis: definition.instance_quota_class === "strip"
            ? { kind: "intrinsic" }
            : { kind: "minmax", min_logical_pixels: 220, max_logical_pixels: 1_200, weight: 1 },
        },
      });
      return created;
    }
    await profileStore.refresh();
    const latest = profileStore.getSnapshot();
    if (latest.status !== "ready") throw new Error("Vibe Page Profile is unavailable.");
    const latestProfile = latest.snapshot.profile;
    const page = latestProfile.vibe_pages.find(
      (candidate) => candidate.page_id === latestProfile.active_vibe_page_id,
    );
    if (page == null) throw new Error("The active Vibe Page is unavailable.");
    const block = {
      block_id: `vibe-block:${crypto.randomUUID().replaceAll("-", "")}`,
      content: { kind: "surface_ref" as const, instance_id: created.instance_id, live: true },
    };
    const sections = page.sections.length === 0
      ? [{
          section_id: `vibe-section:${crypto.randomUUID().replaceAll("-", "")}`,
          heading: definition.label,
          layout: { kind: "flow" as const },
          blocks: [block],
        }]
      : page.sections.map((section, index) => {
          if (index !== page.sections.length - 1) return section;
          if (section.layout.kind === "flow") {
            return { ...section, blocks: [...section.blocks, block] };
          }
          const nextRow = section.layout.placements.reduce(
            (maximum, placement) => Math.max(maximum, placement.row_start),
            0,
          ) + 1;
          return {
            ...section,
            blocks: [...section.blocks, block],
            layout: {
              ...section.layout,
              placements: [...section.layout.placements, {
                block_id: block.block_id,
                row_start: nextRow,
                column_start: 1,
                column_span: 12,
              }],
            },
          };
        });
    await profileStore.applyPage({
      target: {
        project_id: latestProfile.project_id,
        expected_profile_revision: latestProfile.revision,
      },
      page_id: page.page_id,
      expected_page_revision: page.page_revision,
      mutation: { kind: "replace_sections", sections, focused_block_id: block.block_id },
    });
    return created;
  };
  const invokeCommand = async (commandId: string) => {
    if (commandId === "rho.agent.new-conversation") {
      const factory = surfaces?.catalog.factories.find(
        (candidate) => candidate.definition.surface_id === "rho.agent",
      );
      if (factory == null) throw new Error("Agent Surface factory is unavailable.");
      const conversation = await pluginTransport.createAgentConversation();
      await openFactory(factory, {
        conversation_id: conversation.conversation_id,
        mode: "ask",
        composer: "",
        auto_approve: false,
      });
      setCommandSearchOpen(false);
      return;
    }
    if (commandId.startsWith("rho.surface.open.")) {
      const surfaceId = `rho.${commandId.slice("rho.surface.open.".length)}`;
      const factory = surfaces?.catalog.factories.find(
        (candidate) => candidate.definition.surface_id === surfaceId,
      );
      if (factory == null) throw new Error(`Surface factory ${surfaceId} is unavailable.`);
      await openFactory(factory);
      setCommandSearchOpen(false);
      return;
    }
    if (commandId !== "rho.check.run") {
      throw new Error(`Command ${commandId} has no RSR frontend handler yet.`);
    }
    if (snapshot == null || surfaces == null || studio == null) {
      throw new Error("Check project is unavailable until the project Surface Runtime is ready.");
    }
    const before = new Set(surfaces.catalog.instances.map((candidate) => candidate.instance_id));
    const response = await pluginTransport.runCheckProject({
      project_id: snapshot.project.project_id,
      expected_project_revision: snapshot.context.project_revision,
    });
    const opened = await surfaceStore.open({
      surface_id: "rho.check-result",
      project_id: surfaces.project_id,
      mode_id: null,
      resource_binding: null,
      runtime_binding: null,
      view_group_id: null,
      view_state: { check_result_id: response.result.result_id },
      instance_disposition: "new_instance",
      placement_intent: "beside",
      expected_project_revision: surfaces.project_revision,
      expected_layout_revision: studio.scene.layout_revision,
    });
    const created = opened.catalog.instances.find((candidate) => !before.has(candidate.instance_id));
    if (created == null) throw new Error("Check completed, but its result Surface was not created.");
    if (profile?.active_mode === "studio" && studio.scene.root.kind === "container") {
      await studioStore.apply({
        project_id: studio.project_id,
        expected_project_revision: studio.project_revision,
        expected_layout_revision: studio.scene.layout_revision,
        edit: {
          kind: "insert_surface",
          target_container_node_id: studio.scene.root.node_id,
          child_index: studio.scene.root.children.length,
          instance_id: created.instance_id,
          basis: { kind: "minmax", min_logical_pixels: 280, max_logical_pixels: 900, weight: 1 },
        },
      });
    } else if (profile?.active_mode === "vibe") {
      await profileStore.refresh();
      const latest = profileStore.getSnapshot();
      if (latest.status !== "ready") throw new Error("Vibe Page Profile is unavailable after Check.");
      const activePage = latest.snapshot.profile.vibe_pages.find(
        (page) => page.page_id === latest.snapshot.profile.active_vibe_page_id,
      );
      if (activePage == null) throw new Error("The active Vibe Page is unavailable after Check.");
      const block = {
        block_id: `vibe-block:${crypto.randomUUID().replaceAll("-", "")}`,
        content: { kind: "surface_ref" as const, instance_id: created.instance_id, live: true },
      };
      const sections = activePage.sections.length === 0
        ? [{
            section_id: `vibe-section:${crypto.randomUUID().replaceAll("-", "")}`,
            heading: "Check results",
            layout: { kind: "flow" as const },
            blocks: [block],
          }]
        : activePage.sections.map((section, index) => {
            if (index !== activePage.sections.length - 1) return section;
            if (section.layout.kind === "flow") {
              return { ...section, blocks: [...section.blocks, block] };
            }
            const nextRow = Math.max(0, ...section.layout.placements.map((placement) => placement.row_start)) + 1;
            return {
              ...section,
              blocks: [...section.blocks, block],
              layout: {
                kind: "grid" as const,
                placements: [...section.layout.placements, {
                  block_id: block.block_id,
                  row_start: nextRow,
                  column_start: 1,
                  column_span: 12,
                }],
              },
            };
          });
      await profileStore.applyPage({
        target: {
          project_id: latest.snapshot.profile.project_id,
          expected_profile_revision: latest.snapshot.profile.revision,
        },
        page_id: activePage.page_id,
        expected_page_revision: activePage.page_revision,
        mutation: {
          kind: "replace_sections",
          sections,
          focused_block_id: activePage.focused_block_id,
        },
      });
    }
    setCommandSearchOpen(false);
  };
  const pinAgentTask = async (turn: AgentTurnSummary) => {
    await profileStore.refresh();
    const latest = profileStore.getSnapshot();
    if (latest.status !== "ready") throw new Error("The Project UI Profile is unavailable.");
    const latestProfile = latest.snapshot.profile;
    const activePage = latestProfile.vibe_pages.find(
      (page) => page.page_id === latestProfile.active_vibe_page_id,
    );
    if (activePage == null) throw new Error("The active Vibe Page is unavailable.");
    const block = {
      block_id: `vibe-block:${crypto.randomUUID().replaceAll("-", "")}`,
      content: {
        kind: "task_ref" as const,
        task_id: turn.turn_id,
        label: `${turn.mode.toUpperCase()} · ${turn.prompt_preview.slice(0, 96)}`,
      },
    };
    const sections = activePage.sections.length === 0
      ? [{
          section_id: `vibe-section:${crypto.randomUUID().replaceAll("-", "")}`,
          heading: "Agent tasks",
          layout: { kind: "flow" as const },
          blocks: [block],
        }]
      : activePage.sections.map((section, index) => {
          if (index !== activePage.sections.length - 1) return section;
          if (section.layout.kind === "flow") {
            return { ...section, blocks: [...section.blocks, block] };
          }
          const nextRow = section.layout.placements.reduce(
            (maximum, placement) => Math.max(maximum, placement.row_start),
            0,
          ) + 1;
          return {
            ...section,
            blocks: [...section.blocks, block],
            layout: {
              ...section.layout,
              placements: [...section.layout.placements, {
                block_id: block.block_id,
                row_start: nextRow,
                column_start: 1,
                column_span: 12,
              }],
            },
          };
        });
    await profileStore.applyPage({
      target: {
        project_id: latestProfile.project_id,
        expected_profile_revision: latestProfile.revision,
      },
      page_id: activePage.page_id,
      expected_page_revision: activePage.page_revision,
      mutation: {
        kind: "replace_sections",
        sections,
        focused_block_id: block.block_id,
      },
    });
  };
  const surfaceView = (instance: SurfaceInstance, embedded = false) => {
    const boundDescriptor = resources?.resources.find((descriptor) =>
      descriptor.resource_provider_id === instance.resource_binding?.resource_provider_id &&
      descriptor.resource_kind === instance.resource_binding?.resource_kind &&
      descriptor.resource_id === instance.resource_binding.resource_id
    ) ?? null;
    const activePage = profile?.vibe_pages.find(
      (page) => page.page_id === profile.active_vibe_page_id,
    ) ?? null;
    const pluginDocumentRequest: PluginSurfaceDocumentRequest | null =
      surfaces == null || studio == null || instance.origin.kind !== "workspace_plugin"
        ? null
        : {
            target: instanceRequest(instance, surfaces.project_revision),
            expected_layout_revision: profile?.active_mode === "studio"
              ? studio.scene.layout_revision
              : null,
            expected_page_revision: profile?.active_mode === "vibe"
              ? activePage?.page_revision ?? null
              : null,
          };
    return <SurfaceView
      key={instance.instance_id}
      instance={instance}
      focused={!embedded && studio?.scene.focused_surface_instance_id === instance.instance_id}
      setFocus={() => {
        if (!embedded && studio?.scene.focused_surface_instance_id !== instance.instance_id) {
          commit({ kind: "set_focus", instance_id: instance.instance_id });
        }
      }}
      remove={() => commit({ kind: "close_surface_placement", instance_id: instance.instance_id })}
      duplicate={() => run(duplicate(instance))}
      suspend={async () => {
        if (surfaces == null) throw new Error("Surface Runtime is not ready.");
        await surfaceStore.suspend(instanceRequest(instance, surfaces.project_revision));
      }}
      resume={async () => {
        if (surfaces == null) throw new Error("Surface Runtime is not ready.");
        await surfaceStore.resume(instanceRequest(instance, surfaces.project_revision));
      }}
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
      pluginTransport={pluginTransport}
      pluginDocumentRequest={pluginDocumentRequest}
      projectRevision={surfaces?.project_revision ?? 0}
      openCheckEvidence={async (path) => {
        const descriptor = resources?.resources.find((candidate) =>
          candidate.resource_provider_id === "rho.project-files" &&
          candidate.resource_kind === "project_file" &&
          candidate.resource_id === path
        );
        if (descriptor == null) throw new Error(`Check evidence Resource ${path} is unavailable.`);
        await openResource(descriptor, "rho.file-source", "source");
      }}
      agentHealth={snapshot?.health.agent ?? null}
      persistAgentViewState={async (viewState) => {
        if (surfaces == null) throw new Error("Surface Runtime is not ready.");
        await surfaceStore.update({
          target: instanceRequest(instance, surfaces.project_revision),
          mutation: { kind: "set_view_state", view_state: viewState },
        });
      }}
      persistSurfaceViewState={async (viewState) => {
        if (surfaces == null) throw new Error("Surface Runtime is not ready.");
        await surfaceStore.update({
          target: instanceRequest(instance, surfaces.project_revision),
          mutation: { kind: "set_view_state", view_state: viewState },
        });
      }}
      pinAgentTask={pinAgentTask}
      applyAgentFileProposal={async (turn, eventId, proposal) => {
        let beforeContent = "";
        let expectedDiskSha256: string | null = null;
        if (proposal.operation !== "create") {
          if (resources == null) throw new Error("Resource Registry is not ready.");
          let descriptor = resources.resources.find((candidate) =>
            candidate.resource_provider_id === "rho.project-files" &&
            candidate.resource_kind === "project_file" &&
            candidate.resource_id === proposal.path
          );
          if (descriptor == null) {
            const resolved = await resourceStore.resolve({
              project_id: resources.project_id,
              resource_provider_id: "rho.project-files",
              resource_kind: "project_file",
              resource_id: proposal.path,
              expected_project_revision: resources.project_revision,
              expected_snapshot_revision: resources.snapshot_revision,
            });
            descriptor = resolved.resources.find((candidate) =>
              candidate.resource_provider_id === "rho.project-files" &&
              candidate.resource_kind === "project_file" &&
              candidate.resource_id === proposal.path
            );
          }
          if (descriptor == null || descriptor.status !== "ready") {
            throw new Error(`Agent proposal target ${proposal.path} is unavailable.`);
          }
          const content = await resourceStore.read({
            target: resourceTarget(descriptor, resources.project_revision),
            consistency: "shared_document",
          });
          beforeContent = content.content;
          expectedDiskSha256 = descriptor.content_sha256;
          if (expectedDiskSha256 == null) {
            throw new Error(`Agent proposal target ${proposal.path} has no disk digest.`);
          }
        }
        const response = await pluginTransport.applyAgentFileEdit({
          turn_id: turn.turn_id,
          proposal_event_id: eventId,
          path: proposal.path,
          expected_disk_sha256: expectedDiskSha256,
          before_content: beforeContent,
        });
        await Promise.all([resourceStore.refresh(), surfaceStore.refresh()]);
        return { response, beforeContent };
      }}
      undoAgentFileProposal={async (request) => {
        await pluginTransport.undoAgentFileEdit(request);
        await Promise.all([resourceStore.refresh(), surfaceStore.refresh()]);
      }}
      embedded={embedded}
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
    surfaceInstanceCount: surfaces?.catalog.instances.length ?? 0,
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
    activePageBlockCount: activeVibePage?.sections.reduce(
      (total, section) => total + section.blocks.length,
      0,
    ) ?? 0,
    profileLoadStatus: profileSnapshot?.load_status ?? null,
  }), [activeVibePage, instances, profile, profileSnapshot, resources, runtimes, snapshot, state, studio, surfaces]);
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
                <button type="button" role="option" disabled={command.availability.state !== "available"} onClick={() => run(invokeCommand(command.definition.command_id))} key={command.definition.command_id}>
                  <strong>{command.definition.label}</strong><code>{command.definition.command_id}</code>
                </button>
              ))}
              {paletteCommands.length === 0 && <p>No matching command</p>}
            </div>
          )}
        </div>
        <div className="rho-command-projection" aria-label="Primary contextual command">
          {primaryCommands.filter((command) => command.availability.state === "available" && command.definition.command_id === "rho.check.run").slice(0, 1).map((command) => <button type="button" onClick={() => run(invokeCommand(command.definition.command_id))} key={command.definition.command_id}>{command.definition.label}</button>)}
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
              {surfaces != null && (
                <section className="rho-surface-catalog">
                  <div className="rho-surface-catalog-heading">
                    <span className="rho-eyebrow">Surface catalog</span>
                    <span>{surfaces.catalog.factories.length} factories</span>
                  </div>
                  {surfaces.catalog.factories.map((factory) => (
                    <article className="rho-surface-factory" data-surface-factory={factory.definition.surface_id} key={`${factory.definition.surface_id}:${factory.activation_generation}`}>
                      <div>
                        <strong>{factory.definition.label}</strong>
                        <small>{factory.definition.purpose}</small>
                      </div>
                      <button type="button" onClick={() => run(openFactory(factory))}>Open</button>
                    </article>
                  ))}
                </section>
              )}
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
                : <VibePageEditor
                    page={activeVibePage}
                    profileRevision={profile.revision}
                    instances={instances}
                    renderSurface={(instance) => surfaceView(instance, true)}
                    invokeCommand={invokeCommand}
                    commit={(request) => profileStore.applyPage(request)}
                    exportPage={(request) => profileStore.exportPage(request)}
                    reportError={(error) => setActionError(
                      error instanceof Error && error.message.trim()
                        ? error.message.slice(0, 512)
                        : "Vibe Page operation failed.",
                    )}
                  />
              : <LayoutTree node={studio.scene.root} instances={instances} studio={studio} commit={commit} surfaceView={surfaceView} />}
        </section>
      </div>
      <pre id="rsrPreviewEvidence" hidden>{JSON.stringify(evidence)}</pre>
    </main>
  );
}
