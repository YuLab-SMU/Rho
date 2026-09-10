import type { QuerySnapshot } from "./generated/QuerySnapshot";
import type { OperationRecord } from "./generated/OperationRecord";
import type { Precondition } from "./generated/Precondition";
import type { RunSource } from "./generated/RunSource";

export type { RequestContext as ResourceIdentity } from "./shared/ports";
import type { RequestContext as ResourceIdentity } from "./shared/ports";
import type { RuntimeTarget } from "./shared/ports";
export interface ResourcePorts {
  context(): ResourceIdentity;
  query(project: string, capability: string, args?: unknown): Promise<QuerySnapshot>;
  schedule(): void;
  changed(): void;
}
export interface DocumentPorts extends ResourcePorts {
  canRun(): boolean;
  queueing(): boolean;
  invoke(capability: string, args: unknown, preconditions?: Precondition[]): Promise<OperationRecord>;
  run(code: string, source: RunSource, target?: RuntimeTarget): Promise<OperationRecord>;
  captureTarget?(): RuntimeTarget;
  openDocument(id: string, name: string): void;
  renameDocument(id: string, name: string): void;
  closeDocument(id: string): void;
  closeVersion(): number;
  fileSaved(project: string, path: string, sha256: string): void;
  reportError(error: string): void;
}
