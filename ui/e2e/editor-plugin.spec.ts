/** Independent Editor UI and native Files backend through the generic window. */
import { test, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
let directory: string, project: string, url: URL, process_: ReturnType<typeof spawn>, view: any, files: any, editor: any;
let completed=false;
const windowId='editor-independent-window',binary=resolve('../target/debug/rho'),filename='分析与后续编辑的文件.R';
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
  const filesPath=process.env.RHO_FILES_PLUGIN_PACKAGE??join(directory,'files'),editorPath=process.env.RHO_EDITOR_PLUGIN_PACKAGE??join(directory,'editor');
  if(!process.env.RHO_FILES_PLUGIN_PACKAGE)execFileSync(process.execPath,[resolve('../scripts/build-files-plugin.mjs'),filesPath],{stdio:'inherit'});
  if(!process.env.RHO_EDITOR_PLUGIN_PACKAGE)execFileSync(process.execPath,[resolve('../scripts/build-editor-plugin.mjs'),editorPath],{stdio:'inherit'});
  expect(hash(readFileSync(binary))).toBe(before);
  const database=join(directory,'state.sqlite'),snapshot=(path:string,target:string)=>JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',path,'--target',target],{encoding:'utf8'})).result;
  const filesPackage=snapshot(filesPath,'aarch64-apple-darwin'),editorPackage=snapshot(editorPath,'aarch64-apple-darwin');
  process_=spawn(binary,['--database',database,'--project',project,'workbench'],{stdio:['ignore','pipe','pipe']});
  url=new URL(await new Promise<string>((done,reject)=>{let output='',errors='';const timer=setTimeout(()=>reject(new Error(`Editor Host startup timed out: ${errors}`)),90000);
    process_.stderr!.on('data',bytes=>errors+=bytes);process_.stdout!.on('data',bytes=>{output+=bytes;const found=output.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);if(found){clearTimeout(timer);done(found[0]);}});
    process_.once('exit',code=>{clearTimeout(timer);reject(new Error(`Editor Host exited ${code}: ${errors}`));});}));
  files=(await invoke('plugins.activate',{revision:filesPackage.revision,artifact:filesPackage.artifacts[0],target:'aarch64-apple-darwin',alias:'files',configuration:{}})).instance;
  editor=(await invoke('plugins.activate',{revision:editorPackage.revision,artifact:editorPackage.artifacts[0],target:'aarch64-apple-darwin',alias:'editor',configuration:{}})).instance;
  view=await open({source:files.identity,file:await capture(filename)});
});
test.afterAll(async()=>{
  if(process_?.exitCode===null){process_.kill('SIGINT');await new Promise<void>(done=>process_.once('exit',()=>done()));}
  if(directory&&completed)rmSync(directory,{recursive:true,force:true});else if(directory)console.error(`Editor native fixture retained at ${directory}`);
});
test('Editor preserves later edits across a native save and close, restores original outcomes, and saves exact bytes',async({page},info)=>{
  test.setTimeout(180000);const address=new URL(url);address.searchParams.set('window',windowId);address.searchParams.set('plugin-window','');
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(address.href);
  const region=(id:string)=>page.locator(`[data-plugin-frame="${id}"]`),frame=(id:string)=>region(id).frameLocator('iframe');
  const first=frame(view.view),code=first.getByRole('textbox',{name:'Code Editor',exact:true});await expect(code).toBeVisible();
  await expect(first.locator('#file-state')).toHaveText('Saved');
  await first.getByRole('button',{name:'Editor Settings',exact:true}).click();
  const settings=first.getByRole('dialog',{name:'Editor Settings',exact:true});await expect(settings).toBeVisible();
  await settings.getByLabel('Code Font Size',{exact:true}).selectOption('18');await settings.getByLabel('Indent Width',{exact:true}).selectOption('2');
  for(const width of [1440,1920,390,220]){
    await page.setViewportSize({width,height:900});await expect.poll(()=>settings.evaluate((element,width)=>{
      const rect=element.getBoundingClientRect();return Math.abs(innerWidth-width)<4&&rect.left>=0&&rect.right<=innerWidth;
    },width)).toBe(true);await page.screenshot({path:info.outputPath(`editor-settings-${width}.png`)});
  }
  await settings.getByRole('button',{name:'Apply Settings',exact:true}).click();await expect(settings).toBeHidden();
  await expect.poll(()=>code.evaluate(element=>getComputedStyle(element.closest('.cm-editor')!).fontSize)).toBe('18px');
  await expect(first.locator('#file-state')).toHaveText('Saved');
  // This ordinary native context owner sees only acknowledged draft captures.
  await expect.poll(async()=>(await contextSearch(filename)).items.length).toBe(1);
  const originalContext=(await contextSearch(filename)).items[0].reference;
  expect((await contextPreview(originalContext)).text).toBe('x <- 1\n# 说明 中文\n');
  expect((await contextPreview(originalContext,'selection')).text).toBe('');
  await code.click();await code.press('Meta+a');await page.keyboard.insertText('indent_probe');await code.press('Tab');await expect.poll(()=>first.locator('.cm-line').first().textContent()).toBe('  indent_probe');
  await code.press('Meta+z');await expect(code).toHaveText('indent_probe');
  for(const width of [1440,1920,390,220]){
    await page.setViewportSize({width,height:900});await code.click();await expect(code).toBeFocused();
    expect(await code.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    await page.screenshot({path:info.outputPath(`editor-${width}.png`)});
  }
  await page.setViewportSize({width:1440,height:900});await code.click();await code.press('Meta+a');await page.keyboard.insertText('x <- 2\n# captured 中文\n');
  let release!:()=>void,observed!:()=>void,held=false;
  const gate=new Promise<void>(done=>release=done),accepted=new Promise<void>(done=>observed=done);
  await page.route('**/api/plugin-view',async route=>{const body=route.request().postDataJSON()?.message?.body;
    if(!held&&body?.type==='invoke'&&body.capability?.id==='files.apply_patch'){held=true;const response=await route.fetch();observed();await gate;await route.fulfill({response});return;}
    await route.continue();});
  try{
    await first.getByRole('button',{name:'Save',exact:true}).click();await accepted;
    await code.click();await code.press('Meta+a');await page.keyboard.insertText('x <- 3\n# later 编辑\n');
    await page.getByRole('tab',{name:'Editor',exact:true}).locator('[data-layout-path$="/button/close"]').click();
    await expect.poll(()=>code.evaluate(()=>document.body.inert)).toBe(true);
    expect((await query('views.inspect',{view:view.view})).closed).toBe(false);
  }finally{release();}
  await expect(region(view.view)).toHaveCount(0);await page.unroute('**/api/plugin-view');
  expect(readFileSync(join(project,filename),'utf8')).toBe('\ufeffx <- 2\r\n# captured 中文\r\n');
  const closed=await query('views.inspect',{view:view.view});expect(closed.state.pending).toBeNull();
  await expect(contextPreview(originalContext)).rejects.toThrow(/changed/i);
  const synchronized=(await contextSearch(filename)).items[0];
  const unsavedContext=await contextPreview(synchronized.reference);
  expect(unsavedContext.text).toBe('x <- 3\n# later 编辑\n');
  expect(unsavedContext.data.synchronized).toBe(true);expect(unsavedContext.resources).toEqual([]);
  expect(JSON.stringify(unsavedContext)).not.toContain('fileRun');
  // The disk still contains the earlier capture; context reads never save it.
  expect(readFileSync(join(project,filename),'utf8')).toBe('\ufeffx <- 2\r\n# captured 中文\r\n');
  expect(Buffer.byteLength(JSON.stringify(closed.state))).toBeLessThan(32768);
  const secondView=await open(view.configuration,closed.state),second=frame(secondView.view),restored=second.getByRole('textbox',{name:'Code Editor',exact:true});
  await expect(restored).toBeVisible();await expect(restored).toContainText('later 编辑');await expect(second.locator('#file-state')).toHaveText('Unsaved');
  await expect.poll(()=>restored.evaluate(element=>getComputedStyle(element.closest('.cm-editor')!).fontSize)).toBe('18px');await expect(second.locator('#position')).toContainText('2 spaces');
  await expect(second.locator('#file-recovery')).toBeHidden();
  await second.getByRole('button',{name:'Save',exact:true}).click();await expect(second.locator('#file-state')).toHaveText('Saved');
  const expected='\ufeffx <- 3\r\n# later 编辑\r\n';expect(readFileSync(join(project,filename),'utf8')).toBe(expected);
  await page.setViewportSize({width:390,height:900});await second.getByRole('button',{name:'Save As…',exact:true}).click();
  const dialog=second.getByRole('dialog');await expect(dialog).toBeVisible();await dialog.getByLabel('Project-relative file path').fill('复制 α.R');
  await page.screenshot({path:info.outputPath('editor-save-as-390.png')});await dialog.getByRole('button',{name:'Save File',exact:true}).click();
  await expect(dialog).toBeHidden();await expect(second.locator('#file-state')).toHaveText('Saved');expect(readFileSync(join(project,'复制 α.R'),'utf8')).toBe(expected);
  await restored.click();await restored.press('Meta+a');await page.keyboard.insertText('# local edits 中文\n');
  writeFileSync(join(project,'复制 α.R'),'# disk version one\n');await second.getByRole('button',{name:'Compare Disk',exact:true}).click();
  const comparison=second.getByRole('dialog',{name:'Compare Disk',exact:true});await expect(comparison).toBeVisible();
  await expect(comparison.locator('#disk-local')).toContainText('local edits 中文');await expect(comparison.locator('#disk-observed')).toContainText('disk version one');
  await expect(comparison.getByRole('button',{name:'Keep My Edits',exact:true})).toBeEnabled();
  for(const width of [1440,1920,390,220]){
    await page.setViewportSize({width,height:900});
    await expect.poll(()=>comparison.evaluate((element,width)=>{
      const rect=element.getBoundingClientRect();return Math.abs(innerWidth-width)<4&&rect.left>=0&&rect.right<=innerWidth;
    },width)).toBe(true);
    expect(await comparison.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    await page.screenshot({path:info.outputPath(`editor-disk-comparison-${width}.png`)});
  }
  await page.setViewportSize({width:390,height:900});
  writeFileSync(join(project,'复制 α.R'),'# disk version two\n');await comparison.getByRole('button',{name:'Keep My Edits',exact:true}).click();
  await expect(comparison.getByRole('alert')).toContainText('changed again');await comparison.getByRole('button',{name:'Refresh Comparison',exact:true}).click();
  await expect(comparison.locator('#disk-observed')).toContainText('disk version two');await comparison.getByRole('button',{name:'Keep My Edits',exact:true}).click();
  await expect(comparison).toBeHidden();await expect(restored).toContainText('local edits 中文');await expect(second.locator('#file-state')).toHaveText('Unsaved');
  expect(readFileSync(join(project,'复制 α.R'),'utf8')).toBe('# disk version two\n');
  await second.getByRole('button',{name:'Save',exact:true}).click();await expect(second.locator('#file-state')).toHaveText('Saved');
  expect(readFileSync(join(project,'复制 α.R'),'utf8')).toBe('\ufeff# local edits 中文\r\n');
  const diskExact='\ufeff# explicit disk replacement\r\nx <- 4\n';writeFileSync(join(project,'复制 α.R'),diskExact);
  await second.getByRole('button',{name:'Compare Disk',exact:true}).click();await comparison.getByRole('button',{name:'Use Disk Content',exact:true}).click();
  await expect(comparison).toBeHidden();await expect(restored).toContainText('explicit disk replacement');await expect(second.locator('#file-state')).toHaveText('Saved');
  await restored.click();await restored.press('Meta+z');await expect(restored).toContainText('local edits 中文');await expect(second.locator('#file-state')).toHaveText('Unsaved');
  expect(readFileSync(join(project,'复制 α.R'),'utf8')).toBe(diskExact);
  let lostDraftReply=false;
  await page.route('**/api/plugin-view',async route=>{
    const body=route.request().postDataJSON()?.message?.body;
    if(!lostDraftReply&&body?.type==='invoke'&&body.capability?.id==='documents.save'){
      // Keep the channel alive while withholding this original admission reply.
      // A transport abort correctly removes the frame and exercises reconnect,
      // not the retained dialog's acknowledgement-error controls.
      lostDraftReply=true;await route.fetch();await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:false,error:'Original draft acknowledgement unavailable (fixture)'})});return;
    }
    await route.continue();
  });
  await second.getByRole('button',{name:'Compare Disk',exact:true}).click();await expect(comparison).toBeVisible();
  await expect(comparison.getByRole('alert')).toBeVisible();await expect(comparison.getByRole('button',{name:'Close',exact:true})).toBeEnabled();
  await comparison.getByRole('button',{name:'Close',exact:true}).click();await expect(comparison).toBeHidden();
  expect(lostDraftReply).toBe(true);await page.unroute('**/api/plugin-view');
  await second.getByRole('button',{name:'Inspect Original Draft Save',exact:true}).click();await expect(second.locator('#recovery')).toBeHidden();
  await expect(restored).toContainText('local edits 中文');expect(readFileSync(join(project,'复制 α.R'),'utf8')).toBe(diskExact);
  await page.getByRole('tab',{name:'Editor',exact:true}).locator('[data-layout-path$="/button/close"]').click();await expect(region(secondView.view)).toHaveCount(0);
  // Load a genuine editable file whose body plus base exceeds view-state quota.
  const large='\ufeff'+('x <- "中文🙂"; '.repeat(25)+'\r\n').repeat(700);expect(Buffer.byteLength(large)).toBeGreaterThan(256*1024);expect(Buffer.byteLength(large)).toBeLessThan(512*1024);
  writeFileSync(join(project,'large.R'),large);const largeView=await open({source:files.identity,file:await capture('large.R')});
  const largeFrame=frame(largeView.view);await expect(largeFrame.getByRole('textbox',{name:'Code Editor'})).toBeVisible();
  await page.getByRole('tab',{name:'Editor',exact:true}).locator('[data-layout-path$="/button/close"]').click();await expect(region(largeView.view)).toHaveCount(0);
  const retained=await query('views.inspect',{view:largeView.view});expect(retained.state.draft.content.bytes).toBeGreaterThan(512*1024);
  const largeContext=(await contextSearch('large.R')).items[0];
  const bounded=await contextPreview(largeContext.reference,'document',31);
  expect(bounded.truncated).toBe(true);expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(31);
  expect(bounded.text).not.toContain('�');
  const reloaded=await open(largeView.configuration,retained.state);await expect(frame(reloaded.view).getByRole('textbox',{name:'Code Editor'})).toBeVisible();
  await expect(frame(reloaded.view).locator('#file-state')).toHaveText('Saved');await page.setViewportSize({width:1920,height:900});
  await page.screenshot({path:info.outputPath('editor-large-restored-1920.png')});
  await page.getByRole('tab',{name:'Editor',exact:true}).locator('[data-layout-path$="/button/close"]').click();await expect(region(reloaded.view)).toHaveCount(0);
  expect(readFileSync(join(project,'large.R'),'utf8')).toBe(large);
  const operations:any[]=[];let cursor:any=null;
  for(let page=0;page<10;page++){const found=await query('operation.list_recent',{limit:100,...(cursor===null?{}:{before_cursor:cursor})});operations.push(...found.operations);cursor=found.next_cursor;if(cursor===null)break;}
  expect(cursor).toBeNull();
  expect(operations.filter((operation:any)=>operation.capability.id==='files.apply_patch')).toHaveLength(4);
  expect(operations.filter((operation:any)=>['r.execute','workspace.run_r'].includes(operation.capability.id))).toHaveLength(0);
  expect(errors).toEqual([]);completed=true;
});
