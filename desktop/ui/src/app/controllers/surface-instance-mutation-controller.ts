import type {
  SurfaceInstance,
  SurfaceInstanceRequest,
  SurfaceRuntimeSnapshot,
} from "../../transport";
import type { SurfaceInstanceMutation, UpdateSurfaceRequest } from "../../transport/types";
import type { SurfaceStoreSnapshot } from "../../transport/store";

export interface SurfaceInstanceMutationPorts {
  readonly getSurfaces: () => SurfaceStoreSnapshot;
  readonly update: (request: UpdateSurfaceRequest) => Promise<SurfaceRuntimeSnapshot>;
  readonly suspend: (request: SurfaceInstanceRequest) => Promise<SurfaceRuntimeSnapshot>;
  readonly resume: (request: SurfaceInstanceRequest) => Promise<SurfaceRuntimeSnapshot>;
}

function requestFor(
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

export class SurfaceInstanceMutationController {
  readonly #ports: SurfaceInstanceMutationPorts;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(ports: SurfaceInstanceMutationPorts) {
    this.#ports = ports;
  }

  update(instanceId: string, mutation: SurfaceInstanceMutation): Promise<SurfaceRuntimeSnapshot> {
    return this.#enqueue(instanceId, (target) => this.#ports.update({ target, mutation }));
  }

  suspend(instanceId: string): Promise<SurfaceRuntimeSnapshot> {
    return this.#enqueue(instanceId, this.#ports.suspend);
  }

  resume(instanceId: string): Promise<SurfaceRuntimeSnapshot> {
    return this.#enqueue(instanceId, this.#ports.resume);
  }

  async settled(instanceId?: string): Promise<void> {
    if (instanceId != null) await this.#queues.get(instanceId);
    else await Promise.all(this.#queues.values());
  }

  #enqueue(
    instanceId: string,
    operation: (request: SurfaceInstanceRequest) => Promise<SurfaceRuntimeSnapshot>,
  ): Promise<SurfaceRuntimeSnapshot> {
    const admitted = this.#ports.getSurfaces();
    if (admitted.status !== "ready") {
      return Promise.reject(new Error("Surface Runtime is not ready."));
    }
    const admittedProjectId = admitted.snapshot.project_id;
    const previous = this.#queues.get(instanceId) ?? Promise.resolve();
    const task = previous.then(async () => {
      const current = this.#ports.getSurfaces();
      if (current.status !== "ready") throw new Error("Surface Runtime is not ready.");
      if (current.snapshot.project_id !== admittedProjectId) {
        throw new Error("The project changed before the component update could start.");
      }
      const instance = current.snapshot.catalog.instances.find(
        (candidate) => candidate.instance_id === instanceId,
      );
      if (instance == null) throw new Error("The component is no longer available.");
      return operation(requestFor(instance, current.snapshot.project_revision));
    });
    const tail = task.then(() => undefined, () => undefined);
    this.#queues.set(instanceId, tail);
    void tail.then(() => {
      if (this.#queues.get(instanceId) === tail) this.#queues.delete(instanceId);
    });
    return task;
  }
}
