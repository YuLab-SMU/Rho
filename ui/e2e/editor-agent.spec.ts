/** Editor-owned component capture through a real generic Host and ordinary Agent view. */
import { test, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
let directory: string, project: string, url: URL, process_: ReturnType<typeof spawn>, view: any, files: any, editor: any, agent: any;
let completed=false;
const windowId='editor-agent-window',binary=resolve('../target/debug/rho'),filename='分析与后续编辑的文件.R';
const initial='\ufeffx <- 1\r\n# 说明 中文\n';
const hash=(input:Buffer|string)=>'sha256:'+createHash('sha256').update(input).digest('hex');
async function port(method:string,params:any){
  const response=await fetch(new URL('/api/host',url),{method:'POST',headers:{Authorization:`Bearer ${url.hash.slice(7)}`,'Content-Type':'application/json','X-Rho-Studio-Window':windowId},
    body:JSON.stringify({project_root:project,frame:{id:crypto.randomUUID(),request:{method,params}}})}).then(response=>response.json());
  if(!response.ok)throw new Error(response.error);return response.result;
}
async function invoke(id:string,args:any){const record=await port('invoke',{capability:{id,version:1},arguments:args,preconditions:[],client_request_id:crypto.randomUUID()});expect(record.status,JSON.stringify(record.error)).toBe('succeeded');return record.output;}
async function query(id:string,args:any){return(await port('query_snapshot',{capability:{id,version:1},arguments:args})).data;}
async function contextQuery(id:string,args:any){return query(id,{binding:await query('plugins.resolve',{capability:{id,version:1},instance:editor.identity}),arguments:args});}
async function contextSearch(text:string){return contextQuery('editor.context.search',{window:windowId,text,after:null,limit:20});}
async function contextPreview(reference:any,kind='document',max_bytes=65536){return contextQuery('editor.context.preview',{reference,inclusion:{kind},max_bytes});}
async function capture(path:string){const binding=await query('plugins.resolve',{capability:{id:'files.snapshot',version:1},instance:files.identity});return(await query('files.snapshot',{binding,arguments:{paths:[path],limit:1}})).files[0];}
async function open(configuration:any,state:any={}){const layout=await query('windows.layout',{window:windowId});return(await invoke('windows.open_view',{expected_layout_version:layout.version,group:layout.layout.kind==='tabs'?layout.layout.id:null,
  view:{instance:editor.identity,contribution:'editor',window:windowId,configuration,state}})).view;}
test.beforeAll(async()=>{
  test.setTimeout(600000);directory=realpathSync(mkdtempSync(join(tmpdir(),'rho-editor-native-')));project=join(directory,'project');mkdirSync(project);
  writeFileSync(join(project,filename),initial);execFileSync('git',['init','-q',project]);
  const before=hash(readFileSync(binary));
  for(const name of ['RHO_FILES_PLUGIN_PACKAGE','RHO_EDITOR_PLUGIN_PACKAGE','RHO_AGENT_PLUGIN_PACKAGE'])
    if(!process.env[name])throw Error(`Supply a retained ${name}; this browser check never builds packages.`);
  const filesPath=process.env.RHO_FILES_PLUGIN_PACKAGE!,editorPath=process.env.RHO_EDITOR_PLUGIN_PACKAGE!;
  expect(hash(readFileSync(binary))).toBe(before);
  const database=join(directory,'state.sqlite'),snapshot=(path:string,target:string)=>JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',path,'--target',target],{encoding:'utf8'})).result;
  const filesPackage=snapshot(filesPath,'aarch64-apple-darwin'),editorPackage=snapshot(editorPath,'aarch64-apple-darwin');
  process_=spawn(binary,['--database',database,'--project',project,'workbench'],{stdio:['ignore','pipe','pipe']});
  url=new URL(await new Promise<string>((done,reject)=>{let output='',errors='';const timer=setTimeout(()=>reject(new Error(`Editor Host startup timed out: ${errors}`)),90000);
    process_.stderr!.on('data',bytes=>errors+=bytes);process_.stdout!.on('data',bytes=>{output+=bytes;const found=output.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);if(found){clearTimeout(timer);done(found[0]);}});
    process_.once('exit',code=>{clearTimeout(timer);reject(new Error(`Editor Host exited ${code}: ${errors}`));});}));
  files=(await invoke('plugins.activate',{revision:filesPackage.revision,artifact:filesPackage.artifacts[0],target:'aarch64-apple-darwin',alias:'files',configuration:{}})).instance;
  editor=(await invoke('plugins.activate',{revision:editorPackage.revision,artifact:editorPackage.artifacts[0],target:'aarch64-apple-darwin',alias:'editor',configuration:{}})).instance;
  const agentPackage=snapshot(process.env.RHO_AGENT_PLUGIN_PACKAGE!,'aarch64-apple-darwin');
  agent=(await invoke('plugins.activate',{revision:agentPackage.revision,artifact:agentPackage.artifacts[0],target:'aarch64-apple-darwin',alias:'assistant',configuration:{},optional_capabilities:['plugins.instances','plugins.inspect','editor.context.preview'].map(id=>({id,version:1}))})).instance;
  view=await open({source:files.identity,file:await capture(filename)});
});
test.afterAll(async()=>{
  if(process_?.exitCode===null)await new Promise<void>((done,reject)=>{const timer=setTimeout(()=>reject(Error('Disposable Host shutdown timed out')),60000);process_.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(Error('Host shutdown failed'));else done();});process_.kill('SIGINT');});
  if(directory&&completed)rmSync(directory,{recursive:true,force:true});else if(directory)console.error(`Editor Agent fixture retained at ${directory}`);
});
test('Editor selection opens one ordinary Agent view, recovers a lost reply and adds exact input to an editable draft',async({page},info)=>{
  test.setTimeout(150000);const address=new URL(url);address.searchParams.set('window',windowId);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(address.href);
  const frame=(id:string)=>page.locator(`[data-plugin-frame="${id}"]`).frameLocator('iframe');
  const source=frame(view.view),code=source.getByRole('textbox',{name:'Code Editor',exact:true});await expect(code).toBeVisible();
  const text='selected_input <- "同步的选区 Ω"\n# unsaved input\n';
  await code.click();await code.press('Meta+a');await page.keyboard.insertText(text);await code.press('Meta+a');
  await source.getByRole('button',{name:'Ask about…',exact:true}).click();
  const dialog=source.getByRole('dialog',{name:'Ask about this input',exact:true});
  await expect(dialog.locator('#agent-preview')).toHaveText(text.trim());
  await expect(dialog.locator('#agent-capture')).toContainText('Selection from');
  await dialog.getByLabel('Agent instance',{exact:true}).selectOption(agent.identity.instance);
  await expect(dialog.getByRole('button',{name:'Open Agent',exact:true})).toBeEnabled();
  for(const width of [960,390,220]){
    await page.setViewportSize({width,height:900});await expect.poll(()=>dialog.evaluate((element,width)=>{
      const rect=element.getBoundingClientRect();return Math.abs(innerWidth-width)<4&&rect.left>=0&&rect.right<=innerWidth;
    },width)).toBe(true);
    expect(await dialog.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    await page.screenshot({path:info.outputPath(`editor-agent-${width}.png`)});
  }
  await page.setViewportSize({width:960,height:900});
  let opens=0,lost=false;
  await page.route('**/api/plugin-view',async route=>{
    const body=route.request().postDataJSON()?.message?.body;
    if(body?.type==='invoke'&&body.capability?.id==='windows.open_view'){
      opens++;if(!lost){lost=true;await route.fetch();await route.abort('failed');return;}
    }
    await route.continue();
  });
  await dialog.getByRole('button',{name:'Open Agent',exact:true}).click();
  await expect(page.getByRole('tab',{name:'Agent',exact:true})).toBeVisible();
  await expect.poll(async()=>!!(await query('views.inspect',{view:view.view})).state.agent.pending).toBe(true);
  const pending=(await query('views.inspect',{view:view.view})).state.agent.pending;
  await page.reload();await page.getByRole('tab',{name:'Editor',exact:true}).click();
  await source.getByRole('button',{name:'Ask about…',exact:true}).click();
  await dialog.getByRole('button',{name:'Check original request',exact:true}).click();
  await expect(dialog.locator('#agent-status')).toContainText('Agent view opened');
  const saved=(await query('views.inspect',{view:view.view})).state;
  expect(saved.agent.pending).toBeNull();expect(saved.agent.opened.configuration).toEqual(pending.arguments.view.configuration);
  expect(opens).toBe(1);expect(lost).toBe(true);
  await dialog.getByRole('button',{name:'Back to Editor',exact:true}).click();
  await page.getByRole('tab',{name:'Agent',exact:true}).click();
  const receiver=frame(saved.agent.opened.view);
  await receiver.getByRole('button',{name:'New task',exact:true}).click();await receiver.getByRole('button',{name:'Rho',exact:true}).click();
  const composer=receiver.getByRole('textbox',{name:'Agent message',exact:true});await expect(composer).toBeEnabled();
  const selected=await receiver.getByLabel('Select task',{exact:true}).inputValue();expect(selected).toMatch(/^rho:/);
  const agentBinding=await query('plugins.resolve',{capability:{id:'agent.model.conversation',version:1},instance:agent.identity});
  const detail=()=>query('agent.model.conversation',{binding:agentBinding,arguments:{conversation_id:selected.slice(4)}});
  const prompt='Explain this selected input · 中文';await composer.fill(prompt);await expect.poll(async()=>(await detail()).draft).toBe(prompt);
  await receiver.locator('#component-request summary').click();
  await receiver.getByRole('button',{name:'Preview '+saved.agent.input.title,exact:true}).click();
  const picker=receiver.getByRole('dialog',{name:'Choose context'});await expect(picker.locator('#context-preview')).toHaveText(text.trim());
  await picker.getByRole('button',{name:'Close context'}).click();
  await receiver.getByRole('button',{name:'Add context to draft',exact:true}).click();
  await expect(receiver.getByRole('button',{name:'Add context to draft',exact:true})).toBeDisabled();
  await expect.poll(async()=>(await detail()).draft_content.context.length).toBe(1);
  const captured=(await detail()).draft_content.context[0];expect(captured.reference).toEqual(saved.agent.input.reference);expect(JSON.parse(captured.inclusion)).toEqual({kind:'selection'});
  expect((await detail()).draft).toBe(prompt);expect((await contextPreview(captured.reference,'selection')).text).toBe(text);
  expect(readFileSync(join(project,filename),'utf8')).toBe(initial);
  await page.reload();await expect(composer).toHaveValue(prompt);
  await receiver.locator('#component-request summary').click();
  await expect(receiver.getByRole('button',{name:'Add context to draft',exact:true})).toBeDisabled();
  await expect(receiver.locator('#selected-context')).toContainText(saved.agent.input.title);
  await page.screenshot({path:info.outputPath('editor-agent-restored-960.png')});
  const layout=await query('windows.layout',{window:windowId});const ids=(node:any):string[]=>node.kind==='tabs'?node.views:node.kind==='split'?node.children.flatMap(ids):[];
  expect(ids(layout.layout)).toEqual(expect.arrayContaining([view.view,saved.agent.opened.view]));expect(ids(layout.layout)).toHaveLength(2);
  const recent=await query('operation.list_recent',{limit:100});expect(recent.next_cursor).toBeNull();const operations=recent.operations;
  expect(operations.filter((op:any)=>['agent.model.run','agent.native.command','files.apply_patch','r.execute'].includes(op.capability.id))).toHaveLength(0);
  expect(errors).toEqual([]);
  writeFileSync(info.outputPath('editor-agent-result.json'),JSON.stringify({editor:editor.identity,agent:agent.identity,source:captured,request:pending.request,opened_view:saved.agent.opened.view,opens,task:selected,host_sha256:hash(readFileSync(binary)),file_unchanged:true,no_send:true},null,2));
  completed=true;
});
