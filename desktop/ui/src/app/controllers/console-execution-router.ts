import type { SourceExecutionSubmission } from "../source-execution";
import { workbenchFailureMessage } from "../workbench-failure";

export interface ConsoleExecutionAdmission {
  readonly accepted: boolean;
  readonly message: string | null;
}

export interface ConsoleExecutionEndpoint {
  readonly instanceId: string;
  readonly submitSource: (execution: SourceExecutionSubmission) => ConsoleExecutionAdmission;
}

export interface ConsoleExecutionActivation {
  readonly epoch: number;
  readonly projectId: string;
  readonly projectRevision: number;
}

interface ConsoleExecutionWaiter {
  readonly resolve: (endpoint: ConsoleExecutionEndpoint) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class ConsoleExecutionRouter {
  readonly #timeoutMs: number;
  readonly #endpoints = new Map<string, ConsoleExecutionEndpoint>();
  readonly #waiters = new Map<string, Set<ConsoleExecutionWaiter>>();
  readonly #preparations = new Map<string, Promise<ConsoleExecutionEndpoint>>();
  #preferredInstanceId: string | null = null;
  #activation: ConsoleExecutionActivation | null = null;

  constructor(timeoutMs = 4_000) {
    this.#timeoutMs = timeoutMs;
  }

  register(endpoint: ConsoleExecutionEndpoint): () => void {
    this.#endpoints.set(endpoint.instanceId, endpoint);
    const waiters = this.#waiters.get(endpoint.instanceId);
    if (waiters != null) {
      this.#waiters.delete(endpoint.instanceId);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(endpoint);
      }
    }
    return () => {
      if (this.#endpoints.get(endpoint.instanceId) === endpoint) {
        this.#endpoints.delete(endpoint.instanceId);
      }
    };
  }

  markPreferred(instanceId: string): void {
    this.#preferredInstanceId = instanceId;
  }

  activate(activation: ConsoleExecutionActivation | null): void {
    if (activation == null) {
      this.reset();
      return;
    }
    const current = this.#activation;
    if (
      current != null
      && (
        current.epoch !== activation.epoch
        || current.projectId !== activation.projectId
        || activation.projectRevision < current.projectRevision
      )
    ) {
      this.reset();
    }
    this.#activation = activation;
  }

  waitFor(instanceId: string): Promise<ConsoleExecutionEndpoint> {
    if (this.#activation == null) {
      return Promise.reject(new Error(
        "The project changed before the R Console renderer became ready.",
      ));
    }
    const mounted = this.#endpoints.get(instanceId);
    if (mounted != null) return Promise.resolve(mounted);
    return new Promise<ConsoleExecutionEndpoint>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.#waiters.get(instanceId);
        if (waiters != null) {
          for (const waiter of waiters) {
            if (waiter.resolve === resolve) waiters.delete(waiter);
          }
          if (waiters.size === 0) this.#waiters.delete(instanceId);
        }
        reject(new Error("The R Console was placed but its renderer did not become ready."));
      }, this.#timeoutMs);
      const waiter = { resolve, reject, timer };
      const waiters = this.#waiters.get(instanceId) ?? new Set();
      waiters.add(waiter);
      this.#waiters.set(instanceId, waiters);
    });
  }

  async run(
    sourceInstanceId: string,
    execution: SourceExecutionSubmission,
    prepare: () => Promise<ConsoleExecutionEndpoint>,
    report: (message: string | null) => void,
  ): Promise<boolean> {
    const activation = this.#activation;
    if (activation == null) {
      report("The project changed before the R Console action could start.");
      return false;
    }
    const endpoints = [...this.#endpoints.values()];
    const preferred = this.#preferredInstanceId == null
      ? null
      : this.#endpoints.get(this.#preferredInstanceId) ?? null;
    let target = preferred ?? (endpoints.length === 1 ? endpoints[0] ?? null : null);
    if (target == null && endpoints.length > 1) {
      report("More than one R Console is visible. Click the Console you want to use, then run again.");
      return false;
    }
    if (target == null) {
      try {
        target = await this.#prepareOnce(sourceInstanceId, prepare);
      } catch (cause) {
        report(workbenchFailureMessage(cause, "The R Console could not be prepared."));
        return false;
      }
      if (!this.#accepts(activation)) {
        report("The project changed while the R Console was being prepared.");
        return false;
      }
    }
    if (!this.#accepts(activation)) {
      report("The project changed before the R Console could accept this code.");
      return false;
    }
    const admission = target.submitSource(execution);
    if (!admission.accepted) {
      report(admission.message ?? "The selected Console could not accept this code.");
      return false;
    }
    this.#preferredInstanceId = target.instanceId;
    report(null);
    return true;
  }

  reset(reason = "The project changed while the R Console was being prepared."): void {
    this.#activation = null;
    this.#preferredInstanceId = null;
    this.#endpoints.clear();
    this.#preparations.clear();
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(reason));
      }
    }
    this.#waiters.clear();
  }

  dispose(): void {
    this.reset("The workbench closed while the R Console was being prepared.");
  }

  #accepts(activation: ConsoleExecutionActivation): boolean {
    return this.#activation?.epoch === activation.epoch
      && this.#activation.projectId === activation.projectId
      && this.#activation.projectRevision >= activation.projectRevision;
  }

  #prepareOnce(
    sourceInstanceId: string,
    prepare: () => Promise<ConsoleExecutionEndpoint>,
  ): Promise<ConsoleExecutionEndpoint> {
    const existing = this.#preparations.get(sourceInstanceId);
    if (existing != null) return existing;
    const operation = prepare();
    this.#preparations.set(sourceInstanceId, operation);
    const clear = () => {
      if (this.#preparations.get(sourceInstanceId) === operation) {
        this.#preparations.delete(sourceInstanceId);
      }
    };
    void operation.then(clear, clear);
    return operation;
  }
}
