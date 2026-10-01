// A local ACP peer; actual Agent/MCP/Host/Environment and R execute every tool.
module.exports=async({cwd,sendRequest,catalog,rpc,save,session,prompts})=>{
  const assert=require('node:assert/strict');
  const fs=require('node:fs'),path=require('node:path');
  const {randomUUID,createHash}=require('node:crypto');
  const input=JSON.parse(fs.readFileSync(path.join(cwd,'native-environment-input.json'),'utf8'));
  const names=[...input.names,...(input.mode==='readonly'?[]:['read'])];
  assert.deepEqual(catalog.structuredContent.tools.map(t=>t.selection.name),names);
  for(const tool of catalog.structuredContent.tools.filter(t=>t.selection.name!=='read'))assert.deepEqual(tool.selection.target.binding.provider,input.provider);
  const invocation=(tool,args)=>({send_request:sendRequest,tool_request:randomUUID(),tool,arguments:args,preconditions:null});
  const call=request=>rpc('tools/call',{name:'rho_call',arguments:request});
  const result=async(name,args)=>{
    const reply=await call(invocation(name,args));assert.notEqual(reply.isError,true,JSON.stringify(reply));return reply.structuredContent.result;
  };
  const evidence={session,prompts,send_request:sendRequest,mode:input.mode,operations:[]};
  const planArgs={manager:'pak',packages:['local::pkg']};
  if(input.mode==='readonly') {
    const observed=await call(invocation('observe',{limit:10}));
    assert.equal(observed.isError,true,'Unavailable inventory must remain partial, not be promoted to success');
    assert.equal(observed.structuredContent.result.completeness,'partial');
    assert.equal(observed.structuredContent.result.data.status,'unavailable');
    const prepared=await result('prepare_plan',{capability:{id:'environment.plan',version:2},arguments:planArgs,target:null,preconditions:[]});
    assert.deepEqual(prepared.data.arguments.packages,planArgs.packages);
    await rpc('tools/call',{name:'rho_call',arguments:invocation('plan',planArgs)},randomUUID(),-32602);
    save({...evidence,unselected_plan_refused:true});return;
  }
  const resource=async reference=>{
    assert.deepEqual(reference.owner,input.provider);
    const chunks=[];let offset=0;
    do {
      const page=(await result('read',{reference,offset,limit:65536})).data;
      assert.deepEqual(page.reference,reference);assert.equal(page.offset,offset);
      chunks.push(Buffer.from(page.base64,'base64'));
      if(page.next==null)break;assert.ok(page.next>offset);offset=page.next;
    }while(chunks.length<16);
    const bytes=Buffer.concat(chunks);assert.equal(bytes.length,reference.bytes);
    assert.equal('sha256:'+createHash('sha256').update(bytes).digest('hex'),reference.digest);
    return JSON.parse(bytes);
  };
  const operation=async(name,args,status='succeeded')=>{
    const request=invocation(name,args);
    const reply=await call(request);assert.equal(reply.isError===true,status!=='succeeded',JSON.stringify(reply));
    assert.equal(reply.structuredContent.result.status,status,JSON.stringify(reply));
    const loads=path.join(cwd,'namespace-loads.txt');
    const loadedBefore=fs.existsSync(loads)?fs.readFileSync(loads,'utf8'):null;
    assert.deepEqual(await call(request),reply,'Tool retry must retain the original operation and not launch R again');
    assert.equal(fs.existsSync(loads)?fs.readFileSync(loads,'utf8'):null,loadedBefore,'Tool replay cannot load the namespace again');
    const value=reply.structuredContent.result;
    evidence.operations.push({name,invocation:request,result:value});save(evidence);
    return {value,report:await resource(value.output.report)};
  };
  if(input.mode==='tampered') {
    const verified=await operation('verify',{realization_operation_id:input.realization},'failed');
    assert.equal(verified.value.output.verified,false);assert.equal(verified.report.library_digest_matches,false);
    save({...evidence,verification:verified.report});return;
  }
  await rpc('tools/call',{name:'rho_call',arguments:invocation('plan',{...planArgs,binding:{provider:'forged'}})},randomUUID(),-32602);
  const refresh=await operation('refresh',{});assert.equal(refresh.value.output.kind,'configuration');
  const planned=await operation('plan',planArgs);
  assert.equal(planned.report.project_root,input.project);assert.equal(planned.report.packages[0].name,'rhonextfixture');
  const realized=await operation('realize',{plan_operation_id:planned.value.operation_id});
  assert.equal(realized.report.verified,true);assert.equal(realized.report.plan_operation_id,planned.value.operation_id);
  assert.ok(realized.report.library_path.startsWith(input.materials+path.sep));
  assert.equal(realized.report.activation,'available_not_active');
  const verified=await operation('verify',{realization_operation_id:realized.value.operation_id});
  assert.equal(verified.report.verified,true);assert.equal(verified.report.library_digest_matches,true);
  const inventoryReply=await call(invocation('observe',{realization_operation_id:realized.value.operation_id,limit:10}));
  assert.equal(inventoryReply.isError,true,'Cached Environment configuration retains its partial observation label');
  assert.equal(inventoryReply.structuredContent.result.completeness,'partial');
  const inventory=inventoryReply.structuredContent.result.data;
  assert.equal(inventory.status,'ready');assert.equal(inventory.observation.packages[0].name,'rhonextfixture');
  const library=(await result('library',{realization_operation_id:realized.value.operation_id})).data;
  assert.equal(library.realization,realized.value.operation_id);assert.deepEqual(library.source.provider,input.provider);
  assert.equal(library.library_path,realized.report.library_path);
  save({...evidence,library,inventory:inventoryReply.structuredContent.result,verification:verified.report,forged_binding_refused:true});
};
