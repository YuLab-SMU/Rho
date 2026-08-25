import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

import {
  WorkbenchProjectionStore,
  commandsForPlacement,
  createUiKernelTransport,
} from "../transport";
import type {
  AgentConversationSummary,
  AgentContextPlanPreview,
  AgentLlmSettingsView,
  AgentFileMutationResponse,
  AgentMode,
  AgentRuntimeDiagnostics,
  AgentTurnDetail,
  AgentTurnSummary,
  CheckEvidence,
  CheckResult,
  DomainSurfaceData,
  PluginSurfaceBlock,
  PluginSurfaceDocumentRequest,
  PluginSurfaceEventKind,
  ProjectSwitchResponse,
  ResourceContent,
  ResourceDescriptor,
  ResourceReadConsistency,
  ResourceRegistrySnapshot,
  ResourceTarget,
  RuntimeDescriptor,
  RuntimeExecution,
  RuntimeExecutionStartResponse,
  RuntimeExecutionSourceContext,
  RuntimeOutputFollowFrame,
  RuntimeOutputPage,
  RuntimeOutputReference,
  RuntimeOutputSearchResult,
  RuntimeInstanceRequest,
  RuntimeRegistrySnapshot,
  SceneEdit,
  SurfaceInstance,
  SurfaceFactoryRegistration,
  SurfaceInstanceRequest,
  UiKernelTransport,
  WorkspacePreparation,
} from "../transport";
import { VibePageEditor } from "./VibePageEditor";
import { MenuPopover } from "./MenuPopover";
import { NavigatorSurfaceView } from "./Navigator";
import { PlotThumbnail } from "./PlotThumbnail";
import { SourceEditor } from "./SourceEditor";
import type { SourceEditorHandle } from "./SourceEditor";
import type { SourceExecutionSubmission } from "./source-execution";
import { consoleProjectionBlocksText } from "./console-output";
import {
  environmentDetail,
  environmentItemsForMode,
  environmentMatches,
  environmentSummary,
  environmentTone,
} from "./environment-presentation";
import type { EnvironmentMode } from "./environment-presentation";
import {
  domainEmptyState,
  domainItemPresentation,
  domainItemsForMode,
  domainMatches,
  domainPresentationKind,
  domainSummary,
} from "./domain-presentation";
import { ToolbarCustomizer } from "./ToolbarCustomizer";
import {
  loadProjectHistory,
  rememberProjectPath,
  saveProjectHistory,
} from "./project-history";
import type { ProjectHistoryLoad } from "./project-history";
import {
  StudioDragLayer,
  useStudioPointerDrag,
} from "./StudioPointerDrag";
import type { StudioPointerDragController } from "./StudioPointerDrag";
import {
  defaultToolbarLayout,
  loadToolbarLayout,
  saveToolbarLayout,
} from "./toolbar-model";
import { workbenchFailureMessage } from "./workbench-failure";
import { formatHistoryTime } from "./time-format";
import { workbenchOperationTrace } from "./operation-trace";
import { ConsoleExecutionRouter } from "./controllers/console-execution-router";
import type {
  ConsoleExecutionAdmission,
  ConsoleExecutionEndpoint,
} from "./controllers/console-execution-router";
import { useConsoleProjectActivation } from "./controllers/console-project-activation";
import { ProjectSwitchController } from "./controllers/project-switch-controller";
import { RuntimeHistory } from "./RuntimeHistory";
import {
  consoleTranscriptOutputs,
  ConsoleInstanceController,
  initialConsoleState,
  needsConsoleStateCompaction,
} from "./controllers/console-instance-controller";
import type {
  ConsoleOutputRecord,
  ConsolePersistentViewState,
  ConsoleViewState,
} from "./controllers/console-instance-controller";
import { ConsoleRequirementController } from "./controllers/console-requirement-controller";
import { StudioMutationController } from "./controllers/studio-mutation-controller";
import { SurfaceInstanceMutationController } from "./controllers/surface-instance-mutation-controller";
import { surfaceDisplayLabel, surfaceUxProfile } from "./surface-ux";
import {
  findLayoutPlacement,
  LayoutTree,
  NodeOutline,
} from "./layout/LegacySceneLayout";
import type {
  ToolbarComponentId,
  ToolbarLayout,
  ToolbarPreferenceLoad,
} from "./toolbar-model";
import type { StudioDropTarget, StudioDropZone } from "../transport/studio-model";
import { projectLabel } from "../transport/normalize";
import DOMPurify from "dompurify";
import { marked } from "marked";

interface AppProps {
  readonly transport?: UiKernelTransport;
}

function boundedFailureMessage(error: unknown, fallback: string): string {
  return workbenchFailureMessage(error, fallback);
}

type SurfaceTaskStateTone = "loading" | "empty" | "attention" | "error" | "paused";

function SurfaceTaskState({
  tone,
  title,
  detail,
  role,
  busy = false,
  className = "",
  children,
}: {
  readonly tone: SurfaceTaskStateTone;
  readonly title: string;
  readonly detail: string;
  readonly role?: "status" | "alert";
  readonly busy?: boolean;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  return <section className={`rho-task-state rho-task-state-${tone} ${className}`.trim()} role={role} aria-busy={busy || undefined}>
    {busy && <span className="rho-preparation-spinner" aria-hidden="true" />}
    <div><strong>{title}</strong><p>{detail}</p></div>
    {children != null && <div className="rho-task-state-actions">{children}</div>}
  </section>;
}

const defaultTransport = createUiKernelTransport();
const defaultStore = new WorkbenchProjectionStore(defaultTransport);

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

interface SurfaceViewProps {
  readonly instance: SurfaceInstance;
  readonly focused: boolean;
  readonly setFocus: () => void;
  readonly remove: () => void;
  readonly duplicate: () => void;
  readonly suspend: () => Promise<void>;
  readonly resume: () => Promise<void>;
  readonly persistDraft: (draft: string) => void;
  readonly availableModes: readonly {
    readonly mode_id: string;
    readonly label: string;
    readonly interaction_kind: "read_only" | "interactive";
  }[];
  readonly setMode: (modeId: string) => Promise<void>;
  readonly draftCache: Map<string, string>;
  readonly consoleSessionCache: Map<string, ConsoleViewState>;
  readonly runtimes: RuntimeRegistrySnapshot | null;
  readonly attachRuntime: (runtime: RuntimeDescriptor) => Promise<void>;
  readonly detachRuntime: () => Promise<void>;
  readonly startRuntimeExecution: (
    runtime: RuntimeDescriptor,
    code: string,
    sourceContext?: RuntimeExecutionSourceContext,
  ) => Promise<RuntimeExecutionStartResponse>;
  readonly followRuntimeOutput: (
    executionId: string,
    afterSequence: number,
    listener: (frame: RuntimeOutputFollowFrame) => void,
  ) => Promise<void>;
  readonly listRuntimeExecutions: () => Promise<readonly RuntimeExecution[]>;
  readonly loadRuntimeOutputPage: (executionId: string, afterSequence: number) => Promise<RuntimeOutputPage>;
  readonly loadRuntimeOutputPageBefore: (executionId: string, beforeSequence: number) => Promise<RuntimeOutputPage>;
  readonly interruptRuntime: (runtime: RuntimeDescriptor) => Promise<void>;
  readonly restartRuntime: (runtime: RuntimeDescriptor) => Promise<void>;
  readonly persistConsole: (viewState: ConsolePersistentViewState) => Promise<void>;
  readonly registerConsoleExecution: (endpoint: ConsoleExecutionEndpoint) => () => void;
  readonly markConsolePreferred: (instanceId: string) => void;
  readonly runSourceExecution: (
    sourceInstanceId: string,
    execution: SourceExecutionSubmission,
  ) => Promise<boolean>;
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
  readonly openNavigatorFile: (descriptor: ResourceDescriptor) => Promise<void>;
  readonly openSurfaceById: (surfaceId: string) => void;
  readonly agentRuntimeOutputContext: RuntimeOutputReference | null;
  readonly setAgentRuntimeOutputContext: (reference: RuntimeOutputReference | null) => void;
  readonly paneNodeId: string | null;
  readonly paneMemberCount: number;
  readonly studioDrag: StudioPointerDragController;
  readonly embedded: boolean;
}

function outputText(output: ConsoleOutputRecord): string {
  return consoleProjectionBlocksText(output.code, output.blocks);
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
  readonly runSourceExecution: (execution: SourceExecutionSubmission) => Promise<boolean>;
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
  refreshBinding, setViewGroup, persistViewState, runSourceExecution, reportError,
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
  const [sourceRunPending, setSourceRunPending] = useState(false);
  const [viewGroup, setViewGroupInput] = useState(instance.view_group_id ?? "");
  const [renamePath, setRenamePath] = useState(binding?.resource_id ?? "");
  const contentRef = useRef<ResourceContent | null>(content);
  const editorValueRef = useRef(editorValue);
  const localDirtyRef = useRef(localDirty);
  const draftCommitRef = useRef<Promise<ResourceContent | null> | null>(null);
  const sourceEditorRef = useRef<SourceEditorHandle>(null);
  contentRef.current = content;
  editorValueRef.current = editorValue;
  localDirtyRef.current = localDirty;
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
      contentRef.current = next;
      if (!localDirtyRef.current) {
        setEditorValue(next.content);
        editorValueRef.current = next.content;
      }
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(boundedFailureMessage(cause, "Resource read failed."));
    });
    return () => { active = false; };
  }, [binding?.resource_id, bindingRevision, descriptor?.status, read, source, sourceRefreshRevision]);

  useEffect(() => {
    setViewGroupInput(instance.view_group_id ?? "");
  }, [instance.view_group_id]);
  useEffect(() => {
    setRenamePath(binding?.resource_id ?? "");
  }, [binding?.resource_id]);

  const commitDraft = (): Promise<ResourceContent | null> => {
    if (!source || contentRef.current == null || !localDirtyRef.current) {
      return Promise.resolve(contentRef.current);
    }
    if (draftCommitRef.current != null) return draftCommitRef.current;
    const base = contentRef.current;
    const value = editorValueRef.current;
    const operation: Promise<ResourceContent | null> = updateDraft(base, value).then((next) => {
      contentRef.current = next;
      setContent(next);
      if (editorValueRef.current === value) {
        editorValueRef.current = next.content;
        localDirtyRef.current = false;
        setEditorValue(next.content);
        setLocalDirty(false);
      }
      return next;
    }).finally(() => {
      if (draftCommitRef.current === operation) draftCommitRef.current = null;
    });
    draftCommitRef.current = operation;
    return operation;
  };
  const saveCurrent = async () => {
    const current = localDirtyRef.current ? await commitDraft() : contentRef.current;
    if (current == null || !current.dirty) return;
    const next = await save(current);
    contentRef.current = next;
    editorValueRef.current = next.content;
    localDirtyRef.current = false;
    setContent(next);
    setEditorValue(next.content);
    setLocalDirty(false);
  };
  const reloadCurrent = async () => {
    const current = contentRef.current;
    if (current == null) return;
    const next = await reload(current, current.dirty);
    contentRef.current = next;
    editorValueRef.current = next.content;
    localDirtyRef.current = false;
    setContent(next);
    setEditorValue(next.content);
    setLocalDirty(false);
  };
  const mode = instance.mode_id ?? (source ? "source" : "preview");
  const fileName = binding?.resource_id.split("/").filter(Boolean).pop() ?? "No file";
  const dirty = localDirty || content?.dirty === true;
  const outline = editorValue.split("\n").flatMap((line, index) => {
    const match = line.match(/^\s*(?:#+\s+(.+)|([A-Za-z.][\w.]*)\s*<-\s*function\b)/u);
    return match == null ? [] : [{ line: index + 1, label: match[1] ?? match[2] ?? line.trim() }];
  });
  const markup = !source && content != null ? resourceMarkup(content) : null;

  return (
    <div className="rho-file-resource">
      <div className="rho-file-commandbar">
        <span className={`rho-resource-state rho-resource-${descriptor?.status ?? "missing"}`}>
          {descriptor?.status ?? "unresolved"}
        </span>
        <strong className="rho-file-name" title={binding?.resource_id ?? "No Resource bound"}>{fileName}</strong>
        {dirty && <span className="rho-resource-dirty">Unsaved</span>}
        {(content?.stale || staleBinding) && <span className="rho-resource-stale">stale</span>}
        <span className="rho-file-command-spacer" />
        {staleBinding && descriptor != null && (
          <button type="button" onClick={() => void refreshBinding(descriptor).catch(reportError)}>
            Refresh
          </button>
        )}
        {source && content != null && <>
          <button
            type="button"
            className="rho-file-run"
            disabled={sourceRunPending}
            aria-busy={sourceRunPending || undefined}
            aria-label="Run selection or current R expression in Console"
            title="Run selection or current R expression in Console · Ctrl/⌘ + Enter"
            onPointerDown={(event) => {
              event.preventDefault();
            }}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => { void sourceEditorRef.current?.runSelectionOrCurrentLine(); }}
          >{sourceRunPending
              ? <><span className="rho-preparation-spinner" aria-hidden="true" /> Preparing…</>
              : <><span aria-hidden="true">▶</span> Run</>}</button>
          <button
            type="button"
            className={`rho-file-save ${dirty ? "rho-primary-action" : ""}`.trim()}
            disabled={!dirty}
            onClick={() => void saveCurrent().catch(reportError)}
          >Save</button>
          <button type="button" className="rho-file-reload" onClick={() => void reloadCurrent().catch(reportError)}>
            {dirty ? "Discard & reload" : "Reload"}
          </button>
        </>}
        <MenuPopover label={`File information for ${fileName}`} glyph={<span aria-hidden="true">i</span>}>
          <div className="rho-menu-heading">
            <strong>{fileName}</strong>
            <code>{binding?.resource_id ?? "No Resource bound"}</code>
          </div>
          <dl className="rho-menu-facts">
            <div><dt>Status</dt><dd>{descriptor?.status ?? "unresolved"}</dd></div>
            <div><dt>Media type</dt><dd>{descriptor?.media_type ?? "unknown"}</dd></div>
            <div><dt>Resource revision</dt><dd>{descriptor?.resource_revision ?? "—"}</dd></div>
            <div><dt>Document revision</dt><dd>{content?.document_revision ?? "—"}</dd></div>
            <div><dt>View group</dt><dd>{instance.view_group_id ?? "Independent"}</dd></div>
          </dl>
        </MenuPopover>
        <MenuPopover label={`More file actions for ${fileName}`} glyph={<span aria-hidden="true">•••</span>} panelClassName="rho-file-more-menu">
          <div className="rho-menu-heading"><strong>File options</strong></div>
          <label className="rho-menu-field">
            <span>View group</span>
            <input value={viewGroup} onChange={(event) => setViewGroupInput(event.target.value)} placeholder="Independent" />
          </label>
          <button type="button" data-menu-close onClick={() => void setViewGroup(viewGroup.trim() || null).catch(reportError)}>Apply view group</button>
          <div className="rho-menu-separator" />
          <label className="rho-menu-field">
            <span>Path</span>
            <input value={renamePath} onChange={(event) => setRenamePath(event.target.value)} />
          </label>
          <button type="button" data-menu-close disabled={binding == null || renamePath === binding.resource_id} onClick={() => {
            void rename(contentRef.current, renamePath).catch(reportError);
          }}>Rename file</button>
          <div className="rho-menu-separator" />
          <button type="button" data-menu-close disabled={binding == null || dirty} onClick={() => {
            void removeResource(contentRef.current, false).catch(reportError);
          }}>Delete file</button>
          {dirty && <button type="button" data-menu-close onClick={() => {
            void removeResource(contentRef.current, true).catch(reportError);
          }}>Discard changes &amp; delete</button>}
        </MenuPopover>
      </div>
      {descriptor?.status === "missing" && <div className="rho-resource-placeholder">This Resource no longer exists. Its Surface placement remains.</div>}
      {descriptor?.status === "unsupported" && <div className="rho-resource-placeholder">No compatible provider claims this Resource.</div>}
      {error != null && <p className="rho-resource-error" role="alert">{error}</p>}
      {source && mode === "source" && descriptor?.status === "ready" && (
        <SourceEditor
          ref={sourceEditorRef}
          ariaLabel={`Source ${binding?.resource_id ?? instance.instance_id}`}
          value={editorValue}
          viewState={{
            cursor_start: view.cursorStart,
            cursor_end: view.cursorEnd,
            scroll_top: view.scrollTop,
          }}
          onChange={(value) => {
            editorValueRef.current = value;
            localDirtyRef.current = true;
            setEditorValue(value);
            setLocalDirty(true);
          }}
          onBlur={(nextView) => {
            void commitDraft().catch(reportError);
            void persistViewState(nextView).catch(reportError);
          }}
          onViewStateChange={(nextView) => {
            void persistViewState(nextView).catch(reportError);
          }}
          onRun={async (execution) => {
            const current = localDirtyRef.current ? await commitDraft() : contentRef.current;
            if (binding == null || current == null) {
              throw new Error("The Source document is not ready for execution.");
            }
            return runSourceExecution({
              ...execution,
              source_path: binding.resource_id,
              document_version: current.document_revision,
            });
          }}
          onRunPendingChange={setSourceRunPending}
          onRunRejected={(message) => reportError(new Error(message))}
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

function PluginTabs({
  block,
  dispatch,
  path,
}: {
  readonly block: Extract<PluginSurfaceBlock, { kind: "tabs" }>;
  readonly dispatch: (controlId: string, kind: PluginSurfaceEventKind, value: string) => void;
  readonly path: string;
}) {
  const [activeTabId, setActiveTabId] = useState(block.active_tab_id);
  const baseId = useId();
  useEffect(() => setActiveTabId(block.active_tab_id), [block.active_tab_id]);
  const active = block.tabs.find((tab) => tab.tab_id === activeTabId) ?? block.tabs[0];
  return <section className="rho-plugin-tabs">
    <div
      role="tablist"
      aria-label="Component sections"
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='tab']")];
        const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
        if (current < 0) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0
          : event.key === "End" ? tabs.length - 1
          : event.key === "ArrowLeft" ? (current - 1 + tabs.length) % tabs.length
          : (current + 1) % tabs.length;
        tabs[next]?.focus();
        tabs[next]?.click();
      }}
    >
      {block.tabs.map((tab) => {
        const selected = tab.tab_id === active?.tab_id;
        return <button
          type="button"
          role="tab"
          aria-selected={selected}
          aria-controls={`${baseId}-panel-${tab.tab_id}`}
          id={`${baseId}-tab-${tab.tab_id}`}
          tabIndex={selected ? 0 : -1}
          key={tab.tab_id}
          onClick={() => setActiveTabId(tab.tab_id)}
        >{tab.label}</button>;
      })}
    </div>
    {active != null && <div
      role="tabpanel"
      id={`${baseId}-panel-${active.tab_id}`}
      aria-labelledby={`${baseId}-tab-${active.tab_id}`}
    >
      <PluginSurfaceBlocks blocks={active.blocks} dispatch={dispatch} path={`${path}:${active.tab_id}`} />
    </div>}
  </section>;
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
      case "tabs": return <PluginTabs block={block} dispatch={dispatch} path={key} key={key} />;
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
  close,
  reportError,
}: {
  readonly request: PluginSurfaceDocumentRequest;
  readonly transport: UiKernelTransport;
  readonly close: () => void;
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
  if (document == null) {
    if (status === "failed") {
      return (
        <SurfaceTaskState
          tone="error"
          title="Project component unavailable"
          detail="Its workspace plugin is disabled or incompatible. Placement and bindings are preserved."
          role="alert"
          className="rho-plugin-surface-state rho-plugin-surface-failed"
        >
          <button type="button" onClick={load}>Try again</button>
          <button type="button" onClick={close}>Close component</button>
        </SurfaceTaskState>
      );
    }
    return <SurfaceTaskState
      tone="loading"
      title="Loading project component…"
      detail="The workspace plugin is preparing its current document."
      role="status"
      busy
      className={`rho-plugin-surface-state rho-plugin-surface-${status}`}
    />;
  }
  return <section className={`rho-plugin-surface-document rho-plugin-surface-${status}`} aria-busy={status === "busy"}>
    {status === "busy" && <div className="rho-plugin-surface-progress" role="status">Updating project component…</div>}
    <header>
      <span>Project component</span><strong>{document.title}</strong>
      <details className="rho-plugin-document-meta"><summary>Document details</summary><small>Workspace plugin · document revision {document.revision}</small></details>
    </header>
    {document.blocks.length === 0
      ? <SurfaceTaskState tone="empty" title="Nothing to show yet" detail="This project component returned an empty document." role="status" />
      : <PluginSurfaceBlocks blocks={document.blocks} dispatch={dispatch} />}
  </section>;
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
    return <SurfaceTaskState tone="empty" title="No Check result yet" detail="Run Check project to create an immutable result." role="status" className="rho-check-empty" />;
  }
  if (result == null) {
    return status === "failed"
      ? <SurfaceTaskState tone="error" title="Check result unavailable" detail="This captured result is no longer available. Run Check project again." role="alert" className="rho-check-empty rho-check-failed" />
      : <SurfaceTaskState tone="loading" title="Loading Check result…" detail="Reading the immutable captured result." role="status" busy className="rho-check-empty rho-check-loading" />;
  }
  return (
    <section className="rho-check-result" data-result-id={result.result_id}>
      <header className="rho-check-summary">
        <div className="rho-check-outcome">
          <span className={`rho-check-status rho-check-status-${result.status}`}>{result.status}</span>
          <div><strong>{result.findings.length === 0 ? "Project check passed" : `${result.findings.length} ${result.findings.length === 1 ? "finding" : "findings"} to review`}</strong><small title={result.generated_at}>Captured {formatHistoryTime(result.generated_at)}</small></div>
        </div>
        <details className="rho-check-result-meta">
          <summary>Result details</summary>
          <dl>
            <div><dt>Files</dt><dd>{result.coverage.files_scanned}</dd></div>
            <div><dt>Core rules</dt><dd>{result.coverage.core_rules}</dd></div>
            <div><dt>Rule packs</dt><dd>{result.coverage.plugin_rule_packs}</dd></div>
          </dl>
          <small>Snapshot <code>{result.snapshot.snapshot_id}</code></small>
        </details>
      </header>
      {result.limitations.length > 0 && <div className="rho-check-limitations" role="status"><strong>Coverage limitations</strong>{result.limitations.map((item) => <p key={item}>{item}</p>)}</div>}
      <div className="rho-check-findings">
        {result.findings.map((finding, index) => (
          <article className={`rho-check-finding rho-check-finding-${finding.severity}`} key={`${finding.rule_id}:${index}`}>
            <header><span>{finding.category}</span><span>{finding.severity}</span></header>
            <h3>{finding.title}</h3>
            <p>{finding.summary}</p>
            <div className="rho-check-remediation"><strong>Next step</strong><span>{finding.remediation}</span></div>
            <div className="rho-check-evidence">
              {finding.evidence.map((evidence, evidenceIndex) => {
                const path = evidence.kind === "source_range" || evidence.kind === "project_file" ? evidence.path : null;
                return path == null
                  ? <span key={evidenceIndex}>{evidenceLabel(evidence)}</span>
                  : <button type="button" onClick={() => void openEvidence(path).catch(reportError)} key={evidenceIndex}>{evidenceLabel(evidence)}</button>;
              })}
            </div>
            <details className="rho-check-rule-meta"><summary>Rule details</summary><div><span>{checkOriginLabel(finding)}</span><code>{finding.rule_id} · v{finding.rule_version}</code></div></details>
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

function AgentRunningRow({ startedAt, onStop }: { readonly startedAt: string; readonly onStop: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const started = Date.parse(startedAt);
  const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
  const label = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <div className="rho-agent-running" role="status">
      <span className="rho-status-dot rho-status-degraded" aria-hidden="true" />
      <span className="rho-agent-running-label">Agent running · {label}</span>
      <button type="button" onClick={onStop}>Stop</button>
    </div>
  );
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
  runtimeOutputContext,
  setRuntimeOutputContext,
}: {
  readonly instance: SurfaceInstance;
  readonly transport: UiKernelTransport;
  readonly health: SurfaceViewProps["agentHealth"];
  readonly persist: (viewState: AgentSurfaceViewState) => Promise<void>;
  readonly pinTask: (turn: AgentTurnSummary) => Promise<void>;
  readonly applyFileProposal: SurfaceViewProps["applyAgentFileProposal"];
  readonly undoFileProposal: SurfaceViewProps["undoAgentFileProposal"];
  readonly reportError: (error: unknown) => void;
  readonly runtimeOutputContext: RuntimeOutputReference | null;
  readonly setRuntimeOutputContext: (reference: RuntimeOutputReference | null) => void;
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
  const [contextPreview, setContextPreview] = useState<{
    readonly key: string;
    readonly plan: AgentContextPlanPreview;
  } | null>(null);
  const [contextReviewBusy, setContextReviewBusy] = useState(false);
  const [capacityOpen, setCapacityOpen] = useState(false);
  const [capacityBusy, setCapacityBusy] = useState(false);
  const [llmSettings, setLlmSettings] = useState<AgentLlmSettingsView | null>(null);
  const [capacityModelId, setCapacityModelId] = useState("");
  const [capacityDraft, setCapacityDraft] = useState({ context: "", reserve: "" });

  const contextPlanKey = JSON.stringify([
    view.composer.trim(),
    view.mode,
    view.conversation_id,
    runtimeOutputContext?.execution_id ?? null,
    runtimeOutputContext?.start_sequence ?? null,
    runtimeOutputContext?.end_sequence ?? null,
    runtimeOutputContext?.range_sha256 ?? null,
  ]);

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
    if (next.composer !== viewRef.current.composer || next.mode !== viewRef.current.mode ||
        next.conversation_id !== viewRef.current.conversation_id) setContextPreview(null);
    viewRef.current = next;
    setView(next);
    if (durable) void persist(next).catch(reportError);
  };
  const selectCapacityModel = (modelId: string, settings = llmSettings) => {
    const model = settings?.models.find((candidate) => candidate.id === modelId);
    setCapacityModelId(modelId);
    setCapacityDraft({
      context: model == null ? "" : String(model.context_window_tokens),
      reserve: model == null ? "" : String(model.reserved_output_tokens),
    });
  };
  const loadContextCapacity = async () => {
    setCapacityBusy(true);
    try {
      const settings = await transport.loadAgentLlmSettings();
      setLlmSettings(settings);
      const model = settings.models.find((candidate) => candidate.id === settings.selected_model_id)
        ?? settings.models[0];
      selectCapacityModel(model?.id ?? "", settings);
    } catch (error: unknown) {
      reportError(error);
    } finally {
      setCapacityBusy(false);
    }
  };
  const saveContextCapacity = async () => {
    if (llmSettings == null || capacityBusy) return;
    const contextWindow = Number(capacityDraft.context);
    const reservedOutput = Number(capacityDraft.reserve);
    if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(reservedOutput)) {
      reportError(new Error("Context capacity must use whole token counts."));
      return;
    }
    setCapacityBusy(true);
    try {
      const settings = await transport.setAgentContextCapacity({
        model_id: capacityModelId,
        expected_revision: llmSettings.revision,
        context_window_tokens: contextWindow,
        reserved_output_tokens: reservedOutput,
      });
      setLlmSettings(settings);
      selectCapacityModel(capacityModelId, settings);
      setContextPreview(null);
    } catch (error: unknown) {
      reportError(error);
    } finally {
      setCapacityBusy(false);
    }
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
  const reviewContext = async () => {
    const prompt = view.composer.trim();
    if (!prompt || contextReviewBusy || busy || health?.state !== "ready") return;
    setContextReviewBusy(true);
    try {
      const plan = await transport.previewAgentContext({
        prompt,
        mode: view.mode,
        task_kind: "agent_turn",
        model_id: null,
        editor_context: null,
        conversation_id: view.conversation_id,
        runtime_output_context: runtimeOutputContext,
      });
      setContextPreview({ key: contextPlanKey, plan });
    } catch (error: unknown) {
      reportError(error);
    } finally {
      setContextReviewBusy(false);
    }
  };
  const submit = async () => {
    const prompt = view.composer.trim();
    if (!prompt || busy || health?.state !== "ready") return;
    const reviewedPlan = contextPreview?.key === contextPlanKey ? contextPreview.plan : null;
    if (runtimeOutputContext != null && reviewedPlan == null) {
      await reviewContext();
      return;
    }
    setBusy(true);
    try {
      const response = await transport.runAgent({
        prompt,
        mode: view.mode,
        task_kind: "agent_turn",
        model_id: null,
        auto_approve: view.mode === "act" && view.auto_approve,
        editor_context: null,
        conversation_id: view.conversation_id,
        runtime_output_context: runtimeOutputContext,
        context_plan_digest: reviewedPlan?.plan_digest ?? null,
      });
      const next = { ...view, conversation_id: response.conversation_id, composer: "" };
      viewRef.current = next;
      setView(next);
      await persist(next);
      setRuntimeOutputContext(null);
      setContextPreview(null);
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
          <div className="rho-agent-degraded-row">
            <div>
              <strong>{health?.label ?? "Agent runtime unavailable"}</strong>
              {health?.detail != null && <p>{health.detail}</p>}
            </div>
            <button type="button" disabled={busy} onClick={() => {
              setBusy(true);
              void transport.retryAgentRuntime()
                .then((diagnostics) => { setRuntimeDiagnostics(diagnostics); return refresh(); })
                .catch(reportError)
                .finally(() => setBusy(false));
            }}>Retry Agent runtime</button>
          </div>
          <details className="rho-agent-runtime-diagnostics">
            <summary>Dependency details</summary>
            <pre>{diagnosticsText}</pre>
            <button type="button" onClick={() => {
              void navigator.clipboard.writeText(diagnosticsText).catch(reportError);
            }}>Copy diagnostics</button>
          </details>
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
        <button type="button" aria-expanded={capacityOpen} disabled={busy} onClick={() => {
          const next = !capacityOpen;
          setCapacityOpen(next);
          if (next) void loadContextCapacity();
        }}>Context</button>
      </header>
      {capacityOpen && <form className="rho-agent-capacity" aria-label="Agent model context capacity" onSubmit={(event) => {
        event.preventDefault();
        void saveContextCapacity();
      }}>
        {llmSettings == null ? <span>{capacityBusy ? "Loading model capacity…" : "Model capacity is unavailable."}</span> : <>
          <label>Model
            <select value={capacityModelId} disabled={capacityBusy} onChange={(event) => selectCapacityModel(event.target.value)}>
              {llmSettings.models.map((model) => <option value={model.id} key={model.id}>{model.display_name}</option>)}
            </select>
          </label>
          <label>Context window
            <input aria-label="Context window tokens" type="number" min="4096" step="1" disabled={capacityBusy} value={capacityDraft.context} onChange={(event) => setCapacityDraft({ ...capacityDraft, context: event.target.value })} />
          </label>
          <label>Reserve for reply
            <input aria-label="Reserved output tokens" type="number" min="256" step="1" disabled={capacityBusy} value={capacityDraft.reserve} onChange={(event) => setCapacityDraft({ ...capacityDraft, reserve: event.target.value })} />
          </label>
          <div>
            <small>{llmSettings.models.find((model) => model.id === capacityModelId)?.context_capacity_source.replaceAll("_", " ")}</small>
            <button type="button" disabled={capacityBusy} onClick={() => void loadContextCapacity()}>Reload</button>
            <button type="submit" className="rho-primary-action" disabled={capacityBusy || !capacityModelId}>{capacityBusy ? "Saving…" : "Save"}</button>
          </div>
        </>}
      </form>}
      {activeTurn != null && (
        <AgentRunningRow startedAt={activeTurn.started_at} onStop={() => {
          setBusy(true);
          void transport.cancelAgentTurn(activeTurn.turn_id)
            .then(() => refresh())
            .catch(reportError)
            .finally(() => setBusy(false));
        }} />
      )}
      {displayMode !== "composer" && (
        <div className="rho-agent-timeline" aria-busy={loading}>
          {loading && <p>Loading conversation…</p>}
          {!loading && turns.length === 0 && <div className="rho-agent-empty" role="status">
            <strong>Ready for the first turn</strong>
            <span>Choose Ask, Plan, or Act, then use the composer below.</span>
          </div>}
          {turns.map((turn) => {
            const detail = details.get(turn.turn_id);
            const proposals = detail?.events.flatMap((event) => {
              const proposal = parseAgentFileProposal(event);
              return proposal == null ? [] : [{ event, proposal }];
            }) ?? [];
            return (
              <article className={`rho-agent-turn rho-agent-turn-${turn.status}`} data-turn-id={turn.turn_id} key={turn.turn_id}>
                <header>
                  <strong>{turn.mode}</strong>
                  {turn.status !== "completed" && <span className={`rho-agent-turn-status rho-agent-turn-status-${turn.status}`}>{turn.status}</span>}
                  <details className="rho-agent-turn-meta">
                    <summary aria-label={`Details for ${turn.mode} turn`}>Details</summary>
                    <div><span>Status</span><strong>{turn.status}</strong><span>Model</span><code>{turn.model}</code></div>
                  </details>
                </header>
                <p className="rho-agent-prompt">{turn.prompt_preview}</p>
                {turn.final_message != null && <p className="rho-agent-answer">{turn.final_message}</p>}
                {turn.error_message != null && <p className="rho-agent-turn-error">{turn.error_message}</p>}
                {detail?.events.filter((event) => event.code != null).map((event) => (
                  <details className="rho-agent-code-review" key={event.id}>
                    <summary>{event.title}</summary><pre>{event.code}</pre>
                  </details>
                ))}
                {(detail?.context_items?.length ?? 0) > 0 && <details className="rho-agent-context-used">
                  <summary>Context used · {detail!.context_items!.length} {detail!.context_items!.length === 1 ? "source" : "sources"}</summary>
                  <ol>{detail!.context_items!.map((item) => <li key={`${item.ordinal}:${item.source_kind}:${item.source_id ?? "current"}`}>
                    <div><strong>{item.source_kind.replaceAll("_", " ")}</strong><span>{item.disposition}</span></div>
                    {item.source_id != null && <code>{item.source_id}</code>}
                    <small>{item.included_bytes.toLocaleString()} of {item.original_bytes.toLocaleString()} bytes · {item.trust_class}</small>
                  </li>)}</ol>
                </details>}
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
              <button type="button" aria-pressed={view.mode === mode} key={mode} onClick={() => commitView({
                ...view,
                mode,
                auto_approve: mode === "act" ? view.auto_approve : false,
              })}>{mode}</button>
            ))}
          </div>
          <small className="rho-agent-mode-hint">{{
            ask: "Ask about this project",
            plan: "Shape a reviewable approach",
            act: "Work with project tools",
          }[view.mode]}</small>
          {runtimeOutputContext != null && <div className="rho-agent-context-chip" role="status">
            <div>
              <strong>Runtime output</strong>
              <span>Chunks {runtimeOutputContext.start_sequence}–{runtimeOutputContext.end_sequence}</span>
              <small>{runtimeOutputContext.payload_bytes.toLocaleString()} bytes · {runtimeOutputContext.range_sha256.slice(0, 10)}</small>
            </div>
            <button type="button" aria-label="Remove Runtime output from Agent context" onClick={() => {
              setRuntimeOutputContext(null);
              setContextPreview(null);
            }}>×</button>
          </div>}
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
          {view.mode === "act" && <label className="rho-agent-auto-approve">
            <input type="checkbox" checked={view.auto_approve} onChange={(event) => commitView({ ...view, auto_approve: event.target.checked })} />
            Auto-approve project tools for this conversation
          </label>}
          <div className="rho-agent-context-controls">
            <button type="button" disabled={busy || contextReviewBusy || health?.state !== "ready" || !view.composer.trim()} onClick={() => void reviewContext()}>
              {contextReviewBusy ? "Reviewing…" : "Review context"}
            </button>
            <button type="button" className="rho-primary-action" disabled={busy || contextReviewBusy || health?.state !== "ready" || !view.composer.trim()} onClick={() => void submit()}>
              {busy ? "Working…" : runtimeOutputContext != null && contextPreview?.key !== contextPlanKey ? "Review before send" : "Send"}
            </button>
          </div>
          {contextPreview?.key === contextPlanKey && <section className="rho-agent-context-preview" aria-label="Agent context preview">
            <header>
              <div><strong>Context plan</strong><small>{contextPreview.plan.model_display_name} · settings r{contextPreview.plan.settings_revision}</small></div>
              <span>{contextPreview.plan.estimated_input_tokens.toLocaleString()} / {(contextPreview.plan.context_window_tokens - contextPreview.plan.reserved_output_tokens).toLocaleString()} tokens</span>
            </header>
            <ol>{contextPreview.plan.items.map((item) => <li key={`${item.ordinal}:${item.source_kind}:${item.source_id ?? "current"}`}>
              <div><strong>{item.source_kind.replaceAll("_", " ")}</strong><span className={`rho-agent-context-disposition rho-agent-context-disposition-${item.disposition}`}>{item.disposition}</span></div>
              {item.source_id != null && <code>{item.source_id}</code>}
              <small>{item.included_bytes.toLocaleString()} / {item.original_bytes.toLocaleString()} bytes · {item.trust_class}{item.reason_code == null ? "" : ` · ${item.reason_code}`}</small>
            </li>)}</ol>
            <footer>Plan {contextPreview.plan.plan_digest.slice(0, 12)} · {contextPreview.plan.capacity_source}</footer>
          </section>}
        </div>
      )}
    </section>
  );
}

const DOMAIN_SURFACE_IDS = new Set([
  "rho.evidence", "rho.git", "rho.runs", "rho.artifacts",
  "rho.problems", "rho.plots", "rho.logs", "rho.render-jobs", "rho.help",
]);

function EnvironmentSurfaceView({
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
  const mode: EnvironmentMode = instance.mode_id === "requests" ? "requests" : "packages";
  const [filter, setFilter] = useState(initialFilter);
  const [searchOpen, setSearchOpen] = useState(Boolean(initialFilter));
  const [data, setData] = useState<DomainSurfaceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await transport.loadDomainSurface(instance.surface_id));
      setError(null);
    } catch (cause: unknown) {
      setError(boundedFailureMessage(cause, "Environment could not load."));
    } finally {
      setLoading(false);
    }
  }, [instance.surface_id, transport]);
  useEffect(() => {
    void load();
    return transport.subscribeInvalidated(() => void load());
  }, [load, transport]);
  const modeItems = environmentItemsForMode(data?.items ?? [], mode);
  const items = modeItems.filter((item) => environmentMatches(item, filter));
  const summary = environmentSummary(modeItems, mode);
  const closeSearch = () => {
    setFilter("");
    setSearchOpen(false);
    void persist({ filter: "" }).catch(reportError);
  };
  return (
    <section className="rho-environment-surface" aria-label="Project environment">
      <header className="rho-environment-toolbar">
        <div>
          <strong>{loading && data == null ? "Loading environment…" : summary.title}</strong>
          <small>{loading && data == null ? "Reading project state" : summary.subtitle}</small>
        </div>
        <button
          type="button"
          className="rho-icon-btn"
          aria-label={searchOpen ? "Close environment search" : "Search environment"}
          aria-expanded={searchOpen}
          onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}
        >
          {searchOpen ? "×" : <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="m10 10 3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>}
        </button>
        <button type="button" className="rho-icon-btn" aria-label="Refresh environment" disabled={loading} onClick={() => void load()}>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M13 5V2.5L11.4 4A5 5 0 1 0 13 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </header>
      {searchOpen && <div className="rho-environment-search">
        <input
          autoFocus
          type="search"
          aria-label="Filter environment"
          placeholder={mode === "packages" ? "Find a package…" : "Find an operation…"}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onBlur={() => void persist({ filter }).catch(reportError)}
          onKeyDown={(event) => { if (event.key === "Escape") closeSearch(); }}
        />
      </div>}
      {error != null && <SurfaceTaskState tone="error" title="Environment unavailable" detail={error} role="alert" className="rho-environment-error">
        <button type="button" onClick={() => void load()}>Try again</button>
      </SurfaceTaskState>}
      {error == null && <div className="rho-environment-records" aria-busy={loading}>
        {loading && data == null && <SurfaceTaskState tone="loading" title="Loading environment…" detail="Reading the current project library and operation requests." role="status" busy />}
        {!loading && items.length === 0 && <SurfaceTaskState
          tone="empty"
          title={filter ? "No matching results" : mode === "packages" ? "No packages resolved yet" : "No environment operations yet"}
          detail={filter ? "Try a package name, version, or status." : mode === "packages" ? "Package state will appear after the project library is inspected." : "Restore and install requests will appear here when they exist."}
          role="status"
          className="rho-environment-empty"
        />}
        {items.map((item) => {
          const tone = environmentTone(item);
          const detail = environmentDetail(item);
          return <article className={`rho-environment-record rho-environment-${tone}`} data-environment-id={item.id} key={item.id}>
            <span className={`rho-environment-indicator rho-environment-indicator-${tone}`} aria-hidden="true" />
            <div><strong>{item.title}</strong>{item.subtitle != null && <small>{item.subtitle}</small>}</div>
            <span className={`rho-domain-state rho-domain-${item.status ?? "neutral"}`}>{item.status ?? "unknown"}</span>
            {detail != null && <p>{detail}</p>}
          </article>;
        })}
      </div>}
    </section>
  );
}

interface DomainSurfaceViewProps {
  readonly instance: SurfaceInstance;
  readonly transport: UiKernelTransport;
  readonly persist: (viewState: unknown) => Promise<void>;
  readonly reportError: (error: unknown) => void;
  readonly useRuntimeOutputInAgent: (reference: RuntimeOutputReference) => void;
  readonly openSurfaceById: (surfaceId: string) => void;
}

function DomainSurfaceView(props: DomainSurfaceViewProps) {
  const { instance, transport, persist, reportError, useRuntimeOutputInAgent, openSurfaceById } = props;
  const initialFilter = typeof instance.view_state === "object" && instance.view_state != null &&
      "filter" in instance.view_state && typeof instance.view_state.filter === "string"
    ? instance.view_state.filter
    : "";
  if (instance.surface_id === "rho.runs") {
    return <RuntimeHistory
      transport={transport}
      initialFilter={initialFilter}
      persistFilter={(nextFilter) => persist({ filter: nextFilter })}
      reportError={reportError}
      useInAgent={useRuntimeOutputInAgent}
      openOutputReference={(kind) => openSurfaceById(kind === "plot" ? "rho.plots" : "rho.artifacts")}
    />;
  }
  return <GenericDomainSurfaceView {...props} />;
}

function GenericDomainSurfaceView({
  instance,
  transport,
  persist,
  reportError,
}: DomainSurfaceViewProps) {
  const initialFilter = typeof instance.view_state === "object" && instance.view_state != null &&
      "filter" in instance.view_state && typeof instance.view_state.filter === "string"
    ? instance.view_state.filter
    : "";
  const [filter, setFilter] = useState(initialFilter);
  const [searchOpen, setSearchOpen] = useState(Boolean(initialFilter) ||
    (instance.surface_id === "rho.help" && instance.mode_id === "search"));
  const [data, setData] = useState<DomainSurfaceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await transport.loadDomainSurface(instance.surface_id));
      setError(null);
    } catch (cause: unknown) {
      setError(boundedFailureMessage(cause, "This component could not load."));
    } finally {
      setLoading(false);
    }
  }, [instance.surface_id, transport]);
  useEffect(() => {
    void load();
    return transport.subscribeInvalidated(() => void load());
  }, [load, transport]);
  const modeItems = domainItemsForMode(instance.surface_id, instance.mode_id, data?.items ?? []);
  const items = modeItems.filter((item) => domainMatches(instance.surface_id, item, filter));
  const summary = domainSummary(instance.surface_id, modeItems);
  const kind = domainPresentationKind(instance.surface_id);
  const strip = instance.surface_id === "rho.logs" || instance.surface_id === "rho.problems";
  const closeSearch = () => {
    setFilter("");
    setSearchOpen(false);
    void persist({ filter: "" }).catch(reportError);
  };
  return (
    <section className={`rho-domain-surface rho-domain-kind-${kind} ${strip ? "rho-domain-strip" : ""}`} data-domain-kind={kind}>
      <header className="rho-domain-toolbar">
        <div>
          <strong>{loading && data == null ? "Loading…" : summary.title}</strong>
          <small>{loading && data == null ? "Reading project state" : summary.subtitle}</small>
        </div>
        {!strip && <button
          type="button"
          className="rho-icon-btn"
          aria-label={searchOpen ? `Close ${instance.surface_id} search` : `Search ${instance.surface_id}`}
          aria-expanded={searchOpen}
          onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}
        >
          {searchOpen ? "×" : <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="m10 10 3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>}
        </button>}
        <button type="button" className="rho-icon-btn" aria-label={`Refresh ${instance.surface_id}`} disabled={loading} onClick={() => void load()}>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M13 5V2.5L11.4 4A5 5 0 1 0 13 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </header>
      {searchOpen && !strip && <div className="rho-domain-search">
        <input
          autoFocus
          type="search"
          aria-label={`Filter ${instance.surface_id}`}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onBlur={() => void persist({ filter }).catch(reportError)}
          onKeyDown={(event) => { if (event.key === "Escape") closeSearch(); }}
          placeholder={kind === "help" ? "Find a command or topic…" : "Search this view…"}
        />
      </div>}
      {error != null && <SurfaceTaskState tone="error" title="This view is unavailable" detail={error} role="alert" className="rho-domain-error">
        <button type="button" onClick={() => void load()}>Try again</button>
      </SurfaceTaskState>}
      {error == null && <div className="rho-domain-records" aria-busy={loading}>
        {loading && data == null && <SurfaceTaskState tone="loading" title="Loading this view…" detail="Reading the current project records." role="status" busy />}
        {!loading && items.length === 0 && (() => {
          const empty = domainEmptyState(instance.surface_id, Boolean(filter.trim()));
          return <SurfaceTaskState tone="empty" title={empty.title} detail={empty.detail} role="status" className="rho-domain-empty" />;
        })()}
        {items.map((item) => {
          const projected = domainItemPresentation(instance.surface_id, item);
          return <article className={`rho-domain-record rho-domain-record-${projected.tone}`} data-domain-id={item.id} key={item.id}>
            {kind === "outputs" && instance.surface_id === "rho.plots" && (
              <PlotThumbnail plotId={item.id} transport={transport} />
            )}
            <span className={`rho-domain-indicator rho-domain-indicator-${projected.tone}`} aria-hidden="true" />
            <div className="rho-domain-record-copy">
              <strong title={projected.title}>{projected.title}</strong>
              {projected.code != null && <pre className="rho-domain-code"><code>{projected.code}</code></pre>}
              {projected.description != null && <p>{projected.description}</p>}
              {projected.meta.length > 0 && <ul aria-label={`Facts for ${projected.title}`}>{projected.meta.map((fact) => <li key={fact}>{fact}</li>)}</ul>}
            </div>
            <span className={`rho-domain-state rho-domain-${projected.status}`}>{projected.status}</span>
            {projected.disclosureLabel != null && projected.disclosureText != null && <details className="rho-domain-disclosure">
              <summary>{projected.disclosureLabel}</summary><pre>{projected.disclosureText}</pre>
            </details>}
            {!strip && instance.surface_id === "rho.runs" && (projected.status === "failed" || projected.status === "cancelled") && (
              <button type="button" className="rho-domain-row-action" disabled={busyId === item.id} onClick={() => {
                setBusyId(item.id);
                void transport.retryRun(item.id).then(load).catch(reportError).finally(() => setBusyId(null));
              }}>{busyId === item.id ? "Starting…" : "Run again"}</button>
            )}
          </article>;
        })}
      </div>}
    </section>
  );
}

function SurfaceView({
  instance, focused, setFocus, remove, duplicate, suspend, resume, persistDraft, draftCache,
  consoleSessionCache,
  availableModes, setMode,
  runtimes, attachRuntime, detachRuntime, startRuntimeExecution, followRuntimeOutput,
  listRuntimeExecutions, loadRuntimeOutputPage, interruptRuntime,
  loadRuntimeOutputPageBefore,
  restartRuntime, persistConsole, registerConsoleExecution, markConsolePreferred,
  runSourceExecution, resources, readResource, updateResourceDraft,
  saveResource, reloadResource, renameResource, deleteResource,
  refreshResourceBinding, setViewGroup, persistFileViewState, reportError,
  pluginTransport, pluginDocumentRequest, projectRevision, openCheckEvidence,
  agentHealth, persistAgentViewState, persistSurfaceViewState, pinAgentTask,
  applyAgentFileProposal, undoAgentFileProposal, openNavigatorFile, openSurfaceById,
  agentRuntimeOutputContext, setAgentRuntimeOutputContext,
  paneNodeId, paneMemberCount, studioDrag,
  embedded,
}: SurfaceViewProps) {
  const [draft, setDraft] = useState(() => initialDraft(instance, draftCache));
  const [consoleController] = useState(() => new ConsoleInstanceController(
    consoleSessionCache.get(instance.instance_id) ?? initialConsoleState(instance)
  ));
  const consoleSnapshot = useSyncExternalStore(consoleController.subscribe, consoleController.getSnapshot);
  const consoleState = consoleSnapshot.state;
  const consoleRunning = consoleSnapshot.running;
  const [consoleFilterOpen, setConsoleFilterOpen] = useState(() =>
    Boolean(initialConsoleState(instance).filter.trim())
  );
  const [consoleSearch, setConsoleSearch] = useState<RuntimeOutputSearchResult | null>(null);
  const [consoleSearchBusy, setConsoleSearchBusy] = useState(false);
  const consoleOutputRef = useRef<HTMLDivElement>(null);
  const consoleCompactionRevisionRef = useRef<number | null>(null);
  const dndEnabled = !embedded && paneNodeId != null;
  const runtime = instance.runtime_binding;
  const uxProfile = surfaceUxProfile(instance.surface_id);
  const isStrip = uxProfile.areaRole === "strip";
  const title = uxProfile.label;
  const paneDropZone = studioDrag.visual?.target?.nodeId === paneNodeId &&
    !studioDrag.visual.target.zone.startsWith("tab-")
    ? studioDrag.visual.target.zone as Exclude<StudioDropZone, "tab-before" | "tab-after">
    : null;
  const attached = runtimes?.instances.find((candidate) =>
    candidate.runtime_instance_id === runtime?.runtime_instance_id &&
    candidate.activation_generation === runtime.activation_generation
  ) ?? null;
  consoleController.configure({
    runtime: attached,
    start: startRuntimeExecution,
    follow: followRuntimeOutput,
    list: listRuntimeExecutions,
    page: loadRuntimeOutputPage,
    pageBefore: loadRuntimeOutputPageBefore,
    persist: persistConsole,
    reportError,
  });
  useEffect(() => () => consoleController.dispose(), [consoleController]);
  useEffect(() => {
    if (instance.surface_id === "rho.console") {
      consoleSessionCache.set(instance.instance_id, consoleState);
    }
  }, [consoleSessionCache, consoleState, instance.instance_id, instance.surface_id]);
  useEffect(() => {
    if (instance.surface_id !== "rho.console" || !needsConsoleStateCompaction(instance)) return;
    if (consoleCompactionRevisionRef.current === instance.surface_revision) return;
    consoleCompactionRevisionRef.current = instance.surface_revision;
    void consoleController.persistCurrent();
  }, [consoleController, instance, instance.surface_id, instance.surface_revision]);
  const runtimeRecovering = attached != null &&
    (attached.status === "restarting" || attached.status === "starting");
  const consoleBusy = consoleRunning || attached?.status === "busy";
  const consoleNeedle = consoleState.filter.trim().toLowerCase();
  const transcriptOutputs = consoleTranscriptOutputs(consoleState);
  const filteredOutputs = transcriptOutputs.flatMap((output) =>
    !consoleNeedle || outputText(output).toLowerCase().includes(consoleNeedle)
      ? [{ output, ordinal: consoleState.outputs.indexOf(output) + 1 }]
      : []
  );
  useEffect(() => {
    if (instance.surface_id !== "rho.console" || !consoleNeedle) {
      setConsoleSearch(null);
      setConsoleSearchBusy(false);
      return undefined;
    }
    let active = true;
    setConsoleSearchBusy(true);
    const timer = window.setTimeout(() => {
      void pluginTransport.searchRuntimeOutput({
        query: consoleState.filter.trim(),
        console_instance_id: instance.instance_id,
        ...(consoleState.transcript_start_after == null
          ? {}
          : { started_after: consoleState.transcript_start_after.started_at }),
        limit: 100,
      }).then((result) => {
        if (active && result.query.toLowerCase() === consoleNeedle) setConsoleSearch(result);
      }).catch((cause: unknown) => {
        if (active) reportError(cause);
      }).finally(() => {
        if (active) setConsoleSearchBusy(false);
      });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [
    consoleNeedle,
    consoleState.filter,
    consoleState.transcript_start_after,
    instance.instance_id,
    instance.surface_id,
    pluginTransport,
    reportError,
  ]);
  const mountedSearchIds = new Set(filteredOutputs.map(({ output }) => output.execution_id));
  const durableSearchHits = consoleSearch?.hits.filter((hit) => !mountedSearchIds.has(hit.execution_id)) ?? [];
  const transcriptTail = transcriptOutputs.at(-1) ?? null;
  const consoleTailRevision = transcriptTail == null
    ? "empty"
    : `${transcriptTail.execution_id}:${transcriptTail.last_sequence ?? 0}:${transcriptTail.blocks.length}`;
  const commitConsole = useCallback((next: ConsoleViewState) => {
    return consoleController.commit(next);
  }, [consoleController]);
  const closeConsoleFilter = () => {
    setConsoleFilterOpen(false);
    if (consoleState.filter !== "") commitConsole({ ...consoleState, filter: "" });
  };
  const submitConsoleCode = useCallback((
    code: string,
    clearDraft: boolean,
    sourceContext?: RuntimeExecutionSourceContext,
  ): ConsoleExecutionAdmission => {
    return consoleController.submit(code, clearDraft, sourceContext);
  }, [consoleController]);
  const submitConsole = () => {
    const admission = submitConsoleCode(consoleController.getSnapshot().state.draft.trim(), true);
    if (!admission.accepted && admission.message != null) reportError(new Error(admission.message));
    return admission;
  };
  useEffect(() => {
    if (instance.surface_id !== "rho.console") return undefined;
    return registerConsoleExecution({
      instanceId: instance.instance_id,
      submitSource: (execution) => submitConsoleCode(execution.code, false, {
        source_path: execution.source_path,
        execution_mode: execution.kind,
        document_version: execution.document_version,
        source_range: execution.range,
      }),
    });
  }, [instance.instance_id, instance.surface_id, registerConsoleExecution, submitConsoleCode]);
  useLayoutEffect(() => {
    if (!consoleState.follow_tail) return;
    const element = consoleOutputRef.current;
    if (element == null) return;
    element.scrollTop = element.scrollHeight;
    const scrollTop = element.scrollTop;
    const current = consoleController.getSnapshot().state;
    const tail = consoleTranscriptOutputs(current).at(-1) ?? null;
    const readCursor = tail == null
      ? current.read_cursor
      : { execution_id: tail.execution_id, sequence: tail.last_sequence ?? 0 };
    if (current.scroll_top !== scrollTop
        || JSON.stringify(current.read_cursor) !== JSON.stringify(readCursor)) {
      consoleController.replaceState({ ...current, scroll_top: scrollTop, read_cursor: readCursor });
    }
  }, [consoleController, consoleState.follow_tail, consoleTailRevision]);
  return (
    <article
      className={`rho-surface rho-surface-${instance.lifecycle_state} ${focused ? "rho-surface-focused" : ""} ${isStrip ? "rho-surface-strip" : ""}`}
      data-instance-id={instance.instance_id}
      data-surface-id={instance.surface_id}
      data-surface-area={uxProfile.areaRole}
      data-surface-narrow={uxProfile.narrowBehavior}
      data-surface-default-focus={uxProfile.defaultFocus}
      aria-label={`${title} component`}
      data-studio-drop-node-id={dndEnabled ? paneNodeId : undefined}
      data-studio-drop-instance-id={dndEnabled ? instance.instance_id : undefined}
      data-studio-drop-member-count={dndEnabled ? paneMemberCount : undefined}
      data-studio-drop-label={dndEnabled ? title : undefined}
      onPointerDown={embedded && instance.surface_id !== "rho.console" ? undefined : () => {
        if (instance.surface_id === "rho.console") markConsolePreferred(instance.instance_id);
        if (!embedded) setFocus();
      }}
    >
      <header className="rho-surface-chrome">
        <div
          className="rho-surface-title"
          data-studio-drag-source={dndEnabled ? instance.instance_id : undefined}
          onPointerDown={dndEnabled ? (event) => {
            event.stopPropagation();
            if (instance.surface_id === "rho.console") markConsolePreferred(instance.instance_id);
            studioDrag.begin(event, instance.instance_id, title);
          } : undefined}
          onClick={dndEnabled ? (event) => {
            if (!studioDrag.consumeSuppressedClick(event.currentTarget)) setFocus();
          } : undefined}
        ><strong>{title}</strong></div>
        {!embedded && <div className="rho-surface-actions" onPointerDown={(event) => event.stopPropagation()}>
          <MenuPopover
            label={`More actions for ${title}`}
            glyph={<span aria-hidden="true">•••</span>}
            viewportBound={instance.surface_id === "rho.console"}
          >
            <div className="rho-menu-heading"><strong>{title}</strong></div>
            {instance.lifecycle_state === "active" || instance.lifecycle_state === "hidden"
              ? <button type="button" data-menu-close onClick={() => void suspend().catch(reportError)}>Pause component</button>
              : instance.lifecycle_state === "suspended"
                ? <button type="button" data-menu-close onClick={() => void resume().catch(reportError)}>Resume component</button>
                : null}
            <button type="button" data-menu-close onClick={duplicate}>Duplicate component</button>
            {availableModes.length > 1 && <>
              <div className="rho-menu-separator" />
              <div className="rho-menu-heading"><strong>View</strong></div>
              {availableModes.map((mode) => (
                <button
                  type="button"
                  data-menu-close
                  aria-pressed={instance.mode_id === mode.mode_id}
                  key={mode.mode_id}
                  onClick={() => void setMode(mode.mode_id).catch(reportError)}
                >{instance.mode_id === mode.mode_id ? "✓ " : ""}{mode.label}</button>
              ))}
            </>}
            {instance.surface_id === "rho.console" && (
              <>
                <div className="rho-menu-separator" />
                <button
                  type="button"
                  data-menu-close
                  disabled={attached == null || consoleBusy}
                  onClick={() => {
                    if (attached != null) void restartRuntime(attached).catch(reportError);
                  }}
                >Restart {attached?.display_label ?? "runtime"}</button>
                <button
                  type="button"
                  data-menu-close
                  disabled={transcriptOutputs.length === 0 && consoleState.filter === ""}
                  onClick={() => {
                    const tail = consoleState.outputs.at(-1) ?? null;
                    setConsoleFilterOpen(false);
                    commitConsole({
                      ...consoleState,
                      filter: "",
                      scroll_top: 0,
                      follow_tail: true,
                      transcript_start_after: tail == null ? consoleState.transcript_start_after : {
                        execution_id: tail.execution_id,
                        started_at: tail.started_at ?? "0000-01-01T00:00:00Z",
                      },
                      read_cursor: tail == null ? consoleState.read_cursor : {
                        execution_id: tail.execution_id,
                        sequence: tail.last_sequence ?? 0,
                      },
                    });
                  }}
                >Start new transcript</button>
              </>
            )}
            <div className="rho-menu-separator" />
            <dl className="rho-menu-facts">
              <div><dt>Component</dt><dd>{instance.surface_id}</dd></div>
              <div><dt>Revision</dt><dd>{instance.surface_revision}</dd></div>
              <div><dt>Runtime</dt><dd>{runtime?.runtime_instance_id ?? (instance.surface_id === "rho.console" ? "Not attached" : "None")}</dd></div>
            </dl>
          </MenuPopover>
          <button type="button" className="rho-icon-btn" onClick={remove} aria-label={`Remove ${instance.instance_id} from layout`}>×</button>
        </div>}
      </header>
      {instance.lifecycle_state === "suspended" ? (
        <SurfaceTaskState tone="paused" title="Component paused" detail="Its durable binding is preserved while the renderer and derived payloads are released." role="status" className="rho-surface-lifecycle-state">
          <button type="button" onClick={() => void resume().catch(reportError)}>Resume component</button>
        </SurfaceTaskState>
      ) : instance.lifecycle_state === "failed" ? (
        <SurfaceTaskState tone="error" title="Component failed" detail="The failed projection is isolated; project data, Runtime and sibling components remain available." role="alert" className="rho-surface-lifecycle-state rho-surface-lifecycle-failed" />
      ) : instance.lifecycle_state === "placeholder" ? (
        <SurfaceTaskState tone="attention" title="Component provider unavailable" detail="The exact placement and binding are preserved without showing stale plugin or Runtime content." role="status" className="rho-surface-lifecycle-state rho-surface-lifecycle-placeholder">
          <button type="button" onClick={() => void resume().catch(reportError)}>Try again</button>
          <button type="button" onClick={remove}>Close component</button>
        </SurfaceTaskState>
      ) : <>
      {instance.surface_id === "rho.console" && (
        <div className="rho-console-surface">
          <div className="rho-console-toolbar">
            {consoleFilterOpen ? (
              <div className="rho-console-filterbar" role="search">
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="m10 10 3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <input
                  autoFocus
                  type="search"
                  aria-label={`Filter output ${instance.instance_id}`}
                  value={consoleState.filter}
                  onChange={(event) => consoleController.replaceState({ ...consoleState, filter: event.target.value })}
                  onBlur={() => void consoleController.persistCurrent()}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") closeConsoleFilter();
                  }}
                  placeholder="Find in output…"
                />
                <span>{consoleSearchBusy
                  ? "Searching History…"
                  : consoleSearch == null
                    ? `${filteredOutputs.length} / ${transcriptOutputs.length}`
                    : `${consoleSearch.matched_execution_count} / ${consoleSearch.searched_execution_count}`}</span>
                <button type="button" className="rho-icon-btn" aria-label="Close output filter" onClick={closeConsoleFilter}>×</button>
              </div>
            ) : (
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
                      {candidate.display_label}
                    </option>
                  ))}
                </select>
                <span className={`rho-runtime-state rho-runtime-${attached?.status ?? "unbound"}`}>
                  {attached?.status ?? "unbound"}
                </span>
                {transcriptOutputs.length > 0 && (
                  <button
                    type="button"
                    className="rho-icon-btn rho-console-search-toggle"
                    aria-label="Filter Console output"
                    aria-expanded="false"
                    onClick={() => setConsoleFilterOpen(true)}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                      <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                      <path d="m10 10 3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="rho-console-output-region">
            <div
              className="rho-console-output"
              ref={(element) => {
                consoleOutputRef.current = element;
                if (element != null && Math.abs(element.scrollTop - consoleState.scroll_top) > 1) {
                  element.scrollTop = consoleState.scroll_top;
                }
              }}
              onBlur={(event) => {
                const scrollTop = event.currentTarget.scrollTop;
                const current = consoleController.getSnapshot().state;
                if (scrollTop !== current.scroll_top) consoleController.replaceState({ ...current, scroll_top: scrollTop });
                void consoleController.persistCurrent();
              }}
              onScroll={(event) => {
                const element = event.currentTarget;
                const followTail = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
                const current = consoleController.getSnapshot().state;
                const tail = consoleTranscriptOutputs(current).at(-1) ?? null;
                const readCursor = followTail && tail != null
                  ? { execution_id: tail.execution_id, sequence: tail.last_sequence ?? 0 }
                  : current.read_cursor;
                if (current.scroll_top !== element.scrollTop
                    || current.follow_tail !== followTail
                    || JSON.stringify(current.read_cursor) !== JSON.stringify(readCursor)) {
                  consoleController.replaceState({
                    ...current,
                    scroll_top: element.scrollTop,
                    follow_tail: followTail,
                    read_cursor: readCursor,
                  });
                }
              }}
              onPointerUp={() => void consoleController.persistCurrent()}
              onKeyUp={() => void consoleController.persistCurrent()}
              aria-label="R Console transcript"
              aria-live={consoleState.follow_tail ? "polite" : "off"}
              aria-relevant="additions text"
              data-follow-tail={consoleState.follow_tail ? "true" : "false"}
              tabIndex={0}
            >
            {transcriptOutputs.length === 0 && (
              <div className="rho-console-empty" role="status">
                <span aria-hidden="true">&gt;_</span>
                <strong>{attached == null
                  ? "Attach a runtime to begin"
                  : "Ready for R code"}</strong>
              </div>
            )}
            {transcriptOutputs.length > 0 && filteredOutputs.length === 0 && durableSearchHits.length === 0 && (
              <div className="rho-console-empty rho-console-no-match" role="status">
                <strong>No output matches “{consoleState.filter.trim()}”</strong>
                <button type="button" onClick={() => commitConsole({ ...consoleState, filter: "" })}>Clear filter</button>
              </div>
            )}
            {consoleNeedle && consoleSearch != null && <div className="rho-console-search-scope" role="status">
              <span>Searched {consoleSearch.searched_execution_count} durable {consoleSearch.searched_execution_count === 1 ? "execution" : "executions"}{consoleState.transcript_start_after == null ? "" : " since this transcript started"}.</span>
              {consoleSearch.incomplete_execution_count > 0 && <span>{consoleSearch.incomplete_execution_count} had partial, unavailable, or pruned output.</span>}
              {consoleSearch.truncated && <span>Showing the first 100 matches.</span>}
            </div>}
            {durableSearchHits.length > 0 && <div className="rho-console-durable-search-results" aria-label="Matches in durable Console History">
              {durableSearchHits.map((hit) => <article key={`${hit.execution_id}:${hit.sequence}`}>
                <div><strong>{hit.presentation_kind === "code" ? "Submitted code" : hit.presentation_kind}</strong><code>#{hit.sequence}</code></div>
                <pre>{hit.preview}</pre>
                <footer>
                  <button type="button" onClick={() => openSurfaceById("rho.runs")}>Open in History</button>
                  {hit.reference_kind != null && <button type="button" data-reference-id={hit.reference_id ?? undefined} onClick={() => openSurfaceById(hit.reference_kind === "plot" ? "rho.plots" : "rho.artifacts")}>Open {hit.reference_kind === "plot" ? "Plot" : "Artifact"}</button>}
                </footer>
              </article>)}
            </div>}
            {consoleState.released_output_count > 0 && (
              <div className="rho-console-retention-notice" role="status">
                <span>{consoleState.released_output_count} older {consoleState.released_output_count === 1 ? "entry was" : "entries were"} released from this live view.</span>
                <button type="button" onClick={() => openSurfaceById("rho.runs")}>Open History</button>
              </div>
            )}
            {filteredOutputs.map(({ output, ordinal }) => (
              <section
                className="rho-console-entry"
                aria-label={`R Console execution ${ordinal}`}
                key={output.execution_id}
              >
                {output.has_older && <button
                  type="button"
                  className="rho-console-load-older"
                  onClick={() => {
                    const element = consoleOutputRef.current;
                    const beforeHeight = element?.scrollHeight ?? 0;
                    const beforeTop = element?.scrollTop ?? 0;
                    void consoleController.loadOlder(output.execution_id).then(() => {
                      window.requestAnimationFrame(() => {
                        if (element != null) element.scrollTop = beforeTop + element.scrollHeight - beforeHeight;
                      });
                    }).catch(reportError);
                  }}
                >Load earlier output</button>}
                {output.newer_output_omitted && <div className="rho-console-window-notice" role="status">
                  <span>Newer chunks were released from this bounded reading window.</span>
                  <button type="button" onClick={() => void consoleController.loadLatest(output.execution_id).catch(reportError)}>Return to latest output</button>
                </div>}
                <header>
                  <span>{
                    runtimes?.instances.find((candidate) =>
                      candidate.runtime_instance_id === output.runtime_instance_id
                    )?.display_label ?? "R runtime"
                  }</span>
                  {(() => {
                    const stateLabel = `${output.status ?? "completed"}${output.output_state != null && !["collecting", "complete"].includes(output.output_state)
                      ? ` · ${output.output_state}`
                      : ""}`;
                    /* A completed execution is the norm; only attention states earn a
                       label, but the slot keeps the header layout stable. */
                    return (
                      <span className={`rho-console-entry-state rho-console-entry-state-${output.status ?? "completed"}`}>
                        {stateLabel === "completed" ? "" : stateLabel}
                      </span>
                    );
                  })()}
                  <span>#{ordinal}</span>
                  <button type="button" onClick={() => openSurfaceById("rho.runs")}>Open in History</button>
                </header>
                <code><span aria-hidden="true">&gt;</span> {output.code}</code>
                <div className="rho-console-results">
                  {output.blocks.map((result, index) => (
                    <div className={`rho-console-result rho-console-result-${result.kind}`} key={`${result.kind}:${index}`}>
                      {result.label != null && <strong>{result.label}</strong>}
                      <pre>{result.text}</pre>
                      {result.reference != null && <button
                        type="button"
                        className="rho-runtime-output-reference"
                        data-reference-id={result.reference.id}
                        onClick={() => openSurfaceById(result.reference!.kind === "plot" ? "rho.plots" : "rho.artifacts")}
                      >Open {result.reference.kind === "plot" ? "Plot" : "Artifact"}</button>}
                    </div>
                  ))}
                </div>
              </section>
            ))}
            </div>
            {!consoleState.follow_tail && transcriptOutputs.length > 0 && (
              <button
                type="button"
                className="rho-console-jump-latest"
                onClick={() => commitConsole({ ...consoleState, follow_tail: true })}
              >Jump to latest</button>
            )}
            {consoleRunning && <div className="rho-console-busybar" role="progressbar" aria-label="Console is running code" />}
          </div>
          <div className="rho-console-composer">
            <div className="rho-console-input-row">
              <span className="rho-console-prompt" aria-hidden="true">&gt;</span>
              <textarea
                rows={1}
                ref={(element) => {
                  if (element == null) return;
                  element.style.height = "auto";
                  element.style.height = `${element.scrollHeight}px`;
                }}
                aria-label={`Code for ${instance.instance_id}`}
                aria-describedby={`rho-console-hint-${instance.instance_id}`}
                title="Return to run · Shift+Return for a new line · Up/Down for history"
                value={consoleState.draft}
                disabled={attached == null || consoleRunning}
                onChange={(event) => consoleController.replaceState({ ...consoleState, draft: event.target.value, history_cursor: null })}
                onBlur={() => void consoleController.persistCurrent()}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void submitConsole();
                    return;
                  }
                  if ((event.key === "ArrowUp" || event.key === "ArrowDown") && consoleState.history.length > 0) {
                    const atBoundary = event.key === "ArrowUp"
                      ? event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0
                      : event.currentTarget.selectionStart === event.currentTarget.value.length &&
                        event.currentTarget.selectionEnd === event.currentTarget.value.length;
                    if (!atBoundary) return;
                    event.preventDefault();
                    const current = consoleState.history_cursor ?? consoleState.history.length;
                    const cursor = event.key === "ArrowUp"
                      ? Math.max(0, current - 1)
                      : Math.min(consoleState.history.length, current + 1);
                    consoleController.replaceState({
                      ...consoleState,
                      history_cursor: cursor === consoleState.history.length ? null : cursor,
                      draft: cursor === consoleState.history.length ? "" : consoleState.history[cursor] ?? "",
                    });
                  }
                }}
                placeholder={attached == null ? "Attach this Console to a Runtime" : "R code…"}
              />
              <button
                type="button"
                className={consoleBusy ? "rho-console-stop" : "rho-primary-action"}
                disabled={attached == null || (!consoleBusy && !consoleState.draft.trim())}
                onClick={() => {
                  if (consoleBusy && attached != null) void interruptRuntime(attached).catch(reportError);
                  else void submitConsole();
                }}
              >{consoleBusy ? "Stop" : "Run"}</button>
            </div>
            <div className="rho-console-input-hint rho-visually-hidden" id={`rho-console-hint-${instance.instance_id}`}>
              <span>Return to run</span>
              <span>Shift+Return for a new line</span>
              {consoleState.history.length > 0 && <span>↑↓ history</span>}
            </div>
          </div>
          {runtimeRecovering && attached != null && (
            <div className="rho-console-recovering" role="alert">
              <div className="rho-console-recovering-card">
                <span className="rho-preparation-spinner" aria-hidden="true" />
                <strong>{attached.display_label} is restarting</strong>
                <p>The workbench preserves this Console and its drafts while the Runtime recovers.</p>
                <div className="rho-console-recovering-actions">
                  <button type="button" onClick={() => void interruptRuntime(attached).catch(reportError)}>Cancel restart</button>
                  <button type="button" onClick={() => openSurfaceById("rho.logs")}>Open diagnostics</button>
                </div>
              </div>
            </div>
          )}
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
          runSourceExecution={(execution) => runSourceExecution(instance.instance_id, execution)}
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
          runtimeOutputContext={agentRuntimeOutputContext}
          setRuntimeOutputContext={setAgentRuntimeOutputContext}
        />
      )}
      {instance.surface_id === "rho.navigator" && (
        <NavigatorSurfaceView
          instance={instance}
          transport={pluginTransport}
          resources={resources}
          openFile={openNavigatorFile}
          persist={persistSurfaceViewState}
          reportError={reportError}
        />
      )}
      {instance.surface_id === "rho.environment" && (
        <EnvironmentSurfaceView
          instance={instance}
          transport={pluginTransport}
          persist={persistSurfaceViewState}
          reportError={reportError}
        />
      )}
      {DOMAIN_SURFACE_IDS.has(instance.surface_id) && (
        <DomainSurfaceView
          instance={instance}
          transport={pluginTransport}
          persist={persistSurfaceViewState}
          reportError={reportError}
          useRuntimeOutputInAgent={(reference) => {
            setAgentRuntimeOutputContext(reference);
            openSurfaceById("rho.agent");
          }}
          openSurfaceById={openSurfaceById}
        />
      )}
      {instance.surface_id === "rho.surface-playground" && (
        <div className="rho-playground-draft">
          <span className="rho-eyebrow">Developer preview</span>
          <strong>Instance-local state sandbox</strong>
          <p>This draft tests component-local interaction without changing project or Runtime state.</p>
          <label>
          Preview draft
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
          <details><summary>Preview details</summary><code>{instance.instance_id.slice(-12)}</code></details>
        </div>
      )}
      {instance.origin.kind === "workspace_plugin" && pluginDocumentRequest != null && (
        <PluginSurfaceView
          request={pluginDocumentRequest}
          transport={pluginTransport}
          close={remove}
          reportError={reportError}
        />
      )}
      </>}
      {paneDropZone != null && (
        <div className={`rho-drop-overlay rho-drop-${paneDropZone}`} aria-hidden="true">
          <div className="rho-drop-region" />
          <div className="rho-drop-guide">
            <span data-zone="top" data-active={paneDropZone === "top" || undefined}>↑</span>
            <span data-zone="left" data-active={paneDropZone === "left" || undefined}>←</span>
            <span data-zone="center" data-active={paneDropZone === "center" || undefined}>＋</span>
            <span data-zone="right" data-active={paneDropZone === "right" || undefined}>→</span>
            <span data-zone="bottom" data-active={paneDropZone === "bottom" || undefined}>↓</span>
          </div>
        </div>
      )}
    </article>
  );
}

function WorkbenchApp({ transport }: AppProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [resourcePath, setResourcePath] = useState("analysis.R");
  const [commandQuery, setCommandQuery] = useState("");
  const [commandSearchOpen, setCommandSearchOpen] = useState(false);
  const [commandSearchTransient, setCommandSearchTransient] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [toolbarCustomizerOpen, setToolbarCustomizerOpen] = useState(false);
  const [projectSwitching, setProjectSwitching] = useState(false);
  const [projectSwitchTarget, setProjectSwitchTarget] = useState<string | null>(null);
  const [projectSwitchError, setProjectSwitchError] = useState<string | null>(null);
  const [agentRuntimeOutputContext, setAgentRuntimeOutputContext] = useState<RuntimeOutputReference | null>(null);
  const [projectHistory, setProjectHistory] = useState<ProjectHistoryLoad>(() =>
    loadProjectHistory(window.localStorage)
  );
  const [toolbarPreference, setToolbarPreference] = useState<ToolbarPreferenceLoad & {
    readonly projectId: string | null;
  }>({
    projectId: null,
    layout: defaultToolbarLayout(),
    status: "default",
    detail: null,
  });
  const commandSearchRef = useRef<HTMLInputElement>(null);
  const rhoMenuRef = useRef<HTMLDetailsElement>(null);
  const rhoMenuTriggerRef = useRef<HTMLElement>(null);
  const projectSwitchController = useMemo(() => new ProjectSwitchController(), []);
  const traceProjectRef = useRef<string | null>(null);
  const consoleExecutionRouter = useMemo(() => new ConsoleExecutionRouter(), []);
  const draftCache = useRef(new Map<string, string>()).current;
  const consoleSessionCache = useRef(new Map<string, ConsoleViewState>()).current;
  const registerConsoleExecution = useCallback(
    (endpoint: ConsoleExecutionEndpoint) => consoleExecutionRouter.register(endpoint),
    [consoleExecutionRouter],
  );
  const markConsolePreferred = useCallback((instanceId: string) => {
    consoleExecutionRouter.markPreferred(instanceId);
  }, [consoleExecutionRouter]);
  const pluginTransport = transport ?? defaultTransport;
  const store = useMemo(
    () => transport == null ? defaultStore : new WorkbenchProjectionStore(transport),
    [transport],
  );
  const surfaceStore = store;
  const studioStore = store;
  const runtimeStore = store;
  const resourceStore = store;
  const profileStore = store;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const projection = state.status === "ready" ? state.snapshot : null;
  const snapshot = projection?.kernel ?? null;
  const surfaces = projection?.surfaces ?? null;
  const studio = projection?.studio ?? null;
  const runtimes = projection?.runtimes ?? null;
  const resources = projection?.resources ?? null;
  const profileSnapshot = projection?.profile ?? null;
  const profile = profileSnapshot?.profile ?? null;
  const projectionProjectId = snapshot?.project.project_id ?? null;
  useConsoleProjectActivation(consoleExecutionRouter, projectionProjectId);
  useEffect(() => {
    if (projectionProjectId != null && traceProjectRef.current !== projectionProjectId) {
      workbenchOperationTrace.reset();
      traceProjectRef.current = projectionProjectId;
    }
  }, [projectionProjectId]);
  useEffect(() => {
    setAgentRuntimeOutputContext(null);
  }, [projectionProjectId]);
  const projectProjectionsCoherent = projection != null;
  const toolbarProjectId = profile?.project_id ?? null;
  const toolbarLayout = toolbarPreference.projectId === toolbarProjectId
    ? toolbarPreference.layout
    : defaultToolbarLayout();
  useEffect(() => {
    if (profile?.active_mode === "vibe") setInspectorOpen(false);
  }, [profile?.active_mode]);
  useEffect(() => {
    if (toolbarProjectId == null) return;
    let loaded: ToolbarPreferenceLoad;
    try {
      loaded = loadToolbarLayout(window.localStorage, toolbarProjectId);
    } catch {
      loaded = {
        layout: defaultToolbarLayout(),
        status: "unavailable",
        detail: "Toolbar settings could not be read; using the session default.",
      };
    }
    setToolbarPreference({ projectId: toolbarProjectId, ...loaded });
  }, [toolbarProjectId]);
  useEffect(() => {
    const path = snapshot?.project.display_path;
    if (path == null) return;
    setProjectHistory((current) => {
      const history = rememberProjectPath(current.history, path);
      if (history === current.history) return current;
      try {
        saveProjectHistory(window.localStorage, history);
        return { history, status: "clean", detail: null };
      } catch {
        return {
          history,
          status: "unavailable",
          detail: "Recent projects work for this session but could not be saved on this device.",
        };
      }
    });
  }, [snapshot?.project.display_path]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (commandSearchRef.current == null) setCommandSearchTransient(true);
        else {
          commandSearchRef.current.focus();
          commandSearchRef.current.select();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => {
    if (!commandSearchTransient) return;
    commandSearchRef.current?.focus();
    commandSearchRef.current?.select();
  }, [commandSearchTransient]);
  useEffect(() => {
    const closeRhoMenu = (event: PointerEvent) => {
      const menu = rhoMenuRef.current;
      if (menu?.open === true && event.target instanceof Node && !menu.contains(event.target)) {
        menu.open = false;
      }
    };
    const closeRhoMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && rhoMenuRef.current?.open === true) {
        rhoMenuRef.current.open = false;
        rhoMenuTriggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeRhoMenu);
    document.addEventListener("keydown", closeRhoMenuOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeRhoMenu);
      document.removeEventListener("keydown", closeRhoMenuOnEscape);
    };
  }, []);
  const instances = useMemo(() => new Map(surfaces?.catalog.instances.map((instance) => [instance.instance_id, instance]) ?? []), [surfaces]);
  const primaryCommands = useMemo(() => snapshot == null ? [] : commandsForPlacement(snapshot, "primary_candidate"), [snapshot]);
  const paletteCommands = useMemo(() => snapshot == null ? [] : commandsForPlacement(snapshot, "palette").filter((command) => {
    const query = commandQuery.trim().toLocaleLowerCase();
    return query.length === 0 || command.definition.label.toLocaleLowerCase().includes(query) ||
      command.definition.command_id.toLocaleLowerCase().includes(query);
  }), [commandQuery, snapshot]);
  const run = (operation: Promise<unknown>, operationName = "workbench.action") => {
    setActionError(null);
    void workbenchOperationTrace.run(
      operationName,
      () => operation,
      { fallback: "Studio operation failed.", scope: "workbench" },
    ).catch((error: unknown) => setActionError(workbenchFailureMessage(error, "Studio operation failed.")));
  };
  const studioMutationController = useMemo(() => new StudioMutationController({
    getStudio: studioStore.getStudioSnapshot,
    apply: (request) => studioStore.apply(request),
    undo: (request) => studioStore.undo(request),
    redo: (request) => studioStore.redo(request),
    report: setActionError,
    allocateLayoutNodeId: () => `layout-node:${crypto.randomUUID().replaceAll("-", "")}`,
  }), [studioStore]);
  const surfaceMutationController = useMemo(() => new SurfaceInstanceMutationController({
    getSurfaces: surfaceStore.getSurfaceSnapshot,
    update: (request) => surfaceStore.update(request),
    suspend: (request) => surfaceStore.suspend(request),
    resume: (request) => surfaceStore.resume(request),
  }), [surfaceStore]);
  const previewToolbarLayout = (layout: ToolbarLayout) => {
    if (toolbarProjectId == null) return;
    setToolbarPreference((current) => ({
      projectId: toolbarProjectId,
      layout,
      status: current.projectId === toolbarProjectId ? current.status : "default",
      detail: current.projectId === toolbarProjectId ? current.detail : null,
    }));
  };
  const commitToolbarLayout = (layout: ToolbarLayout) => {
    if (toolbarProjectId == null) return;
    let status: ToolbarPreferenceLoad["status"] = "clean";
    let detail: string | null = null;
    try {
      saveToolbarLayout(window.localStorage, toolbarProjectId, layout);
    } catch {
      status = "unavailable";
      detail = "Toolbar changed for this session, but the preference could not be saved.";
      setActionError(detail);
    }
    setToolbarPreference({ projectId: toolbarProjectId, layout, status, detail });
  };
  const commit = (edit: SceneEdit) => {
    void studioMutationController.commit(edit);
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
    placement?: { readonly container_node_id: string; readonly child_index: number },
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
        target_container_node_id: placement?.container_node_id ?? studio.scene.root.node_id,
        child_index: placement?.child_index ?? studio.scene.root.children.length,
        instance_id: created.instance_id,
        basis: { kind: "fraction", weight: 1 },
      },
    });
  };
  const navigatorPlacement = (): { readonly container_node_id: string; readonly child_index: number } | undefined => {
    if (studio == null || studio.scene.root.kind !== "container") return undefined;
    const center = studio.scene.root.children
      .map((child) => child.child)
      .find((node) => node.kind === "container" && node.axis === "vertical");
    if (center == null || center.kind !== "container") return undefined;
    return { container_node_id: center.node_id, child_index: 0 };
  };
  const openNavigatorFile = async (descriptor: ResourceDescriptor) => {
    await openResource(descriptor, "rho.file-source", "source", navigatorPlacement());
  };
  const openSurfaceById = (surfaceId: string) => {
    const existing = surfaces?.catalog.instances.find((candidate) => candidate.surface_id === surfaceId);
    const placement = existing == null || studio == null
      ? null
      : findLayoutPlacement(studio.scene.root, existing.instance_id);
    if (existing != null && placement != null) {
      if (placement.kind === "stack" && !placement.active) {
        commit({ kind: "set_stack_active", stack_node_id: placement.nodeId, instance_id: existing.instance_id });
      } else {
        commit({ kind: "set_focus", instance_id: existing.instance_id });
      }
      return;
    }
    const factory = surfaces?.catalog.factories.find((candidate) => candidate.definition.surface_id === surfaceId);
    if (factory == null) {
      setActionError(`Surface ${surfaceId} is unavailable.`);
      return;
    }
    run(openFactory(factory));
  };
  const commitDrop = (dragInstanceId: string, target: StudioDropTarget) => {
    void studioMutationController.drop(dragInstanceId, target);
  };
  const studioDrag = useStudioPointerDrag(commitDrop);
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
    const latest = profileStore.getProfileSnapshot();
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
      const latest = profileStore.getProfileSnapshot();
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
    const latest = profileStore.getProfileSnapshot();
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
  const consoleRequirementController = useMemo(() => new ConsoleRequirementController({
    getSurfaces: surfaceStore.getSurfaceSnapshot,
    getStudio: studioStore.getStudioSnapshot,
    getRuntimes: runtimeStore.getRuntimeSnapshot,
    getProfile: profileStore.getProfileSnapshot,
    attachRuntime: (request) => runtimeStore.attach(request),
    refreshSurfaces: () => surfaceStore.refresh(),
    openSurface: (request) => surfaceStore.open(request),
    applyStudio: (request) => studioStore.apply(request),
    waitForRenderer: (instanceId) => consoleExecutionRouter.waitFor(instanceId),
    markPreferred: (instanceId) => consoleExecutionRouter.markPreferred(instanceId),
    allocateLayoutNodeId: () => `layout-node:${crypto.randomUUID().replaceAll("-", "")}`,
  }), [consoleExecutionRouter, profileStore, runtimeStore, studioStore, surfaceStore]);
  const runSourceExecution = async (
    sourceInstanceId: string,
    execution: SourceExecutionSubmission,
  ): Promise<boolean> => consoleExecutionRouter.run(
    sourceInstanceId,
    execution,
    () => consoleRequirementController.resolve(sourceInstanceId),
    setActionError,
  );
  const surfaceView = (
    instance: SurfaceInstance,
    embedded = false,
    nodeId?: string,
    paneMemberCount = 1,
  ) => {
    const boundDescriptor = resources?.resources.find((descriptor) =>
      descriptor.resource_provider_id === instance.resource_binding?.resource_provider_id &&
      descriptor.resource_kind === instance.resource_binding?.resource_kind &&
      descriptor.resource_id === instance.resource_binding.resource_id
    ) ?? null;
    const activePage = profile?.vibe_pages.find(
      (page) => page.page_id === profile.active_vibe_page_id,
    ) ?? null;
    const availableModes = surfaces?.catalog.factories.find(
      (factory) => factory.definition.surface_id === instance.surface_id,
    )?.definition.modes ?? [];
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
        await surfaceMutationController.suspend(instance.instance_id);
      }}
      resume={async () => {
        await surfaceMutationController.resume(instance.instance_id);
      }}
      draftCache={draftCache}
      consoleSessionCache={consoleSessionCache}
      availableModes={availableModes}
      setMode={async (modeId) => {
        await surfaceMutationController.update(instance.instance_id, {
          kind: "set_mode",
          mode_id: modeId,
        });
      }}
      persistDraft={(draft) => {
        run(surfaceMutationController.update(instance.instance_id, {
          kind: "set_view_state",
          view_state: { draft },
        }), "surface.set_view_state");
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
      startRuntimeExecution={async (runtime, code, sourceContext) => {
        await store.settled();
        const runtimeState = runtimeStore.getRuntimeSnapshot();
        const surfaceState = surfaceStore.getSurfaceSnapshot();
        if (runtimeState.status !== "ready" || surfaceState.status !== "ready") {
          throw new Error("Runtime Registry or Surface Runtime is not ready.");
        }
        const currentRuntime = runtimeState.snapshot.instances.find((candidate) =>
          candidate.runtime_instance_id === runtime.runtime_instance_id &&
          candidate.activation_generation === runtime.activation_generation
        );
        const currentConsole = surfaceState.snapshot.catalog.instances.find(
          (candidate) => candidate.instance_id === instance.instance_id,
        );
        if (currentRuntime == null || currentConsole == null) {
          throw new Error("The Console or Runtime changed before execution could start.");
        }
        const result = await workbenchOperationTrace.run(
          "runtime.execution.start",
          () => runtimeStore.startExecution({
            runtime: runtimeRequest(currentRuntime, runtimeState.snapshot.project_revision),
            console_instance_id: currentConsole.instance_id,
            expected_console_revision: currentConsole.surface_revision,
            code,
            ...(sourceContext == null ? {} : { source_context: sourceContext }),
          }),
          {
            fallback: "Runtime operation failed.",
            defaultKind: "runtime_infrastructure",
            scope: "surface",
          },
        );
        await runtimeStore.refresh();
        return result;
      }}
      followRuntimeOutput={async (executionId, afterSequence, listener) => {
        try {
          await runtimeStore.followOutput(executionId, afterSequence, listener);
        } finally {
          await runtimeStore.refresh();
        }
      }}
      listRuntimeExecutions={async () => (
        await runtimeStore.listExecutions(100)
      ).filter((execution) => execution.console_instance_id === instance.instance_id)}
      loadRuntimeOutputPage={(executionId, afterSequence) => (
        runtimeStore.outputPage(executionId, afterSequence)
      )}
      loadRuntimeOutputPageBefore={(executionId, beforeSequence) => (
        runtimeStore.outputPageBefore(executionId, beforeSequence)
      )}
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
        await surfaceMutationController.update(instance.instance_id, {
          kind: "set_view_state",
          view_state: viewState,
        });
      }}
      registerConsoleExecution={registerConsoleExecution}
      markConsolePreferred={markConsolePreferred}
      runSourceExecution={runSourceExecution}
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
        await surfaceMutationController.update(instance.instance_id, {
          kind: "bind_resource",
          binding: {
            resource_provider_id: descriptor.resource_provider_id,
            resource_kind: descriptor.resource_kind,
            resource_id: descriptor.resource_id,
            resource_revision: descriptor.resource_revision,
          },
        });
      }}
      setViewGroup={async (viewGroupId) => {
        await surfaceMutationController.update(instance.instance_id, {
          kind: "set_view_group",
          view_group_id: viewGroupId,
        });
      }}
      persistFileViewState={async (viewState) => {
        await surfaceMutationController.update(instance.instance_id, {
          kind: "set_view_state",
          view_state: viewState,
        });
      }}
      reportError={(error) => setActionError(boundedFailureMessage(error, "Runtime operation failed."))}
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
        await surfaceMutationController.update(instance.instance_id, {
          kind: "set_view_state",
          view_state: viewState,
        });
      }}
      persistSurfaceViewState={async (viewState) => {
        await surfaceMutationController.update(instance.instance_id, {
          kind: "set_view_state",
          view_state: viewState,
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
      openNavigatorFile={openNavigatorFile}
      openSurfaceById={openSurfaceById}
      agentRuntimeOutputContext={agentRuntimeOutputContext}
      setAgentRuntimeOutputContext={setAgentRuntimeOutputContext}
      paneNodeId={nodeId ?? null}
      paneMemberCount={paneMemberCount}
      studioDrag={studioDrag}
    />;
  };
  const activeVibePage = profile?.vibe_pages.find(
    (page) => page.page_id === profile.active_vibe_page_id,
  ) ?? null;
  const evidence = useMemo(() => ({
    ready: snapshot != null && surfaces != null && studio != null && runtimes != null && resources != null && profile != null && projectProjectionsCoherent,
    buildId: __RHO_FRONTEND_BUILD_ID__,
    operationTraceCount: workbenchOperationTrace.snapshot().length,
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
  }), [activeVibePage, instances, profile, profileSnapshot, projectProjectionsCoherent, resources, runtimes, snapshot, state, studio, surfaces]);
  useEffect(() => {
    document.documentElement.dataset.rsrReady = String(evidence.ready);
  }, [evidence.ready]);

  const closeRhoMenu = () => {
    if (rhoMenuRef.current != null) rhoMenuRef.current.open = false;
  };
  const refreshProjectProjections = () => store.refresh();
  const performProjectSwitch = async (
    operation: () => Promise<ProjectSwitchResponse>,
    targetPath: string | null,
  ) => projectSwitchController.perform(operation, targetPath, {
      start: (target) => {
        setProjectSwitching(true);
        setProjectSwitchTarget(target);
        setProjectSwitchError(null);
        setActionError(null);
      },
      accept: async () => {
        draftCache.clear();
        consoleSessionCache.clear();
        await refreshProjectProjections();
        closeRhoMenu();
      },
      refreshRestored: async () => {
        await refreshProjectProjections();
      },
      report: setProjectSwitchError,
      finish: () => {
        setProjectSwitching(false);
        setProjectSwitchTarget(null);
      },
    });
  const openCommandSearch = () => {
    closeRhoMenu();
    if (commandSearchRef.current == null) setCommandSearchTransient(true);
    else {
      commandSearchRef.current.focus();
      commandSearchRef.current.select();
    }
  };
  const commandSearch = (
    <div className="rho-command-search">
      <input
        ref={commandSearchRef}
        aria-label="Search commands"
        placeholder="Search or run a command…"
        value={commandQuery}
        onChange={(event) => setCommandQuery(event.target.value)}
        onFocus={() => setCommandSearchOpen(true)}
        onBlur={() => window.setTimeout(() => {
          setCommandSearchOpen(false);
          setCommandSearchTransient(false);
        }, 120)}
      />
      <kbd className="rho-command-kbd" aria-hidden="true">⌘K</kbd>
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
  );
  const railIconProps = {
    viewBox: "0 0 16 16",
    "aria-hidden": true,
    focusable: false,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  const RailSearchIcon = () => (
    <svg {...railIconProps}><circle cx="7" cy="7" r="4" /><path d="m10 10 3.5 3.5" /></svg>
  );
  const RailFolderIcon = () => (
    <svg {...railIconProps}><path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 2h5.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-7Z" /></svg>
  );
  const RailLayersIcon = () => (
    <svg {...railIconProps}><path d="m8 2 6 3-6 3-6-3 6-3Z" /><path d="m2 8.5 6 3 6-3" /></svg>
  );
  const RailPlayIcon = () => (
    <svg {...railIconProps}><path d="M5 3.5v9l7-4.5-7-4.5Z" /></svg>
  );
  const RailComposeIcon = () => (
    <svg {...railIconProps}><rect x="2" y="2.5" width="12" height="11" rx="1" /><path d="M9.5 2.5v11" /></svg>
  );
  const RailStudioIcon = () => (
    <svg {...railIconProps}><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>
  );
  const RailVibeIcon = () => (
    <svg {...railIconProps}><path d="M8 2v4M8 10v4M2 8h4M10 8h4M4.2 4.2l2 2M9.8 9.8l2 2M11.8 4.2l-2 2M6.2 9.8l-2 2" /></svg>
  );
  const renderToolbarComponent = (componentId: ToolbarComponentId) => {
    let content: ReactNode;
    switch (componentId) {
      case "project_context":
        content = (
          <button
            type="button"
            className="rho-rail-btn"
            title={snapshot?.project.display_path ?? ""}
            aria-label={`Project ${snapshot?.project.display_label ?? "menu"}`}
            onClick={() => {
              setToolbarCustomizerOpen(false);
              if (rhoMenuRef.current != null) rhoMenuRef.current.open = true;
            }}
          ><RailFolderIcon /></button>
        );
        break;
      case "scene_selector":
        content = (
          <details className="rho-rail-popover">
            <summary
              className="rho-rail-btn"
              aria-label={profile?.active_mode === "vibe" ? "Vibe Pages" : "Studio Scenes"}
              title={profile?.active_mode === "vibe" ? "Vibe Pages" : "Studio Scenes"}
            ><RailLayersIcon /></summary>
            <div className="rho-rail-popover-panel">
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
                <>
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
                  <button type="button" disabled={!studio?.can_undo} onClick={() => void studioMutationController.undo()}>Undo</button>
                  <button type="button" disabled={!studio?.can_redo} onClick={() => void studioMutationController.redo()}>Redo</button>
                </>
              )}
            </div>
          </details>
        );
        break;
      case "command_search":
        content = (
          <button
            type="button"
            className="rho-rail-btn"
            title="Command search (⌘K)"
            aria-label="Command search"
            onClick={() => {
              closeRhoMenu();
              setCommandSearchTransient(true);
            }}
          ><RailSearchIcon /></button>
        );
        break;
      case "project_action":
        content = (
          <div className="rho-command-projection" aria-label="Primary contextual command">
            {primaryCommands.filter((command) => command.availability.state === "available" && command.definition.command_id === "rho.check.run").slice(0, 1).map((command) => <button type="button" className="rho-rail-btn" title={command.definition.label} aria-label={command.definition.label} onClick={() => run(invokeCommand(command.definition.command_id))} key={command.definition.command_id}><RailPlayIcon /></button>)}
          </div>
        );
        break;
      case "runtime_status":
        content = (
          <div
            className="rho-foundation-status"
            title={snapshot?.health.workspace.label ?? "Connecting"}
          ><span className={`rho-status-dot rho-status-${snapshot?.context.workspace_health ?? state.status}`} /></div>
        );
        break;
      case "compose":
        content = (
          <button
            className="rho-rail-choice rho-bar-compose"
            type="button"
            aria-pressed={inspectorOpen}
            title="Arrange workspace components"
            onClick={() => setInspectorOpen((open) => !open)}
          ><RailComposeIcon /><span>Compose</span></button>
        );
        break;
    }
    return (
      <div
        className={`rho-toolbar-slot rho-toolbar-slot-${componentId.replaceAll("_", "-")}`}
        data-toolbar-component={componentId}
        key={componentId}
      >{content}</div>
    );
  };
  const visibleToolbarComponents = toolbarLayout.order.filter((componentId) =>
    toolbarLayout.visible.includes(componentId)
  );
  const recentProjectPaths = projectHistory.history.paths.filter((path) =>
    path !== snapshot?.project.display_path
  );
  const componentFactories = surfaces?.catalog.factories.filter(
    (factory) => factory.definition.surface_id !== "rho.surface-playground",
  ) ?? [];
  const developerFactories = surfaces?.catalog.factories.filter(
    (factory) => factory.definition.surface_id === "rho.surface-playground",
  ) ?? [];
  const pluginFactories = surfaces?.catalog.factories.filter(
    (factory) => factory.definition.origin.kind === "workspace_plugin",
  ) ?? [];
  const activePluginSurfaceIds = new Set(
    surfaces?.catalog.instances
      .filter((instance) =>
        instance.origin.kind === "workspace_plugin" && instance.lifecycle_state === "active"
      )
      .map((instance) => instance.surface_id) ?? [],
  );
  const renderComponentFactory = (factory: SurfaceFactoryRegistration, developer = false) => {
    const surfaceId = factory.definition.surface_id;
    const label = surfaceId.startsWith("rho.")
      ? surfaceDisplayLabel(surfaceId)
      : factory.definition.label;
    const purpose = developer
      ? "Preview instance-local component state without project or Runtime authority."
      : surfaceId.startsWith("rho.")
        ? surfaceUxProfile(surfaceId).primaryTask
        : factory.definition.purpose;
    return <article className="rho-surface-factory" data-surface-factory={surfaceId} key={`${surfaceId}:${factory.activation_generation}`}>
      <div>
        <strong>{label}</strong>
        {factory.definition.origin.kind === "workspace_plugin" && <span className="rho-component-origin">Project component</span>}
        <small>{purpose}</small>
      </div>
      <button type="button" onClick={() => run(openFactory(factory))}>{developer ? "Open preview" : "Open"}</button>
    </article>;
  };
  const toolbarSplit = Math.ceil(visibleToolbarComponents.length / 2);
  const leftToolbarComponents = visibleToolbarComponents.slice(0, toolbarSplit);
  const rightToolbarComponents = visibleToolbarComponents.slice(toolbarSplit);

  return (
    <main className="rho-studio-shell">
      <header className="rho-studio-bar">
        <div className="rho-toolbar-anchor rho-toolbar-anchor-left">
          <details className="rho-rho-menu" ref={rhoMenuRef}>
            <summary ref={rhoMenuTriggerRef} aria-label="Rho menu" onClick={() => setToolbarCustomizerOpen(false)}><span className="rho-mark-word">Rho</span><span aria-hidden="true">⌄</span></summary>
            <div className="rho-rho-menu-panel" aria-busy={projectSwitching}>
              <button
                type="button"
                className="rho-rho-project"
                aria-label="Open a different project folder"
                disabled={snapshot == null || projectSwitching}
                onClick={() => void performProjectSwitch(
                  () => pluginTransport.pickProjectDirectory(),
                  null,
                )}
              >
                <span className="rho-rho-project-copy">
                  <span className="rho-eyebrow">Project</span>
                  <strong>{snapshot?.project.display_label ?? "Loading…"}</strong>
                  <small>{snapshot?.project.display_path ?? ""}</small>
                </span>
                <span className="rho-project-switch-hint">
                  {projectSwitching && projectSwitchTarget == null ? "Choosing…" : "Switch…"}
                </span>
              </button>
              {recentProjectPaths.length > 0 && (
                <div className="rho-recent-projects">
                  <div className="rho-recent-projects-heading">
                    <span className="rho-eyebrow">Recent projects</span>
                    <span>{recentProjectPaths.length}</span>
                  </div>
                  {recentProjectPaths.map((path) => (
                    <button
                      type="button"
                      data-project-path={path}
                      disabled={projectSwitching}
                      key={path}
                      onClick={() => void performProjectSwitch(
                        () => pluginTransport.openProject(path),
                        path,
                      )}
                    >
                      <span>
                        <strong>{projectLabel(path)}</strong>
                        <small>{path}</small>
                      </span>
                      <span aria-hidden="true">
                        {projectSwitching && projectSwitchTarget === path ? "…" : "›"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {projectSwitchError != null && (
                <p className="rho-project-switch-error" role="alert">{projectSwitchError}</p>
              )}
              {projectHistory.status === "unavailable" && projectHistory.detail != null && (
                <p className="rho-project-history-status" role="status">{projectHistory.detail}</p>
              )}
              <span className="rho-menu-separator" />
              <button type="button" onClick={openCommandSearch}><span>Command search</span><kbd>⌘K</kbd></button>
              <button type="button" onClick={() => {
                closeRhoMenu();
                setToolbarCustomizerOpen(true);
              }}>Customize toolbar…</button>
              <button
                type="button"
                className="rho-build-identity"
                title="Copy this development build identity"
                onClick={() => void navigator.clipboard?.writeText(__RHO_FRONTEND_BUILD_ID__)}
              >
                <span>Development build</span>
                <code>{__RHO_FRONTEND_BUILD_ID__}</code>
              </button>
              <button
                type="button"
                className="rho-session-diagnostics"
                onClick={() => void navigator.clipboard?.writeText(JSON.stringify({
                  build_id: __RHO_FRONTEND_BUILD_ID__,
                  operations: workbenchOperationTrace.snapshot(),
                }, null, 2))}
              >
                <span>Copy session diagnostics</span>
                <span aria-hidden="true">⌘C</span>
              </button>
            </div>
          </details>
        </div>
        <div className="rho-mode-switch" aria-label="Workspace mode">
          {(["studio", "vibe"] as const).map((mode) => (
            <button
              type="button"
              className="rho-rail-choice"
              aria-pressed={profile?.active_mode === mode}
              title={mode === "studio" ? "Studio mode" : "Vibe mode"}
              disabled={profile == null}
              key={mode}
              onClick={() => {
                const target = profileRevisionRequest();
                if (target != null && profile?.active_mode !== mode) {
                  run(profileStore.setMode({ target, mode }));
                }
              }}
            >{mode === "studio" ? <RailStudioIcon /> : <RailVibeIcon />}<span>{mode === "studio" ? "Studio" : "Vibe"}</span></button>
          ))}
        </div>
        {pluginFactories.length > 0 && (
          <nav className="rho-plugin-rail" aria-label="Workspace plugins">
            {pluginFactories.map((factory) => {
              const { definition } = factory;
              const origin = definition.origin;
              const pluginId = origin.kind === "workspace_plugin" ? origin.plugin_id : "";
              const fallback = Array.from(definition.label.trim())[0]?.toUpperCase() ?? "?";
              const active = activePluginSurfaceIds.has(definition.surface_id);
              return (
                <button
                  key={`${definition.surface_id}:${factory.activation_generation}`}
                  type="button"
                  className={`rho-plugin-icon${active ? " rho-plugin-icon-active" : ""}`}
                  title={`${definition.label} · ${pluginId}`}
                  aria-label={`Open ${definition.label}`}
                  onClick={() => run(openFactory(factory))}
                >
                  <span aria-hidden="true">{definition.icon ?? fallback}</span>
                </button>
              );
            })}
          </nav>
        )}
        <div className="rho-toolbar-anchor rho-toolbar-anchor-right">
          <div className="rho-toolbar-lane rho-toolbar-lane-left">
            {leftToolbarComponents.map(renderToolbarComponent)}
          </div>
          <div className="rho-toolbar-lane rho-toolbar-lane-right">
            {rightToolbarComponents.map(renderToolbarComponent)}
          </div>
          <ToolbarCustomizer
            layout={toolbarLayout}
            open={toolbarCustomizerOpen}
            persistenceStatus={toolbarPreference.status}
            persistenceDetail={toolbarPreference.detail}
            onOpenChange={(open) => {
              if (open) closeRhoMenu();
              setToolbarCustomizerOpen(open);
            }}
            onPreview={previewToolbarLayout}
            onCommit={commitToolbarLayout}
          />
        </div>
        {commandSearchTransient && (
          <div className="rho-toolbar-command-overlay">{commandSearch}</div>
        )}
      </header>
      <div className="rho-studio-main">
      <div className={`rho-studio-workspace ${inspectorOpen ? "rho-inspector-open" : "rho-inspector-closed"}`}>
        {inspectorOpen && <aside className="rho-studio-inspector">
          <header>
            <div><span className="rho-eyebrow">Compose</span><strong>Arrange workspace</strong></div>
            <button type="button" onClick={() => setInspectorOpen(false)}>Done</button>
          </header>
          <p className="rho-compose-intro">Add components here. Move and resize them directly on the workspace.</p>
          {snapshot?.health.agent.state !== "ready" && snapshot?.health.agent.label != null && (
            <div className="rho-agent-health" role="status">
              <strong>{snapshot.health.agent.label}</strong>
              {snapshot.health.agent.detail != null && <small>{snapshot.health.agent.detail}</small>}
            </div>
          )}
          {studio != null && (
            <>
              <details className="rho-compose-layout">
                <summary><span>Layout structure</span><span>Advanced</span></summary>
                <div className="rho-inspector-actions">
                  <button type="button" onClick={() => commit({ kind: "normalize" })}>Normalize</button>
                  {studio.scene.root.kind === "container" && <button type="button" onClick={() => commit({ kind: "distribute_container", container_node_id: studio.scene.root.node_id })}>Distribute</button>}
                </div>
                <ol className="rho-layout-outline"><li><NodeOutline node={studio.scene.root} commit={commit} /></li></ol>
              </details>
              {surfaces != null && (
                <section className="rho-surface-catalog">
                  <div className="rho-surface-catalog-heading">
                    <span className="rho-eyebrow">Components</span>
                    <span>{componentFactories.length}</span>
                  </div>
                  {componentFactories.map((factory) => renderComponentFactory(factory))}
                  {developerFactories.length > 0 && <details className="rho-developer-components">
                    <summary><span>Developer tools</span><span>{developerFactories.length}</span></summary>
                    <p>Preview and diagnostic components are kept separate from the normal workbench catalog.</p>
                    {developerFactories.map((factory) => renderComponentFactory(factory, true))}
                  </details>}
                </section>
              )}
              {studio.unplaced_instance_ids.length > 0 && <section className="rho-inventory">
                <span className="rho-eyebrow">Unplaced instances</span>
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
              </section>}
            </>
          )}
          {resources != null && (
            <details className="rho-compose-advanced">
              <summary><span>Resource registry</span><span>{resources.resources.length}</span></summary>
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
            </details>
          )}
          {runtimes != null && (
            <details className="rho-compose-advanced">
              <summary><span>Runtime controls</span><span>{runtimes.instances.length}</span></summary>
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
            </details>
          )}
        </aside>}
        <section className={`rho-studio-canvas rho-canvas-${profile?.active_mode ?? "loading"}`} aria-label={profile?.active_mode === "vibe" ? "Vibe page canvas" : "Studio layout canvas"}>
          {state.status === "failed" && <p role="alert">{state.message}</p>}
          {profileSnapshot?.recovery_detail != null && (
            <div className="rho-profile-recovery" role="status">
              <div><strong>UI Profile recovered from backup</strong><code>{profileSnapshot.recovery_detail}</code></div>
              <button type="button" onClick={() => void navigator.clipboard?.writeText(profileSnapshot.recovery_detail ?? "")}>Copy diagnostics</button>
            </div>
          )}
          {actionError != null && <p className="rho-action-error" role="alert">{actionError}</p>}
          {profile == null || surfaces == null || studio == null || !projectProjectionsCoherent
            ? <div className="rho-studio-loading">{projectSwitching ? "Switching project…" : "Loading the project UI Profile…"}</div>
            : profile.active_mode === "vibe"
              ? activeVibePage == null
                ? <div className="rho-studio-loading">The active Vibe Page is unavailable.</div>
                : <VibePageEditor
                    key={profile.project_id}
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
              : <LayoutTree key={studio.project_id} node={studio.scene.root} instances={instances} studio={studio} commit={commit} studioDrag={studioDrag} surfaceView={surfaceView} />}
        </section>
      </div>
      <StudioDragLayer controller={studioDrag} />
      <footer className="rho-statusbar" aria-label="Workbench status">
        <span className="rho-statusbar-item">
          <span className={`rho-status-dot rho-status-${snapshot?.context.workspace_health ?? "unknown"}`} />
          {snapshot?.health.workspace.label ?? "Connecting"}
        </span>
        <span className="rho-statusbar-item">
          <span className={`rho-status-dot rho-status-${snapshot?.context.agent_health ?? "unknown"}`} />
          {snapshot?.health.agent.label ?? "Agent"}
        </span>
        {(snapshot?.context.active_operations.length ?? 0) > 0 && <span className="rho-statusbar-item" aria-live="polite">
          {`${snapshot!.context.active_operations.length} task${snapshot!.context.active_operations.length > 1 ? "s" : ""} running`}
        </span>}
        <button
          type="button"
          className="rho-link"
          disabled={surfaces?.catalog.factories.some((factory) => factory.definition.surface_id === "rho.problems") !== true}
          onClick={() => {
            const problems = surfaces?.catalog.factories.find((factory) => factory.definition.surface_id === "rho.problems");
            if (problems != null) run(openFactory(problems));
          }}
        >Diagnostics</button>
        <span className="rho-statusbar-path" title={snapshot?.project.display_path ?? ""}>{snapshot?.project.display_path ?? ""}</span>
      </footer>
      </div>
      <pre id="rsrPreviewEvidence" hidden>{JSON.stringify(evidence)}</pre>
    </main>
  );
}
