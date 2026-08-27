import type {
  SceneEdit,
  SceneEditRequest,
  StudioRevisionRequest,
  StudioRuntimeSnapshot,
} from "../../transport";
import type { StudioStoreSnapshot } from "../../transport/store";
import type { WorkbenchMutationLease } from "../../transport/workbench-store";
import { computeStudioDrop } from "../../transport/studio-model";
import type { StudioDropTarget } from "../../transport/studio-model";
import { workbenchFailureMessage } from "../workbench-failure";
import { workbenchOperationTrace } from "../operation-trace";

export interface StudioMutationPorts {
  readonly getStudio: () => StudioStoreSnapshot;
  readonly admit: <T>(
    projectId: string,
    operation: (lease: WorkbenchMutationLease) => Promise<T>,
  ) => Promise<T>;
  readonly apply: (
    request: SceneEditRequest,
    lease: WorkbenchMutationLease,
  ) => Promise<StudioRuntimeSnapshot>;
  readonly undo: (
    request: StudioRevisionRequest,
    lease: WorkbenchMutationLease,
  ) => Promise<StudioRuntimeSnapshot>;
  readonly redo: (
    request: StudioRevisionRequest,
    lease: WorkbenchMutationLease,
  ) => Promise<StudioRuntimeSnapshot>;
  readonly captureReport: () => (message: string | null) => void;
  readonly allocateLayoutNodeId: () => string;
}

export class StudioMutationController {
  readonly #ports: StudioMutationPorts;
  #tail: Promise<void> = Promise.resolve();

  constructor(ports: StudioMutationPorts) {
    this.#ports = ports;
  }

  commit(edit: SceneEdit): Promise<boolean> {
    return this.#enqueue(`studio.${edit.kind}`, async (snapshot, lease) => {
      await this.#ports.apply({
        project_id: snapshot.project_id,
        expected_project_revision: snapshot.project_revision,
        expected_layout_revision: snapshot.scene.layout_revision,
        edit,
      }, lease);
      return true;
    });
  }

  drop(instanceId: string, target: StudioDropTarget): Promise<boolean> {
    return this.#enqueue("studio.drop", async (snapshot, lease) => {
      const next = computeStudioDrop(
        snapshot.scene,
        instanceId,
        target,
        this.#ports.allocateLayoutNodeId,
      );
      if (next == null) return false;
      await this.#ports.apply({
        project_id: snapshot.project_id,
        expected_project_revision: snapshot.project_revision,
        expected_layout_revision: snapshot.scene.layout_revision,
        edit: { kind: "replace_root", root: next.root },
      }, lease);
      return true;
    });
  }

  undo(): Promise<boolean> {
    return this.#revision("studio.undo", this.#ports.undo);
  }

  redo(): Promise<boolean> {
    return this.#revision("studio.redo", this.#ports.redo);
  }

  async settled(): Promise<void> {
    await this.#tail;
  }

  #revision(
    operationName: string,
    operation: (
      request: StudioRevisionRequest,
      lease: WorkbenchMutationLease,
    ) => Promise<StudioRuntimeSnapshot>,
  ): Promise<boolean> {
    return this.#enqueue(operationName, async (snapshot, lease) => {
      await operation({
        project_id: snapshot.project_id,
        expected_project_revision: snapshot.project_revision,
        expected_layout_revision: snapshot.scene.layout_revision,
      }, lease);
      return true;
    });
  }

  #enqueue(
    operationName: string,
    operation: (
      snapshot: StudioRuntimeSnapshot,
      lease: WorkbenchMutationLease,
    ) => Promise<boolean>,
  ): Promise<boolean> {
    const admitted = this.#ports.getStudio();
    if (admitted.status !== "ready") return Promise.resolve(false);
    const admittedProjectId = admitted.snapshot.project_id;
    const report = this.#ports.captureReport();
    return this.#ports.admit(admittedProjectId, (lease) => {
      const task = this.#tail
        .catch(() => undefined)
        .then(async () => {
          const state = this.#ports.getStudio();
          if (state.status !== "ready" || state.snapshot.project_id !== admittedProjectId) {
            return false;
          }
          report(null);
          try {
            return await workbenchOperationTrace.run(
              operationName,
              () => operation(state.snapshot, lease),
              { fallback: "Studio operation failed.", scope: "workbench" },
            );
          } catch (cause: unknown) {
            report(workbenchFailureMessage(cause, "Studio operation failed."));
            return false;
          }
        });
      this.#tail = task.then(() => undefined);
      return task;
    }).catch(() => false);
  }
}
