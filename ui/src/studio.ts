import type { MediaPage } from "./generated/MediaPage";
import type { RunRArguments } from "./generated/RunRArguments";
import type { ConsoleState } from "./generated/ConsoleState";
import type { RunSource } from "./generated/RunSource";
import { Documents } from "./documents";
import { Packages } from "./packages";
import { newPlotView } from "./plot-viewport";
import type { PlotView } from "./plot-viewport";
import type { Placement } from "./layout-model";
import type { DirectoryPage } from "./generated/DirectoryPage";
import type { WorkspaceSnapshotData } from "./generated/WorkspaceSnapshotData";
import type { BindingSummary } from "./generated/BindingSummary";
import { HostClient, json, message } from "./host-client";
import type { WorkbenchInfo } from "./generated/WorkbenchInfo";
import type { RConfiguration } from "./generated/RConfiguration";
import type { ApplicationState } from "./generated/ApplicationState";
import type { OperationRecord } from "./generated/OperationRecord";
import type { Invocation } from "./generated/Invocation";
import type { RuntimeStatus } from "./generated/RuntimeStatus";
import type { RecentOperations } from "./generated/RecentOperations";
import type { OutputEvent } from "./generated/OutputEvent";
import type { OutputEvents } from "./generated/OutputEvents";
import type { MediaReference } from "./generated/MediaReference";
import type { OutputPage } from "./generated/OutputPage";
import type { Precondition } from "./generated/Precondition";

export interface PendingRequest {
  invocation: Invocation;
  operationId?: string;
  ignored?: boolean;
  error?: string;
}
export const terminal = (status: string) =>
  ["succeeded", "failed", "cancelled", "uncertain"].includes(status);

/** Documents, requests and observations outlive every panel and layout. */
export class Studio {
  info: WorkbenchInfo | null = null;
  readonly documents = new Documents(this);
  readonly packages = new Packages(this);
  directory: DirectoryPage | null = null;
  directories = new Map<string, DirectoryPage>();
  expandedDirectories = new Set<string>([""]);
  filesScrollTop = 0;
  showHiddenFiles = false;
  expandedObjects = new Set<string>();
  directoryError = "";
  directoryLoading = false;
  objects: WorkspaceSnapshotData | null = null;
  objectsObservedAt: number | null = null;
  objectsNotice = "";
  inspectors = new Map<
    string,
    { binding: BindingSummary; observedAt: number; notice: string }
  >();
  selectedObject: string | null = null;

  r: RConfiguration | null = null;
  error = "";
  connected = false;
  consoleInput = "";
  consoleState: ConsoleState | null = null;
  commandHistory: string[] = [];
  consoleViews: Record<
    string,
    {
      input: string;
      hiddenBefore: number;
      scrollTop: number;
      follow: boolean;
      anchor?: number;
      head?: number;
    }
  > = {};
  consoleView(id: string) {
    return (this.consoleViews[id] ??= {
      input: id === "console" ? this.consoleInput : "",
      hiddenBefore: 0,
      scrollTop: 0,
      follow: true,
    });
  }
  newConsole() {
    const id = `console:${crypto.randomUUID()}`;
    this.consoleView(id);
    this.showPanel?.(
      "console",
      id,
      `Console ${Object.keys(this.consoleViews).length}`,
    );
    this.persist();
    this.emit();
  }
  records = new Map<string, OperationRecord>();
  pending: PendingRequest[] = [];
  recent: string[] = [];
  runtime: RuntimeStatus | null = null;
  preferences = { editorFontSize: 14, indentWidth: 4 };
  private preferencesUpdate: Promise<void> = Promise.resolve();
  private preferencesState: ApplicationState = {
    key: "preferences",
    version: null,
    value: null,
  };
  outputEvents = new Map<string, OutputEvent[]>();
  outputNotices = new Map<string, string>();
  outputCursors = new Map<string, number>();
  private outputDone = new Set<string>();
  mediaUrls = new Map<string, string>();
  mediaErrors = new Map<string, string>();
  private mediaLoads = new Map<string, Promise<void>>();
  selectedPlot: string | null = null;
  plotZoom: number | null = null;
  plotViews: Record<string, PlotView> = {};
  plotMedia = new Map<string, MediaReference>();
  plotTimes = new Map<string, number>();
  plotRecords = new Map<string, OperationRecord>();
  private mediaOrder = new Map<string, number>();
  private plotCursor: number | null = null;
  private plotLoading = false;
  private mediaAccess = new Map<string, number>();
  plotView(id: string) {
    return (this.plotViews[id] ??= {
      ...newPlotView(),
      selected: id === "plots" ? this.selectedPlot : null,
      follow: id !== "plots" || !this.selectedPlot,
      transforms:
        id === "plots" && this.selectedPlot && this.plotZoom !== null
          ? { [this.selectedPlot]: { zoom: this.plotZoom, x: 0, y: 0 } }
          : {},
    });
  }
  async loadPlotDetails(reference: MediaReference) {
    if (
      !this.project ||
      this.records.has(reference.operation_id) ||
      this.plotRecords.has(reference.operation_id)
    )
      return;
    const project = this.project,
      record = await this.client.getOperation(project, reference.operation_id);
    if (project === this.project && record) {
      this.plotRecords.set(reference.operation_id, record);
      this.emit("plots");
    }
  }
  newPlotView(reference: MediaReference) {
    const id = `plots:${crypto.randomUUID()}`;
    this.plotViews[id] = {
      ...newPlotView(),
      selected: this.mediaKey(reference),
      follow: false,
      pinned: true,
    };
    this.showPanel?.(
      "plots",
      id,
      `Comparison ${Object.values(this.plotViews).filter((v) => v.pinned).length}`,
    );
    this.persist();
    this.emit();
  }
  async loadEarlierPlots() {
    if (!this.project || this.plotLoading) return;
    const project = this.project;
    this.plotLoading = true;
    try {
      const page = await this.client.query(project, "operation.list_recent", {
        before_cursor: this.plotCursor,
        client_request_id: null,
        limit: 30,
      });
      if (page.status !== "ready") return;
      const data = page.data as RecentOperations;
      this.plotCursor = data.next_cursor;
      for (const op of data.operations) {
        if (!op.capability.id.startsWith("workspace.")) continue;
        this.mediaOrder.set(op.operation_id, op.cursor);
        let after_sequence = 0,
          more = true;
        while (more) {
          const result = await this.client.query(
            project,
            "workspace.list_outputs",
            { operation_id: op.operation_id, after_sequence, limit: 100 },
          );
          if (result.status !== "ready") break;
          const outputs = result.data as MediaPage;
          if (project !== this.project) return;
          for (const item of outputs.media) {
            this.plotMedia.set(this.mediaKey(item.reference), item.reference);
            this.plotTimes.set(
              this.mediaKey(item.reference),
              item.observed_at_ms,
            );
          }
          more = outputs.has_more && outputs.next_sequence > after_sequence;
          after_sequence = outputs.next_sequence;
        }
      }
      this.followPlots();
      this.emit();
    } finally {
      this.plotLoading = false;
    }
  }
  private followPlots() {
    const images = this.media;
    for (const view of Object.values(this.plotViews))
      if (view.follow && !view.pinned) {
        view.selected = images.length ? this.mediaKey(images.at(-1)!) : null;
        view.seen = images.length;
      }
  }

  recentCursor: number | null = null;
  showPanel?: (
    component: string,
    id?: string,
    name?: string,
    config?: unknown,
  ) => void;
  private observedAt = 0;
  layout: unknown = null;
  viewPlacements: Record<string, Placement> = {};
  knownViews: Record<
    string,
    { component: string; name: string; config?: unknown }
  > = {};
  layoutHistory: import("flexlayout-react").IJsonModel[] = [];
  visibleObjects = new Set<string>();
  closedViews = new Set<string>();
  viewCloseVersion = 0;
  openFile?: () => void;
  renameView?: (id: string, name: string) => void;
  openPanels?: () => void;
  state: ApplicationState = { key: "studio", version: null, value: null };
  syncError = "";
  unsynced = false;
  private revision = 0;
  private listeners = new Set<() => void>();
  private channelListeners = new Map<string, Set<() => void>>();
  private channelVersions = new Map<string, number>();
  subscribeChannels(channels: string[], listener: () => void) {
    for (const c of channels) {
      if (!this.channelListeners.has(c))
        this.channelListeners.set(c, new Set());
      this.channelListeners.get(c)!.add(listener);
    }
    return () => {
      for (const c of channels) this.channelListeners.get(c)?.delete(listener);
    };
  }
  channelSnapshot(channels: string[]) {
    return channels.map((c) => this.channelVersions.get(c) ?? 0).join(":");
  }
  private timer?: ReturnType<typeof setTimeout>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saving: Promise<void> | null = null;
  private unconfirmedState: unknown = undefined;
  stateConflict: ApplicationState | null = null;
  private generation = 0;
  private cursor = 0;
  private stopped = false;
  constructor(readonly client: HostClient) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.revision;
  emit(...channels: string[]) {
    const selected = channels.length
      ? channels
      : [...this.channelListeners.keys()];
    const listeners = new Set<() => void>();
    for (const c of selected) {
      this.channelVersions.set(c, (this.channelVersions.get(c) ?? 0) + 1);
      for (const fn of this.channelListeners.get(c) ?? []) listeners.add(fn);
    }
    for (const fn of listeners) fn();
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  get project() {
    return this.info?.project_root ?? null;
  }
  get busy() {
    return (
      this.pending.some((p) => !p.error && !p.ignored) ||
      [...this.records.values()].some((r) => !terminal(r.status))
    );
  }
  get canRun() {
    return (
      !!this.project &&
      this.connected &&
      ["idle", "busy"].includes(this.runtime?.state ?? "") &&
      (this.consoleState?.pending.length ?? 0) < 32 &&
      !!this.info?.capabilities.some(
        (c) => c.capability.id === "workspace.run_r",
      )
    );
  }
  get queueing() {
    return (
      !!this.consoleState?.current ||
      !!this.consoleState?.pause ||
      !!this.consoleState?.pending.length ||
      this.runtime?.state === "busy"
    );
  }
  async refreshConsole() {
    if (
      !this.project ||
      !this.info?.capabilities.some(
        (c) => c.capability.id === "workspace.console_state",
      )
    )
      return;
    const project = this.project,
      result = await this.client.query(project, "workspace.console_state");
    if (
      project === this.project &&
      result.status === "ready" &&
      JSON.stringify(result.data) !== JSON.stringify(this.consoleState)
    ) {
      this.consoleState = result.data as ConsoleState;
      this.emit("console");
    }
  }
  async queueControl(pause: boolean) {
    if (!this.consoleState) return;
    await this.invoke(
      pause ? "workspace.pause_queue" : "workspace.resume_queue",
      {
        session_id: this.consoleState.session_id,
        pause_id: pause ? null : (this.consoleState.pause?.id ?? null),
      },
    );
    await this.refreshConsole();
  }
  async cancelPending(id?: string) {
    if (!this.project) return;
    const errors: string[] = [];
    for (const run of this.consoleState?.pending ?? []) {
      if (!id || id === run.operation_id) {
        try {
          await this.client.cancel(this.project, run.operation_id, true);
        } catch (error) {
          errors.push(message(error));
        }
      }
    }
    await this.refreshConsole();
    if (errors.length)
      throw new Error(
        `Some entries changed state or could not be cancelled: ${errors.join("; ")}`,
      );
  }
  async start() {
    try {
      [this.info, this.r] = await Promise.all([
        this.client.info(),
        this.client.rConfiguration(),
      ]);
      this.preferencesState = await this.client.readState(null, "preferences");
      const preferences = this.preferencesState.value as Partial<
        typeof this.preferences
      > | null;
      this.preferences = {
        editorFontSize: [12, 14, 16, 18].includes(
          preferences?.editorFontSize ?? 0,
        )
          ? preferences!.editorFontSize!
          : 14,
        indentWidth: [2, 4, 8].includes(preferences?.indentWidth ?? 0)
          ? preferences!.indentWidth!
          : 4,
      };
      const recent = await this.client.readState(null, "recent");
      if (Array.isArray(recent.value))
        this.recent = recent.value.filter(
          (v): v is string => typeof v === "string",
        );
      if (this.project && this.recent[0] !== this.project) {
        const items = [
          this.project,
          ...this.recent.filter((p) => p !== this.project),
        ].slice(0, 12);
        try {
          await this.client.writeState(null, { ...recent, value: items });
          this.recent = items;
        } catch (error) {
          this.error = message(error);
        }
      }
      if (this.r?.error) this.error = this.r.error;
      await this.restore();
      await this.observe();
      this.connected = true;
    } catch (error) {
      this.error = message(error);
    }
    this.emit();
    this.schedule();
  }
  setPreferences(patch: Partial<typeof this.preferences>) {
    this.preferencesUpdate = this.preferencesUpdate
      .catch(() => {})
      .then(async () => {
        const preferences = { ...this.preferences, ...patch };
        if (
          ![12, 14, 16, 18].includes(preferences.editorFontSize) ||
          ![2, 4, 8].includes(preferences.indentWidth)
        )
          throw new Error("Invalid editor preferences");
        this.preferencesState = await this.client.writeState(null, {
          ...this.preferencesState,
          value: preferences,
        });
        this.preferences = preferences;
        this.emit();
      });
    return this.preferencesUpdate;
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.saveTimer);
  }
  async selectProject(path: string) {
    await this.flush();
    if (this.unsynced)
      throw new Error(
        this.syncError ||
          "Drafts are not synced. The project was not switched.",
      );
    this.info = await this.client.selectProject(path);
    this.r = await this.client.rConfiguration();
    if (this.r.error) this.error = this.r.error;
    this.generation++;
    this.cursor = 0;
    this.records.clear();
    this.pending = [];
    this.layout = null;
    this.clearOutputs();
    this.observedAt = 0;
    this.directory = null;
    this.directories.clear();
    this.expandedObjects.clear();
    this.consoleState = null;
    this.directoryError = "";
    this.objects = null;
    this.packages.reset();
    this.inspectors.clear();
    await this.restore();
    await this.observe();
    const recent = await this.client.readState(null, "recent");
    this.recent = [
      this.project!,
      ...(Array.isArray(recent.value)
        ? recent.value.filter(
            (v): v is string => typeof v === "string" && v !== this.project,
          )
        : []),
    ].slice(0, 12);
    await this.client.writeState(null, { ...recent, value: this.recent });
    this.emit();
  }
  async refreshInfo() {
    [this.info, this.r] = await Promise.all([
      this.client.info(),
      this.client.rConfiguration(),
    ]);
    this.runtime = null;
    this.objects = null;
    this.packages.reset();
    this.inspectors.clear();
    if (this.r.error) this.error = this.r.error;
    await this.observe();
    this.emit();
  }
  async restore() {
    if (!this.project) return;
    this.state = await this.client.readState(this.project, "studio");
    const data = this.state.value as {
      layout?: unknown;
      pending?: PendingRequest[];
      consoleInput?: string;
      documents?: unknown;
      selectedPlot?: string;
      plotZoom?: number | null;
      cursor?: number;
      viewPlacements?: Record<string, Placement>;
      knownViews?: Studio["knownViews"];
      layoutHistory?: import("flexlayout-react").IJsonModel[];
      consoleViews?: Studio["consoleViews"];
      expandedDirectories?: string[];
      filesScrollTop?: number;
      showHiddenFiles?: boolean;
      commandHistory?: string[];
      plotViews?: Record<string, PlotView>;
    } | null;
    this.layout = data?.layout ?? null;
    this.viewPlacements = {};
    for (const [id, p] of Object.entries(data?.viewPlacements ?? {}))
      if (p && Array.isArray(p.neighbors))
        this.viewPlacements[id] = {
          group: typeof p.group === "string" ? p.group : undefined,
          neighbors: p.neighbors.filter((v) => typeof v === "string"),
        };
    this.knownViews = {};
    for (const [id, v] of Object.entries(data?.knownViews ?? {}))
      if (
        v &&
        typeof v.name === "string" &&
        [
          "console",
          "plots",
          "document",
          "viewer",
          "files",
          "objects",
          "editor",
        ].includes(v.component)
      )
        this.knownViews[id] = v;
    this.layoutHistory = (data?.layoutHistory ?? [])
      .filter((v) => v && typeof v === "object" && v.layout)
      .slice(-20);
    this.closedViews.clear();
    this.plotViews = {};
    for (const [id, value] of Object.entries(data?.plotViews ?? {})) {
      if (!value || typeof value !== "object") continue;
      const view = newPlotView();
      view.selected =
        typeof value.selected === "string" ? value.selected : null;
      view.follow = value.follow !== false;
      view.pinned = value.pinned === true;
      view.history = value.history !== false;
      view.seen = Number(value.seen) || 0;
      for (const [key, p] of Object.entries(value.transforms ?? {}))
        if (
          p &&
          (p.zoom === null || Number.isFinite(p.zoom)) &&
          Number.isFinite(p.x) &&
          Number.isFinite(p.y)
        )
          view.transforms[key] = {
            zoom: p.zoom === null ? null : Math.max(0.01, Math.min(8, p.zoom)),
            x: p.x,
            y: p.y,
          };
      this.plotViews[id] = view;
    }
    this.consoleViews = {};
    for (const [id, view] of Object.entries(data?.consoleViews ?? {})) {
      if (view && typeof view.input === "string")
        this.consoleViews[id] = {
          input: view.input,
          hiddenBefore: Number(view.hiddenBefore) || 0,
          scrollTop: Number(view.scrollTop) || 0,
          follow: view.follow !== false,
          anchor: Math.max(
            0,
            Math.min(view.input.length, Number(view.anchor) || 0),
          ),
          head: Math.max(
            0,
            Math.min(view.input.length, Number(view.head) || 0),
          ),
        };
    }
    this.expandedDirectories = new Set(
      (data?.expandedDirectories ?? [""]).filter((p) => typeof p === "string"),
    );
    this.filesScrollTop = Number(data?.filesScrollTop) || 0;
    this.showHiddenFiles = data?.showHiddenFiles === true;
    this.commandHistory = (data?.commandHistory ?? [])
      .filter((v) => typeof v === "string")
      .slice(-500);
    this.documents.restore(data?.documents);
    this.pending = Array.isArray(data?.pending) ? data.pending : [];
    this.consoleInput =
      typeof data?.consoleInput === "string" ? data.consoleInput : "";
    this.selectedPlot =
      typeof data?.selectedPlot === "string" ? data.selectedPlot : null;
    this.plotZoom = [0.5, 1, 2].includes(data?.plotZoom ?? 0)
      ? data!.plotZoom!
      : null;
    this.cursor = Number.isSafeInteger(data?.cursor) ? data!.cursor! : 0;
    for (const pending of this.pending)
      pending.error = "The request is unconfirmed. Refresh does not replay it.";
    this.unsynced = false;
    this.syncError = "";
    this.stateConflict = null;
    this.unconfirmedState = undefined;
  }
  persist() {
    const changed = !this.unsynced;
    this.unsynced = true;
    if (changed) this.emit("shell");
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.flush();
    }, 400);
  }
  serialize(): unknown {
    return {
      version: 2,
      viewPlacements: this.viewPlacements,
      knownViews: this.knownViews,
      layoutHistory: this.layoutHistory,
      consoleViews: this.consoleViews,
      commandHistory: this.commandHistory,
      plotViews: this.plotViews,
      expandedDirectories: [...this.expandedDirectories],
      filesScrollTop: this.filesScrollTop,
      showHiddenFiles: this.showHiddenFiles,
      documents: this.documents.serialize(),
      layout: this.layout,
      pending: this.pending,
      consoleInput: this.consoleInput,
      selectedPlot: this.selectedPlot,
      plotZoom: this.plotZoom,
      cursor: this.cursor,
    };
  }
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (this.saving) {
      await this.saving;
      if (this.unsynced && !this.syncError) await this.flush();
      return;
    }
    if (!this.project || !this.unsynced) return;
    const project = this.project;
    const value = json(this.serialize());
    this.saving = (async () => {
      try {
        if (this.syncError) {
          const remote = await this.client.readState(project, this.state.key);
          if (remote.version !== this.state.version) {
            if (
              this.unconfirmedState !== undefined &&
              JSON.stringify(remote.value) ===
                JSON.stringify(this.unconfirmedState)
            )
              this.state = remote;
            else {
              this.stateConflict = remote;
              throw new Error(
                "Another window updated shared drafts. Your edits are retained. Resolve the window conflict.",
              );
            }
          }
        }
        this.unconfirmedState = value;
        const saved = await this.client.writeState(project, {
          ...this.state,
          value,
        });
        if (project !== this.project) return;
        this.state = saved;
        this.syncError = "";
        this.unconfirmedState = undefined;
        this.stateConflict = null;
        this.unsynced =
          JSON.stringify(value) !== JSON.stringify(this.serialize());
      } catch (error) {
        this.syncError = message(error);
        this.unsynced = true;
      } finally {
        this.saving = null;
        this.emit("shell");
      }
    })();
    await this.saving;
    if (this.unsynced && !this.syncError) await this.flush();
  }
  async replaceSharedDrafts(remote: ApplicationState) {
    this.state = { ...this.state, version: remote.version };
    this.syncError = "";
    this.stateConflict = null;
    this.unconfirmedState = undefined;
    await this.flush();
  }
  async invoke(
    id: string,
    args: unknown,
    preconditions: Precondition[] = [],
  ): Promise<OperationRecord> {
    if (!this.project) throw new Error("Open a project first");
    const project = this.project;
    if (new TextEncoder().encode(JSON.stringify(args)).length > 256 * 1024)
      throw new Error(
        "Arguments exceed 256 KiB. Nothing was submitted; your draft is retained.",
      );
    const request: PendingRequest = {
      invocation: {
        client_request_id: crypto.randomUUID(),
        capability: { id, version: 1 },
        arguments: json(args),
        preconditions,
      },
    };
    if (
      new TextEncoder().encode(
        JSON.stringify({
          project_root: project,
          frame: {
            id: crypto.randomUUID(),
            request: { method: "invoke", params: request.invocation },
          },
        }),
      ).length >
      272 * 1024
    )
      throw new Error(
        "The request exceeds 272 KiB. Nothing was submitted; your draft is retained.",
      );
    this.pending.push(request);
    this.persist();
    this.emit();
    await this.flush();
    if (this.unsynced) {
      this.pending = this.pending.filter((p) => p !== request);
      this.persist();
      throw new Error(`Request was not submitted: ${this.syncError}`);
    }
    try {
      const record = await this.client.invoke(
        project,
        request.invocation,
        id === "workspace.run_r",
      );
      this.records.set(record.operation.operation_id, record);
      if (id.startsWith("workspace.")) {
        this.observedAt = 0;
        this.packages.invalidate();
      }
      this.pending = this.pending.filter((p) => p !== request);
      this.persist();
      this.emit();
      return record;
    } catch (error) {
      request.error = message(error);
      this.persist();
      this.emit();
      throw error;
    }
  }
  async reviewOperation(id: string) {
    const project = this.project;
    if (!project || this.records.has(id)) return;
    const record = await this.client.getOperation(project, id);
    if (!record || project !== this.project) return;
    const summary = await this.client.query(project, "operation.list_recent", {
      client_request_id: record.operation.client_request_id,
      limit: 1,
    });
    const entry = (summary.data as RecentOperations | null)?.operations[0];
    if (entry) this.mediaOrder.set(id, entry.cursor);
    if (project === this.project) {
      this.records.set(id, record);
      this.emit("outputs");
    }
  }
  async retryPending(request: PendingRequest) {
    if (!this.project || !this.connected) throw new Error("Host Unavailable");
    try {
      request.error = undefined;
      request.ignored = false;
      this.persist();
      this.emit();
      await this.flush();
      if (this.unsynced) throw new Error(this.syncError);
      const record = await this.client.invoke(this.project, request.invocation);
      this.records.set(record.operation.operation_id, record);
      this.pending = this.pending.filter((p) => p !== request);
      this.persist();
      this.emit();
    } catch (error) {
      request.error = message(error);
      this.persist();
      this.emit();
    }
  }
  async run(
    code: string,
    source: RunSource = {
      view_id: "console",
      label: "Console",
      kind: "console",
    },
  ) {
    if (!this.canRun || !code.trim())
      throw new Error(
        (this.consoleState?.pending.length ?? 0) >= 32
          ? "Queue full (32 pending runs). Your input is retained."
          : "R is unavailable. Your input is retained.",
      );
    if (code.includes("\0")) throw new Error("R code cannot contain NUL.");
    const session = this.consoleState?.session_id ?? this.runtime?.session_id;
    const args: RunRArguments = { code, output_mode: "console", source };
    const record = await this.invoke(
      "workspace.run_r",
      args,
      session
        ? [{ kind: "workspace.session", subject: "active", expected: session }]
        : [],
    );
    if (record.status === "failed" && record.output === null)
      throw new Error(record.error ?? "Run was rejected");
    await this.refreshConsole();
    return record;
  }
  async cancel() {
    const id =
      this.consoleState?.current?.operation_id ??
      [...this.records.values()].find((r) => r.status === "running")?.operation
        .operation_id;
    if (this.project && id) await this.client.cancel(this.project, id);
  }
  async listDirectory(path = "", append = false) {
    const project = this.project;
    if (!project) return;
    this.directoryLoading = true;
    this.directoryError = "";
    this.emit("files");
    try {
      const result = await this.client.query(
        project,
        "project.list_directory",
        {
          path,
          after_name: append ? this.directories.get(path)?.next_name : null,
          limit: 200,
        },
      );
      if (result.status !== "ready") throw new Error(result.notices.join("\n"));
      const page = result.data as DirectoryPage;
      if (this.project === project) {
        this.directory = {
          ...page,
          entries:
            append && this.directories.has(path)
              ? [...this.directories.get(path)!.entries, ...page.entries]
              : page.entries,
        };
        this.directories.set(path, this.directory);
      }
    } catch (error) {
      this.directoryError = message(error);
    } finally {
      this.directoryLoading = false;
      this.emit("files");
    }
  }
  async inspectObject(name: string) {
    const project = this.project,
      session = this.runtime?.session_id;
    if (!project) return;
    const snapshot = await this.client.query(
      project,
      "workspace.inspect_object",
      { name, max_items: 20 },
    );
    if (
      project !== this.project ||
      this.runtime?.session_id !== session ||
      (session && snapshot.target.identity !== session)
    )
      return;
    if (snapshot.status !== "ready") {
      this.objectsNotice = snapshot.notices.join("\n");
      this.emit("objects");
      return;
    }
    this.inspectors.set(name, {
      binding: snapshot.data as BindingSummary,
      observedAt: snapshot.observed_at_ms,
      notice: snapshot.notices.join("\n"),
    });
    this.selectedObject = name;
    this.emit("objects");
  }
  clearOutputs() {
    for (const url of this.mediaUrls.values()) URL.revokeObjectURL(url);
    this.outputEvents.clear();
    this.outputNotices.clear();
    this.outputCursors.clear();
    this.outputDone.clear();
    this.mediaUrls.clear();
    this.mediaErrors.clear();
    this.mediaLoads.clear();
    this.plotMedia.clear();
    this.plotTimes.clear();
    this.plotRecords.clear();
    this.mediaOrder.clear();
    this.plotCursor = null;
    this.plotViews = {};
    this.runtime = null;
  }
  mediaKey(reference: MediaReference) {
    return `${reference.operation_id}:${reference.sequence}:${reference.sha256}`;
  }
  get media(): MediaReference[] {
    const all = new Map(this.plotMedia);
    for (const events of this.outputEvents.values())
      for (const e of events)
        if (e.media) all.set(this.mediaKey(e.media), e.media);
    return [...all.values()].sort(
      (a, b) =>
        (this.mediaOrder.get(a.operation_id) ?? Number.MAX_SAFE_INTEGER) -
          (this.mediaOrder.get(b.operation_id) ?? Number.MAX_SAFE_INTEGER) ||
        a.operation_id.localeCompare(b.operation_id) ||
        a.sequence - b.sequence,
    );
  }
  selectPlot(reference: MediaReference) {
    this.selectedPlot = this.mediaKey(reference);
    const view = this.plotView("plots");
    view.selected = this.selectedPlot;
    view.follow = false;
    view.seen = this.media.length;
    this.persist();
    this.emit();
  }
  locatePlot(reference: MediaReference) {
    this.selectPlot(reference);
    this.showPanel?.("plots");
  }
  async loadMedia(reference: MediaReference): Promise<void> {
    const key = this.mediaKey(reference),
      project = this.project;
    if (!project || this.mediaUrls.has(key) || this.mediaErrors.has(key))
      return;
    if (this.mediaLoads.has(key)) return this.mediaLoads.get(key)!;
    const promise = (async () => {
      try {
        if (
          !["image/png", "image/jpeg", "image/svg+xml"].includes(
            reference.mime_type,
          ) ||
          reference.byte_size > 16 * 1024 * 1024
        )
          throw new Error("Unsupported or oversized media output");
        const bytes = new Uint8Array(reference.byte_size);
        let offset = 0;
        do {
          const snapshot = await this.client.query(
            project,
            "workspace.read_output",
            { reference, offset, limit_bytes: 65536 },
          );
          if (snapshot.status !== "ready")
            throw new Error(snapshot.notices.join("\n"));
          const page = snapshot.data as OutputPage;
          if (
            page.offset !== offset ||
            JSON.stringify(page.reference) !== JSON.stringify(reference) ||
            page.bytes.length > 65536 ||
            offset + page.bytes.length > bytes.length ||
            (!page.bytes.length && page.has_more)
          )
            throw new Error("Media chunk identity does not match");
          bytes.set(page.bytes, offset);
          offset += page.bytes.length;
          if (!page.has_more) break;
        } while (offset < bytes.length);
        const digest =
          "sha256:" +
          Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          )
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
        if (offset !== bytes.length || digest !== reference.sha256)
          throw new Error("Original output failed its checksum");
        if (this.project === project) {
          this.mediaUrls.set(
            key,
            URL.createObjectURL(
              new Blob([bytes], { type: reference.mime_type }),
            ),
          );
          let total = this.media
            .filter((r) => this.mediaUrls.has(this.mediaKey(r)))
            .reduce((sum, r) => sum + r.byte_size, 0);
          const activeViews = new Set<string>();
          const visit = (node: unknown) => {
            if (!node || typeof node !== "object") return;
            const n = node as {
              type?: string;
              selected?: number;
              id?: string;
              component?: string;
              children?: unknown[];
            };
            if (n.type === "tabset") {
              const tab = n.children?.[n.selected ?? 0] as
                | { id?: string; component?: string }
                | undefined;
              if (tab?.component === "plots" && tab.id) activeViews.add(tab.id);
            } else for (const child of n.children ?? []) visit(child);
          };
          visit((this.layout as { layout?: unknown } | null)?.layout);
          // Keep visible originals; closed comparison views do not pin the cache.
          const protectedKeys = new Set(
            [...activeViews].map((id) => this.plotViews[id]?.selected),
          );
          protectedKeys.add(key);
          for (const r of this.media.sort(
            (a, b) =>
              (this.mediaAccess.get(this.mediaKey(a)) ?? 0) -
              (this.mediaAccess.get(this.mediaKey(b)) ?? 0),
          )) {
            const k = this.mediaKey(r);
            if (total <= 64 * 1024 * 1024) break;
            if (protectedKeys.has(k) || !this.mediaUrls.has(k)) continue;
            URL.revokeObjectURL(this.mediaUrls.get(k)!);
            this.mediaUrls.delete(k);
            total -= r.byte_size;
          }
        }
      } catch (error) {
        if (this.project === project) this.mediaErrors.set(key, message(error));
      } finally {
        this.mediaLoads.delete(key);
        this.emit("media");
      }
    })();
    this.mediaLoads.set(key, promise);
    return promise;
  }
  async loadRecent(older = false) {
    const project = this.project;
    if (!project) return;
    const page = await this.client.query(project, "operation.list_recent", {
      before_cursor: older ? this.recentCursor : null,
      client_request_id: null,
      limit: 30,
    });
    if (page.status !== "ready") return;
    const data = page.data as RecentOperations;
    if (older || this.recentCursor === null)
      this.recentCursor = data.next_cursor;
    for (const summary of [...data.operations].reverse()) {
      if (!summary.capability.id.startsWith("workspace.")) continue;
      this.mediaOrder.set(summary.operation_id, summary.cursor);
      const existing = this.records.get(summary.operation_id);
      if (
        existing &&
        existing.updated_at_ms === summary.updated_at_ms &&
        existing.status === summary.status
      )
        continue;
      await this.acceptRecord(project, summary.operation_id);
    }
  }
  private async acceptRecord(project: string, id: string) {
    const record = await this.client.getOperation(project, id);
    if (
      project !== this.project ||
      !record ||
      record.operation.idempotency_scope !== project
    )
      return;
    if (
      terminal(record.status) &&
      this.records.get(id)?.status !== record.status
    ) {
      this.observedAt = 0;
      this.packages.invalidate();
    }
    this.records.set(id, record);
    const pending = this.pending.find(
      (p) =>
        p.invocation.client_request_id === record.operation.client_request_id,
    );
    if (pending) {
      pending.operationId = id;
      pending.error = undefined;
      if (terminal(record.status)) {
        this.pending = this.pending.filter((p) => p !== pending);
        this.persist();
      }
    }
    this.emit("outputs", "console", "runtime");
  }
  async observe() {
    const project = this.project;
    if (!project) return;
    await this.loadRecent();
    const refreshObjects = this.observedAt === 0 || !this.objects;
    if (
      this.info?.capabilities.some(
        (c) => c.capability.id === "workspace.runtime_status",
      )
    ) {
      const status = await this.client.query(
        project,
        "workspace.runtime_status",
      );
      if (project === this.project && status.status === "ready") {
        const next = status.data as RuntimeStatus;
        if (this.runtime && this.runtime.session_id !== next.session_id) {
          this.inspectors.clear();
          this.objects = null;
          this.packages.reset();
        }
        this.runtime = next;
      }
    }
    if (
      this.info?.capabilities.some(
        (c) =>
          (refreshObjects || !this.objects) &&
          c.capability.id === "workspace.snapshot",
      )
    ) {
      const objects = await this.client.query(project, "workspace.snapshot", {
        limit: 200,
      });
      if (project === this.project) {
        if (objects.status === "ready") {
          this.objects = objects.data as WorkspaceSnapshotData;
          this.objectsObservedAt = objects.observed_at_ms;
          this.objectsNotice = "";
          for (const name of this.visibleObjects)
            await this.inspectObject(name);
        } else this.objectsNotice = objects.notices.join("\n");
      }
    }
    if (this.packages.visible && this.packages.dirty)
      await this.packages.refresh();
    for (const pending of [...this.pending]) {
      if (pending.operationId) {
        await this.acceptRecord(project, pending.operationId);
        continue;
      }
      const page = await this.client.query(project, "operation.list_recent", {
        client_request_id: pending.invocation.client_request_id,
        limit: 1,
      });
      const summary = (page.data as RecentOperations | null)?.operations[0];
      if (summary) await this.acceptRecord(project, summary.operation_id);
    }
    this.observedAt = Date.now();
    this.emit();
  }
  private schedule() {
    if (!this.stopped)
      this.timer = setTimeout(() => {
        void this.poll();
      }, 250);
  }
  private async poll() {
    const project = this.project,
      generation = this.generation;
    try {
      if (project) {
        if (
          Date.now() - this.observedAt > 2000 ||
          this.pending.some((p) => !p.operationId && !p.error)
        )
          await this.observe();
        await this.refreshConsole();
        const events = await this.client.subscribe(project, this.cursor);
        if (generation !== this.generation) return;
        for (const id of new Set(events.map((e) => e.operation_id)))
          if (this.records.has(id)) await this.acceptRecord(project, id);
        if (events.length) this.cursor = events.at(-1)!.sequence;
        for (const [id, record] of this.records) {
          if (
            this.outputDone.has(id) ||
            !record.operation.capability.id.startsWith("workspace.")
          )
            continue;
          const snapshot = await this.client.query(
            project,
            "workspace.output_events",
            {
              operation_id: id,
              after_sequence: this.outputCursors.get(id) ?? 0,
              limit: 100,
            },
          );
          if (project !== this.project) return;
          if (snapshot.status !== "ready") {
            if (terminal(record.status)) {
              this.outputNotices.set(id, snapshot.notices.join("\n"));
              this.outputDone.add(id);
              this.emit("outputs", "plots");
            }
            continue;
          }
          const page = snapshot.data as OutputEvents;
          if (
            page.operation_id !== id ||
            !Number.isSafeInteger(page.next_sequence)
          )
            throw new Error("Output identity does not match");
          this.outputCursors.set(id, page.next_sequence);
          if (page.events.length) {
            for (const event of page.events)
              if (event.media)
                this.plotTimes.set(
                  this.mediaKey(event.media),
                  event.observed_at_ms,
                );
            this.outputEvents.set(id, [
              ...(this.outputEvents.get(id) ?? []),
              ...page.events,
            ]);
            if (!this.selectedPlot) {
              const media = page.events.find((e) => e.media)?.media;
              if (media) this.selectedPlot = this.mediaKey(media);
            }
            this.followPlots();
            this.emit("outputs", "plots");
          }
          if (page.truncated || page.gap)
            this.outputNotices.set(
              id,
              [
                ...page.notices,
                page.truncated
                  ? "Output reached the observation limit. Later content is omitted."
                  : "",
              ]
                .filter(Boolean)
                .join("\n"),
            );
          if (terminal(record.status) && !page.has_more)
            this.outputDone.add(id);
        }
      }
      if (!project) await this.client.info();
      if (!this.connected) {
        this.connected = true;
        if (this.unsynced) void this.flush();
        this.emit("shell", "runtime", "console");
      }
    } catch (error) {
      if (this.connected) {
        this.connected = false;
        this.error = message(error);
        this.emit("shell", "runtime", "console");
      }
    } finally {
      this.schedule();
    }
  }
}
