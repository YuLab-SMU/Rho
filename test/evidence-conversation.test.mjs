import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {RhoService} from '../dist/server.js';
import {BrowserClient} from '../dist/browser.js';
import {RhoClient} from '../dist/client.js';
import path from 'node:path';
const peer=`import fs from 'node:fs';import readline from 'node:readline';let n=0;const out=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');readline.createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l),reply=result=>out({id:r.id,result});if(r.method==='initialize')reply({protocolVersion:1,agentCapabilities:{loadSession:true}});if(r.method==='session/new')reply({sessionId:'test'});if(r.method==='session/load')reply({});if(r.method==='session/prompt'){n++;fs.writeFileSync('analysis.py','print('+n+')\\n');out({method:'session/update',params:{sessionId:'test',update:{sessionUpdate:'tool_call',toolCallId:'write-'+n,title:'Write',kind:'edit',status:'completed',locations:[{path:process.cwd()+'/analysis.py'}],rawInput:{file_path:process.cwd()+'/analysis.py'}}}});reply({stopReason:'end_turn'});}});`;
test('new turns capture immutable disk and dirty buffer versions; reads and retries do not repeat work',async()=>{
 const root=await fs.mkdtemp('/tmp/rho-evidence-turn-');let service;
 try{
 await fs.writeFile(path.join(root,'peer.mjs'),peer);await fs.mkdir(path.join(root,'project'));
 service=await new RhoService({root,stateDir:path.join(root,'.service'),rscript:'/missing',claudeAcp:{command:{file:process.execPath,args:[path.join(root,'peer.mjs')]}}}).start();
 const admin=new RhoClient({url:service.url,token:service.adminToken}),p=await admin.call('project.open',{path:'project'}),person=new BrowserClient({url:service.url});
 const call=(m,b={})=>person.call(m,{projectId:p.id,...b});
 await fs.writeFile(path.join(p.root,'analysis.py'),'print(0)\n');let d=await call('document.open',{path:'analysis.py'});await call('document.edit',{documentId:d.id,expectedVersion:d.version,expectedRevision:d.revision,changeId:'human',undoGroup:'human',edits:[{from:d.content.length,to:d.content.length,insert:'# unsaved human\n'}]});
 const start=await call('conversation.start',{changeId:'one',text:'write'}),id=start.conversation.conversationId;
 async function done(){for(let i=0;i<200;i++){const r=await call('conversation.read',{conversationId:id});if(r.turns.at(-1).state!=='running'&&r.turns.at(-1).evidence?.records.length&&r.turns.at(-1).evidence.records.every(x=>x.state!=='pending'))return r;await new Promise(r=>setTimeout(r,20));}throw Error('capture timeout');}
 const a=await done();const snapshots=a.turns[0].evidence.records.flatMap(r=>r.snapshots);assert.ok(snapshots.some(s=>s.source.kind==='buffer'&&s.source.dirty));const old=snapshots.find(s=>s.source.kind==='disk');assert.ok(old);
 await call('conversation.send',{conversationId:id,changeId:'two',text:'write again'});await done();await fs.rm(path.join(p.root,'analysis.py'));
 const page=await call('resource.read',{resource:old.resource,offset:0});assert.equal(Buffer.from(page.data,'base64').toString(),'print(1)\n');
 await call('conversation.send',{conversationId:id,changeId:'two',text:'write again'});assert.equal((await call('conversation.read',{conversationId:id})).turns.length,2);
 await assert.rejects(fs.stat(path.join(p.root,'.rho/host.sock')),{code:'ENOENT'});
 await assert.rejects(call('conversation.send',{conversationId:id,changeId:'two',text:'a different intent'}),e=>e.error?.kind==='conflict');
 await assert.rejects(admin.call('annotation.decide',{projectId:p.id,annotationId:'q',expectedVersion:1,changeId:'spoof',targetMessageId:'x',resources:[old.resource],status:'accepted'}),e=>e.error?.kind==='unauthorized');
 const journal=path.join(p.root,'.rho/rho/conversations',id+'.json');await service.close();service=null;
 const saved=JSON.parse(await fs.readFile(journal,'utf8'));saved.turns[0].evidence.records[0].state='pending';saved.turns[0].evidence.records[0].snapshots=[];await fs.writeFile(journal,JSON.stringify(saved));
 service=await new RhoService({root,stateDir:path.join(root,'.service'),rscript:'/missing',conversations:{maxCaptureFiles:1,maxCaptureBytes:2,maxSnapshotBytes:2},claudeAcp:{command:{file:process.execPath,args:[path.join(root,'peer.mjs')]}}}).start();
 const restarted=new BrowserClient({url:service.url});const reopened=await restarted.call('conversation.read',{projectId:p.id,conversationId:id});assert.equal(reopened.turns[0].evidence.records[0].state,'interrupted');assert.equal(reopened.turns[0].evidence.records[0].snapshots.length,0);assert.equal((await restarted.call('resource.read',{projectId:p.id,resource:old.resource,offset:0})).resource.version,old.resource.version);
 await restarted.call('conversation.send',{projectId:p.id,conversationId:id,changeId:'limited',text:'write within a tiny capture budget'});
 for(let i=0;i<200;i++){const read=await restarted.call('conversation.read',{projectId:p.id,conversationId:id});if(read.turns.at(-1).state!=='running'&&read.turns.at(-1).evidence?.records.every(r=>r.state!=='pending')){assert.equal(read.turns.at(-1).state,'completed');assert.ok(read.turns.at(-1).evidence.records.every(r=>r.state==='unavailable'));assert.ok(read.turns.at(-1).evidence.omitted>0);break;}if(i===199)throw Error('limited capture timeout');await new Promise(r=>setTimeout(r,20));}

 }finally{await service?.close();await fs.rm(root,{recursive:true,force:true});}
});
