/** The native path is distinct from the protocol's opaque project identity.
 * Epoch fences view reads; it is not a scientific revision. */
export interface ResourceIdentity {
  readonly epoch: number;
  readonly project: string | null;
  readonly connected: boolean;
  readonly capabilities: readonly string[];
}
export interface Observation<T = unknown> {
  status: string;
  data?: T | null;
  notices: string[];
}
export interface OperationChange { epoch: number; project: string; capability: string; status: string; }
export interface FileSaved { epoch: number; project: string; path: string; }
export interface ResourcePorts {
  context(): ResourceIdentity;
  query(project: string, capability: string, args: unknown): Promise<Observation>;
  schedule(): void;
  changed(): void;
}
