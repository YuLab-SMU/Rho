import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export async function testDevelopment(module, operationRequestId, ViewRequestError) {
  const {Development}=await module('development');
  const digest=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
  const revision=digest('source'),artifact=digest('artifact');
  let saved=null,records=[],calls=[],fault=null,saveFault=false,preview=null,view=null;
  const client={view:{view:'studio',window:'window',project:'project',principal:'user'},
    operation:async id=>structuredClone(records.find(r=>r.operation.operation_id===id)),
    cancel:async id=>({accepted:true,operation:structuredClone(records.find(r=>r.operation.operation_id===id))}),
    query:async(cap,args)=>{
      let data;
      if(cap.id==='plugins.inspect')data={summary:{revision},artifacts:[{id:artifact}],manifest:{default_configuration:{theme:'light'},views:[{id:'main'}]}};
      else if(cap.id==='plugins.instance')data=preview;
      else if(cap.id==='views.inspect')data=view;
      else if(cap.id==='windows.layout')data={window:'window',project:'project',principal:'user',version:4,layout:{kind:'tabs',id:'group',views:['studio'],selected:'studio'}};
      else if(cap.id==='operation.get')data={record:records.find(r=>r.operation.operation_id===args.operation_id)};
      else if(cap.id==='operation.list_recent')data={operations:records.filter(r=>r.operation.client_request_id===args.client_request_id).map(r=>({operation_id:r.operation.operation_id}))};
      else throw Error(cap.id);
      return{status:'ready',data:structuredClone(data)};
    },
    invoke:async(cap,args,options)=>{
      assert.equal(saved.pending.request,options.requestId,'intent must be durably acknowledged first');calls.push(cap.id);
      if(fault==='reject')throw new ViewRequestError('native refusal',{code:'invalid_input'});
      const request=await operationRequestId(client.view.view,options.requestId);
      let record=records.find(r=>r.operation.client_request_id===request);
      if(!record){
        const id='operation-'+records.length;let output;
        if(cap.id==='plugins.build')output={operation_id:id,revision:args.revision,artifact,process:{termination:'exited',exit_code:0},diagnostic:null};
        else if(cap.id==='plugins.preview')output=preview={instance:{identity:{instance:'preview',plugin:'example.preview',revision:args.revision,artifact:args.artifact},purpose:'fixture_preview',project:'project',principal:'user',alias:args.alias,configuration:args.configuration,state:'active',diagnostic:null},observed_in_this_host:true,process_id:null,retained_calls:0,pending_messages:0,stderr:null};
        else if(cap.id==='windows.open_view'){view={...args.view,view:'preview-view',project:'project',principal:'user',purpose:'fixture_preview',state_version:0,closed:false};output={view,layout:{version:5}};}
        else if(cap.id==='views.close'){view={...view,closed:true};output=view;}
        else if(cap.id==='plugins.release'){preview={...preview,instance:{...preview.instance,state:'released'}};output=preview;}
        else throw Error(cap.id);
        record={operation:{operation_id:id,caller:{kind:'plugin',id:client.view.view},client_request_id:request,capability:cap,normalized_arguments:structuredClone(args),preconditions:[]},status:'succeeded',outcome:'succeeded',output:structuredClone(output),error:null};records.push(record);
      }
      if(fault==='lost')throw Error('acknowledgement lost');
      if(fault==='accepted'){record.status='running';record.outcome=null;return structuredClone(record);}
      if(fault==='mismatch')return{...record,operation:{...record.operation,caller:{kind:'plugin',id:'foreign'}}};
      return structuredClone(record);
    }};
  function controller(){let dev;dev=new Development(client,async()=>{if(saveFault||fault==='final-save'&&!dev.data.pending&&preview?.instance.state==='released')throw Error('draft save unconfirmed');saved=structuredClone(dev.data);},()=>{});return dev;}
  let dev=controller();await dev.configure(revision);assert.equal(calls.length,0,'configuration only observes metadata');
  dev.data.inputs.queries='invalid JSON';await assert.rejects(dev.startPreview());assert.equal(calls.length,0);assert.equal(dev.data.inputs.queries,'invalid JSON');dev.data.inputs.queries='[]';
  saveFault=true;await assert.rejects(dev.build(revision),/save unconfirmed/);assert.equal(calls.length,0);saveFault=false;
  // The captured request can be submitted only under its original view identity.
  await dev.dispatch();assert.equal(dev.data.build.output.artifact,artifact);assert.equal(dev.data.pending,null);
  fault='accepted';await dev.build(revision);assert.ok(dev.data.pending.operation);fault=null;await dev.stopBuild();assert.equal(dev.data.stopRequested,dev.data.pending.operation);assert.ok(dev.data.pending,'requesting cancellation is not confirmed native stop');records.at(-1).status='succeeded';records.at(-1).outcome='succeeded';await dev.recover();assert.equal(calls.length,2);
  fault='lost';await assert.rejects(dev.startPreview(),/acknowledgement lost/);assert.ok(dev.data.pending);const total=records.length;
  dev=controller();await dev.restore(saved);assert.equal(calls.length,3,'reopen does not replay a native request');
  client.view.view='replacement';await assert.rejects(dev.dispatch(),/Only the original view/);fault=null;await dev.recover();assert.equal(records.length,total);assert.equal(dev.data.preview.instance.instance.purpose,'fixture_preview');
  client.view.view='studio';
  await assert.rejects(dev.startPreview(),/Close and release/);
  fault='reject';await assert.rejects(dev.openPreview(),/native refusal/);assert.equal(dev.data.pending,null);assert.ok(dev.data.preview);assert.equal(dev.data.preview.view,null);assert.equal(calls.filter(id=>id==='plugins.preview').length,1,'a refused view keeps its original preview instance');fault=null;await dev.openPreview();assert.equal(dev.data.preview.view.view,'preview-view');
  assert.equal(records.at(-1).operation.normalized_arguments.group,'group');assert.equal(records.at(-1).operation.normalized_arguments.expected_layout_version,4);
  await assert.rejects(dev.releasePreview(),/Close the preview/);
  await dev.closePreview();assert.equal(dev.data.preview.view.closed,true);assert.equal(records.at(-1).operation.normalized_arguments.mode.kind,'flush');
  fault='final-save';await assert.rejects(dev.releasePreview(),/save unconfirmed/);assert.ok(dev.data.pending);assert.ok(dev.data.preview,'unconfirmed final draft keeps the exact lifecycle target for recovery');
  fault=null;await dev.recover();assert.equal(dev.data.pending,null);assert.equal(dev.data.preview,null);
  fault='reject';await assert.rejects(dev.build(revision),/native refusal/);assert.equal(dev.data.pending,null);fault=null;
  fault='mismatch';await assert.rejects(dev.build(revision),/original plugin request/);assert.ok(dev.data.pending);fault=null;await dev.recover();
  fault='lost';await assert.rejects(dev.build(revision),/acknowledgement lost/);fault=null;
  const uncertain=records.at(-1);uncertain.status='uncertain';uncertain.outcome='uncertain';uncertain.output.artifact=null;uncertain.output.process.termination='uncertain';
  await assert.rejects(dev.recover(),/uncertain/);assert.ok(dev.data.pending);assert.equal(dev.data.build.status,'uncertain');
  await assert.rejects(dev.build(revision),/original development request/);
  uncertain.status='failed';uncertain.outcome='failed';await assert.rejects(dev.recover(),/failed/);assert.equal(dev.data.pending,null);
  // A success-shaped response for another source never becomes a preview candidate.
  fault='lost';await assert.rejects(dev.build(revision),/acknowledgement lost/);fault=null;records.at(-1).output.revision=digest('other-source');
  await assert.rejects(dev.recover(),/differs from its original source/);assert.ok(dev.data.pending);
  console.log('Studio development: exact builds, retained fixture lifecycle, native refusals, asynchronous/lost acknowledgements, replacement-view recovery and uncertain outcomes passed.');
}
