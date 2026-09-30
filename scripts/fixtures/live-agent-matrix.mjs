// The 11 historical intents mapped to current public ports. Do not substitute
// R file writes for missing Editor edit/save/run tools or count them as passes.
import assert from 'node:assert/strict';

export const liveMatrixCases=[
  ...['objects','packages','plots','environment','workspace'].map(id=>({id,profile:id,available:true,mode:id==='workspace'?'run':'explain'})),
  ...[['documents','documents'],['project','project'],['repair-document','documents'],['repair-plot','documents'],['generic-new-task','project'],['objects-script','objects']]
    .map(([id,profile])=>({id,profile,available:false,reason:'This historical R-only fixture does not select Editor tools. Current scoped document-workflow coverage is in test-preview-agent-context.mjs --document-workflow true; these historical real-model cases remain unassessed.'})),
];

export function installedCopyVersion(preview){
  // The owner validates this exact selector against the installed copy. The
  // human-readable preview deliberately has no separate `Version:` heading.
  assert.equal(preview.truncated,false,'Installed-copy context must be complete');
  const {package:name,version}=preview.item.reference.selector;
  assert.equal(name,'parallel');
  assert.equal(typeof version,'string');assert.ok(version.length>0);
  assert.ok(preview.text.startsWith(`Installed package: ${name} ${version}\n`),'Owner text must match its verified installed-copy identity');
  return version;
}

export async function liveAgentMatrix({r,session,rBinding,scientificCase,settings,query,port,pluginQuery,agentQuery,agentInvoke,answerFor,peer,report,save}){
  assert.equal(liveMatrixCases.length*3,33);assert.equal(new Set(liveMatrixCases.map(item=>item.profile)).size,7);
  const selectedCases=process.env.RHO_LIVE_MATRIX_CASES?.split(',');
  if(selectedCases)assert.ok(selectedCases.length>0&&selectedCases.every(id=>liveMatrixCases.some(item=>item.id===id)),'Unknown selected matrix case');
  const scenarios=liveMatrixCases.filter(item=>!selectedCases||selectedCases.includes(item.id));
  const matrix=report.matrix={expected:33,selected_cases:selectedCases??null,expected_selected:scenarios.length*3,cases:liveMatrixCases,attempts:[],complete:false,all_passed:false};save();
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
  const version=installedCopyVersion(packages);
  for(const scenario of scenarios){
    for(let repetition=1;repetition<=3;repetition++){
      const attempt={id:scenario.id,profile:scenario.profile,repetition,status:scenario.available?'running':'not_run',reason:scenario.reason??null};matrix.attempts.push(attempt);save();
      if(!scenario.available)continue;
      const started=Date.now(),id=`live-${scenario.id}-${repetition}`;
      try{
        let text,source=[],mode=scenario.mode,expected,capability;
        if(scenario.id==='objects'){
          source=[selected(objects,{kind:'summary'})];expected='5';
          assert.match(objects.text,/"length":\s*5\b/,'The selected owner summary must establish the expected length');
          text='Read the selected observed object metadata. Report its object type and exact length in one short sentence. Treat its recognition sample as bounded evidence, not a complete object read. Do not execute R.';
        }else if(scenario.id==='packages'){
          source=[selected(packages,{kind:'metadata'})];expected=version;
          text='From the exact selected installed-copy metadata, report the package name parallel and its installed version in one sentence. Do not load or attach the package. Do not infer installation history.';
        }else if(scenario.id==='plots'){
          source=[selected(plots,{kind:'metadata'})];expected=null;
          text='What can you establish about the selected plot from the supplied context? Distinguish available evidence from visual details you cannot inspect. Do not execute R.';
        }else if(scenario.id==='environment'){
          expected=session;
          text='Inspect the selected workspace and report its exact current session ID. Do not execute R, start a runtime or change the environment.';
        }else{
          mode='run';capability='r.execute';expected='43';
          text='Calculate 6 * 7 + 1 in the selected R workspace and report its confirmed native result in one sentence.';
        }
        const created=(await agentInvoke('agent.model.create',{conversation_id:id,profile:scenario.profile})).output;
        const conversation=(await agentInvoke('agent.model.draft',{conversation_id:id,draft_version:created.draft_version,content:{text,context:source,assets:[]},grant:{mode,session:{workspace_instance_id:r.instance,session_id:session},documents:[],files:[],permission_policy:'ask'}})).output;
        const before=peer?.calls.length??0;
        const record=await agentInvoke('agent.model.run',{request_id:`${id}-send`,conversation_id:id,conversation_version:conversation.version,model_settings_version:settings.version,text,sources:source,r:rBinding,mode,assets:[],continuation:null});
        const run=record.output;attempt.run=run.run_id;attempt.operation=record.operation.operation_id;attempt.state=run.state;save();
        assert.equal(run.state,'completed',run.reason??'Real model did not complete');
        assert.deepEqual((run.context?.sources??[]).map(item=>item.selection),source);
        const answer=await answerFor(run);attempt.answer=answer;
        if(expected!==null)assert.ok(answer.includes(expected),`Answer omitted expected owner/native result ${expected}`);
        else assert.match(answer,/metadata|pixels|image|visual|元数据|像素|图像|图形/i,'Plot answer must discuss the evidence boundary');
        const receipts=await agentQuery('agent.model.run.tools',{run_id:run.run_id});attempt.tools=receipts;
        const effects=receipts.filter(item=>item.capability==='r.execute');
        assert.equal(effects.length,mode==='run'?1:0,'Source inspection cannot silently execute scientific work');
        if(capability){
          const chosen=receipts.filter(item=>item.capability===capability);assert.equal(chosen.length,1);assert.equal(chosen[0].phase,'resolved');
          if(mode==='run'){
            const child=await port('get_operation',{operation_id:chosen[0].operation_id});
            assert.equal(child.status,'succeeded');assert.equal(child.operation.causation_id,record.operation.operation_id);
            assert.deepEqual(child.operation.normalized_arguments.binding,rBinding);assert.equal(child.output.session_id,session);
          }
        }
        if(peer)assert.equal(answer,peer.calls.slice(before).map(call=>call.text).join(''),'Stored text must equal the real wire text');
        attempt.status=scenario.id==='plots'?'partial':'passed';attempt.model_calls=run.model_calls;attempt.tool_calls=run.tool_calls;
        if(scenario.id==='plots')attempt.reason='Metadata-boundary behavior passed; the original matrix visual-color intent is not established by a metadata-only context';
      }catch(error){attempt.status='failed';attempt.reason=String(error.message??error);}
      attempt.seconds=(Date.now()-started)/1000;save();console.log(JSON.stringify({live_case:attempt.id,repetition,status:attempt.status,seconds:attempt.seconds}));
    }
  }
  matrix.passed=matrix.attempts.filter(item=>item.status==='passed').length;
  matrix.failed=matrix.attempts.filter(item=>item.status==='failed').length;
  matrix.not_run=matrix.attempts.filter(item=>item.status==='not_run').length;
  matrix.partial=matrix.attempts.filter(item=>item.status==='partial').length;
  matrix.complete=matrix.not_run===0&&matrix.attempts.length===33;matrix.all_passed=matrix.complete&&matrix.passed===33;
  matrix.assessment_complete=matrix.attempts.length===matrix.expected_selected&&matrix.attempts.every(item=>['passed','partial','failed','not_run'].includes(item.status));
  matrix.scope='User requested acceptance of existing capabilities with missing capabilities retained individually; not_run is never passed';save();
}
