/** Public original-operation inspection for ordinary plugins. No speculative replay. */
import type { JsonValue, CapabilityKey } from '../plugin-protocol/index.js';
import type { PluginViewClient } from './index.js';
import { operationRequestId } from './operation-identity.js';
type Client = Pick<PluginViewClient, 'view' | 'query' | 'operation'>;
export interface OperationIntent { view: string; request: string; capability: CapabilityKey; arguments: JsonValue; operation: string | null; preconditions?: JsonValue[]; }
export interface OriginalOperationRecord {
  operation: { operation_id: string; caller: { kind: string; id: string }; client_request_id: string;
    capability: CapabilityKey; normalized_arguments: JsonValue; preconditions: JsonValue[] };
  status: string; outcome: string | null; output: unknown; error: string | null;
}
export const canonicalOperationValue = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
export const sameOperationValue = (left: unknown, right: unknown) => canonicalOperationValue(left) === canonicalOperationValue(right);
export const isTerminalOperation = (status: string) => ['succeeded', 'failed', 'cancelled', 'uncertain'].includes(status);
export async function verifyOriginalOperation(value: unknown, original: OperationIntent): Promise<OriginalOperationRecord> {
  const intent = structuredClone(original), record = structuredClone(value) as OriginalOperationRecord, operation = record?.operation;
  if (!operation || typeof operation.operation_id !== 'string' || !operation.operation_id ||
    intent.operation !== null && operation.operation_id !== intent.operation || operation.caller?.kind !== 'plugin' || operation.caller.id !== intent.view ||
    operation.client_request_id !== await operationRequestId(intent.view, intent.request) || !sameOperationValue(operation.capability, intent.capability) ||
    !sameOperationValue(operation.normalized_arguments, intent.arguments) || !sameOperationValue(operation.preconditions, intent.preconditions ?? []) ||
    !['accepted', 'running', 'reconciling', 'succeeded', 'failed', 'cancelled', 'uncertain'].includes(record.status) ||
    (isTerminalOperation(record.status) ? record.outcome !== record.status : record.outcome !== null))
    throw new Error('The result does not match the original plugin request.');
  return record;
}
export async function inspectOriginalOperation(client: Pick<Client, 'view' | 'query' | 'operation'>, intent: OperationIntent): Promise<OriginalOperationRecord> {
  const frozen = structuredClone(intent);
  if (frozen.operation) {
    if (frozen.view === client.view.view) return verifyOriginalOperation(await client.operation(frozen.operation), frozen);
    const reply = await client.query<{ status: string; data?: { record?: unknown } }>({ id: 'operation.get', version: 1 }, { operation_id: frozen.operation });
    if (reply.status !== 'ready' || !reply.data?.record) throw new Error('The original plugin Operation is unavailable.');
    return verifyOriginalOperation(reply.data.record, frozen);
  }
  const page = await client.query<{ status: string; data?: { operations?: { operation_id: string }[] } }>({ id: 'operation.list_recent', version: 1 },
    { client_request_id: await operationRequestId(frozen.view, frozen.request), limit: 10 });
  if (page.status !== 'ready' || !Array.isArray(page.data?.operations) || page.data.operations.length !== 1)
    throw new Error('No unique original Operation was found. The saved request remains unconfirmed.');
  return inspectOriginalOperation(client, { ...frozen, operation: page.data.operations[0]!.operation_id });
}
