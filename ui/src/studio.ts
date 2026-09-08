import { HostClient } from "./host-client";
import { Notifications } from "./shared/events";
import { RuntimeCoordinator } from "./runtime-coordinator";
import { ApplicationPersistence, Preferences } from "./application-state";
import { Session } from "./session";
import { Operations } from "./operations";
import { Console } from "./console";
import { Documents } from "./documents";
import { Objects } from "./objects";
import { Packages } from "./packages";
import { Files } from "./files";
import { Outputs } from "./outputs";
import { MediaCache } from "./media-cache";
import { Plots } from "./plots";
import { PanelLayout } from "./layout-model";
import { Navigation } from "./navigation";
import { browserMedia } from "./media-adapter";

/** Composition and client lifecycle only. Scientific state lives in its module. */
export class Studio {
  readonly notifications = new Notifications();
  readonly coordinator = new RuntimeCoordinator();
  readonly session: Session;
  readonly operations: Operations;
  readonly console: Console;
  readonly documents: Documents;
  readonly objects: Objects;
  readonly packages: Packages;
  readonly files: Files;
  readonly outputs: Outputs;
  readonly mediaCache: MediaCache;
  readonly plots: Plots;
  readonly layout: PanelLayout;
  readonly navigation: Navigation;
  readonly persistence: ApplicationPersistence;
  readonly preferences: Preferences;
  private readonly subscriptions: (() => void)[] = [];
  private stopped = false;
  private lifecycle = 0;
  private phase: "session" | "preferences" | "checkpoint" | "restore" | "native" | "operations" | "ready" = "session";
  private booting: Promise<void> | null = null;

  constructor(private readonly client: HostClient, options: { width?: number } = {}) {
    const query = this.coordinator.query(client.query.bind(client));
    const state = { readState: client.readState.bind(client), writeState: client.writeState.bind(client) };
    this.session = new Session({
      ...state, query, notifications: this.notifications,
      info: client.info.bind(client), rConfiguration: client.rConfiguration.bind(client),
      selectProject: client.selectProject.bind(client), probeR: client.probeR.bind(client), applyR: client.applyR.bind(client),
      transition: { before: () => this.suspend(), after: (changed) => this.initialize(changed), failed: () => this.resumeAfterFailure() },
    });
    this.persistence = new ApplicationPersistence(state, this.session.context);
    this.preferences = new Preferences(state);
    this.layout = new PanelLayout({ changed: this.persistence.changed, width: options.width });
    this.operations = new Operations({
      context: this.session.context, query, notifications: this.notifications,
      subscribe: client.subscribe.bind(client), getOperation: client.getOperation.bind(client),
      invoke: client.invoke.bind(client), cancel: client.cancel.bind(client),
      execution: () => this.console.consoleState, changed: this.persistence.changed,
      flush: () => this.persistence.flush(), unsynced: () => this.persistence.unsynced, syncError: () => this.persistence.syncError,
    });
    this.console = new Console({
      context: this.session.context, query,
      run: this.operations.run.bind(this.operations), invoke: this.operations.invoke.bind(this.operations), cancel: this.operations.cancel.bind(this.operations),
      respondInput: client.respondInput.bind(client), changed: this.persistence.changed,
      schedule: () => this.coordinator.wake("control"), controlChanged: () => this.operations.refreshAdmission(),
      showConsole: (id, name) => this.layout.show("console", id, name),
    });
    const resource = (id: string) => ({ context: this.session.context, query,
      changed: this.persistence.changed, schedule: () => this.coordinator.wake(id) });
    this.files = new Files(resource("files"));
    this.objects = new Objects(resource("objects"));
    this.packages = new Packages(resource("packages"));
    this.documents = new Documents({ ...resource("files"),
      canRun: () => this.operations.canRun, queueing: () => this.operations.queueing,
      invoke: this.operations.invoke.bind(this.operations), run: this.operations.run.bind(this.operations),
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
    this.navigation = new Navigation({ context: this.session.context, show: this.layout.show.bind(this.layout),
      openDocument: this.documents.open.bind(this.documents), createDocument: this.documents.create.bind(this.documents),
      locatePlot: this.plots.locate.bind(this.plots), reportError: this.session.reportError.bind(this.session) });

    for (const fragment of [this.operations, this.console, this.files, this.objects, this.packages, this.plots, this.layout])
      this.persistence.register(fragment);
    this.persistence.register({ serialize: () => ({ documents: this.documents.serialize() }),
      restore: (value) => this.documents.restore((value as { documents?: unknown } | null)?.documents) });

    this.subscriptions.push(
      this.notifications.on("projectChanged", () => {
        if (this.phase === "ready") this.phase = "checkpoint";
        this.session.setReady(false);
        this.operations.reset(); this.console.reset(); this.files.reset(); this.objects.reset(); this.packages.reset();
        this.documents.reset(); this.outputs.reset(); this.mediaCache.reset(); this.plots.reset(); this.layout.resetState(); this.navigation.reset();
      }),
      this.notifications.on("sessionChanged", () => {
        this.operations.sessionChanged(); this.console.resetSession(); this.documents.sessionChanged();
        this.objects.sessionChanged(); this.packages.sessionChanged(); this.outputs.sessionChanged(); this.mediaCache.sessionChanged();
      }),
      this.notifications.on("operationChanged", (event) => this.objects.operationChanged(event)),
      this.notifications.on("operationChanged", (event) => this.packages.operationChanged(event)),
      this.notifications.on("operationChanged", (event) => this.files.operationChanged(event)),
      this.notifications.on("operationChanged", (event) => this.outputs.operationChanged(event)),
      this.notifications.on("fileSaved", (event) => this.files.fileSaved(event)),
      this.layout.subscribe(() => this.notifications.send("viewsChanged", { activeViewIds: this.layout.getSnapshot().activeViewIds })),
      this.notifications.on("viewsChanged", ({ activeViewIds }) => this.mediaCache.protect(this.plots.protectedMedia(activeViewIds))),
      this.notifications.on("viewsChanged", (event) => this.objects.viewsChanged(event)),
      this.notifications.on("viewsChanged", (event) => this.packages.viewsChanged(event)),
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
    this.coordinator.register("control", 250, ready(() => this.console.refresh()));
    this.coordinator.register("events", 250, ready(async () => {
      await this.operations.initialize(this.console.operationIds());
      return this.operations.consumeEvents();
    }));
    this.coordinator.register("runtime", 2000, ready(() => this.session.refreshRuntime()));
    this.coordinator.register("pending", 2000, ready(async () => {
      await this.operations.reconcilePending(); await this.operations.ensureReferences(this.console.operationIds());
    }));
    this.coordinator.register("objects", 2000, ready(async () => { await this.objects.observe(); return this.objects.needsObservation; }));
    this.coordinator.register("packages", 2000, ready(async () => { await this.packages.observe(); return this.packages.needsObservation; }));
    this.coordinator.register("files", 2000, ready(async () => { await this.files.observe(); return this.files.needsObservation; }));
    this.coordinator.register("outputs", 250, ready(() => this.outputs.step()));
    this.coordinator.register("media", 250, ready(() => this.mediaCache.step()));
  }
  async start() {
    this.stopped = false;
    this.coordinator.startReads();
    await this.advanceStartup().catch(() => {});
    if (!this.stopped) this.coordinator.start();
  }
  private async suspend() {
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
          await this.persistence.restore();
          if (!current()) return;
          this.phase = "native";
        }
        if (this.phase === "native") {
          await this.session.refreshRuntime().catch(() => {});
          if (!current()) return;
          await this.console.refresh().catch(() => {});
          if (!current()) return;
          this.phase = "operations";
        }
        if (this.phase === "operations") {
          await this.operations.initialize(this.console.operationIds());
          if (!current()) return;
          if (this.session.project && !this.operations.initialized) return;
          this.outputs.restoreReferences(this.plots.retainedReferences());
          this.files.listDirectory();
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
    this.stopped = true; this.lifecycle++; this.session.stop(); this.coordinator.stop(); this.client.stopReads(); this.persistence.stop(); this.preferences.stop();
    this.operations.stop(); this.console.stop(); this.documents.stop(); this.files.stop(); this.objects.stop(); this.packages.stop();
    this.outputs.stop(); this.mediaCache.stop(); this.plots.stop(); this.navigation.stop(); this.layout.stop();
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.notifications.dispose();
  }
}
