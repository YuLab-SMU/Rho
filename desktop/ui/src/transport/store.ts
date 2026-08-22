import type {
  CommandPlacementTag,
  OpenSurfaceRequest,
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

const LOADING: UiStoreSnapshot = Object.freeze({ status: "loading" });
const SURFACE_LOADING: SurfaceStoreSnapshot = Object.freeze({ status: "loading" });
const STUDIO_LOADING: StudioStoreSnapshot = Object.freeze({ status: "loading" });
const RUNTIME_LOADING: RuntimeStoreSnapshot = Object.freeze({ status: "loading" });

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
    if (current.status === "ready") {
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
    if (current.status === "ready") {
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
    if (current.status === "ready") {
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
    if (current.status === "ready") {
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

  execute(request: RuntimeExecuteRequest) {
    return this.#transport.executeRuntime(request);
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
