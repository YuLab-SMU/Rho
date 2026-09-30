// The 11 historical intents mapped to current public ports. Do not substitute
// R file writes for missing Editor edit/save/run tools or count them as passes.
import assert from 'node:assert/strict';

export const liveMatrixCases=[
  ...['objects','packages','plots','environment','workspace'].map(id=>({id,profile:id,available:true})),
  ...[['documents','documents'],['project','project'],['repair-document','documents'],['repair-plot','documents'],['generic-new-task','project'],['objects-script','objects']]
    .map(([id,profile])=>({id,profile,available:false,reason:'The current ordinary Rho model port exposes r_session/r_execute; scoped Editor edit/save/captured-run tools have not been connected.'})),
];

export async function liveAgentMatrix({r,session,rBinding,scientificCase,settings,query,port,pluginQuery,agentQuery,agentInvoke,answerFor,peer,report,save}){
  assert.equal(liveMatrixCases.length*3,33);assert.equal(new Set(liveMatrixCases.map(item=>item.profile)).size,7);
  const matrix=report.matrix={expected:33,cases:liveMatrixCases,attempts:[],complete:false,all_passed:false};save();
  const original=kind=>scientificCase.report.sources.find(source=>source.kind===kind).reference;
  const selected=(preview,inclusion)=>({source:'plugin',label:preview.item.title,reference:preview.item.reference,inclusion:JSON.stringify(inclusion)});
  const packages=await pluginQuery(r,'r.context.packages.preview',{reference:original('packages'),inclusion:{kind:'metadata'},max_bytes:16384});
  const plots=await pluginQuery(r,'r.context.plots.preview',{reference:original('plots'),inclusion:{kind:'metadata'},max_bytes:16384});
  const binding=await query('plugins.resolve',{instance:r,capability:{id:'r.observe_object',version:1}});
  const observation=await port('query_snapshot',{capability:{id:'r.observe_object',version:1},arguments:{binding,arguments:{expected_session:session,name:'annotation_object',path:[]},preconditions:null}});
  assert.equal(observation.status,'ready');const objectRef=observation.data.data.object_ref;
  const page=await pluginQuery(r,'r.context.objects.search',{window:packages.item.reference.window,text:'annotation_object',after:null,limit:20});
  const reference=page.items.find(item=>item.reference.selector.object_ref===objectRef)?.reference;assert.ok(reference,'Current object handle must be observed');
  const objects=await pluginQuery(r,'r.context.objects.preview',{reference,inclusion:{kind:'summary'},max_bytes:16384});
  const version=/Version:\s*([^\s]+)/i.exec(packages.text)?.[1];assert.ok(version,'Installed package version must come from the owner');
  for(const scenario of liveMatrixCases){
    for(let repetition=1;repetition<=3;repetition++){
      const attempt={id:scenario.id,profile:scenario.profile,repetition,status:scenario.available?'running':'not_run',reason:scenario.reason??null};matrix.attempts.push(attempt);save();
      if(!scenario.available)continue;
      const started=Date.now(),id=`live-${scenario.id}-${repetition}`,marker=`rho-${scenario.id}-${repetition}`;
      try{
        let text,source=[],mode='explain',expected,capability;
        if(scenario.id==='objects'){
          source=[selected(objects,{kind:'summary'})];mode='run';capability='r.execute';expected='15';
          text=`The bounded object summary is selected. In the selected session call r_execute exactly once to compute sum(annotation_object) without modifying it, and print "${marker}" with the sum. Report the marker and native numeric result in one short sentence.`;
        }else if(scenario.id==='packages'){
          source=[selected(packages,{kind:'metadata'})];expected=version;
          text='From the exact selected installed-copy metadata, report the package name parallel and its installed version in one sentence. Do not load or attach the package. Do not infer installation history.';
        }else if(scenario.id==='plots'){
          source=[selected(plots,{kind:'metadata'})];expected='METADATA_ONLY';
          text='This selected original plot context includes metadata only. Reply with METADATA_ONLY followed by one sentence explaining that you cannot inspect chart pixels from this context. Do not execute R or invent chart contents.';
        }else if(scenario.id==='environment'){
          capability='r.session';expected=session;
          text='Call r_session exactly once for the originally selected workspace. Report its exact session ID in one short sentence. Do not execute R, start a runtime or change the environment.';
        }else{
          mode='run';capability='r.execute';expected='43';
          text=`In the selected workspace call r_execute exactly once with cat("${marker}", 6L * 7L + 1L, "\\n"). Reply with the marker and confirmed native result in one sentence. Do not execute it again.`;
        }
        const created=(await agentInvoke('agent.model.create',{conversation_id:id,profile:scenario.profile})).output;
        const conversation=(await agentInvoke('agent.model.draft',{conversation_id:id,draft_version:created.draft_version,content:{text,context:source,assets:[]},grant:{mode,session:{workspace_instance_id:r.instance,session_id:session},documents:[],files:[],permission_policy:'ask'}})).output;
        const before=peer?.calls.length??0;
        const record=await agentInvoke('agent.model.run',{request_id:`${id}-send`,conversation_id:id,conversation_version:conversation.version,model_settings_version:settings.version,text,sources:source,r:rBinding,mode,assets:[],continuation:null});
        const run=record.output;attempt.run=run.run_id;attempt.operation=record.operation.operation_id;attempt.state=run.state;save();
        assert.equal(run.state,'completed',run.reason??'Real model did not complete');
        assert.deepEqual(run.context.sources.map(item=>item.selection),source);
        const answer=await answerFor(run);attempt.answer=answer;
        assert.ok(answer.includes(expected),`Answer omitted expected owner/native result ${expected}`);
        const receipts=await agentQuery('agent.model.run.tools',{run_id:run.run_id});attempt.tools=receipts;
        const effects=receipts.filter(item=>item.capability==='r.execute');
        assert.equal(effects.length,mode==='run'?1:0,'Source inspection cannot silently execute scientific work');
        if(capability){
          const chosen=receipts.filter(item=>item.capability===capability);assert.equal(chosen.length,1);assert.equal(chosen[0].phase,'resolved');
          if(mode==='run'){
            assert.ok(answer.includes(marker));const child=await port('get_operation',{operation_id:chosen[0].operation_id});
            assert.equal(child.status,'succeeded');assert.equal(child.operation.causation_id,record.operation.operation_id);
            assert.deepEqual(child.operation.normalized_arguments.binding,rBinding);assert.equal(child.output.session_id,session);
          }
        }
        if(peer)assert.equal(answer,peer.calls.slice(before).map(call=>call.text).join(''),'Stored text must equal the real wire text');
        attempt.status='passed';attempt.model_calls=run.model_calls;attempt.tool_calls=run.tool_calls;
      }catch(error){attempt.status='failed';attempt.reason=String(error.message??error);}
      attempt.seconds=(Date.now()-started)/1000;save();console.log(JSON.stringify({live_case:attempt.id,repetition,status:attempt.status,seconds:attempt.seconds}));
    }
  }
  matrix.passed=matrix.attempts.filter(item=>item.status==='passed').length;
  matrix.failed=matrix.attempts.filter(item=>item.status==='failed').length;
  matrix.not_run=matrix.attempts.filter(item=>item.status==='not_run').length;
  matrix.complete=matrix.not_run===0&&matrix.attempts.length===33;matrix.all_passed=matrix.complete&&matrix.passed===33;save();
}
