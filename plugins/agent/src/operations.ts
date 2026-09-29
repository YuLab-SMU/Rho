import type { CapabilityKey, JsonValue } from '../public/plugin-protocol/index.js';
import { operationRequestId, type PluginViewClient } from '../public/plugin-ui/index.js';

export type Client = Pick<PluginViewClient, 'view' | 'query' | 'control' | 'invoke' | 'operation' | 'setState'>;
export const json = (value: unknown) => value as JsonValue;
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
export const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export const terminal = (status: string) => ['succeeded', 'failed', 'cancelled', 'uncertain'].includes(status);
export interface Intent {
  view: string; request: string; capability: CapabilityKey; arguments: JsonValue; operation: string | null;
}
export interface RecordReply {
  operation: { operation_id: string; caller: { kind: string; id: string }; client_request_id: string;
    capability: CapabilityKey; normalized_arguments: JsonValue; preconditions: JsonValue[] };
  status: string; outcome: string | null; output: unknown; error: string | null;
}
export async function verifyOriginal(value: unknown, intent: Intent): Promise<RecordReply> {
  const record = value as RecordReply, operation = record?.operation;
  if (!operation || typeof operation.operation_id !== 'string' || !operation.operation_id ||
    intent.operation !== null && operation.operation_id !== intent.operation || operation.caller?.kind !== 'plugin' || operation.caller.id !== intent.view ||
    operation.client_request_id !== await operationRequestId(intent.view, intent.request) || !same(operation.capability, intent.capability) ||
    !same(operation.normalized_arguments, intent.arguments) || !same(operation.preconditions, []) ||
    !['accepted', 'running', 'reconciling', 'succeeded', 'failed', 'cancelled', 'uncertain'].includes(record.status) ||
    (terminal(record.status) ? record.outcome !== record.status : record.outcome !== null))
    throw new Error('The result does not match the original Agent request.');
  return record;
}
export async function inspectOriginal(client: Client, intent: Intent): Promise<RecordReply> {
  const frozen = structuredClone(intent);
  if (frozen.view !== client.view.view) throw Error('This request belongs to another Agent view.');
  if (frozen.operation) return verifyOriginal(await client.operation(frozen.operation), frozen);
  const page = await client.query<{ status: string; data?: { operations?: { operation_id: string }[] } }>({ id: 'operation.list_recent', version: 1 },
    { client_request_id: await operationRequestId(frozen.view, frozen.request), limit: 10 });
  if (page.status !== 'ready' || !Array.isArray(page.data?.operations) || page.data.operations.length !== 1)
    throw Error('The original request is not yet observable. It remains unconfirmed.');
  return inspectOriginal(client, { ...frozen, operation: page.data.operations[0]!.operation_id });
}
