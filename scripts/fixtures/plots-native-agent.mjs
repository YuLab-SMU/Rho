import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export async function plotsNativeAgent({agent,r,project,selection,context,binding,invoke,pluginQuery}){
 const control=value=>({task_id:value.detail.summary.task.task_id,generation:value.detail.summary.attachment.generation});
 const bound=await binding(agent,'agent.native.command');
 const command=async command=>(await invoke('agent.native.command',{binding:bound,arguments:{request_id:randomUUID(),command}})).output;
 let task=await command({kind:'create',provider:'kimi',model:'fixture',effort:null});task=await command({kind:'connect',control:control(task)});
 const sends=[],evidence=()=>JSON.parse(fs.readFileSync(path.join(project,'native-science-evidence.json'),'utf8'));
 for(const images of [true,false]){
  task=await command({kind:'save_draft',control:control(task),version:task.detail.draft.version,content:{text:images?'Compare the two selected original plots.':'Continue with the retained text history.',assets:[],context:images?[selection]:[]}});
  fs.writeFileSync(path.join(project,'native-plots-input.json'),JSON.stringify({reference:selection.reference,selection,text:context.text,resources:context.resources,images}));
  const input={binding:bound,arguments:{request_id:randomUUID(),command:{kind:'send',control:control(task),draft_version:task.detail.draft.version},tools:[{name:'preview',target:{type:'provider',binding:await binding(r,'r.context.plots.preview')}}]}};
  const parent=await invoke('agent.native.command',input);assert.equal(parent.output.receipt.status,'succeeded');
  const proof=evidence();assert.equal(proof.error,undefined,JSON.stringify(proof));assert.equal(proof.send_request,input.arguments.request_id);assert.equal(proof.prompts,images?1:2);
  assert.deepEqual(proof.image_digests,images?context.resources.map(p=>p.digest):[]);
  const captured=await pluginQuery(agent,'agent.native.context',{request_id:input.arguments.request_id});
  assert.equal(captured.contexts.length,images?1:0);
  if(images){assert.deepEqual(captured.contexts[0].selection,selection);assert.equal(captured.contexts[0].text,context.text);
   assert.deepEqual(captured.contexts[0].images,context.resources.map(reference=>({reference,sha256:reference.digest,mime_type:reference.media_type,bytes:reference.bytes})));}
  assert.equal((await invoke('agent.native.command',input)).output.receipt.status,'succeeded');assert.equal(evidence().prompts,images?1:2);
  sends.push({input,captured,proof,operation:parent.operation.operation_id});task=parent.output;
 }
 const report={peer:'local deterministic ACP fixture',task:control(task).task_id,sends,restart_verified:false};
 return {report,async afterRestart(){for(const sent of sends){
  assert.deepEqual(await pluginQuery(agent,'agent.native.context',{request_id:sent.input.arguments.request_id}),sent.captured);
  assert.equal((await invoke('agent.native.command',sent.input)).output.receipt.status,'succeeded');
 }assert.equal(evidence().prompts,2);report.restart_verified=true;}};
}
