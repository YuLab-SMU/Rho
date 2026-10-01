import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {inflateSync} from 'node:zlib';

// Real Agent/Rig/Host and annotation resources; only the model HTTP peer is synthetic.
export async function annotationImageAgent({agent,notes,image,query,invoke,binding,pluginQuery}) {
  const requests=[],errors=[];
  const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
  const server=createServer(async(req,res)=>{
    try {
      assert.equal(req.url,'/v1/chat/completions');assert.equal(req.method,'POST');
      let raw='';for await(const bytes of req){raw+=bytes;assert.ok(Buffer.byteLength(raw)<4*1024*1024);}
      const body=JSON.parse(raw);assert.equal(body.stream,true);
      const parts=body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]);
      const images=parts.filter(p=>p.type==='image_url');let reply;
      if(images.length){
        assert.equal(images.length,1);const encoded=images[0].image_url.url;
        assert.ok(encoded.startsWith('data:image/png;base64,'));const bytes=Buffer.from(encoded.split(',')[1],'base64');
        if(digest(bytes)===digest(image.bytes)){
          assert.deepEqual(bytes,image.bytes);assert.ok(JSON.stringify(body.messages).includes('Captured view'));
          assert.ok(JSON.stringify(body.messages).includes('rectangle'));reply='Reviewed the explicitly selected captured image and its region mark.';
          requests.push({kind:'image',digest:digest(bytes),bytes:bytes.length});
        }else{
          assert.equal(bytes.readUInt32BE(16),8);assert.equal(bytes.readUInt32BE(20),8);
          const chunks=[];for(let at=8;at<bytes.length;){const n=bytes.readUInt32BE(at);if(bytes.toString('ascii',at+4,at+8)==='IDAT')chunks.push(bytes.subarray(at+8,at+8+n));at+=12+n;}
          const row=inflateSync(Buffer.concat(chunks));assert.equal(row[0],0);
          reply=['red','green','blue'][[...row.subarray(1,4)].indexOf(255)];assert.ok(reply);
          requests.push({kind:'diagnostic'});
        }
      }else{reply='Continued from the retained text history without receiving another image.';requests.push({kind:'text-only'});}
      const chunk=(delta,finish_reason)=>`data: ${JSON.stringify({id:'image-context-peer',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`;
      res.writeHead(200,{'Content-Type':'text/event-stream'}).end(chunk({role:'assistant'},null)+chunk({content:reply},null)+chunk({},'stop')+'data: [DONE]\n\n');
    }catch(error){errors.push(String(error));res.writeHead(500).end('Image context fixture rejected the input');}
  });
  const close=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const aq=(id,args)=>pluginQuery(agent,id,args);
    const ai=async(id,args,expected='succeeded')=>invoke(id,{binding:await binding(agent,id),arguments:args},randomUUID(),expected);
    const old=await aq('agent.model.settings',{});
    const settings=(await ai('agent.model.configure',{version:old.version,enabled:true,connection:{...old.connection,base_url:`http://127.0.0.1:${server.address().port}/v1`}})).output;
    const id='annotation-image-reader';let conversation=(await ai('agent.model.create',{conversation_id:id,profile:'project'})).output;
    const text='Review the selected captured image and its marked region.';
    conversation=(await ai('agent.model.draft',{conversation_id:id,draft_version:conversation.draft_version,content:{text,context:[image.selection],assets:[]},grant:null})).output;
    const input={request_id:'annotation-image-send',conversation_id:id,conversation_version:conversation.version,model_settings_version:settings.version,text,sources:[image.selection]};
    await ai('agent.model.run',{...input,request_id:'image-before-diagnostic'},'failed');
    assert.deepEqual((await aq('agent.model.conversation',{conversation_id:id})).draft_content,conversation.draft_content);
    assert.equal(requests.length,0,'Unverified image cannot reach the model');
    const diagnostic=(await ai('agent.model.test',{request_id:'annotation-image-diagnostic',model_settings_version:settings.version,kind:'images'})).output;
    assert.equal(diagnostic.state,'passed',JSON.stringify({diagnostic,errors}));
    const original=await ai('agent.model.run',input);assert.equal(original.output.state,'completed',JSON.stringify(original.output));
    const run=original.output;assert.equal(run.context.sources[0].native_data.agent_context_images.length,1);
    assert.equal(run.context.sources[0].native_data.agent_context_images[0].sha256,digest(image.bytes));
    conversation=await aq('agent.model.conversation',{conversation_id:id});
    const followup={request_id:'annotation-image-text-followup',conversation_id:id,conversation_version:conversation.version,model_settings_version:settings.version,text:'Summarize the prior answer using retained text only.',sources:[]};
    assert.equal((await ai('agent.model.run',followup)).output.state,'completed');
    assert.deepEqual(requests.map(r=>r.kind),['diagnostic','image','text-only']);assert.deepEqual(errors,[]);
    const report={peer:'local deterministic HTTP fixture',image_sha256:digest(image.bytes),run:run.run_id,operation:original.operation.operation_id,unverified_image_refused:true,history_does_not_resend_image:true,restart_verified:false};
    return {report,close,async afterRestart(){
      assert.equal((await query('plugins.instance',{instance:notes})).instance.state,'suspended');
      assert.deepEqual((await aq('agent.model.run.get',{run_id:run.run_id})).context,run.context);
      assert.deepEqual((await ai('agent.model.run',input)).output.context,run.context);
      assert.equal(requests.length,3);assert.deepEqual(errors,[]);
      assert.equal((await query('plugins.instance',{instance:notes})).instance.state,'suspended');report.restart_verified=true;
    }};
  }catch(error){await close();throw error;}
}
