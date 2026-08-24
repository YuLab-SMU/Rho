import {
  createSurfaceStudioCommands,
  type LayoutAxisV1,
  type LayoutBasisV1,
  type LayoutChildV1,
  type LayoutNodeV1,
  type OpenSurfaceRequestV1,
  type RuntimeAttachmentRequestV1,
  type RuntimeDetachRequestV1,
  type SceneEditRequestV1,
  type SceneEditV1,
  type SceneStateV1,
  type StackNodeV1,
  type StudioRevisionRequestV1,
  type StudioRuntimeSnapshotV1,
  type SurfaceDefinitionV1_Serialize,
  type SurfaceFactoryRegistrationV1_Serialize,
  type SurfaceInstanceMutationV1,
  type SurfaceInstanceRequestV1,
  type SurfaceInstanceV1,
  type SurfaceLifecycleStateV1,
  type SurfaceOriginV1,
  type SurfaceRuntimeSnapshotV1_Serialize,
  type SurfaceStudioInvoke,
  type UpdateSurfaceRequestV1,
} from "./generated/surface-studio";
export type { ResourceBinding } from "./resource";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type SurfaceOrigin = DeepReadonly<SurfaceOriginV1>;
export type SurfaceLifecycleState = SurfaceLifecycleStateV1;

export type SurfaceDefinition = Omit<
  DeepReadonly<SurfaceDefinitionV1_Serialize>,
  "icon"
> & {
  readonly icon?: string;
};

export type SurfaceFactoryRegistration = Omit<
  DeepReadonly<SurfaceFactoryRegistrationV1_Serialize>,
  "definition"
> & {
  readonly definition: SurfaceDefinition;
};

export type SurfaceInstance = DeepReadonly<SurfaceInstanceV1>;

export type SurfaceRuntimeSnapshot = Omit<
  DeepReadonly<SurfaceRuntimeSnapshotV1_Serialize>,
  "contract" | "contract_major" | "catalog"
> & {
  readonly contract: "rho.ui.surface-runtime.snapshot.v1";
  readonly contract_major: 1;
  readonly catalog: {
    readonly factories: readonly SurfaceFactoryRegistration[];
    readonly instances: readonly SurfaceInstance[];
  };
};

export type OpenSurfaceRequest = DeepReadonly<OpenSurfaceRequestV1>;
export type SurfaceInstanceRequest = DeepReadonly<SurfaceInstanceRequestV1>;
export type SurfaceInstanceMutation = DeepReadonly<SurfaceInstanceMutationV1>;
export type UpdateSurfaceRequest = DeepReadonly<UpdateSurfaceRequestV1>;
export type RuntimeAttachmentRequest = DeepReadonly<RuntimeAttachmentRequestV1>;
export type RuntimeDetachRequest = DeepReadonly<RuntimeDetachRequestV1>;

export type LayoutAxis = LayoutAxisV1;
export type LayoutBasis = DeepReadonly<LayoutBasisV1>;
export type LayoutChild = DeepReadonly<LayoutChildV1>;
export type StackNode = DeepReadonly<StackNodeV1>;
export type LayoutNode = DeepReadonly<LayoutNodeV1>;
export type SceneState = DeepReadonly<SceneStateV1>;
export type SceneEdit = DeepReadonly<SceneEditV1>;
export type SceneEditRequest = DeepReadonly<SceneEditRequestV1>;
export type StudioRevisionRequest = DeepReadonly<StudioRevisionRequestV1>;

export type StudioRuntimeSnapshot = Omit<
  DeepReadonly<StudioRuntimeSnapshotV1>,
  "contract" | "contract_major"
> & {
  readonly contract: "rho.ui.studio-runtime.snapshot.v1";
  readonly contract_major: 1;
};

export interface SurfaceStudioTransport {
  loadSurfaces(): Promise<SurfaceRuntimeSnapshot>;
  openSurface(request: OpenSurfaceRequest): Promise<SurfaceRuntimeSnapshot>;
  updateSurface(request: UpdateSurfaceRequest): Promise<SurfaceRuntimeSnapshot>;
  closeSurface(request: SurfaceInstanceRequest): Promise<SurfaceRuntimeSnapshot>;
  suspendSurface(request: SurfaceInstanceRequest): Promise<SurfaceRuntimeSnapshot>;
  resumeSurface(request: SurfaceInstanceRequest): Promise<SurfaceRuntimeSnapshot>;
  loadStudio(): Promise<StudioRuntimeSnapshot>;
  applyStudio(request: SceneEditRequest): Promise<StudioRuntimeSnapshot>;
  undoStudio(request: StudioRevisionRequest): Promise<StudioRuntimeSnapshot>;
  redoStudio(request: StudioRevisionRequest): Promise<StudioRuntimeSnapshot>;
  attachRuntime(request: RuntimeAttachmentRequest): Promise<SurfaceRuntimeSnapshot>;
  detachRuntime(request: RuntimeDetachRequest): Promise<SurfaceRuntimeSnapshot>;
}

function checkedSurfaceSnapshot(
  snapshot: SurfaceRuntimeSnapshotV1_Serialize,
): SurfaceRuntimeSnapshot {
  if (
    snapshot.contract !== "rho.ui.surface-runtime.snapshot.v1" ||
    snapshot.contract_major !== 1
  ) {
    throw new Error("Surface Runtime returned an unsupported contract version.");
  }
  return snapshot as SurfaceRuntimeSnapshot;
}

function checkedStudioSnapshot(snapshot: StudioRuntimeSnapshotV1): StudioRuntimeSnapshot {
  if (
    snapshot.contract !== "rho.ui.studio-runtime.snapshot.v1" ||
    snapshot.contract_major !== 1
  ) {
    throw new Error("Studio Runtime returned an unsupported contract version.");
  }
  return snapshot as StudioRuntimeSnapshot;
}

export function createTauriSurfaceStudioTransport(
  invoke: SurfaceStudioInvoke,
): SurfaceStudioTransport {
  const commands = createSurfaceStudioCommands(invoke);
  return {
    loadSurfaces: () => commands.surfaceList().then(checkedSurfaceSnapshot),
    openSurface: (request) => (
      commands.surfaceOpen(request as OpenSurfaceRequestV1).then(checkedSurfaceSnapshot)
    ),
    updateSurface: (request) => (
      commands.surfaceUpdate(request as UpdateSurfaceRequestV1).then(checkedSurfaceSnapshot)
    ),
    closeSurface: (request) => commands.surfaceClose(request).then(checkedSurfaceSnapshot),
    suspendSurface: (request) => commands.surfaceSuspend(request).then(checkedSurfaceSnapshot),
    resumeSurface: (request) => commands.surfaceResume(request).then(checkedSurfaceSnapshot),
    loadStudio: () => commands.studioScene().then(checkedStudioSnapshot),
    applyStudio: (request) => (
      commands.studioApply(request as SceneEditRequestV1).then(checkedStudioSnapshot)
    ),
    undoStudio: (request) => commands.studioUndo(request).then(checkedStudioSnapshot),
    redoStudio: (request) => commands.studioRedo(request).then(checkedStudioSnapshot),
    attachRuntime: (request) => commands.runtimeAttach(request).then(checkedSurfaceSnapshot),
    detachRuntime: (request) => commands.runtimeDetach(request).then(checkedSurfaceSnapshot),
  };
}
