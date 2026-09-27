/** Explicit native build and fixture-preview lifecycle. Source editing does not
 * dispatch these requests; each action first retains its original intent. */
import type { PluginBuildResult, PluginInspection, PluginInstanceObservation, PluginViewRecord, PluginWindowLayout, PluginWindowNode, PreviewPlugin, OpenedPluginWindowView } from '../public/plugin-protocol/index.js';
import { ViewRequestError } from '../public/plugin-ui/index.js';
import { type Client, type Intent, type RecordReply, json, same, terminal, verifyOriginal, inspectOriginal } from './operations.js';
import { BackendTest, emptyBackendTest, type BackendTestState } from './backend-test.js';

export interface DevelopmentState {
  testing?: BackendTestState;
  previewed?: { revision: string; artifact: string };
  pending: Intent | null;
  stopRequested?: string;
  build: RecordReply | null;
  preview: { instance: PluginInstanceObservation; view: PluginViewRecord | null } | null;
  inputs: { revision: string; artifact: string; contribution: string; configuration: string; viewConfiguration: string; viewState: string; queries: string; timeoutMinutes?: string } | null;
}
export const emptyDevelopment = (): DevelopmentState => ({ pending: null, build: null, preview: null, inputs: null });
export function buildDiagnostic(record: RecordReply): string {
  const report = record.output as PluginBuildResult | null;
  if (record.status === 'cancelled') return 'Build cancelled. No new artifact was published.';
  if (record.status === 'failed' && report?.process.termination === 'timed_out') return 'Build exceeded its time limit. No new artifact was published.';
  if (record.status === 'failed' && report?.process.termination === 'exited' && report.process.exit_code !== null && report.process.exit_code !== 0) return `Build exited with code ${report.process.exit_code}. Open the build log for details.`;
  return report?.diagnostic ?? record.error ?? '';
}
const operations = new Set(['plugins.build', 'plugins.preview', 'windows.open_view', 'views.close', 'plugins.release']);
const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(value);
async function read<T>(client: Client, id: string, args: unknown): Promise<T> {
  const reply = await client.query<{ status: string; data?: T; notices?: string[] }>({ id, version: 1 }, json(args));
  if (reply.status !== 'ready' || reply.data == null) throw Error(reply.notices?.join('\n') || `${id} is unavailable.`);
  return reply.data;
}
function group(node: PluginWindowNode, current: string): string | null {
  if (node.kind === 'tabs') return node.views.includes(current) ? node.id : null;
  if (node.kind === 'split') for (const child of node.children) { const found = group(child, current); if (found) return found; }
  return null;
}
function firstGroup(node: PluginWindowNode): string | null {
  if (node.kind === 'tabs') return node.id;
  if (node.kind === 'split') for (const child of node.children) { const found = firstGroup(child); if (found) return found; }
  return null;
}

export class Development {
  data = emptyDevelopment();
  readonly testing: BackendTest;
  constructor(readonly client: Client, private readonly persist: () => Promise<unknown>, private readonly guard: () => void) {
    this.testing=new BackendTest(client,()=>this.data.testing??=emptyBackendTest(),value=>this.data.testing=value,persist,()=>{guard();if(this.data.pending)throw Error('Inspect the original build or preview request first.');});
  }
  async restore(value: DevelopmentState) {
    if (!value || !['pending', 'build', 'preview', 'inputs'].every(key => Object.hasOwn(value, key))) throw Error('Saved development state is incomplete.');
    this.data = structuredClone(value);
    this.validateIntent();
    if (this.data.build) {
      const record = this.data.build;
      if (record.operation?.capability.id !== 'plugins.build') throw Error('Saved build is not a build Operation.');
      const output = record.output as PluginBuildResult | null;
      if (output && (!digest(output.revision) || output.operation_id !== record.operation.operation_id || output.revision !== (record.operation.normalized_arguments as any)?.revision)) throw Error('Saved build evidence has a different identity.');
    }
    if (this.data.preview) this.previewIdentity(this.data.preview.instance);
    if (this.data.testing) this.testing.validate();
  }
  private available() { this.guard(); if (this.data.pending || this.data.testing?.pending) throw Error('Inspect the original development request before starting another action.'); }
  private validateIntent() {
    const intent = this.data.pending;
    if (!intent) return;
    if (!identity(intent.view) || !identity(intent.request) || intent.operation !== null && !identity(intent.operation) || intent.capability?.version !== 1 || !operations.has(intent.capability.id)) throw Error('The retained development request is invalid.');
    const args = intent.arguments as any;
    if (intent.capability.id === 'plugins.build' && (!digest(args?.revision) || !Number.isInteger(args.timeout_ms) || args.timeout_ms < 1 || args.timeout_ms > 3_600_000)) throw Error('The retained build target is invalid.');
    if (intent.capability.id === 'plugins.preview' && (!digest(args?.revision) || !digest(args?.artifact) || !Array.isArray(args.queries))) throw Error('The retained preview target is invalid.');
    if (intent.capability.id === 'windows.open_view' && (!this.data.preview || !same(args?.view?.instance, this.data.preview.instance.instance.identity) || args.view.window !== this.client.view.window)) throw Error('The retained preview view differs from its instance or window.');
    if (intent.capability.id === 'views.close' && (!this.data.preview?.view || args?.view !== this.data.preview.view.view)) throw Error('The retained close request differs from its preview.');
    if (intent.capability.id === 'plugins.release' && (!this.data.preview || !same(args?.instance, this.data.preview.instance.instance.identity))) throw Error('The retained release request differs from its preview.');
  }
  private previewIdentity(observed: PluginInstanceObservation) {
    const record = observed?.instance;
    if (!record || record.purpose !== 'fixture_preview' || record.project !== this.client.view.project || record.principal !== this.client.view.principal || !digest(record.identity?.revision) || !digest(record.identity?.artifact) || !identity(record.identity.instance) || observed.process_id !== null) throw Error('The result is not this project’s fixture preview.');
    return record;
  }
  async configure(revision: string) {
    this.available();
    if (this.data.inputs?.revision === revision) return;
    const inspection = await read<PluginInspection>(this.client, 'plugins.inspect', { revision });
    if (inspection.summary.revision !== revision) throw Error('Inspection returned another revision.');
    this.data.inputs = { revision, artifact: inspection.artifacts[0]?.id ?? '', contribution: inspection.manifest.views[0]?.id ?? '',
      configuration: JSON.stringify(inspection.manifest.default_configuration, null, 2), viewConfiguration: '{}', viewState: '{}', queries: '[]', timeoutMinutes: '10' };
    await this.persist();
  }
  async build(revision: string, timeout_ms = 600000) { this.available(); await this.begin('plugins.build', { revision, timeout_ms }); }
  async startPreview() {
    this.available();
    if (this.data.preview) throw Error('Close and release the retained preview before creating another.');
    const input = this.data.inputs;
    if (!input || !digest(input.revision) || !digest(input.artifact)) throw Error('Choose an exact built artifact first.');
    const args: PreviewPlugin = { revision: input.revision, artifact: input.artifact, alias: 'studio-preview', configuration: JSON.parse(input.configuration), queries: JSON.parse(input.queries) };
    if (!Array.isArray(args.queries) || args.queries.length > 128 || new TextEncoder().encode(JSON.stringify(args)).length > 256 * 1024) throw Error('Preview requires at most 128 exact query fixtures and 256 KiB.');
    // Parse view input before creating an instance so invalid input stays editable.
    JSON.parse(input.viewConfiguration); JSON.parse(input.viewState);
    await this.begin('plugins.preview', args);
  }
  async openPreview() {
    this.available(); const preview = this.data.preview, input = this.data.inputs;
    if (!preview || !input || preview.view || input.revision !== preview.instance.instance.identity.revision || input.artifact !== preview.instance.instance.identity.artifact) throw Error('Choose the retained preview’s exact source and artifact before opening its view.');
    const observed = await read<PluginInstanceObservation>(this.client, 'plugins.instance', { instance: preview.instance.instance.identity });
    this.previewIdentity(observed);
    if (!same(observed.instance.identity, preview.instance.instance.identity)) throw Error('Inspection returned another preview.');
    if (!observed.observed_in_this_host || observed.instance.state !== 'active') throw Error('The preview is not active in this Host. It has not been restarted.');
    const layout = await read<PluginWindowLayout>(this.client, 'windows.layout', { window: this.client.view.window });
    if (layout.window !== this.client.view.window || layout.project !== this.client.view.project || layout.principal !== this.client.view.principal) throw Error('The window observation differs from this view’s scope.');
    await this.begin('windows.open_view', { view: { instance: observed.instance.identity, contribution: input.contribution, window: this.client.view.window,
      configuration: JSON.parse(input.viewConfiguration), state: JSON.parse(input.viewState) }, expected_layout_version: layout.version, group: group(layout.layout, this.client.view.view) ?? firstGroup(layout.layout) });
  }
  async inspectPreview() {
    this.available(); const preview = this.data.preview; if (!preview) return;
    const observed = await read<PluginInstanceObservation>(this.client, 'plugins.instance', { instance: preview.instance.instance.identity });
    this.previewIdentity(observed);
    if (!same(observed.instance.identity, preview.instance.instance.identity)) throw Error('Inspection returned another preview.');
    preview.instance = observed;
    if (preview.view) {
      const view = await read<PluginViewRecord>(this.client, 'views.inspect', { view: preview.view.view });
      if (view.view !== preview.view.view || !same(view.instance, observed.instance.identity) || view.purpose !== 'fixture_preview') throw Error('Inspection returned another preview view.');
      preview.view = view;
    }
    await this.persist();
  }
  async closePreview(retainAcknowledged = false) {
    this.available(); await this.inspectPreview(); const view = this.data.preview?.view;
    if (!view || view.closed) return;
    await this.begin('views.close', { view: view.view, mode: retainAcknowledged ? { kind: 'retain_acknowledged', expected_version: view.state_version } : { kind: 'flush' } });
  }
  async releasePreview() {
    this.available(); await this.inspectPreview(); const preview = this.data.preview;
    if (!preview) return;
    if (preview.view && !preview.view.closed) throw Error('Close the preview view before releasing its instance.');
    await this.begin('plugins.release', { instance: preview.instance.instance.identity });
  }
  private async begin(id: string, args: unknown) {
    this.data.stopRequested = undefined;
    this.data.pending = { view: this.client.view.view, request: crypto.randomUUID(), capability: { id, version: 1 }, arguments: json(structuredClone(args)), operation: null };
    await this.persist(); await this.dispatch(true);
  }
  async dispatch(first = false) {
    this.validateIntent(); const intent = this.data.pending;
    if (!intent || intent.view !== this.client.view.view) throw Error('Only the original view can retry this development request. Inspect its original Operation.');
    await this.persist(); let reply: unknown;
    try { reply = await this.client.invoke(intent.capability, intent.arguments, { requestId: intent.request }); }
    catch (error) {
      const code = error instanceof ViewRequestError ? (error.diagnostic as any)?.code : null;
      if (first && ['invalid_input', 'content_changed', 'not_found', 'access_denied'].includes(code)) { this.data.pending = null; await this.persist(); }
      throw error;
    }
    await this.finish(await verifyOriginal(reply, intent));
  }
  async recover() {
    this.validateIntent(); if (!this.data.pending) throw Error('No development request is pending.');
    await this.finish(await inspectOriginal(this.client, this.data.pending));
  }
  async stopBuild() {
    this.validateIntent(); const intent = this.data.pending;
    if (!intent || intent.capability.id !== 'plugins.build' || !intent.operation || intent.view !== this.client.view.view) throw Error('Only the original view can request stopping its accepted build.');
    const observed = await inspectOriginal(this.client, intent);
    if (terminal(observed.status)) { await this.finish(observed); return; }
    const reply = await this.client.cancel<{ accepted: boolean; operation: unknown }>(intent.operation);
    const record = await verifyOriginal(reply.operation, intent);
    if (reply.accepted) { this.data.stopRequested = intent.operation; await this.persist(); }
    if (terminal(record.status)) await this.finish(record);
    else if (!reply.accepted) throw Error('The build stop request was not accepted. Inspect its original result.');
  }
  private async finish(record: RecordReply) {
    const intent = this.data.pending!; intent.operation = record.operation.operation_id;
    await this.persist();
    const deadline = Date.now() + 2000;
    while (!terminal(record.status) && Date.now() < deadline) { await new Promise(done => setTimeout(done, 100)); record = await inspectOriginal(this.client, intent); }
    if (!terminal(record.status)) {
      if (intent.capability.id === 'plugins.build') { this.data.build = structuredClone(record); await this.persist(); }
      return;
    }
    const retained = structuredClone(this.data);
    const id = intent.capability.id, args = intent.arguments as any;
    if (id === 'plugins.build') {
      const result = record.output as PluginBuildResult | null;
      if (result && (result.operation_id !== intent.operation || result.revision !== args.revision || result.artifact !== null && !digest(result.artifact))) throw Error('Build receipt differs from its original source or Operation.');
      if (record.status === 'succeeded' && (!result?.artifact || result.process?.termination !== 'exited' || result.process.exit_code !== 0)) throw Error('The build has no confirmed successful artifact.');
      this.data.build = structuredClone(record);
      if (record.status === 'succeeded' && this.data.inputs && this.data.inputs.revision === args.revision) this.data.inputs.artifact = result!.artifact!;
    }
    if (record.status === 'succeeded') {
      if (id === 'plugins.preview') {
        const output = record.output as PluginInstanceObservation, instance = this.previewIdentity(output);
        if (instance.identity.revision !== args.revision || instance.identity.artifact !== args.artifact || instance.alias !== args.alias || !same(instance.configuration, args.configuration) || instance.state !== 'active' || !output.observed_in_this_host) throw Error('Preview receipt differs from its original request.');
        this.data.preview = { instance: output, view: null };
      } else if (id === 'windows.open_view') {
        const output = record.output as OpenedPluginWindowView, view = output?.view;
        if (!view || !identity(view.view) || view.purpose !== 'fixture_preview' || view.project !== this.client.view.project || view.principal !== this.client.view.principal || !same(view.instance, args.view.instance) || view.contribution !== args.view.contribution || view.window !== args.view.window || !same(view.configuration, args.view.configuration) || !same(view.state, args.view.state) || view.closed) throw Error('View receipt differs from its original preview request.');
        this.data.preview!.view = view;
        this.data.previewed = {revision: view.instance.revision, artifact: view.instance.artifact};
      } else if (id === 'views.close') {
        const view = record.output as PluginViewRecord;
        if (view?.view !== args.view || view.purpose !== 'fixture_preview' || view.project !== this.client.view.project || view.principal !== this.client.view.principal || view.window !== this.client.view.window || !same(view.instance, this.data.preview!.instance.instance.identity) || !view.closed) throw Error('The original preview closure is not confirmed.');
        this.data.preview!.view = view;
      } else if (id === 'plugins.release') {
        const output = record.output as PluginInstanceObservation; this.previewIdentity(output);
        if (!same(output.instance.identity, args.instance) || output.instance.state !== 'released') throw Error('The original preview release is not confirmed.');
        this.data.preview = null;
      }
    }
    if (record.status === 'uncertain') { await this.persist(); throw Error(record.error || 'The original development outcome is uncertain. Its identity and evidence remain retained.'); }
    this.data.pending = null;
    try { await this.persist(); } catch (error) { this.data = retained; throw error; }
    if (record.status !== 'succeeded') throw Error((id === 'plugins.build' ? buildDiagnostic(record) : record.error) || `The original development request ${record.status}.`);
  }
}
