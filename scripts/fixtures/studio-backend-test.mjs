import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export async function testBackendTest(module, operationRequestId, ViewRequestError) {
  const {Development}=await module('development');
  const digest=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
  const revision=digest('source'),artifact=digest('artifact'),identity={plugin:'example.backend',revision,artifact,instance:'native-instance'};
  let saved=null, records=[], calls=[], fault=null, saveFault=false, project=null, view=null, generation=0, navigation=[];
  const client={view:{view:'studio',window:'window',project:'analysis',principal:'user'},
    testProject:id=>{assert.equal(id,project?.project.id);return {query:(cap,args)=>query(id,cap,args),invoke:(cap,args,options)=>invoke(id,cap,args,options),operation:async id=>structuredClone(records.find(r=>r.operation.operation_id===id))};},
    openTestWorkspace:async id=>{navigation.push(id);return{navigation_requested:true};},
    query:(cap,args)=>query(null,cap,args),invoke:(cap,args,options)=>invoke(null,cap,args,options),
    operation:async id=>structuredClone(records.find(r=>r.operation.operation_id===id))};
  async function query(target,cap,args) {
    let data;
    if(cap.id==='plugins.test_project'){assert.equal(target,null);assert.equal(args.id,project.project.id);data=project;}
    else if(cap.id==='plugins.test_operation'){assert.equal(target,null);assert.equal(args.id,project.project.id);data={record:records.find(r=>r.target===args.id&&r.operation.operation_id===args.operation_id)};}
    else if(cap.id==='windows.layout'){assert.equal(target,project.project.id);data={window:'window',project:project.project.project,principal:'user',version:4,layout:{kind:'tabs',id:'test-group',views:[],selected:null}};}
    else if(cap.id==='views.inspect'){assert.equal(target,project.project.id);assert.equal(args.view,view.view);data=view;}
    else if(cap.id==='operation.get')data={record:records.find(r=>r.target===target&&r.operation.operation_id===args.operation_id)};
    else if(cap.id==='operation.list_recent')data={operations:records.filter(r=>r.target===target&&r.operation.client_request_id===args.client_request_id).map(r=>({operation_id:r.operation.operation_id}))};
    else throw Error(cap.id);
    return{status:'ready',data:structuredClone(data)};
  }
  async function invoke(target,cap,args,options) {
    assert.equal(saved.testing.pending.intent.request,options.requestId,'test intent saved before native dispatch');
    assert.equal(saved.testing.pending.testProject,target,'exact original Host selected before dispatch');calls.push({target,id:cap.id});
    if(fault==='reject')throw new ViewRequestError('native refusal',{code:'invalid_input'});
    const request=await operationRequestId(client.view.view,options.requestId);
    let record=records.find(r=>r.target===target&&r.operation.client_request_id===request);
    if(!record){
      const id='operation-'+records.length;let output;
      if(cap.id==='plugins.test_create') {
        assert.equal(target,null);generation++;
        output=project={project:{id:'test-'+generation,source_project:'analysis',principal:'user',source_operation_id:id,project:'child-'+generation,directory:'/temporary/test-'+generation,selection:structuredClone(args),version:0,state:'ready',instances:{subject:identity},activation_operations:{subject:'activation-'+generation},diagnostic:null},observed_in_this_host:true};
      } else if(cap.id==='plugins.test_stop') {
        assert.equal(target,null);assert.equal(args.id,project.project.id);assert.equal(args.expected_version,project.project.version);
        output=project={...project,project:{...project.project,state:'stopped',version:project.project.version+1},observed_in_this_host:false};
      } else if(cap.id==='windows.open_view') {
        assert.equal(target,project.project.id);assert.equal(args.group,'test-group');
        view={...args.view,view:'test-view-'+generation,project:project.project.project,principal:'user',state_version:0,closed:false,purpose:'runtime'};output={view,layout:{version:5}};
      } else if(cap.id==='views.close') {
        assert.equal(target,project.project.id);assert.equal(args.view,view.view);output=view={...view,closed:true};
      } else throw Error(cap.id);
      record={target,operation:{operation_id:id,caller:{kind:'plugin',id:client.view.view},client_request_id:request,capability:cap,normalized_arguments:structuredClone(args),preconditions:[]},status:'succeeded',outcome:'succeeded',output:structuredClone(output),error:null};records.push(record);
    }
    if(fault==='lost')throw Error('acknowledgement lost');
    if(fault==='failed-create'){
      project.project.state='failed';project.project.diagnostic='activation failed';record.status=record.outcome='failed';record.output=null;record.error='activation failed';record.recovery={kind:'plugin_test_project',test_project:project.project.id};
    }
    if(fault==='mismatch')return{...record,operation:{...record.operation,caller:{kind:'plugin',id:'foreign'}}};
    return structuredClone(record);
  }
  function controller(){let dev;dev=new Development(client,async()=>{if(saveFault||fault==='final-save'&&!dev.testing.data.pending&&project?.project.state==='stopped')throw Error('draft save unconfirmed');saved=structuredClone(dev.data);},()=>{});return dev;}
  let dev=controller(),testing=dev.testing;
  await testing.configure(identity.plugin,revision,artifact,{});assert.equal(calls.length,0);
  testing.data.inputs.instances='invalid JSON';await assert.rejects(testing.create(revision,artifact));assert.equal(calls.length,0);await testing.configure(identity.plugin,revision,artifact,{});
  await assert.rejects(testing.create(digest('different'),artifact),/selected source/);
  saveFault=true;await assert.rejects(testing.create(revision,artifact),/save unconfirmed/);assert.equal(calls.length,0);saveFault=false;
  fault='lost';await assert.rejects(testing.dispatch(),/acknowledgement lost/);assert.equal(records.length,1);
  dev=controller();await dev.restore(saved);testing=dev.testing;assert.equal(calls.length,1,'restoring a draft never replays test work');
  client.view.view='replacement';await assert.rejects(testing.dispatch(),/Only the original view/);fault=null;await testing.recover();assert.equal(records.length,1);assert.equal(testing.data.project.project.id,'test-1');
  await assert.rejects(testing.create(revision,artifact),/Stop the retained/);
  await testing.openWindow();assert.deepEqual(navigation,['test-1']);
  fault='lost';await assert.rejects(testing.openView('main',{title:'Test'},{}),/acknowledgement lost/);assert.equal(testing.data.pending.testProject,'test-1');
  const before=calls.length;await assert.rejects(dev.build(revision),/original development request/);await assert.rejects(testing.configure(identity.plugin,revision,artifact,{}),/original backend-test/);assert.equal(calls.length,before);
  client.view.view='next';fault=null;await testing.recover();assert.equal(testing.data.view.view,'test-view-1');assert.equal(calls.length,before);
  // Known child IDs can still be inspected in the original journal if the child
  // stops elsewhere; never fall back to a same-ID operation in analysis.
  fault='lost';await assert.rejects(testing.closeView(true),/acknowledgement lost/);fault=null;
  testing.data.pending.intent.operation=records.at(-1).operation.operation_id;
  project.observed_in_this_host=false;await testing.recover();assert.equal(testing.data.view.closed,true);assert.equal(calls.length,before+1);
  assert.equal(records.at(-1).operation.normalized_arguments.mode.kind,'retain_acknowledged');
  project.observed_in_this_host=true;
  fault='final-save';await assert.rejects(testing.stop(),/save unconfirmed/);assert.ok(testing.data.pending);assert.equal(testing.data.project.project.state,'ready');fault=null;await testing.recover();assert.equal(testing.data.pending,null);assert.equal(testing.data.project.project.state,'stopped');
  assert.throws(()=>testing.openWindow(),/unavailable/);
  fault='reject';await assert.rejects(testing.create(revision,artifact),/native refusal/);assert.equal(testing.data.pending,null);assert.equal(testing.data.project.project.id,'test-1');
  fault='failed-create';await assert.rejects(testing.create(revision,artifact),/activation failed/);assert.equal(testing.data.project.project.state,'failed');assert.equal(testing.data.project.project.id,'test-2');assert.equal(testing.data.pending,null);
  fault=null;await testing.stop();
  fault='mismatch';await assert.rejects(testing.create(revision,artifact),/original plugin request/);assert.ok(testing.data.pending);fault=null;await testing.recover();assert.equal(testing.data.project.project.id,'test-3');
  fault='lost';await assert.rejects(testing.stop(),/acknowledgement lost/);fault=null;
  const uncertain=records.at(-1);uncertain.status=uncertain.outcome='uncertain';uncertain.output=null;
  await assert.rejects(testing.recover(),/uncertain/);assert.ok(testing.data.pending);await assert.rejects(testing.create(revision,artifact),/original backend-test/);
  uncertain.status=uncertain.outcome='failed';await assert.rejects(testing.recover(),/failed/);assert.equal(testing.data.pending,null);
  // Native unavailability is displayed as recorded state and never starts a new Host.
  project.observed_in_this_host=false;await testing.inspect();assert.equal(testing.data.project.observed_in_this_host,false);await assert.rejects(testing.openView('main',{},{}),/unavailable/);
  assert.equal(records.filter(r=>r.operation.capability.id==='plugins.test_create').length,3);
  console.log('Studio backend tests: explicit exact selection, acknowledged intent, child ports, lost results, replacement-view recovery, retained journals, failed activation, cleanup and uncertain outcomes passed.');
}
