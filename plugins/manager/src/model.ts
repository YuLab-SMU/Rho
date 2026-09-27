/** Management owns presentation and orchestration; the public Host ports own truth. */
import type { ApplyScenario, ScenarioRevision, ScenarioLayout, ScenarioView, PluginInstanceObservation,
  PluginInspection, PluginViewRecord, InstanceRef, JsonValue } from '../public/plugin-protocol/index.js';
import { type Client, type Intent, type RecordReply, json, same, verifyOriginal, inspectOriginal } from './operations.js';
import { ViewRequestError } from '../public/plugin-ui/index.js';
import { ArchiveUpload, verifyArchiveImport, type ArchiveUploadState } from './archive.js';
import { ArchiveExport, type ArchiveExportState } from './export.js';
export { same, json } from './operations.js';
export type Purpose = { kind: 'activate' | 'view'; key: string } | { kind: 'apply' | 'checkpoint' | 'archive_import' | 'archive_export' | 'other' };
export interface Preparation { definition: ScenarioRevision; request: ApplyScenario; ready: boolean; }
export interface Saved {
  section: 'installed' | 'instances' | 'scenarios'; selected: string; detail: boolean; scroll: number;
  draft: string | null; preparation: Preparation | null;
  retained_views: string[];
  pending: { intent: Intent; purpose: Purpose } | null;
  upload?: ArchiveUploadState | null;
  exported?: ArchiveExportState | null;
}
export const initial = (): Saved => ({ section: 'installed', selected: '', detail: false, scroll: 0, draft: null, preparation: null, retained_views: [], pending: null });
export const viewsOf = (layout: ScenarioLayout): ScenarioView[] => layout.kind === 'tabs' ? layout.views : layout.kind === 'split' ? layout.children.flatMap(viewsOf) : [];
export const short = (id: string) => id.startsWith('sha256:') ? id.slice(7, 15) : id;
export const own = <T>(record: Record<string,T>, key:string):T|undefined=>Object.hasOwn(record,key)?record[key]:undefined;
const put = <T>(record:Record<string,T>,key:string,value:T)=>Object.defineProperty(record,key,{value,enumerable:true,writable:true,configurable:true});
/** Match serde's public optional-field defaults before freezing the request. */
export function checkpointInput(value: unknown): JsonValue {
  const copy = structuredClone(value) as Record<string,unknown>;
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new Error('A checkpoint must be a JSON object.');
  copy.expected_head ??= null;
  if (copy.instances && typeof copy.instances === 'object') for (const item of Object.values(copy.instances)) {
    if (item && typeof item === 'object' && Array.isArray(item.optional_capabilities) && !item.optional_capabilities.length) delete item.optional_capabilities;
  }
  if (Array.isArray(copy.providers)) for (const item of copy.providers) if (item && typeof item === 'object') item.target ??= null;
  const visit = (layout: any) => {
    if (!layout || typeof layout !== 'object') return;
    if (layout.kind === 'tabs') { layout.selected ??= null; if (Array.isArray(layout.views)) for (const view of layout.views) if (view && typeof view === 'object') view.resource ??= null; }
    if (layout.kind === 'split' && Array.isArray(layout.children)) layout.children.forEach(visit);
  };
  visit(copy.layout); return json(copy);
}
export function matches(instance: PluginInstanceObservation, wanted: ScenarioRevision['instances'][string]) {
  const found = instance.instance;
  return instance.observed_in_this_host && (found.purpose??'runtime') === 'runtime' && found.state === 'active' && found.identity.plugin === wanted.plugin &&
    found.identity.revision === wanted.revision && found.identity.artifact === wanted.artifact && same(found.configuration, wanted.configuration);
}
export function viewMatches(view: PluginViewRecord, wanted: ScenarioView, instance: InstanceRef, window: string) {
  return !view.closed && (view.purpose??'runtime') === 'runtime' && view.window === window && same(view.instance, instance) && view.contribution === wanted.contribution &&
    same(view.configuration, wanted.configuration) && same(view.resource ?? null, wanted.resource);
}
export async function read<T>(client: Client, id: string, args: unknown): Promise<T> {
  const result = await client.query<{status: string; data?: T; notices?: string[]}>({id,version:1}, json(args));
  if (result.status !== 'ready' || result.data == null) throw new Error(result.notices?.join('\n') || `${id} is unavailable.`);
  return result.data;
}
/** Persist intent before dispatch; save its verified effect before clearing it.
 * Recovery inspects one original request, and never resumes later steps itself. */
export class Manager {
  state: Saved;
  readonly upload: ArchiveUpload;
  readonly archiveExport: ArchiveExport;
  constructor(readonly client: Client, saved: Saved = initial()) {
    this.state = structuredClone(saved);
    this.upload = new ArchiveUpload(client, () => this.state.upload ?? null, value => { this.state.upload = value; }, () => this.save(), () => {
      if (this.state.pending) throw Error('Inspect the original request before changing its archive transfer.');
    });
    this.archiveExport = new ArchiveExport(client, () => this.state.exported ?? null, value => { this.state.exported = value; }, () => this.save(), () => {
      if (this.state.pending) throw Error('Inspect the original request before changing its export.');
    }, args => this.invoke('plugins.archive_export', args, {kind:'archive_export'}));
  }
  save() { return this.client.setState(json(structuredClone(this.state))); }
  async importArchive() {
    const upload = this.state.upload;
    if (!upload?.inspection || upload.received !== upload.reference.bytes || upload.imported) throw Error('Inspect a complete archive before importing it.');
    return this.invoke('plugins.archive_import', { reference: upload.reference }, { kind: 'archive_import' });
  }
  async inspectArchiveImport() {
    const upload = this.state.upload;
    if (!upload?.original || !upload.imported) throw Error('No original successful import is retained.');
    const record = await inspectOriginal(this.client, upload.original);
    if (record.status !== 'succeeded' || !same(verifyArchiveImport(record.output, upload), upload.imported))
      throw Error('The original import result is not confirmed.');
    return record;
  }
  async invoke(id: string, args: unknown, purpose: Purpose = {kind:'other'}) {
    if (this.state.pending) throw new Error('Inspect the original request before starting another operation.');
    const intent: Intent = {view:this.client.view.view,request:crypto.randomUUID(),capability:{id,version:1},arguments:json(structuredClone(args)),operation:null};
    this.state.pending = {intent,purpose};
    try { await this.save(); } catch (error) { this.state.pending = null; throw error; }
    return this.dispatch(true);
  }
  async dispatch(firstDispatch = false) {
    const pending = this.state.pending;
    if (!pending || pending.intent.view !== this.client.view.view) throw new Error('Only the original view may retry this saved request. Inspect its original Operation.');
    let reply: unknown;
    try { reply = await this.client.invoke(pending.intent.capability, pending.intent.arguments, {requestId:pending.intent.request}); }
    catch (error) {
      // Correlated Host preparation rejection on a fresh request precedes
      // admission. Never use this shortcut after an uncertain dispatch/retry.
      const diagnostic = error instanceof ViewRequestError ? error.diagnostic as {code?:string} | undefined : undefined;
      if (firstDispatch && diagnostic?.code && ['invalid_input','content_changed','not_found','access_denied'].includes(diagnostic.code)) {
        this.state.pending = null; await this.save();
      }
      throw error;
    }
    const record = await verifyOriginal(reply, pending.intent);
    return this.accept(await this.observeCompletion(record));
  }
  async recover() {
    if (!this.state.pending) return;
    return this.accept(await this.observeCompletion(await inspectOriginal(this.client, this.state.pending.intent)));
  }
  private async observeCompletion(record: RecordReply) {
    if (['succeeded','failed','cancelled','uncertain'].includes(record.status)) return record;
    this.state.pending!.intent.operation = record.operation.operation_id; await this.save();
    const deadline = Date.now() + 8000;
    while (!['succeeded','failed','cancelled','uncertain'].includes(record.status) && Date.now() < deadline) {
      await new Promise(done=>setTimeout(done,200));
      record = await inspectOriginal(this.client, this.state.pending!.intent);
    }
    return record;
  }
  private async accept(record: RecordReply) {
    const pending = this.state.pending!;
    pending.intent.operation = record.operation.operation_id;
    if (record.status !== 'succeeded') {
      // Failed/cancelled are terminal journal outcomes. Uncertain stays visible.
      if (record.status === 'failed' || record.status === 'cancelled') this.state.pending = null;
      await this.save(); throw new Error(record.error || `Original request is ${record.status}.`);
    }
    const prep = this.state.preparation;
    if (pending.purpose.kind === 'activate') {
      if (!prep) throw new Error('The saved preparation is missing; retain the original request for inspection.');
      const output = record.output as PluginInstanceObservation, wanted = prep.definition.instances[pending.purpose.key];
      if (!wanted || !matches(output, wanted)) throw new Error('Activation returned a different or unavailable instance.');
      put(prep.request.instances,pending.purpose.key,output.instance.identity);
    } else if (pending.purpose.kind === 'view') {
      if (!prep) throw new Error('The saved preparation is missing.');
      const key = pending.purpose.key, wanted = viewsOf(prep.definition.layout).find(v => v.id === key);
      if (!wanted || !viewMatches(record.output as PluginViewRecord, wanted, prep.request.instances[wanted.instance]!, this.client.view.window))
        throw new Error('The created view does not match the saved preparation.');
      put(prep.request.views,wanted.id,(record.output as PluginViewRecord).view);
      this.state.retained_views = [...new Set([...this.state.retained_views, (record.output as PluginViewRecord).view])].slice(-256);
    } else if (pending.purpose.kind === 'apply') {
      if (prep) prep.ready = false;
    } else if (pending.purpose.kind === 'checkpoint') {
      this.state.draft = null; this.state.section = 'scenarios'; this.state.selected = (record.output as ScenarioRevision).id; this.state.detail = true;
    } else if (pending.purpose.kind === 'archive_import') {
      const upload = this.state.upload;
      if (!upload || pending.intent.capability.id !== 'plugins.archive_import' || !same(pending.intent.arguments, { reference: upload.reference }))
        throw Error('The retained import differs from its captured archive.');
      upload.imported = verifyArchiveImport(record.output, upload);
      upload.original = structuredClone(pending.intent);
    } else if (pending.purpose.kind === 'archive_export') {
      this.archiveExport.accept(record, pending.intent);
    }
    this.state.pending = null;
    try { await this.save(); } catch (error) { this.state.pending = pending; throw error; }
    return record.output;
  }
  async begin(definition: ScenarioRevision, version: number) {
    if (this.state.pending) throw new Error('An original request still needs inspection.');
    this.state.preparation = { definition:structuredClone(definition), ready:false,
      request:{window:this.client.view.window,revision:definition.id,expected_layout_version:version,instances:{},views:{}} };
    await this.save();
  }
  async prepare(inspections: Map<string,PluginInspection>, selections: Record<string,string>, viewSelections: Record<string,string>, instances: PluginInstanceObservation[]) {
    const prep = this.state.preparation;
    if (!prep) throw new Error('Choose a scenario first.');
    prep.ready = false; await this.save();
    // Validate every artifact before creating anything. Host revalidates all of
    // this plus grants, dependency pins, live state and native layout CAS.
    for (const wanted of Object.values(prep.definition.instances)) {
      const inspection = inspections.get(wanted.revision);
      if (!inspection || inspection.summary.plugin !== wanted.plugin || !inspection.artifacts.some(a => a.id === wanted.artifact))
        throw new Error(`Missing exact revision or artifact: ${wanted.revision}. Import it with the plugin CLI.`);
    }
    for (const [alias,wanted] of Object.entries(prep.definition.instances)) {
      if (Object.hasOwn(prep.request.instances, alias)) continue;
      if (Object.hasOwn(selections, alias) && selections[alias]) {
        const selected = instances.find(i => i.instance.identity.instance === selections[alias]);
        if (!selected || !matches(selected,wanted)) throw new Error(`The selected instance for ${alias} is no longer available.`);
        if (Object.values(prep.request.instances).some(i=>same(i,selected.instance.identity))) throw new Error('Each alias must use a distinct instance.');
        put(prep.request.instances,alias,selected.instance.identity); await this.save();
      } else {
        const target = inspections.get(wanted.revision)!.artifacts.find(a=>a.id===wanted.artifact)!.target;
        await this.invoke('plugins.activate', {revision:wanted.revision,artifact:wanted.artifact,target,alias,configuration:wanted.configuration,
          ...(wanted.optional_capabilities?.length ? {optional_capabilities:wanted.optional_capabilities} : {})}, {kind:'activate',key:alias});
      }
    }
    for (const wanted of viewsOf(prep.definition.layout)) {
      if (Object.hasOwn(prep.request.views, wanted.id)) continue;
      const instance = prep.request.instances[wanted.instance]!;
      if (Object.hasOwn(viewSelections, wanted.id) && viewSelections[wanted.id]) {
        const found = await read<PluginViewRecord>(this.client,'views.inspect',{view:viewSelections[wanted.id]});
        if (!viewMatches(found,wanted,instance,this.client.view.window)) throw new Error(`The selected view for ${wanted.id} does not match this scene.`);
        put(prep.request.views,wanted.id,found.view); await this.save();
      } else await this.invoke('views.open', {instance,contribution:wanted.contribution,window:this.client.view.window,
        configuration:wanted.configuration,state:wanted.state,...(wanted.resource ? {resource:wanted.resource} : {})}, {kind:'view',key:wanted.id});
    }
    await read(this.client,'scenarios.prepare',prep.request); prep.ready = true; await this.save();
  }
  async apply() {
    const prep = this.state.preparation;
    if (!prep?.ready) throw new Error('Prepare the exact selection before switching.');
    return this.invoke('scenarios.apply',prep.request,{kind:'apply'});
  }
}
