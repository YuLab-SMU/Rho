/** Rho's actual ordinary view, Rig model driver and R plugin. Only the model peer is local. */
import { test, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyAgentBuild, agentBuildMode } from '../../scripts/agent-plugin-artifact.mjs';
import { setAgentViewport } from './fixtures/agent-scientific-context';

let directory: string, project: string, url: URL, host: ReturnType<typeof spawn>, agent: any, r: any, view: any, session: string, rBinding: any;
let completed = false, modelUrl: string;
const binary = resolve('../target/debug/rho'), windowId = 'rho-tools-acceptance';
const requests: any[] = [], errors: string[] = [];
const server = createServer(async (request, response) => {
  try {
    expect(request.method).toBe('POST'); expect(request.url).toBe('/v1/chat/completions');
    expect(request.headers.authorization).toBe('Bearer disposable-rho-tool-key');
    let input = ''; for await (const bytes of request) { input += bytes; if (Buffer.byteLength(input) > 262144) throw Error('Oversized model input'); }
    const body = JSON.parse(input); expect(body.stream).toBe(true); requests.push(body);
    expect(body.tools.map((tool: any) => tool.function.name).sort()).toEqual(['r_execute','r_session']);
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({id:'rho-tool-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`;
    let text = chunk({role:'assistant'},null);
    if (requests.length === 1) {
      const code = 'tool_counter <- if (exists("tool_counter", inherits=FALSE)) tool_counter + 1L else 1L; writeLines(as.character(tool_counter), "rho-tool-counter.txt"); cat("Rho selected tool result 中文 Ω\\n"); tool_counter';
      text += chunk({tool_calls:[{index:0,id:'original-r-tool',type:'function',function:{name:'r_execute',arguments:JSON.stringify({code})}}]},null) + chunk({},'tool_calls');
    } else {
      if (requests.length === 2) {
        const tool = JSON.parse(body.messages.find((message: any) => message.role === 'tool').content);
        expect(tool.status).toBe('succeeded'); expect(tool.output.report).toBeTruthy();
      } else {
        expect(requests).toHaveLength(3);
        expect(JSON.stringify(body.messages)).toContain('Confirmed earlier actions must not be executed again');
      }
      text += chunk({content:'Confirmed original R result 中文 Ω'},null) + chunk({},'stop');
    }
    response.writeHead(200,{'Content-Type':'text/event-stream'}).end(text + 'data: [DONE]\n\n');
  } catch (error) { errors.push(String(error)); response.writeHead(500).end('Model fixture rejected request'); }
});
async function port(method: string, params: unknown) {
  const reply = await fetch(new URL('/api/host',url),{method:'POST',headers:{Authorization:`Bearer ${url.hash.slice(7)}`,'Content-Type':'application/json','X-Rho-Studio-Window':windowId},
    body:JSON.stringify({project_root:project,frame:{id:crypto.randomUUID(),request:{method,params}}})}).then(response=>response.json());
  if (!reply.ok) throw Error(reply.error); return reply.result;
}
async function query(id: string, args: unknown) { return (await port('query_snapshot',{capability:{id,version:1},arguments:args})).data; }
async function binding(instance: any, id: string, version=1) { return query('plugins.resolve',{instance,capability:{id,version}}); }
async function invoke(id: string, args: unknown) {
  const record=await port('invoke',{capability:{id,version:1},arguments:args,preconditions:[],client_request_id:crypto.randomUUID()});
  expect(record.status,JSON.stringify(record.error)).toBe('succeeded'); return record.output;
}
async function agentQuery(id: string, args: unknown) { return query(id,{binding:await binding(agent,id),arguments:args}); }
async function executions() {
  const records:any[]=[]; let before_cursor:number|null=null;
  for(let i=0;i<20;i++){
    const page=await query('operation.list_recent',{limit:100,before_cursor});
    records.push(...page.operations.filter((record:any)=>record.capability.id==='r.execute'));
    if(page.next_cursor===null)return records;before_cursor=page.next_cursor;
  }
  throw Error('Exceeded bounded Operation history');
}
test.beforeAll(async()=>{
  test.setTimeout(180000);
  const agentPackage=verifyAgentBuild(process.env.RHO_AGENT_PLUGIN_PACKAGE!);
  directory=realpathSync(mkdtempSync(join(tmpdir(),'rho-tools-browser-')));project=join(directory,'project');mkdirSync(project);
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));modelUrl=`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const database=join(directory,'state.sqlite');
  const snapshot=(path:string)=>JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',path,'--target','aarch64-apple-darwin'],{encoding:'utf8',timeout:90000})).result;
  const packages={agent:snapshot(agentPackage),r:snapshot(realpathSync(process.env.RHO_R_PLUGIN_PACKAGE!))};
  host=spawn(binary,['--database',database,'--project',project,'workbench'],{stdio:['ignore','pipe','pipe']});
  url=new URL(await new Promise<string>((done,reject)=>{
    let output='',errors='';const timer=setTimeout(()=>reject(Error(`Host startup timeout: ${errors}`)),60000);
    host.stderr!.on('data',bytes=>errors+=bytes);host.stdout!.on('data',bytes=>{output+=bytes;const found=output.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);if(found){clearTimeout(timer);done(found[0]);}});
    host.once('exit',code=>{clearTimeout(timer);reject(Error(`Host exited ${code}: ${errors}`));});
  }));
  const activate=async(name:'agent'|'r',configuration:unknown,optional_capabilities:any[]=[])=>
    (await invoke('plugins.activate',{revision:packages[name].revision,artifact:packages[name].artifacts[0],target:'aarch64-apple-darwin',alias:name,configuration,optional_capabilities})).instance.identity;
  r=await activate('r',{ark:realpathSync(process.env.RHO_ARK!),r_home:realpathSync(process.env.RHO_R_HOME!),execution_timeout_seconds:60});
  session=(await invoke('r.create_session',{binding:await binding(r,'r.create_session'),arguments:{}})).session_id;
  agent=await activate('agent',{},[{id:'r.execute',version:2},...['r.session','operation.get','plugins.delegated_operation'].map(id=>({id,version:1}))]);
  rBinding={...await binding(r,'r.execute',2),target:session};
  const layout=await query('windows.layout',{window:windowId});
  view=(await invoke('windows.open_view',{expected_layout_version:layout.version,group:null,view:{instance:agent,contribution:'agent',window:windowId,
    configuration:{tools:[{name:'Selected workspace',target:{type:'provider',binding:rBinding}}]},state:{}}})).view;
});
test.afterAll(async()=>{
  try {
    if(host&&host.exitCode===null&&host.signalCode===null)await new Promise<void>((done,reject)=>{
      const timer=setTimeout(()=>{host.kill('SIGKILL');reject(Error('Disposable Host shutdown timeout'));},60000);
      host.once('exit',(code,signal)=>{clearTimeout(timer);if(code!==0||signal)reject(Error(`Unclean shutdown ${code}/${signal}`));else done();});host.kill('SIGINT');
    });
  } finally {server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
  if(completed)rmSync(directory,{recursive:true,force:true});else if(directory)console.error(`Rho tools evidence retained at ${directory}`);
});
test('Rho selection binds real R to the original Send and Continue retains it after deselection',async({page},info)=>{
  test.setTimeout(180000);
  const address=new URL(url);address.searchParams.set('window',windowId);await page.goto(address.href);
  const frame=page.locator(`[data-plugin-frame="${view.view}"]`).frameLocator('iframe');
  await frame.getByRole('button',{name:'New task',exact:true}).click();await frame.getByRole('button',{name:'Rho',exact:true}).click();
  const composer=frame.getByRole('textbox',{name:'Agent message',exact:true});await expect(composer).toBeEnabled();
  const selected=await frame.getByLabel('Select task',{exact:true}).inputValue();expect(selected).toMatch(/^rho:/);const task=selected.slice(4);
  const conversation=()=>agentQuery('agent.model.conversation',{conversation_id:task});
  const history=()=>agentQuery('agent.model.history',{conversation_id:task,before:null,limit:5});
  const run=(id:string)=>agentQuery('agent.model.run.get',{run_id:id});
  await frame.getByRole('button',{name:'Task actions',exact:true}).click();await frame.getByRole('button',{name:'Settings',exact:true}).click();
  const settings=frame.getByRole('dialog',{name:'Agent settings'});
  await settings.getByRole('checkbox',{name:'Enable Rho'}).check();await settings.getByRole('combobox',{name:'API format'}).selectOption('openai_completions');
  await settings.getByRole('textbox',{name:'Base URL'}).fill(modelUrl);await settings.getByRole('textbox',{name:'Model ID'}).fill('fixture');
  await settings.getByRole('textbox',{name:'API key',exact:true}).fill('disposable-rho-tool-key');await settings.getByRole('button',{name:'Save',exact:true}).click();
  await expect(settings.locator('#settings-key-status')).toContainText('Saved on this computer');await settings.getByRole('button',{name:'Close settings'}).click();
  await frame.getByRole('button',{name:'Tools',exact:true}).click();const choice=frame.getByRole('checkbox',{name:'Selected workspace · Run R',exact:true});
  await expect(choice).not.toBeChecked();await choice.check();await expect(choice).toBeChecked();
  await expect.poll(async()=>((await query('views.inspect',{view:view.view})).state as any)?.rho?.tool?.name).toBe('Selected workspace');
  await page.reload();await frame.getByRole('button',{name:'Tools',exact:true}).click();await expect(choice).toBeChecked();
  for(const width of [1440,390,220]){await setAgentViewport(page,frame,width);await expect.poll(()=>frame.locator('body').evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await expect.poll(()=>frame.locator('#tools-menu').evaluate(node=>{const rect=node.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight;})).toBe(true);await frame.locator('body').screenshot({path:info.outputPath(`rho-tools-${width}.png`)});}
  await frame.getByRole('button',{name:'Tools',exact:true}).click();await setAgentViewport(page,frame,1440);
  const prompt='Run the selected R counter once · 中文 Ω';await composer.fill(prompt);await expect.poll(async()=>(await conversation()).draft).toBe(prompt);
  let sends=0;
  await page.route('**/api/plugin-view',async route=>{
    const body=route.request().postDataJSON()?.message?.body;
    if(body?.type==='invoke'&&body.capability.id==='agent.model.run'){
      sends++;if(sends===1){const response=await route.fetch(),reply=await response.json();expect(reply.ok).toBe(true);await route.fulfill({response,json:{id:reply.id,ok:false,error:'Fixture lost original Rho tool Send reply'}});return;}
    }await route.continue();
  });
  await frame.getByRole('button',{name:'Send message',exact:true}).click();
  await expect.poll(async()=>(await history()).runs.length,{timeout:45000}).toBe(1);const originalId=(await history()).runs[0].run_id;
  await expect.poll(async()=>(await run(originalId)).state,{timeout:60000}).toBe('completed');expect(errors).toEqual([]);
  await page.reload();await frame.locator('#inspect-original').click();
  await expect(frame.getByRole('log',{name:'Agent conversation'})).toContainText('Confirmed original R result 中文 Ω');
  const original=await run(originalId);expect(original.request.grant).toMatchObject({mode:'run',session:{workspace_instance_id:r.instance,session_id:session}});
  const admission=await agentQuery('agent.model.run.admission',{run_id:originalId});expect(admission.r).toEqual(rBinding);
  const receipts=await agentQuery('agent.model.run.tools',{run_id:originalId});expect(receipts).toHaveLength(1);expect(receipts[0].phase).toBe('resolved');
  const children=await executions();expect(children).toHaveLength(1);
  const child=await port('get_operation',{operation_id:receipts[0].operation_id});
  expect(child.status).toBe('succeeded');expect(child.operation.normalized_arguments.binding).toEqual(rBinding);expect(child.output.session_id).toBe(session);
  const originalOperation=await port('get_operation',{operation_id:child.operation.causation_id});
  expect(originalOperation.operation.capability.id).toBe('agent.model.run');expect(originalOperation.operation.normalized_arguments.arguments.request_id).toBe(original.request.request_id);expect(readFileSync(join(project,'rho-tool-counter.txt'),'utf8').trim()).toBe('1');expect(requests).toHaveLength(2);expect(sends).toBe(1);
  await frame.getByRole('button',{name:'Tools',exact:true}).click();await choice.uncheck();await expect(choice).not.toBeChecked();await frame.getByRole('button',{name:'Tools',exact:true}).click();
  await frame.getByRole('button',{name:'Check tool outcomes',exact:true}).click();await expect(frame.getByText('Original tool outcomes inspected',{exact:true})).toBeVisible();
  await composer.fill('Continue from that confirmed result without running it again');await expect.poll(async()=>(await conversation()).draft).toContain('Continue from');
  await frame.getByRole('button',{name:'Continue task',exact:true}).click();await expect.poll(async()=>(await history()).runs.length).toBe(2);
  const continuedId=(await history()).runs[0].run_id;await expect.poll(async()=>(await run(continuedId)).state).toBe('completed');
  expect((await agentQuery('agent.model.run.admission',{run_id:continuedId})).r).toEqual(rBinding);
  expect((await run(continuedId)).request.continuation.run_id).toBe(originalId);expect(requests).toHaveLength(3);expect(await executions()).toHaveLength(1);
  await page.reload();await expect(frame.getByRole('log',{name:'Agent conversation'})).toContainText('Confirmed original R result 中文 Ω');
  expect(await executions()).toHaveLength(1);expect(requests).toHaveLength(3);expect(errors).toEqual([]);
  verifyAgentBuild(process.env.RHO_AGENT_PLUGIN_PACKAGE!);
  writeFileSync(info.outputPath('rho-tools-result.json'),JSON.stringify({status:'passed',build_mode:agentBuildMode(process.env.RHO_AGENT_PLUGIN_PACKAGE!),task,session,original:originalId,continued:continuedId,child:child.operation.operation_id,parent:child.operation.causation_id,model_requests:requests.length,executions:1,send_calls:sends,limits:['Local model peer; actual Rig, ordinary Host and R','No installation, publication or user Host restart']},null,2));completed=true;
});
