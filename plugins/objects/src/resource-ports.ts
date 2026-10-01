import type { RInspection } from "../public/r-protocol/index.js";

/** Local view-request generation fences asynchronous reads, never scientific truth. */
export interface ResourceIdentity {
  readonly epoch: number;
  readonly project: string | null;
  readonly session: string | null;
  readonly runtimeState: string | null;
  readonly connected: boolean;
  readonly capabilities: readonly string[];
}
export interface ObjectSelection {
  name: string;
  object_ref: string;
  native_session_id: string;
}
/** The connection must first verify the original provider and native session. */
export interface OperationChange {
  epoch: number;
  project: string;
  session: string;
  operationId: string;
  capability: string;
  status: string;
  cursor: number;
}
export interface ResourcePorts {
  context(): ResourceIdentity;
  query(project: string, capability: string, args: unknown): Promise<RInspection<unknown>>;
  schedule(): void;
  changed(): void;
}
