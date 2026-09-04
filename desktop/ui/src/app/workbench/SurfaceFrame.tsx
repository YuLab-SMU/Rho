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
  PluginSurfaceDocumentRequest,
  ResourceDescriptor,
  ResourceRegistrySnapshot,
  RuntimeDescriptor,
  RuntimeExecution,
  RuntimeExecutionStartResponse,
  RuntimeExecutionSourceContext,
  RuntimeOutputFollowFrame,
  RuntimeOutputPage,
  RunAgentRequest,
  RuntimeOutputSearchResult,
  RuntimeRegistrySnapshot,
  RuntimeProviderRegistration,
  SurfaceInstance,
  SurfaceFactoryRegistration,
  UiKernelTransport,
} from "../../transport";
import { AgentSurface } from "../agent/AgentSurface";
import {
  RuntimeCenterSurface,
  type RuntimeConsoleAttachment,
} from "../authority/RuntimeCenterSurface";
import type { AgentSurfaceState } from "../agent/AgentSurface";
import { CheckResultView } from "../CheckResultView";
import { DOMAIN_SURFACE_IDS, DomainSurfaceView } from "../DomainSurfaceView";
import { FileResourceView } from "../FileResourceView";
import type { FileResourceViewProps } from "../FileResourceView";
import { MenuPopover } from "../MenuPopover";
import { NavigatorSurfaceView } from "../Navigator";
import { PluginSurfaceView } from "../PluginSurfaceView";
import { SurfaceTaskState } from "../SurfaceTaskState";
import { SettingsSurfaceView } from "../SettingsSurfaceView";
import { ConsoleSurface } from "../console/ConsoleSurface";
import type { ConsoleTranscriptRow } from "../console/ConsoleSurface";
import { consoleProjectionBlocksText } from "../console-output";
import {
  consoleTranscriptOutputs,
  ConsoleInstanceController,
  initialConsoleState,
  needsConsoleStateCompaction,
} from "../controllers/console-instance-controller";
import type {
  ConsoleOutputRecord,
  ConsolePersistentViewState,
  ConsoleViewState,
} from "../controllers/console-instance-controller";
import type {
  ConsoleExecutionAdmission,
  ConsoleExecutionEndpoint,
} from "../controllers/console-execution-router";
import { surfaceUxProfile } from "../surface-ux";
import { SurfaceRouter } from "./SurfaceRouter";
import { createAuthorityPorts } from "./authorityPorts";
import { createAgentCorePorts } from "./agentPorts";
import { createEvidenceGraphPorts } from "./evidenceGraphPorts";
import { createResultsPorts } from "./resultsPorts";

interface SurfaceFrameProps {
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
  readonly stopRuntime: (runtime: RuntimeDescriptor) => Promise<void>;
  readonly createRuntime: (
    provider: RuntimeProviderRegistration,
    label: string | null,
    openConsole: boolean,
  ) => Promise<void>;
  readonly openRuntimeConsole: (runtime: RuntimeDescriptor, createAnother: boolean) => Promise<void>;
  readonly runtimeConsoleAttachments: readonly RuntimeConsoleAttachment[];
  readonly persistConsole: (viewState: ConsolePersistentViewState) => Promise<void>;
  readonly registerConsoleExecution: (endpoint: ConsoleExecutionEndpoint) => () => void;
  readonly markConsolePreferred: (instanceId: string) => void;
  readonly resources: ResourceRegistrySnapshot | null;
  readonly activeFileResourceId: string | null;
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
  readonly openFindingReference: (path: string) => Promise<void>;
  readonly agentHealth: { readonly state: string; readonly label: string; readonly detail: string | null } | null;
  readonly runAgentConversation: (
    current: AgentSurfaceState,
    request: RunAgentRequest,
    onAccepted?: (conversationId: string) => void,
  ) => Promise<AgentSurfaceState>;
  readonly persistAgentViewState: (viewState: AgentSurfaceState) => Promise<void>;
  readonly persistSurfaceViewState: (viewState: unknown) => Promise<void>;
  readonly openNavigatorFile: (descriptor: ResourceDescriptor) => Promise<void>;
  readonly openSurfaceById: (surfaceId: string, viewStateOverride?: unknown) => void;
  readonly openPlot: (plotId: string) => void;
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
export function SurfaceFrame({
  instance, focused, setFocus, remove, duplicate, suspend, resume, persistDraft, draftCache,
  consoleSessionCache,
  availableModes, setMode,
  runtimes, attachRuntime, detachRuntime, startRuntimeExecution, followRuntimeOutput,
  listRuntimeExecutions, loadRuntimeOutputPage, interruptRuntime,
  loadRuntimeOutputPageBefore,
  restartRuntime, stopRuntime, createRuntime, openRuntimeConsole, runtimeConsoleAttachments,
  persistConsole, registerConsoleExecution, markConsolePreferred,
  resources, activeFileResourceId, readResource, updateResourceDraft, withFileMutation,
  reloadResource, renameResource, deleteResource,
  refreshResourceBinding, setViewGroup, persistFileViewState, reportError,
  pluginTransport, surfaceFactories, pluginDocumentRequest, projectRevision, openFindingReference,
  agentHealth, runAgentConversation, persistAgentViewState,
  persistSurfaceViewState,
  openNavigatorFile, openSurfaceById, openPlot,
  embedded, dockviewHosted,
}: SurfaceFrameProps) {
  const authorityPorts = createAuthorityPorts(pluginTransport);
  const agentCore = createAgentCorePorts(pluginTransport);
  const evidencePorts = createEvidenceGraphPorts(pluginTransport);
  const resultsPorts = createResultsPorts(pluginTransport);
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
  const transcriptRows: ConsoleTranscriptRow[] = transcriptOutputs.map((output, index) => {
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
        <ConsoleSurface
          instance={instance}
          consoleFilterOpen={consoleFilterOpen}
          setConsoleFilterOpen={setConsoleFilterOpen}
          consoleState={consoleState}
          consoleController={consoleController}
          consoleSearchBusy={consoleSearchBusy}
          consoleSearch={consoleSearch}
          filteredOutputs={filteredOutputs}
          transcriptOutputs={transcriptOutputs}
          closeConsoleFilter={closeConsoleFilter}
          consoleRunning={consoleRunning}
          attached={attached}
          runtimes={runtimes}
          detachRuntime={detachRuntime}
          attachRuntime={attachRuntime}
          reportError={reportError}
          consoleOutputRef={consoleOutputRef}
          consoleNeedle={consoleNeedle}
          durableSearchHits={durableSearchHits}
          openSurfaceById={openSurfaceById}
          openPlot={openPlot}
          commitConsole={commitConsole}
          consoleBusy={consoleBusy}
          submitConsole={submitConsole}
          interruptRuntime={interruptRuntime}
          runtimeRecovering={runtimeRecovering}
        />
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
          openReference={openFindingReference}
          reportError={reportError}
        />
      )}
      {instance.surface_id === "rho.agent" && (
        <AgentSurface
          instance={instance}
          transport={agentCore}
          health={agentHealth}
          runConversation={runAgentConversation}
          persist={persistAgentViewState}
          reportError={reportError}
        />
      )}
      {instance.surface_id === "rho.runtimes" && (
        <RuntimeCenterSurface
          snapshot={runtimes}
          consoleAttachments={runtimeConsoleAttachments}
          createRuntime={createRuntime}
          openConsole={openRuntimeConsole}
          interruptRuntime={interruptRuntime}
          restartRuntime={restartRuntime}
          stopRuntime={stopRuntime}
          reportError={reportError}
        />
      )}
      {instance.surface_id === "rho.navigator" && (
        <NavigatorSurfaceView
          instance={instance}
          transport={pluginTransport}
          resources={resources}
          activeResourceId={activeFileResourceId}
          openFile={openNavigatorFile}
          persist={persistSurfaceViewState}
          reportError={reportError}
          openSurfaceById={openSurfaceById}
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
      <SurfaceRouter
        instance={instance}
        authorityPorts={authorityPorts}
        evidencePorts={evidencePorts}
        resultsPorts={resultsPorts}
        reportError={reportError}
        openSurface={openSurfaceById}
        openPlot={openPlot}
      />
      {DOMAIN_SURFACE_IDS.has(instance.surface_id) && (
        <DomainSurfaceView
          instance={instance}
          transport={pluginTransport}
          persist={persistSurfaceViewState}
          reportError={reportError}
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
    </article>
  );
}
