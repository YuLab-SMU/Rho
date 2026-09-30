import {test,expect} from '@playwright/test';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,realpath,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {buildVisualSciencePlugin} from '../../scripts/fixtures/visual-science-plugin.mjs';
let directory:string,project:string,url:URL,host:ReturnType<typeof spawn>,view:any,instance:any,files:any,completed=false,core:string;
const binary=resolve('../target/debug/rho'),windowId='visual-science-window';
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
async function port(method:string,params:any){const response=await fetch(new URL('/api/host',url),{method:'POST',headers:{Authorization:`Bearer ${url.hash.slice(7)}`,'Content-Type':'application/json','X-Rho-Studio-Window':windowId},body:JSON.stringify({project_root:project,frame:{id:crypto.randomUUID(),request:{method,params}}})}).then(r=>r.json());if(!response.ok)throw Error(response.error);return response.result;}
async function query(id:string,args:any){return(await port('query_snapshot',{capability:{id,version:1},arguments:args})).data;}
async function invoke(id:string,args:any){const result=await port('invoke',{capability:{id,version:1},arguments:args,client_request_id:crypto.randomUUID(),preconditions:[]});expect(result.status,result.error).toBe('succeeded');return result.output;}
test.beforeAll(async()=>{
 const archive=process.env.RHO_FILES_PLUGIN_ARCHIVE;if(!archive)throw Error('Set RHO_FILES_PLUGIN_ARCHIVE to an accepted Files archive; this test does not rebuild native plugins.');
 directory=await mkdtemp(join(tmpdir(),'rho-visual-science-'));project=join(directory,'project');await mkdir(project);project=await realpath(project);core=hash(await readFile(binary));
 await writeFile(join(project,'analysis.R'),'x <- 1\n');execFileSync('git',['init','-q',project]);
 const database=join(directory,'state.sqlite'),retained=JSON.parse(execFileSync(binary,['--database',database,'plugins','import',resolve(archive)],{encoding:'utf8'})).result;
 host=spawn(binary,['--database',database,'--project',project,'workbench'],{stdio:['ignore','pipe','pipe']});
 url=new URL(await new Promise<string>((done,reject)=>{let out='',errors='';const timer=setTimeout(()=>reject(Error(`Host startup timed out: ${errors}`)),30000);host.stderr!.on('data',b=>errors+=b);host.stdout!.on('data',b=>{out+=b;const found=out.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);if(found){clearTimeout(timer);done(found[0]);}});host.once('exit',code=>{clearTimeout(timer);reject(Error(`Host exited ${code}: ${errors}`));});}));
 const inspected=await query('plugins.inspect',{revision:retained.revision});expect(inspected.summary.plugin).toBe('org.rho.files');
 files=(await invoke('plugins.activate',{revision:retained.revision,artifact:inspected.artifacts[0].id,target:'aarch64-apple-darwin',alias:'files',configuration:{}})).instance.identity;
 const paths=await query('workspace.paths',{});expect(paths.project_root).toBe(project);
 const binding=async(id:string)=>({...await query('plugins.resolve',{instance:files,capability:{id,version:1}}),target:paths.project_root});
 const readBinding=await binding('files.read_text'),observed=await query('files.read_text',{binding:readBinding,arguments:{path:'analysis.R'}});expect(observed.file.path).toBe('analysis.R');
 const node=(kind:string)=>({kind,children:[],properties:{},style_tokens:{},bindings:{},visible_when:null,events:{},component:null});
 const write={binding:await binding('files.apply_patch'),arguments:{patch:'diff --git a/analysis.R b/analysis.R\n--- a/analysis.R\n+++ b/analysis.R\n@@ -1 +1 @@\n-x <- 1\n+x <- 2\n'},preconditions:[{kind:'file.sha256',subject:'analysis.R',expected:observed.file.sha256}]};
 const declaration={format_version:1,root:'root',nodes:{root:{...node('container'),children:['content','run']},content:{...node('text'),bindings:{text:{source:'file',path:['data','fragments','0','text']}}},run:{...node('button'),properties:{text:'Apply declared patch'},events:{click:[{kind:'invoke',capability:{id:'files.apply_patch',version:1},arguments:write}]}}},data_sources:{file:{capability:{id:'files.read_text',version:1},arguments:{binding:readBinding,arguments:{path:'analysis.R',expected_sha256:null,start_line:1,limit_lines:10,continuation:null}},subscribe:true}},components:{}};
 const source=buildVisualSciencePlugin(directory,declaration),subject=JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',source,'--target','ui-web'],{encoding:'utf8'})).result;
 instance=(await invoke('plugins.activate',{revision:subject.revision,artifact:subject.artifacts[0],target:'ui-web',alias:'declarative-files',configuration:{}})).instance.identity;
 view=(await invoke('windows.open_view',{expected_layout_version:0,group:null,view:{instance,window:windowId,contribution:'report',configuration:{},state:{}}})).view;
});
test.afterAll(async()=>{if(host?.exitCode===null){host.kill('SIGINT');await new Promise<void>(done=>host.once('exit',()=>done()));}if(directory&&completed)await rm(directory,{recursive:true,force:true});else if(directory)console.error(`Visual science fixture retained at ${directory}`);});
test('declarative view observes real Files and recovers its original scientific operation without replay',async({page},info)=>{
 const requests:any[]=[];page.on('request',request=>{if(request.url().endsWith('/api/plugin-view'))requests.push(request.postDataJSON()?.message);});
 let lost=false,holdRead=false,releaseRead!:()=>void,seenRead!:()=>void;const readHeld=new Promise<void>(done=>seenRead=done),readReleased=new Promise<void>(done=>releaseRead=done);
 await page.route('**/api/plugin-view',async route=>{const message=route.request().postDataJSON()?.message,body=message?.body;
  if(!lost&&body?.type==='invoke'&&body.capability.id==='files.apply_patch'){lost=true;const response=await route.fetch(),reply=await response.json();expect(reply.ok,reply.error).toBe(true);await route.fulfill({response,json:{...reply,ok:false,error:'Fixture lost the original scientific acknowledgement'}});}
  else if(holdRead&&body?.type==='query'&&body.capability.id==='files.read_text'){holdRead=false;const response=await route.fetch();seenRead();await readReleased;await route.fulfill({response});}
  else await route.continue();
 });
 const address=new URL(url);address.searchParams.set('window',windowId);await page.goto(address.href);
 const frame=page.locator(`[data-plugin-frame="${view.view}"]`).frameLocator('iframe');
 await expect(frame.locator('[data-visual-node=content]')).toHaveText('x <- 1');
 await expect.poll(()=>requests.filter(r=>r?.body?.capability?.id==='files.read_text').length).toBeGreaterThan(1);
 expect(requests.filter(r=>r?.body?.type==='invoke'&&r?.body?.capability?.id==='files.apply_patch')).toHaveLength(0);
 await frame.getByRole('button',{name:'Apply declared patch',exact:true}).click();await expect(frame.getByRole('alert')).toContainText('original scientific acknowledgement');
 await expect(frame.locator('[data-visual-node=content]')).toHaveText('x <- 2');expect(await readFile(join(project,'analysis.R'),'utf8')).toBe('x <- 2\n');
 const pending=(await query('views.inspect',{view:view.view})).state.intent;expect(pending.operation).toBe(null);expect(pending.arguments.binding.provider).toEqual(files);expect(pending.arguments.binding.target).toBe(project);
 await frame.getByRole('button',{name:'Apply declared patch',exact:true}).click();await expect(frame.getByRole('alert')).toContainText('cannot be sent again');
 await page.reload();await expect(frame.locator('#receipt')).toHaveText('Original request unconfirmed');await expect(frame.locator('[data-visual-node=content]')).toHaveText('x <- 2');
 await frame.getByRole('button',{name:'Inspect original operation',exact:true}).click();await expect(frame.locator('#receipt')).toContainText('succeeded / ');
 const saved=(await query('views.inspect',{view:view.view})).state,record=(await query('operation.get',{operation_id:saved.intent.operation})).record;
 expect(record.operation.caller.id).toBe(view.view);expect(record.operation.normalized_arguments).toEqual(pending.arguments);expect(record.operation.normalized_arguments.binding.target).toBe(project);expect(record.output.changed_paths).toEqual(['analysis.R']);
 const scoped='sha256:'+hash(`${pending.view}:${pending.request}`);expect(record.operation.client_request_id).toBe(scoped);expect((await query('operation.list_recent',{client_request_id:scoped,limit:10})).operations).toHaveLength(1);
 holdRead=true;await readHeld;await frame.getByRole('button',{name:'Stop observing',exact:true}).click();releaseRead();await expect(frame.locator('#report')).toBeEmpty();
 const readCount=requests.filter(r=>r?.body?.capability?.id==='files.read_text').length;
 // A bounded quiet interval spans two polling periods and the held reply's release.
 await page.waitForTimeout(450);expect(requests.filter(r=>r?.body?.capability?.id==='files.read_text')).toHaveLength(readCount);
 const layout=await query('windows.layout',{window:windowId});const replacement=(await invoke('windows.open_view',{expected_layout_version:layout.version,group:layout.layout.id,view:{instance,window:windowId,contribution:'report',configuration:{},state:saved}})).view;
 const reopened=page.locator(`[data-plugin-frame="${replacement.view}"]`).frameLocator('iframe');await expect(reopened.locator('[data-visual-node=content]')).toHaveText('x <- 2');
 await reopened.getByRole('button',{name:'Inspect original operation',exact:true}).click();await expect.poll(async()=>(await query('views.inspect',{view:replacement.view})).state_version).toBeGreaterThan(0);await expect(reopened.locator('#receipt')).toContainText(saved.intent.operation);
 expect(requests.filter(r=>r?.body?.type==='invoke'&&r?.body?.capability?.id==='files.apply_patch')).toHaveLength(1);expect(requests.some(r=>r?.view===replacement.view&&r?.body?.type==='query'&&r.body.capability.id==='operation.get')).toBe(true);
 expect(await readFile(join(project,'analysis.R'),'utf8')).toBe('x <- 2\n');expect(hash(await readFile(binary))).toBe(core);expect(lost).toBe(true);
 await page.screenshot({path:info.outputPath('declarative-files-recovery.png')});
 await writeFile(info.outputPath('result.json'),JSON.stringify({core_sha256:core,files,view:view.view,replacement:replacement.view,operation:saved.intent.operation,scoped_request:scoped,checks:['Actual Files read through captured provider/target; periodic snapshots update rendered declaration','One explicit declared native patch; write intent persisted before dispatch','Lost acknowledgement leaves native result observable and original request unconfirmed','Duplicate gesture and reload do not re-invoke; explicit recovery verifies original record','Replacement view inspects original caller through public operation.get without replay','Disposal stops polling and ignores held late read; core bytes unchanged'],limits:['Snapshot polling, not native event streaming','Native Files operation, not R execution or Host restart']},null,2)+'\n');completed=true;
});
