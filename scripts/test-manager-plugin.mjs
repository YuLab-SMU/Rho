import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildManagerPlugin} from './build-manager-plugin.mjs';
import {checkManagerArchive} from './fixtures/manager-archive.mjs';
import {checkManagerExport} from './fixtures/manager-export.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rho-manager-model-'));
try {
  const plugin=buildManagerPlugin(path.join(dir,'manager'));
  const {Manager,checkpointInput,matches,viewMatches}=await import(pathToFileURL(path.join(plugin,'dist/src/model.js')));
  const {operationRequestId,ViewRequestError}=await import(pathToFileURL(path.join(plugin,'dist/public/plugin-ui/index.js')));
  await checkManagerArchive({Manager,operationRequestId});
  await checkManagerExport({Manager,operationRequestId});
  const digest=n=>'sha256:'+n.repeat(64),identity={instance:'instance',plugin:'example.plugin',revision:digest('a'),artifact:digest('b')};
  const observed={instance:{identity,purpose:'runtime',configuration:{},state:'active',alias:'example'},observed_in_this_host:true};
  const definition={id:digest('c'),parent:null,scenario:'example',project:'project',name:'Example',instances:{example:{plugin:identity.plugin,revision:identity.revision,artifact:identity.artifact,configuration:{},dependencies:{}}},providers:[],
    layout:{kind:'tabs',id:'group',selected:'saved',views:[{id:'saved',instance:'example',contribution:'view',configuration:{},state:{text:'checkpoint'},state_revision:identity.revision,resource:null}]}};
  const live={view:'live',purpose:'runtime',instance:identity,window:'window',contribution:'view',configuration:{},state:{text:'new unsaved text'},closed:false};
  assert.equal(matches({...observed,instance:{...observed.instance,purpose:'fixture_preview'}},definition.instances.example),false,'a preview cannot satisfy a runtime selection');
  assert.equal(viewMatches({...live,purpose:'fixture_preview'},definition.layout.views[0],identity,'window'),false,'a preview cannot satisfy a scenario view');
  assert.equal(matches({...observed,instance:{...observed.instance,purpose:undefined}},definition.instances.example),true,'normal runtime messages omit the marker');
  assert.equal(viewMatches({...live,purpose:undefined},definition.layout.views[0],identity,'window'),true);
  const inspection={summary:{plugin:identity.plugin},artifacts:[{id:identity.artifact,target:'ui-web'}]};
  let saved=null,records=[],calls=[],fault=null,saveFault=false;
  const client={view:{view:'manager',window:'window'},setState:async value=>{if(saveFault)throw Error('state acknowledgement lost');saved=structuredClone(value);},
    query:async(cap,args)=>{
      calls.push({id:cap.id,args});
      if(cap.id==='views.inspect')return{status:'ready',data:live};
      if(cap.id==='scenarios.prepare')return{status:'ready',data:{}};
      if(cap.id==='operation.list_recent')return{status:'ready',data:{operations:records.filter(r=>r.operation.client_request_id===args.client_request_id).map(r=>({operation_id:r.operation.operation_id}))}};
      if(cap.id==='operation.get')return{status:'ready',data:{record:records.find(r=>r.operation.operation_id===args.operation_id)}};
      throw Error(cap.id);
    },operation:async id=>records.find(r=>r.operation.operation_id===id),
    async invoke(cap,args,options){
      assert.ok(saved.pending,'intent is durably saved before invocation');calls.push({id:cap.id,args,request:options.requestId});
      if(fault==='rejected')throw new ViewRequestError('stale layout',{code:'content_changed'});
      if(fault==='failed')throw Error('connection lost before any receipt');
      const request=await operationRequestId(this.view.view,options.requestId);
      let record=records.find(r=>r.operation.client_request_id===request);
      if(!record){record={operation:{operation_id:'operation-'+records.length,caller:{kind:'plugin',id:this.view.view},client_request_id:request,capability:cap,normalized_arguments:args,preconditions:[]},status:'succeeded',outcome:'succeeded',output:cap.id==='plugins.activate'?observed:cap.id==='views.open'?{...live,state:args.state}:{} };records.push(record);}
      if(fault==='lost')throw Error('acknowledgement lost');
      if(fault==='accepted')return{...structuredClone(record),status:'accepted',outcome:null,output:null};
      return structuredClone(record);
    }};
  let manager=new Manager(client);
  await manager.begin(definition,7);assert.deepEqual(calls,[],'review creates no runtime or scientific work');
  await manager.prepare(new Map([[identity.revision,inspection]]),{example:'instance'},{saved:'live'},[observed]);
  assert.deepEqual(calls.map(c=>c.id),['views.inspect','scenarios.prepare']);
  assert.equal(manager.state.preparation.request.views.saved,'live');assert.equal(live.state.text,'new unsaved text');
  await manager.apply();assert.equal(calls.at(-1).id,'scenarios.apply');assert.equal(calls.at(-1).args.expected_layout_version,7);
  assert.equal(manager.state.preparation.ready,false,'an applied prepared selection cannot be clicked twice');
  fault='accepted';await manager.invoke('plugins.branch',{revision:identity.revision,name:'My branch'});
  assert.equal(manager.state.pending,null,'normal asynchronous acceptance is observed to terminal status');fault=null;

  calls=[];await manager.begin(definition,8);
  await assert.rejects(manager.prepare(new Map(),{},{},[]),/Missing exact revision/);assert.deepEqual(calls,[],'all artifacts checked before any activation');
  fault='lost';await assert.rejects(manager.prepare(new Map([[identity.revision,inspection]]),{},{},[]),/acknowledgement lost/);
  assert.equal(manager.state.pending.intent.capability.id,'plugins.activate');const original=saved.pending.intent.request;
  assert.equal(records.filter(r=>r.operation.capability.id==='plugins.activate').length,1);
  manager=new Manager({...client,view:{view:'replacement',window:'window'}},saved);
  fault=null;await manager.recover();assert.equal(manager.state.preparation.request.instances.example.instance,'instance');
  assert.equal(manager.state.pending,null);assert.equal(calls.filter(c=>c.id==='views.open').length,0,'recovery never resumes later steps');
  await manager.prepare(new Map([[identity.revision,inspection]]),{},{},[]);
  assert.equal(calls.filter(c=>c.id==='plugins.activate').length,1,'recovered preparation does not activate twice');
  assert.equal(calls.filter(c=>c.id==='views.open').length,1);
  assert.equal(manager.state.preparation.request.expected_layout_version,8,'preparation does not refresh away a concurrent edit');

  manager=new Manager(client);fault='rejected';await assert.rejects(manager.invoke('scenarios.apply',{}),/stale layout/);assert.equal(manager.state.pending,null,'fresh native preparation rejection permits corrected input');
  fault='failed';await assert.rejects(manager.invoke('plugins.activate',{}),/connection lost/);assert.ok(manager.state.pending);
  const before=structuredClone(manager.state.pending);fault='rejected';await assert.rejects(manager.dispatch(),/stale layout/);
  assert.deepEqual(manager.state.pending,before,'rejection after a lost receipt does not discard original evidence');
  await assert.rejects(manager.recover(),/No unique original/);assert.ok(manager.state.pending);
  const replacement=new Manager({...client,view:{view:'other',window:'window'}},manager.state);
  await assert.rejects(replacement.dispatch(),/Only the original view/);

  manager=new Manager(client);fault=null;saveFault=true;
  const count=calls.length;await assert.rejects(manager.invoke('plugins.remove',{}),/state acknowledgement lost/);assert.equal(calls.length,count,'no dispatch if intent persistence is unconfirmed');saveFault=false;
  const normalized=checkpointInput({name:'draft',instances:{a:{optional_capabilities:[]}},providers:[{}],layout:{kind:'tabs',views:[{}]}});
  assert.equal(normalized.expected_head,null);assert.deepEqual(normalized.instances.a,{});assert.equal(normalized.providers[0].target,null);assert.equal(normalized.layout.views[0].resource,null);
  const unusual=structuredClone(definition);unusual.instances=Object.fromEntries([['__proto__',unusual.instances.example]]);unusual.layout.views[0].instance='__proto__';unusual.layout.views[0].id='constructor';
  manager=new Manager(client);await manager.begin(unusual,9);await manager.prepare(new Map([[identity.revision,inspection]]),Object.fromEntries([['__proto__','instance']]),{constructor:'live'},[observed]);
  assert.ok(Object.hasOwn(manager.state.preparation.request.instances,'__proto__'));assert.equal(manager.state.preparation.request.views.constructor,'live');
  assert.equal(Object.getPrototypeOf(manager.state.preparation.request.instances),Object.prototype,'native string identities cannot replace a dictionary prototype');
  assert.ok(original);console.log('Manager builds independently; explicit reuse, partial preparation, original recovery, stale versions and saved-intent boundaries pass.');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
