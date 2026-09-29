// Actual ordinary Objects → Agent draft → Send → Host restart. No builds here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {verifyRBuild} from './r-plugin-artifact.mjs';
import {verifyAgentBuild} from './agent-plugin-artifact.mjs';
import {chromium,expect} from '../ui/node_modules/@playwright/test/index.mjs';
const root=path.resolve(import.meta.dirname,'..');
const binary=process.env.RHO_TEST_BINARY??path.join(root,'target/debug/rho');
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const hostHash=hash(fs.readFileSync(binary));
const packages=Object.fromEntries(['r','agent','objects'].map(name=>{
 const value=process.env[`RHO_${name.toUpperCase()}_PLUGIN_PACKAGE`];assert.ok(value,`Supply current ${name} package`);
 const location=fs.realpathSync(value);assert.ok(!location.startsWith(root+path.sep));return[name,location];
}));
verifyRBuild(packages.r);verifyAgentBuild(packages.agent);
// Refuse stale UI source while reusing its once-built artifact.
function verifyTree(from,to){for(const entry of fs.readdirSync(from,{withFileTypes:true})){
 const a=path.join(from,entry.name),b=path.join(to,entry.name);assert.ok(!entry.isSymbolicLink());
 if(entry.isDirectory())verifyTree(a,b);else assert.equal(hash(fs.readFileSync(a)),hash(fs.readFileSync(b)),`Stale ${a}`);
}}
verifyTree(path.join(root,'plugins/objects/src'),path.join(packages.objects,'src'));
verifyTree(path.join(root,'plugins/agent/sdk/component-input'),path.join(packages.objects,'public/agent-input'));
assert.ok(process.env.RHO_ARK&&process.env.RHO_R_HOME,'Select existing Ark and R paths');
const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-object-agent-')));
const project=path.join(directory,'project'),database=path.join(directory,'host.sqlite');fs.mkdirSync(project);
const window='object-agent-acceptance',hostEnvironment={...process.env};
const evidence=process.env.RHO_OBJECT_AGENT_EVIDENCE??path.join(directory,'result.json');
const result={host_sha256:hostHash,packages,directory,stages:[],screenshots:[],completed:false};
let host, exited, url, agent, r, objects;
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
  for(const [name,directory] of Object.entries(packages)) snapshots[name]=JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',directory,'--target',name==='objects'?'ui-web':'aarch64-apple-darwin'],{encoding:'utf8',timeout:60000})).result;
  result.snapshots=snapshots;
  await start();
  for(const name of ['r','agent','objects']) {
    const snapshot=snapshots[name];
    const active=(await invoke('plugins.activate',{revision:snapshot.revision,artifact:snapshot.artifacts[0],target:name==='objects'?'ui-web':'aarch64-apple-darwin',alias:name,
      configuration:name==='r'?{ark:fs.realpathSync(process.env.RHO_ARK),r_home:fs.realpathSync(process.env.RHO_R_HOME)}:{},
      optional_capabilities:name==='agent'?['plugins.instances','plugins.inspect','r.context.objects.search','r.context.objects.preview'].map(key):[]})).output.instance.identity;
    if(name==='r')r=active;if(name==='agent')agent=active;if(name==='objects')objects=active;
  }
  const empty=await pluginQuery(r,'r.context.objects.search',{window,text:'',after:null,limit:20});assert.deepEqual(empty.items,[]);
  assert.equal((await pluginQuery(r,'r.inspection_state',{expected_session:null})).session_id,null);
  const session=(await invoke('r.create_session',{binding:await binding(r,'r.create_session'),arguments:{}})).output.session_id;
  const execute=async code=>invoke('r.execute',{binding:await binding(r,'r.execute'),arguments:{expected_session:session,code}});
  await execute('answer <- c("原始对象 Ω", "second"); nested <- list(child = c(42L, 43L)); invisible(NULL)');
  const layout=await query('windows.layout',{window});
  const view=(await invoke('windows.open_view',{expected_layout_version:layout.version,group:layout.layout.kind==='tabs'?layout.layout.id:null,
    view:{instance:objects,contribution:'object',window,configuration:{source:r,object_group:null,object:{name:'answer',path:[]}},state:{}}})).output.view;
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const address=new URL(url);address.searchParams.set('window',window);await page.goto(address.href);
  const frame=id=>page.locator(`[data-plugin-frame="${id}"]`).frameLocator('iframe');
  const source=frame(view.view),ask=source.getByRole('button',{name:'Ask about…',exact:true});
  await expect(ask).toBeEnabled();await ask.click();
  const dialog=source.getByRole('dialog',{name:'Ask about this input',exact:true});
  await expect(dialog.locator('[data-input=preview]')).toContainText('原始对象 Ω');
  await expect(dialog.locator('[data-input=preview]')).toContainText('not the whole object');
  await dialog.getByLabel('Agent instance',{exact:true}).selectOption(agent.instance);
  for(const width of [1440,960,390,220]) {
    await page.setViewportSize({width,height:900});
    await expect.poll(()=>source.locator('body').evaluate(()=>innerWidth)).toBeGreaterThan(width-20);
    await expect.poll(()=>dialog.evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(false);
    const file=path.join(directory,`objects-ask-${width}.png`);await dialog.screenshot({path:file});result.screenshots.push(file);
  }
  await page.setViewportSize({width:1440,height:900});
  await dialog.getByRole('button',{name:'Open Agent',exact:true}).click();
  await expect.poll(async()=>!!(await query('views.inspect',{view:view.view})).state.agent?.opened).toBe(true);
  const saved=(await query('views.inspect',{view:view.view})).state.agent;
  const reference=saved.input.reference;
  assert.deepEqual(reference.provider,r);assert.equal(reference.selector.session,session);assert.equal(reference.selector.name,'answer');
  const context=await pluginQuery(r,'r.context.objects.preview',{reference,inclusion:{kind:'summary'},max_bytes:16384});
  expectedText=context.text;
  await page.getByRole('tab',{name:'Agent',exact:true}).click();
  const receiver=frame(saved.opened.view);
  await receiver.getByRole('button',{name:'New task',exact:true}).click();await receiver.getByRole('button',{name:'Rho',exact:true}).click();
  const composer=receiver.getByRole('textbox',{name:'Agent message',exact:true});await expect(composer).toBeEnabled();
  const selected=await receiver.getByLabel('Select task',{exact:true}).inputValue();assert.ok(selected.startsWith('rho:'));const task=selected.slice(4);
  const conversation=()=>pluginQuery(agent,'agent.model.conversation',{conversation_id:task});
  await composer.fill('Explain this observed object summary.');
  await receiver.locator('#component-request summary').click();
  await receiver.getByRole('button',{name:'Add context to draft',exact:true}).click();
  await expect.poll(async()=>(await conversation()).draft_content.context.length).toBe(1);
  const capture=(await conversation()).draft_content.context[0];assert.deepEqual(capture.reference,reference);
  await page.reload();await expect(composer).toHaveValue('Explain this observed object summary.');
  assert.deepEqual((await conversation()).draft_content.context,[capture]);
  result.stages.push('real R object → Objects Ask preview → selected Agent view → explicit draft add → reload retains exact input');save();
  const shot=path.join(directory,'object-agent-draft.png');await page.screenshot({path:shot});result.screenshots.push(shot);
  model=createServer(async(request,response)=>{
    try {
      assert.equal(request.method,'POST');assert.equal(request.url,'/v1/chat/completions');assert.equal(request.headers.authorization,'Bearer disposable-object-key');
      let raw='';for await(const part of request){raw+=part;assert.ok(Buffer.byteLength(raw)<=262144);}
      const body=JSON.parse(raw);
      const contains=value=>typeof value==='string'?(value.includes(expectedText)||value.includes(JSON.stringify(expectedText))):value&&typeof value==='object'&&Object.values(value).some(contains);
      assert.ok(contains(body.messages),'Exact object summary must reach the model');requests.push(body);
      const chunk=(delta,finish_reason)=>`data: ${JSON.stringify({id:'object-model',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}

`;
      response.writeHead(200,{'Content-Type':'text/event-stream'}).end(chunk({role:'assistant'},null)+chunk({content:'Reviewed the bounded original object summary.'},null)+chunk({},'stop')+'data: [DONE]\n\n');
    }catch(error){modelErrors.push(String(error));response.writeHead(500).end('Fixture rejected model input');}
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const credential=await port('control',{capability:key('agent.model.key.store'),arguments:{binding:await binding(agent,'agent.model.key.store'),arguments:{request_id:'object-fixture-key',value:'disposable-object-key'}}});
  const agentInvoke=async(id,args)=>invoke(id,{binding:await binding(agent,id),arguments:args});
  const settings=(await agentInvoke('agent.model.configure',{version:(await pluginQuery(agent,'agent.model.settings',{})).version,enabled:true,connection:{protocol:'openai_completions',base_url:`http://127.0.0.1:${model.address().port}/v1`,model:'fixture',credential}})).output;
  // Refresh observes the explicitly configured model without changing the draft.
  await page.reload();await expect(receiver.getByRole('button',{name:'Send message',exact:true})).toBeEnabled();
  await receiver.getByRole('button',{name:'Send message',exact:true}).click();
  await expect.poll(()=>requests.length).toBe(1);
  await expect(receiver.locator('#transcript')).toContainText('Reviewed the bounded original object summary.');
  const detail=await pluginQuery(agent,'agent.model.history',{conversation_id:task,before:null,limit:20});
  const run=detail.runs.at(-1);
  assert.ok(run?.run_id,JSON.stringify(detail));
  const original=await pluginQuery(agent,'agent.model.run.get',{run_id:run.run_id});
  assert.equal(original.state,'completed');assert.equal(original.context.sources[0].text,context.text);
  assert.deepEqual(original.context.sources[0].selection,capture);assert.deepEqual(modelErrors,[]);
  result.original_run=original;result.stages.push('explicit browser Send captures the original summary through real Agent/Rig into local model peer');save();
  // Nested path reads use the same original root handle, never a name-only lookup.
  const native=await port('query_snapshot',{capability:key('r.observe_object'),arguments:{binding:await binding(r,'r.observe_object'),arguments:{expected_session:session,name:'nested'}}});
  assert.equal(native.status,'ready');assert.ok(['complete','partial'].includes(native.completeness));
  assert.equal(native.data.status,'ready');assert.equal(native.data.session_id,session);assert.equal(native.data.completeness,native.completeness);
  const observation=native.data.data;result.nested_observation_completeness=native.completeness;
  const found=await pluginQuery(r,'r.context.objects.search',{window,text:'nested',after:null,limit:20});
  assert.ok(found.items.some(item=>item.reference.selector.object_ref===observation.object_ref));
  const nested={provider:r,window,contribution:'objects',selector:{session,name:'nested',object_ref:observation.object_ref,observed_path:[],path:[{kind:'name',name:'child'}]}};
  const child=await pluginQuery(r,'r.context.objects.preview',{reference:nested,inclusion:{kind:'summary'},max_bytes:16384});
  assert.ok(child.text.includes('42'));assert.deepEqual(child.item.reference,nested);
  const forged=structuredClone(nested);forged.selector.name='answer';
  await assert.rejects(()=>pluginQuery(r,'r.context.objects.preview',{reference:forged,inclusion:{kind:'summary'},max_bytes:16384}));
  // Keep the second draft under its real browser controller. Direct native calls
  // deliberately cannot take over a view-owned task just by naming its window.
  await receiver.getByRole('button',{name:'Choose context',exact:true}).click();
  const picker=receiver.getByRole('dialog',{name:'Choose context'}),sources=picker.getByRole('combobox',{name:'Context source',exact:true});
  await sources.selectOption(await sources.locator('option').filter({hasText:'Observed objects'}).getAttribute('value'));
  await picker.getByRole('textbox',{name:'Search context',exact:true}).fill('answer');
  await picker.getByRole('button',{name:'Search',exact:true}).click();
  await picker.locator('#context-items').getByRole('button',{name:/Object answer/}).first().click();
  await expect(picker.locator('#context-preview')).toContainText('原始对象 Ω');
  await picker.getByRole('button',{name:'Add to draft',exact:true}).click();
  await composer.fill('Review the original observation again');
  await expect.poll(async()=>{const task=await conversation();return task.draft_content.context.length===1&&task.draft==='Review the original observation again';}).toBe(true);
  const retainedDraft=await conversation();
  assert.deepEqual(retainedDraft.draft_content.context[0].reference.provider,r);
  assert.equal(retainedDraft.draft_content.context[0].reference.selector.name,'answer');
  await execute('answer <- "replacement"; invisible(NULL)');
  await assert.rejects(()=>pluginQuery(r,'r.context.objects.preview',{reference,inclusion:{kind:'summary'},max_bytes:16384}));
  assert.equal((await pluginQuery(agent,'agent.model.run.get',{run_id:original.run_id})).context.sources[0].text,expectedText);
  await receiver.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(receiver.locator('#error')).toContainText('Original native observation is unavailable; no work was replayed');
  result.stale_send_error=await receiver.locator('#error').textContent();
  assert.deepEqual((await conversation()).draft_content,retainedDraft.draft_content,'Rejected stale source must preserve the draft');
  assert.equal(requests.length,1);assert.deepEqual(errors,[]);
  result.stages.push('exact nested path; substituted name and changed original object refused; captured Send remains unchanged');save();
  await browser.close();browser=null;
  await stop();await start();
  const agentState=await query('plugins.instance',{instance:agent});
  assert.equal(agentState.instance.state,'suspended');
  await invoke('plugins.resume',{instance:agent,suspension:agentState.instance.suspension});
  assert.equal((await query('plugins.instance',{instance:r})).instance.state,'suspended');
  assert.deepEqual((await pluginQuery(agent,'agent.model.run.get',{run_id:original.run_id})).context,original.context);
  assert.equal(requests.length,1);
  const rState=await query('plugins.instance',{instance:r});await invoke('plugins.resume',{instance:r,suspension:rState.instance.suspension});
  await assert.rejects(()=>pluginQuery(r,'r.context.objects.preview',{reference,inclusion:{kind:'summary'},max_bytes:16384}));
  assert.equal((await pluginQuery(r,'r.inspection_state',{expected_session:null})).session_id,null);
  result.stages.push('actual Host restart: same Agent input retained; resumed R refuses old handle without starting a native session');
  result.completed=true;
} catch(error) { result.error=safe(error.stack??error);throw error; }
finally {
  if(browser)await browser.close();
  try{await stop();}catch(error){result.completed=false;result.cleanup_error=safe(error.message);if(host?.exitCode===null)host.kill('SIGKILL');}
  if(model){model.closeAllConnections();await new Promise(resolve=>model.close(resolve));}
  assert.equal(hash(fs.readFileSync(binary)),hostHash,'Host must remain frozen');
  save();console.log(JSON.stringify({completed:result.completed,evidence,directory,stages:result.stages}));
  if(!result.completed)process.exitCode=1;
}
