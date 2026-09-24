/** R output semantics belong to this package, not the view container. */
import type { InstanceRef, JsonValue } from "../public/plugin-protocol/index.js";
import type { RunSource } from "../public/r-protocol/index.js";
import { isResourceReference, type ResourceReader, type ResourceReference } from "../public/plugin-ui/index.js";
export interface SavedOutput {
  operation: string; sequence: number; status: string; session: string;
  accepted: number; reference: ResourceReference;
  inputSource: RunSource | null;
}
export type Selection = { operation_id: string; resource_id: string; };
export function sameOwner(a: InstanceRef, b: InstanceRef): boolean {
  return a.instance === b.instance && a.plugin === b.plugin && a.revision === b.revision && a.artifact === b.artifact;
}
function object(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}
function isRExecution(capability: { id?: unknown; version?: unknown } | undefined): boolean {
  return capability?.id === "r.execute" && (capability.version === 1 || capability.version === 2);
}
export function outputsFrom(value: unknown, source: InstanceRef): SavedOutput[] {
  const record = object(value), operation = object(record?.operation), output = object(record?.output);
  const provider = object(operation?.normalized_arguments)?.binding?.provider;
  if (!operation || !isRExecution(operation.capability) || !provider || !sameOwner(provider, source)) return [];
  if (!["succeeded", "failed", "cancelled", "uncertain"].includes(record!.status) || !output) return [];
  if (output.operation_id !== operation.operation_id) throw new Error("Saved output differs from its original R operation");
  if (record!.status === "cancelled" && output.started === false && Object.keys(output).length === 2) return [];
  if (!Array.isArray(output.outputs)) throw new Error("Saved output differs from its original R operation");
  let inputSource: RunSource | null = null;
  if (operation.capability.version === 2) {
    const expected = object(object(operation.normalized_arguments)?.arguments)?.run?.source ?? null;
    const actual = output.source ?? null;
    if (expected === null ? actual !== null : !actual || ["view_id", "label", "kind"].some(field => typeof actual[field] !== "string" || actual[field] !== expected[field]))
      throw new Error("Saved output source differs from its original R input");
    inputSource = actual === null ? null : { view_id: actual.view_id, label: actual.label, kind: actual.kind };
  }
  const results: SavedOutput[] = [];
  for (const item of output.outputs) {
    if (item?.reference?.media_type !== "text/html") continue;
    const ref = item.reference, native = object(item.native);
    if (!isResourceReference(ref) || !sameOwner(ref.owner, source) || !native || native.operation_id !== operation.operation_id ||
      native.mime_type !== "text/html" || native.byte_size !== ref.bytes || native.sha256 !== ref.digest ||
      !Number.isSafeInteger(native.sequence) || native.sequence < 0 || typeof output.session_id !== "string")
      throw new Error("Saved HTML has an inconsistent producing operation or resource identity");
    results.push({ operation: operation.operation_id, sequence: native.sequence, status: record!.status,
      session: output.session_id, accepted: operation.accepted_at_ms, reference: structuredClone(ref), inputSource });
  }
  return results;
}
export function key(output: SavedOutput): string { return `${output.operation}:${output.reference.resource}`; }
export function matches(output: SavedOutput, selection: Selection): boolean {
  return output.operation === selection.operation_id && output.reference.resource === selection.resource_id;
}
export function mergeHistory(existing: SavedOutput[], incoming: SavedOutput[], selected: Selection | null, older: boolean): SavedOutput[] {
  const all = new Map(existing.map(output => [key(output), output]));
  for (const output of incoming) all.set(key(output), output);
  const order = (a: SavedOutput, b: SavedOutput) => b.accepted - a.accepted || b.sequence - a.sequence;
  const sorted = Array.from(all.values()).sort(order);
  // Paging earlier must not redefine Latest or discard an explicitly selected run.
  const anchors = sorted.filter((output, index) => index === 0 || (selected !== null && matches(output, selected)));
  const remaining = sorted.filter(output => !anchors.includes(output)), capacity = 200 - anchors.length;
  return [...anchors, ...(older ? remaining.slice(-capacity) : remaining.slice(0, capacity))].sort(order);
}
export async function readOperation(reader: ResourceReader, source: InstanceRef, id: string): Promise<SavedOutput[]> {
  const result = await reader.query<{ data?: { record?: unknown } }>({ id: "operation.get", version: 1 }, { operation_id: id });
  if (!result.data?.record) throw new Error("The original operation is unavailable in this project");
  return outputsFrom(result.data.record, source);
}
export async function readHistory(reader: ResourceReader, source: InstanceRef, before: number | null) {
  const result = await reader.query<{ data?: { operations: { operation_id: string; capability: { id: string; version: number }; status: string }[]; next_cursor: number | null } }>(
    { id: "operation.list_recent", version: 1 }, { limit: 25, before_cursor: before } as JsonValue);
  if (!result.data || !Array.isArray(result.data.operations)) throw new Error("Operation history is unavailable");
  const items: SavedOutput[] = [];
  for (const operation of result.data.operations) {
    if (isRExecution(operation.capability) && ["succeeded", "failed", "cancelled", "uncertain"].includes(operation.status))
      items.push(...await readOperation(reader, source, operation.operation_id));
  }
  return { items, next: result.data.next_cursor };
}
