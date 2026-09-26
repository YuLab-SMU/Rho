/** Original-operation inspection for this document owner. No speculative replay. */
import type { JsonValue, CapabilityKey } from '../public/plugin-protocol/index.js';
import { operationRequestId, type PluginViewClient } from '../public/plugin-ui/index.js';
export type Client = Pick<PluginViewClient, 'view' | 'query' | 'control' | 'invoke' | 'operation' | 'setState'>;
export interface Intent { view: string; request: string; capability: CapabilityKey; arguments: JsonValue; operation: string | null; }
export interface RecordReply {
  operation: { operation_id: string; caller: { kind: string; id: string }; client_request_id: string;
    capability: CapabilityKey; normalized_arguments: JsonValue; preconditions: JsonValue[] };
  status: string; outcome: string | null; output: unknown; error: string | null;
}
export const json = (value: unknown) => value as JsonValue;
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
export const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
export const terminal = (status: string) => ['succeeded', 'failed', 'cancelled', 'uncertain'].includes(status);
export async function verifyOriginal(value: unknown, intent: Intent): Promise<RecordReply> {
  const record = value as RecordReply, operation = record?.operation;
  if (!operation || typeof operation.operation_id !== 'string' || !operation.operation_id ||
    intent.operation !== null && operation.operation_id !== intent.operation || operation.caller?.kind !== 'plugin' || operation.caller.id !== intent.view ||
    operation.client_request_id !== await operationRequestId(intent.view, intent.request) || !same(operation.capability, intent.capability) ||
    !same(operation.normalized_arguments, intent.arguments) || !same(operation.preconditions, []) ||
    !['accepted', 'running', 'reconciling', 'succeeded', 'failed', 'cancelled', 'uncertain'].includes(record.status) ||
    (terminal(record.status) ? record.outcome !== record.status : record.outcome !== null))
    throw new Error('The result does not match the original document request.');
  return record;
}
export async function inspectOriginal(client: Client, intent: Intent): Promise<RecordReply> {
  const frozen = structuredClone(intent);
  if (frozen.operation) {
    if (frozen.view === client.view.view) return verifyOriginal(await client.operation(frozen.operation), frozen);
    const reply = await client.query<{ status: string; data?: { record?: unknown } }>({ id: 'operation.get', version: 1 }, { operation_id: frozen.operation });
    if (reply.status !== 'ready' || !reply.data?.record) throw new Error('The original document Operation is unavailable.');
    return verifyOriginal(reply.data.record, frozen);
  }
  const page = await client.query<{ status: string; data?: { operations?: { operation_id: string }[] } }>({ id: 'operation.list_recent', version: 1 },
    { client_request_id: await operationRequestId(frozen.view, frozen.request), limit: 10 });
  if (page.status !== 'ready' || !Array.isArray(page.data?.operations) || page.data.operations.length !== 1)
    throw new Error('No unique original Operation was found. The saved request remains unconfirmed.');
  return inspectOriginal(client, { ...frozen, operation: page.data.operations[0]!.operation_id });
}
