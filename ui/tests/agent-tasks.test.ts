import { afterEach, expect, it, vi } from "vitest";
import { AgentTasks } from "../src/agent-tasks";
import type { AgentTaskPorts } from "../src/agent-task-ports";
import type { AgentTaskDetail } from "../src/generated/AgentTaskDetail";
import type { AgentTaskCommandResult } from "../src/generated/AgentTaskCommandResult";
import type { AgentTaskEventPage } from "../src/generated/AgentTaskEventPage";
import type { AgentCommandReceipt } from "../src/generated/AgentCommandReceipt";
const clone = <T>(v:T):T => structuredClone(v);
const windowRef={window_id:"window-one",incarnation:"current"};
function detail(id="a"):AgentTaskDetail{return {summary:{observation_version:1,history_generation:0,task:{task_id:id,project_root:"/study",provider:"kimi",native_session_id:null,title:id,created_at_ms:1,updated_at_ms:1,archived:false,model:"model",effort:null,mode:null},attachment:{generation:1,controller:windowRef,connection_id:null,state:"draft",capabilities:{resume:true,history:"native_context_history",images:true,embedded_context:true,modes:[],current_mode:null,models:[]},decisions:[],error:null,control_frozen:false},draft_version:0,has_draft:false,event_cursor:0,history_gap:false,unconfirmed:0},draft:{version:0,content:{text:"",assets:[],context:[]},updated_at_ms:1},assets:[],receipts:[]};}
function receipt(id:string,taskId:string,kind:string,status="succeeded"):AgentCommandReceipt{return {request_id:id,task_id:taskId,command:kind,input_digest:"digest",request_digest:"request-digest",input_assets:[],input_context:[],submitted_draft:null,status,native_session_id:null,native_turn_id:null,created_at_ms:1,updated_at_ms:1,error:null,submitted_draft_version:null};}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}
const models:AgentTasks[]=[];
afterEach(()=>{for(const m of models)m.stop();models.length=0;vi.useRealTimers();});
function fixture(){
 let online=true,project="/study";const records=new Map([['a',detail('a')],['b',detail('b')]]);const receipts=new Map<string,AgentCommandReceipt>();
 let eventPage:AgentTaskEventPage={task_id:"a",history_generation:0,events:[],next_cursor:0,has_more:false,history_gap:false,oldest_cursor:0,durable_cursor:0};
 const ports:AgentTaskPorts={windowId:windowRef.window_id,context:()=>({epoch:1,project,session:"r",runtimeState:"idle",connected:online,ready:true,capabilities:[]}),window:()=>online?windowRef:null,changed:vi.fn(),schedule:vi.fn(),readLocal:()=>null,writeLocal:vi.fn(),asset:vi.fn(),releaseAsset:vi.fn(),discover:vi.fn(),
 query:vi.fn(async req=>{const q=req.query;switch(q.kind){case"list":return{kind:"list",tasks:[...records.values()].map(d=>clone(d.summary)),attention:[],next:null,running:0,permissions:0};case"get":return{kind:"detail",detail:clone(records.get(q.task_id)!)};case"receipt":return{kind:"receipt",receipt:clone(receipts.get(q.request_id)??null)};case"events":return{kind:"events",page:clone(eventPage)};default:throw new Error("Unexpected query");}}),
 command:vi.fn(async req=>{const c=req.command;if(!('control'in c))throw new Error('unexpected create');const d=records.get(c.control.task_id)!;
 if(c.control.generation!==d.summary.attachment.generation)throw Object.assign(new Error('generation changed'),{status:409});
 if(c.kind==='save_draft'){if(c.version!==d.draft.version)throw Object.assign(new Error('draft changed'),{status:409});d.draft.content=clone(c.content);d.draft.version++;d.summary.observation_version++;d.summary.draft_version=d.draft.version;}
 const r=receipt(req.request_id,d.summary.task.task_id,c.kind,c.kind==='send'?'prepared':'succeeded');receipts.set(r.request_id,r);return{receipt:r,detail:clone(d)};})};
 const model=new AgentTasks(ports);models.push(model);
 return{model,ports,records,receipts,online:(v:boolean)=>online=v,project:(v:string)=>project=v,eventPage:(v:AgentTaskEventPage)=>eventPage=v};
}
it('opening, switching and hiding a panel only read tasks and never discover or start a CLI',async()=>{
 const f=fixture();f.model.show('agent');await f.model.observeSummary();f.model.select('b');await f.model.loadDetail('b');f.model.hide('agent');await f.model.observeEvents();
 expect(f.ports.discover).not.toHaveBeenCalled();expect(f.ports.command).not.toHaveBeenCalled();expect(f.model.getSnapshot().selected).toBe('b');
});
it('task drafts stay independent across switches and close/reopen',async()=>{
 vi.useFakeTimers();const f=fixture();await f.model.observeSummary();await f.model.loadDetail('a');await f.model.loadDetail('b');f.model.editText('a','alpha');f.model.select('b');f.model.editText('b','beta');f.model.hide('agent');f.model.show('agent');
 expect(f.model.getSnapshot().drafts.get('a')?.content.text).toBe('alpha');expect(f.model.getSnapshot().drafts.get('b')?.content.text).toBe('beta');await f.model.flushAll();
 expect(f.records.get('a')?.draft.content.text).toBe('alpha');expect(f.records.get('b')?.draft.content.text).toBe('beta');
});
it('a delayed draft acknowledgement does not overwrite subsequent typing',async()=>{
 vi.useFakeTimers();const f=fixture();await f.model.observeSummary();await f.model.loadDetail('a');f.model.editText('a','first');
 const pending=deferred<AgentTaskCommandResult>();vi.mocked(f.ports.command).mockReturnValueOnce(pending.promise);const saving=f.model.flushDraft('a');
 f.model.editText('a','second');const d=detail('a');d.draft.version=1;d.draft.content.text='first';d.summary.observation_version=2;
 const call=vi.mocked(f.ports.command).mock.calls[0][0];pending.resolve({receipt:receipt(call.request_id,'a','save_draft'),detail:d});await saving;
 expect(f.model.getSnapshot().drafts.get('a')?.content.text).toBe('second');expect(f.model.getSnapshot().drafts.get('a')?.dirty).toBe(true);
});
it('a lost send acknowledgement is reconciled by request identity and never re-sent',async()=>{
 const f=fixture();await f.model.observeSummary();await f.model.loadDetail('a');f.records.get('a')!.draft.content.text='hello';await f.model.loadDetail('a');
 vi.mocked(f.ports.command).mockRejectedValueOnce(new Error('ACK lost'));await f.model.send('a');const request=vi.mocked(f.ports.command).mock.calls[0][0];
 f.receipts.set(request.request_id,receipt(request.request_id,'a','send','submitted'));await f.model.observeSummary();await f.model.observeSummary();
 expect(f.ports.command).toHaveBeenCalledTimes(1);expect(f.model.getSnapshot().pending[0].requestId).toBe(request.request_id);
});
it('offline typing becomes a retained conflict copy after another window takes over',async()=>{
 vi.useFakeTimers();const f=fixture();await f.model.observeSummary();await f.model.loadDetail('a');f.online(false);f.model.editText('a','offline local content');expect(f.ports.writeLocal).toHaveBeenCalled();
 const d=f.records.get('a')!;d.summary.attachment.controller={window_id:'other-window',incarnation:'other'};d.summary.attachment.generation=2;d.summary.observation_version=2;d.draft.version=1;d.draft.content.text='new controller';
 f.online(true);await f.model.observeSummary();await f.model.loadDetail('a');expect(f.model.canEdit('a')).toBe(false);expect(f.model.getSnapshot().drafts.get('a')?.conflict?.text).toBe('offline local content');
 expect(f.ports.command).not.toHaveBeenCalled();
});
it('native history replacement does not duplicate earlier cached messages',async()=>{
 const f=fixture();f.model.show('agent');await f.model.observeSummary();f.model.select('a');
 const event={sequence:1,event_id:'old',request_id:null,generation:1,native_session_id:'s',native_turn_id:null,native_item_id:null,kind:'message',role:'assistant',text:'hello',status:null,source:'observation',observed_at_ms:1};
 f.eventPage({task_id:'a',history_generation:0,events:[event],next_cursor:1,has_more:false,history_gap:false,oldest_cursor:1,durable_cursor:1});await f.model.observeEvents();
 f.eventPage({task_id:'a',history_generation:1,events:[{...event,sequence:2,event_id:'native-history',source:'native_history'}],next_cursor:2,has_more:false,history_gap:true,oldest_cursor:2,durable_cursor:2});await f.model.observeEvents();
 expect(f.model.getSnapshot().events.get('a')?.map(e=>e.event_id)).toEqual(['native-history']);
});
it('draft copies and selection are restored without replaying pending commands',async()=>{
 vi.useFakeTimers();const f=fixture();await f.model.observeSummary();await f.model.loadDetail('a');f.model.select('a');f.model.editText('a','local draft');const snapshot=f.model.serialize();
 const g=fixture();g.model.restore(snapshot);expect(g.model.getSnapshot().selected).toBe('a');expect(g.model.getSnapshot().drafts.get('a')?.content.text).toBe('local draft');expect(g.ports.command).not.toHaveBeenCalled();
});
it.each(['send','save_draft'] as const)('handoff source reads distinguish pending %s from unsaved draft writes',async kind=>{
 const f=fixture();await f.model.observeSummary();await f.model.loadDetail('a');
 f.ports.handoffQuery=vi.fn(async()=>({kind:'source',source:{source:{kind:'native',task_id:'a'},title:'a',body:'Goal: Review\n\nConfirmed:\n\nNext:',context:[],revision:'v1',truncated:true,notices:[]}}));
 f.model.restore({agentTasks:{pending:[{requestId:'original',taskId:'a',kind,localRevision:0,content:null}]}});
 await f.model.handoffs.prepare({kind:'native',task_id:'a'});
 if(kind==='send'){expect(f.ports.handoffQuery).toHaveBeenCalledOnce();expect(f.model.handoffs.editor({kind:'native',task_id:'a'})?.observation?.truncated).toBe(true);}
 else{expect(f.ports.handoffQuery).not.toHaveBeenCalled();expect(f.model.handoffs.editor({kind:'native',task_id:'a'})?.error).toContain('Save or resolve');}
 expect(f.ports.command).not.toHaveBeenCalled();
});
it('handoff targets use the shared active-task query without changing an archived source selection',async()=>{
 const f=fixture();f.model.select('a');await f.model.loadDetail('a');f.model.filterArchived(true);
 const query=vi.fn(async()=>({kind:'project_list' as const,page:{tasks:[],attention:[],attention_count:0,next:'next-page',running:0,permissions:0}}));f.ports.projectQuery=query;
 await f.model.readHandoffTargets('current-page');
 expect(query).toHaveBeenCalledWith({project_root:'/study',query:{kind:'project_list',archived:false,before:'current-page',limit:32}});
 expect(f.model.getSnapshot().archived).toBe(true);expect(f.model.getSnapshot().selectedTask).toEqual({kind:'native',task_id:'a'});
});

it('a hidden mounted tab stops history polling while summaries remain available',async()=>{
 const f=fixture();f.model.show('agent');await f.model.observeSummary();f.model.select('a');f.model.viewsChanged({activeViewIds:['objects']});vi.mocked(f.ports.query).mockClear();await f.model.observeEvents();await f.model.observeSummary();
 expect(vi.mocked(f.ports.query).mock.calls.some(([r])=>r.query.kind==='events')).toBe(false);expect(vi.mocked(f.ports.query).mock.calls.some(([r])=>r.query.kind==='list')).toBe(true);
});
it('send waits for the in-flight autosave and sends the newest saved draft once',async()=>{
 vi.useFakeTimers();const f=fixture();await f.model.observeSummary();await f.model.loadDetail('a');f.model.editText('a','first');
 const pending=deferred<AgentTaskCommandResult>();vi.mocked(f.ports.command).mockReturnValueOnce(pending.promise);const saving=f.model.flushDraft('a');f.model.editText('a','latest');const sending=f.model.send('a');
 expect(f.ports.command).toHaveBeenCalledTimes(1);const d=f.records.get('a')!;d.draft.version=1;d.draft.content.text='first';d.summary.observation_version=2;
 const request=vi.mocked(f.ports.command).mock.calls[0][0];pending.resolve({receipt:receipt(request.request_id,'a','save_draft'),detail:clone(d)});await saving;await sending;
 expect(f.records.get('a')!.draft.content.text).toBe('latest');expect(vi.mocked(f.ports.command).mock.calls.filter(([r])=>r.command.kind==='send')).toHaveLength(1);expect(vi.mocked(f.ports.command).mock.calls.at(-1)![0].command).toMatchObject({kind:'send',draft_version:2});
});
it('initial newest-page cursors do not confuse older history with forward polling',async()=>{
 const f=fixture();f.model.show('agent');await f.model.observeSummary();f.model.select('a');
 const event={sequence:200,event_id:'latest',request_id:null,generation:1,native_session_id:'s',native_turn_id:null,native_item_id:null,kind:'message',role:'assistant',text:'latest',status:null,source:'observation',observed_at_ms:1};
 f.eventPage({task_id:'a',history_generation:0,events:[event],next_cursor:101,has_more:true,history_gap:false,oldest_cursor:1,durable_cursor:200});await f.model.observeEvents();expect(f.model.getSnapshot().earlier.get('a')).toBe(true);await f.model.observeEvents();
 const queries=vi.mocked(f.ports.query).mock.calls.map(([r])=>r.query).filter(q=>q.kind==='events');expect(queries.at(-1)).toMatchObject({after:200});
});
it('retains text committed by an IME after takeover as a local conflict without writing it remotely',async()=>{
 const f=fixture();await f.model.observeSummary();await f.model.loadDetail('a');
 const d=f.records.get('a')!;d.summary.attachment.controller={window_id:'other-window',incarnation:'other'};d.summary.attachment.generation=2;d.summary.observation_version=2;d.draft.version=1;d.draft.content.text='new controller draft';
 await f.model.loadDetail('a');f.model.commitComposition('a','local 中文',{text:'local ',assets:['original-image'],context:[]});
 expect(f.model.getSnapshot().drafts.get('a')?.conflict).toEqual({text:'local 中文',assets:['original-image'],context:[]});expect(f.records.get('a')!.draft.content.text).toBe('new controller draft');expect(f.ports.command).not.toHaveBeenCalled();
});

it('unified navigation keeps typed identities, pagination and restored selection without sending',async()=>{
 const f=fixture(); const rho={reference:{kind:"rho" as const,conversation_id:"a"},provider:null,title:"Rho task",created_at_ms:2,updated_at_ms:2,archived:false,state:"draft",has_draft:true,permissions:0,attention_reason:null,history_gap:false};
 const native={...rho,reference:{kind:"native" as const,task_id:"a"},provider:"kimi" as const,title:"Native task",created_at_ms:1};
 f.ports.projectQuery=vi.fn(async request=>({kind:"project_list",page:{tasks:request.query.kind==='project_list'&&request.query.before?[native]:[rho],attention:[],next:request.query.kind==='project_list'&&request.query.before?null:'cursor',running:0,permissions:0,attention_count:0}}));
 await f.model.observeSummary(); expect(f.model.getSnapshot().selectedTask).toEqual(rho.reference); expect(f.model.getSnapshot().selected).toBe(null);
 await f.model.loadMore(); expect(f.model.getSnapshot().projectTasks.map(t=>t.title)).toEqual(['Rho task','Native task']);
 f.model.chooseTask(native.reference); await f.model.loadDetail('a'); f.model.chooseTask(rho.reference); f.model.rememberAgent('rho');
 const saved=f.model.serialize(); const restored=new AgentTasks(f.ports); models.push(restored); restored.restore(saved);
 expect(restored.getSnapshot().selectedTask).toEqual(rho.reference); expect(restored.getSnapshot().selected).toBe(null); expect(restored.getSnapshot().lastAgent).toBe('rho');
 expect(f.ports.command).not.toHaveBeenCalled(); expect(f.ports.discover).not.toHaveBeenCalled();
});

it('archived native tasks keep control actions available but cannot edit or send a draft',async()=>{
 const f=fixture();f.records.get('a')!.summary.task.archived=true;await f.model.loadDetail('a');
 expect(f.model.canControl('a')).toBe(true);expect(f.model.canEdit('a')).toBe(false);
 f.model.editText('a','blocked');await f.model.send('a');
 expect(f.model.getSnapshot().drafts.get('a')?.content.text).toBe('');expect(f.ports.command).not.toHaveBeenCalled();
});

it('a late recovered native create cannot replace the current Rho selection or start native history polling',async()=>{
 const f=fixture(); f.model.show('agent');
 f.model.restore({agentTasks:{selectedTask:{kind:'rho',conversation_id:'rho-current'},pending:[{requestId:'late-create',taskId:null,kind:'create',localRevision:0,content:null}]}});
 f.receipts.set('late-create',receipt('late-create','a','create'));
 await f.model.observeSummary(); await f.model.observeEvents();
 expect(f.model.getSnapshot().selectedTask).toEqual({kind:'rho',conversation_id:'rho-current'}); expect(f.model.getSnapshot().selected).toBe(null);
 expect(vi.mocked(f.ports.query).mock.calls.some(([request])=>request.query.kind==='events')).toBe(false);
 expect(f.model.serialize()).not.toHaveProperty('agentTasks.selected');
});
it('a delayed new-task acknowledgement preserves a selection made while creation was in progress',async()=>{
 const f=fixture(),pending=deferred<AgentTaskCommandResult>();
 vi.mocked(f.ports.discover).mockResolvedValue({provider:'kimi',models:[{id:'model',name:'Model',efforts:[],default_effort:null}],selected_model:'model',error:null} as never);
 vi.mocked(f.ports.command).mockReturnValueOnce(pending.promise);
 const creating=f.model.newTask('kimi'); await vi.waitFor(()=>expect(f.ports.command).toHaveBeenCalledOnce());
 f.model.chooseTask({kind:'rho',conversation_id:'rho-current'});
 const call=vi.mocked(f.ports.command).mock.calls[0][0]; pending.resolve({receipt:receipt(call.request_id,'a','create'),detail:detail('a')}); await creating;
 expect(f.model.getSnapshot().selectedTask).toEqual({kind:'rho',conversation_id:'rho-current'}); expect(f.model.getSnapshot().selected).toBe(null);
});
