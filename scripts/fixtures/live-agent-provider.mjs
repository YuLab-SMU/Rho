// Opt-in real-provider acceptance on the current ordinary Agent/Host/R path.
// The ordinary ephemeral key Control port keeps secrets out of Operations/evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {liveProviderTrace} from './live-provider-trace.mjs';
import {liveAgentMatrix} from './live-agent-matrix.mjs';
import {liveAgentVision} from './live-agent-vision.mjs';

export async function liveAgentProvider({agent,r,project,scientificCase,image,matrix=false,port,query,invoke,binding,pluginQuery,report,save}) {
  const agentQuery=(id,args)=>pluginQuery(agent,id,args);
  const agentInvoke=async(id,args,request=randomUUID())=>invoke(id,{binding:await binding(agent,id),arguments:args},request);
  const answerFor=async run=>{
    let cursor=0,answer='';
    for(let page=0;cursor<run.event_cursor&&page<10;page++){
      const events=await agentQuery('agent.model.run.events',{run_id:run.run_id,after:cursor,limit:100});
      assert.equal(events.history_gap,false);assert.ok(events.cursor>cursor,'Event paging must advance');
      answer+=events.events.filter(event=>event.content.kind==='text').map(event=>event.content.text).join('');cursor=events.cursor;
    }
    assert.equal(cursor,run.event_cursor,'A partial transcript is not a pass');return answer;
  };
  let credential;
  const peer=process.env.RHO_LIVE_PROVIDER_TRACE==='1'?await liveProviderTrace(process.env.RHO_LIVE_PROVIDER_URL,report,save):null;
  const removeCredential=async()=>{
    if(!credential)return;
    const settings=await agentQuery('agent.model.settings',{});
    await port('control',{capability:{id:'agent.model.key.remove',version:1},arguments:{binding:await binding(agent,'agent.model.key.remove'),arguments:{key_id:credential.key_id,settings_version:settings.version}}});
    credential=null;
  };
  try {
  // Ordinary plugin backends intentionally do not inherit Host API-key variables.
  // Store only in this disposable Agent instance through its existing Control port.
  credential=await port('control',{capability:{id:'agent.model.key.store',version:1},arguments:{binding:await binding(agent,'agent.model.key.store'),
    arguments:{request_id:'live-provider-temporary-key',value:process.env[process.env.RHO_LIVE_PROVIDER_KEY_ENV]}}});
  const settings=(await agentInvoke('agent.model.configure',{
    version:(await agentQuery('agent.model.settings',{})).version,enabled:true,
    connection:{protocol:'anthropic',base_url:peer?.url??process.env.RHO_LIVE_PROVIDER_URL,model:process.env.RHO_LIVE_PROVIDER_MODEL,
      credential},
  })).output;
  if(matrix&&process.env.RHO_LIVE_MATRIX_CASES){
    // A targeted repair retains prior smoke evidence instead of paying for
    // another connection diagnostic and scientific-effect model loop.
    const session=scientificCase.report.session;
    const rBinding={...await query('plugins.resolve',{instance:r,capability:{id:'r.execute',version:2}}),target:session};
    await liveAgentMatrix({r,session,rBinding,scientificCase,settings,query,port,pluginQuery,agentQuery,agentInvoke,answerFor,peer,report,save});
    const retained=[];
    for(const attempt of report.matrix.attempts.filter(item=>item.run))retained.push({run:await agentQuery('agent.model.run.get',{run_id:attempt.run}),tools:await agentQuery('agent.model.run.tools',{run_id:attempt.run})});
    const calls=peer?.calls.length;
    report.status='targeted_assessment_recorded';save();
    return {async close(){try{await removeCredential();}finally{if(peer)await peer.close();}},async afterRestart(){
      const state=await query('plugins.instance',{instance:agent});assert.equal(state.instance.state,'suspended');
      assert.deepEqual((await invoke('plugins.resume',{instance:agent,suspension:state.instance.suspension})).output.instance.identity,agent);
      for(const item of retained){assert.deepEqual(await agentQuery('agent.model.run.get',{run_id:item.run.run_id}),item.run);assert.deepEqual(await agentQuery('agent.model.run.tools',{run_id:item.run.run_id}),item.tools);}
      if(peer)assert.equal(peer.calls.length,calls);
      report.targeted_restart_verified=true;save();
    }};
  }
  const diagnostic=(await agentInvoke('agent.model.test',{request_id:'live-provider-connection',model_settings_version:settings.version,kind:'connection'})).output;
  report.connection=diagnostic;save();
  if(diagnostic.state!=='passed'){
    report.preflight_warning=diagnostic.detail??diagnostic.state;save();
    // Record an exact-output quality failure, then assess the planned cases. A
    // protocol/transport failure still stops; the representative smoke exists.
    assert.ok(matrix&&diagnostic.detail==='Synthetic model assertion did not match',`Real provider diagnostic: ${diagnostic.state}; ${diagnostic.detail??''}`);
  }
  const session=scientificCase.report.session;
  const rBinding={...await query('plugins.resolve',{instance:r,capability:{id:'r.execute',version:2}}),target:session};
  const conversationId='live-provider-original-operation';
  const created=(await agentInvoke('agent.model.create',{conversation_id:conversationId,profile:'workspace'})).output;
  const selected=scientificCase.cases.find(item=>item.context.data.source.title.includes('annotation_object'))??scientificCase.cases[2];
  const sources=[{source:'plugin',label:selected.context.item.title,reference:selected.notePreview.reference,inclusion:JSON.stringify(selected.notePreview.inclusion)}];
  const filename='live-provider-counter.txt',marker=`rho-live-${randomUUID()}`;
  const code=`counter_path <- "${filename}"; counter_before <- if (file.exists(counter_path)) as.integer(readLines(counter_path, n=1L)) else 0L; counter_after <- counter_before + 1L; writeLines(as.character(counter_after), counter_path); cat("${marker}", "counter", counter_after, "\\n")`;
  const text=`In the explicitly selected R workspace, call r_execute exactly once with this code:\n${code}\nThen report the returned marker and counter. Do not run it again. The attached note is frozen historical evidence; do not claim its object values are current.`;
  const saved=(await agentInvoke('agent.model.draft',{conversation_id:conversationId,draft_version:created.draft_version,
    content:{text,context:sources,assets:[]},grant:{mode:'run',session:{workspace_instance_id:r.instance,session_id:session},documents:[],files:[],permission_policy:'ask'}})).output;
  const input={request_id:'live-provider-original-send',conversation_id:conversationId,conversation_version:saved.version,
    model_settings_version:settings.version,text,sources,r:rBinding,mode:'run',assets:[],continuation:null};
  const bound=await binding(agent,'agent.model.run'),clientRequest='live-provider-host-original-send';
  const envelope={binding:bound,arguments:input,preconditions:null};
  const wireBefore=peer?.calls.length??0;
  // Deliberately discard the acknowledgement. Recover by its saved native request
  // identity rather than invoking again or guessing the most recent operation.
  await port('invoke',{capability:{id:'agent.model.run',version:1},arguments:envelope,preconditions:[],client_request_id:clientRequest});
  const until=Date.now()+180000;
  let run;
  do {
    run=await agentQuery('agent.model.run.request',{request_id:input.request_id});
    report.run=run;save();
    if(['completed','failed','stopped','interrupted'].includes(run.state))break;
    assert.ok(Date.now()<until,'Real provider Send did not settle');
    await new Promise(resolve=>setTimeout(resolve,250));
  } while(true);
  assert.equal(run.state,'completed',`Real provider Send: ${run.state}; ${run.reason??''}`);
  assert.deepEqual(run.context.sources[0].selection,sources[0]);
  assert.equal(run.context.sources[0].text,selected.context.text);
  const admission=await agentQuery('agent.model.run.admission',{run_id:run.run_id});
  assert.deepEqual(admission.r,rBinding);
  const original=await port('get_operation',{operation_id:admission.operation});
  assert.equal(original.status,'succeeded');
  assert.deepEqual(original.operation.normalized_arguments,envelope);
  const receipts=await agentQuery('agent.model.run.tools',{run_id:run.run_id});
  const effects=receipts.filter(receipt=>receipt.capability==='r.execute');
  assert.equal(effects.length,1,'Exactly one original R execution');
  assert.equal(effects[0].phase,'resolved');
  const child=await port('get_operation',{operation_id:effects[0].operation_id});
  assert.equal(child.status,'succeeded');assert.equal(child.operation.causation_id,admission.operation);
  assert.deepEqual(child.operation.normalized_arguments.binding,rBinding);
  assert.equal(child.output.session_id,session);
  assert.equal(fs.readFileSync(path.join(project,filename),'utf8').trim(),'1');
  const answer=await answerFor(run);
  assert.ok(answer.includes(marker),'The model answer retains the tool marker');
  report.answer=answer;
  if(peer){
    report.wire_answer_matches=answer===peer.calls.slice(wireBefore).map(call=>call.text).join('');save();
    assert.ok(report.wire_answer_matches,'Stored model text must retain every wire text fragment');
  }
  report.status='passed';report.smoke={original_operation:admission.operation,child_operation:child.operation.operation_id,
    client_request_id:clientRequest,session,r_binding:rBinding,acknowledgement:'deliberately discarded after public invoke',
    recovered_by:'agent.model.run.request → native admission → original Host operation',native_effects:1,
    context_source_replayed:false,restart_verified:false};save();
  if(matrix)await liveAgentMatrix({r,session,rBinding,scientificCase,settings,query,port,pluginQuery,agentQuery,agentInvoke,answerFor,peer,report,save});
  let vision;
  if(process.env.RHO_LIVE_VISION_MODEL){assert.ok(image,'Real vision requires --captures');vision=await liveAgentVision({image,agentQuery,agentInvoke,answerFor,peer,report,save});}
  const calls=peer?.calls.length;
  return {async close(){try{await removeCredential();}finally{if(peer)await peer.close();}},async afterRestart(){
    const state=await query('plugins.instance',{instance:agent});
    assert.equal(state.instance.state,'suspended');
    const resumed=(await invoke('plugins.resume',{instance:agent,suspension:state.instance.suspension})).output.instance.identity;
    assert.deepEqual(resumed,agent);
    const retained=await agentQuery('agent.model.run.get',{run_id:run.run_id});assert.deepEqual(retained,run);
    assert.deepEqual(await agentQuery('agent.model.run.tools',{run_id:run.run_id}),receipts);
    // Exact Host retry and a distinct Host request using the same native request
    // both resolve the retained original. Neither starts a new model or R loop.
    const retry=await invoke('agent.model.run',envelope,clientRequest);
    assert.equal(retry.operation.operation_id,admission.operation);
    const nativeRetry=(await agentInvoke('agent.model.run',input)).output;
    assert.equal(nativeRetry.run_id,run.run_id);assert.equal(nativeRetry.model_calls,run.model_calls);
    assert.equal(nativeRetry.tool_calls,run.tool_calls);
    assert.equal(fs.readFileSync(path.join(project,filename),'utf8').trim(),'1');
    assert.equal((await query('plugins.instance',{instance:r})).instance.state,'suspended');
    if(vision)await vision.afterRestart();
    if(peer)assert.equal(peer.calls.length,calls,'Recovery must not contact the real model again');
    report.smoke.restart_verified=true;save();
  }};
  } catch(error) {
    try {await removeCredential();} catch {report.credential_cleanup='failed; disposable instance retained';save();}
    if(peer)await peer.close();
    throw error;
  }
}
