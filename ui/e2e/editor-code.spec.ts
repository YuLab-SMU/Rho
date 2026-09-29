/** Native Editor/R/Console packages, explicit optional grants and original recovery. */
import { test, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
let directory: string, project: string, url: URL, host: ReturnType<typeof spawn>, view: any, files: any, editor: any, r: any, alternate: any, console_: any;
let completed=false;
const windowId='editor-code-window',binary=resolve('../target/debug/rho'),filename='编辑与格式化.R',initial='\ufeffformat_should_not_execute=42\r\n';
const hash=(input:Buffer|string)=>'sha256:'+createHash('sha256').update(input).digest('hex');
async function port(method:string,params:any){
  const response=await fetch(new URL('/api/host',url),{method:'POST',headers:{Authorization:`Bearer ${url.hash.slice(7)}`,'Content-Type':'application/json','X-Rho-Studio-Window':windowId},
    body:JSON.stringify({project_root:project,frame:{id:crypto.randomUUID(),request:{method,params}}})}).then(response=>response.json());
  if(!response.ok)throw new Error(response.error);return response.result;
}
async function invoke(id:string,args:any){const record=await port('invoke',{capability:{id,version:1},arguments:args,preconditions:[],client_request_id:crypto.randomUUID()});expect(record.status,JSON.stringify(record.error)).toBe('succeeded');return record.output;}
async function query(id:string,args:any){return(await port('query_snapshot',{capability:{id,version:1},arguments:args})).data;}
async function native(id:string,args:any,provider=r){return query(id,{binding:await query('plugins.resolve',{capability:{id,version:1},instance:provider.identity}),arguments:args});}
async function run(code:string,provider=r){const session=await native('r.session',{},provider);return invoke('r.execute',{binding:await query('plugins.resolve',{capability:{id:'r.execute',version:1},instance:provider.identity}),arguments:{expected_session:session.session_id,code}});}
async function open(configuration:any,state:any={}){const layout=await query('windows.layout',{window:windowId});return(await invoke('windows.open_view',{expected_layout_version:layout.version,group:layout.layout.kind==='tabs'?layout.layout.id:null,
  view:{instance:editor.identity,contribution:'editor',window:windowId,configuration,state}})).view;}
test.beforeAll(async()=>{
  test.setTimeout(600000);expect(process.env.RHO_ARK&&process.env.RHO_R_HOME,'Use explicitly selected existing Ark/R tools.').toBeTruthy();
  directory=realpathSync(mkdtempSync(join(tmpdir(),'rho-editor-code-')));project=join(directory,'project');mkdirSync(project);writeFileSync(join(project,filename),initial);execFileSync('git',['init','-q',project]);
  const before=hash(readFileSync(binary)),packages:any={};
  for(const [name,key] of [['files','RHO_FILES_PLUGIN_PACKAGE'],['editor','RHO_EDITOR_PLUGIN_PACKAGE'],['r','RHO_R_PLUGIN_PACKAGE'],['console','RHO_CONSOLE_PLUGIN_PACKAGE']]){
    const path=process.env[key]??join(directory,name);if(!process.env[key])execFileSync(process.execPath,[resolve(`../scripts/build-${name}-plugin.mjs`),path],{stdio:'inherit'});packages[name]=path;
  }
  expect(hash(readFileSync(binary))).toBe(before);
  const database=join(directory,'state.sqlite'),snapshot=(path:string,target:string)=>JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',path,'--target',target],{encoding:'utf8'})).result;
  const captured:any={};for(const name of Object.keys(packages))captured[name]=snapshot(packages[name],['r','files','editor'].includes(name)?'aarch64-apple-darwin':'ui-web');
  host=spawn(binary,['--database',database,'--project',project,'workbench'],{stdio:['ignore','pipe','pipe']});
  url=new URL(await new Promise<string>((done,reject)=>{let output='',errors='';const timer=setTimeout(()=>reject(new Error(`Editor code Host startup timed out: ${errors}`)),90000);
    host.stderr!.on('data',bytes=>errors+=bytes);host.stdout!.on('data',bytes=>{output+=bytes;const found=output.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);if(found){clearTimeout(timer);done(found[0]);}});
    host.once('exit',code=>{clearTimeout(timer);reject(new Error(`Editor code Host exited ${code}: ${errors}`));});}));
  const activate=async(name:string,configuration:any={},optional_capabilities:any[]=[],alias=name)=>
    (await invoke('plugins.activate',{revision:captured[name].revision,artifact:captured[name].artifacts[0],target:['r','files','editor'].includes(name)?'aarch64-apple-darwin':'ui-web',alias,configuration,optional_capabilities})).instance;
  files=await activate('files');
  r=await activate('r',{ark:realpathSync(process.env.RHO_ARK!),r_home:realpathSync(process.env.RHO_R_HOME!),execution_timeout_seconds:30});
  alternate=await activate('r',r.configuration,[],'analysis-alt');
  editor=await activate('editor',{},[{id:'r.session',version:1},{id:'r.execute',version:2},{id:'r.format',version:1},{id:'resources.read',version:1},{id:'plugins.instances',version:1},{id:'plugins.inspect',version:1}]);
  console_=await activate('console');
  const binding=await query('plugins.resolve',{capability:{id:'files.snapshot',version:1},instance:files.identity});
  const file=(await query('files.snapshot',{binding,arguments:{paths:[filename],limit:1}})).files[0];
  view=await open({source:files.identity,file,runtime:r.identity,session_selection:true});
});
test.afterAll(async()=>{
  if(host?.exitCode===null){host.kill('SIGINT');await new Promise<void>(done=>host.once('exit',()=>done()));}
  if(directory&&completed)rmSync(directory,{recursive:true,force:true});else if(directory)console.error(`Editor code fixture retained at ${directory}`);
});
test('ordinary Editor retains native formatting, captured Console runs and save-before-run recovery across reopening',async({page},info)=>{
  test.setTimeout(240000);const address=new URL(url);address.searchParams.set('window',windowId);address.searchParams.set('plugin-window','');
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(address.href);
  const region=(id:string)=>page.locator(`[data-plugin-frame="${id}"]`),frame=(id:string)=>region(id).frameLocator('iframe');
  const first=frame(view.view),code=first.getByRole('textbox',{name:'Code Editor',exact:true});await expect(code).toBeVisible();
  expect((await native('r.session',{})).state).toBe('unstarted');
  await first.getByRole('button',{name:'Format',exact:true}).click();await expect(first.locator('#error')).toContainText('Start the selected R session');
  expect((await native('r.session',{})).state).toBe('unstarted');expect(readFileSync(join(project,filename),'utf8')).toBe(initial);
  // Starting R is an explicit Console action in this disposable window.
  const layout=await query('windows.layout',{window:windowId});
  const consoleView=(await invoke('windows.open_view',{expected_layout_version:layout.version,group:layout.layout.id,view:{instance:console_.identity,contribution:'console',window:windowId,configuration:{source:r.identity},state:{}}})).view;
  const consoleFrame=frame(consoleView.view);await expect(consoleFrame.getByRole('button',{name:'Start R',exact:true})).toBeVisible();
  await consoleFrame.getByRole('button',{name:'Start R',exact:true}).click();await expect.poll(async()=>(await native('r.session',{})).state,{timeout:60000}).toBe('idle');
  await page.getByRole('tab',{name:'Editor',exact:true}).click();await first.getByRole('button',{name:'Format',exact:true}).click();
  await expect(first.locator('#code-status')).toContainText('Formatting complete');await expect(code).toContainText('format_should_not_execute <- 42');
  expect((await run('exists("format_should_not_execute", envir=.GlobalEnv, inherits=FALSE)')).value).toBe(false);expect(readFileSync(join(project,filename),'utf8')).toBe(initial);
  await code.click();await code.press('Meta+z');await expect(code).toContainText('format_should_not_execute=42');
  await first.getByRole('button',{name:'Format',exact:true}).click();await expect(first.locator('#code-status')).toContainText('Formatting complete');await expect(code).toContainText('format_should_not_execute <- 42');
  await first.getByRole('button',{name:'Save',exact:true}).click();await expect(first.locator('#file-state')).toHaveText('Saved');
  expect(readFileSync(join(project,filename),'utf8')).toBe('\ufeffformat_should_not_execute <- 42');
  await run('editor_run_count <- 0');
  await code.click();await code.press('Meta+a');await page.keyboard.insertText('editor_run_count <- editor_run_count + 1\ncat("编辑运行", editor_run_count)');
  await first.getByRole('button',{name:'Run Document',exact:true}).click();await expect(first.locator('#code-status')).toContainText('succeeded');
  expect((await run('editor_run_count')).value).toBe(1);
  await page.getByRole('tab',{name:'Console',exact:true}).click();await expect(consoleFrame.getByRole('textbox',{name:'Console Transcript',exact:true})).toContainText('编辑运行 1');
  await page.getByRole('tab',{name:'Editor',exact:true}).click();await code.click();await code.press('Meta+a');await page.keyboard.insertText('late_format=2');
  let release!:()=>void,observed!:()=>void,held=false;const gate=new Promise<void>(done=>release=done),accepted=new Promise<void>(done=>observed=done);
  await page.route('**/api/plugin-view',async route=>{const body=route.request().postDataJSON()?.message?.body;
    if(!held&&body?.type==='invoke'&&body.capability?.id==='r.format'){held=true;const response=await route.fetch();observed();await gate;await route.fulfill({response});return;}
    await route.continue();});
  try{
    await first.getByRole('button',{name:'Format',exact:true}).click();await accepted;
    await code.click();await code.press('Meta+a');await page.keyboard.insertText('later_edits=99');
    await page.getByRole('tab',{name:'Editor',exact:true}).locator('[data-layout-path$="/button/close"]').click();
    await expect.poll(()=>code.evaluate(()=>document.body.inert)).toBe(true);expect((await query('views.inspect',{view:view.view})).closed).toBe(false);
  }finally{release();}
  await expect(region(view.view)).toHaveCount(0);await page.unroute('**/api/plugin-view');
  const closed=await query('views.inspect',{view:view.view}),reopened=await open(view.configuration,closed.state),second=frame(reopened.view),restored=second.getByRole('textbox',{name:'Code Editor',exact:true});
  await expect(restored).toContainText('later_edits=99');
  await expect(second.getByRole('button',{name:'Compare Formatting',exact:true})).toBeVisible();
  await expect(second.getByRole('button',{name:'Retry Original Request',exact:true})).toBeDisabled();
  await second.getByRole('button',{name:'Compare Formatting',exact:true}).click();
  const dialog=second.getByRole('dialog',{name:'Compare Formatting',exact:true});await expect(dialog.locator('#format-local')).toHaveText('later_edits=99');await expect(dialog.locator('#format-result')).toHaveText('late_format <- 2');
  for(const width of [1440,1920,390,220]){
    await page.setViewportSize({width,height:900});await expect.poll(()=>dialog.evaluate((element,width)=>{
      const rect=element.getBoundingClientRect();return Math.abs(innerWidth-width)<4&&rect.left>=0&&rect.right<=innerWidth;
    },width)).toBe(true);expect(await dialog.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    await page.screenshot({path:info.outputPath(`editor-format-comparison-${width}.png`)});
  }
  await dialog.getByRole('button',{name:'Apply Formatted Text',exact:true}).click();await expect(dialog).toBeHidden();await expect(restored).toContainText('late_format <- 2');
  await restored.click();await restored.press('Meta+z');await expect(restored).toContainText('later_edits=99');
  expect(readFileSync(join(project,filename),'utf8')).toBe('\ufeffformat_should_not_execute <- 42');expect((await run('exists("late_format", envir=.GlobalEnv, inherits=FALSE)')).value).toBe(false);
  for(const width of [1440,1920,390,220]){
    await page.setViewportSize({width,height:900});await expect.poll(()=>restored.evaluate((_element,width)=>Math.abs(innerWidth-width)<4,width)).toBe(true);
    expect(await restored.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await page.screenshot({path:info.outputPath(`editor-code-${width}.png`)});
  }
  await page.setViewportSize({width:1440,height:900});await run('editor_saved_count <- 0');
  const captured='editor_saved_count <- editor_saved_count + 1\ncat("已保存运行", editor_saved_count)',later='later_save_run <- TRUE';
  await restored.click();await restored.press('Meta+a');await page.keyboard.insertText(captured);
  let releaseSave!:()=>void,observeSave!:()=>void,heldSave=false;
  const saveGate=new Promise<void>(done=>releaseSave=done),saveAccepted=new Promise<void>(done=>observeSave=done);
  await page.route('**/api/plugin-view',async route=>{const body=route.request().postDataJSON()?.message?.body;
    if(!heldSave&&body?.type==='invoke'&&body.capability?.id==='files.apply_patch'){
      heldSave=true;const response=await route.fetch();observeSave();await saveGate;await route.fulfill({response});return;
    }await route.continue();});
  try{
    await restored.press('Meta+Shift+Enter');await saveAccepted;
    await restored.click();await restored.press('Meta+a');await page.keyboard.insertText(later);
    expect((await run('editor_saved_count')).value).toBe(0);
  }finally{releaseSave();}
  await expect(second.locator('#code-status')).toContainText('succeeded');await page.unroute('**/api/plugin-view');
  await expect(restored).toContainText(later);await expect(second.locator('#file-state')).toHaveText('Unsaved');
  expect(readFileSync(join(project,filename),'utf8')).toBe('\ufeff'+captured.replaceAll('\n','\r\n'));
  expect((await run('editor_saved_count')).value).toBe(1);expect((await run('exists("later_save_run", envir=.GlobalEnv, inherits=FALSE)')).value).toBe(false);
  await page.getByRole('tab',{name:'Console',exact:true}).click();await expect(consoleFrame.getByRole('textbox',{name:'Console Transcript',exact:true})).toContainText('已保存运行 1');
  await page.getByRole('tab',{name:'Editor',exact:true}).click();await restored.click();await restored.press('Meta+a');await page.keyboard.insertText('must_not_run_after_close <- TRUE');
  let releaseClose!:()=>void,observeClose!:()=>void,heldClose=false;
  const closeGate=new Promise<void>(done=>releaseClose=done),closeAccepted=new Promise<void>(done=>observeClose=done);
  await page.route('**/api/plugin-view',async route=>{const body=route.request().postDataJSON()?.message?.body;
    if(!heldClose&&body?.type==='invoke'&&body.capability?.id==='files.apply_patch'){
      heldClose=true;const response=await route.fetch();observeClose();await closeGate;await route.fulfill({response});return;
    }await route.continue();});
  try{
    await second.getByRole('button',{name:'Save and Run',exact:true}).click();await closeAccepted;
    await page.getByRole('tab',{name:'Editor',exact:true}).locator('[data-layout-path$="/button/close"]').click();
    await expect.poll(()=>restored.evaluate(()=>document.body.inert)).toBe(true);
  }finally{releaseClose();}
  await expect(region(reopened.view)).toHaveCount(0);await page.unroute('**/api/plugin-view');
  const savedClose=await query('views.inspect',{view:reopened.view}),savedReopen=await open(reopened.configuration,savedClose.state),third=frame(savedReopen.view);
  await expect(third.locator('#code-status')).toHaveText('Saved before closing. No R run was submitted. Dismiss this result to run the current document.');
  await expect(third.getByRole('button',{name:'Run Saved Capture',exact:true})).toBeHidden();
  expect((await run('exists("must_not_run_after_close", envir=.GlobalEnv, inherits=FALSE)')).value).toBe(false);
  expect(readFileSync(join(project,filename),'utf8')).toBe('\ufeffmust_not_run_after_close <- TRUE');
  await page.screenshot({path:info.outputPath('editor-saved-run-reopened.png')});
  await third.getByRole('button',{name:'Dismiss Result',exact:true}).click();await expect(third.locator('#code-recovery')).toBeHidden();
  const newView=await open({source:files.identity,file:null,runtime:r.identity,session_selection:true}),newFrame=frame(newView.view),newCode=newFrame.getByRole('textbox',{name:'Code Editor',exact:true});
  await expect(newCode).toBeVisible();await newCode.fill('new_saved_file <- 7');await newFrame.getByRole('button',{name:'Save and Run',exact:true}).click();
  const newDialog=newFrame.getByRole('dialog',{name:'Save and Run',exact:true});await expect(newDialog).toBeVisible();
  await newDialog.getByLabel('Project-relative file path',{exact:true}).fill('created-中文.R');
  for(const width of [390,220]){
    await page.setViewportSize({width,height:900});await expect.poll(()=>newDialog.evaluate((element,width)=>{
      const rect=element.getBoundingClientRect();return Math.abs(innerWidth-width)<4&&rect.left>=0&&rect.right<=innerWidth;
    },width)).toBe(true);await page.screenshot({path:info.outputPath(`editor-save-run-as-${width}.png`)});
  }
  await newDialog.getByRole('button',{name:'Save and Run File',exact:true}).click();await expect(newDialog).toBeHidden();
  await expect(newFrame.locator('#code-status')).toContainText('succeeded');expect(readFileSync(join(project,'created-中文.R'),'utf8')).toBe('new_saved_file <- 7');
  expect((await run('new_saved_file')).value).toBe(7);
  await newFrame.locator('#choose-session').click();const sessions=newFrame.getByRole('dialog',{name:'Run in Session',exact:true});
  await expect(sessions.getByRole('button',{name:'analysis-alt unstarted',exact:true})).toBeVisible();
  for(const width of [1440,1920,390,220]){
    await page.setViewportSize({width,height:900});await expect.poll(()=>sessions.evaluate((element,width)=>{
      const rect=element.getBoundingClientRect();return Math.abs(innerWidth-width)<4&&rect.left>=0&&rect.right<=innerWidth;
    },width)).toBe(true);await page.screenshot({path:info.outputPath(`editor-sessions-${width}.png`)});
  }
  await sessions.getByRole('button',{name:'analysis-alt unstarted',exact:true}).click();await expect(sessions).toBeHidden();
  expect((await native('r.session',{},alternate)).state).toBe('unstarted');
  await newFrame.getByRole('button',{name:'Run Document',exact:true}).click();await expect(newFrame.locator('#error')).toContainText('Start the selected R session');
  expect((await native('r.session',{},alternate)).state).toBe('unstarted');
  const alternateLayout=await query('windows.layout',{window:windowId});
  const alternateConsole=(await invoke('windows.open_view',{expected_layout_version:alternateLayout.version,group:alternateLayout.layout.id,view:{instance:console_.identity,contribution:'console',window:windowId,configuration:{source:alternate.identity},state:{}}})).view;
  await frame(alternateConsole.view).getByRole('button',{name:'Start R',exact:true}).click();await expect.poll(async()=>(await native('r.session',{},alternate)).state,{timeout:60000}).toBe('idle');
  await page.getByRole('tab',{name:'Editor',exact:true}).last().click();await newCode.click();await newCode.press('Meta+a');await page.keyboard.insertText('Sys.sleep(2); isolated_target <- "alternate"');
  await newFrame.getByRole('button',{name:'Run Document',exact:true}).click();
  await newFrame.locator('#choose-session').click();await expect(sessions.getByRole('button',{name:/^r idle/})).toBeVisible();
  await sessions.getByRole('button',{name:/^r idle/}).click();await expect(sessions).toBeHidden();
  await expect(newFrame.locator('#code-status')).toContainText('succeeded');
  expect((await run('isolated_target',alternate)).value).toBe('alternate');expect((await run('exists("isolated_target", envir=.GlobalEnv, inherits=FALSE)')).value).toBe(false);
  await newFrame.locator('#choose-session').click();await sessions.getByRole('button',{name:'analysis-alt idle',exact:true}).click();await expect(sessions).toBeHidden();
  await page.getByRole('tab',{name:'Editor',exact:true}).last().locator('[data-layout-path$="/button/close"]').click();await expect(region(newView.view)).toHaveCount(0);
  const selectionClosed=await query('views.inspect',{view:newView.view}),selectionReopened=await open(newView.configuration,selectionClosed.state),selectedFrame=frame(selectionReopened.view);
  await expect(selectedFrame.getByRole('textbox',{name:'Code Editor',exact:true})).toContainText('isolated_target');
  await selectedFrame.locator('#choose-session').click();await expect(selectedFrame.getByRole('button',{name:'analysis-alt idle · Selected',exact:true})).toBeVisible();
  await selectedFrame.getByRole('button',{name:'Close',exact:true}).click();
  const operations:any[]=[];let cursor:any=null;
  for(let n=0;n<10;n++){const page=await query('operation.list_recent',{limit:100,...(cursor===null?{}:{before_cursor:cursor})});operations.push(...page.operations);cursor=page.next_cursor;if(cursor===null)break;}
  expect(cursor).toBeNull();const editorRuns=operations.filter((op:any)=>op.capability.id==='r.execute'&&op.capability.version===2);
  expect(editorRuns).toHaveLength(4);const originals=await Promise.all(editorRuns.map(op=>port('get_operation',{operation_id:op.operation_id})));
  const originalRun=originals.find(op=>op.operation.normalized_arguments.arguments.run.source.view_id===view.view);
  expect(originalRun.operation.normalized_arguments.arguments.run.source).toEqual({view_id:view.view,label:filename,kind:'document'});
  const savedRun=originals.find(op=>op.operation.normalized_arguments.arguments.run.source.kind==='file'&&op.operation.normalized_arguments.arguments.run.source.label===filename);
  expect(savedRun.operation.normalized_arguments.arguments.run).toEqual({code:captured,source:{view_id:reopened.view,label:filename,kind:'file'},output_mode:'console'});
  const alternateRun=originals.find(op=>op.operation.normalized_arguments.binding.provider.instance===alternate.identity.instance);
  expect(alternateRun.operation.normalized_arguments.arguments.run.code).toBe('Sys.sleep(2); isolated_target <- "alternate"');
  expect(operations.filter((op:any)=>op.capability.id==='r.format')).toHaveLength(3);expect(operations.filter((op:any)=>op.capability.id==='files.apply_patch')).toHaveLength(4);
  expect(errors).toEqual([]);completed=true;
});
