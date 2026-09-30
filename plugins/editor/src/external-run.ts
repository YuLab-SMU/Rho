/** A link to an ordinary Editor operation. Its original owner remains the only
 * result authority; neither a view refresh nor Inspect can replay the run. */
import type { ContextReference, InstanceRef } from '../public/plugin-protocol/index.js';
import { type Client, type RecordReply, json, same } from './operations.js';
import { validProvider } from './r-actions.js';
import { sha256 } from './text.js';

export interface ExternalRun {
  operation: string;
  reference: ContextReference;
  document_version: string;
  code_digest: string;
  runtime: InstanceRef;
  session: string;
  source: { view_id: string; label: string; kind: 'document' };
}
export interface ExternalRunObservation { parent: RecordReply; execution: RecordReply | null; code: string | null; }
const identity = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(v);
const digest = (v: unknown) => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
export function validateExternalRun(client: Client, value: unknown): asserts value is ExternalRun {
  const run = value as ExternalRun, selector = run?.reference?.selector as { draft?: string; version?: number; digest?: string };
  if (!run || !identity(run.operation) || !run.document_version || !digest(run.code_digest) || !validProvider(run.runtime) || !identity(run.session) ||
    !same(run.reference?.provider, client.view.instance) || run.reference?.window !== client.view.window || run.reference?.contribution !== 'documents' ||
    !identity(selector?.draft) || !Number.isSafeInteger(selector.version) || selector.version! < 1 || !digest(selector.digest) ||
    run.source?.view_id !== `draft:${selector.draft}` || run.source.kind !== 'document' || typeof run.source.label !== 'string' ||
    !run.source.label || new TextEncoder().encode(run.source.label).length > 512 || run.source.label.includes('\0'))
    throw Error('The retained Agent run has another document, provider or capture identity.');
}
export async function inspectExternalRun(client: Client, capture: ExternalRun): Promise<ExternalRunObservation> {
  validateExternalRun(client, capture);
  const capability = { id: 'editor.run.inspect', version: 1 };
  const observed = await client.query<{ status: string; completeness?: string; data?: { parent: RecordReply; execution: RecordReply | null } }>(capability,
    json({ binding: { provider: capture.reference.provider, project: client.view.project, capability, target: null }, arguments: { operation: capture.operation }, preconditions: null }));
  if (observed.status !== 'ready' || observed.completeness && observed.completeness !== 'complete' || !observed.data)
    throw Error('The original Agent run observation is incomplete. Its request is retained.');
  const { parent, execution } = observed.data;
  const original = parent?.operation.normalized_arguments as any;
  if (parent?.operation.operation_id !== capture.operation || !same(parent.operation.capability, { id: 'editor.run', version: 1 }) ||
    !same(original?.binding.provider, capture.reference.provider) || original?.binding.project !== client.view.project ||
    !same(original?.arguments.reference, capture.reference) || !same(original?.arguments.runtime, capture.runtime) || original?.arguments.expected_session !== capture.session)
    throw Error('The observed parent differs from the captured Agent run.');
  if (!execution) return { parent, execution: null, code: null };
  const child = execution.operation as typeof execution.operation & { causation_id?: string }, args = child.normalized_arguments as any;
  if (child.causation_id !== capture.operation || child.caller.kind !== 'plugin' || child.caller.id !== capture.reference.provider.instance ||
    !same(child.capability, { id: 'r.execute', version: 2 }) || !same(args?.binding.provider, capture.runtime) || args?.binding.project !== client.view.project ||
    args?.binding.target !== capture.session || args?.arguments.expected_session !== capture.session || args?.arguments.run.output_mode !== 'console' ||
    !same(args?.arguments.run.source, capture.source) || typeof args?.arguments.run.code !== 'string' || await sha256(args.arguments.run.code) !== capture.code_digest)
    throw Error('The native execution differs from the captured document, code, R provider or session.');
  if (execution.status === 'succeeded') {
    const output = execution.output as any;
    if (output?.operation_id !== child.operation_id || output.session_id !== capture.session || !same(output.source, capture.source) || output.output_mode !== 'console')
      throw Error('The native result differs from the original captured execution.');
  }
  // The parent's uncertainty is retained even when this child now has evidence.
  return { parent, execution, code: args.arguments.run.code };
}
