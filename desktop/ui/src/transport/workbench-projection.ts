import {
  createWorkbenchProjectionCommands,
  type WorkbenchProjectionInvoke,
  type WorkbenchProjectionV1_Serialize,
  type WorkbenchRevisionVectorV1,
} from "./generated/workbench-projection";
import type { UiKernelSnapshot } from "./kernel-generated";
import type { ProjectUiProfileSnapshot } from "./profile";
import type { ResourceRegistrySnapshot } from "./resource";
import type { RuntimeRegistrySnapshot } from "./runtime";
import type { StudioRuntimeSnapshot, SurfaceRuntimeSnapshot } from "./surface-studio";
import type { Unsubscribe } from "./types";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type WorkbenchRevisionVector = DeepReadonly<WorkbenchRevisionVectorV1>;

export type WorkbenchProjection = Omit<
  DeepReadonly<WorkbenchProjectionV1_Serialize>,
  | "contract"
  | "contract_major"
  | "kernel"
  | "surfaces"
  | "studio"
  | "runtimes"
  | "resources"
  | "profile"
> & {
  readonly contract: "rho.ui.workbench-projection.v1";
  readonly contract_major: 1;
  readonly kernel: UiKernelSnapshot;
  readonly surfaces: SurfaceRuntimeSnapshot;
  readonly studio: StudioRuntimeSnapshot;
  readonly runtimes: RuntimeRegistrySnapshot;
  readonly resources: ResourceRegistrySnapshot;
  readonly profile: ProjectUiProfileSnapshot;
};

export interface WorkbenchProjectionTransport {
  loadWorkbenchProjection(): Promise<WorkbenchProjection>;
  subscribeWorkbenchInvalidated(listener: () => void): Unsubscribe;
}

export function validateWorkbenchProjection(
  projection: WorkbenchProjectionV1_Serialize | WorkbenchProjection,
): WorkbenchProjection {
  if (
    projection.contract !== "rho.ui.workbench-projection.v1" ||
    projection.contract_major !== 1 ||
    projection.projection_generation <= 0
  ) {
    throw new Error("Workbench returned an unsupported projection contract.");
  }
  const projectId = projection.project_id;
  const projectIds = [
    projection.kernel.project.project_id,
    projection.kernel.context.project_id,
    projection.surfaces.project_id,
    projection.studio.project_id,
    projection.studio.scene.project_id,
    projection.runtimes.project_id,
    projection.resources.project_id,
    projection.profile.profile.project_id,
  ];
  if (projectIds.some((candidate) => candidate !== projectId)) {
    throw new Error("Workbench returned snapshots from different projects.");
  }
  const revisions = projection.revisions;
  const projectRevisions = [
    projection.kernel.context.project_revision,
    projection.surfaces.project_revision,
    projection.studio.project_revision,
    projection.runtimes.project_revision,
    projection.resources.project_revision,
  ];
  if (
    revisions.project_revision <= 0 ||
    projectRevisions.some((revision) => revision !== revisions.project_revision) ||
    revisions.kernel_snapshot_revision !== projection.kernel.snapshot_revision ||
    revisions.surface_snapshot_revision !== projection.surfaces.snapshot_revision ||
    revisions.studio_snapshot_revision !== projection.studio.snapshot_revision ||
    revisions.layout_revision !== projection.studio.scene.layout_revision ||
    revisions.runtime_snapshot_revision !== projection.runtimes.snapshot_revision ||
    revisions.resource_snapshot_revision !== projection.resources.snapshot_revision ||
    revisions.profile_revision !== projection.profile.profile.revision
  ) {
    throw new Error("Workbench returned a projection with a mismatched revision vector.");
  }
  return projection as WorkbenchProjection;
}

export function createTauriWorkbenchProjectionTransport(
  invoke: WorkbenchProjectionInvoke,
): Pick<WorkbenchProjectionTransport, "loadWorkbenchProjection"> {
  const commands = createWorkbenchProjectionCommands(invoke);
  return {
    loadWorkbenchProjection: () => (
      commands.workbenchProjectionSnapshot().then(validateWorkbenchProjection)
    ),
  };
}
