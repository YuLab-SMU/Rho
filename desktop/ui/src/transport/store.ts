import type {
  CommandPlacementTag,
  OpenSurfaceRequest,
  ProjectUiProfileSnapshot,
  ProfileTransport,
  ResourceDeleteRequest,
  ResourceDraftRequest,
  ResourceReadRequest,
  ResourceRegistrySnapshot,
  ResourceReloadRequest,
  ResourceRenameRequest,
  ResourceResolveRequest,
  ResourceSaveRequest,
  ResourceTransport,
  RuntimeAttachmentRequest,
  RuntimeCreateRequest,
  RuntimeDetachRequest,
  RuntimeExecuteRequest,
  RuntimeInstanceRequest,
  RuntimeRegistrySnapshot,
  SceneEditRequest,
  StudioRevisionRequest,
  StudioRuntimeSnapshot,
  SurfaceInstanceRequest,
  SurfaceRuntimeSnapshot,
  UiKernelSnapshot,
  UiKernelTransport,
  Unsubscribe,
  UpdateSurfaceRequest,
  UiProfileSceneLabelRequest,
  UiProfileSceneTargetRequest,
  UiProfileSelectPageRequest,
  UiProfileSelectSceneRequest,
  UiProfileSetModeRequest,
  VibePageExportRequest,
  VibePageMutationRequest,
} from "./types";

export type UiStoreSnapshot =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly source: UiKernelTransport["source"];
      readonly snapshot: UiKernelSnapshot;
    };

export type SurfaceStoreSnapshot =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly source: UiKernelTransport["source"];
      readonly snapshot: SurfaceRuntimeSnapshot;
    };

export type StudioStoreSnapshot =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly source: UiKernelTransport["source"];
      readonly snapshot: StudioRuntimeSnapshot;
    };

export type RuntimeStoreSnapshot =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly source: UiKernelTransport["source"];
      readonly snapshot: RuntimeRegistrySnapshot;
    };

export type ResourceStoreSnapshot =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly source: UiKernelTransport["source"];
      readonly snapshot: ResourceRegistrySnapshot;
    };

export type UiProfileStoreSnapshot =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly source: UiKernelTransport["source"];
      readonly snapshot: ProjectUiProfileSnapshot;
    };

const LOADING: UiStoreSnapshot = Object.freeze({ status: "loading" });
const SURFACE_LOADING: SurfaceStoreSnapshot = Object.freeze({ status: "loading" });
const STUDIO_LOADING: StudioStoreSnapshot = Object.freeze({ status: "loading" });
const RUNTIME_LOADING: RuntimeStoreSnapshot = Object.freeze({ status: "loading" });
const RESOURCE_LOADING: ResourceStoreSnapshot = Object.freeze({ status: "loading" });
const UI_PROFILE_LOADING: UiProfileStoreSnapshot = Object.freeze({ status: "loading" });

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, 512);
  return "Rho could not load the UI Kernel snapshot.";
}

function deepFreeze<T>(value: T): T {
  if (value != null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function sameSnapshot(left: UiKernelSnapshot, right: UiKernelSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class UiExternalStore {
  readonly #transport: UiKernelTransport;
  readonly #listeners = new Set<() => void>();
  #state: UiStoreSnapshot = LOADING;
  #stopTransport: Unsubscribe | undefined;
  #refreshing: Promise<void> | undefined;
  #refreshQueued = false;

  constructor(transport: UiKernelTransport) {
    this.#transport = transport;
  }

  readonly getSnapshot = (): UiStoreSnapshot => this.#state;

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#stopTransport = this.#transport.subscribeInvalidated(() => {
        void this.refresh();
      });
      void this.refresh();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#stopTransport?.();
        this.#stopTransport = undefined;
      }
    };
  };

  #publish(state: UiStoreSnapshot): void {
    if (state === this.#state) return;
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  #install(snapshot: UiKernelSnapshot): void {
    const current = this.#state;
    if (
      current.status === "ready" &&
      snapshot.project.project_id === current.snapshot.project.project_id
    ) {
      const currentRevision = current.snapshot.snapshot_revision;
      if (snapshot.snapshot_revision < currentRevision) return;
      if (snapshot.snapshot_revision === currentRevision) {
        if (sameSnapshot(snapshot, current.snapshot)) return;
        this.#publish({
          status: "failed",
          message: "UI Kernel returned different data for one snapshot revision.",
        });
        return;
      }
    }
    this.#publish(
      deepFreeze({ status: "ready", source: this.#transport.source, snapshot } as const),
    );
  }

  async #runRefreshLoop(): Promise<void> {
    do {
      this.#refreshQueued = false;
      try {
        this.#install(await this.#transport.loadSnapshot());
      } catch (error: unknown) {
        if (this.#state.status !== "ready") {
          this.#publish({ status: "failed", message: errorMessage(error) });
        }
      }
    } while (this.#refreshQueued);
  }

  refresh(): Promise<void> {
    if (this.#refreshing != null) {
      this.#refreshQueued = true;
      return this.#refreshing;
    }
    this.#refreshing = this.#runRefreshLoop().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }
}

export class SurfaceExternalStore {
  readonly #transport: UiKernelTransport;
  readonly #listeners = new Set<() => void>();
  #state: SurfaceStoreSnapshot = SURFACE_LOADING;
  #stopTransport: Unsubscribe | undefined;
  #refreshing: Promise<void> | undefined;
  #refreshQueued = false;

  constructor(transport: UiKernelTransport) {
    this.#transport = transport;
  }

  readonly getSnapshot = (): SurfaceStoreSnapshot => this.#state;

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#stopTransport = this.#transport.subscribeSurfacesInvalidated(() => {
        void this.refresh();
      });
      void this.refresh();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#stopTransport?.();
        this.#stopTransport = undefined;
      }
    };
  };

  #publish(state: SurfaceStoreSnapshot): void {
    if (state === this.#state) return;
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  #install(snapshot: SurfaceRuntimeSnapshot): void {
    const current = this.#state;
    if (current.status === "ready" && snapshot.project_id === current.snapshot.project_id) {
      const revision = current.snapshot.snapshot_revision;
      if (snapshot.snapshot_revision < revision) return;
      if (snapshot.snapshot_revision === revision) {
        if (JSON.stringify(snapshot) === JSON.stringify(current.snapshot)) return;
        this.#publish({
          status: "failed",
          message: "Surface Runtime returned different data for one snapshot revision.",
        });
        return;
      }
    }
    this.#publish(
      deepFreeze({ status: "ready", source: this.#transport.source, snapshot } as const),
    );
  }

  async #runRefreshLoop(): Promise<void> {
    do {
      this.#refreshQueued = false;
      try {
        this.#install(await this.#transport.loadSurfaces());
      } catch (error: unknown) {
        if (this.#state.status !== "ready") {
          this.#publish({ status: "failed", message: errorMessage(error) });
        }
      }
    } while (this.#refreshQueued);
  }

  refresh(): Promise<void> {
    if (this.#refreshing != null) {
      this.#refreshQueued = true;
      return this.#refreshing;
    }
    this.#refreshing = this.#runRefreshLoop().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #mutate(
    operation: () => Promise<SurfaceRuntimeSnapshot>,
  ): Promise<SurfaceRuntimeSnapshot> {
    const snapshot = await operation();
    this.#install(snapshot);
    return snapshot;
  }

  open(request: OpenSurfaceRequest) {
    return this.#mutate(() => this.#transport.openSurface(request));
  }

  update(request: UpdateSurfaceRequest) {
    return this.#mutate(() => this.#transport.updateSurface(request));
  }

  close(request: SurfaceInstanceRequest) {
    return this.#mutate(() => this.#transport.closeSurface(request));
  }

  suspend(request: SurfaceInstanceRequest) {
    return this.#mutate(() => this.#transport.suspendSurface(request));
  }

  resume(request: SurfaceInstanceRequest) {
    return this.#mutate(() => this.#transport.resumeSurface(request));
  }
}

export class StudioExternalStore {
  readonly #transport: UiKernelTransport;
  readonly #listeners = new Set<() => void>();
  #state: StudioStoreSnapshot = STUDIO_LOADING;
  #stopTransport: Unsubscribe | undefined;
  #refreshing: Promise<void> | undefined;
  #refreshQueued = false;

  constructor(transport: UiKernelTransport) {
    this.#transport = transport;
  }

  readonly getSnapshot = (): StudioStoreSnapshot => this.#state;

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#stopTransport = this.#transport.subscribeStudioInvalidated(() => {
        void this.refresh();
      });
      void this.refresh();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#stopTransport?.();
        this.#stopTransport = undefined;
      }
    };
  };

  #publish(state: StudioStoreSnapshot): void {
    if (state === this.#state) return;
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  #install(snapshot: StudioRuntimeSnapshot): void {
    const current = this.#state;
    if (current.status === "ready" && snapshot.project_id === current.snapshot.project_id) {
      const revision = current.snapshot.snapshot_revision;
      if (snapshot.snapshot_revision < revision) return;
      if (snapshot.snapshot_revision === revision) {
        if (JSON.stringify(snapshot) === JSON.stringify(current.snapshot)) return;
        this.#publish({
          status: "failed",
          message: "Studio Runtime returned different data for one snapshot revision.",
        });
        return;
      }
    }
    this.#publish(
      deepFreeze({ status: "ready", source: this.#transport.source, snapshot } as const),
    );
  }

  async #runRefreshLoop(): Promise<void> {
    do {
      this.#refreshQueued = false;
      try {
        this.#install(await this.#transport.loadStudio());
      } catch (error: unknown) {
        if (this.#state.status !== "ready") {
          this.#publish({ status: "failed", message: errorMessage(error) });
        }
      }
    } while (this.#refreshQueued);
  }

  refresh(): Promise<void> {
    if (this.#refreshing != null) {
      this.#refreshQueued = true;
      return this.#refreshing;
    }
    this.#refreshing = this.#runRefreshLoop().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #mutate(operation: () => Promise<StudioRuntimeSnapshot>) {
    const snapshot = await operation();
    this.#install(snapshot);
    return snapshot;
  }

  apply(request: SceneEditRequest) {
    return this.#mutate(() => this.#transport.applyStudio(request));
  }

  undo(request: StudioRevisionRequest) {
    return this.#mutate(() => this.#transport.undoStudio(request));
  }

  redo(request: StudioRevisionRequest) {
    return this.#mutate(() => this.#transport.redoStudio(request));
  }
}

type ProfileStoreTransport = ProfileTransport & Pick<
  UiKernelTransport,
  "source" | "subscribeUiProfileInvalidated"
>;

export class UiProfileExternalStore {
  readonly #transport: ProfileStoreTransport;
  readonly #listeners = new Set<() => void>();
  #state: UiProfileStoreSnapshot = UI_PROFILE_LOADING;
  #stopTransport: Unsubscribe | undefined;
  #refreshing: Promise<void> | undefined;
  #refreshQueued = false;

  constructor(transport: ProfileStoreTransport) {
    this.#transport = transport;
  }

  readonly getSnapshot = (): UiProfileStoreSnapshot => this.#state;

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#stopTransport = this.#transport.subscribeUiProfileInvalidated(() => {
        void this.refresh();
      });
      void this.refresh();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#stopTransport?.();
        this.#stopTransport = undefined;
      }
    };
  };

  #publish(state: UiProfileStoreSnapshot): void {
    if (state === this.#state) return;
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  #install(snapshot: ProjectUiProfileSnapshot): void {
    const current = this.#state;
    if (current.status === "ready") {
      const revision = current.snapshot.profile.revision;
      if (snapshot.profile.project_id === current.snapshot.profile.project_id) {
        if (snapshot.profile.revision < revision) return;
        if (snapshot.profile.revision === revision) {
          if (JSON.stringify(snapshot) === JSON.stringify(current.snapshot)) return;
          this.#publish({
            status: "failed",
            message: "UI Profile returned different data for one profile revision.",
          });
          return;
        }
      }
    }
    this.#publish(
      deepFreeze({ status: "ready", source: this.#transport.source, snapshot } as const),
    );
  }

  async #runRefreshLoop(): Promise<void> {
    do {
      this.#refreshQueued = false;
      try {
        this.#install(await this.#transport.loadUiProfile());
      } catch (error: unknown) {
        if (this.#state.status !== "ready") {
          this.#publish({ status: "failed", message: errorMessage(error) });
        }
      }
    } while (this.#refreshQueued);
  }

  refresh(): Promise<void> {
    if (this.#refreshing != null) {
      this.#refreshQueued = true;
      return this.#refreshing;
    }
    this.#refreshing = this.#runRefreshLoop().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #mutate(operation: () => Promise<ProjectUiProfileSnapshot>) {
    const snapshot = await operation();
    this.#install(snapshot);
    return snapshot;
  }

  setMode(request: UiProfileSetModeRequest) {
    return this.#mutate(() => this.#transport.setUiProfileMode(request));
  }

  selectScene(request: UiProfileSelectSceneRequest) {
    return this.#mutate(() => this.#transport.selectUiProfileScene(request));
  }

  selectPage(request: UiProfileSelectPageRequest) {
    return this.#mutate(() => this.#transport.selectUiProfilePage(request));
  }

  applyPage(request: VibePageMutationRequest) {
    return this.#mutate(() => this.#transport.applyVibePage(request));
  }

  exportPage(request: VibePageExportRequest) {
    return this.#transport.exportVibePage(request);
  }

  duplicateScene(request: UiProfileSceneLabelRequest) {
    return this.#mutate(() => this.#transport.duplicateUiProfileScene(request));
  }

  saveScene(request: UiProfileSceneTargetRequest) {
    return this.#mutate(() => this.#transport.saveUiProfileScene(request));
  }

  renameScene(request: UiProfileSceneLabelRequest) {
    return this.#mutate(() => this.#transport.renameUiProfileScene(request));
  }

  deleteScene(request: UiProfileSceneTargetRequest) {
    return this.#mutate(() => this.#transport.deleteUiProfileScene(request));
  }

  resetScene(request: UiProfileSceneTargetRequest) {
    return this.#mutate(() => this.#transport.resetUiProfileScene(request));
  }
}

export class RuntimeExternalStore {
  readonly #transport: UiKernelTransport;
  readonly #listeners = new Set<() => void>();
  #state: RuntimeStoreSnapshot = RUNTIME_LOADING;
  #stopTransport: Unsubscribe | undefined;
  #refreshing: Promise<void> | undefined;
  #refreshQueued = false;

  constructor(transport: UiKernelTransport) {
    this.#transport = transport;
  }

  readonly getSnapshot = (): RuntimeStoreSnapshot => this.#state;

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#stopTransport = this.#transport.subscribeRuntimesInvalidated(() => {
        void this.refresh();
      });
      void this.refresh();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#stopTransport?.();
        this.#stopTransport = undefined;
      }
    };
  };

  #publish(state: RuntimeStoreSnapshot): void {
    if (state === this.#state) return;
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  #install(snapshot: RuntimeRegistrySnapshot): void {
    const current = this.#state;
    if (current.status === "ready" && snapshot.project_id === current.snapshot.project_id) {
      const revision = current.snapshot.snapshot_revision;
      if (snapshot.snapshot_revision < revision) return;
      if (snapshot.snapshot_revision === revision) {
        if (JSON.stringify(snapshot) === JSON.stringify(current.snapshot)) return;
        this.#publish({
          status: "failed",
          message: "Runtime Registry returned different data for one snapshot revision.",
        });
        return;
      }
    }
    this.#publish(
      deepFreeze({ status: "ready", source: this.#transport.source, snapshot } as const),
    );
  }

  async #runRefreshLoop(): Promise<void> {
    do {
      this.#refreshQueued = false;
      try {
        this.#install(await this.#transport.loadRuntimes());
      } catch (error: unknown) {
        if (this.#state.status !== "ready") {
          this.#publish({ status: "failed", message: errorMessage(error) });
        }
      }
    } while (this.#refreshQueued);
  }

  refresh(): Promise<void> {
    if (this.#refreshing != null) {
      this.#refreshQueued = true;
      return this.#refreshing;
    }
    this.#refreshing = this.#runRefreshLoop().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #mutate(operation: () => Promise<RuntimeRegistrySnapshot>) {
    const snapshot = await operation();
    this.#install(snapshot);
    return snapshot;
  }

  create(request: RuntimeCreateRequest) {
    return this.#mutate(() => this.#transport.createRuntime(request));
  }

  interrupt(request: RuntimeInstanceRequest) {
    return this.#mutate(() => this.#transport.interruptRuntime(request));
  }

  restart(request: RuntimeInstanceRequest) {
    return this.#mutate(() => this.#transport.restartRuntime(request));
  }

  stop(request: RuntimeInstanceRequest) {
    return this.#mutate(() => this.#transport.stopRuntime(request));
  }

  attach(request: RuntimeAttachmentRequest) {
    return this.#transport.attachRuntime(request);
  }

  detach(request: RuntimeDetachRequest) {
    return this.#transport.detachRuntime(request);
  }

  startExecution(request: RuntimeExecuteRequest) {
    return this.#transport.startRuntimeExecution(request);
  }

  getExecution(executionId: string) {
    return this.#transport.getRuntimeExecution(executionId);
  }

  listExecutions(limit = 50) {
    return this.#transport.listRuntimeExecutions(limit);
  }

  outputPage(executionId: string, afterSequence = 0) {
    return this.#transport.loadRuntimeOutputPage({
      execution_id: executionId,
      after_sequence: afterSequence,
      page_size: 100,
      byte_limit: 512 * 1024,
    });
  }

  outputPageBefore(executionId: string, beforeSequence: number) {
    return this.#transport.loadRuntimeOutputPage({
      execution_id: executionId,
      before_sequence: beforeSequence,
      page_size: 100,
      byte_limit: 512 * 1024,
    });
  }

  followOutput(executionId: string, afterSequence: number, listener: Parameters<UiKernelTransport["followRuntimeOutput"]>[2]) {
    return this.#transport.followRuntimeOutput(executionId, afterSequence, listener);
  }
}

type ResourceStoreTransport = ResourceTransport & Pick<
  UiKernelTransport,
  "source" | "subscribeResourcesInvalidated"
>;

export class ResourceExternalStore {
  readonly #transport: ResourceStoreTransport;
  readonly #listeners = new Set<() => void>();
  #state: ResourceStoreSnapshot = RESOURCE_LOADING;
  #stopTransport: Unsubscribe | undefined;
  #refreshing: Promise<void> | undefined;
  #refreshQueued = false;

  constructor(transport: ResourceStoreTransport) {
    this.#transport = transport;
  }

  readonly getSnapshot = (): ResourceStoreSnapshot => this.#state;

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#stopTransport = this.#transport.subscribeResourcesInvalidated(() => {
        void this.refresh();
      });
      void this.refresh();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#stopTransport?.();
        this.#stopTransport = undefined;
      }
    };
  };

  #publish(state: ResourceStoreSnapshot): void {
    if (state === this.#state) return;
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  #install(snapshot: ResourceRegistrySnapshot): void {
    const current = this.#state;
    if (current.status === "ready" && snapshot.project_id === current.snapshot.project_id) {
      const revision = current.snapshot.snapshot_revision;
      if (snapshot.snapshot_revision < revision) return;
      if (snapshot.snapshot_revision === revision) {
        if (JSON.stringify(snapshot) === JSON.stringify(current.snapshot)) return;
        this.#publish({
          status: "failed",
          message: "Resource Registry returned different data for one snapshot revision.",
        });
        return;
      }
    }
    this.#publish(
      deepFreeze({ status: "ready", source: this.#transport.source, snapshot } as const),
    );
  }

  async #runRefreshLoop(): Promise<void> {
    do {
      this.#refreshQueued = false;
      try {
        this.#install(await this.#transport.loadResources());
      } catch (error: unknown) {
        if (this.#state.status !== "ready") {
          this.#publish({ status: "failed", message: errorMessage(error) });
        }
      }
    } while (this.#refreshQueued);
  }

  refresh(): Promise<void> {
    if (this.#refreshing != null) {
      this.#refreshQueued = true;
      return this.#refreshing;
    }
    this.#refreshing = this.#runRefreshLoop().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #mutate(operation: () => Promise<ResourceRegistrySnapshot>) {
    const snapshot = await operation();
    this.#install(snapshot);
    return snapshot;
  }

  resolve(request: ResourceResolveRequest) {
    return this.#mutate(() => this.#transport.resolveResource(request));
  }

  read(request: ResourceReadRequest) {
    return this.#transport.readResource(request);
  }

  updateDraft(request: ResourceDraftRequest) {
    return this.#transport.updateResourceDraft(request);
  }

  save(request: ResourceSaveRequest) {
    return this.#transport.saveResource(request);
  }

  reload(request: ResourceReloadRequest) {
    return this.#transport.reloadResource(request);
  }

  rename(request: ResourceRenameRequest) {
    return this.#mutate(() => this.#transport.renameResource(request));
  }

  delete(request: ResourceDeleteRequest) {
    return this.#mutate(() => this.#transport.deleteResource(request));
  }
}

export function commandsForPlacement(
  snapshot: UiKernelSnapshot,
  placement: CommandPlacementTag,
) {
  return snapshot.command_registry.registrations.filter((registration) =>
    registration.definition.placement_tags.includes(placement),
  );
}
