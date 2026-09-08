import type { QuerySnapshot } from "../generated/QuerySnapshot";
import type { OperationRecord } from "../generated/OperationRecord";
import type { OperationSummary } from "../generated/OperationSummary";
import type { RecentOperations } from "../generated/RecentOperations";
import type { RunSource } from "../generated/RunSource";
import type { Precondition } from "../generated/Precondition";
import type { JsonValue } from "../generated/serde_json/JsonValue";

/** epoch fences browser work only; it is never a scientific revision. */
export interface RequestContext {
  readonly epoch: number;
  readonly project: string | null;
  readonly session: string | null;
  readonly runtimeState: string | null;
  readonly connected: boolean;
  readonly ready?: boolean;
  readonly capabilities: readonly string[];
}
export type QueryPort = (project: string, id: string, args?: unknown) => Promise<QuerySnapshot>;
export function sameScope(before: RequestContext, now: RequestContext, native = false) {
  return before.epoch === now.epoch && before.project === now.project &&
    (!native || before.session === now.session);
}
export interface OperationReadPort {
  getRecord(id: string): OperationRecord | undefined;
  getSummary(id: string): OperationSummary | undefined;
  ensureOperation(id: string): Promise<OperationRecord | null>;
  listRecent(before: number | null, limit?: number): Promise<RecentOperations>;
  records(): ReadonlyMap<string, OperationRecord>;
  summaries(): ReadonlyMap<string, OperationSummary>;
}
export interface OperationCommands {
  invoke(id: string, args: unknown, preconditions?: Precondition[]): Promise<OperationRecord>;
  run(code: string, source?: RunSource): Promise<OperationRecord>;
}
export interface PersistenceFragment {
  serialize(): Record<string, unknown>;
  restore(value: unknown): void;
}
export const terminal = (status: string) =>
  ["succeeded", "failed", "cancelled", "uncertain"].includes(status);
export const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
