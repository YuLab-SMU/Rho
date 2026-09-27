import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export async function testScenario(module,operationRequestId,ViewRequestError){
 const {ScenarioApplication}=await module('scenario');
 const hash=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
 const old=hash('old'),next=hash('next'),artifact=hash('artifact'),nextArtifact=hash('next-artifact');
 const reference={plugin:'example.report',revision:old,artifact,instance:'old-instance'};
 const initial={id:hash('initial'),parent:null,scenario:'reports',project:'project',name:'Report comparison',instances:{report:{plugin:'example.report',revision:old,artifact,configuration:{},dependencies:{}}},providers:[],layout:{kind:'tabs',id:'reports',selected:'report-view',views:[{id:'report-view',instance:'report',contribution:'view',configuration:{},state:{text:'checkpoint state'},state_revision:old,resource:null}]}};
 const observation=(ref,alias='report')=>({instance:{identity:ref,alias,project:'project',principal:'user',configuration:{},state:'active',purpose:'runtime'},observed_in_this_host:true,process_id:null});
 const view=(ref,id,state)=>({view:id,instance:ref,contribution:'view',window:'window',project:'project',principal:'user',configuration:{},state,closed:false});
 const scenes=new Map([[initial.id,initial]]),instances=new Map([[reference.instance,observation(reference)]]),views=new Map([['old-view',view(reference,'old-view',{text:'Unsaved old draft 中文 Ω'})],['studio',{view:'studio',closed:true}]]);
 let current={scenario:{window:'window',project:'project',principal:'user',revision:initial.id,instances:{report:reference},views:{'report-view':'old-view'},providers:[],applied_layout_version:1},layout:{window:'window',project:'project',principal:'user',version:1,layout:{kind:'tabs',id:'old-tabs',views:['old-view'],selected:'old-view'}}};
 let saved, app, fault=null,saveFault=false,records=[],calls=[],head=initial.id;
 const client={view:{view:'studio',window:'window',project:'project',principal:'user',instance:{plugin:'org.rho.studio',revision:hash('studio'),artifact:hash('studio-artifact'),instance:'studio-instance'},contribution:'studio',state:{}},query:async(cap,args)=>{
   let data;
   if(cap.id==='scenarios.get')data=scenes.get(args.revision);
   else if(cap.id==='scenarios.list')data={scenarios:[{scenario:'reports',revision:head,name:'Report comparison'}],next:null};
   else if(cap.id==='plugins.inspect')data={summary:{plugin:'example.report',revision:args.revision},artifacts:[{id:args.revision===old?artifact:nextArtifact,target:'ui-web'}]};
   else if(cap.id==='plugins.instance')data=instances.get(args.instance.instance);
   else if(cap.id==='views.inspect')data=views.get(args.view);
   else if(cap.id==='windows.scenario')data=current;
   else if(cap.id==='scenarios.prepare'){if(args.expected_layout_version!==current.layout.version)throw Error('layout changed');data=application(args);}
   else if(cap.id==='operation.get')data={record:records.find(r=>r.operation.operation_id===args.operation_id)};
   else if(cap.id==='operation.list_recent')data={operations:records.filter(r=>r.operation.client_request_id===args.client_request_id).map(r=>({operation_id:r.operation.operation_id}))};
   else throw Error(cap.id);
   return{status:'ready',data:structuredClone(data)};
 },operation:async id=>structuredClone(records.find(r=>r.operation.operation_id===id)),invoke:async(cap,args,options)=>{
   assert.equal(saved.pending.intent.request,options.requestId,'scenario intent acknowledged before mutation');calls.push(cap.id);
   if(fault==='reject')throw new ViewRequestError('native precondition changed',{code:'content_changed'});
   const request=await operationRequestId(client.view.view,options.requestId);let record=records.find(r=>r.operation.client_request_id===request);
   if(!record){let output;
     if(cap.id==='scenarios.checkpoint'){
       assert.equal(args.expected_head,head,'checkpoint advances captured head');const {expected_head,...body}=structuredClone(args);output={...body,id:hash('checkpoint-'+records.length),parent:expected_head,project:'project'};head=output.id;scenes.set(head,output);
     }else if(cap.id==='plugins.activate'){
       output=observation({plugin:'example.report',revision:args.revision,artifact:args.artifact,instance:'instance-'+records.length},args.alias);instances.set(output.instance.identity.instance,output);
     }else if(cap.id==='views.open'){
       output=view(args.instance,'view-'+records.length,args.state);views.set(output.view,output);
     }else if(cap.id==='scenarios.apply'){if(args.expected_layout_version!==current.layout.version)throw new ViewRequestError('layout changed',{code:'content_changed'});output=current=application(args);}
     else throw Error(cap.id);
     record={operation:{operation_id:'operation-'+records.length,caller:{kind:'plugin',id:client.view.view},client_request_id:request,capability:cap,normalized_arguments:structuredClone(args),preconditions:[]},status:'succeeded',outcome:'succeeded',output:structuredClone(output),error:null};records.push(record);
   }
   if(fault==='lost')throw Error('acknowledgement lost');
   if(fault==='mismatch')return{...record,operation:{...record.operation,caller:{kind:'plugin',id:'foreign'}}};
   return structuredClone(record);
 }};
 function application(args){return{scenario:{window:'window',project:'project',principal:'user',revision:args.revision,instances:structuredClone(args.instances),views:structuredClone(args.views),providers:[],applied_layout_version:args.expected_layout_version+1},layout:{...current.layout,version:args.expected_layout_version+1,layout:{kind:'tabs',id:'reports',views:Object.values(args.views),selected:Object.values(args.views)[0]}}};}
 function controller(){let value;value=new ScenarioApplication(client,async()=>{if(saveFault||fault==='final-save'&&!value.data.pending)throw Error('save unconfirmed');saved=structuredClone(value.data);},()=>{});return value;}
 app=controller();await app.select(initial.id,'example.report');assert.equal(calls.length,0);assert.equal(app.data.states,'{\n  "report-view": {}\n}');
 await assert.rejects(app.stage(next,nextArtifact,null),/Preview or test/);app.data.states='{}';await assert.rejects(app.stage(next,nextArtifact,{revision:next,artifact:nextArtifact}),/every view/);
 app.data.states=JSON.stringify({'report-view':{text:'New state'}});await app.stage(next,nextArtifact,{revision:next,artifact:nextArtifact});assert.equal(calls.length,0);assert.equal(app.data.draft.layout.views[0].state_revision,next);
 saveFault=true;await assert.rejects(app.saveCheckpoint(),/save unconfirmed/);assert.equal(calls.length,0);saveFault=false;
 fault='lost';await assert.rejects(app.dispatch(),/acknowledgement lost/);const originalSaved=structuredClone(saved);assert.equal(current.scenario.revision,initial.id);
 app=controller();app.restore(originalSaved);client.view.view='replacement';await assert.rejects(app.dispatch(),/Only the original view/);fault=null;await app.recover();assert.equal(records.length,1);assert.equal(app.data.saved.id,head);client.view.view='studio';
 fault='lost';await assert.rejects(app.prepare(),/acknowledgement lost/);assert.equal(records.length,2);assert.equal(views.size,2,'lost activation does not create later views');
 app=controller();app.restore(saved);fault=null;await app.recover();assert.equal(records.length,2,'recovery only inspects original activation');assert.equal(current.scenario.revision,initial.id);
 await app.prepare();assert.equal(records.length,3);assert.equal(app.data.preparation.ready,true);assert.deepEqual(views.get('old-view').state,{text:'Unsaved old draft 中文 Ω'});
 const preparedView=app.data.preparation.request.views['report-view'];assert.deepEqual(views.get(preparedView).state,{text:'New state'});
 current.layout.version++;await assert.rejects(app.apply(),/layout changed/);assert.equal(app.data.pending,null);assert.equal(app.data.preparation.ready,false);assert.equal(current.scenario.revision,initial.id);
 await app.restartPreparation();await app.prepare();assert.equal(records.length,3,'refresh reuses prepared exact instances and views');
 fault='lost';await assert.rejects(app.apply(),/acknowledgement lost/);assert.equal(current.scenario.revision,head);app=controller();app.restore(saved);fault=null;await app.recover();assert.equal(records.length,4);assert.equal(app.data.applied.scenario.revision,head);
 const newer=head;await app.restoreCheckpoint(initial.id);assert.notEqual(head,initial.id);assert.notEqual(head,newer);assert.equal(scenes.get(head).parent,newer);assert.equal(current.scenario.revision,newer,'restoring history only saves a new checkpoint');
 await app.prepare();assert.equal(app.data.preparation.request.instances.report.instance,reference.instance);assert.equal(app.data.preparation.request.views['report-view'],'old-view');assert.equal(records.length,5,'historical live view reused with its latest draft');
 fault='final-save';await assert.rejects(app.apply(),/save unconfirmed/);assert.ok(app.data.pending,'failed final persistence retains original application');fault=null;await app.recover();assert.equal(records.length,6);assert.equal(current.scenario.revision,head);assert.deepEqual(views.get('old-view').state,{text:'Unsaved old draft 中文 Ω'});
 await app.select(head,'example.report');await app.stage(next,nextArtifact,{revision:next,artifact:nextArtifact});fault='mismatch';await assert.rejects(app.saveCheckpoint(),/original source request/);assert.ok(app.data.pending);fault=null;
 const uncertain=records.at(-1);uncertain.status=uncertain.outcome='uncertain';uncertain.output=null;await assert.rejects(app.recover(),/uncertain/);assert.ok(app.data.pending);await assert.rejects(app.select(initial.id,'example.report'),/original scenario/);
 const {Studio}=await module('model');const owner=new Studio(client);owner.application.restore(app.data);
 let synchronized;owner.drafts.save=async body=>{synchronized=body;};await owner.flush();
 const reopened=new Studio(client);reopened.drafts.read=async()=>synchronized;await reopened.open();assert.ok(reopened.application.data.pending);
 await assert.rejects(reopened.select(next),/original unconfirmed/);await assert.rejects(reopened.development.configure(next),/scenario or draft/);await assert.rejects(reopened.development.testing.configure('example.report',next,nextArtifact,{}),/scenario or draft/);
 uncertain.status=uncertain.outcome='failed';await assert.rejects(app.recover(),/failed/);assert.equal(app.data.pending,null);
 assert.equal(instances.get(reference.instance).instance.state,'active');assert.equal(views.get('old-view').closed,false);assert.ok(!calls.includes('views.close')&&!calls.includes('plugins.release'));
 console.log('Studio scenarios: explicit preview/state, head and window CAS, acknowledged intents, no speculative continuation, replacement-view recovery, partial preparation reuse, history restoration and retained live drafts passed.');
}
