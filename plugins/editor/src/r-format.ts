import { isResourceReference, readResource } from '../public/plugin-ui/index.js';
import type { FormatResult } from '../public/r-protocol/index.js';
import { type Client, type Intent, type RecordReply, same, verifyOriginal } from './operations.js';
import { bytes } from './text.js';

/** Reads only a verified original formatter result. Applying it remains the
 * document owner's decision and must compare the captured document version. */
export async function readFormattedCode(client: Client, original: RecordReply, captured: Intent): Promise<FormatResult> {
  const intent = structuredClone(captured), record = await verifyOriginal(structuredClone(original), intent);
  const args = intent.arguments as any, output = record.output as any;
  if (!same(intent.capability, { id: 'r.format', version: 1 }) || !same(args?.binding?.capability, intent.capability) ||
    args?.binding?.project !== client.view.project || typeof args?.arguments?.expected_session !== 'string' ||
    args.binding.target !== args.arguments.expected_session || typeof args.arguments.code !== 'string' ||
    bytes(args.arguments.code).length > 65536 || args.arguments.code.includes('\0'))
    throw new Error('The retained formatting request does not match its original input and session.');
  if (record.status !== 'succeeded') throw new Error(record.error || 'Formatting has no confirmed successful result.');
  if (!output || output.operation_id !== record.operation.operation_id || output.session_id !== args.arguments.expected_session ||
    !same(output.source, args.arguments.source ?? null) || output.output_mode !== null || typeof output.value_in_report !== 'boolean' ||
    !isResourceReference(output.report) || !same(output.report.owner, args.binding.provider) || output.report.media_type !== 'application/json')
    throw new Error('The formatting result belongs to another request, source or session.');
  let value = output.value;
  if (output.value_in_report) {
    if (value !== null) throw new Error('The formatting result has contradictory inline and retained values.');
    const report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readResource(client, output.report)));
    if (report.session_id !== output.session_id || report.outcome !== 'succeeded' || report.error !== null)
      throw new Error('The original retained formatting report is not a successful result for this session.');
    value = report.value;
  }
  if (!value || typeof value.code !== 'string' || bytes(value.code).length > 128 * 1024 || value.code.includes('\0') ||
    typeof value.tool_version !== 'string' || !value.tool_version || bytes(value.tool_version).length > 256 ||
    typeof value.changed !== 'boolean' || value.changed !== (value.code !== args.arguments.code))
    throw new Error('The complete formatted text or its change marker is invalid. The original result is retained.');
  return { code: value.code, tool_version: value.tool_version, changed: value.changed };
}
