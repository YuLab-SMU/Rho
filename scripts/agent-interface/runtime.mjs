import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import readline from 'node:readline';
export const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), {mode:0o600});
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const terminal = record => ['succeeded','failed','cancelled','uncertain','rejected'].includes(record?.status);
export async function until(read, predicate, label, timeout=45000) {
  const deadline=Date.now()+timeout; let last;
  do { last=await read(); if(predicate(last)) return last; await delay(100); } while(Date.now()<deadline);
  throw new Error(`${label} timed out: ${JSON.stringify(last).slice(0,2000)}`);
}
export function exec(program,args,options={}) {
  const r=spawnSync(program,args,{encoding:'utf8',timeout:60000,...options});
  assert.equal(r.status,0,`${program}: ${r.error?.message||r.stderr||r.signal}`); return r.stdout.trim();
}
export function parseRpc(text) {
  if(!text.trim()) return [];
  if(text.trimStart().startsWith('{')||text.trimStart().startsWith('[')) { const value=JSON.parse(text); return Array.isArray(value)?value:[value]; }
  return text.split(/\r?\n\r?\n/).flatMap(event=>{const data=event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');return data&&data!=='[DONE]'?[JSON.parse(data)]:[];});
}
export class McpClient {
  constructor(url, token) { this.url=url;this.token=token;this.sequence=0;this.session=null; }
  async request(method,params={},timeout=60000) {
    const id=++this.sequence;
    const reply=await fetch(this.url,{method:'POST',headers:{authorization:`Bearer ${this.token}`,accept:'application/json, text/event-stream','content-type':'application/json',...(this.session?{'mcp-session-id':this.session}:{})},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(timeout)});
    const session=reply.headers.get('mcp-session-id');if(session)this.session=session;
    const text=await reply.text();assert.ok(reply.ok,`MCP HTTP ${reply.status}: ${text.slice(0,2000)}`);
    const result=parseRpc(text).find(message=>message.id===id);assert.ok(result,`MCP ${method} lacks response ${id}`);
    if(result.error)throw new Error(JSON.stringify(result.error));return result.result;
  }
  async initialize() {
    const hello=await this.request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'rho-private-fixture',version:'1'}});
    assert.equal(hello.serverInfo.name,'rho');
    const response=await fetch(this.url,{method:'POST',headers:{authorization:`Bearer ${this.token}`,accept:'application/json, text/event-stream','content-type':'application/json','mcp-session-id':this.session},body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});await response.arrayBuffer();
    return hello;
  }
  call(name,args={}) { return this.request('tools/call',{name,arguments:args}); }
  async query(id,args={}) { const r=await this.call(`rho.${id}.v1`,args);assert.notEqual(r.isError,true,JSON.stringify(r));return r.structuredContent.result; }
  async close() { if(this.session) await fetch(this.url,{method:'DELETE',headers:{authorization:`Bearer ${this.token}`,'mcp-session-id':this.session}}).catch(()=>{}); }
}
export class FixtureHost {
  constructor(options, directory) { this.options=options;this.directory=directory;this.pages=[];this.contexts=[];this.seedRecords=[];this.browserTraffic=[]; }
  async start(project, skillsManifest=null) {
    this.project=fs.realpathSync(project);this.database=path.join(this.directory,'state','next.sqlite');
    const urlFile=path.join(this.directory,'launch.url');
    const args=['--database',this.database,'--project',this.project,'--ark',this.options.ark,'--r-home',this.options.rHome,...(skillsManifest?['--host-skills',skillsManifest]:[]),'workbench','--url-file',urlFile];
    this.child=spawn(this.options.binary,args,{stdio:['ignore','pipe','pipe']});
    const log=fs.createWriteStream(path.join(this.options.evidence,'host.stderr.log'),{mode:0o600});this.child.stderr.pipe(log);this.child.stdout.resume();
    this.exit=once(this.child,'exit');
    await until(()=>{if(this.child.exitCode!==null)throw new Error(`Fixture Host exited ${this.child.exitCode}`);return fs.existsSync(urlFile)?fs.readFileSync(urlFile,'utf8').trim():null;},Boolean,'private Host startup',90000).then(url=>{this.launchUrl=url;const u=new URL(url);this.origin=u.origin;this.token=new URLSearchParams(u.hash.slice(1)).get('token');assert.ok(this.token);});
    this.mcp=new McpClient(`${this.origin}/mcp`,this.token);await this.mcp.initialize();
    const status=await this.query('workspace.runtime_status');assert.equal(status.status,'ready','Fixture requires a real running R runtime, not Host project-only fallback');assert.ok(status.data?.session_id||status.target?.identity);
    this.session=(await this.query('workspace.console_state')).data.session_id;assert.ok(this.session,'real native R session required');
    return this;
  }
  async api(endpoint,body,windowId='acceptance-fixture') {
    const response=await fetch(`${this.origin}${endpoint}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json','X-Rho-Studio-Window':windowId},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
    const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;
  }
  async port(method,params,windowId) {const reply=await this.api('/api/host',{project_root:this.project,frame:{id:randomUUID(),request:{method,params}}},windowId);assert.equal(reply.ok,true,JSON.stringify(reply));return reply.result;}
  query(id,arguments_={}) {return this.port('query_snapshot',{capability:{id,version:1},arguments:arguments_});}
  async run(code,{id=`fixture-${randomUUID()}`,accepted=false,expect='succeeded'}={}) {
    const record=await this.port('invoke',{client_request_id:id,capability:{id:'workspace.run_r',version:1},arguments:{code,output_mode:'console'},preconditions:[],...(accepted?{return_after_acceptance:true}:{})});
    this.seedRecords.push(record.operation.operation_id);
    if(!accepted)assert.equal(record.status,expect,JSON.stringify(record));return record;
  }
  async resumeFixtureQueue() {
    const state=(await this.query('workspace.console_state')).data;if(!state.pause)return;
    const record=await this.port('invoke',{client_request_id:`fixture-resume-${randomUUID()}`,capability:{id:'workspace.resume_queue',version:1},arguments:{session_id:state.session_id,pause_id:state.pause.id},preconditions:[]});
    this.seedRecords.push(record.operation.operation_id);assert.equal(record.status,'succeeded');
  }
  async runWithLostAcknowledgement(code,id) {
    const body={project_root:this.project,frame:{id:randomUUID(),request:{method:'invoke',params:{client_request_id:id,capability:{id:'workspace.run_r',version:1},arguments:{code,output_mode:'console'},preconditions:[]}}}};
    const response=await fetch(`${this.origin}/api/host`,{method:'POST',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json','X-Rho-Studio-Window':'acceptance-lost-client'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
    assert.ok(response.ok);await response.body.cancel(); // Original client consumes no acknowledgement body.
    const page=(await this.query('operation.list_recent',{client_request_id:id,limit:1})).data;
    assert.equal(page.operations.length,1);const record=await this.get(page.operations[0].operation_id);assert.equal(record.status,'succeeded');this.seedRecords.push(record.operation.operation_id);
    json(path.join(this.options.evidence,'lost-acknowledgement.json'),{client_request_id:id,original_response_body_cancelled:true,recovered_operation_id:record.operation.operation_id});return record;
  }
  get(id) {return this.port('get_operation',{operation_id:id});}
  async newPage(windowId=`acceptance-${randomUUID()}`) {
    if(!this.browser) {const require=createRequire(path.join(this.options.root,'ui/package.json'));const {chromium}=require('@playwright/test');this.browser=await chromium.launch({channel:this.options.chromeChannel||'chrome',headless:true});}
    const context=await this.browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});this.contexts.push(context);
    await context.addInitScript(id=>sessionStorage.setItem('rho-window-id',id),windowId);
    const page=await context.newPage();this.pages.push(page);
    page.on('response',async response=>{if(!response.url().endsWith('/api/host'))return;try{const request=response.request().postDataJSON();const reply=await response.json();this.browserTraffic.push({windowId,request: scrub(request),reply:scrub(reply)});}catch{}});
    page.on('pageerror',error=>fs.appendFileSync(path.join(this.options.evidence,'browser.errors.log'),`${windowId}: ${error.stack}\n`));
    await page.goto(this.launchUrl);await page.getByRole('textbox',{name:'Console Input',exact:true}).waitFor({timeout:45000});
    await until(()=>this.query('application.windows',{limit:50}),r=>r.data?.windows?.some(w=>w.window.window_id===windowId&&w.online),'resident Studio bridge');
    return {page,windowId,window:(await this.query('application.windows',{limit:50})).data.windows.find(w=>w.window.window_id===windowId).window};
  }
  async openDocument(surface,file,text=null) {
    const {page}=surface;await page.getByRole('button',{name:'File',exact:true}).click();await page.getByRole('menuitem',{name:'Open File…',exact:true}).click();await page.getByRole('dialog').getByLabel('File Path').fill(file);await page.getByRole('dialog').getByRole('button',{name:'Open',exact:true}).click();
    const editor=page.locator('.document-panel:visible .cm-content');await editor.waitFor();if(text!==null)await editor.fill(text);
    await until(()=>this.query('application.context',{window:surface.window,limit:50}),r=>r.data?.current_document?.path===file&&r.data.current_document.dirty===(text!==null),'document synchronization');return editor;
  }
  async draft(surface,allowOffline=false) {const c=(await this.query('application.context',{window:surface.window,allow_offline:allowOffline,limit:50})).data;const d=c.current_document;assert.ok(d);const p=await this.query('application.read_document',{window:surface.window,document:d.document,expected_sha256:d.sha256,limit_bytes:65536,allow_offline:allowOffline});return {context:c,document:d,text:p.data.text};}
  async screenshot(name='studio.png') {for(let i=0;i<this.pages.length;i++)if(!this.pages[i].isClosed())await this.pages[i].screenshot({path:path.join(this.options.evidence,`${i}-${name}`)});}
  async close() {
    await this.screenshot('final.png').catch(()=>{});await this.browser?.close().catch(()=>{});await this.mcp?.close();
    if(this.child&&this.child.exitCode===null){this.child.kill('SIGINT');const timer=setTimeout(()=>this.child.kill('SIGKILL'),10000);await this.exit;clearTimeout(timer);}
    json(path.join(this.options.evidence,'browser.json'),this.browserTraffic);
  }
}
export function scrub(value) {if(Array.isArray(value))return value.map(scrub);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,/token|authorization/i.test(key)?'<redacted>':scrub(v)]));return value;}
export async function discoverSkills(codex,cwd,overrides=[]) {
  const child=spawn(codex,['app-server','-c','features.apps=false','-c','features.hooks=false',...overrides.flatMap(value=>['-c',value])],{cwd,stdio:['pipe','pipe','pipe']});let sequence=0;const pending=new Map();let stderr='';child.once('exit',(code)=>{for(const p of pending.values())p.reject(new Error(`Codex native discovery exited ${code}: ${stderr.slice(-1500)}`));pending.clear();});child.stderr.on('data',b=>stderr+=b);const lines=readline.createInterface({input:child.stdout});
  lines.on('line',line=>{try{const message=JSON.parse(line);const p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(new Error(JSON.stringify(message.error))):p.resolve(message.result);}}catch{}});
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
  const timer=setTimeout(()=>{for(const p of pending.values())p.reject(new Error(`Codex native Skill discovery timeout: ${stderr.slice(-1000)}`));child.kill('SIGTERM');},30000);
  try {await request('initialize',{clientInfo:{name:'rho-skill-acceptance',version:'1'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n');const result=await request('skills/list',{cwds:[cwd],forceReload:true});return result.data.find(entry=>fs.realpathSync(entry.cwd)===fs.realpathSync(cwd))??result.data[0];}
  finally {clearTimeout(timer);child.stdin.end();child.kill('SIGTERM');lines.close();}
}
export function skillOverrides(discovered,allowed=[]) {const entries=discovered.skills.map(skill=>`{path=${JSON.stringify(skill.path)},enabled=${allowed.includes(path.resolve(skill.path))}}`);return `skills.config=[${entries.join(',')}]`;}
