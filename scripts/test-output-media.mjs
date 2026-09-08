// Real MCP stdio evidence test. Build current rho/ark first; this script never invokes Cargo.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const option=(name,otherwise)=>{const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:otherwise;};
const binary=option('--binary',path.join(root,'target/debug/rho'));
const ark=option('--ark',process.env.RHO_ARK||path.join(root,'target/debug/ark'));
const probe=spawnSync('Rscript',['--vanilla','-e','cat(R.home())'],{encoding:'utf8'});
assert.equal(probe.status,0,'Real R is required; missing R is not a passing skip.');
const rHome=process.env.RHO_R_HOME||probe.stdout.trim();
assert.ok(fs.existsSync(binary),'Build current rho before testing');assert.ok(fs.existsSync(ark),'Build current Ark before testing');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rho-output-media-'));
const project=path.join(directory,'project');fs.mkdirSync(project);
const evidence=option('--evidence',path.join(root,'target/agent-interface/output-media'));fs.mkdirSync(evidence,{recursive:true});
const trace=fs.createWriteStream(path.join(evidence,'mcp.jsonl'));
const child=spawn(binary,['--database',path.join(directory,'state/next.sqlite'),'--project',project,'--ark',ark,'--r-home',rHome,'mcp'],{stdio:['pipe','pipe','pipe']});
const pending=new Map();let sequence=0;let calls=0;let responseBytes=0;
child.stderr.on('data',chunk=>fs.appendFileSync(path.join(evidence,'stderr.log'),chunk));
const lines=readline.createInterface({input:child.stdout});
lines.on('line',line=>{trace.write(`${line}\n`);responseBytes+=Buffer.byteLength(line);const message=JSON.parse(line);const waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);clearTimeout(waiter.timer);message.error?waiter.reject(new Error(JSON.stringify(message.error))):waiter.resolve(message.result);});
const exited=new Promise(resolve=>child.once('exit',(code,signal)=>{for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(new Error(`MCP exited ${code}/${signal}`));}pending.clear();resolve({code,signal});}));
function request(method,params){calls++;const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timeout`));},60000);pending.set(id,{resolve,reject,timer});const line=JSON.stringify({jsonrpc:'2.0',id,method,params});trace.write(`${line}\n`);child.stdin.write(`${line}\n`);});}
const call=(name,args)=>request('tools/call',{name,arguments:args});
const digest=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
let passed=false;
try{
 const hello=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'output-media-acceptance',version:'1'}});assert.ok(hello.capabilities.resources);child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized',params:{}})+'\n');
 let cursor;const tools=[];do{const page=await request('tools/list',cursor?{cursor}:{});tools.push(...page.tools);cursor=page.nextCursor;}while(cursor);
 assert.ok(tools.some(tool=>tool.name==='rho.output.view'));assert.ok((await request('resources/templates/list',{})).resourceTemplates.length>=3);
 const executed=(await call('rho.workspace.run_r.v1',{client_request_id:'native-media-plot',arguments:{code:"plot(1:5, (1:5)^2, main='Verified MCP evidence', col='red', pch=19)",output_mode:'console'}})).structuredContent.result;
 assert.equal(executed.status,'succeeded',JSON.stringify(executed));
 const id=executed.operation.operation_id;
 const outputs=(await call('rho.workspace.list_outputs.v1',{operation_id:id,after_sequence:0,limit:100})).structuredContent.result.data;assert.ok(outputs.media.length>0);
 const reference=outputs.media.at(-1).reference;
 const view=await call('rho.output.view',{reference,max_edge:1600});assert.notEqual(view.isError,true,JSON.stringify(view));
 const image=view.content.find(content=>content.type==='image');assert.ok(image,'Native MCP ImageContent is required');const png=Buffer.from(image.data,'base64');assert.ok(png.length<=512*1024);fs.writeFileSync(path.join(evidence,'preview.png'),png);
 const metadata=view.structuredContent.result.data;assert.equal(digest(png),metadata.preview_sha256);assert.equal(metadata.preview_base64,undefined);assert.equal(metadata.reference.sha256,reference.sha256);
 const resource=view.content.find(content=>content.type==='resource_link');assert.ok(resource);
 const original=(await request('resources/read',{uri:resource.uri})).contents[0];let bytes;
 if(original.blob){bytes=Buffer.from(original.blob,'base64');}else{const manifest=JSON.parse(original.text);const chunks=[];for(const part of manifest.chunks){const result=(await request('resources/read',{uri:part.uri})).contents[0];const chunk=Buffer.from(result.blob,'base64');assert.equal(chunk.length,part.byte_size);chunks.push(chunk);}bytes=Buffer.concat(chunks);}
 assert.equal(bytes.length,reference.byte_size);assert.equal(digest(bytes),reference.sha256);fs.writeFileSync(path.join(evidence,'original.bin'),bytes);
 const cropped=await call('rho.output.view',{reference,crop:{x:0,y:0,width:Math.max(1,Math.floor(metadata.original_width/2)),height:Math.max(1,Math.floor(metadata.original_height/2))},max_edge:1200});assert.ok(cropped.content.some(content=>content.type==='image'));
 assert.equal(cropped.structuredContent.result.data.reference.sha256,reference.sha256);
 const help=(await call('rho.workspace.help.v1',{client_request_id:'native-media-help',arguments:{topic:'mean'}})).structuredContent.result;assert.equal(help.status,'succeeded',JSON.stringify(help));
 const helpEvents=(await call('rho.workspace.output_events.v1',{operation_id:help.operation.operation_id,after_sequence:0,limit:100})).structuredContent.result.data;
 const textReference=helpEvents.events.find(event=>event.kind==='text_artifact')?.media;assert.ok(textReference,'Help must become a text artifact');
 const text=(await call('rho.output.read_text.v1',{reference:textReference,offset:0,limit_bytes:256})).structuredContent.result.data;assert.ok(text.text.length>0);assert.equal(text.encoding,'utf-8');
 const plots=(await call('rho.workspace.list_outputs.v1',{operation_id:help.operation.operation_id,after_sequence:0,limit:100})).structuredContent.result.data;assert.ok(plots.media.every(media=>media.reference.mime_type.startsWith('image/')));
 passed=true;
}finally{
 child.stdin.end();const timer=setTimeout(()=>child.kill('SIGTERM'),10000);const exit=await exited;clearTimeout(timer);trace.end();
 fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed,calls,response_bytes:responseBytes,exit,project_isolated:true},null,2));
 fs.rmSync(directory,{recursive:true,force:true});
}
console.log(`Native MCP media evidence passed; ${calls} requests, ${responseBytes} reply bytes.`);
