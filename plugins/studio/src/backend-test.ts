/** Ordinary Studio workflow over public parent/child ports. No native lifecycle
 * is reproduced here: retained intent and receipts belong to their original Host. */
import type { CreatePluginTestProject, PluginTestProjectObservation, PluginViewRecord, PluginWindowLayout, OpenedPluginWindowView } from '../public/plugin-protocol/index.js';
import { ViewRequestError } from '../public/plugin-ui/index.js';
import { type Client, type Intent, type RecordReply, json, same, terminal, verifyOriginal, inspectOriginal } from './operations.js';

export interface BackendTestState {
  inputs: { name: string; instances: string } | null;
  project: PluginTestProjectObservation | null;
  view: PluginViewRecord | null;
  pending: { intent: Intent; testProject: string | null } | null;
  last: RecordReply | null;
}
export const emptyBackendTest = (): BackendTestState => ({ inputs: null, project: null, view: null, pending: null, last: null });
const testId = (id: unknown): id is string => typeof id === 'string' && /^[a-z][a-z0-9._-]{0,127}$/.test(id) && !id.includes('..');
const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(value);
const allowed = new Set(['plugins.test_create','plugins.test_stop','windows.open_view','views.close']);
async function read<T>(client: Pick<Client,'query'>, id: string, args: unknown): Promise<T> {
  const reply = await client.query<{ status: string; data?: T; notices?: string[] }>({id,version:1},json(args));
  if (reply.status !== 'ready' || reply.data == null) throw Error(reply.notices?.join('\n') || `${id} is unavailable.`);
  return reply.data;
}
export class BackendTest {
  constructor(readonly client: Client, private readonly state: () => BackendTestState, private readonly replace: (value: BackendTestState) => void,
    private readonly persist: () => Promise<unknown>, private readonly guard: () => void) {}
  get data() { return this.state(); }
  private available() { this.guard(); if (this.data.pending) throw Error('Inspect the original backend-test request before another action.'); }
  validate() {
    const data=this.data;
    if (!data || !['inputs','project','view','pending','last'].every(key=>Object.hasOwn(data,key))) throw Error('Saved backend-test state is incomplete.');
    if (data.project) this.verifyProject(data.project);
    if (data.view) this.verifyView(data.view);
    const pending=data.pending;
    if (!pending) return;
    const {intent,testProject}=pending, args=intent?.arguments as any;
    if (!intent || !identity(intent.view) || !identity(intent.request) || intent.operation!==null&&!identity(intent.operation) || intent.capability?.version!==1 || !allowed.has(intent.capability.id)) throw Error('The retained backend-test request is invalid.');
    if (intent.capability.id==='plugins.test_create' && (typeof args?.name!=='string' || !digest(args?.instances?.subject?.revision) || !digest(args.instances.subject.artifact))) throw Error('The retained test selection is invalid.');
    if (intent.capability.id==='plugins.test_stop' && (!Number.isSafeInteger(args?.expected_version) || args.expected_version<0)) throw Error('The retained test lifecycle version is invalid.');
    if (['windows.open_view','views.close'].includes(intent.capability.id)) {
      if (!testId(testProject) || data.project?.project.id!==testProject) throw Error('The retained request names another test project.');
      if (intent.capability.id==='windows.open_view' && (!same(args?.view?.instance,data.project.project.instances.subject) || args.view.window!==this.client.view.window)) throw Error('The retained test view differs from its original instance or window.');
      if (intent.capability.id==='views.close' && args?.view!==data.view?.view) throw Error('The retained closure names another view.');
    } else if (testProject!==null || intent.capability.id==='plugins.test_stop' && args?.id!==data.project?.project.id) throw Error('The retained test lifecycle target changed.');
  }
  private verifyProject(value: PluginTestProjectObservation) {
    const record=value?.project;
    if (!record || !testId(record.id) || record.source_project!==this.client.view.project || record.principal!==this.client.view.principal || record.project===record.source_project || !Number.isSafeInteger(record.version)) throw Error('The result is not this source project’s disposable test.');
    const previous=this.data.project?.project;
    if (previous && (record.id!==previous.id || record.source_operation_id!==previous.source_operation_id || record.project!==previous.project || !same(record.selection,previous.selection))) throw Error('Test observation changed its original identity or selection.');
    return record;
  }
  private verifyView(view: PluginViewRecord) {
    const project=this.data.project?.project;
    if (!project || !view || view.project!==project.project || view.principal!==project.principal || view.window!==this.client.view.window || !same(view.instance,project.instances.subject) || (view.purpose??'runtime')!=='runtime') throw Error('The result is not this test’s subject view.');
    return view;
  }
  async configure(plugin: string, revision: string, artifact: string, configuration: unknown) {
    this.available();
    this.data.inputs={name:'Backend test',instances:JSON.stringify({subject:{plugin,revision,artifact,configuration,dependencies:{}}},null,2)};
    await this.persist();
  }
  async create(revision: string, artifact: string) {
    this.available(); const data=this.data;
    if (data.project && data.project.project.state!=='stopped') throw Error('Stop the retained test before creating another.');
    if (!data.inputs) throw Error('Use a built checkpoint to configure the test first.');
    const args:CreatePluginTestProject={name:data.inputs.name,instances:JSON.parse(data.inputs.instances)};
    if (args.instances?.subject?.revision!==revision || args.instances.subject.artifact!==artifact) throw Error('The test subject must match the selected source and built artifact.');
    // The old stopped record remains until a new acknowledged result replaces it.
    await this.begin('plugins.test_create',args,null);
  }
  private selected() {
    const observed=this.data.project;
    if (!observed?.observed_in_this_host || !['ready','failed'].includes(observed.project.state)) throw Error('The original test Host is unavailable; it has not been restarted.');
    return this.client.testProject(observed.project.id);
  }
  async inspect() {
    this.available(); if (!this.data.project) return;
    const observed=await read<PluginTestProjectObservation>(this.client,'plugins.test_project',{id:this.data.project.project.id});
    this.verifyProject(observed); this.data.project=observed;
    if (this.data.view && !this.data.view.closed && observed.observed_in_this_host && ['ready','failed'].includes(observed.project.state)) {
      const view=await read<PluginViewRecord>(this.selected(),'views.inspect',{view:this.data.view.view});
      this.verifyView(view); if (view.view!==this.data.view.view) throw Error('Inspection returned another test view.'); this.data.view=view;
    }
    await this.persist();
  }
  async openView(contribution: string, configuration: unknown, state: unknown) {
    this.available(); await this.inspect(); const subject=this.data.project?.project.instances.subject;
    if (!subject || this.data.view && !this.data.view.closed) throw Error('The test subject is unavailable or its view is already open.');
    const layout=await read<PluginWindowLayout>(this.selected(),'windows.layout',{window:this.client.view.window});
    if (layout.project!==this.data.project!.project.project || layout.principal!==this.client.view.principal || layout.window!==this.client.view.window) throw Error('Test layout returned another scope.');
    const group=(node:PluginWindowLayout['layout']):string|null=>node.kind==='tabs'?node.id:node.kind==='split'?node.children.map(group).find(value=>value!==null)??null:null;
    await this.begin('windows.open_view',{view:{instance:subject,contribution,window:this.client.view.window,configuration,state},expected_layout_version:layout.version,group:group(layout.layout)},this.data.project!.project.id);
  }
  openWindow() { this.available(); this.selected(); return this.client.openTestWorkspace(this.data.project!.project.id); }
  async closeView(retainAcknowledged=false) {
    this.available(); await this.inspect(); const view=this.data.view;
    if (!view || view.closed) return;
    await this.begin('views.close',{view:view.view,mode:retainAcknowledged?{kind:'retain_acknowledged',expected_version:view.state_version}:{kind:'flush'}},this.data.project!.project.id);
  }
  async stop() {
    this.available(); await this.inspect(); const record=this.data.project?.project;
    if (!record || record.state==='stopped') return;
    await this.begin('plugins.test_stop',{id:record.id,expected_version:record.version},null);
  }
  private async begin(id: string,args: unknown,testProject:string|null) {
    this.data.pending={intent:{view:this.client.view.view,request:crypto.randomUUID(),capability:{id,version:1},arguments:json(structuredClone(args)),operation:null},testProject};
    await this.persist(); await this.dispatch(true);
  }
  async dispatch(first=false) {
    this.validate(); const pending=this.data.pending;
    if (!pending || pending.intent.view!==this.client.view.view) throw Error('Only the original view can retry this backend-test request.');
    await this.persist(); let result:unknown;
    try { result=await (pending.testProject?this.client.testProject(pending.testProject):this.client).invoke(pending.intent.capability,pending.intent.arguments,{requestId:pending.intent.request}); }
    catch(error) {
      const code=error instanceof ViewRequestError?(error.diagnostic as any)?.code:null;
      if (first && ['invalid_input','content_changed','not_found','access_denied'].includes(code)) { this.data.pending=null; await this.persist(); }
      throw error;
    }
    await this.finish(await verifyOriginal(result,pending.intent));
  }
  private async original() {
    const pending=this.data.pending!;
    if (!pending.testProject) return inspectOriginal(this.client,pending.intent);
    if (pending.intent.operation) {
      const value=await read<{record:unknown}>(this.client,'plugins.test_operation',{id:pending.testProject,operation_id:pending.intent.operation});
      return verifyOriginal(value.record,pending.intent);
    }
    const selected=this.client.testProject(pending.testProject);
    return inspectOriginal({view:this.client.view,query:selected.query.bind(selected),operation:selected.operation.bind(selected)},pending.intent);
  }
  async recover() { this.validate(); if (!this.data.pending) throw Error('No backend-test request is pending.'); await this.finish(await this.original()); }
  private async finish(record:RecordReply) {
    const pending=this.data.pending!,intent=pending.intent; intent.operation=record.operation.operation_id; await this.persist();
    const deadline=Date.now()+2000;
    while (!terminal(record.status) && Date.now()<deadline) { await new Promise(done=>setTimeout(done,100)); record=await this.original(); }
    this.data.last=structuredClone(record);
    if (!terminal(record.status)) { await this.persist(); return; }
    const retained=structuredClone(this.data),args=intent.arguments as any;
    if (intent.capability.id==='plugins.test_create') {
      let observed=record.output as PluginTestProjectObservation|null;
      const recovery=(record as any).recovery;
      if (!observed && recovery?.kind==='plugin_test_project' && testId(recovery.test_project)) observed=await read(this.client,'plugins.test_project',{id:recovery.test_project});
      if (observed) {
        // A new original create replaces only the previous stopped test record.
        const previous=this.data.project; this.data.project=null;
        try {
          const project=this.verifyProject(observed);
          if (project.source_operation_id!==intent.operation || !same(project.selection,args) || record.status==='succeeded' && (!observed.observed_in_this_host || project.state!=='ready')) throw Error('Test creation receipt differs from its original request.');
          this.data.project=observed; this.data.view=null;
        } catch(error) { this.data.project=previous; throw error; }
      } else if (record.status==='succeeded') throw Error('Test creation has no confirmed project.');
    } else if (record.status==='succeeded') {
      if (intent.capability.id==='plugins.test_stop') {
        const observed=record.output as PluginTestProjectObservation;
        if (this.verifyProject(observed).state!=='stopped' || observed.observed_in_this_host) throw Error('Test cleanup is not confirmed.');
        this.data.project=observed;
      } else {
        const view=intent.capability.id==='windows.open_view'?(record.output as OpenedPluginWindowView)?.view:record.output as PluginViewRecord;
        this.verifyView(view);
        if (intent.capability.id==='windows.open_view' ? view.closed || view.contribution!==args.view.contribution || !same(view.configuration,args.view.configuration) || !same(view.state,args.view.state) : view.view!==args.view || !view.closed) throw Error('Test view receipt differs from the original request.');
        this.data.view=view;
      }
    }
    if (record.status==='uncertain') { await this.persist(); throw Error(record.error || 'The original test outcome is uncertain. Its request remains retained.'); }
    this.data.pending=null;
    try { await this.persist(); } catch(error) { this.replace(retained); throw error; }
    if (record.status!=='succeeded') throw Error(record.error || `The original backend-test request ${record.status}.`);
  }
}
