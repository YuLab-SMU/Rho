import type { MediaReference } from "../generated/MediaReference";

export interface OperationChange {
  epoch: number; project: string; operationId: string; capability: string;
  status: string; cursor: number | null;
}
export interface DomainEvents {
  projectChanged: { epoch: number; project: string | null };
  sessionChanged: { epoch: number; project: string | null; session: string | null };
  operationChanged: OperationChange;
  outputAppended: { epoch: number; project: string; operationId: string; media?: readonly MediaReference[] };
  fileSaved: { epoch: number; project: string; path: string; hash: string };
  viewsChanged: { activeViewIds: readonly string[] };
}

/** Typed domain facts; subscribers query their own owner and publish their own UI. */
export class Notifications {
  private handlers = new Map<keyof DomainEvents, Set<(event: never) => void>>();
  on<K extends keyof DomainEvents>(kind: K, listener: (event: DomainEvents[K]) => void) {
    let handlers = this.handlers.get(kind);
    if (!handlers) this.handlers.set(kind, handlers = new Set());
    handlers.add(listener as (event: never) => void);
    return () => { handlers.delete(listener as (event: never) => void); };
  }
  send<K extends keyof DomainEvents>(kind: K, event: DomainEvents[K]) {
    for (const listener of [...this.handlers.get(kind) ?? []]) listener(event as never);
  }
  dispose() { this.handlers.clear(); }
}
