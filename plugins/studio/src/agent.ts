import type { InstanceRef, PluginBranch, PluginInspection, PluginInstanceObservation, PluginInstanceObservations, PluginWindowLayout, PluginViewRecord, OpenedPluginWindowView } from '../public/plugin-protocol/index.js';
import { ViewRequestError } from '../public/plugin-ui/index.js';
import { type Client, type Intent, type RecordReply, json, same, verifyOriginal, inspectOriginal } from './operations.js';

export interface AgentInput { branch: PluginBranch; goal: string; instance: InstanceRef | null; }
export interface AgentState { input: AgentInput | null; pending: Intent | null; opened: PluginViewRecord | null; }
const empty = (): AgentState => ({input: null, pending: null, opened: null});
async function read<T>(client: Client, id: string, args: unknown): Promise<T> {
  const reply = await client.query<{status: string; completeness?: string; data?: T; notices?: string[]}>({id, version: 1}, json(args));
  if (reply.status !== 'ready' || reply.completeness && reply.completeness !== 'complete' || reply.data == null) throw Error(reply.notices?.join('\n') || `${id} is unavailable.`);
  return reply.data;
}
/** Captures one development branch, then opens an ordinary Agent view. Only
 * that view owns task drafts/Send; opening never creates, sends or builds. */
export class AgentAssistance {
  data: AgentState = empty();
  candidates: PluginInstanceObservation[] = [];
  next: string | null = null;
  constructor(readonly client: Client, private persist: () => Promise<unknown>, private guard: () => void) {}
  private available() { this.guard(); if (this.data.pending) throw Error('Inspect the original Agent view request before another action.'); }
  restore(value: AgentState) { this.data = structuredClone(value); this.validate(); }
  private validate() {
    const data = this.data, p = data?.pending, args = p?.arguments as any;
    if (!data || !['input', 'pending', 'opened'].every(key => Object.hasOwn(data, key))) throw Error('The saved Studio Agent request is incomplete.');
    if (p && (p.capability?.id !== 'windows.open_view' || p.capability.version !== 1 || typeof p.view !== 'string' || typeof p.request !== 'string' ||
      !data.input || !same(args?.view?.instance, data.input.instance) || args.view.window !== this.client.view.window || args.view.contribution !== 'agent' ||
      args.view.configuration?.studio_request?.branch !== data.input.branch.id || args.view.configuration.studio_request.revision !== data.input.branch.head))
      throw Error('The retained Agent request differs from its captured branch or view.');
    if (data.opened) this.verifyView(data.opened);
  }
  private liveAgent(value: PluginInstanceObservation) {
    const item = value?.instance;
    return !!item && value.observed_in_this_host && item.state === 'active' && (item.purpose ?? 'runtime') === 'runtime' &&
      item.project === this.client.view.project && item.principal === this.client.view.principal && item.identity.plugin === 'org.rho.agent';
  }
  async list(more = false) {
    const page = await read<PluginInstanceObservations>(this.client, 'plugins.instances', {after: more ? this.next : null, limit: 20});
    if (page.next !== null && (page.next === (more ? this.next : null) || !page.instances.some(i => i.instance.identity.instance === page.next))) throw Error('Agent instance pagination did not advance.');
    const previous = more ? this.candidates : [];
    if (page.instances.some(i => previous.some(p => same(p.instance.identity, i.instance.identity)))) throw Error('Agent instance pagination repeated a result.');
    this.candidates = [...previous, ...page.instances.filter(i => this.liveAgent(i))]; this.next = page.next;
  }
  async prepare(branch: PluginBranch) {
    this.available();
    const head = await read<{revision: string}>(this.client, 'plugins.branch_head', {branch: branch.id});
    if (head.revision !== branch.head) throw Error('This branch changed. Open its current checkpoint before preparing an Agent request.');
    this.data.input = {branch: structuredClone(branch), goal: this.data.input?.goal ?? '', instance: null};
    this.data.opened = null; await this.persist(); await this.list();
  }
  async open() {
    this.available(); const input = this.data.input;
    if (this.data.opened) throw Error('Prepare a new request before opening another Agent view.');
    if (!input?.instance || !input.goal.trim()) throw Error('Choose an active Agent instance and describe the requested change.');
    if (new TextEncoder().encode(input.goal).length > 4096) throw Error('Keep the request within 4 KiB.');
    const captured = structuredClone(input);
    const head = await read<{revision: string}>(this.client, 'plugins.branch_head', {branch: captured.branch.id});
    if (head.revision !== captured.branch.head) throw Error('The captured branch changed. Prepare a new request from its current checkpoint.');
    const observed = await read<PluginInstanceObservation>(this.client, 'plugins.instance', {instance: captured.instance});
    if (!this.liveAgent(observed) || !same(observed.instance.identity, captured.instance)) throw Error('The selected Agent instance is unavailable. Restore it explicitly in Plugins.');
    const inspection = await read<PluginInspection>(this.client, 'plugins.inspect', {revision: captured.instance!.revision});
    const view = inspection.manifest.views.find(v => v.id === 'agent');
    if (inspection.summary.revision !== captured.instance!.revision || inspection.summary.plugin !== 'org.rho.agent' ||
      !(view?.configuration_schema as any)?.properties?.studio_request) throw Error('This Agent revision does not accept Studio requests. Select a current Agent instance.');
    const layout = await read<PluginWindowLayout>(this.client, 'windows.layout', {window: this.client.view.window});
    if (layout.project !== this.client.view.project || layout.principal !== this.client.view.principal || layout.window !== this.client.view.window) throw Error('Layout belongs to another project or window.');
    const {id: branch, head: revision} = captured.branch;
    const tool = (name: string, id: string, fixed: object) => ({name, target: {type: 'host', project: this.client.view.project, capability: {id, version: 1}, fixed_arguments: fixed}});
    const tools = [tool('inspect_checkpoint', 'plugins.inspect', {revision}), tool('list_source', 'plugins.source_tree', {revision}), tool('read_source', 'plugins.read_source', {revision}),
      tool('read_branch_head', 'plugins.branch_head', {branch}), tool('check_source_changes', 'plugins.check_source', {branch, expected_head: revision}), tool('create_checkpoint', 'plugins.checkpoint', {branch, expected_head: revision})];
    const configuration = {tools, studio_request: {request_id: crypto.randomUUID(), branch, revision, title: `Studio · ${captured.branch.name}`.slice(0, 160),
      text: `Plugin Studio request\nPlugin: ${captured.branch.plugin}\nBranch: ${captured.branch.name} (${branch})\nCheckpoint: ${revision}\n\n${captured.goal.trim()}\n\nRead this captured source and, if needed, create a checkpoint on this branch. Build, preview and scenario application remain separate Studio actions.`}};
    const group = (node: PluginWindowLayout['layout']): string | null => node.kind === 'tabs' ? node.id : node.kind === 'split' ? node.children.map(group).find(id => id !== null) ?? null : null;
    this.data.pending = {view: this.client.view.view, request: crypto.randomUUID(), capability: {id: 'windows.open_view', version: 1},
      arguments: json({view: {instance: captured.instance, contribution: 'agent', window: this.client.view.window, configuration, state: {}}, expected_layout_version: layout.version, group: group(layout.layout)}), operation: null};
    await this.persist(); await this.dispatch(true);
  }
  async dispatch(first = false) {
    this.validate(); const pending = this.data.pending;
    if (!pending || pending.view !== this.client.view.view) throw Error('Only the original Studio view can retry this request.');
    await this.persist(); let value: unknown;
    try { value = await this.client.invoke(pending.capability, pending.arguments, {requestId: pending.request}); }
    catch (error) {
      const code = error instanceof ViewRequestError ? (error.diagnostic as any)?.code : null;
      if (first && ['invalid_input', 'content_changed', 'not_found', 'access_denied'].includes(code)) { this.data.pending = null; await this.persist(); }
      throw error;
    }
    await this.finish(await verifyOriginal(value, pending));
  }
  async recover() { this.validate(); if (this.data.pending) await this.finish(await inspectOriginal(this.client, this.data.pending)); }
  private verifyView(view: PluginViewRecord) {
    if (!view || !this.data.input || !same(view.instance, this.data.input.instance) || view.project !== this.client.view.project || view.principal !== this.client.view.principal || view.window !== this.client.view.window || view.contribution !== 'agent' || (view.purpose ?? 'runtime') !== 'runtime') throw Error('The opened Agent view differs from the selected instance or window.');
  }
  private async finish(record: RecordReply) {
    const original = this.data.pending!; original.operation = record.operation.operation_id; await this.persist();
    if (record.status !== 'succeeded') {
      if (['failed', 'cancelled'].includes(record.status)) { this.data.pending = null; await this.persist(); }
      throw Error(record.error || `Original Agent view request is ${record.status}.`);
    }
    const opened = (record.output as OpenedPluginWindowView)?.view, args = original.arguments as any;
    this.verifyView(opened);
    if (!same(opened.configuration, args.view.configuration) || !same(opened.state, args.view.state)) throw Error('The Agent view receipt changed the original request.');
    const previous = this.data.opened; this.data.opened = opened; this.data.pending = null;
    try { await this.persist(); } catch (error) { this.data.opened = previous; this.data.pending = original; throw error; }
  }
}
