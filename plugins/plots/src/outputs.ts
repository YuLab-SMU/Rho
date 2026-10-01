/** Native R output interpretation is owned by the ordinary Plots package. */
import type { InstanceRef, JsonValue } from "../public/plugin-protocol/index.js";
import type { MediaReference, RunSource } from "../public/r-protocol/index.js";
import { isResourceReference, type ResourceReader, type ResourceReference } from "../public/plugin-ui/index.js";
export interface SavedPlot {
  operation: string; status: string; session: string; accepted: number;
  native: MediaReference; reference: ResourceReference; inputSource: RunSource | null;
}
export interface PlotSelection { operation_id: string; resource_id: string; }
export const sameOwner = (a: InstanceRef, b: InstanceRef) => a.instance === b.instance && a.plugin === b.plugin && a.revision === b.revision && a.artifact === b.artifact;
const object = (value: unknown): Record<string, any> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
const imageTypes = new Set(["image/png", "image/jpeg", "image/svg+xml"]);
export const terminal = (status: unknown) => ["succeeded", "failed", "cancelled", "uncertain"].includes(String(status));
export const rExecution = (capability: any) => capability?.id === "r.execute" && [1, 2].includes(capability.version);
export const key = (plot: SavedPlot) => `${plot.operation}:${plot.reference.resource}`;
export const matches = (plot: SavedPlot, selection: PlotSelection) => plot.operation === selection.operation_id && plot.reference.resource === selection.resource_id;
export function plotsFrom(value: unknown, source: InstanceRef): SavedPlot[] {
  const record=object(value), operation=object(record?.operation), output=object(record?.output), binding=object(operation?.normalized_arguments)?.binding;
  if (!operation || !rExecution(operation.capability) || !binding?.provider || !sameOwner(binding.provider, source)) return [];
  if (!terminal(record!.status) || !output) return [];
  if (output.operation_id !== operation.operation_id || typeof operation.operation_id !== "string" || !Number.isSafeInteger(operation.accepted_at_ms) || operation.accepted_at_ms < 0)
    throw new Error("Saved plot differs from its original R Operation.");
  if (record!.status === "cancelled" && output.started === false && Object.keys(output).length === 2) return [];
  if (!Array.isArray(output.outputs) || typeof output.session_id !== "string" || !output.session_id ||
      typeof binding.target === "string" && binding.target !== output.session_id)
    throw new Error("Saved plot differs from its original native R session.");
  let inputSource: RunSource | null = null;
  if (operation.capability.version === 2) {
    const expected = object(object(operation.normalized_arguments)?.arguments)?.run?.source ?? null, actual = output.source ?? null;
    if (expected === null ? actual !== null : !actual || ["view_id", "label", "kind"].some(field => typeof actual[field] !== "string" || actual[field] !== expected[field]))
      throw new Error("Saved plot source differs from the original R input.");
    inputSource = actual === null ? null : { view_id: actual.view_id, label: actual.label, kind: actual.kind };
  }
  const results: SavedPlot[] = [], resources=new Set<string>(), sequences=new Set<number>();
  for (const item of output.outputs) {
    if (!imageTypes.has(item?.reference?.media_type)) continue;
    const reference=item.reference, native=object(item.native);
    if (!isResourceReference(reference) || !sameOwner(reference.owner, source) || !native || native.operation_id !== operation.operation_id ||
        native.mime_type !== reference.media_type || native.byte_size !== reference.bytes || native.sha256 !== reference.digest ||
        !Number.isSafeInteger(native.sequence) || native.sequence <= 0 || !(native.display_id === null || typeof native.display_id === "string") ||
        resources.has(reference.resource) || sequences.has(native.sequence))
      throw new Error("Saved plot has an inconsistent output or resource identity.");
    resources.add(reference.resource); sequences.add(native.sequence);
    results.push({ operation: operation.operation_id, status: record!.status, session: output.session_id, accepted: operation.accepted_at_ms,
      native: structuredClone(native) as MediaReference, reference: structuredClone(reference), inputSource });
  }
  return results;
}
export async function readOperation(reader: ResourceReader, source: InstanceRef, id: string): Promise<SavedPlot[]> {
  const result=await reader.query<{data?:{record?:unknown}}>({id:"operation.get",version:1},{operation_id:id});
  const record=object(result.data?.record);
  if (!record || record.operation?.operation_id !== id) throw new Error("The original plot Operation is unavailable in this project.");
  return plotsFrom(record,source);
}
export async function readHistory(reader: ResourceReader, source: InstanceRef, before: number | null) {
  const result=await reader.query<{data?:{operations:any[];next_cursor:number|null}}>({id:"operation.list_recent",version:1},{limit:25,before_cursor:before} as JsonValue);
  if (!result.data || !Array.isArray(result.data.operations) || result.data.operations.length > 25 ||
      !(result.data.next_cursor === null || Number.isSafeInteger(result.data.next_cursor) && result.data.next_cursor >= 0 && (before === null || result.data.next_cursor < before)))
    throw new Error("Plot history is unavailable or its continuation is invalid.");
  const plots: SavedPlot[] = [];
  for (const operation of result.data.operations) if (rExecution(operation.capability) && terminal(operation.status))
    plots.push(...await readOperation(reader,source,operation.operation_id));
  return { plots, next: result.data.next_cursor, operations: result.data.operations.map(operation=>operation.operation_id as string) };
}
export function mergeHistory(existing: readonly SavedPlot[], incoming: readonly SavedPlot[], selected: PlotSelection | null, older: boolean): SavedPlot[] {
  const all=new Map(existing.map(plot=>[key(plot),plot]));
  for (const plot of incoming) all.set(key(plot),plot);
  const order=(a:SavedPlot,b:SavedPlot)=>a.accepted-b.accepted || a.native.sequence-b.native.sequence || key(a).localeCompare(key(b));
  const sorted=[...all.values()].sort(order), anchors=sorted.filter((plot,i)=>i===sorted.length-1 || selected && matches(plot,selected));
  const remaining=sorted.filter(plot=>!anchors.includes(plot)), capacity=200-anchors.length;
  return [...anchors,...(older?remaining.slice(0,capacity):remaining.slice(-capacity))].sort(order);
}
