import type { InstanceRef } from '../public/plugin-protocol/index.js';
import type { FormatResult } from '../public/r-protocol/index.js';
import type { EditorDocument } from './document.js';
import { type Client, type Intent, json, same } from './operations.js';
import { bytes, validatePath } from './text.js';

export type CodeActionKind = 'document' | 'selection' | 'line' | 'format' | 'file';
export interface CodeAction {
  intent: Intent;
  kind: CodeActionKind;
  version: string;
  path: string | null;
  text: string;
  from: number;
  to: number;
  status: string | null;
  error: string | null;
  formatted: FormatResult | null;
  applied: boolean;
}
function label(path: string | null) {
  const name = path?.split('/').at(-1) ?? 'Untitled.R';
  let result = '';
  for (const char of name) { if (bytes(result + char).length > 508) return result + '…'; result += char; }
  return result;
}
export function validProvider(value: unknown): value is InstanceRef {
  const owner = value as InstanceRef;
  return !!owner && [owner.instance, owner.plugin].every(value => typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(value)) &&
    [owner.revision, owner.artifact].every(value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value));
}
/** An optional exact native R owner. Observing it never creates a session. */
export class EditorCodeActions {
  private selected: InstanceRef | null;
  constructor(private readonly client: Client, source: InstanceRef | null = null) {
    if (source !== null && !validProvider(source)) throw new Error('Select an exact R provider for Editor code actions.');
    this.selected = source && structuredClone(source);
  }
  get source() { return this.selected && structuredClone(this.selected); }
  select(source: InstanceRef | null) {
    if (source !== null && !validProvider(source)) throw new Error('Select an exact R provider for Editor code actions.');
    this.selected = source && structuredClone(source);
  }
  async prepare(document: Pick<EditorDocument, 'snapshot' | 'state'>, requested: 'document' | 'selection' | 'format' | 'file'): Promise<CodeAction> {
    const provider = this.source;
    if (!provider) throw new Error('No R provider is configured for this Editor.');
    const capture = document.snapshot, text = document.state.doc.toString(), selection = document.state.selection.main;
    if (capture.readonly !== null || capture.path !== null && !/\.[rR]$/.test(capture.path)) throw new Error('Select an editable R document.');
    let kind: CodeActionKind = requested, from = 0, to = text.length;
    if (requested === 'selection') {
      if (!selection.empty) { from = selection.from; to = selection.to; }
      else { const line = document.state.doc.lineAt(selection.head); from = line.from; to = line.to; kind = 'line'; }
    }
    const code = text.slice(from, to), limit = kind === 'format' ? 65536 : 262144;
    if (bytes(code).length > limit || code.includes('\0') || kind !== 'format' && !code.trim())
      throw new Error(kind === 'format' ? 'Formatting accepts at most 64 KiB of UTF-8 text.' : 'Running accepts nonempty text up to 256 KiB of UTF-8. Select a smaller range.');
    const observed = await this.client.query<{ status: string; data?: { session_id?: unknown } }>({ id: 'r.session', version: 1 },
      json({ binding: { capability: { id: 'r.session', version: 1 }, provider, project: this.client.view.project, target: null }, arguments: {} }));
    const session = observed.data?.session_id;
    if (observed.status !== 'ready' || typeof session !== 'string' || !session || bytes(session).length > 160 || session.includes('\0'))
      throw new Error('Start the selected R session in Console before using Editor code actions.');
    const capability = { id: kind === 'format' ? 'r.format' : 'r.execute', version: kind === 'format' ? 1 : 2 };
    const source = { view_id: this.client.view.view, label: label(capture.path), kind };
    const arguments_ = kind === 'format' ? { expected_session: session, code, source } : { expected_session: session, run: { code, source, output_mode: 'console' } };
    return { kind, version: capture.version, path: capture.path, text, from, to, status: null, error: null, formatted: null, applied: false,
      intent: { view: this.client.view.view, request: crypto.randomUUID(), operation: null, capability,
        arguments: json({ binding: { capability, provider, project: this.client.view.project, target: session }, arguments: arguments_, preconditions: null }) } };
  }
  validate(action: CodeAction) {
    if (!action || !['document', 'selection', 'line', 'format', 'file'].includes(action.kind) || typeof action.version !== 'string' || !action.version ||
      typeof action.text !== 'string' || action.text.includes('\0') || bytes(action.text).length > 512 * 1024 || action.text.includes('\r') ||
      !Number.isSafeInteger(action.from) || !Number.isSafeInteger(action.to) || action.from < 0 || action.to < action.from || action.to > action.text.length ||
      !action.intent || typeof action.intent.view !== 'string' || !action.intent.view || bytes(action.intent.view).length > 160 ||
      typeof action.intent.request !== 'string' || !action.intent.request ||
      !(action.intent.operation === null || typeof action.intent.operation === 'string' && !!action.intent.operation) ||
      ![null, 'accepted', 'running', 'reconciling', 'succeeded', 'failed', 'cancelled', 'uncertain'].includes(action.status) ||
      typeof action.applied !== 'boolean' || action.applied && (action.kind !== 'format' || action.status !== 'succeeded' || action.formatted !== null) ||
      !(action.error === null || typeof action.error === 'string') || action.formatted !== null &&
      (action.kind !== 'format' || action.status !== 'succeeded' || typeof action.formatted.code !== 'string' || bytes(action.formatted.code).length > 128 * 1024 || action.formatted.code.includes('\0') ||
        typeof action.formatted.tool_version !== 'string' || !action.formatted.tool_version || bytes(action.formatted.tool_version).length > 256 ||
        typeof action.formatted.changed !== 'boolean' || action.formatted.changed !== (action.formatted.code !== action.text)))
      throw new Error('The retained Editor code request is invalid.');
    if (action.path !== null) validatePath(action.path);
    const code = action.text.slice(action.from, action.to), formatting = action.kind === 'format', args = action.intent.arguments as any;
    const capability = { id: formatting ? 'r.format' : 'r.execute', version: formatting ? 1 : 2 };
    const session = args?.arguments?.expected_session, source = { view_id: action.intent.view, label: label(action.path), kind: action.kind };
    const provider = args?.binding?.provider;
    if (!validProvider(provider) || !same(action.intent.capability, capability) || typeof session !== 'string' || !session || bytes(session).length > 160 || session.includes('\0') ||
      bytes(code).length > (formatting ? 65536 : 262144) || !formatting && !code.trim() ||
      ['format', 'document', 'file'].includes(action.kind) && (action.from !== 0 || action.to !== action.text.length) ||
      !same(args, { binding: { capability, provider, project: this.client.view.project, target: session },
        arguments: formatting ? { expected_session: session, code, source } : { expected_session: session, run: { code, source, output_mode: 'console' } }, preconditions: null }))
      throw new Error('The retained Editor code request differs from its captured text, R provider or session.');
  }
}
