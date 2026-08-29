import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import type {
  AgentFileMutationResponse,
  AgentTurnSummary,
  PluginSurfaceDocumentRequest,
  ResourceDescriptor,
  ResourceRegistrySnapshot,
  RuntimeDescriptor,
  RuntimeExecution,
  RuntimeExecutionStartResponse,
  RuntimeExecutionSourceContext,
  RuntimeOutputFollowFrame,
  RuntimeOutputPage,
  RuntimeOutputReference,
  RunAgentRequest,
  RuntimeOutputSearchResult,
  RuntimeRegistrySnapshot,
  SurfaceInstance,
  SurfaceFactoryRegistration,
  UiKernelTransport,
} from "../transport";
import { AgentSurfaceView } from "./AgentSurfaceView";
import type {
  AgentFileProposal,
  AgentFileProposalReview,
  AgentFileUndoState,
  AgentSurfaceViewState,
} from "./AgentSurfaceView";
import type { AgentStudioPresentation } from "./agent/studio-presentation";
import { CheckResultView } from "./CheckResultView";
import { DOMAIN_SURFACE_IDS, DomainSurfaceView } from "./DomainSurfaceView";
import { EnvironmentSurfaceView } from "./EnvironmentSurfaceView";
import { FileResourceView } from "./FileResourceView";
import type { FileResourceViewProps } from "./FileResourceView";
import { MenuPopover } from "./MenuPopover";
import { NavigatorSurfaceView } from "./Navigator";
import { PluginSurfaceView } from "./PluginSurfaceView";
import { SurfaceTaskState } from "./SurfaceTaskState";
import { SettingsSurfaceView } from "./SettingsSurfaceView";
import { consoleProjectionBlocksText } from "./console-output";
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
import type {
  ConsoleExecutionAdmission,
  ConsoleExecutionEndpoint,
} from "./controllers/console-execution-router";
import { surfaceUxProfile } from "./surface-ux";

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
  readonly resources: ResourceRegistrySnapshot | null;
  readonly readResource: FileResourceViewProps["read"];
  readonly updateResourceDraft: FileResourceViewProps["updateDraft"];
  readonly withFileMutation: FileResourceViewProps["withMutation"];
  readonly reloadResource: FileResourceViewProps["reload"];
  readonly renameResource: FileResourceViewProps["rename"];
  readonly deleteResource: FileResourceViewProps["removeResource"];
  readonly refreshResourceBinding: FileResourceViewProps["refreshBinding"];
  readonly setViewGroup: FileResourceViewProps["setViewGroup"];
  readonly persistFileViewState: FileResourceViewProps["persistViewState"];
  readonly reportError: (error: unknown) => void;
  readonly pluginTransport: UiKernelTransport;
  readonly surfaceFactories: readonly SurfaceFactoryRegistration[];
  readonly pluginDocumentRequest: PluginSurfaceDocumentRequest | null;
  readonly projectRevision: number;
  readonly openCheckEvidence: (path: string) => Promise<void>;
  readonly agentHealth: { readonly state: string; readonly label: string; readonly detail: string | null } | null;
  readonly createAgentConversation: (
    current: AgentSurfaceViewState,
  ) => Promise<AgentSurfaceViewState>;
  readonly runAgentConversation: (
    current: AgentSurfaceViewState,
    request: RunAgentRequest,
    onAccepted?: (conversationId: string) => void,
  ) => Promise<AgentSurfaceViewState>;
  readonly persistAgentViewState: (viewState: AgentSurfaceViewState) => Promise<void>;
  readonly persistSurfaceViewState: (viewState: unknown) => Promise<void>;
  readonly pinAgentTask: (turn: AgentTurnSummary) => Promise<void>;
  readonly presentAgentTurnInStudio: (
    turn: AgentTurnSummary,
    presentation: AgentStudioPresentation,
  ) => Promise<void>;
  readonly applyAgentFileProposal: (
    turn: AgentTurnSummary,
    eventId: number,
    proposal: AgentFileProposal,
    review?: AgentFileProposalReview,
  ) => Promise<{ readonly response: AgentFileMutationResponse; readonly beforeContent: string }>;
  readonly undoAgentFileProposal: (request: AgentFileUndoState) => Promise<void>;
  readonly openNavigatorFile: (descriptor: ResourceDescriptor) => Promise<void>;
  readonly openSurfaceById: (surfaceId: string) => void;
  readonly openPlot: (plotId: string) => void;
  readonly agentRuntimeOutputContext: RuntimeOutputReference | null;
  readonly setAgentRuntimeOutputContext: (reference: RuntimeOutputReference | null) => boolean;
  readonly embedded: boolean;
  readonly dockviewHosted: boolean;
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

function findDockviewActionsHost(instanceId: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return [...document.querySelectorAll<HTMLElement>("[data-rho-surface-actions-host]")]
    .find((candidate) => candidate.dataset.rhoSurfaceActionsHost === instanceId) ?? null;
}
export function SurfaceView({
  instance, focused, setFocus, remove, duplicate, suspend, resume, persistDraft, draftCache,
  consoleSessionCache,
  availableModes, setMode,
  runtimes, attachRuntime, detachRuntime, startRuntimeExecution, followRuntimeOutput,
  listRuntimeExecutions, loadRuntimeOutputPage, interruptRuntime,
  loadRuntimeOutputPageBefore,
  restartRuntime, persistConsole, registerConsoleExecution, markConsolePreferred,
  resources, readResource, updateResourceDraft, withFileMutation,
  reloadResource, renameResource, deleteResource,
  refreshResourceBinding, setViewGroup, persistFileViewState, reportError,
  pluginTransport, surfaceFactories, pluginDocumentRequest, projectRevision, openCheckEvidence,
  agentHealth, createAgentConversation, runAgentConversation, persistAgentViewState,
  persistSurfaceViewState, pinAgentTask, presentAgentTurnInStudio,
  applyAgentFileProposal, undoAgentFileProposal, openNavigatorFile, openSurfaceById, openPlot,
  agentRuntimeOutputContext, setAgentRuntimeOutputContext,
  embedded, dockviewHosted,
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
  const consoleNeedsCompaction = needsConsoleStateCompaction(instance);
  const [consoleRendererReady, setConsoleRendererReady] = useState(
    () => !consoleNeedsCompaction,
  );
  const runtime = instance.runtime_binding;
  const uxProfile = surfaceUxProfile(instance.surface_id);
  const isStrip = uxProfile.areaRole === "strip";
  const title = uxProfile.label;
  const dockviewOwnsChrome = dockviewHosted && !embedded && !isStrip;
  const [dockviewActionsHost, setDockviewActionsHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!dockviewOwnsChrome) {
      setDockviewActionsHost(null);
      return undefined;
    }
    const syncHost = () => {
      const next = findDockviewActionsHost(instance.instance_id);
      setDockviewActionsHost((current) => current === next ? current : next);
    };
    syncHost();
    if (typeof MutationObserver === "undefined") return undefined;
    const observer = new MutationObserver(syncHost);
    observer.observe(document.querySelector(".rho-dockview-scene") ?? document.body, {
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [dockviewOwnsChrome, instance.instance_id]);
  const attached = runtimes?.instances.find((candidate) =>
    candidate.runtime_instance_id === runtime?.runtime_instance_id &&
    candidate.activation_generation === runtime.activation_generation
  ) ?? null;
  useLayoutEffect(() => {
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
  }, [
    attached,
    consoleController,
    followRuntimeOutput,
    listRuntimeExecutions,
    loadRuntimeOutputPage,
    loadRuntimeOutputPageBefore,
    persistConsole,
    reportError,
    startRuntimeExecution,
  ]);
  useEffect(() => () => consoleController.dispose(), [consoleController]);
  useEffect(() => {
    if (instance.surface_id === "rho.console") {
      consoleSessionCache.set(instance.instance_id, consoleState);
    }
  }, [consoleSessionCache, consoleState, instance.instance_id, instance.surface_id]);
  useEffect(() => {
    if (instance.surface_id !== "rho.console") return;
    if (!consoleNeedsCompaction) {
      setConsoleRendererReady(true);
      return;
    }
    if (consoleCompactionRevisionRef.current === instance.surface_revision) return;
    consoleCompactionRevisionRef.current = instance.surface_revision;
    setConsoleRendererReady(false);
    let active = true;
    void consoleController.persistCurrent()
      .then(() => { if (active) setConsoleRendererReady(true); });
    return () => { active = false; };
  }, [
    consoleController,
    consoleNeedsCompaction,
    instance.surface_id,
    instance.surface_revision,
  ]);
  const runtimeRecovering = attached != null &&
    (attached.status === "restarting" || attached.status === "starting");
  const consoleBusy = consoleRunning || attached?.status === "busy";
  const consoleNeedle = consoleState.filter.trim().toLowerCase();
  const transcriptOutputs = consoleTranscriptOutputs(consoleState);
  let runtimeGroup = 0;
  const transcriptRows = transcriptOutputs.map((output, index) => {
    if (index > 0 && transcriptOutputs[index - 1]?.runtime_instance_id !== output.runtime_instance_id) {
      runtimeGroup += 1;
    }
    return { output, ordinal: consoleState.outputs.indexOf(output) + 1, runtimeGroup };
  });
  const filteredOutputs = transcriptRows.filter(({ output }) =>
    !consoleNeedle || outputText(output).toLowerCase().includes(consoleNeedle)
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
    if (instance.surface_id !== "rho.console" || !consoleRendererReady) return undefined;
    return registerConsoleExecution({
      instanceId: instance.instance_id,
      submitSource: (execution) => submitConsoleCode(execution.code, false, {
        source_path: execution.source_path,
        execution_mode: execution.kind,
        document_version: execution.document_version,
        source_range: execution.range,
      }),
    });
  }, [consoleRendererReady, instance.instance_id, instance.surface_id, registerConsoleExecution, submitConsoleCode]);
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
  const surfaceManagement = !embedded ? <div
    className="rho-surface-actions"
    onPointerDown={(event) => event.stopPropagation()}
  >
    <MenuPopover
      label={`More actions for ${title}`}
      glyph={<span aria-hidden="true">•••</span>}
      viewportBound={dockviewOwnsChrome || instance.surface_id === "rho.console"}
    >
      <div className="rho-menu-heading"><strong>{title}</strong></div>
      {instance.lifecycle_state === "active" || instance.lifecycle_state === "hidden"
        ? <button type="button" data-menu-close onClick={() => void suspend().catch(reportError)}>Pause component</button>
        : instance.lifecycle_state === "suspended"
          ? <button type="button" data-menu-close onClick={() => void resume().catch(reportError)}>Resume component</button>
          : null}
      {instance.surface_id !== "rho.settings" && (
        <button type="button" data-menu-close onClick={duplicate}>Duplicate component</button>
      )}
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
    {!dockviewOwnsChrome && <button
      type="button"
      className="rho-icon-btn"
      onClick={remove}
      aria-label={`Remove ${instance.instance_id} from layout`}
    >×</button>}
  </div> : null;
  return (
    <article
      className={`rho-surface rho-surface-${instance.lifecycle_state} ${focused ? "rho-surface-focused" : ""} ${isStrip ? "rho-surface-strip" : ""} ${dockviewOwnsChrome ? "rho-surface-dockview-hosted" : ""}`}
      data-instance-id={instance.instance_id}
      data-surface-id={instance.surface_id}
      data-surface-area={uxProfile.areaRole}
      data-surface-narrow={uxProfile.narrowBehavior}
      data-surface-default-focus={uxProfile.defaultFocus}
      aria-label={`${title} component`}
      onPointerDown={embedded && instance.surface_id !== "rho.console" ? undefined : () => {
        if (instance.surface_id === "rho.console") markConsolePreferred(instance.instance_id);
        if (!embedded) setFocus();
      }}
    >
      {dockviewOwnsChrome
        ? dockviewActionsHost != null && surfaceManagement != null
          ? createPortal(surfaceManagement, dockviewActionsHost)
          : null
        : <header className="rho-surface-chrome">
            <div className="rho-surface-title"><strong>{title}</strong></div>
            {surfaceManagement}
          </header>}
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
                  {hit.reference_kind === "plot" && hit.reference_id != null && <button type="button" data-reference-id={hit.reference_id} onClick={() => openPlot(hit.reference_id!)}>Open Plot</button>}
                </footer>
              </article>)}
            </div>}
            {consoleState.released_output_count > 0 && (
              <div className="rho-console-retention-notice" role="status">
                <span>{consoleState.released_output_count} older {consoleState.released_output_count === 1 ? "entry was" : "entries were"} released from this live view.</span>
                <button type="button" onClick={() => openSurfaceById("rho.runs")}>Open History</button>
              </div>
            )}
            {filteredOutputs.map(({ output, ordinal, runtimeGroup: outputRuntimeGroup }, visibleIndex) => (
              <section
                className="rho-console-entry"
                aria-label={`R Console execution ${ordinal}`}
                data-runtime-group-start={visibleIndex === 0 || filteredOutputs[visibleIndex - 1]?.runtimeGroup !== outputRuntimeGroup
                  ? "true"
                  : "false"}
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
                  {(visibleIndex === 0 || filteredOutputs[visibleIndex - 1]?.runtimeGroup !== outputRuntimeGroup) && <span className="rho-console-workspace-label">{
                    runtimes?.instances.find((candidate) =>
                      candidate.runtime_instance_id === output.runtime_instance_id
                    )?.display_label ?? "R runtime"
                  }</span>}
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
                <code className="rho-console-command"><span aria-hidden="true">&gt;</span> {output.code}</code>
                <div className="rho-console-results">
                  {output.blocks.map((result, index) => (
                    <div className={`rho-console-result rho-console-result-${result.kind}`} key={`${result.kind}:${index}`}>
                      {result.label != null && <strong>{result.label}</strong>}
                      <pre>{result.text}</pre>
                      {result.reference?.kind === "plot" && <button
                        type="button"
                        className="rho-runtime-output-reference"
                        data-reference-id={result.reference.id}
                        onClick={() => openPlot(result.reference!.id)}
                      >Open Plot</button>}
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
          withMutation={withFileMutation}
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
          createConversation={createAgentConversation}
          runConversation={runAgentConversation}
          persist={persistAgentViewState}
          pinTask={pinAgentTask}
          presentInStudio={presentAgentTurnInStudio}
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
          openSurfaceById={openSurfaceById}
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
      {instance.surface_id === "rho.settings" && (
        <SettingsSurfaceView
          instance={instance}
          transport={pluginTransport}
          factories={surfaceFactories}
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
            if (setAgentRuntimeOutputContext(reference)) openSurfaceById("rho.agent");
          }}
          openSurfaceById={openSurfaceById}
          openPlot={openPlot}
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
    </article>
  );
}
