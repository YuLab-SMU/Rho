import { test, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { buildDraftViewFixture } from '../../scripts/fixtures/plugin-draft-view.mjs';

let directory: string, project: string, url: URL, process_: ReturnType<typeof spawn>, installed: any, instance: any, view: any;
let completed=false;
const windowId='draft-browser-window';
async function port(method: string, params: any) {
  const reply=await fetch(new URL('/api/host',url),{method:'POST',headers:{Authorization:`Bearer ${url.hash.slice(7)}`,'Content-Type':'application/json','X-Rho-Studio-Window':windowId},
    body:JSON.stringify({project_root:project,frame:{id:crypto.randomUUID(),request:{method,params}}})}).then(response=>response.json());
  if(!reply.ok)throw new Error(reply.error);return reply.result;
}
async function invoke(id:string,args:any){const record=await port('invoke',{capability:{id,version:1},arguments:args,preconditions:[],client_request_id:crypto.randomUUID()});expect(record.status,JSON.stringify(record.error)).toBe('succeeded');return record.output;}
async function query(id:string,args:any){return(await port('query_snapshot',{capability:{id,version:1},arguments:args})).data;}
test.beforeAll(async()=>{
  test.setTimeout(180000);
  directory=await mkdtemp(join(tmpdir(),'rho-draft-browser-'));project=join(directory,'project');await mkdir(project);project=await realpath(project);
  const database=join(directory,'state.sqlite'),source=buildDraftViewFixture(directory),binary=resolve('../target/debug/rho');
  installed=JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',source,'--target','ui-web'],{encoding:'utf8'})).result;
  process_=spawn(binary,['--database',database,'--project',project,'workbench'],{stdio:['ignore','pipe','pipe']});
  url=new URL(await new Promise<string>((done,reject)=>{
    let output='',errors='';const timer=setTimeout(()=>reject(new Error(`Draft fixture startup timed out: ${errors}`)),90000);
    process_.stderr!.on('data',bytes=>errors+=bytes);process_.stdout!.on('data',bytes=>{output+=bytes;const found=output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-z0-9]+/);if(found){clearTimeout(timer);done(found[0]);}});
    process_.once('exit',code=>{clearTimeout(timer);reject(new Error(`Draft fixture exited ${code}: ${errors}`));});
  }));
  instance=(await invoke('plugins.activate',{revision:installed.revision,artifact:installed.artifacts[0],target:'ui-web',alias:'draft',configuration:{}})).instance;
  view=(await invoke('windows.open_view',{expected_layout_version:0,group:null,view:{instance:instance.identity,contribution:'document',window:windowId,configuration:{},state:{}}})).view;
});
test.afterAll(async()=>{
  if(process_?.exitCode===null){process_.kill('SIGINT');await new Promise<void>(done=>process_.once('exit',()=>done()));}
  if(directory&&completed)await rm(directory,{recursive:true,force:true});else if(directory)console.error(`Draft browser fixture retained at ${directory}`);
});
test('an ordinary view flushes large Unicode content while draining and restores exact bytes in another view',async({page},info)=>{
  test.setTimeout(120000);
  const address=new URL(url);address.searchParams.set('window',windowId);address.searchParams.set('plugin-window','');
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(address.href);
  const region=(id:string)=>page.locator(`[data-plugin-frame="${id}"]`),frame=region(view.view).frameLocator('iframe');
  await expect(frame.getByRole('status')).toHaveText('Ready');
  const text='\ufeff'+('保留草稿 α🙂'.repeat(30)+'\n').repeat(1000),input=frame.getByLabel('Draft text');
  await input.fill('Editable 草稿');
  // Seed bulk fixture content without a giant automation Fill/trace payload.
  // Storage still uses only the actual view's public SDK and close handler.
  await input.evaluate((element,text)=>{(element as HTMLTextAreaElement).value=text;},text);
  expect(Buffer.byteLength(JSON.stringify({text}))).toBeGreaterThan(512*1024);
  const release=await port('invoke',{capability:{id:'plugins.release',version:1},arguments:{instance:instance.identity},preconditions:[],client_request_id:crypto.randomUUID()});
  expect(release.status).not.toBe('succeeded');expect((await query('plugins.instance',{instance:instance.identity})).instance.state).toBe('draining');
  let releaseReceipt!:()=>void,sawReceipt!:()=>void,held=false;
  const receiptGate=new Promise<void>(resolve=>releaseReceipt=resolve),observedReceipt=new Promise<void>(resolve=>sawReceipt=resolve);
  await page.route('**/api/plugin-view',async route=>{
    const body=route.request().postDataJSON()?.message?.body;
    if(!held&&body?.type==='get_operation'){
      const response=await route.fetch(),reply=await response.json();
      if(reply.ok&&reply.result?.status==='succeeded'){held=true;sawReceipt();await receiptGate;await route.fulfill({response});return;}
      await route.fulfill({response});return;
    }
    await route.continue();
  });
  try{
    await page.getByRole('tab',{name:'Draft',exact:true}).locator('[data-layout-path$="/button/close"]').click();
    await observedReceipt;
    expect((await query('views.inspect',{view:view.view})).closed).toBe(false);
    expect(await input.evaluate(()=>document.body.inert)).toBe(true);
    expect(await input.inputValue()).toBe(text);
    await page.screenshot({path:info.outputPath('large-draft-awaiting-original-receipt.png')});
  }finally{releaseReceipt();}
  await expect(region(view.view)).toHaveCount(0);await page.unroute('**/api/plugin-view');
  const closed=await query('views.inspect',{view:view.view});expect(closed.closed).toBe(true);expect(closed.state.pending).toBeNull();
  expect(Buffer.byteLength(JSON.stringify(closed.state))).toBeLessThan(32768);
  const record=await query('documents.inspect',{window:windowId,draft:closed.state.draft.draft});
  const expected=Buffer.from(JSON.stringify({text}));expect(record.content.bytes).toBe(expected.length);
  expect(record.content.digest).toBe(`sha256:${createHash('sha256').update(expected).digest('hex')}`);
  await invoke('plugins.release',{instance:instance.identity});
  const reopened=(await invoke('plugins.activate',{revision:installed.revision,artifact:installed.artifacts[0],target:'ui-web',alias:'reopened',configuration:{}})).instance;
  const layout=await query('windows.layout',{window:windowId});
  const next=(await invoke('windows.open_view',{expected_layout_version:layout.version,group:layout.layout.kind==='tabs'?layout.layout.id:null,
    view:{instance:reopened.identity,contribution:'document',window:windowId,configuration:{},state:closed.state}})).view;
  const restored=region(next.view).frameLocator('iframe');await expect(restored.getByRole('status')).toHaveText('Ready');
  expect(await restored.getByLabel('Draft text').inputValue()).toBe(text);
  await page.screenshot({path:info.outputPath('large-draft-restored.png')});
  await page.getByRole('tab',{name:'Draft',exact:true}).locator('[data-layout-path$="/button/close"]').click();await expect(region(next.view)).toHaveCount(0);
  const final=await query('documents.inspect',{window:windowId,draft:record.draft});expect(final.version).toBe(2);expect(final.content.digest).toBe(record.content.digest);
  await invoke('plugins.release',{instance:reopened.identity});
  await invoke('documents.discard',{window:windowId,draft:record.draft,source:record.source,expected_version:final.version});
  await invoke('plugins.remove',{revision:installed.revision});
  const saves=(await query('operation.list_recent',{limit:100})).operations.filter((operation:any)=>operation.capability.id==='documents.save');expect(saves).toHaveLength(2);
  expect(errors).toEqual([]);completed=true;
});
