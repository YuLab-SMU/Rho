import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {canonical,digest} from '@rho-workspace/plugin-contracts';
import {LayeredMcp} from '@rho-workspace/plugin-agent/layered';
import {RhoService} from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { validateResponse, responseProblems } from '../dist/contract-runtime.js';
const require=createRequire(import.meta.resolve('@rho-workspace/plugin-agent'));
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
async function connect(file,measures=[]){const client=new Client({name:'layered-acceptance',version:'1.0'}),transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(import.meta.resolve('@rho-workspace/plugin-agent/mcp'))],env:{PATH:process.env.PATH,RHO_AGENT_CONNECTION:file},stderr:'pipe'});transport.stderr.resume();await client.connect(transport);const original=client.callTool.bind(client);client.callTool=async(...args)=>{const reply=await original(...args);measures.push({tool:args[0].name,requestBytes:Buffer.byteLength(JSON.stringify(args[0].arguments)),textBytes:Buffer.byteLength(reply.content[0].text),isError:!!reply.isError,structuredCopy:'structuredContent' in reply});return reply;};return client;}
async function call(client,name,input){const reply=await client.callTool({name,arguments:input});assert.equal('structuredContent' in reply,false);assert.equal(reply.content.length,1);return JSON.parse(reply.content[0].text);}
const query={after:0,cursor:null,limit:100,maxBytes:65536};
test('default progressive MCP pages whole contracts, reuses knownRefs, refetches after context/process loss and rejects stale authorization',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rho-layered-')),service=await new RhoService({root,stateDir:path.join(root,'state'),coreBinary:'/missing',rscript:'/missing',plugins:['documents','files','tables','agent']}).start();let client; const measures=[];
 try{
 const admin=new RhoClient({url:service.url,token:service.adminToken}),p=await admin.call('project.create',{name:'project'}),doc=await admin.call('document.open',{projectId:p.id,path:'notes.md'});
 await admin.call('document.edit',{projectId:p.id,documentId:doc.id,expectedVersion:doc.version,edits:[{from:0,to:0,insert:'共享的原始说明 🧬'}],undoGroup:'seed'});
 const file=path.join(root,'business.private.json');await service.agentConnection(p.id,'business',file,['document.read'],undefined);
 const calls=[],dispatch=service.dispatch.bind(service);service.dispatch=async(request,principal,ref)=>{if(principal.profile)calls.push({method:request.method,bodyBytes:Buffer.byteLength(JSON.stringify(request.body)),contractRef:ref??null});return dispatch(request,principal,ref);};
 client=await connect(file,measures);const tools=await client.listTools();assert.deepEqual(tools.tools.map(t=>t.name),['rho_index','rho_resolve','rho_call','rho_read']);assert.ok(JSON.stringify(tools).length<8000);assert.equal(calls.length,0);
 const groups=await call(client,'rho_index',{});assert.deepEqual(groups.value.groups,[{owner:'documents',operations:1}]);assert.deepEqual(groups.value.entries,[]);
 let index=await call(client,'rho_index',{owner:'documents',cursor:null,maxBytes:16384});assert.equal(index.ok,true);assert.deepEqual(index.value.entries.map(e=>e.id),['document.read']);
 const oldAuthorization=index.value.authorizationRef;const entry=index.value.entries[0],invoke={operation:'document.read',contractRef:entry.contractRef,input:{documentId:doc.id}};
 assert.equal((await call(client,'rho_call',invoke)).error.kind,'condition');assert.equal(calls.some(c=>c.method==='document.read'),false);
 let input={catalogRef:index.value.catalogRef,selected:['document.read'],knownRefs:[],cursor:null,maxBytes:1024},page=await call(client,'rho_resolve',input);assert.equal(page.ok,true);assert.equal(page.value.complete,false);assert.equal(page.value.items.length,0);assert.ok(page.value.requiredBytes>1024);
 const objects=new Map();let pages=1;
 for(let n=0;n<20;n++){
   if(page.value.requiredBytes){input={...input,maxBytes:Math.max(4096,page.value.requiredBytes),cursor:null,knownRefs:[...objects.keys()]};}
   else input={...input,cursor:page.value.next};
   page=await call(client,'rho_resolve',input);pages++;assert.equal(page.ok,true,JSON.stringify(page));
   for(const object of page.value.items){assert.equal(digest(canonical(object.content)),object.ref);objects.set(object.ref,object);}
   if(page.value.complete)break;
 }
 assert.equal(page.value.complete,true);assert.ok(pages>1);assert.ok(objects.has(entry.contractRef));
 // The dynamic MCP call is validated against the resolved owner contract and then
 // enters the same service operation as a direct HTTP call: the accepted value must
 // conform to that operation's published response, and equal the direct reply.
 const viaMcp=await call(client,'rho_call',invoke);
 assert.equal(viaMcp.value.content,'共享的原始说明 🧬');
 assert.ok(validateResponse('document.read',viaMcp.value),'rho_call response: '+JSON.stringify(responseProblems('document.read')));
 assert.deepEqual(viaMcp.value,await admin.call('document.read',{projectId:p.id,documentId:doc.id}));
 const known=await call(client,'rho_resolve',{catalogRef:index.value.catalogRef,selected:['document.read'],knownRefs:[...objects.keys()],cursor:null,maxBytes:1024});assert.equal(known.value.items.length,0);assert.equal(known.value.omittedKnownRefs.length,objects.size);
 const refetched=await call(client,'rho_resolve',{catalogRef:index.value.catalogRef,selected:['document.read'],knownRefs:[],cursor:null,maxBytes:65536});assert.equal(refetched.value.items.length,objects.size);
 const count=calls.length;assert.equal((await call(client,'rho_resolve',{catalogRef:index.value.catalogRef,selected:Array(17).fill('document.read'),knownRefs:[],cursor:null,maxBytes:65536})).error.kind,'invalid');assert.equal(calls.length,count);
 assert.equal((await call(client,'rho_call',{...invoke,input:{documentId:doc.id,projectId:'other'}})).error.kind,'invalid');
 await admin.call('capability.configure',{projectId:p.id,expectedVersion:0,changeId:'off',enabled:['files','tables','agent']});
 assert.equal((await call(client,'rho_call',invoke)).error.kind,'stale');assert.equal(calls.filter(c=>c.method==='document.read').length,2);
 await admin.call('capability.configure',{projectId:p.id,expectedVersion:1,changeId:'on',enabled:['documents','files','tables','agent']});
 assert.equal((await call(client,'rho_resolve',{catalogRef:index.value.catalogRef,selected:['document.read'],knownRefs:[...objects.keys()],cursor:null,maxBytes:65536})).error.kind,'stale');
 index=await call(client,'rho_index',{owner:'documents',cursor:null,maxBytes:16384});assert.notEqual(index.value.authorizationRef,oldAuthorization);assert.equal(index.value.entries[0].contractRef,entry.contractRef);
 const restored=await call(client,'rho_resolve',{catalogRef:index.value.catalogRef,selected:['document.read'],knownRefs:[...objects.keys()],cursor:null,maxBytes:65536});assert.deepEqual(restored.value.items.map(o=>o.kind),['contract']);assert.equal((await call(client,'rho_call',invoke)).ok,true);
 await client.close();client=await connect(file,measures);assert.equal((await call(client,'rho_call',invoke)).error.kind,'condition');
 const afterRestart=await call(client,'rho_resolve',{catalogRef:index.value.catalogRef,selected:['document.read'],knownRefs:[...objects.keys()],cursor:null,maxBytes:65536});assert.equal(afterRestart.value.items.length,objects.size);assert.equal((await call(client,'rho_call',invoke)).ok,true);
 assert.equal(calls.some(c=>['protocol.describe','capability.list'].includes(c.method)),false);assert.equal(service.bridge.owned.size,0);
 console.log('PHASE4_MCP_METRICS '+JSON.stringify({toolsListBytes:Buffer.byteLength(JSON.stringify(tools)),toolCalls:measures.length,modelCalls:0,inputTokens:0,outputTokens:0,requests:calls,measures}));
 }finally{if(client)await client.close();await service.close();await fs.rm(root,{recursive:true,force:true});}
});
test('incomplete schema closure and forged immutable bodies never become executable cache proofs',async()=>{
 let executions=0;const make=content=>({ref:digest(canonical(content)),kind:'contract',content});
 const partial=make({method:'document.read',requiredSkillRefs:[],inputSchema:{$ref:'#/definitions/Missing'},outputSchema:{type:'object'},definitions:{}});
 const layer=new LayeredMcp({profile:'layered-business',methods:['document.read']},{invoke:async method=>{if(method==='capability.resolve')return{ok:true,value:{items:[partial]}};executions++;return{ok:true,value:{}};},retain:async()=>{}});
 await assert.rejects(layer.resolve({catalogRef:'0'.repeat(64),selected:['document.read'],knownRefs:[],cursor:null,maxBytes:65536}),e=>e.kind==='condition');
 await assert.rejects(layer.call({operation:'document.read',contractRef:partial.ref,input:{}}),e=>e.kind==='condition');assert.equal(executions,0);
 partial.ref='0'.repeat(64);await assert.rejects(layer.resolve({catalogRef:'0'.repeat(64),selected:['document.read'],knownRefs:[],cursor:null,maxBytes:65536}),e=>e.kind==='condition');
});
test('bounded cache preserves fetched bodies but refuses execution when it cannot retain a complete proof',async()=>{
 const content={method:'noop',inputSchema:{type:'object',additionalProperties:false},outputSchema:{type:'object'},definitions:{},requiredSkillRefs:[]},object={ref:digest(canonical(content)),kind:'contract',content};let executions=0;
 const layer=new LayeredMcp({profile:'layered-business',methods:['noop']},{invoke:async method=>{if(method==='capability.resolve')return{ok:true,value:{items:[object]}};executions++;return{ok:true};},retain:async()=>{}},1,1);
 assert.deepEqual((await layer.resolve({knownRefs:[]})).value.items,[object]);await assert.rejects(layer.call({operation:'noop',contractRef:object.ref,input:{}}),e=>e.kind==='condition');assert.equal(executions,0);
});
