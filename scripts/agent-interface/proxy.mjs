import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {digest,json,parseRpc} from './runtime.mjs';

/** Transparent test transport: does not invent capabilities or scientific results.
 * Fault hooks alter fixture state or interrupt delivery, never fabricate owner replies.
 */
export class RecordingProxy {
  constructor(host,scenario,evidence,{maxCalls=80,maxTextBytes=1024*1024}={}) {
    this.host=host;this.scenario=scenario;this.evidence=evidence;this.limits={maxCalls,maxTextBytes};this.token=randomUUID();this.calls=[];this.responses=[];this.violations=[];this.images=[];this.textBytes=0;this.discoveryBytes=0;this.sequence=0;this.inflight=new Set();this.readonlyTools=new Set();this.finished=false;this.imageResources=new Map();
    fs.mkdirSync(path.join(evidence,'images'),{recursive:true});this.trace=fs.createWriteStream(path.join(evidence,'mcp.jsonl'),{mode:0o600});
  }
  fail(reason) {this.violations.push(reason);this.onViolation?.(reason);}
  async start() {
    this.server=http.createServer((request,response)=>{const promise=this.forward(request,response).catch(error=>{this.trace.write(JSON.stringify({direction:'proxy_error',message:error.message})+'\n');if(!response.headersSent)response.writeHead(502,{'content-type':'text/plain'});response.end('Recorded MCP transport failure');});this.inflight.add(promise);promise.finally(()=>this.inflight.delete(promise));});
    this.server.listen(0,'127.0.0.1');await once(this.server,'listening');this.url=`http://127.0.0.1:${this.server.address().port}/mcp`;return this;
  }
  async forward(request,response) {
    if(request.url!=='/mcp'||request.headers.authorization!==`Bearer ${this.token}`){response.writeHead(401);response.end();return;}
    let body=Buffer.alloc(0);for await(const chunk of request){body=Buffer.concat([body,chunk]);assert.ok(body.length<=512*1024,'MCP request budget');}
    const rpc=body.length?JSON.parse(body):null;
    const call={sequence:++this.sequence,at_ms:Date.now(),rpc};
    this.trace.write(JSON.stringify({direction:'request',...call})+'\n');
    const evaluated=rpc&&['tools/call','resources/read'].includes(rpc.method);
    if(evaluated){
      this.calls.push(call);this.onAccountingChange?.();if(this.calls.length>this.limits.maxCalls){this.fail('tool_call_budget_exceeded');response.writeHead(429);response.end('Tool call budget exceeded');return;}
      const violationsBefore=this.violations.length;
      if(rpc.method==='tools/call') {
        const name=rpc.params?.name;const args=rpc.params?.arguments??{};
        if(!name?.startsWith('rho.'))this.fail(`non_rho_tool:${name}`);
        if(this.scenario.prohibitR&&name==='rho.workspace.run_r.v1')this.fail('readonly_task_executed_R');
        if(this.scenario.readonly&&!this.readonlyTools.has(name)&&!explicitReadTaskAction(this.scenario.id,name,args))this.fail(`readonly_task_mutation:${name}`);
        if(['rho.process.run_local.v1','rho.process.run_remote.v1','rho.slurm.submit.v1'].includes(name))this.fail(`scientific_sidechannel:${name}`);
        const code=args.arguments?.code;
        if(typeof code==='string'&&/\b(system2?|download\.file|socketConnection|url)\s*\(/.test(code))this.fail('R_code_attempted_external_sidechannel');
        if('caller' in args||'principal' in args||'actor' in args)this.fail('caller_supplied_authority');
      }
      if(this.violations.length!==violationsBefore){response.writeHead(403,{'content-type':'text/plain'});response.end('Acceptance boundary rejected a prohibited Agent action');return;}
      await this.scenario.beforeCall?.(call,this);
    }
    const headers={authorization:`Bearer ${this.host.token}`,accept:request.headers.accept??'application/json, text/event-stream',...(body.length?{'content-type':'application/json'}:{})};
    for(const key of ['mcp-session-id','mcp-protocol-version','last-event-id'])if(request.headers[key])headers[key]=request.headers[key];
    const abort=new AbortController();response.once('close',()=>abort.abort());
    const upstream=await fetch(`${this.host.origin}/mcp`,{method:request.method,headers,signal:abort.signal,...(body.length?{body}:{})});
    const outHeaders={};for(const key of ['content-type','mcp-session-id','mcp-protocol-version','cache-control'])if(upstream.headers.has(key))outHeaders[key]=upstream.headers.get(key);
    if(request.method==='GET') {
      response.writeHead(upstream.status,outHeaders);
      if(upstream.body)for await(const chunk of upstream.body){if(response.destroyed)break;response.write(chunk);}response.end();return;
    }
    const raw=Buffer.from(await upstream.arrayBuffer());
    let messages=[];try{messages=parseRpc(raw.toString('utf8'));}catch(error){if(upstream.ok&&raw.length)this.fail(`unparseable_MCP_response:${error.message}`);}
    for(const message of messages){
      const result=message.result;if(rpc?.method==='tools/list')for(const tool of result?.tools??[])if(tool.annotations?.readOnlyHint===true)this.readonlyTools.add(tool.name);
      this.observeImageResources(rpc,result);const binding=rpc?.method==='resources/read'?this.imageResources.get(rpc.params?.uri):null;
      const clean=this.extractImages(message,call.sequence,binding);
      const textSize=textResponseBytes(message,binding);
      if(evaluated){this.textBytes+=textSize;this.responses.push({call,...clean});this.onAccountingChange?.();if(this.textBytes>this.limits.maxTextBytes)this.fail('text_tool_return_budget_exceeded');}
      else this.discoveryBytes+=textSize;
      this.trace.write(JSON.stringify({direction:'response',sequence:call.sequence,at_ms:Date.now(),message:clean})+'\n');
      if(evaluated)await this.scenario.afterResponse?.(call,message,this);
      // Tool error responses are retained; they are not automatically a failed
      // task because version/expiry recovery deliberately observes such errors.
      const record=operationRecord(rpc?.params?.name,result?.structuredContent?.result);if(record)this.checkIdentity(record);
      if(rpc?.params?.name==='rho.workspace.read_object.v1'&&result?.structuredContent?.result?.status==='ready'){const page=result.structuredContent.result.data;if(page){assert.equal(typeof page.root_name,'string','ObjectReadPage must preserve root binding identity');assert.ok(Array.isArray(page.observed_path)&&Array.isArray(page.path),'ObjectReadPage must distinguish observed and relative paths');}}
    }
    response.writeHead(upstream.status,outHeaders);response.end(raw);
  }
  checkIdentity(record) {
    const op=record.operation;if(!op||this.host.seedRecords.includes(op.operation_id))return;
    if(op.principal?.kind!=='human'||op.principal?.id!=='local-user')this.fail(`principal_mixup:${op.operation_id}`);
    if(op.caller?.kind!=='agent'||op.caller?.id!=='local-mcp')this.fail(`actor_mixup:${op.operation_id}`);
  }
  observeImageResources(rpc,result) {
    if(result?.isError)return;
    if(['rho.output.view','rho.output.view.v1'].includes(rpc?.params?.name)){
      const reference=result?.structuredContent?.result?.data?.reference;
      if(reference?.mime_type?.startsWith('image/'))for(const item of result.content??[])if(item.type==='resource_link'){
        const address=new URL(item.uri);assert.equal(address.protocol,'rho-output:');assert.deepEqual(JSON.parse(Buffer.from(address.pathname.slice(1),'base64url').toString('utf8')),reference);
        assert.equal(address.hostname,reference.byte_size<=4*1024*1024?'original':'manifest');
        this.imageResources.set(item.uri,{uri:item.uri,kind:address.hostname,reference,offset:0,byte_size:reference.byte_size});
      }
    }
    const binding=rpc?.method==='resources/read'?this.imageResources.get(rpc.params?.uri):null;
    if(binding?.kind==='manifest')for(const item of result.contents??[])if(item.uri===binding.uri&&typeof item.text==='string'){
      const manifest=JSON.parse(item.text);assert.deepEqual(manifest.reference,binding.reference);assert.equal(manifest.chunk_bytes,65536);
      let offset=0;for(const part of manifest.chunks){
        assert.equal(part.offset,offset);assert.equal(part.byte_size,Math.min(65536,binding.reference.byte_size-offset));assert.ok(part.byte_size>0);
        const address=new URL(part.uri),segments=address.pathname.slice(1).split('/');assert.equal(address.protocol,'rho-output:');assert.equal(address.hostname,'chunk');assert.equal(Number(segments[0]),part.offset);
        assert.deepEqual(JSON.parse(Buffer.from(segments[1],'base64url').toString('utf8')),binding.reference);
        this.imageResources.set(part.uri,{...binding,uri:part.uri,kind:'chunk',manifest_uri:binding.uri,offset:part.offset,byte_size:part.byte_size});offset+=part.byte_size;
      }
      assert.equal(offset,binding.reference.byte_size,'manifest must cover the exact original bytes');
    }
  }
  extractImages(value,sequence,binding=null) {
    if(Array.isArray(value))return value.map(v=>this.extractImages(v,sequence,binding));
    if(!value||typeof value!=='object')return value;
    if(value.type==='image'&&typeof value.data==='string'){
      const bytes=Buffer.from(value.data,'base64');const sha=digest(bytes);const relative=`images/${sequence}-${sha.slice(7)}.${value.mimeType==='image/png'?'png':'bin'}`;fs.writeFileSync(path.join(this.evidence,relative),bytes);this.images.push({sequence,mime_type:value.mimeType,bytes:bytes.length,sha256:sha,file:relative});return {...value,data:undefined,artifact:relative,sha256:sha,byte_size:bytes.length};
    }
    if(isImageBlob(value,binding)){const bytes=Buffer.from(value.blob,'base64');if(binding&&value.uri===binding.uri)assert.equal(bytes.length,binding.byte_size);
      const sha=digest(bytes),relative=`images/resource-${sequence}-${sha.slice(7)}.bin`;fs.writeFileSync(path.join(this.evidence,relative),bytes);
      this.images.push({sequence,mime_type:binding?.reference.mime_type??value.mimeType,bytes:bytes.length,sha256:sha,file:relative,resource:true,...(binding&&value.uri===binding.uri?{resource_uri:binding.uri,manifest_uri:binding.manifest_uri,reference:binding.reference,offset:binding.offset,chunk:binding.kind==='chunk'}:{})});return {...value,blob:undefined,artifact:relative,sha256:sha,byte_size:bytes.length};}
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,this.extractImages(v,sequence,binding)]));
  }
  toolCalls(name) {return this.calls.filter(c=>c.rpc?.params?.name===name);}
  results(name) {return this.responses.filter(r=>r.call.rpc?.params?.name===name).map(r=>r.result?.structuredContent?.result);}
  hasDiagnostic(code) {return this.responses.some(response=>JSON.stringify(response).toLowerCase().includes(code.toLowerCase()));}
  records() {return this.responses.flatMap(response=>{const record=operationRecord(response.call.rpc?.params?.name,response.result?.structuredContent?.result);return record?[record]:[];});}
  receipts() {return this.responses.flatMap(response=>{const name=response.call.rpc?.params?.name,value=response.result?.structuredContent?.result;
    if(name==='rho.application.command_status.v1')return value?.data?[value.data]:[];
    if(name==='rho.application.control.v1')return value?[value]:[];return [];});}
  assertNoDuplicateExecution() {
    try {assertOperationIdentities(this.records(),this.receipts());} catch(error){this.fail(error.message);}
  }
  async close() {if(this.finished)return;this.finished=true;this.server?.closeAllConnections();if(this.server)await new Promise(resolve=>this.server.close(resolve));await Promise.allSettled([...this.inflight]);this.trace.end();await once(this.trace,'finish');this.assertNoDuplicateExecution();
    const originals=[];for(const binding of this.imageResources.values())if(binding.kind==='manifest'){
      const chunks=new Map();for(const image of this.images.filter(image=>image.chunk&&image.manifest_uri===binding.uri)){const previous=chunks.get(image.offset);if(previous&&previous.sha256!==image.sha256)this.fail('incoherent_original_chunk');chunks.set(image.offset,image);}
      let offset=0;const parts=[];for(const [position,image] of [...chunks].sort((a,b)=>a[0]-b[0])){if(position!==offset)break;parts.push(fs.readFileSync(path.join(this.evidence,image.file)));offset+=image.bytes;}
      const complete=offset===binding.reference.byte_size;if(complete&&digest(Buffer.concat(parts))!==binding.reference.sha256)this.fail('original_reassembly_digest_mismatch');originals.push({reference:binding.reference,complete,contiguous_bytes:offset});
    }
    this.onAccountingChange?.();json(path.join(this.evidence,'transport.json'),{calls:this.calls.length,text_bytes:this.textBytes,discovery_bytes:this.discoveryBytes,images:this.images,original_reassemblies:originals,violations:this.violations});}
}

export function operationRecord(tool,result) {
  // These are distinct registered wire contracts, not shape-based fallback.
  if(tool==='rho.operation.get.v1')return result?.data?.record??null;
  if(tool==='rho.operation.get')return result??null;
  if(['rho.operation.request_cancellation','rho.operation.request_cancellation.v1'].includes(tool))return result?.operation??null;
  return result?.operation?.operation_id?result:null;
}

export function assertOperationIdentities(records,receipts=[]) {
  const byRequest=new Map(),byStep=new Map();
  for(const {operation:op} of records){
    const key=JSON.stringify([op.idempotency_scope??null,op.principal??op.caller,op.caller,op.client_request_id]);
    const previous=byRequest.get(key);assert.ok(!previous||previous===op.operation_id,`duplicate_request_executed:${op.client_request_id}`);byRequest.set(key,op.operation_id);
  }
  for(const receipt of receipts)for(const step of ['save','run'])if(receipt[step]?.operation_id){
    const key=JSON.stringify([receipt.window,receipt.request_id,step]),id=receipt[step].operation_id,previous=byStep.get(key);
    assert.ok(!previous||previous===id,`duplicate_application_execution:${receipt.request_id}:${step}`);byStep.set(key,id);
  }
}

/** Provenance comes from consumed replies, never merely from caller arguments. */
export function consumedIdentities(responses) {
  const identities=new Set(),operationIds=new Set();
  const keys=/^(?:operation_id|client_request_id|window_id|incarnation|document_id|document_version|selection_version|context_version|session_id|native_session_id|object_ref|directory_ref|observation_id|index_ref|skill_ref|source_ref|resource_ref|sha256|.*_sha256|.*_digest|native_identity|project_root)$/;
  function visit(value) {
    if(Array.isArray(value)){for(const item of value)visit(item);return;}
    if(!value||typeof value!=='object')return;
    for(const [key,item] of Object.entries(value)){
      // Arguments/examples and uncommitted candidate bodies are data, not
      // proof that a referenced native resource exists.
      if(['arguments','normalized_arguments','preconditions','documentation','input_schema','output_schema','recovery_schema','candidate','next_reads'].includes(key))continue;
      if(keys.test(key)&&typeof item==='string'&&item.length>=3)identities.add(item);
      if(key==='operation_id'&&typeof item==='string')operationIds.add(item);
      visit(item);
    }
  }
  for(const response of responses){
    const value=response.result?.structuredContent?.result,record=operationRecord(response.call?.rpc?.params?.name,value);
    if(authoritativeOperationRecord(record))visit(record);
    else if(!response.error&&!response.result?.isError)visit(value??response.result);
  }
  return {identities,operationIds};
}

function authoritativeOperationRecord(record) {
  const operation=record?.operation;
  return !!operation&&typeof operation.operation_id==='string'&&typeof operation.client_request_id==='string'&&
    typeof operation.domain==='string'&&typeof operation.target?.kind==='string'&&typeof operation.target.identity==='string'&&
    typeof operation.caller?.kind==='string'&&typeof operation.caller.id==='string'&&
    typeof operation.capability?.id==='string'&&Number.isInteger(operation.capability.version)&&operation.capability.version>0&&
    ['accepted','running','reconciling','succeeded','failed','cancelled','uncertain'].includes(record.status)&&
    ['outcome','output','error','recovery','cancellation_requested','updated_at_ms'].every(key=>Object.hasOwn(record,key))&&
    typeof record.cancellation_requested==='boolean'&&Number.isFinite(record.updated_at_ms);
}

export function assertConsumedEvidence(report,responses,nativeSkillReads=[]) {
  const {identities,operationIds}=consumedIdentities(responses);
  for(const file of nativeSkillReads)identities.add(file);
  const timed=responses.flatMap(response=>{const value=response.result?.structuredContent?.result,tool=response.call?.rpc?.params?.name;
    return value?.source&&Number.isFinite(value.observed_at_ms)&&tool?[{source:value.source,time:String(value.observed_at_ms),names:[tool,tool.replace(/^rho\./,'').replace(/\.v(\d+)$/,'@$1')]}]:[];});
  for(const fact of report.facts)assert.ok(fact.evidence.some(citation=>[...identities].some(id=>citation.includes(id))||
    timed.some(observation=>citation.includes(observation.time)&&[observation.source,...observation.names].some(name=>citation.includes(name)))),`fact ${fact.key} lacks a consumed native/resource/version identity or timed owner observation`);
  for(const id of report.operation_ids)assert.ok(operationIds.has(id),`reported operation was not present in consumed evidence: ${id}`);
}

function isImageBlob(value,binding) {return typeof value.blob==='string'&&(value.mimeType?.startsWith('image/')||
  (binding?.kind==='chunk'&&binding.reference?.mime_type?.startsWith('image/')&&value.uri===binding.uri&&value.mimeType==='application/octet-stream'));}
export function textResponseBytes(value,binding=null) {
  let encodedImageBytes=0;
  function visit(item) {
    if(Array.isArray(item)){for(const child of item)visit(child);return;}
    if(!item||typeof item!=='object')return;
    if(item.type==='image'&&typeof item.data==='string')encodedImageBytes+=Buffer.byteLength(item.data);
    if(isImageBlob(item,binding))encodedImageBytes+=Buffer.byteLength(item.blob);
    for(const [key,child] of Object.entries(item))if(!['data','blob'].includes(key)||typeof child!=='string')visit(child);
  }
  visit(value);return Buffer.byteLength(JSON.stringify(value))-encodedImageBytes;
}

export function explicitReadTaskAction(task,name,args) {
  return (task==='package_copies'&&name==='rho.workspace.help.v1')
    || (task==='recovery_disconnect'&&name==='rho.application.control.v1'&&args.action?.kind==='run_file');
}
