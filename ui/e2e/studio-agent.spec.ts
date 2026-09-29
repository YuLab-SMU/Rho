/** One retained Agent package, actual Studio/Agent iframes and real Host ports.
 * The external ACP peer is local and deterministic; no model quality claim. */
import {test,expect} from '@playwright/test';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,realpathSync,readFileSync,writeFileSync,copyFileSync,chmodSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,delimiter} from 'node:path';
import {buildStudioPlugin} from '../../scripts/build-studio-plugin.mjs';
import {buildUiFixture} from '../../scripts/fixtures/plugin-ui.mjs';
import {verifyAgentBuild,agentBuildMode} from '../../scripts/agent-plugin-artifact.mjs';

let directory:string,project:string,url:URL,host:ReturnType<typeof spawn>,completed=false;
let agent:any,studioView:any,oldView:any,subject:any,initial:any,originalSource:string;
const binary=resolve('../target/debug/rho'),windowId='studio-agent-window';
async function port(method:string,params:unknown) {
  const response=await fetch(new URL('/api/host',url),{method:'POST',headers:{Authorization:`Bearer ${url.hash.slice(7)}`,'Content-Type':'application/json','X-Rho-Studio-Window':windowId},
    body:JSON.stringify({project_root:project,frame:{id:crypto.randomUUID(),request:{method,params}}})}).then(r=>r.json());
  if(!response.ok)throw Error(response.error);return response.result;
}
async function query(id:string,args:unknown){return(await port('query_snapshot',{capability:{id,version:1},arguments:args})).data;}
async function invoke(id:string,args:unknown) {
  const record=await port('invoke',{capability:{id,version:1},arguments:args,preconditions:[],client_request_id:crypto.randomUUID()});
  expect(record.status,JSON.stringify(record.error)).toBe('succeeded');return record.output;
}
async function agentQuery(id:string,args:unknown) {
  const binding=await query('plugins.resolve',{instance:agent,capability:{id,version:1}});return query(id,{binding,arguments:args});
}
async function operations() {
  const records:any[]=[];let before_cursor:number|null=null;
  for(let n=0;n<20;n++) {
    const page=await query('operation.list_recent',{limit:100,before_cursor});records.push(...page.operations);
    if(page.next_cursor===null)return records;before_cursor=page.next_cursor;
  }throw Error('Studio acceptance exceeded its bounded Operation history.');
}
async function stopHost() {
  if(!host || host.exitCode!==null || host.signalCode!==null)return;
  await new Promise<void>((done,reject)=>{
    const timer=setTimeout(()=>{host.kill('SIGKILL');reject(Error('Disposable Studio Host did not confirm shutdown.'));},60000);
    host.once('exit',(code,signal)=>{clearTimeout(timer);if(code!==0||signal)reject(Error(`Disposable Studio Host exit ${code}/${signal}`));else done();});host.kill('SIGINT');
  });
}
test.beforeAll(async()=>{
  test.setTimeout(180000);expect(process.env.RHO_AGENT_PLUGIN_PACKAGE).toBeTruthy();
  const agentPackage=verifyAgentBuild(process.env.RHO_AGENT_PLUGIN_PACKAGE!);
  directory=realpathSync(mkdtempSync(join(tmpdir(),'rho-studio-agent-')));project=join(directory,'project');mkdirSync(project);
  const nativeBin=join(directory,'native-bin'),nativeHome=join(directory,'native-home');mkdirSync(nativeBin);mkdirSync(nativeHome);
  writeFileSync(join(nativeBin,'rho-science-fixture'),'disposable');
  copyFileSync(resolve('../crates/host/tests/fixtures/agent-science.cjs'),join(nativeBin,'kimi'));chmodSync(join(nativeBin,'kimi'),0o700);
  copyFileSync(resolve('../crates/host/tests/fixtures/agent-studio-tools.cjs'),join(nativeBin,'agent-studio-tools.cjs'));
  const database=join(directory,'state.sqlite');
  const snapshot=(path:string,target='ui-web')=>JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',path,'--target',target],{encoding:'utf8',timeout:90000,killSignal:'SIGKILL'})).result;
  const studio=snapshot(buildStudioPlugin(join(directory,'studio'))),agentSource=snapshot(agentPackage,'aarch64-apple-darwin');
  const subjectPath=buildUiFixture(directory),manifest=JSON.parse(readFileSync(join(subjectPath,'plugin.json'),'utf8'));
  manifest.requires=manifest.requires.filter((r:any)=>r.capability.id!=='fixture.answer');manifest.name='Agent-assisted report';
  writeFileSync(join(subjectPath,'plugin.json'),JSON.stringify(manifest,null,2));subject=snapshot(subjectPath);
  originalSource=readFileSync(join(subjectPath,'src/index.html'),'utf8');
  host=spawn(binary,['--database',database,'--project',project,'workbench'],{stdio:['ignore','pipe','pipe'],env:{...process.env,PATH:nativeBin+delimiter+process.env.PATH}});
  url=new URL(await new Promise<string>((done,reject)=>{
    let output='',errors='';const timer=setTimeout(()=>reject(Error(`Disposable Studio Host startup deadline: ${errors}`)),60000);
    host.stderr!.on('data',b=>errors+=b);host.stdout!.on('data',b=>{output+=b;const match=output.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);if(match){clearTimeout(timer);done(match[0]);}});
    host.once('exit',code=>{clearTimeout(timer);reject(Error(`Disposable Studio Host exited ${code}: ${errors}`));});
  }));
  const activate=async(source:any,target:string,alias:string,optional_capabilities:any[]=[],configuration:unknown={}) => (await invoke('plugins.activate',{revision:source.revision,artifact:source.artifacts[0],target,alias,configuration,optional_capabilities})).instance.identity;
  const studioInstance=await activate(studio,'ui-web','studio'),report=await activate(subject,'ui-web','report');
  agent=await activate(agentSource,'aarch64-apple-darwin','agent',['host.core_contract','plugins.inspect','plugins.branch_head','plugins.source_tree','plugins.read_source','plugins.check_source','plugins.checkpoint','operation.get','plugins.delegated_operation'].map(id=>({id,version:1})),{kimi_home:nativeHome});
  studioView=await invoke('views.open',{instance:studioInstance,window:windowId,contribution:'studio',configuration:{},state:{}});
  oldView=await invoke('views.open',{instance:report,window:windowId,contribution:'view',configuration:{},state:{text:'Original report note'}});
  const selection=(value:any)=>({plugin:value.plugin,revision:value.revision,artifact:value.artifact,configuration:{},dependencies:{}});
  initial=await invoke('scenarios.checkpoint',{scenario:'studio-agent-report',expected_head:null,name:'Agent-assisted report',instances:{studio:selection(studioInstance),report:selection(report)},providers:[],
    layout:{kind:'tabs',id:'report-tabs',selected:'studio-view',views:[{id:'studio-view',instance:'studio',contribution:'studio',configuration:{},state:{},state_revision:studio.revision,resource:null},
      {id:'report-view',instance:'report',contribution:'view',configuration:{},state:{text:'Original report note'},state_revision:subject.revision,resource:null}]}});
  await invoke('scenarios.apply',{window:windowId,revision:initial.id,expected_layout_version:0,instances:{studio:studioInstance,report},views:{'studio-view':studioView.view,'report-view':oldView.view}});
});
test.afterAll(async()=>{
  try {await stopHost();} finally {if(directory&&completed)rmSync(directory,{recursive:true,force:true});else if(directory)console.error(`Studio Agent fixture retained at ${directory}`);}
});

test('Studio request creates one exact native Agent checkpoint before explicit build, preview and scenario application',async({page},info)=>{
  test.setTimeout(300000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const address=new URL(url);address.searchParams.set('window',windowId);await page.goto(address.href);
  const studio=page.locator(`[data-plugin-frame="${studioView.view}"]`).frameLocator('iframe');
  await studio.getByRole('button',{name:'Choose revision',exact:true}).click();await studio.locator(`#revision-list [data-revision="${subject.revision}"]`).click();
  await studio.getByLabel('Development branch name').fill('report-agent-edit');await studio.getByRole('button',{name:'Create branch from selected',exact:true}).click();
  await expect(studio.locator('#subtitle')).toContainText('report-agent-edit');
  const branch=(await query('plugins.branches',{plugin:oldView.instance.plugin,after:null,limit:100})).branches.find((b:any)=>b.name==='report-agent-edit');
  const other=await invoke('plugins.branch',{revision:subject.revision,name:'Unselected report branch'});
  const newSource=originalSource.replace('<h1>Independent View</h1>','<h1>Agent revised report 中文 Ω</h1>');expect(newSource).not.toBe(originalSource);
  writeFileSync(join(project,'native-studio-input.json'),JSON.stringify({branch:branch.id,other_branch:other.branch,revision:subject.revision,path:'src/index.html',original:originalSource,
    changes:{'src/index.html':{kind:'put',content_base64:Buffer.from(newSource).toString('base64'),executable:false}}}));
  await studio.getByRole('button',{name:'Ask Agent',exact:true}).click();await studio.getByLabel('Requested change').fill('Change the report heading to “Agent revised report 中文 Ω” on this selected branch. Create one checkpoint for review.');
  await studio.getByLabel('Agent instance',{exact:true}).selectOption(agent.instance);
  let loseOpen=true,openCalls=0;
  await page.route('**/api/plugin-view',async route=>{
    const body=route.request().postDataJSON()?.message?.body;
    if(body?.type==='invoke'&&body.capability.id==='windows.open_view'&&body.arguments.view.contribution==='agent') {
      openCalls++;if(loseOpen){loseOpen=false;const response=await route.fetch(),reply=await response.json();expect(reply.ok).toBe(true);await route.fulfill({response,json:{id:reply.id,ok:false,error:'Fixture lost original Agent view reply'}});return;}
    }await route.continue();
  });
  await studio.getByRole('button',{name:'Open Agent draft',exact:true}).click();
  await expect(page.getByRole('tab',{name:'Agent',exact:true})).toBeVisible();await page.getByRole('tab',{name:'Plugin Studio',exact:true}).click();
  await expect(studio.locator('#agent-pending')).toBeVisible();await page.reload();await studio.getByRole('button',{name:'Ask Agent',exact:true}).click();
  await studio.getByRole('button',{name:'Inspect original Agent view',exact:true}).click();await expect(studio.locator('#agent-opened')).toContainText('Agent view opened');expect(openCalls).toBe(1);
  await page.unroute('**/api/plugin-view');await studio.locator('#close-agent').click();
  const layout=await query('windows.layout',{window:windowId});
  // Layout records store view IDs; inspect only the IDs in this exact window.
  const ids=(node:any):string[]=>node.kind==='tabs'?node.views:node.kind==='split'?node.children.flatMap(ids):[];
  const inspected=(await Promise.all(ids(layout.layout).map(view=>query('views.inspect',{view})))).find(v=>v.instance.instance===agent.instance);
  expect(inspected).toBeTruthy();expect(inspected.configuration.studio_request.branch).toBe(branch.id);expect(inspected.configuration.tools).toHaveLength(6);
  expect((await operations()).filter((r:any)=>r.capability.id==='agent.native.command')).toHaveLength(0);
  expect(existsSync(join(project,'native-science-evidence.json'))).toBe(false);
  await page.getByRole('tab',{name:'Agent',exact:true}).click();const frame=page.locator(`[data-plugin-frame="${inspected.view}"]`).frameLocator('iframe');
  await frame.getByRole('button',{name:'New task',exact:true}).click();await frame.getByRole('button',{name:'Kimi Code',exact:true}).click();
  const composer=frame.getByRole('textbox',{name:'Agent message',exact:true});await expect(composer).toBeEnabled({timeout:45000});
  const task=(await frame.getByLabel('Select task',{exact:true}).inputValue()).slice(7);
  await frame.locator('#studio-request summary').click();await frame.getByRole('button',{name:'Add Studio request to draft',exact:true}).click();
  await expect(composer).toHaveValue(/Agent revised report 中文 Ω/);await expect.poll(async()=>(await agentQuery('agent.native.task',{task_id:task})).draft.content.text).toContain('Create one checkpoint');
  expect(existsSync(join(project,'native-science-evidence.json'))).toBe(false);
  await frame.getByRole('button',{name:'Send message',exact:true}).click();
  await expect.poll(()=>existsSync(join(project,'native-science-evidence.json')),{timeout:60000}).toBe(true);
  await expect.poll(()=>{const e=JSON.parse(readFileSync(join(project,'native-science-evidence.json'),'utf8'));if(e.error)throw Error(e.error);return e.proposal?.revision;},{timeout:60000}).toBeTruthy();
  const evidence=JSON.parse(readFileSync(join(project,'native-science-evidence.json'),'utf8')),head=evidence.proposal.revision;
  const detail=await agentQuery('agent.native.task',{task_id:task});const send=detail.receipts.find((r:any)=>r.command==='send');expect(send).toBeTruthy();
  await expect.poll(async()=>(await agentQuery('agent.native.receipt',{request_id:send.request_id})).status).toBe('succeeded');
  const lookup={send_request:send.request_id,tool_request:evidence.invocation.tool_request};
  const tool=await agentQuery('agent.native.tool',lookup);expect(tool.phase).toBe('resolved');
  const child=(await query('operation.get',{operation_id:tool.operation})).record;
  expect(child.status).toBe('succeeded');expect(child.operation.caller).toEqual({kind:'plugin',id:agent.instance});
  expect(child.operation.capability.id).toBe('plugins.checkpoint');expect(child.operation.normalized_arguments.branch).toBe(branch.id);
  expect(child.operation.normalized_arguments.expected_head).toBe(subject.revision);expect(child.output).toEqual(evidence.proposal);
  const parent=(await query('operation.get',{operation_id:child.operation.causation_id})).record;
  expect(parent.operation.capability.id).toBe('agent.native.command');expect(parent.operation.normalized_arguments.arguments.request_id).toBe(send.request_id);
  expect((await agentQuery('agent.native.tool.operation',lookup)).operation.output).toEqual(child.output);
  expect(evidence.prompts).toBe(1);expect(evidence.rejected_branch_replacement).toBe(true);expect(evidence.rejected_head_replacement).toBe(true);
  expect((await query('plugins.branch_head',{branch:branch.id})).revision).toBe(head);expect((await query('plugins.branch_head',{branch:other.branch})).revision).toBe(subject.revision);
  expect((await query('plugins.inspect',{revision:head})).artifacts).toHaveLength(0);
  let records=await operations();expect(records.filter(r=>r.capability.id==='plugins.checkpoint')).toHaveLength(1);
  for(const id of ['plugins.build','plugins.preview'])expect(records.filter(r=>r.capability.id===id)).toHaveLength(0);
  expect((await query('windows.scenario',{window:windowId})).scenario.revision).toBe(initial.id);
  await page.reload();await expect(frame.getByRole('log')).toContainText('new checkpoint');expect(JSON.parse(readFileSync(join(project,'native-science-evidence.json'),'utf8')).prompts).toBe(1);
  await page.getByRole('tab',{name:'Plugin Studio',exact:true}).click();await studio.getByRole('button',{name:'Choose revision',exact:true}).click();
  await studio.getByRole('button',{name:new RegExp(`report-agent-edit · ${head.slice(7,15)}`)}).click();
  await studio.getByRole('button',{name:'History',exact:true}).click();await studio.getByText('src/index.html · changed',{exact:true}).click();await expect(studio.locator('#changes')).toContainText('Agent revised report 中文 Ω');
  await studio.locator('#close-history').click();await studio.getByRole('button',{name:'Build & preview',exact:true}).click();
  await studio.getByRole('button',{name:'Build checkpoint',exact:true}).click();await expect(studio.locator('#build-status')).toContainText('Build succeeded',{timeout:60000});
  const built=(await query('plugins.inspect',{revision:head})).artifacts;expect(built).toHaveLength(1);
  await studio.getByText('Preview configuration and fixture data',{exact:true}).click();await studio.getByLabel('Initial view state',{exact:true}).fill('{"text":"Preview only"}');
  await studio.getByRole('button',{name:'Start preview',exact:true}).click();await expect(page.locator('[data-plugin-preview=fixture]')).toBeVisible();
  const previewLayout=await query('windows.layout',{window:windowId});expect(previewLayout.layout.kind).toBe('tabs');
  const previewView=await query('views.inspect',{view:previewLayout.layout.selected});expect(previewView.purpose).toBe('fixture_preview');expect(previewView.instance.revision).toBe(head);
  const previewRegion=page.locator(`[data-plugin-frame="${previewView.view}"]`);await expect(previewRegion.frameLocator('iframe').getByRole('heading',{name:'Agent revised report 中文 Ω',exact:true})).toBeVisible();
  await page.screenshot({path:info.outputPath('studio-agent-preview.png')});
  expect((await query('windows.scenario',{window:windowId})).scenario.revision).toBe(initial.id);expect((await query('plugins.instance',{instance:oldView.instance})).instance.state).toBe('active');
  await page.getByRole('tab',{name:'Plugin Studio',exact:true}).click();await studio.getByRole('button',{name:'Close preview view',exact:true}).click();
  await expect(studio.locator('#preview-instance')).toContainText('view closed');await studio.locator('#release-preview').click();await studio.locator('#close-development').click();
  await studio.getByRole('button',{name:'Apply to scenario',exact:true}).click();await studio.getByLabel('Target scenario',{exact:true}).selectOption(initial.id);
  await expect(studio.getByLabel('Instance alias',{exact:true})).toHaveValue('report');await studio.getByLabel('New view state by view ID',{exact:true}).fill('{"report-view":{"text":"Reviewed Agent checkpoint"}}');
  await studio.getByRole('button',{name:'Stage selected build',exact:true}).click();await studio.getByRole('button',{name:'Save scenario checkpoint',exact:true}).click();
  await studio.getByRole('button',{name:'Prepare instances',exact:true}).click();await expect(studio.locator('#scenario-lifecycle')).toContainText('ready to apply');
  expect((await query('windows.scenario',{window:windowId})).scenario.revision).toBe(initial.id);
  await studio.getByRole('button',{name:'Apply to this window',exact:true}).click();await expect(studio.locator('#scenario-applied')).toContainText('Applied');
  const applied=await query('windows.scenario',{window:windowId});expect(applied.scenario.instances.report.revision).toBe(head);expect(applied.scenario.instances.report.artifact).toBe(built[0].id);
  expect(applied.scenario.instances.report.instance).not.toBe(oldView.instance.instance);expect((await query('views.inspect',{view:oldView.view})).closed).toBe(false);
  expect((await query('plugins.instance',{instance:oldView.instance})).instance.state).toBe('active');expect((await query('views.inspect',{view:inspected.view})).closed).toBe(false);
  await studio.locator('#close-scenario').click();await page.getByRole('tab',{name:'Independent View',exact:true}).click();
  const report=page.locator(`[data-plugin-frame="${applied.scenario.views['report-view']}"]`).frameLocator('iframe');
  await expect(report.getByRole('heading',{name:'Agent revised report 中文 Ω',exact:true})).toBeVisible();await expect(report.getByLabel('View note',{exact:true})).toHaveValue('Reviewed Agent checkpoint');
  records=await operations();expect(records.filter(r=>r.capability.id==='plugins.checkpoint')).toHaveLength(1);expect(records.filter(r=>r.capability.id==='plugins.build')).toHaveLength(1);
  expect(records.filter(r=>r.capability.id==='plugins.preview')).toHaveLength(1);expect(JSON.parse(readFileSync(join(project,'native-science-evidence.json'),'utf8')).prompts).toBe(1);expect(errors).toEqual([]);
  await page.screenshot({path:info.outputPath('studio-agent-applied.png')});
  writeFileSync(info.outputPath('studio-agent-evidence.json'),JSON.stringify({source:subject.revision,branch:branch.id,checkpoint:head,artifact:built[0].id,scenario:applied.scenario.revision,
    agent:agent,send:send.request_id,native_tool:evidence.invocation.tool_request,view_open_calls:openCalls,prompts:1,checkpoint_operations:1,build_operations:1,preview_operations:1,old_instance_retained:true,
    agent_package:verifyAgentBuild(process.env.RHO_AGENT_PLUGIN_PACKAGE!),build_mode:agentBuildMode(process.env.RHO_AGENT_PLUGIN_PACKAGE!),limits:['Local ACP peer; no external model','Separate explicit Studio actions; no publication','Host restart is covered by agent-workspace.spec.ts, not this case']},null,2)+'\n');
  completed=true;
});
