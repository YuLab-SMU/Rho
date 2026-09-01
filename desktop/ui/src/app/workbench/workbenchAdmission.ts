import type {
  ResourceDescriptor,
  ResourceTarget,
  RuntimeDescriptor,
  RuntimeInstanceRequest,
  SurfaceInstance,
  SurfaceInstanceRequest,
  UiKernelTransport,
} from "../../transport";
import type { WorkbenchProjectionStore } from "../../transport";
import type { FileMutationWorkflow } from "../FileResourceView";
import type {
  ProjectActionScope,
  ProjectTransitionEpochController,
} from "../controllers/project-transition-epoch-controller";

export async function settleWorkbenchMutationQueues(
  controllerQueues: readonly Promise<void>[],
  settleStore: () => Promise<void>,
): Promise<void> {
  const controllerResults = await Promise.allSettled(controllerQueues);
  let storeFailure: unknown = null;
  try {
    await settleStore();
  } catch (error: unknown) {
    storeFailure = error;
  }
  const controllerFailure = controllerResults.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (controllerFailure != null) throw controllerFailure.reason;
  if (storeFailure != null) throw storeFailure;
}

export async function runRevocableFileMutationWorkflow<T>(
  operation: (workflow: FileMutationWorkflow) => Promise<T>,
  ports: FileMutationWorkflow,
): Promise<T> {
  let open = true;
  const runIfOpen = <Result,>(action: () => Promise<Result>): Promise<Result> => (
    open ? action() : Promise.reject(new Error("The File workflow capability has expired."))
  );
  const workflow: FileMutationWorkflow = {
    updateDraft: (content, value) => runIfOpen(() => ports.updateDraft(content, value)),
    save: (content) => runIfOpen(() => ports.save(content)),
    runSourceExecution: (execution) => runIfOpen(() => ports.runSourceExecution(execution)),
  };
  try {
    return await operation(workflow);
  } finally {
    open = false;
  }
}

export function instanceRequest(
  instance: SurfaceInstance,
  projectRevision: number,
): SurfaceInstanceRequest {
  return {
    project_id: instance.project_id,
    instance_id: instance.instance_id,
    activation_generation: instance.activation_generation,
    expected_project_revision: projectRevision,
    expected_surface_revision: instance.surface_revision,
  };
}

export function runtimeRequest(
  runtime: RuntimeDescriptor,
  projectRevision: number,
): RuntimeInstanceRequest {
  return {
    project_id: runtime.project_id,
    runtime_provider_id: runtime.runtime_provider_id,
    runtime_instance_id: runtime.runtime_instance_id,
    activation_generation: runtime.activation_generation,
    expected_project_revision: projectRevision,
    expected_state_revision: runtime.state_revision,
  };
}

export function resourceTarget(
  descriptor: ResourceDescriptor,
  projectRevision: number,
  resourceRevision = descriptor.resource_revision,
): ResourceTarget {
  return {
    project_id: descriptor.project_id,
    resource_provider_id: descriptor.resource_provider_id,
    resource_kind: descriptor.resource_kind,
    resource_id: descriptor.resource_id,
    expected_project_revision: projectRevision,
    expected_resource_revision: resourceRevision,
  };
}

export function sameProjectActionScope(
  left: ProjectActionScope | null,
  right: ProjectActionScope | null,
): boolean {
  return left?.epoch === right?.epoch
    && left?.projectId === right?.projectId
    && left?.projectRevision === right?.projectRevision;
}

const ADMISSION_GUARDED_TRANSPORT_METHODS = new Set<PropertyKey>([
  "retryRun",
  "updateRuntimeOutputPolicy",
  "pruneRuntimeOutput",
  "deleteRuntimeExecution",
  "createAgentConversation",
  "runAgent",
  "retryAgentTurn",
  "cancelAgentTurn",
  "respondAgentApproval",
  "retryAgentRuntime",
  "applyAgentFileEdit",
  "undoAgentFileEdit",
  "dispatchPluginSurfaceEvent",
  "runCheckProject",
  "setSelection",
]);

export function createAdmissionGuardedTransport(
  transport: UiKernelTransport,
  store: WorkbenchProjectionStore,
  controller: ProjectTransitionEpochController,
  scope: ProjectActionScope | null,
): UiKernelTransport {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(transport, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const cached = methods.get(property);
      if (cached != null) return cached;
      const bound = value.bind(target) as (...args: unknown[]) => unknown;
      const method = ADMISSION_GUARDED_TRANSPORT_METHODS.has(property)
        ? (...args: unknown[]) => {
            if (scope == null || !controller.accepts(scope)) {
              return Promise.reject(new Error("The project action belongs to an inactive transition epoch."));
            }
            const current = store.getSnapshot();
            if (current.status !== "ready") return Promise.reject(new Error("Workbench is not ready."));
            if (
              current.snapshot.project_id !== scope.projectId
              || current.snapshot.kernel.context.project_revision !== scope.projectRevision
            ) {
              return Promise.reject(new Error("The project action scope is stale."));
            }
            return store.admitMutation(scope.projectId, () => Promise.resolve(bound(...args)));
          }
        : bound;
      methods.set(property, method);
      return method;
    },
  }) as UiKernelTransport;
}
