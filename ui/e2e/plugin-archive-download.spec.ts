import {test,expect} from '@playwright/test';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,realpath,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {buildArchiveDownloadUiFixture} from '../../scripts/fixtures/plugin-archive-download.mjs';
let directory:string,project:string,url:URL,host:ReturnType<typeof spawn>,view:any,instance:any,receipt:any,completed=false;
const windowId='archive-download';
async function port(method:string,params:any){
 const reply=await fetch(new URL('/api/host',url),{method:'POST',headers:{Authorization:`Bearer ${url.hash.slice(7)}`,'Content-Type':'application/json','X-Rho-Studio-Window':windowId},body:JSON.stringify({project_root:project,frame:{id:crypto.randomUUID(),request:{method,params}}})}).then(r=>r.json());
 if(!reply.ok)throw Error(reply.error);return reply.result;
}
async function invoke(id:string,args:any){const record=await port('invoke',{capability:{id,version:1},arguments:args,preconditions:[],client_request_id:crypto.randomUUID()});expect(record.status,record.error).toBe('succeeded');return record.output;}
async function query(id:string,args:any){return(await port('query_snapshot',{capability:{id,version:1},arguments:args})).data;}
test.beforeAll(async()=>{
 directory=await mkdtemp(join(tmpdir(),'rho-archive-download-'));project=join(directory,'project');await mkdir(project);project=await realpath(project);
 const binary=resolve('../target/debug/rho'),database=join(directory,'state.sqlite');
 const pkg=JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',buildArchiveDownloadUiFixture(directory)],{encoding:'utf8'})).result;
 host=spawn(binary,['--database',database,'--project',project,'--plugins-only','workbench'],{stdio:['ignore','pipe','pipe']});
 url=new URL(await new Promise<string>((done,reject)=>{let text='',errors='';const timer=setTimeout(()=>reject(Error(`Archive Host startup timed out: ${errors}`)),40000);
  host.stderr!.on('data',data=>errors+=data);host.stdout!.on('data',data=>{text+=data;const found=text.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);if(found){clearTimeout(timer);done(found[0]);}});host.once('exit',code=>{clearTimeout(timer);reject(Error(`Archive Host exited ${code}: ${errors}`));});}));
 receipt=await invoke('plugins.archive_export',{revision:pkg.revision,artifacts:[]});
 instance=(await invoke('plugins.activate',{revision:pkg.revision,artifact:pkg.artifacts[0],target:'ui-web',alias:'archive',configuration:{}})).instance.identity;
 view=await invoke('views.open',{instance,window:windowId,contribution:'view',configuration:{archive_reference:receipt.reference},state:{text:'Original draft 中文'}});
});
test.afterAll(async()=>{if(host?.exitCode===null){host.kill('SIGINT');await new Promise<void>(done=>host.once('exit',()=>done()));}if(completed)await rm(directory,{recursive:true,force:true});else if(directory)console.error(`Archive download fixture retained at ${directory}`);});
test('ordinary archive downloads require an explicit gesture, verify full bytes and stop before a closed view can download',async({page,context},info)=>{
 const address=new URL(url);address.searchParams.set('window',windowId);address.searchParams.set('plugin-view',view.view);
 const downloads:string[]=[];page.on('download',item=>downloads.push(item.suggestedFilename()));await page.goto(address.href);
 const frame=page.frameLocator('iframe');await expect(frame.locator('#automatic-archive')).toContainText('explicit Download action');expect(downloads).toEqual([]);
 const before=await query('operation.list_recent',{limit:100}),pending=page.waitForEvent('download');
 await frame.getByRole('button',{name:'Download archive',exact:true}).click();const download=await pending;
 expect(download.suggestedFilename()).toBe('源码与视图 Ω.rho-plugin');await download.saveAs(info.outputPath('source.rho-plugin'));expect(await download.failure()).toBeNull();
 const bytes=await readFile(info.outputPath('source.rho-plugin'));expect(bytes.length).toBe(receipt.reference.bytes);expect('sha256:'+createHash('sha256').update(bytes).digest('hex')).toBe(receipt.reference.digest);
 const archive=JSON.parse(bytes.toString());expect(archive.revision.id).toBe(receipt.revision);expect(archive.artifacts).toEqual([]);
 await expect(frame.locator('#archive-download-result')).toHaveText('Archive download requested');expect(await query('operation.list_recent',{limit:100})).toEqual(before);expect(context.pages()).toHaveLength(1);
 await frame.getByRole('button',{name:'Try foreign archive',exact:true}).click();
 await expect(frame.locator('#archive-download-result')).toHaveAttribute('data-status','error');
 await expect(frame.locator('#archive-download-result')).toContainText(/archive|not found|missing/i);expect(downloads).toEqual(['源码与视图 Ω.rho-plugin']);
 let release!:()=>void,sawRead!:()=>void,held=false;const gate=new Promise<void>(done=>release=done),observed=new Promise<void>(done=>sawRead=done);
 await page.route('**/api/plugin-view',async route=>{const body=route.request().postDataJSON()?.message?.body;
  if(!held&&body?.type==='query'&&body.capability?.id==='plugins.archive_read'){held=true;const response=await route.fetch();sawRead();await gate;await route.fulfill({response});}else await route.continue();});
 await frame.getByRole('button',{name:'Download archive',exact:true}).click();await observed;
 try{await invoke('views.close',{view:view.view,mode:{kind:'flush'}});expect((await query('views.inspect',{view:view.view})).closed).toBe(true);}finally{release();}
 await expect(frame.locator('#archive-download-result')).toContainText(/closed|closure|view connection|unavailable/i);expect(downloads).toEqual(['源码与视图 Ω.rho-plugin']);
 expect((await query('plugins.instance',{instance})).instance.state).toBe('active');await invoke('plugins.release',{instance});completed=true;
});
