// Deterministic ACP only. Agent/Host/Remote/OpenSSH/sshd and commands are real.
module.exports=async({cwd,sendRequest,catalog,rpc,save,session,prompts})=>{
  const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
  const {randomUUID,createHash}=require('node:crypto');
  const input=JSON.parse(fs.readFileSync(path.join(cwd,'native-remote-input.json'),'utf8'));
  const tools=catalog.structuredContent.tools;
  assert.deepEqual(tools.map(t=>t.selection.name),input.mode==='readonly'?['prepare']:['prepare','run','read']);
  assert.deepEqual(tools[0].selection.target.binding.provider,input.provider);
  const invocation=(tool,args)=>({send_request:sendRequest,tool_request:randomUUID(),tool,arguments:args,preconditions:null});
  const call=request=>rpc('tools/call',{name:'rho_call',arguments:request});
  const prepared=await call(invocation('prepare',{capability:{id:'process.run_remote',version:2},arguments:input.arguments,preconditions:[],target:null}));
  assert.notEqual(prepared.isError,true,JSON.stringify(prepared));
  const args=prepared.structuredContent.result.data.arguments;
  const evidence={session,prompts,send_request:sendRequest,mode:input.mode,prepared:prepared.structuredContent.result.data};
  if(input.mode==='readonly'){
    await rpc('tools/call',{name:'rho_call',arguments:invocation('run',args)},randomUUID(),-32602);
    save({...evidence,unselected_run_refused:true});return;
  }
  assert.deepEqual(tools[1].selection.target.binding.provider,input.provider);
  await rpc('tools/call',{name:'rho_call',arguments:invocation('run',{...args,target:{host_alias:'forged'}})},randomUUID(),-32602);
  const request=invocation('run',args);save({...evidence,invocation:request,forged_target_refused:true});
  const original=await call(request);
  if(input.mode==='uncertain'){
    assert.equal(original.isError,true);
    assert.match(original.structuredContent.error,/unconfirmed|confirmed terminal outcome|unresolved/i);
    assert.equal(original.structuredContent.result,undefined,'An uncertain child cannot be promoted to a confirmed tool result');
    save({...evidence,invocation:request,unconfirmed:true});return;
  }
  const expected=input.mode==='failed'?'failed':'succeeded';
  assert.equal(original.isError===true,expected==='failed',JSON.stringify(original));
  assert.equal(original.structuredContent.result.status,expected,JSON.stringify(original));
  if(input.mode==='stop')return;
  const before=fs.readFileSync(input.effect,'utf8');
  assert.deepEqual(await call(request),original);assert.equal(fs.readFileSync(input.effect,'utf8'),before);
  const reference=original.structuredContent.result.output.report;assert.deepEqual(reference.owner,input.provider);
  const chunks=[];let offset=0;
  do{
    const reply=await call(invocation('read',{reference,offset,limit:65536}));assert.notEqual(reply.isError,true,JSON.stringify(reply));
    const page=reply.structuredContent.result.data;assert.deepEqual(page.reference,reference);assert.equal(page.offset,offset);
    chunks.push(Buffer.from(page.base64,'base64'));if(page.next==null)break;assert.ok(page.next>offset);offset=page.next;
  }while(chunks.length<8);
  const bytes=Buffer.concat(chunks);assert.equal(bytes.length,reference.bytes);assert.equal('sha256:'+createHash('sha256').update(bytes).digest('hex'),reference.digest);
  const report=JSON.parse(bytes);assert.deepEqual(report.target,input.target);
  assert.equal(Buffer.from(report.transport.stdout.bytes).toString(),input.arguments.stdin);
  assert.equal(Buffer.from(report.transport.stderr.bytes).toString(),'SSH stderr 中文');
  assert.equal(report.transport.exit_code,input.mode==='failed'?9:0);
  save({...evidence,invocation:request,forged_target_refused:true,report,resource_verified:true});
};
