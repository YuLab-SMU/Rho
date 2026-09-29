// Actual ordinary Files → Agent draft → Send → Host restart. No builds here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {verifyAgentBuild} from './agent-plugin-artifact.mjs';
import {chromium,expect} from '../ui/node_modules/@playwright/test/index.mjs';
const root=path.resolve(import.meta.dirname,'..');
const binary=process.env.RHO_TEST_BINARY??path.join(root,'target/debug/rho');
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const hostHash=hash(fs.readFileSync(binary));
const packages=Object.fromEntries(['files','agent'].map(name=>{
 const value=process.env[`RHO_${name.toUpperCase()}_PLUGIN_PACKAGE`];assert.ok(value,`Supply current ${name} package`);
 const location=fs.realpathSync(value);assert.ok(!location.startsWith(root+path.sep));return[name,location];
}));
verifyAgentBuild(packages.agent);
// Refuse stale UI source while reusing its once-built artifact.
function verifyTree(from,to){for(const entry of fs.readdirSync(from,{withFileTypes:true})){
 const a=path.join(from,entry.name),b=path.join(to,entry.name);assert.ok(!entry.isSymbolicLink());
 if(entry.isDirectory())verifyTree(a,b);else assert.equal(hash(fs.readFileSync(a)),hash(fs.readFileSync(b)),`Stale ${a}`);
}}
verifyTree(path.join(root,'plugins/files/src'),path.join(packages.files,'src'));
verifyTree(path.join(root,'plugins/agent/sdk/component-input'),path.join(packages.files,'public/agent-input'));
const packageManifest=file=>{const value=JSON.parse(fs.readFileSync(file,'utf8'));delete value.source.files;return value;};
assert.deepEqual(packageManifest(path.join(packages.files,'plugin.json')),packageManifest(path.join(root,'plugins/files/plugin.json')),'Stale Files manifest');
verifyTree(path.join(root,'plugins/files/backend/src'),path.join(packages.files,'backend/src'));
const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-files-agent-')));
const project=path.join(directory,'project'),database=path.join(directory,'host.sqlite');fs.mkdirSync(project);
const window='files-agent-acceptance',hostEnvironment={...process.env};
const evidence=process.env.RHO_FILES_AGENT_EVIDENCE??path.join(directory,'result.json');
const result={host_sha256:hostHash,packages,directory,stages:[],screenshots:[],completed:false};
let host, exited, url, agent, files;
const key = id => ({id, version: 1});
const save = () => fs.writeFileSync(evidence, JSON.stringify(result, null, 2) + '\n');
const safe = text => String(text).replace(/token=[a-z0-9]+/g, 'token=[redacted]');
function deadline(promise, label, ms = 30000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`${label} timed out`)), ms);
  })]).finally(() => clearTimeout(timer));
}
async function start() {
  host = spawn(binary, ['--database', database, '--project', project, '--plugins-only', 'workbench'], {stdio: ['ignore', 'pipe', 'pipe'], env:hostEnvironment});
  exited = new Promise(resolve => host.once('exit', (code, signal) => resolve({code, signal})));
  let output = '', errors = '';
  url = new URL(await deadline(new Promise((resolve, reject) => {
    host.on('error', reject);
    host.stderr.on('data', bytes => { const text = safe(bytes); errors += text; fs.appendFileSync(path.join(directory, 'host-stderr.log'), text); });
    host.stdout.on('data', bytes => {
      output += bytes;
      const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);
      if (found) resolve(found[0]);
    });
    exited.then(status => reject(Error(`Owned Host exited ${JSON.stringify(status)}: ${errors}`)));
  }), 'Owned Host startup', 60000));
}
async function stop() {
  if (!host || host.exitCode !== null || host.signalCode !== null) return;
  host.kill('SIGINT');
  const ended = await deadline(exited, 'Owned Host drain', 30000);
  assert.equal(ended.code, 0, JSON.stringify(ended));
}
async function port(method, params) {
  const response = await fetch(new URL('/api/host', url), {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: {Authorization: `Bearer ${url.hash.slice(7)}`, 'Content-Type': 'application/json', 'X-Rho-Studio-Window': window},
    body: JSON.stringify({project_root: project, frame: {id: randomUUID(), request: {method, params}}}),
  });
  const reply = await response.json();
  assert.equal(reply.ok, true, safe(JSON.stringify(reply)));
  return reply.result;
}
async function query(id, args) {
  const observation = await port('query_snapshot', {capability: key(id), arguments: args});
  assert.equal(observation.status, 'ready', JSON.stringify(observation));
  assert.equal(observation.completeness, 'complete', JSON.stringify(observation));
  return observation.data;
}
async function invoke(id, args, request = randomUUID(), expected = 'succeeded') {
  let record = await port('invoke', {capability: key(id), arguments: args, preconditions: [], client_request_id: request});
  const until = Date.now() + 15000;
  while (!['succeeded', 'failed', 'cancelled', 'uncertain'].includes(record.status)) {
    assert.ok(Date.now() < until, `Original ${id} did not settle`);
    record = await port('get_operation', {operation_id: record.operation.operation_id});
    if (!['succeeded', 'failed', 'cancelled', 'uncertain'].includes(record.status))
      await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(record.status, expected, JSON.stringify({id, status: record.status, error: record.error}));
  return record;
}
const binding = (instance, id) => query('plugins.resolve', {instance, capability: key(id)});
const pluginQuery = async (instance, id, arguments_) => query(id, {binding: await binding(instance, id), arguments: arguments_});
let browser, model;
const requests=[],modelErrors=[];
let expectedText='';
try {
  const snapshots={};
  for(const [name,directory] of Object.entries(packages)) snapshots[name]=JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',directory,'--target','aarch64-apple-darwin'],{encoding:'utf8',timeout:60000})).result;
  result.snapshots=snapshots;
  await start();
  for(const name of ['files','agent']) {
    const snapshot=snapshots[name];
    const active=(await invoke('plugins.activate',{revision:snapshot.revision,artifact:snapshot.artifacts[0],target:'aarch64-apple-darwin',alias:name,
      configuration:{},optional_capabilities:name==='agent'?['plugins.instances','plugins.inspect','files.context.search','files.context.preview'].map(key):[]})).output.instance.identity;
    if(name==='files')files=active;if(name==='agent')agent=active;
  }
  const empty=await pluginQuery(files,'files.context.search',{window,text:'',after:null,limit:20});assert.deepEqual(empty.items,[]);
  const file=path.join(project,'分析.R'),originalText='记录 original\r\nprint(42)\n';fs.writeFileSync(file,originalText);fs.writeFileSync(path.join(project,'other.R'),'different source');
  const layout=await query('windows.layout',{window});
  const view=(await invoke('windows.open_view',{expected_layout_version:layout.version,group:layout.layout.kind==='tabs'?layout.layout.id:null,
    view:{instance:files,contribution:'files',window,configuration:{editor:null,editor_group:null,runtime:null},state:{}}})).output.view;
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const address=new URL(url);address.searchParams.set('window',window);await page.goto(address.href);
  const frame=id=>page.locator(`[data-plugin-frame="${id}"]`).frameLocator('iframe');
  const source=frame(view.view),ask=source.getByRole('button',{name:'Ask about…',exact:true});
  await source.locator('button[title="分析.R"]').click();
  await expect(ask).toBeEnabled();await ask.click();
  const dialog=source.getByRole('dialog',{name:'Ask about this input',exact:true});
  await dialog.getByLabel('Include',{exact:true}).selectOption('text');
  await expect(dialog.locator('[data-input=preview]')).toContainText('print(42)');
  await dialog.getByLabel('Agent instance',{exact:true}).selectOption(agent.instance);
  for(const width of [1440,960,390,220]) {
    await page.setViewportSize({width,height:900});
    await expect.poll(()=>source.locator('body').evaluate(()=>innerWidth)).toBeLessThanOrEqual(width);
    await expect.poll(()=>source.locator('body').evaluate(()=>innerWidth)).toBeGreaterThan(width-20);
    await expect.poll(()=>dialog.evaluate(node=>node.getBoundingClientRect().height)).toBeGreaterThan(250);
    await expect.poll(()=>dialog.evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(false);
    await expect.poll(()=>source.locator('.panel-footer').evaluate(node=>[...node.children].some(child=>child.scrollWidth>child.clientWidth))).toBe(false);
    const file=path.join(directory,`files-ask-${width}.png`);await page.screenshot({path:file});result.screenshots.push(file);
  }
  await page.setViewportSize({width:1440,height:900});
  await dialog.getByRole('button',{name:'Open Agent',exact:true}).click();
  // Opening Agent can unmount the source iframe; inspect its saved receipt.
  await expect.poll(async()=>!!(await query('views.inspect',{view:view.view})).state.agent?.opened,{timeout:15000}).toBe(true);
  const saved=(await query('views.inspect',{view:view.view})).state.agent;
  const reference=saved.input.reference;
  assert.deepEqual(reference.provider,files);assert.equal(reference.selector.path,'分析.R');assert.ok(reference.selector.sha256);assert.ok(reference.selector.native_identity);
  const context=await pluginQuery(files,'files.context.preview',{reference,inclusion:{kind:'text'},max_bytes:16384});
  assert.ok(context.text.endsWith(originalText));
  expectedText=context.text;
  await page.getByRole('tab',{name:'Agent',exact:true}).click();
  const receiver=frame(saved.opened.view);
  await receiver.getByRole('button',{name:'New task',exact:true}).click();await receiver.getByRole('button',{name:'Rho',exact:true}).click();
  const composer=receiver.getByRole('textbox',{name:'Agent message',exact:true});await expect(composer).toBeEnabled();
  const selected=await receiver.getByLabel('Select task',{exact:true}).inputValue();assert.ok(selected.startsWith('rho:'));const task=selected.slice(4);
  const conversation=()=>pluginQuery(agent,'agent.model.conversation',{conversation_id:task});
  await composer.fill('Explain this original file.');
  await receiver.locator('#component-request summary').click();
  await receiver.getByRole('button',{name:'Add context to draft',exact:true}).click();
  await expect.poll(async()=>(await conversation()).draft_content.context.length).toBe(1);
  const capture=(await conversation()).draft_content.context[0];assert.deepEqual(capture.reference,reference);
  await page.reload();await expect(composer).toHaveValue('Explain this original file.');
  assert.deepEqual((await conversation()).draft_content.context,[capture]);
  result.stages.push('original Unicode file → Files Ask preview → selected Agent view → explicit draft add → reload retains exact input');save();
  const shot=path.join(directory,'files-agent-draft.png');await page.screenshot({path:shot});result.screenshots.push(shot);
  model=createServer(async(request,response)=>{
    try {
      assert.equal(request.method,'POST');assert.equal(request.url,'/v1/chat/completions');assert.equal(request.headers.authorization,'Bearer disposable-files-key');
      let raw='';for await(const part of request){raw+=part;assert.ok(Buffer.byteLength(raw)<=262144);}
      const body=JSON.parse(raw);
      const contains=value=>typeof value==='string'?(value.includes(expectedText)||value.includes(JSON.stringify(expectedText))):value&&typeof value==='object'&&Object.values(value).some(contains);
      assert.ok(contains(body.messages),'Exact original file text must reach the model');requests.push(body);
      const chunk=(delta,finish_reason)=>`data: ${JSON.stringify({id:'files-model',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}

`;
      response.writeHead(200,{'Content-Type':'text/event-stream'}).end(chunk({role:'assistant'},null)+chunk({content:'Reviewed the original file.'},null)+chunk({},'stop')+'data: [DONE]\n\n');
    }catch(error){modelErrors.push(String(error));response.writeHead(500).end('Fixture rejected model input');}
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const credential=await port('control',{capability:key('agent.model.key.store'),arguments:{binding:await binding(agent,'agent.model.key.store'),arguments:{request_id:'files-fixture-key',value:'disposable-files-key'}}});
  const agentInvoke=async(id,args)=>invoke(id,{binding:await binding(agent,id),arguments:args});
  const settings=(await agentInvoke('agent.model.configure',{version:(await pluginQuery(agent,'agent.model.settings',{})).version,enabled:true,connection:{protocol:'openai_completions',base_url:`http://127.0.0.1:${model.address().port}/v1`,model:'fixture',credential}})).output;
  // Refresh observes the explicitly configured model without changing the draft.
  await page.reload();await expect(receiver.getByRole('button',{name:'Send message',exact:true})).toBeEnabled();
  await receiver.getByRole('button',{name:'Send message',exact:true}).click();
  await expect.poll(()=>requests.length).toBe(1);
  await expect(receiver.locator('#transcript')).toContainText('Reviewed the original file.');
  const detail=await pluginQuery(agent,'agent.model.history',{conversation_id:task,before:null,limit:20});
  const run=detail.runs.at(-1);
  assert.ok(run?.run_id,JSON.stringify(detail));
  const original=await pluginQuery(agent,'agent.model.run.get',{run_id:run.run_id});
  assert.equal(original.state,'completed');assert.equal(original.context.sources[0].text,context.text);
  assert.deepEqual(original.context.sources[0].selection,capture);assert.deepEqual(modelErrors,[]);
  result.original_run=original;result.stages.push('explicit browser Send captures the original file text through real Agent/Rig into local model peer');save();
  const forged=structuredClone(reference);forged.selector.path='../outside';
  await assert.rejects(()=>pluginQuery(files,'files.context.preview',{reference:forged,inclusion:{kind:'text'},max_bytes:16384}));
  const found=await pluginQuery(files,'files.context.search',{window,text:'分析',after:null,limit:20});
  assert.deepEqual(found.items[0].reference,reference);
  fs.writeFileSync(path.join(project,'other.R'),'later unrelated change');
  assert.deepEqual(await pluginQuery(files,'files.context.preview',{reference,inclusion:{kind:'text'},max_bytes:16384}),context);
  assert.deepEqual(errors,[]);
  result.stages.push('unrelated file changes preserve source; path escape refuses preview');save();
  await browser.close();browser=null;await stop();await start();
  for(const instance of [agent,files]){const state=await query('plugins.instance',{instance});assert.equal(state.instance.state,'suspended');await invoke('plugins.resume',{instance,suspension:state.instance.suspension});}
  assert.deepEqual((await pluginQuery(agent,'agent.model.run.get',{run_id:original.run_id})).context,original.context);
  assert.deepEqual(await pluginQuery(files,'files.context.preview',{reference,inclusion:{kind:'text'},max_bytes:16384}),context);
  fs.writeFileSync(file,'replacement contents');
  await assert.rejects(()=>pluginQuery(files,'files.context.preview',{reference,inclusion:{kind:'text'},max_bytes:16384}),error=>{result.restart_refusal=safe(error.message);return /changed|digest|identity/i.test(error.message);});
  assert.equal(requests.length,1);
  assert.deepEqual((await pluginQuery(agent,'agent.model.run.get',{run_id:original.run_id})).context,original.context);
  result.stages.push('actual Host restart retains original Agent run and file text; changed file stays refused without replay');result.completed=true;
} catch(error){result.error=safe(error.stack??error);throw error;}
finally {
 if(browser)await browser.close();
 try{await stop();}catch(error){result.completed=false;result.cleanup_error=safe(error.message);if(host?.exitCode===null)host.kill('SIGKILL');}
 if(model){model.closeAllConnections();await new Promise(resolve=>model.close(resolve));}
 assert.equal(hash(fs.readFileSync(binary)),hostHash);save();
}
console.log(JSON.stringify({completed:result.completed,evidence,directory,stages:result.stages}));
