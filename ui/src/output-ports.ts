import type { MediaReference } from "./generated/MediaReference";
import type { OperationRecord } from "./generated/OperationRecord";
import type { OutputEvent } from "./generated/OutputEvent";
import type { OperationReadPort, QueryPort, RequestContext } from "./shared/ports";
import type { DomainEvents } from "./shared/events";

export const mediaKey = (reference: MediaReference) =>
  `${reference.operation_id}:${reference.sequence}:${reference.sha256}`;
export const sameMediaReference = (a: MediaReference, b: MediaReference) =>
  a.operation_id === b.operation_id && a.sequence === b.sequence && a.mime_type === b.mime_type &&
  a.byte_size === b.byte_size && a.sha256 === b.sha256 && a.display_id === b.display_id;
export function validMediaReference(value: unknown): value is MediaReference {
  const ref = value as MediaReference | null;
  return !!ref && typeof ref.operation_id === "string" && Number.isSafeInteger(ref.sequence) && ref.sequence > 0 &&
    typeof ref.mime_type === "string" && Number.isSafeInteger(ref.byte_size) && ref.byte_size >= 0 &&
    typeof ref.sha256 === "string" && /^sha256:[a-f0-9]{64}$/i.test(ref.sha256) &&
    (ref.display_id === null || typeof ref.display_id === "string");
}

export interface OutputSnapshot {
  readonly events: ReadonlyMap<string, readonly OutputEvent[]>;
  readonly notices: ReadonlyMap<string, string>;
  readonly errors: ReadonlyMap<string, string>;
  readonly cursors: ReadonlyMap<string, number>;
  readonly completed: ReadonlySet<string>;
  readonly media: readonly MediaReference[];
  /** Retained text/html outputs in the same authoritative order as `media`. */
  readonly html: readonly MediaReference[];
  readonly times: ReadonlyMap<string, number>;
  readonly records: ReadonlyMap<string, OperationRecord>;
  readonly historyLoading: boolean;
  readonly historyError: string;
}
export interface OutputReadPort {
  getSnapshot(): Readonly<OutputSnapshot>;
  subscribe(listener: () => void): () => void;
}
export interface OutputsDependencies {
  context(): RequestContext;
  query: QueryPort;
  operations: OperationReadPort;
  schedule?(): void;
  appended?(event: DomainEvents["outputAppended"]): void;
  now?(): number;
}
export interface MediaAdapter {
  sha256(bytes: Uint8Array): Promise<string>;
  createUrl(bytes: Uint8Array, mimeType: string): string;
  revokeUrl(url: string): void;
}
export interface MediaCacheDependencies {
  context(): RequestContext;
  query: QueryPort;
  adapter: MediaAdapter;
  schedule?(): void;
  now?(): number;
  budgetBytes?: number;
}
export interface PlotsDependencies {
  outputs: OutputReadPort;
  changed?(): void;
  openPlot?(id: string, name: string): void;
  showPlots?(): void;
  newId?(): string;
}
