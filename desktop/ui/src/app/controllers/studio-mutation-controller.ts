import type {
  SceneEdit,
  SceneEditRequest,
  StudioRevisionRequest,
  StudioRuntimeSnapshot,
} from "../../transport";
import type { StudioStoreSnapshot } from "../../transport/store";
import { computeStudioDrop } from "../../transport/studio-model";
import type { StudioDropTarget } from "../../transport/studio-model";
import { workbenchFailureMessage } from "../workbench-failure";
import { workbenchOperationTrace } from "../operation-trace";

export interface StudioMutationPorts {
  readonly getStudio: () => StudioStoreSnapshot;
  readonly apply: (request: SceneEditRequest) => Promise<StudioRuntimeSnapshot>;
  readonly undo: (request: StudioRevisionRequest) => Promise<StudioRuntimeSnapshot>;
  readonly redo: (request: StudioRevisionRequest) => Promise<StudioRuntimeSnapshot>;
  readonly report: (message: string | null) => void;
  readonly allocateLayoutNodeId: () => string;
}

export class StudioMutationController {
  readonly #ports: StudioMutationPorts;
  #tail: Promise<void> = Promise.resolve();

  constructor(ports: StudioMutationPorts) {
    this.#ports = ports;
  }

  commit(edit: SceneEdit): Promise<boolean> {
    return this.#enqueue(`studio.${edit.kind}`, async (snapshot) => {
      await this.#ports.apply({
        project_id: snapshot.project_id,
        expected_project_revision: snapshot.project_revision,
        expected_layout_revision: snapshot.scene.layout_revision,
        edit,
      });
      return true;
    });
  }

  drop(instanceId: string, target: StudioDropTarget): Promise<boolean> {
    return this.#enqueue("studio.drop", async (snapshot) => {
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
      });
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
    operation: (request: StudioRevisionRequest) => Promise<StudioRuntimeSnapshot>,
  ): Promise<boolean> {
    return this.#enqueue(operationName, async (snapshot) => {
      await operation({
        project_id: snapshot.project_id,
        expected_project_revision: snapshot.project_revision,
        expected_layout_revision: snapshot.scene.layout_revision,
      });
      return true;
    });
  }

  #enqueue(
    operationName: string,
    operation: (snapshot: StudioRuntimeSnapshot) => Promise<boolean>,
  ): Promise<boolean> {
    const task = this.#tail
      .catch(() => undefined)
      .then(async () => {
        const state = this.#ports.getStudio();
        if (state.status !== "ready") return false;
        this.#ports.report(null);
        try {
          return await workbenchOperationTrace.run(
            operationName,
            () => operation(state.snapshot),
            { fallback: "Studio operation failed.", scope: "workbench" },
          );
        } catch (cause: unknown) {
          this.#ports.report(workbenchFailureMessage(cause, "Studio operation failed."));
          return false;
        }
      });
    this.#tail = task.then(() => undefined);
    return task;
  }
}
