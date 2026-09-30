import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export async function liveAgentVision({image,agentQuery,agentInvoke,answerFor,peer,report,save}){
  const vision=report.vision={model:process.env.RHO_LIVE_VISION_MODEL,completed:false};save();
  const old=await agentQuery('agent.model.settings',{});
  const settings=(await agentInvoke('agent.model.configure',{version:old.version,enabled:true,connection:{...old.connection,model:vision.model}})).output;
  const diagnostic=(await agentInvoke('agent.model.test',{request_id:'live-vision-diagnostic',model_settings_version:settings.version,kind:'images'})).output;
  vision.diagnostic=diagnostic;save();assert.equal(diagnostic.state,'passed',diagnostic.detail??'Real image diagnostic did not pass');
  const id='live-captured-image';let conversation=(await agentInvoke('agent.model.create',{conversation_id:id,profile:'plots'})).output;
  const text='Inspect the explicitly included captured PNG. Describe its visible colors/texture in one sentence, then identify the rectangle mark from the retained note metadata. This capture is a fixture, not a scientific chart. Do not invent axes or results.';
  conversation=(await agentInvoke('agent.model.draft',{conversation_id:id,draft_version:conversation.draft_version,content:{text,context:[image.selection],assets:[]},grant:null})).output;
  const input={request_id:'live-image-send',conversation_id:id,conversation_version:conversation.version,model_settings_version:settings.version,text,sources:[image.selection],assets:[],r:null,mode:'explain',continuation:null};
  const before=peer?.calls.length??0;
  const original=await agentInvoke('agent.model.run',input),run=original.output;vision.run=run.run_id;save();
  assert.equal(run.state,'completed',run.reason??'Real image Send did not complete');
  const sha256='sha256:'+createHash('sha256').update(image.bytes).digest('hex');
  assert.equal(run.context.sources[0].native_data.agent_context_images[0].sha256,sha256);
  const answer=await answerFor(run);vision.answer=answer;assert.match(answer,/rectangle/i);
  if(peer){
    const calls=peer.calls.slice(before);assert.equal(answer,calls.map(call=>call.text).join(''));
    assert.deepEqual(calls.flatMap(call=>call.images),[{sha256,bytes:image.bytes.length,media_type:'image/png'}]);
  }
  conversation=await agentQuery('agent.model.conversation',{conversation_id:id});
  const followup={...input,request_id:'live-image-text-followup',conversation_version:conversation.version,text:'Summarize the preceding answer in one sentence, using retained text only. No image is included in this message.',sources:[]};
  const next=peer?.calls.length??0;
  const continued=(await agentInvoke('agent.model.run',followup)).output;
  assert.equal(continued.state,'completed',continued.reason??'Real text followup did not complete');
  if(peer)assert.deepEqual(peer.calls.slice(next).flatMap(call=>call.images),[],'A text followup must not resend original pixels');
  vision.completed=true;vision.image={sha256,bytes:image.bytes.length};vision.followup=continued.run_id;
  vision.history_does_not_resend_image=!!peer;vision.restart_verified=false;save();
  return {async afterRestart(){
    assert.deepEqual((await agentQuery('agent.model.run.get',{run_id:run.run_id})).context,run.context);
    const replay=(await agentInvoke('agent.model.run',input)).output;assert.equal(replay.run_id,run.run_id);assert.equal(replay.model_calls,run.model_calls);
    vision.restart_verified=true;save();
  }};
}
