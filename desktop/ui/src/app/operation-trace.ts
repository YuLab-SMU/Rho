import { normalizeWorkbenchFailure } from "./workbench-failure";
import type { WorkbenchFailureContext, WorkbenchFailureKind } from "./workbench-failure";

export type WorkbenchOperationStage = "started" | "succeeded" | "failed";

export interface WorkbenchOperationTraceEntry {
  readonly operation_id: string;
  readonly operation: string;
  readonly stage: WorkbenchOperationStage;
  readonly elapsed_ms: number;
  readonly failure_kind: WorkbenchFailureKind | null;
}

interface ActiveOperation {
  readonly operationId: string;
  readonly operation: string;
  readonly startedAt: number;
}

export class WorkbenchOperationTrace {
  readonly #capacity: number;
  readonly #now: () => number;
  #sequence = 0;
  #entries: WorkbenchOperationTraceEntry[] = [];

  constructor(capacity = 64, now: () => number = () => performance.now()) {
    this.#capacity = Math.max(1, Math.trunc(capacity));
    this.#now = now;
  }

  start(operation: string): ActiveOperation {
    const active = {
      operationId: `op-${String(++this.#sequence).padStart(6, "0")}`,
      operation: operation.replace(/[^A-Za-z0-9:._-]/gu, "-").slice(0, 64) || "operation",
      startedAt: this.#now(),
    };
    this.#append(active, "started", null);
    return active;
  }

  succeed(active: ActiveOperation): void {
    this.#append(active, "succeeded", null);
  }

  fail(active: ActiveOperation, cause: unknown, context: WorkbenchFailureContext): void {
    const failure = normalizeWorkbenchFailure(cause, {
      ...context,
      operationId: active.operationId,
    });
    this.#append(active, "failed", failure.kind);
  }

  async run<T>(
    operation: string,
    work: () => Promise<T>,
    failureContext: WorkbenchFailureContext,
  ): Promise<T> {
    const active = this.start(operation);
    try {
      const result = await work();
      this.succeed(active);
      return result;
    } catch (cause) {
      this.fail(active, cause, failureContext);
      throw cause;
    }
  }

  snapshot(): readonly WorkbenchOperationTraceEntry[] {
    return this.#entries.map((entry) => ({ ...entry }));
  }

  reset(): void {
    this.#entries = [];
  }

  #append(active: ActiveOperation, stage: WorkbenchOperationStage, failureKind: WorkbenchFailureKind | null) {
    this.#entries.push({
      operation_id: active.operationId,
      operation: active.operation,
      stage,
      elapsed_ms: Math.max(0, Math.round(this.#now() - active.startedAt)),
      failure_kind: failureKind,
    });
    if (this.#entries.length > this.#capacity) this.#entries.splice(0, this.#entries.length - this.#capacity);
  }
}

export const workbenchOperationTrace = new WorkbenchOperationTrace();
