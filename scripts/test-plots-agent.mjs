// Actual ordinary Plots → Agent draft → Send → Host restart. No builds here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {inflateSync} from 'node:zlib';
import {plotsNativeAgent} from './fixtures/plots-native-agent.mjs';
import {spawn,execFileSync} from 'node:child_process';
import {verifyRBuild} from './r-plugin-artifact.mjs';
import {verifyAgentBuild} from './agent-plugin-artifact.mjs';
import {chromium,expect} from '../ui/node_modules/@playwright/test/index.mjs';
const root=path.resolve(import.meta.dirname,'..');
const binary=process.env.RHO_TEST_BINARY??path.join(root,'target/debug/rho');
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const hostHash=hash(fs.readFileSync(binary));
const packages=Object.fromEntries(['r','agent','plots'].map(name=>{
 const value=process.env[`RHO_${name.toUpperCase()}_PLUGIN_PACKAGE`];assert.ok(value,`Supply current ${name} package`);
 const location=fs.realpathSync(value);assert.ok(!location.startsWith(root+path.sep));return[name,location];
}));
verifyRBuild(packages.r);verifyAgentBuild(packages.agent);
// Refuse stale UI source while reusing its once-built artifact.
function verifyTree(from,to){for(const entry of fs.readdirSync(from,{withFileTypes:true})){
 const a=path.join(from,entry.name),b=path.join(to,entry.name);assert.ok(!entry.isSymbolicLink());
 if(entry.isDirectory())verifyTree(a,b);else assert.equal(hash(fs.readFileSync(a)),hash(fs.readFileSync(b)),`Stale ${a}`);
}}
verifyTree(path.join(root,'plugins/plots/src'),path.join(packages.plots,'src'));
verifyTree(path.join(root,'plugins/agent/sdk/component-input'),path.join(packages.plots,'public/agent-input'));
assert.ok(process.env.RHO_ARK&&process.env.RHO_R_HOME,'Select existing Ark and R paths');
const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-plots-agent-')));
const project=path.join(directory,'project'),database=path.join(directory,'host.sqlite');fs.mkdirSync(project);execFileSync('git',['init','-q',project]);
const window='plots-agent-acceptance',hostEnvironment={...process.env};
const nativeBin=path.join(directory,'native-bin'),nativeHome=path.join(directory,'native-home');
fs.mkdirSync(nativeBin);fs.mkdirSync(nativeHome);fs.writeFileSync(path.join(nativeBin,'rho-science-fixture'),'disposable');
fs.copyFileSync(path.join(root,'crates/host/tests/fixtures/agent-science.cjs'),path.join(nativeBin,'kimi'));
fs.copyFileSync(path.join(root,'scripts/fixtures/agent-plots-input.cjs'),path.join(nativeBin,'agent-plots-input.cjs'));
fs.chmodSync(path.join(nativeBin,'kimi'),0o700);hostEnvironment.PATH=nativeBin+path.delimiter+process.env.PATH;

const evidence=process.env.RHO_PLOTS_AGENT_EVIDENCE??path.join(directory,'result.json');
const result={host_sha256:hostHash,packages,directory,stages:[],screenshots:[],completed:false};
let host, exited, url, agent, r, plots;
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
  for(const [name,directory] of Object.entries(packages)) snapshots[name]=JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',directory,'--target',name==='plots'?'ui-web':'aarch64-apple-darwin'],{encoding:'utf8',timeout:60000})).result;
  result.snapshots=snapshots;await start();
  for(const name of ['r','agent','plots']) {
    const snapshot=snapshots[name];
    const active=(await invoke('plugins.activate',{revision:snapshot.revision,artifact:snapshot.artifacts[0],target:name==='plots'?'ui-web':'aarch64-apple-darwin',alias:name,
      configuration:name==='r'?{ark:fs.realpathSync(process.env.RHO_ARK),r_home:fs.realpathSync(process.env.RHO_R_HOME)}:name==='agent'?{kimi_home:nativeHome}:{},
      optional_capabilities:name==='agent'?['plugins.instances','plugins.inspect','resources.read','operation.get','r.context.plots.search','r.context.plots.preview'].map(key):name==='r'?['operation.get','operation.list_recent','resources.read'].map(key):[]})).output.instance.identity;
    if(name==='r')r=active;if(name==='agent')agent=active;if(name==='plots')plots=active;
  }
  assert.deepEqual((await pluginQuery(r,'r.context.plots.search',{window,text:'',after:null,limit:20})).items,[]);
  assert.equal((await pluginQuery(r,'r.inspection_state',{expected_session:null})).session_id,null);
  const session=(await invoke('r.create_session',{binding:await binding(r,'r.create_session'),arguments:{}})).output.session_id;
  const execute=async code=>invoke('r.execute',{binding:await binding(r,'r.execute'),arguments:{expected_session:session,code}});
  const first=await execute('plot(1:5, col="blue", main="Original A")');
  const second=await execute('plot(5:1, col="red", main="Original B")');
  const originalIds=[first,second].map(run=>run.operation.operation_id);
  const layout=await query('windows.layout',{window});
  const view=(await invoke('windows.open_view',{expected_layout_version:layout.version,group:layout.layout.kind==='tabs'?layout.layout.id:null,
    view:{instance:plots,contribution:'plots',window,configuration:{source:r,selection:null,pinned:false,plot_group:null},state:{}}})).output.view;
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const address=new URL(url);address.searchParams.set('window',window);await page.goto(address.href);
  const frame=id=>page.locator(`[data-plugin-frame="${id}"]`).frameLocator('iframe'),source=frame(view.view);
  const add=async()=>{await source.getByRole('button',{name:'Plot Actions',exact:true}).click();await source.getByRole('menuitem',{name:'Add Plot to Agent Comparison',exact:true}).click();};
  await expect(source.getByRole('button',{name:'Previous Plot',exact:true})).toBeEnabled();
  await add();await source.getByRole('button',{name:'Previous Plot',exact:true}).click();await add();
  await expect.poll(async()=>(await query('views.inspect',{view:view.view})).state.agentPlots?.length).toBe(2);
  const selected=(await query('views.inspect',{view:view.view})).state.agentPlots;
  assert.deepEqual(selected.map(p=>p.operation).sort(),originalIds.sort());
  await execute('plot(1, main="Later output must not replace the comparison")');
  await page.reload();
  await source.getByRole('button',{name:'Ask about selected plots',exact:true}).click();
  const dialog=source.getByRole('dialog',{name:'Ask about this input',exact:true});
  await expect(dialog.locator('.input-images img')).toHaveCount(2);
  await expect(dialog.locator('[data-input=preview]')).toContainText('Producing run:');
  await dialog.getByLabel('Agent instance',{exact:true}).selectOption(agent.instance);
  for(const width of [1440,960,390,220]) {
    await page.setViewportSize({width,height:900});
    await expect.poll(()=>source.locator('body').evaluate(()=>innerWidth)).toBeGreaterThan(width-20);
    await expect.poll(()=>dialog.evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(false);
    const file=path.join(directory,`plots-ask-${width}.png`);await dialog.screenshot({path:file});result.screenshots.push(file);
  }
  await page.setViewportSize({width:1440,height:900});
  // Metadata is an explicit alternative, never an automatic downgrade.
  await dialog.getByLabel('Include',{exact:true}).selectOption('metadata');
  await expect(dialog.locator('[data-input=preview]')).toContainText('no image content');
  await expect(dialog.locator('.input-images img')).toHaveCount(0);
  await dialog.getByLabel('Include',{exact:true}).selectOption('images');
  await expect(dialog.locator('.input-images img')).toHaveCount(2);
  await dialog.getByLabel('Agent instance',{exact:true}).selectOption(agent.instance);
  await dialog.getByRole('button',{name:'Open Agent',exact:true}).click();
  await expect.poll(async()=>!!(await query('views.inspect',{view:view.view})).state.agent?.opened).toBe(true);
  const saved=(await query('views.inspect',{view:view.view})).state.agent,reference=saved.input.reference;
  const context=await pluginQuery(r,'r.context.plots.preview',{reference,inclusion:{kind:'images'},max_bytes:16384});
  assert.deepEqual(context.resources.map(p=>p.resource),selected.map(p=>p.reference.resource));expectedText=context.text;
  const forged=structuredClone(reference);forged.selector.plots[0].session='replacement';
  await assert.rejects(()=>pluginQuery(r,'r.context.plots.preview',{reference:forged,inclusion:{kind:'images'},max_bytes:16384}));
  await page.getByRole('tab',{name:'Agent',exact:true}).click();const receiver=frame(saved.opened.view);
  await receiver.getByRole('button',{name:'New task',exact:true}).click();await receiver.getByRole('button',{name:'Rho',exact:true}).click();
  const composer=receiver.getByRole('textbox',{name:'Agent message',exact:true});await expect(composer).toBeEnabled();
  const task=(await receiver.getByLabel('Select task',{exact:true}).inputValue()).slice(4);
  const conversation=()=>pluginQuery(agent,'agent.model.conversation',{conversation_id:task});
  await composer.fill('Compare these two original plots.');
  await receiver.locator('#component-request summary').click();await receiver.getByRole('button',{name:'Add context to draft',exact:true}).click();
  await expect.poll(async()=>(await conversation()).draft_content.context.length).toBe(1);
  const capture=(await conversation()).draft_content.context[0];assert.deepEqual(capture.reference,reference);
  await page.reload();await expect(composer).toHaveValue('Compare these two original plots.');
  assert.deepEqual((await conversation()).draft_content.context,[capture]);
  const shot=path.join(directory,'plots-agent-draft.png');await page.screenshot({path:shot});result.screenshots.push(shot);
  result.stages.push('real R originals → explicit pair selection → later plot/reload preserves pair → preview/images/metadata → Agent draft');save();
  model=createServer(async(request,response)=>{
    try {
      assert.equal(request.method,'POST');assert.equal(request.url,'/v1/chat/completions');
      let raw='';for await(const part of request){raw+=part;assert.ok(Buffer.byteLength(raw)<=8*1024*1024);}
      const body=JSON.parse(raw),images=body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='image_url');let answer;
      const bytes=images.map(p=>{assert.ok(p.image_url.url.startsWith('data:image/png;base64,'));return Buffer.from(p.image_url.url.split(',')[1],'base64');});
      if(images.length===1&&bytes[0].readUInt32BE(16)===8){
        const chunks=[];for(let at=8;at<bytes[0].length;){const n=bytes[0].readUInt32BE(at);if(bytes[0].toString('ascii',at+4,at+8)==='IDAT')chunks.push(bytes[0].subarray(at+8,at+8+n));at+=12+n;}
        const row=inflateSync(Buffer.concat(chunks));assert.equal(row[0],0);answer=['red','green','blue'][[...row.subarray(1,4)].indexOf(255)];assert.ok(answer);requests.push({kind:'diagnostic'});
      }else if(images.length){
        assert.equal(images.length,2);assert.deepEqual(bytes.map(hash),context.resources.map(p=>p.digest));
        const contains=value=>typeof value==='string'?(value.includes(expectedText)||value.includes(JSON.stringify(expectedText))):value&&typeof value==='object'&&Object.values(value).some(contains);
        assert.ok(contains(body.messages));requests.push({kind:'pair',digests:bytes.map(hash)});answer='Compared the two original plots and their producing runs.';
      }else{requests.push({kind:'text'});answer='Retained text history without new image input.';}
      const chunk=(delta,finish_reason)=>`data: ${JSON.stringify({id:'plots-peer',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`;
      response.writeHead(200,{'Content-Type':'text/event-stream'}).end(chunk({role:'assistant'},null)+chunk({content:answer},null)+chunk({},'stop')+'data: [DONE]\n\n');
    }catch(error){modelErrors.push(String(error));response.writeHead(500).end('Fixture rejected model input');}
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const credential=await port('control',{capability:key('agent.model.key.store'),arguments:{binding:await binding(agent,'agent.model.key.store'),arguments:{request_id:'plots-fixture-key',value:'disposable-plots-key'}}});
  const agentInvoke=async(id,args)=>invoke(id,{binding:await binding(agent,id),arguments:args});
  const settings=(await agentInvoke('agent.model.configure',{version:(await pluginQuery(agent,'agent.model.settings',{})).version,enabled:true,connection:{protocol:'openai_completions',base_url:`http://127.0.0.1:${model.address().port}/v1`,model:'fixture',credential}})).output;
  await page.reload();await expect(receiver.getByRole('button',{name:'Send message',exact:true})).toBeEnabled();
  await receiver.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(receiver.locator('#error')).not.toHaveText('');
  assert.deepEqual((await conversation()).draft_content.context,[capture]);assert.equal(requests.length,0);
  assert.equal((await agentInvoke('agent.model.test',{request_id:'plots-image-diagnostic',model_settings_version:settings.version,kind:'images'})).output.state,'passed');
  await page.reload();await receiver.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(receiver.locator('#transcript')).toContainText('Compared the two original plots');
  const history=await pluginQuery(agent,'agent.model.history',{conversation_id:task,before:null,limit:20});
  const original=await pluginQuery(agent,'agent.model.run.get',{run_id:history.runs.at(-1).run_id});
  assert.equal(original.state,'completed');assert.deepEqual(original.context.sources[0].selection,capture);
  assert.deepEqual(original.context.sources[0].native_data.agent_context_images.map(p=>p.sha256),context.resources.map(p=>p.digest));
  result.original_run=original;save();
  await receiver.getByRole('button',{name:'Sent context',exact:true}).last().click();
  const sent=receiver.getByRole('dialog',{name:'Choose context'});
  await sent.getByRole('button',{name:'View original image 1',exact:true}).click();
  await expect(sent.getByRole('img',{name:'Original Plot 1',exact:true})).toBeVisible();
  await expect.poll(()=>sent.getByRole('img',{name:'Original Plot 1',exact:true}).evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true);
  const imageShot=path.join(directory,'plots-original-image.png');await sent.screenshot({path:imageShot});result.screenshots.push(imageShot);
  await sent.getByRole('button',{name:'View producing run 1',exact:true}).click();
  await expect(sent.locator('.context-artifact-evidence').first()).toContainText(originalIds.includes(reference.selector.plots[0].operation)?reference.selector.plots[0].operation:'unexpected original');
  await expect(sent.locator('.context-artifact-evidence').first()).toContainText('Original run · succeeded');
  for(const width of [1440,960,390,220]){
    await page.setViewportSize({width,height:900});await expect.poll(()=>receiver.locator('body').evaluate(()=>innerWidth)).toBeGreaterThan(width-20);
    await expect.poll(()=>sent.evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(false);
    await sent.getByRole('button',{name:'View producing run 1',exact:true}).scrollIntoViewIfNeeded();
    const linksShot=path.join(directory,`plots-producing-run-${width}.png`);await sent.screenshot({path:linksShot});result.screenshots.push(linksShot);
  }
  await page.setViewportSize({width:1440,height:900});
  await sent.locator('#context-close').click();
  await composer.fill('Continue using the previous answer.');await receiver.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(receiver.locator('#transcript')).toContainText('Retained text history');
  assert.deepEqual(requests.map(p=>p.kind),['diagnostic','pair','text']);assert.deepEqual(modelErrors,[]);assert.deepEqual(errors,[]);
  result.original_run=original;result.stages.push('unverified image Send preserves draft; diagnosed model receives exact original pair; follow-up does not resend pixels');save();
  const native=await plotsNativeAgent({agent,r,project,selection:capture,context,binding,invoke,pluginQuery});result.native=native.report;
  result.stages.push('Native original Send carries exact pair; public preview query, text-only follow-up and idempotent retries pass');save();
  await browser.close();browser=null;await stop();await start();
  for(const instance of [agent,r]){
    const state=await query('plugins.instance',{instance});assert.equal(state.instance.state,'suspended');await invoke('plugins.resume',{instance,suspension:state.instance.suspension});
    if(instance===agent){await native.afterRestart();assert.equal((await query('plugins.instance',{instance:r})).instance.state,'suspended');}
  }
  assert.deepEqual((await pluginQuery(agent,'agent.model.run.get',{run_id:original.run_id})).context,original.context);
  const restored=await pluginQuery(r,'r.context.plots.preview',{reference,inclusion:{kind:'images'},max_bytes:16384});assert.deepEqual(restored,context);
  for(const reference of restored.resources){
    const chunks=[];let offset=0;
    do{const part=await query('resources.read',{reference,offset,limit:262144});assert.deepEqual(part.reference,reference);assert.equal(part.offset,offset);chunks.push(Buffer.from(part.base64,'base64'));offset=part.next;}while(offset!==null);
    const bytes=Buffer.concat(chunks);assert.equal(bytes.length,reference.bytes);assert.equal(hash(bytes),reference.digest);
  }
  assert.equal((await pluginQuery(r,'r.inspection_state',{expected_session:null})).session_id,null);
  assert.deepEqual(requests.map(p=>p.kind),['diagnostic','pair','text']);
  result.stages.push('actual Host restart: same Agent context and original image references retained; no R session or model replay');result.completed=true;
} catch(error) {
  result.error=safe(error.stack??error);
  if(browser){const page=browser.contexts()[0]?.pages()[0];if(page){result.failure_frames=await Promise.all(page.frames().map(async frame=>{try{return (await frame.locator('body').innerText()).slice(0,12000);}catch{return 'unavailable';}}));}}
  throw error;
}
finally {
  if(browser)await browser.close();
  try{await stop();}catch(error){result.completed=false;result.cleanup_error=safe(error.message);if(host?.exitCode===null)host.kill('SIGKILL');}
  if(model){model.closeAllConnections();await new Promise(resolve=>model.close(resolve));}
  assert.equal(hash(fs.readFileSync(binary)),hostHash);save();console.log(JSON.stringify({completed:result.completed,evidence,directory,stages:result.stages}));if(!result.completed)process.exitCode=1;
}
