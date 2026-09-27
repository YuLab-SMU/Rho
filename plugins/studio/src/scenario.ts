/** Ordinary Studio orchestration over the public scenario and lifecycle ports.
 * Each mutation has its own synchronized intent. Recovery never advances steps. */
import type { ApplyScenario, InstanceRef, PluginInspection, PluginInstanceObservation, PluginViewRecord, SaveScenario, ScenarioLayout, ScenarioPage, ScenarioRevision, ScenarioView, WindowScenarioSnapshot } from '../public/plugin-protocol/index.js';
import { ViewRequestError } from '../public/plugin-ui/index.js';
import { type Client, type Intent, type RecordReply, json, same, terminal, verifyOriginal, inspectOriginal } from './operations.js';
import { own, put } from './visual.js';
export const scenarioViews = (layout: ScenarioLayout): ScenarioView[] => layout.kind === 'tabs' ? layout.views : layout.kind === 'split' ? layout.children.flatMap(scenarioViews) : [];
export interface PreviewEvidence { revision: string; artifact: string; }
type Pending = { intent: Intent; kind: 'checkpoint' | 'activate' | 'view' | 'apply'; key: string | null };
export interface ScenarioState {
  target: ScenarioRevision | null; alias: string; states: string;
  draft: SaveScenario | null; saved: ScenarioRevision | null;
  preparation: { request: ApplyScenario; ready: boolean } | null;
  retained: { instances: InstanceRef[]; views: string[] };
  pending: Pending | null; applied: WindowScenarioSnapshot | null;
}
export const emptyScenario = (): ScenarioState => ({ target: null, alias: '', states: '{}', draft: null, saved: null, preparation: null, retained: { instances: [], views: [] }, pending: null, applied: null });
async function read<T>(client: Client, id: string, args: unknown): Promise<T> {
  const reply = await client.query<{status: string; data?: T; notices?: string[]}>({id, version: 1}, json(args));
  if (reply.status !== 'ready' || reply.data == null) throw Error(reply.notices?.join('\n') || `${id} is unavailable.`);
  return reply.data;
}
function checkpoint(definition: ScenarioRevision, head = definition.id): SaveScenario {
  const result: SaveScenario = structuredClone({scenario: definition.scenario, expected_head: head, name: definition.name, instances: definition.instances, providers: definition.providers, layout: definition.layout});
  for (const value of Object.values(result.instances)) if (!value.optional_capabilities?.length) delete value.optional_capabilities;
  for (const value of result.providers) value.target ??= null;
  for (const view of scenarioViews(result.layout)) view.resource ??= null;
  return result;
}
function instanceMatches(observed: PluginInstanceObservation, wanted: ScenarioRevision['instances'][string]) {
  const value = observed.instance;
  return observed.observed_in_this_host && (value.purpose ?? 'runtime') === 'runtime' && value.state === 'active' && value.identity.plugin === wanted.plugin && value.identity.revision === wanted.revision && value.identity.artifact === wanted.artifact && same(value.configuration, wanted.configuration);
}
function viewMatches(view: PluginViewRecord, wanted: ScenarioView, instance: InstanceRef, window: string) {
  return !view.closed && (view.purpose ?? 'runtime') === 'runtime' && view.window === window && same(view.instance, instance) && view.contribution === wanted.contribution && same(view.configuration, wanted.configuration) && same(view.resource ?? null, wanted.resource ?? null);
}
export class ScenarioApplication {
  data = emptyScenario();
  constructor(readonly client: Client, private readonly persist: () => Promise<unknown>, private readonly guard: () => void) {}
  restore(value: ScenarioState) {
    if (!value || !['target', 'alias', 'states', 'draft', 'saved', 'preparation', 'retained', 'pending', 'applied'].every(key => Object.hasOwn(value, key))) throw Error('Saved scenario work is incomplete.');
    this.data = structuredClone(value);
    if (value.target) this.definition(value.target);
    if (value.saved) this.definition(value.saved);
    if (value.preparation && (!value.saved || value.preparation.request.revision !== value.saved.id || value.preparation.request.window !== this.client.view.window)) throw Error('Saved preparation differs from its scenario or window.');
    this.validateIntent();
  }
  private available() { this.guard(); if (this.data.pending) throw Error('Inspect the original scenario request before starting another action.'); }
  private definition(value: ScenarioRevision, revision = value.id) {
    if (value.id !== revision || value.project !== this.client.view.project) throw Error('Scenario observation differs from its requested revision or project.');
    return value;
  }
  private window(value: WindowScenarioSnapshot) {
    const layout = value.layout;
    if (layout.window !== this.client.view.window || layout.project !== this.client.view.project || layout.principal !== this.client.view.principal) throw Error('Scenario window observation differs from this view’s scope.');
    return value;
  }
  async list(after: string | null = null): Promise<ScenarioPage> { return read(this.client, 'scenarios.list', {after, limit: 100}); }
  async get(revision: string) { return this.definition(await read<ScenarioRevision>(this.client, 'scenarios.get', {revision}), revision); }
  async select(revision: string, plugin: string | null) {
    this.available(); const target = await this.get(revision);
    this.data.target = target; this.data.alias = Object.entries(target.instances).find(([, value]) => value.plugin === plugin)?.[0] ?? '';
    this.resetProposal(); this.resetStates(); await this.persist();
  }
  async chooseAlias(alias: string) {
    this.available(); if (!this.data.target || !own(this.data.target.instances, alias)) throw Error('Choose an existing scenario alias.');
    this.data.alias = alias; this.resetProposal(); this.resetStates(); await this.persist();
  }
  private resetStates() { this.data.states = JSON.stringify(Object.fromEntries(scenarioViews(this.data.target!.layout).filter(view => view.instance === this.data.alias).map(view => [view.id, {}])), null, 2); }
  private resetProposal() { this.data.draft = null; this.data.saved = null; this.data.preparation = null; }
  async stage(revision: string, artifact: string, preview: PreviewEvidence | null) {
    this.available(); const {target, alias} = this.data;
    if (!target || !own(target.instances, alias)) throw Error('Choose the target scenario and instance alias.');
    if (!preview || preview.revision !== revision || preview.artifact !== artifact) throw Error('Preview or test this exact revision and artifact before applying it.');
    const inspected = await read<PluginInspection>(this.client, 'plugins.inspect', {revision});
    if (inspected.summary.revision !== revision || inspected.summary.plugin !== target.instances[alias]!.plugin || !inspected.artifacts.some(value => value.id === artifact)) throw Error('The selected build does not belong to this scenario alias.');
    const states = JSON.parse(this.data.states);
    const draft = checkpoint(target), views = scenarioViews(draft.layout).filter(view => view.instance === alias);
    if (!states || Array.isArray(states) || typeof states !== 'object' || !same(Object.keys(states).sort(), views.map(view => view.id).sort())) throw Error('Provide an explicit new state for every view of the selected alias.');
    draft.instances[alias]!.revision = revision; draft.instances[alias]!.artifact = artifact;
    for (const view of views) { view.state = states[view.id]; view.state_revision = revision; }
    if (new TextEncoder().encode(JSON.stringify(draft)).length > 256 * 1024) throw Error('Scenario checkpoint exceeds 256 KiB.');
    this.resetProposal(); this.data.draft = draft; await this.persist();
  }
  async saveCheckpoint() {
    this.available(); if (!this.data.draft) throw Error('Stage a scenario change first.');
    await this.begin('scenarios.checkpoint', this.data.draft, 'checkpoint');
  }
  async restoreCheckpoint(revision: string) {
    this.available(); const target = this.data.target; if (!target) throw Error('Choose a named scenario first.');
    const historical = await this.get(revision);
    if (historical.scenario !== target.scenario) throw Error('History must belong to the same named scenario.');
    this.resetProposal(); this.data.draft = checkpoint(historical, target.id);
    await this.saveCheckpoint();
  }
  async restartPreparation() {
    this.available(); if (!this.data.saved) throw Error('Save the scenario checkpoint first.');
    const current = this.window(await read<WindowScenarioSnapshot>(this.client, 'windows.scenario', {window: this.client.view.window}));
    this.data.preparation = {request: {window: this.client.view.window, revision: this.data.saved.id, expected_layout_version: current.layout.version, instances: {}, views: {}}, ready: false};
    // Current mappings are preferred; retained exact instances/views can be used
    // again after restoring history. Never infer targets from alias names.
    this.data.retained.instances = [...Object.values(current.scenario?.instances ?? {}), ...this.data.retained.instances].filter((value, index, all) => all.findIndex(other => same(value, other)) === index).slice(0, 256);
    this.data.retained.views = [...new Set([...Object.values(current.scenario?.views ?? {}), this.client.view.view, ...this.data.retained.views])].slice(0, 256);
    await this.persist();
  }
  async prepare() {
    this.available(); if (!this.data.saved) throw Error('Save the scenario checkpoint first.');
    if (!this.data.preparation) await this.restartPreparation();
    const saved = this.data.saved, prep = this.data.preparation!; prep.ready = false; await this.persist();
    const inspections = new Map<string, PluginInspection>();
    for (const wanted of Object.values(saved.instances)) {
      const inspected = inspections.get(wanted.revision) ?? await read<PluginInspection>(this.client, 'plugins.inspect', {revision: wanted.revision});
      if (inspected.summary.revision !== wanted.revision || inspected.summary.plugin !== wanted.plugin || !inspected.artifacts.some(a => a.id === wanted.artifact)) throw Error('An exact scenario artifact is unavailable.');
      inspections.set(wanted.revision, inspected);
    }
    for (const [alias, wanted] of Object.entries(saved.instances)) {
      if (own(prep.request.instances, alias)) continue;
      let reuse: InstanceRef | null = null;
      for (const candidate of this.data.retained.instances) {
        if (candidate.plugin !== wanted.plugin || candidate.revision !== wanted.revision || candidate.artifact !== wanted.artifact || Object.values(prep.request.instances).some(value => same(value, candidate))) continue;
        const observed = await read<PluginInstanceObservation>(this.client, 'plugins.instance', {instance: candidate});
        if (same(observed.instance.identity, candidate) && instanceMatches(observed, wanted)) { reuse = candidate; break; }
      }
      if (reuse) { put(prep.request.instances, alias, reuse); await this.persist(); }
      else await this.begin('plugins.activate', {revision: wanted.revision, artifact: wanted.artifact, target: inspections.get(wanted.revision)!.artifacts.find(a => a.id === wanted.artifact)!.target, alias, configuration: wanted.configuration, ...(wanted.optional_capabilities?.length ? {optional_capabilities: wanted.optional_capabilities} : {})}, 'activate', alias);
    }
    for (const wanted of scenarioViews(saved.layout)) {
      if (own(prep.request.views, wanted.id)) continue;
      const instance = prep.request.instances[wanted.instance]!; let reuse: string | null = null;
      for (const candidate of this.data.retained.views) {
        const view = await read<PluginViewRecord>(this.client, 'views.inspect', {view: candidate});
        if (view.view === candidate && viewMatches(view, wanted, instance, this.client.view.window) && !Object.values(prep.request.views).includes(view.view)) { reuse = candidate; break; }
      }
      if (reuse) { put(prep.request.views, wanted.id, reuse); await this.persist(); }
      else await this.begin('views.open', {instance, contribution: wanted.contribution, window: this.client.view.window, configuration: wanted.configuration, state: wanted.state, ...(wanted.resource ? {resource: wanted.resource} : {})}, 'view', wanted.id);
    }
    this.applicationReceipt(await read<WindowScenarioSnapshot>(this.client, 'scenarios.prepare', prep.request), prep.request);
    prep.ready = true; await this.persist();
  }
  async apply() {
    this.available(); const prep = this.data.preparation;
    if (!prep?.ready) throw Error('Prepare this checkpoint before applying it to the current window.');
    await this.begin('scenarios.apply', prep.request, 'apply');
  }
  private validateIntent() {
    const pending = this.data.pending; if (!pending) return;
    const {intent, kind, key} = pending, args = intent.arguments as any;
    const id = {checkpoint: 'scenarios.checkpoint', activate: 'plugins.activate', view: 'views.open', apply: 'scenarios.apply'}[kind];
    if (!id || intent.capability?.id !== id || intent.capability.version !== 1 || !/^[A-Za-z0-9._-]{1,128}$/.test(intent.view) || !/^[A-Za-z0-9._-]{1,128}$/.test(intent.request)) throw Error('The retained scenario intent is invalid.');
    if (kind === 'checkpoint' && (!this.data.draft || !same(args, this.data.draft))) throw Error('The retained checkpoint differs from its captured proposal.');
    if (kind === 'apply' && (!this.data.preparation || !same(args, this.data.preparation.request))) throw Error('The retained application differs from its preparation.');
    if (kind === 'activate') {
      const wanted = key && this.data.saved && own(this.data.saved.instances, key);
      if (!wanted || args.revision !== wanted.revision || args.artifact !== wanted.artifact || args.alias !== key || !same(args.configuration, wanted.configuration) || !same(args.optional_capabilities ?? [], wanted.optional_capabilities ?? [])) throw Error('The retained activation differs from its exact scenario selection.');
    }
    if (kind === 'view') {
      const wanted = this.data.saved && scenarioViews(this.data.saved.layout).find(view => view.id === key);
      if (!wanted || !this.data.preparation || !same(args.instance, this.data.preparation.request.instances[wanted.instance]) || args.window !== this.client.view.window || args.contribution !== wanted.contribution || !same(args.configuration, wanted.configuration) || !same(args.state, wanted.state) || !same(args.resource ?? null, wanted.resource ?? null)) throw Error('The retained view differs from its scenario definition.');
    }
  }
  private async begin(id: string, args: unknown, kind: Pending['kind'], key: string | null = null) {
    this.available(); this.data.pending = {kind, key, intent: {view: this.client.view.view, request: crypto.randomUUID(), capability: {id, version: 1}, arguments: json(structuredClone(args)), operation: null}};
    await this.persist(); await this.dispatch(true);
  }
  async dispatch(first = false) {
    this.validateIntent(); const pending = this.data.pending;
    if (!pending || pending.intent.view !== this.client.view.view) throw Error('Only the original view can retry this scenario request. Inspect its original Operation.');
    await this.persist(); let reply: unknown;
    try { reply = await this.client.invoke(pending.intent.capability, pending.intent.arguments, {requestId: pending.intent.request}); }
    catch (error) {
      const code = error instanceof ViewRequestError ? (error.diagnostic as any)?.code : null;
      if (first && ['invalid_input', 'content_changed', 'not_found', 'access_denied'].includes(code)) { this.data.pending = null; if (this.data.preparation) this.data.preparation.ready = false; await this.persist(); }
      throw error;
    }
    await this.finish(await verifyOriginal(reply, pending.intent));
  }
  async recover() {
    this.validateIntent(); if (!this.data.pending) throw Error('No scenario request is pending.');
    await this.finish(await inspectOriginal(this.client, this.data.pending.intent));
  }
  private applicationReceipt(output: WindowScenarioSnapshot, args: ApplyScenario) {
    this.window(output); const scene = output.scenario;
    if (!scene || scene.window !== args.window || scene.project !== this.client.view.project || scene.principal !== this.client.view.principal || scene.revision !== args.revision || !same(scene.instances, args.instances) || !same(scene.views, args.views) || scene.applied_layout_version !== args.expected_layout_version + 1 || output.layout.version !== scene.applied_layout_version) throw Error('Scenario receipt differs from its exact preparation.');
  }
  private async finish(record: RecordReply) {
    const pending = this.data.pending!, {intent, kind, key} = pending; intent.operation = record.operation.operation_id; await this.persist();
    const deadline = Date.now() + 2000;
    while (!terminal(record.status) && Date.now() < deadline) { await new Promise(done => setTimeout(done, 100)); record = await inspectOriginal(this.client, intent); }
    if (!terminal(record.status) || record.status === 'uncertain') throw Error(record.error || `Original scenario request is ${record.status}. Inspect its result before continuing.`);
    const retained = structuredClone(this.data), args = intent.arguments as any;
    if (record.status === 'succeeded') {
      if (kind === 'checkpoint') {
        const value = this.definition(record.output as ScenarioRevision);
        if (value.parent !== args.expected_head || !same(checkpoint(value, value.parent!), args)) throw Error('Checkpoint receipt differs from the exact saved proposal.');
        this.data.saved = value; this.data.target = value; this.data.preparation = null;
      } else if (kind === 'activate') {
        const value = record.output as PluginInstanceObservation;
        if (!this.data.saved || !this.data.preparation || !key || !instanceMatches(value, this.data.saved.instances[key]!) || value.instance.project !== this.client.view.project || value.instance.principal !== this.client.view.principal || value.instance.alias !== key) throw Error('Activation receipt differs from the scenario instance.');
        put(this.data.preparation.request.instances, key, value.instance.identity);
        this.data.retained.instances = [value.instance.identity, ...this.data.retained.instances].slice(0, 256);
      } else if (kind === 'view') {
        const value = record.output as PluginViewRecord, wanted = scenarioViews(this.data.saved!.layout).find(view => view.id === key)!;
        if (!this.data.preparation || !viewMatches(value, wanted, args.instance, args.window) || !same(value.state, args.state) || value.project !== this.client.view.project || value.principal !== this.client.view.principal) throw Error('View receipt differs from the scenario definition.');
        put(this.data.preparation.request.views, key!, value.view); this.data.retained.views = [value.view, ...this.data.retained.views].slice(0, 256);
      } else {
        const value = record.output as WindowScenarioSnapshot; this.applicationReceipt(value, args);
        this.data.applied = value; this.data.preparation!.ready = false;
      }
    } else if (this.data.preparation) this.data.preparation.ready = false;
    this.data.pending = null;
    try { await this.persist(); } catch (error) { this.data = retained; throw error; }
    if (record.status !== 'succeeded') throw Error(record.error || `Original scenario request ${record.status}.`);
  }
}
