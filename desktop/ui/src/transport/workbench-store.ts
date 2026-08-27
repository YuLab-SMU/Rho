import type {
  OpenSurfaceRequest,
  ProjectUiProfileSnapshot,
  ResourceDeleteRequest,
  ResourceDraftRequest,
  ResourceReadRequest,
  ResourceRegistrySnapshot,
  ResourceReloadRequest,
  ResourceRenameRequest,
  ResourceResolveRequest,
  ResourceSaveRequest,
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
  UiProfileSceneLabelRequest,
  UiProfileSceneTargetRequest,
  UiProfileSelectPageRequest,
  UiProfileSelectSceneRequest,
  UiProfileSetModeRequest,
  Unsubscribe,
  UpdateSurfaceRequest,
  VibePageExportRequest,
  VibePageMutationRequest,
} from "./types";
import {
  validateWorkbenchProjection,
  type WorkbenchProjection,
} from "./workbench-projection";

export type WorkbenchStoreSnapshot =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly source: UiKernelTransport["source"];
      readonly snapshot: WorkbenchProjection;
    };

export type DomainStoreSnapshot<T> =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly source: UiKernelTransport["source"];
      readonly snapshot: T;
    };

export type UiStoreSnapshot = DomainStoreSnapshot<UiKernelSnapshot>;
export type SurfaceStoreSnapshot = DomainStoreSnapshot<SurfaceRuntimeSnapshot>;
export type StudioStoreSnapshot = DomainStoreSnapshot<StudioRuntimeSnapshot>;
export type RuntimeStoreSnapshot = DomainStoreSnapshot<RuntimeRegistrySnapshot>;
export type ResourceStoreSnapshot = DomainStoreSnapshot<ResourceRegistrySnapshot>;
export type UiProfileStoreSnapshot = DomainStoreSnapshot<ProjectUiProfileSnapshot>;

const LOADING: WorkbenchStoreSnapshot = Object.freeze({ status: "loading" });

export type WorkbenchMutationLease = Readonly<{
  projectId: string;
  admissionEpoch: number;
}>;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, 512);
  return "Rho could not load the Workbench projection.";
}

function deepFreeze<T>(value: T): T {
  if (value != null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function sameProjection(left: WorkbenchProjection, right: WorkbenchProjection): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class WorkbenchProjectionStore {
  readonly #transport: UiKernelTransport;
  readonly #listeners = new Set<() => void>();
  #state: WorkbenchStoreSnapshot = LOADING;
  #installedProjection: WorkbenchProjection | undefined;
  #stopTransport: Unsubscribe | undefined;
  #refreshing: Promise<void> | undefined;
  #refreshQueued = false;
  readonly #mutations = new Set<Promise<unknown>>();
  readonly #admittedOperations = new Set<Promise<unknown>>();
  readonly #liveMutationLeases = new WeakSet<WorkbenchMutationLease>();
  #mutationAdmissionOpen = true;
  #mutationAdmissionEpoch = 0;

  constructor(transport: UiKernelTransport) {
    this.#transport = transport;
  }

  readonly getSnapshot = (): WorkbenchStoreSnapshot => this.#state;

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#stopTransport = this.#transport.subscribeWorkbenchInvalidated(() => {
        void this.refresh().catch(() => undefined);
      });
      void this.refresh().catch(() => undefined);
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#stopTransport?.();
        this.#stopTransport = undefined;
      }
    };
  };

  #publish(state: WorkbenchStoreSnapshot): void {
    if (state === this.#state) return;
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  #install(projection: WorkbenchProjection): void {
    const current = this.#installedProjection;
    if (current != null) {
      const generation = current.projection_generation;
      if (projection.projection_generation < generation) return;
      if (projection.projection_generation === generation) {
        if (sameProjection(projection, current)) return;
        const message = "Workbench returned different data for one projection generation.";
        this.#publish({ status: "failed", message });
        throw new Error(message);
      }
    }
    const installed = deepFreeze(projection);
    this.#installedProjection = installed;
    this.#publish(deepFreeze({
      status: "ready",
      source: this.#transport.source,
      snapshot: installed,
    } as const));
  }

  async #loadProjection(): Promise<WorkbenchProjection> {
    const projection = validateWorkbenchProjection(
      await this.#transport.loadWorkbenchProjection(),
    );
    this.#install(projection);
    const current = this.#state;
    if (current.status !== "ready") {
      throw new Error(current.status === "failed" ? current.message : "Workbench is not ready.");
    }
    return current.snapshot;
  }

  async #runRefreshLoop(): Promise<void> {
    let failure: unknown;
    do {
      this.#refreshQueued = false;
      try {
        await this.#loadProjection();
        failure = undefined;
      } catch (error: unknown) {
        failure = error;
        if (this.#state.status !== "ready") {
          this.#publish({ status: "failed", message: errorMessage(error) });
        }
      }
    } while (this.#refreshQueued);
    if (failure != null) throw failure;
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

  #domain<T>(select: (projection: WorkbenchProjection) => T): DomainStoreSnapshot<T> {
    const current = this.#state;
    if (current.status !== "ready") return current;
    return { status: "ready", source: current.source, snapshot: select(current.snapshot) };
  }

  readonly getKernelSnapshot = (): UiStoreSnapshot => this.#domain((value) => value.kernel);
  readonly getSurfaceSnapshot = (): SurfaceStoreSnapshot => this.#domain((value) => value.surfaces);
  readonly getStudioSnapshot = (): StudioStoreSnapshot => this.#domain((value) => value.studio);
  readonly getRuntimeSnapshot = (): RuntimeStoreSnapshot => this.#domain((value) => value.runtimes);
  readonly getResourceSnapshot = (): ResourceStoreSnapshot => this.#domain((value) => value.resources);
  readonly getProfileSnapshot = (): UiProfileStoreSnapshot => this.#domain((value) => value.profile);

  #assertProject(projectId: string): void {
    const current = this.#state;
    if (current.status !== "ready") throw new Error("Workbench is not ready.");
    if (current.snapshot.project_id !== projectId) {
      throw new Error("The project changed before the operation could synchronize.");
    }
  }

  async #performMutation<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    this.#assertProject(projectId);
    const before = this.#installedProjection?.projection_generation ?? 0;
    const result = await operation();
    const projection = await this.#loadProjection();
    if (projection.project_id !== projectId) {
      throw new Error("The project changed while the operation was synchronizing.");
    }
    if (projection.projection_generation <= before) {
      throw new Error("Workbench did not publish a new projection after the operation.");
    }
    return result;
  }

  #mutate<T>(
    projectId: string,
    operation: () => Promise<T>,
    lease?: WorkbenchMutationLease,
  ): Promise<T> {
    if (lease == null) {
      return this.admitMutation(projectId, (admitted) => (
        this.#mutate(projectId, operation, admitted)
      ));
    }
    if (!this.#liveMutationLeases.has(lease) || lease.projectId !== projectId) {
      return Promise.reject(new Error("The Workbench mutation admission is no longer valid."));
    }
    const mutation = this.#performMutation(projectId, operation);
    this.#mutations.add(mutation);
    void mutation.then(
      () => this.#mutations.delete(mutation),
      () => this.#mutations.delete(mutation),
    );
    return mutation;
  }

  async settled(): Promise<void> {
    while (this.#admittedOperations.size > 0 || this.#mutations.size > 0) {
      await Promise.allSettled([
        ...this.#admittedOperations,
        ...this.#mutations,
      ]);
    }
  }

  admitMutation<T>(
    projectId: string,
    operation: (lease: WorkbenchMutationLease) => Promise<T>,
  ): Promise<T> {
    if (!this.#mutationAdmissionOpen) {
      return Promise.reject(new Error("Project transition is in progress."));
    }
    this.#assertProject(projectId);
    const lease = Object.freeze({
      projectId,
      admissionEpoch: this.#mutationAdmissionEpoch,
    });
    this.#liveMutationLeases.add(lease);
    let admitted: Promise<T>;
    try {
      admitted = Promise.resolve(operation(lease));
    } catch (error: unknown) {
      admitted = Promise.reject(error);
    }
    const tracked = admitted.finally(() => {
      this.#liveMutationLeases.delete(lease);
    });
    this.#admittedOperations.add(tracked);
    void tracked.then(
      () => this.#admittedOperations.delete(tracked),
      () => this.#admittedOperations.delete(tracked),
    );
    return tracked;
  }

  closeMutationAdmission(): void {
    if (!this.#mutationAdmissionOpen) return;
    this.#mutationAdmissionOpen = false;
    this.#mutationAdmissionEpoch += 1;
  }

  openMutationAdmission(): void {
    this.#mutationAdmissionOpen = true;
  }

  readonly isMutationAdmissionOpen = (): boolean => this.#mutationAdmissionOpen;

  open(request: OpenSurfaceRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.project_id, () => this.#transport.openSurface(request), lease);
  }

  update(request: UpdateSurfaceRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(
      request.target.project_id,
      () => this.#transport.updateSurface(request),
      lease,
    );
  }

  close(request: SurfaceInstanceRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.project_id, () => this.#transport.closeSurface(request), lease);
  }

  suspend(request: SurfaceInstanceRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(
      request.project_id,
      () => this.#transport.suspendSurface(request),
      lease,
    );
  }

  resume(request: SurfaceInstanceRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(
      request.project_id,
      () => this.#transport.resumeSurface(request),
      lease,
    );
  }

  apply(request: SceneEditRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(
      request.project_id,
      () => this.#transport.applyStudio(request),
      lease,
    );
  }

  undo(request: StudioRevisionRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(
      request.project_id,
      () => this.#transport.undoStudio(request),
      lease,
    );
  }

  redo(request: StudioRevisionRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(
      request.project_id,
      () => this.#transport.redoStudio(request),
      lease,
    );
  }

  setMode(request: UiProfileSetModeRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.target.project_id, () => this.#transport.setUiProfileMode(request), lease);
  }

  selectScene(request: UiProfileSelectSceneRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.target.project_id, () => this.#transport.selectUiProfileScene(request), lease);
  }

  selectPage(request: UiProfileSelectPageRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.target.project_id, () => this.#transport.selectUiProfilePage(request), lease);
  }

  applyPage(request: VibePageMutationRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.target.project_id, () => this.#transport.applyVibePage(request), lease);
  }

  exportPage(request: VibePageExportRequest) {
    return this.#transport.exportVibePage(request);
  }

  duplicateScene(request: UiProfileSceneLabelRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.target.project_id, () => this.#transport.duplicateUiProfileScene(request), lease);
  }

  saveScene(request: UiProfileSceneTargetRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.target.project_id, () => this.#transport.saveUiProfileScene(request), lease);
  }

  renameScene(request: UiProfileSceneLabelRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.target.project_id, () => this.#transport.renameUiProfileScene(request), lease);
  }

  deleteScene(request: UiProfileSceneTargetRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.target.project_id, () => this.#transport.deleteUiProfileScene(request), lease);
  }

  resetScene(request: UiProfileSceneTargetRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.target.project_id, () => this.#transport.resetUiProfileScene(request), lease);
  }

  create(request: RuntimeCreateRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.project_id, () => this.#transport.createRuntime(request), lease);
  }

  interrupt(request: RuntimeInstanceRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.project_id, () => this.#transport.interruptRuntime(request), lease);
  }

  restart(request: RuntimeInstanceRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.project_id, () => this.#transport.restartRuntime(request), lease);
  }

  stop(request: RuntimeInstanceRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.project_id, () => this.#transport.stopRuntime(request), lease);
  }

  attach(request: RuntimeAttachmentRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.surface.project_id, () => this.#transport.attachRuntime(request), lease);
  }

  detach(request: RuntimeDetachRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.surface.project_id, () => this.#transport.detachRuntime(request), lease);
  }

  startExecution(request: RuntimeExecuteRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.runtime.project_id, () => this.#transport.startRuntimeExecution(request), lease);
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

  followOutput(
    executionId: string,
    afterSequence: number,
    listener: Parameters<UiKernelTransport["followRuntimeOutput"]>[2],
  ) {
    return this.#transport.followRuntimeOutput(executionId, afterSequence, listener);
  }

  resolve(request: ResourceResolveRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.project_id, () => this.#transport.resolveResource(request), lease);
  }

  read(request: ResourceReadRequest) {
    return this.#transport.readResource(request);
  }

  updateDraft(request: ResourceDraftRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.target.project_id, () => this.#transport.updateResourceDraft(request), lease);
  }

  save(request: ResourceSaveRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.target.project_id, () => this.#transport.saveResource(request), lease);
  }

  reload(request: ResourceReloadRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.target.project_id, () => this.#transport.reloadResource(request), lease);
  }

  rename(request: ResourceRenameRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.target.project_id, () => this.#transport.renameResource(request), lease);
  }

  delete(request: ResourceDeleteRequest, lease?: WorkbenchMutationLease) {
    return this.#mutate(request.target.project_id, () => this.#transport.deleteResource(request), lease);
  }
}
