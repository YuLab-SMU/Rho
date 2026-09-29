// The ACP peer is deterministic; Agent capture, MCP and the R owner are real.
module.exports=async({cwd,sendRequest,catalog,rpc,save,session,prompts,prompt})=>{
 const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
 const input=JSON.parse(fs.readFileSync(path.join(cwd,'native-plots-input.json'),'utf8'));
 const tools=catalog.structuredContent.tools;assert.equal(tools.length,1);assert.equal(tools[0].selection.name,'preview');
 assert.deepEqual(tools[0].selection.target.binding.provider,input.reference.provider);
 const captured=prompt.find(p=>p.type==='text'&&p.text.startsWith('User-selected source context for this original Send.'));
 if(input.images){assert.ok(captured);const contexts=JSON.parse(captured.text.slice(captured.text.indexOf('[')));assert.equal(contexts.length,1);assert.deepEqual(contexts[0].selection,input.selection);assert.equal(contexts[0].text,input.text);}
 else assert.equal(captured,undefined);
 const images=prompt.filter(p=>p.type==='image');assert.equal(images.length,input.images?2:0);
 if(input.images)for(const [i,image]of images.entries()){
  assert.equal(image.mimeType,input.resources[i].media_type);const bytes=Buffer.from(image.data,'base64');
  assert.equal(bytes.length,input.resources[i].bytes);assert.equal('sha256:'+createHash('sha256').update(bytes).digest('hex'),input.resources[i].digest);
 }
 const invocation={send_request:sendRequest,tool_request:randomUUID(),tool:'preview',arguments:{reference:input.reference,inclusion:{kind:'metadata'},max_bytes:16384},preconditions:null};
 const result=await rpc('tools/call',{name:'rho_call',arguments:invocation});assert.notEqual(result.isError,true);
 assert.deepEqual(result.structuredContent.result.data.item.reference,input.reference);
 assert.deepEqual(result.structuredContent.result.data.resources,[]);
 assert.deepEqual(await rpc('tools/call',{name:'rho_call',arguments:invocation}),result);
 save({session,prompts,send_request:sendRequest,image_digests:images.map(p=>'sha256:'+createHash('sha256').update(Buffer.from(p.data,'base64')).digest('hex')),query:result.structuredContent.result.data});
};
