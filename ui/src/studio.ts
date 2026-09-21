import { HostClient } from "./host-client";
import { Notifications } from "./shared/events";
import { RuntimeCoordinator } from "./runtime-coordinator";
import { ApplicationPersistence, Preferences } from "./application-state";
import { ApplicationBridge } from "./application-bridge";
import { Session } from "./session";
import { RuntimeSessions } from "./runtime-sessions";
import { RuntimeOwnerRegistry, nativeWorkspaceCapabilities, workspaceArguments, workspaceCommands, workspaceQuery } from "./runtime-ports";
import { operationWorkspaceInstance } from "./shared/ports";
import { Operations } from "./operations";
import { Console } from "./console";
import { Documents } from "./documents";
import { Objects } from "./objects";
import { Packages, packageCopyKey } from "./packages";
import { Files } from "./files";
import { Outputs } from "./outputs";
import { MediaCache } from "./media-cache";
import { Plots } from "./plots";
import { Help } from "./help";
import { Viewer } from "./viewer";
import { PanelLayout } from "./layout-model";
import { Navigation } from "./navigation";
import { Agents } from "./agents";
import { NativeAgents } from "./native-agents";
import { AgentTasks } from "./agent-tasks";
import { taskDraftCache, previewAgentAsset, releaseAgentAsset } from "./agent-task-adapter";
import { ComponentAgents } from "./component-agents";
import { componentDraftCache } from "./component-agent-adapter";
import { copyAgentText } from "./agent-adapter";
import { browserMedia } from "./media-adapter";
import { mediaKey } from "./output-ports";
import type { ApplicationBridgeSession } from "./generated/ApplicationBridgeSession";
import type { ApplicationContextState } from "./generated/ApplicationContextState";
import type { MediaPage } from "./generated/MediaPage";
import type { PackageSnapshotData } from "./generated/PackageSnapshotData";
import type { ObjectReadPage } from "./generated/ObjectReadPage";
import type { MediaReference } from "./generated/MediaReference";
import type { PersistenceFragment, QueryPort, RuntimeTarget } from "./shared/ports";

interface RuntimeWorkspace { id: string; console: Console; objects: Objects; packages: Packages }

/** Composition and client lifecycle only. Scientific state lives in its module. */
export class Studio {
  readonly notifications = new Notifications();
  readonly coordinator = new RuntimeCoordinator();
  readonly session: Session;
  readonly operations: Operations;
  readonly runtimeSessions: RuntimeSessions;
  readonly console: Console;
  readonly objects: Objects;
  readonly packages: Packages;
  readonly documents: Documents;
  readonly files: Files;
  readonly outputs: Outputs;
  readonly mediaCache: MediaCache;
  readonly plots: Plots;
  readonly help: Help;
  readonly viewer: Viewer;
  readonly layout: PanelLayout;
  readonly navigation: Navigation;
  readonly persistence: ApplicationPersistence;
  readonly preferences: Preferences;
  readonly application: ApplicationBridge;
  readonly agents: Agents;
  readonly nativeAgents: NativeAgents;
  readonly agentTasks: AgentTasks;
  readonly componentAgents: ComponentAgents;
  private readonly documentPersistence: PersistenceFragment;
  private readonly consolePersistence: PersistenceFragment;
  private readonly objectPersistence: PersistenceFragment;
  private readonly packagePersistence: PersistenceFragment;
  private readonly query: QueryPort;
  private readonly workspaces = new RuntimeOwnerRegistry<RuntimeWorkspace>();
  private startupContinuation = false;
  private readonly subscriptions: (() => void)[] = [];
  private stopped = false;
  private lifecycle = 0;
  private phase: "session" | "preferences" | "checkpoint" | "restore" | "native" | "operations" | "application" | "ready" = "session";
  private booting: Promise<void> | null = null;

  constructor(private readonly client: HostClient, options: { width?: number; applicationIdentity?: { windowId: string; incarnation: string; previousSession?: ApplicationBridgeSession } } = {}) {
    const query = this.coordinator.query(client.query.bind(client));
    this.query = query;
    const state = { readState: client.readState.bind(client), writeState: client.writeState.bind(client) };
    this.session = new Session({
      ...state, query, notifications: this.notifications,
      info: client.info.bind(client), rConfiguration: client.rConfiguration.bind(client),
      selectProject: client.selectProject.bind(client), probeR: client.probeR.bind(client), applyR: client.applyR.bind(client),
      quitWorkbench: client.quitWorkbench.bind(client),
      transition: { before: () => this.suspend(), after: (changed) => this.initialize(changed), failed: () => this.resumeAfterFailure() },
    });
    const windowId = options.applicationIdentity?.windowId ?? client.windowId;
    this.persistence = new ApplicationPersistence(state, this.session.context, `studio.${windowId}`, true);
    this.preferences = new Preferences(state);
    this.layout = new PanelLayout({ changed: this.persistence.changed, width: options.width });
    this.operations = new Operations({
      context: this.session.context, contextFor: this.session.contextFor, query, notifications: this.notifications,
      subscribe: client.subscribe.bind(client), getOperation: client.getOperation.bind(client),
      invoke: client.invoke.bind(client), cancel: client.cancel.bind(client),
      execution: (id) => this.workspaceFor(id ?? this.session.workspaceInstanceId).console.consoleState, changed: this.persistence.changed,
      flush: () => this.persistence.flush(), unsynced: () => this.persistence.unsynced, syncError: () => this.persistence.syncError,
    });
    this.runtimeSessions = new RuntimeSessions({ context: this.session.context, query,
      commands: { invoke: this.operations.invoke.bind(this.operations) }, changed: this.persistence.changed,
      schedule: () => this.coordinator.wake("runtime-sessions"),
      stopWork: (id) => this.workspaceFor(id).console.stopWork(),
      selectionChanged: (id) => { this.session.selectInstance(id); this.workspaceFor(id ?? "main"); this.operations.refreshAdmission(); },
      instanceObserved: (_previous, current) => { this.workspaceFor(current.workspace_instance_id);
        this.session.observeInstanceIdentity(current.workspace_instance_id, current.native_session_id); },
    });
    const main = this.workspaceFor("main"); this.console = main.console; this.objects = main.objects; this.packages = main.packages;
    const resource = (id: string) => ({ context: this.session.context, query,
      changed: this.persistence.changed, schedule: () => this.coordinator.wake(id) });
    this.files = new Files(resource("files"));
    this.documents = new Documents({ ...resource("files"),
      canRun: () => this.operations.canRun, queueing: () => this.operations.queueing,
      invoke: (id, args, preconditions) => this.operations.invoke(id, nativeWorkspaceCapabilities.has(id) ? workspaceArguments(this.session.workspaceInstanceId, args) : args, preconditions),
      run: this.operations.run.bind(this.operations), captureTarget: () => this.captureSelectedTarget(),
      openDocument: (id, name) => this.layout.show("document", id, name, { documentId: id }),
      renameDocument: (id, name) => this.layout.rename(id, name), closeDocument: (id) => this.layout.close(id),
      closeVersion: () => this.layout.getSnapshot().closeVersion,
      fileSaved: (project, path, hash) => this.notifications.send("fileSaved", { epoch: this.session.epoch, project, path, hash }),
      reportError: (error) => this.session.reportError(error),
    });
    this.outputs = new Outputs({ context: this.session.context, query,
      operations: { getRecord: this.operations.getRecord, getSummary: this.operations.getSummary,
        ensureOperation: this.operations.ensureOperation, listRecent: this.operations.listRecent.bind(this.operations),
        records: () => this.operations.records, summaries: () => this.operations.summaries },
      schedule: () => this.coordinator.wake("outputs"), appended: (event) => this.notifications.send("outputAppended", event),
    });
    this.mediaCache = new MediaCache({ context: this.session.context, query, adapter: browserMedia, schedule: () => this.coordinator.wake("media") });
    this.plots = new Plots({ outputs: this.outputs, changed: this.persistence.changed,
      openPlot: (id, name) => this.layout.show("plots", id, name), showPlots: () => this.layout.show("plots") });
    this.help = new Help({ context: this.session.context, query, changed: this.persistence.changed,
      schedule: () => this.coordinator.wake("help") });
    this.viewer = new Viewer({ outputs: this.outputs, changed: this.persistence.changed,
      openViewer: (id, name) => this.layout.show("viewer", id, name) });
    this.navigation = new Navigation({ context: this.session.context, show: this.layout.show.bind(this.layout),
      bindView: (view, id) => { if (this.runtimeSessions.getInstance(id)) this.runtimeSessions.pinView(view, id); },
      openDocument: this.documents.open.bind(this.documents), createDocument: this.documents.create.bind(this.documents),
      locatePlot: this.plots.locate.bind(this.plots), reportError: this.session.reportError.bind(this.session) });

    const context = (): Omit<ApplicationContextState, "version"> => {
      const layout = this.layout.getSnapshot(), session = this.session.context().session;
      const plot = this.plots.selectedEvidence(layout.activeTabId && layout.knownViews[layout.activeTabId]?.component === "plots" ? layout.activeTabId : "plots");
      const objectView = layout.activeTabId && layout.knownViews[layout.activeTabId]?.component === "viewer" ? layout.activeTabId : this.layout.has("objects") ? "objects" : undefined;
      const objectWorkspace = this.workspaceForView(objectView), packageWorkspace = this.workspaceForView(this.layout.has("packages") ? "packages" : undefined);
      const objectOwner = objectWorkspace.objects, packageOwner = packageWorkspace.packages;
      const objectNative = this.session.contextFor(objectWorkspace.id).session, packageNative = this.session.contextFor(packageWorkspace.id).session;
      const packageName = packageOwner.selected;
      const copy = packageName ? packageOwner.details.get(packageName)?.copies.find((copy) => packageCopyKey(copy) === packageOwner.sourceCopy) : null;
      const objectSelection = objectOwner.applicationSelection ?? (objectOwner.selected && objectNative ? { name: objectOwner.selected, native_session_id: objectNative, object_ref: null } : null);
      const packageSelection = packageOwner.applicationSelection ?? (packageName && copy && packageNative && packageOwner.session === packageNative && packageOwner.data?.observation_id
        ? { package: packageName, copy_id: packageCopyKey(copy), observation_id: packageOwner.data.observation_id, native_session_id: packageNative } : null);
      return {
        label: this.session.project?.split("/").at(-1) ?? "Rho Studio", active_document_id: this.documents.active, active_view_id: layout.activeTabId,
        native_session_id: session, workspace_instance_id: this.session.workspaceInstanceId,
        views: Object.entries(layout.knownViews).filter(([id]) => !layout.closedViews.has(id)).map(([view_id, view]) => {
          const native = ["console", "objects", "packages", "viewer"].includes(view.component);
          const pinned = native ? this.runtimeSessions.getSnapshot().viewTargets.get(view_id) : undefined;
          const workspace = pinned ? this.workspaceFor(pinned) : null, nativeSession = workspace ? this.session.contextFor(workspace.id).session : null;
          return { view_id, view_type: view.component, document_id: view.component === "document" ? (view.config as { documentId?: string } | undefined)?.documentId ?? view_id : null,
            active: layout.activeViewIds.includes(view_id), ...(workspace ? { workspace_instance_id: workspace.id } : {}), ...(nativeSession ? { native_session_id: nativeSession } : {}) };
        }),
        selected_object: objectSelection ? { ...objectSelection, workspace_instance_id: objectWorkspace.id } : null,
        selected_package: packageSelection ? { ...packageSelection, workspace_instance_id: packageWorkspace.id } : null,
        selected_plot: plot ? { operation_id: plot.operation_id, sequence: plot.sequence } : null,
      };
    };
    const activateView = (id: string, preserveCollapsed = false) => {
      if (preserveCollapsed && this.layout.isCollapsed(id)) return;
      const view = this.layout.getSnapshot().knownViews[id];
      if (!view || !this.layout.has(id)) throw new Error("The requested view is not open.");
      this.layout.show(view.component, id, view.name, view.config);
      if (view.component === "document") this.documents.activate((view.config as { documentId?: string } | undefined)?.documentId ?? id);
    };
    const identity = options.applicationIdentity ?? {
      windowId, incarnation: client.incarnation,
    };
    this.application = new ApplicationBridge({ scope: this.session.context, identity,
      previousSession: () => this.session.project ? client.previousBridgeSession(this.session.project) : undefined,
      transport: { bridge: client.applicationBridge.bind(client), execute: client.applicationExecute.bind(client), status: client.applicationStatus.bind(client), readDocument: client.applicationReadDocument.bind(client) },
      registered: (session) => { if (this.session.project) client.rememberBridgeSession(this.session.project, session); },
      reportError: this.session.reportError.bind(this.session),
      modules: {
        context, documents: this.documents.applicationDocuments.bind(this.documents), restoreDocuments: this.documents.applicationRestore.bind(this.documents),
        restoreViews: async (desired) => {
          // Observe any scientific evidence first. Resolve the latest local
          // intent only when all remaining layout commands can run together.
          const requested = desired(), project = this.session.project;
          let reference: MediaReference | null = null, plotError = "";
          if (requested.selected_plot && project) {
            const selection = requested.selected_plot;
            try {
              const observed = await query(project, "workspace.list_outputs", { operation_id: selection.operation_id, after_sequence: Math.max(0, selection.sequence - 1), limit: 1 });
              const found = (observed.data as MediaPage | null)?.media.find((item) => item.reference.sequence === selection.sequence)?.reference;
              if (observed.status === "ready" && found?.operation_id === selection.operation_id) reference = found;
              else plotError = observed.notices.join("\n") || "The synchronized selected plot is currently unavailable.";
            } catch (error) { plotError = error instanceof Error ? error.message : String(error); }
          }
          if (project !== this.session.project) throw new Error("The project changed while restoring the selected plot.");
          const saved = desired();
          const current = this.layout.getSnapshot();
          for (const id of Object.keys(current.knownViews)) if (this.layout.has(id) && !saved.views.some((view) => view.view_id === id)) this.layout.close(id);
          for (const view of saved.views) {
            const known = current.knownViews[view.view_id];
            const document = view.document_id ? this.documents.getDocumentSnapshot(view.document_id) : null;
            this.layout.restoreView(view.view_type, view.view_id, document?.name ?? known?.name,
              document ? { documentId: document.id } : known?.config);
            if (view.workspace_instance_id && ["console", "objects", "packages", "viewer"].includes(view.view_type))
              this.runtimeSessions.restoreViewTarget(view.view_id, view.workspace_instance_id);
          }
          if (saved.selected_object) {
            const id = saved.selected_object.workspace_instance_id ?? this.session.workspaceInstanceId;
            if (saved.selected_object.native_session_id === this.session.contextFor(id).session && saved.selected_object.object_ref)
              this.workspaceFor(id).objects.selectObservation(saved.selected_object);
          }
          if (saved.selected_package) {
            const id = saved.selected_package.workspace_instance_id ?? this.session.workspaceInstanceId;
            if (saved.selected_package.native_session_id === this.session.contextFor(id).session) this.workspaceFor(id).packages.restoreSelection(saved.selected_package);
          }
          if (saved.selected_plot && requested.selected_plot && saved.selected_plot.operation_id === requested.selected_plot.operation_id && saved.selected_plot.sequence === requested.selected_plot.sequence) {
            if (reference) {
              this.outputs.restoreReferences([mediaKey(reference)]); this.plots.restoreSelection(reference);
            } else if (plotError) this.session.reportError(plotError);
          }
          for (const view of saved.views) if (view.active) activateView(view.view_id, true);
          if (saved.active_view_id) activateView(saved.active_view_id, true);
          if (saved.active_document_id) this.documents.activate(saved.active_document_id);
        },
        openView: (type, id) => {
          if (type === "console" && id && id !== "console") this.workspaceForView(id).console.updateView(id, {});
          if (type === "plots" && id) this.plots.ensureView(id);
          this.layout.show(type, id);
        },
        activateView, closeView: this.layout.close.bind(this.layout), openDocument: this.documents.open.bind(this.documents),
        createDocument: (path, text) => { this.documents.applicationCreate(path, text); },
        checkDocument: this.documents.applicationCheck.bind(this.documents), setSelection: this.documents.applicationSetSelection.bind(this.documents),
        editDocument: this.documents.applicationEdit.bind(this.documents), confirmSave: this.documents.applicationConfirmSave.bind(this.documents),
        selectObject: async (selection) => {
          const id = selection.workspace_instance_id ?? this.session.workspaceInstanceId, scope = this.session.contextFor(id), owner = this.workspaceFor(id).objects;
          if (scope.session !== selection.native_session_id) throw new Error("The object's native session changed.");
          if (!selection.object_ref) throw new Error("An object observation reference is required.");
          const observed = await query(scope.project!, "workspace.read_object", workspaceArguments(id, { expected_session: selection.native_session_id, object_ref: selection.object_ref, kind: "structure" }));
          if (observed.status !== "ready" || this.session.project !== scope.project || this.session.contextFor(id).session !== selection.native_session_id) throw new Error(observed.notices.join("\n") || "The object observation is no longer valid.");
          const page = observed.data as ObjectReadPage | null;
          if (!page || page.root_name !== selection.name || page.observed_path.length !== 0) throw new Error("The object reference does not identify this exact root binding.");
          owner.selectObservation(selection, page); this.runtimeSessions.restoreViewTarget("objects", id); this.layout.show("objects");
        },
        selectPackage: async (selection) => {
          const project = this.session.project!, instanceId = selection.workspace_instance_id ?? this.session.workspaceInstanceId, owner = this.workspaceFor(instanceId).packages, pages: PackageSnapshotData[] = [];
          let offset: number | null = 0;
          while (offset !== null) {
            const observed = await query(project, "workspace.packages", workspaceArguments(instanceId, { mode: "installed", grouped: true, filter: "", package_name: selection.package,
              observation_id: selection.observation_id, expected_session: selection.native_session_id, offset, limit: 200 }));
            const page = observed.data as PackageSnapshotData | null;
            if (observed.status !== "ready" || !page || page.observation_id !== selection.observation_id || page.offset !== offset || this.session.project !== project || this.session.contextFor(instanceId).session !== selection.native_session_id)
              throw new Error(observed.notices.join("\n") || "The exact installed-copy observation is no longer available.");
            pages.push(page);
            if (page.packages.some((copy) => packageCopyKey(copy) === selection.copy_id)) break;
            if (page.next_offset !== null && page.next_offset <= offset) throw new Error("Package copy continuation did not advance.");
            offset = page.next_offset;
          }
          owner.selectObservedCopy(pages, selection.copy_id, selection.native_session_id); this.runtimeSessions.restoreViewTarget("packages", instanceId); this.layout.show("packages");
        },
        selectPlot: async (selection) => {
          const project = this.session.project!;
          await this.operations.ensureOperation(selection.operation_id);
          const observed = await query(project, "workspace.list_outputs", { operation_id: selection.operation_id, after_sequence: Math.max(0, selection.sequence - 1), limit: 1 });
          const page = observed.data as MediaPage | null;
          const reference = page?.media.find((item) => item.reference.sequence === selection.sequence)?.reference;
          if (this.session.project !== project || observed.status !== "ready" || !reference || reference.operation_id !== selection.operation_id) throw new Error(observed.notices.join("\n") || "The original plot reference is unavailable.");
          this.outputs.restoreReferences([mediaKey(reference)]); this.plots.locate(reference);
        },
      },
    });

    this.agents = new Agents({ context: this.session.context,
      window: () => this.application.getSnapshot().online ? this.application.window : null,
      read: client.agentConnection.bind(client), configuration: client.agentConfiguration.bind(client),
      copy: copyAgentText, schedule: () => this.coordinator.wake("agents") });
    this.nativeAgents = new NativeAgents({ context: this.session.context,
      window: () => this.application.getSnapshot().online ? this.application.window : null,
      discover: request => client.discoverAgent(request), test: request => client.testAgent(request),
      setup: request => client.setupAgent(request),
      schedule: () => this.coordinator.wake("native-agents") });
    this.agentTasks = new AgentTasks({ context: this.session.context, windowId,
      window: () => this.application.getSnapshot().online ? this.application.window : null,
      query: request => client.agentTaskQuery(request), command: request => client.agentTaskCommand(request),
      projectQuery: request => client.agentTaskQuery(request),
      handoffQuery: request => client.agentHandoffQuery(request), handoffCommand: request => client.agentHandoffCommand(request),
      synchronizeRhoDraft: async reference => {
        const owner = this.componentAgents, id = reference.conversation_id;
        if (owner.getSnapshot().drafts.get(id)?.dirty) await owner.flushDraft(id);
        const draft = owner.getSnapshot().drafts.get(id);
        if (draft?.dirty || draft?.conflict != null) throw new Error("Save or resolve this task's current draft before preparing the handoff.");
      },
      refreshRhoTask: reference => this.componentAgents.observeConversation(reference.conversation_id),
      discover: request => client.discoverAgent(request),
      asset: async request => previewAgentAsset(await client.agentAsset(request)), releaseAsset: releaseAgentAsset,
      ...taskDraftCache(windowId), changed: this.persistence.changed,
      schedule: () => { this.coordinator.wake("agent-task-summary"); this.coordinator.wake("agent-task-events"); } });
    this.componentAgents = new ComponentAgents({ context: this.session.context,
      selectedConversation: () => { const selected = this.agentTasks.getSnapshot().selectedTask; return selected?.kind === "rho" ? selected.conversation_id : null; },
      synchronizeContext: () => this.application.flush(),
      window: () => this.application.getSnapshot().online ? this.application.window : null,
      query: request => client.componentQuery(request), command: request => client.componentCommand(request),
      sourceSearch: request => client.componentSourceSearch(request),
      sourcePreview: request => client.componentSourcePreview(request),
      asset: async request => previewAgentAsset(await client.componentAsset(request)), releaseAsset: releaseAgentAsset,
      credential: request => client.componentCredential(request), test: request => client.componentModelTest(request),
      initial: (profile, viewId) => {
        const workspace = profile === "environment" && viewId && this.runtimeSessions.getInstance(viewId) ? this.workspaceFor(viewId) : this.workspaceForView(viewId), native = this.session.contextFor(workspace.id).session;
        const session = native ? { workspace_instance_id: workspace.id, session_id: native } : null;
        const sources: import("./generated/AgentContextSelection").AgentContextSelection[] = [];
        const reference = { workspace_instance_id: workspace.id, expected_session: native };
        if (profile === "objects" && native && workspace.objects.selected)
          sources.push({ source: "objects", label: workspace.objects.selected, reference: { ...reference, name: workspace.objects.selected }, inclusion: "summary" });
        if (profile === "packages" && native && workspace.packages.applicationSelection) {
          const selected = workspace.packages.applicationSelection;
          const copy = workspace.packages.details.get(selected.package)?.copies.find(copy => packageCopyKey(copy) === selected.copy_id);
          if (copy) sources.push({ source: "packages", label: selected.package, reference: { ...reference, package: selected.package, library_path: copy.library_path, observation_id: selected.observation_id }, inclusion: "summary" });
        }
        if (profile === "plots") {
          const plot = this.plots.selectedEvidence(viewId ?? "plots");
          if (plot) sources.push({ source: "plots", label: "Selected plot", reference: { ...plot }, inclusion: "image" });
        }
        if (profile === "workspace" && native) sources.push({ source: "workspace", label: "Console / Workspace", reference, inclusion: "summary" });
        if (profile === "environment") sources.push({ source: "environment", label: workspace.id, reference: { workspace_instance_id: workspace.id }, inclusion: "summary" });
        if (profile === "project" && this.files.selected) sources.push({ source: "files", label: this.files.selected, reference: { path: this.files.selected }, inclusion: "text" });
        const documentId = this.documents.applicationDocuments().some(d => d.document_id === viewId) ? viewId : this.documents.active ?? undefined;
        return { session, sources, documentId };
      },
      ...componentDraftCache(windowId) });

    this.consolePersistence = this.workspaceFragment("console", "runtimeConsoleViews");
    this.objectPersistence = this.workspaceFragment("objects", "runtimeObjectViews");
    this.packagePersistence = this.workspaceFragment("packages", "runtimePackageViews");
    for (const fragment of [this.operations, this.runtimeSessions, this.consolePersistence, this.files, this.objectPersistence, this.packagePersistence, this.plots, this.layout, this.agentTasks])
      this.persistence.register(fragment);
    this.documentPersistence = { serialize: () => ({}),
      restorationKey: () => ({ active: this.documents.active, documents: this.documents.applicationDocuments().map((d) => [d.document_id, d.version, d.selection.version]) }),
      restore: (value) => this.documents.restore((value as { documents?: unknown } | null)?.documents) };
    this.persistence.register(this.documentPersistence);
    this.persistence.prepareRestore();

    this.subscriptions.push(
      this.notifications.on("projectChanged", () => {
        if (this.phase === "ready") this.phase = "checkpoint";
        this.session.setReady(false);
        this.operations.reset(); this.runtimeSessions.reset(); this.resetWorkspaces(); this.files.reset(); this.startupContinuation = false;
        this.documents.reset(); this.outputs.reset(); this.mediaCache.reset(); this.plots.reset(); this.help.reset(); this.viewer.reset(); this.layout.resetState(); this.navigation.reset();
        this.application.reset(); this.agents.reset(); this.nativeAgents.reset();
        this.agentTasks.reset();
        this.componentAgents.reset();
        this.persistence.prepareRestore();
      }),
      this.notifications.on("sessionChanged", () => {
        this.agents.reset();
        this.nativeAgents.reset();
        this.application.disconnected();
        this.operations.sessionChanged(); this.documents.sessionChanged();
        for (const workspace of this.workspaces.values()) { workspace.console.resetSession(); workspace.objects.sessionChanged(); workspace.packages.sessionChanged(); }
        this.outputs.sessionChanged(); this.mediaCache.sessionChanged();
      }),
      this.notifications.on("instanceChanged", (event) => {
        const workspace = this.workspaces.get(event.workspaceInstanceId);
        workspace?.console.resetSession(); workspace?.objects.sessionChanged(); workspace?.packages.sessionChanged();
        this.operations.refreshAdmission();
      }),
      this.notifications.on("operationChanged", (event) => {
        const record = this.operations.getRecord(event.operationId), id = event.workspaceInstanceId ?? (record ? operationWorkspaceInstance(record) : undefined);
        const workspace = id ? this.workspaces.get(id) : this.runtimeSessions.supported ? null : this.workspaces.get("main");
        workspace?.objects.operationChanged(event); workspace?.packages.operationChanged(event);
        if (event.capability.startsWith("runtime.") || event.capability.startsWith("workspace.checkpoint_")) this.runtimeSessions.invalidate(id);
      }),
      this.notifications.on("operationChanged", (event) => this.files.operationChanged(event)),
      this.notifications.on("operationChanged", (event) => this.outputs.operationChanged(event)),
      this.notifications.on("fileSaved", (event) => this.files.fileSaved(event)),
      this.layout.subscribe(() => this.notifications.send("viewsChanged", { activeViewIds: this.layout.getSnapshot().activeViewIds })),
      this.notifications.on("viewsChanged", ({ activeViewIds }) => this.mediaCache.protect(this.plots.protectedMedia(activeViewIds))),
      this.notifications.on("viewsChanged", (event) => {
        for (const workspace of this.workspaces.values()) { workspace.objects.viewsChanged(event); workspace.packages.viewsChanged(event); }
      }),
      this.notifications.on("viewsChanged", (event) => this.agentTasks.viewsChanged(event)),
      this.plots.subscribe(() => this.mediaCache.protect(this.plots.protectedMedia(this.layout.getSnapshot().activeViewIds))),
    );
    const ready = (task: () => Promise<void | boolean>) => async () => {
      if (this.phase === "ready" && !this.stopped) return task();
    };
    this.coordinator.register("bootstrap", 250, () => this.advanceStartup());
    this.coordinator.register("health", 2000, async () => {
      if (this.phase === "session" || this.session.switching || this.stopped) return;
      await this.session.health();
      if (this.phase === "ready" && this.persistence.unsynced) await this.persistence.flush();
    });
    this.coordinator.register("runtime-sessions", 2000, ready(async () => { if (this.runtimeSessions.supported) return this.runtimeSessions.observe(); }));
    this.coordinator.register("runtime-startup", 250, ready(() => this.continueStartup()));
    this.coordinator.register("application", 250, ready(() => this.application.step()));
    this.coordinator.register("application-lease", 5000, async () => { if (!this.stopped) await this.application.heartbeat(); });
    this.coordinator.register("events", 250, ready(async () => {
      await this.operations.initialize(this.workspaceOperationIds());
      return this.operations.consumeEvents();
    }));
    this.coordinator.register("agents", 2000, async () => { if (!this.stopped) await this.agents.observe(); });
    this.coordinator.register("native-agents", 500, async () => { if (!this.stopped) await this.nativeAgents.observe(); });
    this.coordinator.register("agent-task-summary", 1000, async () => { if (!this.stopped) await this.agentTasks.observeSummary(); });
    this.coordinator.register("help", 500, ready(() => this.help.observe()));
    this.coordinator.register("agent-task-events", 250, async () => { if (!this.stopped) await this.agentTasks.observeEvents(); });
    this.coordinator.register("pending", 2000, ready(async () => {
      await this.operations.reconcilePending(); await this.operations.ensureReferences(this.workspaceOperationIds());
    }));
    this.coordinator.register("files", 2000, ready(async () => { await this.files.observe(); return this.files.needsObservation; }));
    this.coordinator.register("storage", 10000, ready(() => this.files.observeStorage()));
    this.coordinator.register("outputs", 250, ready(() => this.outputs.step()));
    this.coordinator.register("media", 250, ready(() => this.mediaCache.step()));
  }
  workspaceFor(id = this.runtimeSessions?.selectedId ?? "main"): RuntimeWorkspace {
    const existing = this.workspaces.get(id); if (existing) return existing;
    const query = workspaceQuery(id, this.query), commands = workspaceCommands(id, { invoke: this.operations.invoke.bind(this.operations) });
    const context = () => this.session.contextFor(id);
    const resource = (kind: string) => ({ context, query, changed: this.persistence.changed, schedule: () => this.coordinator.wake(`${kind}:${id}`) });
    const console = new Console({ context, query, invoke: commands.invoke,
      run: (code, source) => this.operations.run(code, source, undefined, id), cancel: (operation, pending) => this.operations.cancel(operation, pending, id),
      respondInput: this.client.respondInput.bind(this.client), changed: this.persistence.changed,
      schedule: () => this.coordinator.wake(`control:${id}`), controlChanged: () => this.operations.refreshAdmission(),
      showConsole: (view, name) => this.layout.show("console", view, name) });
    const workspace = { id, console, objects: new Objects(resource("objects")), packages: new Packages(resource("packages")) };
    this.workspaces.register(id, workspace);
    const active = () => this.phase === "ready" && !this.stopped;
    const nativeReady = () => !this.runtimeSessions.supported || this.runtimeSessions.getInstance(id)?.state === "ready";
    this.coordinator.register(`control:${id}`, 250, async () => { if (active() && nativeReady()) await console.refresh(); });
    this.coordinator.register(`runtime:${id}`, 2000, async () => {
      if (!active()) return;
      if (this.runtimeSessions.supported) await this.runtimeSessions.refreshInstance(id);
      if (nativeReady()) await this.session.refreshRuntime(id);
      this.operations.refreshAdmission();
    });
    this.coordinator.register(`objects:${id}`, 2000, async () => {
      if (!active()) return; await workspace.objects.observe(); return workspace.objects.needsObservation;
    });
    this.coordinator.register(`packages:${id}`, 2000, async () => {
      if (!active()) return; await workspace.packages.observe(); return workspace.packages.needsObservation;
    });
    return workspace;
  }
  workspaceForView(viewId?: string) { return this.workspaceFor(viewId ? this.runtimeSessions.targetForView(viewId) ?? "main" : this.runtimeSessions.selectedId ?? "main"); }
  private workspaceFragment(owner: "console" | "objects" | "packages", key: string): PersistenceFragment {
    return {
      serialize: () => ({ ...this.workspaceFor("main")[owner].serialize(),
        [key]: Object.fromEntries([...this.workspaces].filter(([id]) => id !== "main").map(([id, workspace]) => [id, workspace[owner].serialize()])) }),
      restore: (value) => {
        this.workspaceFor("main")[owner].restore(value);
        const saved = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null;
        if (saved && typeof saved === "object" && !Array.isArray(saved)) for (const [id, fragment] of Object.entries(saved).slice(0, 128))
          if (id && id !== "main") this.workspaceFor(id)[owner].restore(fragment);
      },
    };
  }
  private resetWorkspaces() {
    for (const workspace of this.workspaces.values()) {
      workspace.console.reset(); workspace.objects.reset(); workspace.packages.reset();
      if (workspace.id !== "main") {
        workspace.console.stop(); workspace.objects.stop(); workspace.packages.stop(); this.workspaces.release(workspace.id);
        for (const name of ["control", "runtime", "objects", "packages"]) this.coordinator.unregister(`${name}:${workspace.id}`);
      }
    }
  }
  private workspaceOperationIds() { return [...new Set([...this.workspaces.values()].flatMap((workspace) => workspace.console.operationIds()))]; }
  private captureSelectedTarget(): RuntimeTarget {
    if (this.runtimeSessions.supported) return this.runtimeSessions.captureTarget();
    const scope = this.session.context();
    if (!scope.session) throw new Error("R is unavailable. Your input is retained.");
    return Object.freeze({ workspaceInstanceId: scope.workspaceInstanceId ?? "main", nativeSessionId: scope.session, continuationLineageId: scope.session });
  }
  /** Startup policy is an explicit lifecycle command after UI/drafts are ready, never a query side effect. */
  private async continueStartup() {
    if (!this.startupContinuation || !this.runtimeSessions.supported) return;
    const project = this.session.project, lifecycle = this.lifecycle;
    if (!this.runtimeSessions.selected) await this.runtimeSessions.initialize();
    if (this.stopped || project !== this.session.project || lifecycle !== this.lifecycle) return;
    const selected = this.runtimeSessions.selected;
    if (!selected) return;
    this.startupContinuation = false;
    if (selected.state === "ready") { await this.session.refreshRuntime(selected.workspace_instance_id); this.operations.refreshAdmission(); return; }
    if (selected.state !== "stopped") return;
    const unresolved = this.operations.pending.some((pending) => {
      const args = pending.invocation.arguments;
      return args && typeof args === "object" && !Array.isArray(args) && args.workspace_instance_id === selected.workspace_instance_id && pending.invocation.capability.id.startsWith("runtime.");
    });
    if (unresolved) { this.session.reportError("The previous R session request is unconfirmed. Check the original request before starting R."); return; }
    await this.runtimeSessions.continueInstance(selected.workspace_instance_id);
    if (!this.stopped && project === this.session.project && lifecycle === this.lifecycle) {
      this.coordinator.wake(`runtime:${selected.workspace_instance_id}`); this.coordinator.wake(`control:${selected.workspace_instance_id}`);
    }
  }
  async start() {
    this.stopped = false;
    this.coordinator.startReads();
    await this.advanceStartup().catch(() => {});
    if (!this.stopped) this.coordinator.start();
  }
  private async suspend() {
    await this.agentTasks.flushAll();
    await this.application.flush();
    await this.persistence.flush();
    if (this.persistence.unsynced) throw new Error(this.persistence.syncError || "Drafts are not synced. The project was not switched.");
    this.lifecycle++;
    this.booting = null;
    this.session.setReady(false);
    this.coordinator.stop(); this.client.stopReads();
  }
  private async initialize(projectChanged: boolean) {
    if (this.stopped) return;
    this.lifecycle++; this.booting = null;
    this.phase = projectChanged ? "checkpoint" : "native";
    this.session.setReady(false);
    this.coordinator.startReads();
    try { await this.advanceStartup(); }
    finally { if (!this.stopped) this.coordinator.start(); }
  }
  private resumeAfterFailure() {
    if (this.stopped) return;
    if (this.phase === "ready") this.phase = "native";
    this.coordinator.start();
  }
  /** A failed read retries its current startup stage; it cannot skip persisted requests or drafts. */
  private async advanceStartup(): Promise<void> {
    if (this.stopped || this.phase === "ready") return;
    if (this.booting) return this.booting;
    const lifecycle = this.lifecycle;
    const current = () => !this.stopped && lifecycle === this.lifecycle;
    const task = (async () => {
      try {
        if (this.phase === "session") {
          await this.session.start();
          if (!current()) return;
          this.phase = "preferences";
        }
        if (this.phase === "preferences") {
          await this.preferences.restore();
          if (!current()) return;
          this.phase = "checkpoint";
        }
        if (this.phase === "checkpoint") {
          await this.operations.beginBaseline();
          if (!current()) return;
          this.phase = "restore";
        }
        if (this.phase === "restore") {
          const retained = await this.persistence.restore();
          if (!current()) return;
          this.application.prepareRestore({ views: retained.has(this.layout), documents: retained.has(this.documentPersistence),
            object: retained.has(this.objectPersistence), package: retained.has(this.packagePersistence), plot: retained.has(this.plots) });
          this.phase = "native";
        }
        if (this.phase === "native") {
          if (this.runtimeSessions.supported) {
            // The editor/application lane proceeds even when R needs slow restoration or attention.
            this.startupContinuation = true;
            await this.runtimeSessions.initialize().catch(() => {});
          } else {
            await this.session.refreshRuntime().catch(() => {});
            if (!current()) return;
            await this.console.refresh().catch(() => {});
          }
          if (!current()) return;
          this.phase = "operations";
        }
        if (this.phase === "operations") {
          await this.operations.initialize(this.workspaceOperationIds());
          if (!current()) return;
          if (this.session.project && !this.operations.initialized) return;
          this.outputs.restoreReferences(this.plots.retainedReferences());
          this.files.listDirectory();
          this.phase = "application";
        }
        if (this.phase === "application") {
          await this.application.start();
          if (!current() || !this.application.ready) return;
          this.phase = "ready";
          this.session.setReady(true);
          this.operations.refreshAdmission();
        }
      } catch (error) {
        if (current()) this.session.reportError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    })();
    this.booting = task;
    try { await task; }
    finally { if (this.booting === task) this.booting = null; }
  }
  stop() {
    this.application.stop();
    this.agents.stop();
    this.nativeAgents.stop();
    this.agentTasks.stop();
    this.componentAgents.dispose();
    this.stopped = true; this.lifecycle++; this.session.stop(); this.coordinator.stop(); this.client.stopReads(); this.persistence.stop(); this.preferences.stop();
    this.operations.stop(); this.runtimeSessions.stop(); this.documents.stop(); this.files.stop();
    for (const workspace of this.workspaces.values()) { workspace.console.stop(); workspace.objects.stop(); workspace.packages.stop(); }
    this.outputs.stop(); this.mediaCache.stop(); this.plots.stop(); this.navigation.stop(); this.layout.stop();
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.notifications.dispose();
  }
}
