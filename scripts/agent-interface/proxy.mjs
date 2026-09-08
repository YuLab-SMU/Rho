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
    this.host=host;this.scenario=scenario;this.evidence=evidence;this.limits={maxCalls,maxTextBytes};this.token=randomUUID();this.calls=[];this.responses=[];this.violations=[];this.images=[];this.textBytes=0;this.discoveryBytes=0;this.sequence=0;this.inflight=new Set();this.readonlyTools=new Set();
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
      this.calls.push(call);if(this.calls.length>this.limits.maxCalls){this.fail('tool_call_budget_exceeded');response.writeHead(429);response.end('Tool call budget exceeded');return;}
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
      const result=message.result;if(rpc?.method==='tools/list')for(const tool of result?.tools??[])if(tool.annotations?.readOnlyHint===true)this.readonlyTools.add(tool.name);const clean=this.extractImages(message,call.sequence);
      const textSize=textResponseBytes(message);
      if(evaluated){this.textBytes+=textSize;this.responses.push({call,...clean});if(this.textBytes>this.limits.maxTextBytes)this.fail('text_tool_return_budget_exceeded');}
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
  extractImages(value,sequence) {
    if(Array.isArray(value))return value.map(v=>this.extractImages(v,sequence));
    if(!value||typeof value!=='object')return value;
    if(value.type==='image'&&typeof value.data==='string'){
      const bytes=Buffer.from(value.data,'base64');const sha=digest(bytes);const relative=`images/${sequence}-${sha.slice(7)}.${value.mimeType==='image/png'?'png':'bin'}`;fs.writeFileSync(path.join(this.evidence,relative),bytes);this.images.push({sequence,mime_type:value.mimeType,bytes:bytes.length,sha256:sha,file:relative});return {...value,data:undefined,artifact:relative,sha256:sha,byte_size:bytes.length};
    }
    if(typeof value.blob==='string'&&value.mimeType?.startsWith('image/')){const bytes=Buffer.from(value.blob,'base64');const sha=digest(bytes);const relative=`images/resource-${sequence}-${sha.slice(7)}.bin`;fs.writeFileSync(path.join(this.evidence,relative),bytes);this.images.push({sequence,mime_type:value.mimeType,bytes:bytes.length,sha256:sha,file:relative,resource:true});return {...value,blob:undefined,artifact:relative,sha256:sha,byte_size:bytes.length};}
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,this.extractImages(v,sequence)]));
  }
  toolCalls(name) {return this.calls.filter(c=>c.rpc?.params?.name===name);}
  results(name) {return this.responses.filter(r=>r.call.rpc?.params?.name===name).map(r=>r.result?.structuredContent?.result);}
  hasDiagnostic(code) {return this.responses.some(response=>JSON.stringify(response).toLowerCase().includes(code.toLowerCase()));}
  assertNoDuplicateExecution() {
    const byRequest=new Map();const codeOperations=new Map();
    for(const response of this.responses){const record=operationRecord(response.call.rpc?.params?.name,response.result?.structuredContent?.result);if(!record)continue;const op=record.operation;if(this.host.seedRecords.includes(op.operation_id))continue;const key=op.client_request_id;const previous=byRequest.get(key);if(previous&&previous!==op.operation_id)this.fail(`duplicate_request_executed:${key}`);byRequest.set(key,op.operation_id);
      if(op.capability?.id==='workspace.run_r'){const code=op.normalized_arguments?.code;if(code){const ids=codeOperations.get(code)??new Set();ids.add(op.operation_id);codeOperations.set(code,ids);}}
    }
    for(const ids of codeOperations.values())if(ids.size>1)this.fail(`duplicate_scientific_code_execution:${[...ids].join(',')}`);
  }
  async close() {this.server?.closeAllConnections();if(this.server)await new Promise(resolve=>this.server.close(resolve));await Promise.allSettled([...this.inflight]);this.trace.end();await once(this.trace,'finish');this.assertNoDuplicateExecution();json(path.join(this.evidence,'transport.json'),{calls:this.calls.length,text_bytes:this.textBytes,discovery_bytes:this.discoveryBytes,images:this.images,violations:this.violations});}
}

export function operationRecord(tool,result) {
  // These are distinct registered wire contracts, not shape-based fallback.
  if(tool==='rho.operation.get.v1')return result?.data?.record??null;
  if(tool==='rho.operation.get')return result??null;
  return result?.operation?.operation_id?result:null;
}

export function textResponseBytes(value) {
  let encodedImageBytes=0;
  function visit(item) {
    if(Array.isArray(item)){for(const child of item)visit(child);return;}
    if(!item||typeof item!=='object')return;
    if(item.type==='image'&&typeof item.data==='string')encodedImageBytes+=Buffer.byteLength(item.data);
    if(item.mimeType?.startsWith('image/')&&typeof item.blob==='string')encodedImageBytes+=Buffer.byteLength(item.blob);
    for(const [key,child] of Object.entries(item))if(!['data','blob'].includes(key)||typeof child!=='string')visit(child);
  }
  visit(value);return Buffer.byteLength(JSON.stringify(value))-encodedImageBytes;
}

export function explicitReadTaskAction(task,name,args) {
  return (task==='package_copies'&&name==='rho.workspace.help.v1')
    || (task==='recovery_disconnect'&&name==='rho.application.control.v1'&&args.action?.kind==='run_file');
}
