/** Public component-input sender. Source owners supply exact references; only view opening mutates. */
import type { ContextReference, ContextPreview, InstanceRef, PluginInspection, PluginInstanceObservation, PluginInstanceObservations, PluginWindowLayout, PluginViewRecord, OpenedPluginWindowView } from '../plugin-protocol/index.js';
import { ViewRequestError } from '../plugin-ui/index.js';
import { type Client, type Intent, type RecordReply, json, same, verifyOriginal, inspectOriginal } from './operations.js';
export interface ComponentSource { reference: ContextReference; title: string; inclusion: unknown; preview: {id:string;version:number}; }
export interface AgentInput extends ComponentSource { request: string; source_view: string; instance: InstanceRef | null; }
export interface AgentState { input: AgentInput | null; pending: Intent | null; opened: PluginViewRecord | null; }
const empty = (): AgentState => ({input:null,pending:null,opened:null});
async function read<T>(client: Client, id: string, args: unknown): Promise<T> {
  const reply=await client.query<{status:string;completeness?:string;data?:T}>({id,version:1},json(args));
  if(reply.status!=='ready'||reply.completeness&&reply.completeness!=='complete'||reply.data==null)throw Error(`${id} is not fully available.`);
  return reply.data;
}
export class ComponentAgent {
  data: AgentState;
  candidates: PluginInstanceObservation[]=[];
  next: string|null=null;
  preview='';
  busy=false;
  constructor(private client:Client, saved:AgentState|undefined, private persist:(state:AgentState)=>Promise<void>, private guard:()=>void, private changed:()=>void) {
    this.data=structuredClone(saved??empty());this.validate();
  }
  private validate() {
    const {input,pending,opened}=this.data,args=pending?.arguments as any;
    if(input&&(!input.request||typeof input.source_view!=='string'||!input.source_view||input.reference.window!==this.client.view.window))throw Error('The retained Agent input belongs to another source view or window.');
    if(pending&&(!input||pending.view!==input.source_view||pending.capability.id!=='windows.open_view'||pending.capability.version!==1||
      !same(args?.view?.instance,input.instance)||args.view.window!==this.client.view.window||args.view.contribution!=='agent'||
      !same(args.view.configuration,this.configuration(input))))throw Error('The retained Agent view request differs from its captured source.');
    if(opened)this.verifyView(opened);
  }
  private async act(work:()=>Promise<void>) {
    this.guard();if(this.busy)throw Error('Wait for the current Agent request.');this.busy=true;this.changed();
    try{await work();}finally{this.busy=false;this.changed();}
  }
  private async save(){this.guard();await this.persist(structuredClone(this.data));this.guard();}
  private active(value:PluginInstanceObservation){const item=value?.instance;return !!item&&value.observed_in_this_host&&item.state==='active'&&
    (item.purpose??'runtime')==='runtime'&&item.project===this.client.view.project&&item.principal===this.client.view.principal&&item.identity.plugin==='org.rho.agent';}
  private async listPage(more:boolean){
    const page=await read<PluginInstanceObservations>(this.client,'plugins.instances',{after:more?this.next:null,limit:20});this.guard();
    if(page.next!==null&&(page.next===(more?this.next:null)||!page.instances.some(item=>item.instance.identity.instance===page.next)))throw Error('Agent instance pagination did not advance.');
    const previous=more?this.candidates:[];
    if(page.instances.some(item=>previous.some(old=>same(old.instance.identity,item.instance.identity))))throw Error('Agent instance pagination repeated a result.');
    this.candidates=[...previous,...page.instances.filter(item=>this.active(item))];this.next=page.next;
  }
  list(more=false){return this.act(()=>this.listPage(more));}
  select(instance:InstanceRef|null){return this.act(async()=>{
    if(!this.data.input||this.data.pending||this.data.opened)throw Error('Prepare a new input before changing its target.');
    if(instance&&!this.candidates.some(item=>same(item.instance.identity,instance)))throw Error('Choose an observed Agent instance.');
    this.data.input.instance=structuredClone(instance);await this.save();
  });}
  private async checkSource(input:AgentInput){
    const capability=input.preview;
    const value=await read<ContextPreview>(this.client,capability.id,{binding:{provider:input.reference.provider,project:this.client.view.project,capability,target:null},
      arguments:{reference:input.reference,inclusion:input.inclusion,max_bytes:16384},preconditions:null});this.guard();
    if(!same(value.item.reference,input.reference)||value.truncated||value.resources.length||new TextEncoder().encode(value.text).length>16384)
      throw Error('This source is changed, partial or unavailable. Choose a smaller inclusion and prepare the current input.');
    this.preview=value.text;
  }
  prepare(source:ComponentSource){return this.act(async()=>{
    if(this.data.pending)throw Error('Inspect the original Agent view request before preparing another input.');
    if(source.reference.window!==this.client.view.window||!source.title||source.title.length>160)throw Error('Select an exact source from this window.');
    const input:AgentInput={...structuredClone(source),request:crypto.randomUUID(),source_view:this.client.view.view,instance:null};
    await this.checkSource(input);this.data={input,pending:null,opened:null};await this.save();await this.listPage(false);
  });}
  private configuration(input:AgentInput){return {component_request:{request_id:input.request,title:`Ask about ${input.title}`.slice(0,160),
    sources:[{source:'plugin',label:input.title,reference:input.reference,inclusion:JSON.stringify(input.inclusion)}]}};}
  open(){return this.act(async()=>{
    if(this.data.pending||this.data.opened)throw Error('Inspect the original request or prepare a new input before opening another view.');
    const input=structuredClone(this.data.input);if(!input?.instance)throw Error('Choose an active Agent instance.');
    await this.checkSource(input);
    const observed=await read<PluginInstanceObservation>(this.client,'plugins.instance',{instance:input.instance});this.guard();
    if(!this.active(observed)||!same(observed.instance.identity,input.instance))throw Error('The chosen Agent instance is unavailable. Restore it explicitly in Plugins.');
    const inspection=await read<PluginInspection>(this.client,'plugins.inspect',{revision:input.instance.revision});this.guard();
    if(inspection.summary.revision!==input.instance.revision||inspection.manifest.id!=='org.rho.agent'||
      !(inspection.manifest.views.find(view=>view.id==='agent')?.configuration_schema as any)?.properties?.component_request)
      throw Error('This Agent revision does not accept component input. Choose an updated instance.');
    const layout=await read<PluginWindowLayout>(this.client,'windows.layout',{window:this.client.view.window});this.guard();
    if(layout.window!==this.client.view.window||layout.project!==this.client.view.project||layout.principal!==this.client.view.principal)throw Error('The layout belongs to another window.');
    const group=(node:PluginWindowLayout['layout']):string|null=>node.kind==='tabs'?node.id:node.kind==='split'?node.children.map(group).find(id=>id!==null)??null:null;
    this.data.pending={view:this.client.view.view,request:crypto.randomUUID(),capability:{id:'windows.open_view',version:1},operation:null,
      arguments:json({view:{instance:input.instance,contribution:'agent',window:this.client.view.window,configuration:this.configuration(input),state:{}},expected_layout_version:layout.version,group:group(layout.layout)})};
    await this.dispatch(true);
  });}
  private async dispatch(first=false){this.validate();const pending=this.data.pending;
    if(!pending||pending.view!==this.client.view.view)throw Error('Only the original source view can retry this request.');
    await this.save();let result:unknown;
    try{result=await this.client.invoke(pending.capability,pending.arguments,{requestId:pending.request});}
    catch(error){
      const code=error instanceof ViewRequestError?(error.diagnostic as any)?.code:null;
      if(first&&['invalid_input','content_changed','not_found','access_denied'].includes(code)){this.data.pending=null;await this.save();}
      throw error;
    }
    await this.finish(await verifyOriginal(result,pending));
  }
  retry(){return this.act(()=>this.dispatch());}
  inspect(){return this.act(async()=>{this.validate();if(this.data.pending)await this.finish(await inspectOriginal(this.client,this.data.pending));});}
  private verifyView(view:PluginViewRecord){const input=this.data.input;
    if(!input||!view||!same(view.instance,input.instance)||view.project!==this.client.view.project||view.principal!==this.client.view.principal||
      view.window!==this.client.view.window||view.contribution!=='agent'||(view.purpose??'runtime')!=='runtime'||!same(view.configuration,this.configuration(input)))
      throw Error('The Agent view receipt differs from the original captured input.');
  }
  private async finish(record:RecordReply){
    const pending=this.data.pending!;pending.operation=record.operation.operation_id;await this.save();
    // Admission can precede window placement. Observe only this durable original;
    // a slow/uncertain result stays recoverable instead of opening another view.
    for(let attempt=0;attempt<20&&['accepted','running','reconciling'].includes(record.status);attempt++){
      await new Promise(resolve=>setTimeout(resolve,50));this.guard();record=await inspectOriginal(this.client,pending);
    }
    if(record.status!=='succeeded'){
      if(['failed','cancelled'].includes(record.status)){this.data.pending=null;await this.save();}
      throw Error(record.error||`Original Agent view request is ${record.status}.`);
    }
    const opened=(record.output as OpenedPluginWindowView)?.view;this.verifyView(opened);
    if(!same(opened.state,(pending.arguments as any).view.state))throw Error('The original Agent view state was changed.');
    this.data.opened=opened;this.data.pending=null;
    try{await this.save();}catch(error){this.data.opened=null;this.data.pending=pending;throw error;}
  }
}
