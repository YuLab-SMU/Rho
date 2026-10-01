import assert from 'node:assert/strict';

export async function checkEditorFormat({readFormattedCode,sdk}) {
  const clone=value=>structuredClone(value),encode=value=>new TextEncoder().encode(value);
  const owner={plugin:'org.rho.r',instance:'native-r',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)};
  const make=async({input='x=1',code='x <- 1',retained=false,reportChange=()=>{},raw=null}={})=>{
    const value={code,tool_version:'fixture',changed:code!==input};
    const report={session_id:'session',outcome:'succeeded',error:null,value};reportChange(report);
    const body=raw??encode(JSON.stringify(report));
    const reference={owner:clone(owner),resource:'report',digest:(await sdk.captureDraftContent(body)).content.digest,bytes:body.length,media_type:'application/json'};
    const intent={view:'editor',request:'format-original',operation:'format-operation',capability:{id:'r.format',version:1},arguments:{
      binding:{provider:clone(owner),project:'project',capability:{id:'r.format',version:1},target:'session'},
      arguments:{expected_session:'session',code:input,source:{view_id:'editor',label:'分析.R',kind:'format'}},preconditions:null}};
    const record={operation:{operation_id:intent.operation,caller:{kind:'plugin',id:intent.view},client_request_id:await sdk.operationRequestId(intent.view,intent.request),
      capability:clone(intent.capability),normalized_arguments:clone(intent.arguments),preconditions:[]},status:'succeeded',outcome:'succeeded',error:null,
      output:{operation_id:intent.operation,session_id:'session',source:clone(intent.arguments.arguments.source),output_mode:null,
        value_in_report:retained,value:retained?null:clone(value),report:reference}};
    const state={reads:0,change:()=>{}};
    const client={view:{project:'project'},query:async(cap,args)=>{
      assert.deepEqual(cap,{id:'resources.read',version:1});assert.deepEqual(args.reference,reference);state.reads++;
      const end=Math.min(args.offset+args.limit,body.length),part={reference:clone(reference),offset:args.offset,base64:Buffer.from(body.slice(args.offset,end)).toString('base64'),next:end===body.length?null:end};
      state.change(part);return{status:'ready',data:part};
    }};
    return{client,intent,record,state,value};
  };
  const inline=await make();assert.deepEqual(await readFormattedCode(inline.client,inline.record,inline.intent),inline.value);assert.equal(inline.state.reads,0);
  const empty=await make({input:'',code:''});assert.deepEqual(await readFormattedCode(empty.client,empty.record,empty.intent),empty.value);
  const large=await make({input:'# 注释\n'.repeat(6000),code:'# 注释\nx <- 1\n'.repeat(6000),retained:true,
    reportChange:report=>{report.stdout='bounded event log\n'.repeat(20000);}});
  assert.deepEqual(await readFormattedCode(large.client,large.record,large.intent),large.value);assert.ok(large.state.reads>1,'read complete retained report across page boundaries');
  for(const mutate of [
    f=>f.record.operation.caller.id='other',f=>f.record.operation.client_request_id='other',
    f=>f.record.operation.operation_id='other',f=>f.record.operation.normalized_arguments.arguments.code='another input',
    f=>delete f.intent.arguments.preconditions,
    f=>f.record.operation.preconditions=[{kind:'unexpected'}],
    f=>{f.record.status='accepted';f.record.outcome=null;},f=>{f.record.status=f.record.outcome='uncertain';},
    f=>f.record.output.operation_id='other',f=>f.record.output.session_id='other',f=>f.record.output.source.label='other.R',
    f=>f.record.output.report.owner.instance='other',f=>f.record.output.report.media_type='text/plain',
    f=>f.record.output.output_mode='console',f=>f.record.output.value_in_report='true',
    f=>f.record.output.value.changed=false,f=>f.record.output.value.code='x\0y',f=>f.record.output.value.code='中'.repeat(50000),
    f=>f.record.output.value.tool_version='',f=>f.record.output.value.tool_version='中'.repeat(100),
    f=>{f.record.output.value_in_report=true;},
  ]) { const f=await make();mutate(f);await assert.rejects(readFormattedCode(f.client,f.record,f.intent));assert.equal(f.state.reads,0); }
  for(const mutate of [
    args=>args.binding.project='other',args=>args.binding.target='other',args=>args.binding.capability.version=2,
    args=>args.arguments.code='中'.repeat(22000),args=>args.arguments.code='x\0y',args=>args.arguments.expected_session=null,
  ]) { const f=await make();mutate(f.intent.arguments);f.record.operation.normalized_arguments=clone(f.intent.arguments);
    await assert.rejects(readFormattedCode(f.client,f.record,f.intent));assert.equal(f.state.reads,0); }
  for(const reportChange of [report=>report.session_id='other',report=>report.outcome='failed',report=>report.error='original error',
    report=>report.value.changed=false,report=>report.value=null]) {
    const f=await make({retained:true,reportChange});await assert.rejects(readFormattedCode(f.client,f.record,f.intent));assert.equal(f.state.reads,1);
  }
  for(const raw of [new Uint8Array([255]),encode('{incomplete')]) {
    const f=await make({retained:true,raw});await assert.rejects(readFormattedCode(f.client,f.record,f.intent));
  }
  for(const change of [part=>part.reference.digest='sha256:'+'f'.repeat(64),part=>part.offset++,part=>part.next=0,
    part=>{part.base64=Buffer.from('x'.repeat(Buffer.from(part.base64,'base64').length)).toString('base64');}]) {
    const f=await make({retained:true});f.state.change=change;await assert.rejects(readFormattedCode(f.client,f.record,f.intent));
  }
  const over=await make({retained:true});over.record.output.report.bytes=16*1024*1024+1;
  await assert.rejects(readFormattedCode(over.client,over.record,over.intent),/byte limit/);assert.equal(over.state.reads,0);
  const frozen=await make({retained:true}),reading=readFormattedCode(frozen.client,frozen.record,frozen.intent);
  frozen.record.output.session_id='changed';frozen.intent.arguments.arguments.code='changed';
  assert.deepEqual(await reading,frozen.value,'caller mutations after capture cannot replace original input or result');
  console.log('Editor formatting reader checks passed: exact original request/session/source, inline and complete retained text, quotas, frozen inputs, corrupt bytes and failed-result refusal.');
}
