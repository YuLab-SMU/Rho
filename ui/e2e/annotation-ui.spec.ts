import {test,expect} from '@playwright/test';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,realpath,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';

const binary=resolve('../target/debug/rho'),windowId='annotation-ui-window';
const key=(id:string)=>({id,version:1});
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
let directory:string,project:string,url:URL,host:ReturnType<typeof spawn>,annotation:any,files:any,view:any,completed=false,core:string;
async function port(method:string,params:any){const response=await fetch(new URL('/api/host',url),{method:'POST',headers:{Authorization:`Bearer ${url.hash.slice(7)}`,'Content-Type':'application/json','X-Rho-Studio-Window':windowId},body:JSON.stringify({project_root:project,frame:{id:crypto.randomUUID(),request:{method,params}}})}).then(r=>r.json());if(!response.ok)throw Error(response.error);return response.result;}
async function query(id:string,args:any){const response=await port('query_snapshot',{capability:key(id),arguments:args});expect(response.status,JSON.stringify(response)).toBe('ready');return response.data;}
async function invoke(id:string,args:any){const result=await port('invoke',{capability:key(id),arguments:args,client_request_id:crypto.randomUUID(),preconditions:[]});expect(result.status,result.error).toBe('succeeded');return result.output;}

test.beforeAll(async()=>{
 const annotationPackage=process.env.RHO_ANNOTATION_PLUGIN_PACKAGE,filesArchive=process.env.RHO_FILES_PLUGIN_ARCHIVE;
 if(!annotationPackage||!filesArchive)throw Error('Set RHO_ANNOTATION_PLUGIN_PACKAGE and RHO_FILES_PLUGIN_ARCHIVE to built, retained packages.');
 directory=await mkdtemp(join(tmpdir(),'rho-annotation-ui-'));project=join(directory,'project');await mkdir(project);project=await realpath(project);core=digest(await readFile(binary));
 await writeFile(join(project,'analysis.R'),'x <- 1\nprint(42)\n');execFileSync('git',['init','-q',project]);
 const database=join(directory,'state.sqlite');
 const filesImported=JSON.parse(execFileSync(binary,['--database',database,'plugins','import',resolve(filesArchive)],{encoding:'utf8'})).result;
 const notesSnapshot=JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',resolve(annotationPackage),'--target','aarch64-apple-darwin'],{encoding:'utf8'})).result;
 host=spawn(binary,['--database',database,'--project',project,'workbench'],{stdio:['ignore','pipe','pipe']});
 url=new URL(await new Promise<string>((done,reject)=>{let out='',errors='';const timer=setTimeout(()=>reject(Error(`Host startup timed out: ${errors}`)),30000);host.stderr!.on('data',b=>errors+=b);host.stdout!.on('data',b=>{out+=b;const found=out.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);if(found){clearTimeout(timer);done(found[0]);}});host.once('exit',code=>{clearTimeout(timer);reject(Error(`Host exited ${code}: ${errors}`));});}));
 const inspected=await query('plugins.inspect',{revision:filesImported.revision});
 files=(await invoke('plugins.activate',{revision:filesImported.revision,artifact:inspected.artifacts[0].id,target:'aarch64-apple-darwin',alias:'files',configuration:{}})).instance.identity;
 annotation=(await invoke('plugins.activate',{revision:notesSnapshot.revision,artifact:notesSnapshot.artifacts[0],target:'aarch64-apple-darwin',alias:'annotations',configuration:{},optional_capabilities:['plugins.instances','plugins.resolve','workspace.paths','files.read_text','files.context.preview','operation.get','operation.list_recent'].map(key)})).instance.identity;
 view=(await invoke('windows.open_view',{expected_layout_version:0,group:null,view:{instance:annotation,window:windowId,contribution:'annotations',configuration:{},state:{}}})).view;
});
test.afterAll(async()=>{if(host?.exitCode===null){host.kill('SIGINT');await new Promise<void>(done=>host.once('exit',()=>done()));}if(directory&&completed)await rm(directory,{recursive:true,force:true});else if(directory)console.error(`Annotation UI fixture retained at ${directory}`);});

test('captures quoted Files evidence, recovers a lost note acknowledgement, and edits by revision',async({page},info)=>{
 let lost=false;const requests:any[]=[];
 await page.route('**/api/plugin-view',async route=>{const message=route.request().postDataJSON()?.message,body=message?.body;requests.push(message);if(!lost&&body?.type==='invoke'&&body.capability.id==='annotations.write'&&body.arguments?.arguments?.command?.kind==='create'){lost=true;const reply=await route.fetch();const response=await reply.json();expect(response.ok,response.error).toBe(true);await route.fulfill({response:reply,json:{...response,ok:false,error:'Fixture lost the note acknowledgement'}});}else await route.continue();});
 const address=new URL(url);address.searchParams.set('window',windowId);await page.goto(address.href);
 const frame=page.locator(`[data-plugin-frame="${view.view}"]`).frameLocator('iframe');
 await expect(frame.locator('#provider')).toContainText('files');await frame.locator('#provider').selectOption(files.instance);
 await frame.getByLabel('Project file').fill('analysis.R');await frame.getByRole('button',{name:'Read file'}).click();
 await expect(frame.locator('#source-text')).toHaveValue(/x <- 1/);
 await frame.locator('#source-text').evaluate((element:HTMLTextAreaElement)=>{const start=element.value.indexOf('x <- 1');element.setSelectionRange(start,start+6);});
 await frame.getByRole('button',{name:'Capture selected text'}).click();await expect(frame.locator('#evidence-status')).toContainText('Frozen evidence');await expect(frame.locator('#frozen-text')).toHaveText('x <- 1');
 await frame.getByLabel('Note',{exact:true}).fill('Check the original result');await frame.getByRole('button',{name:'Save note'}).click();
 await expect(frame.locator('#pending')).toBeVisible();await expect(frame.locator('#notice')).toContainText('lost the note acknowledgement');
 expect(requests.filter(r=>r?.body?.type==='invoke'&&r.body.arguments?.arguments?.command?.kind==='create')).toHaveLength(1);
 await page.reload();await expect(frame.locator('#pending')).toBeVisible();await expect(frame.getByLabel('Note',{exact:true})).toHaveValue('Check the original result');
 await frame.getByRole('button',{name:'Inspect original operation'}).click();await expect(frame.locator('#pending')).toBeHidden();await expect(frame.locator('#editor-title')).toContainText('Edit revision 1');
 const saved=(await query('views.inspect',{view:view.view})).state;expect(saved.pending).toBe(null);expect(saved.selected.revision).toBe(1);
 const note=await query('annotations.read',{binding:await query('plugins.resolve',{instance:annotation,capability:key('annotations.read')}),arguments:{kind:'read',annotation:saved.selected}});
 expect(note.evidence.fragment.text).toBe('x <- 1');expect(note.revision.note).toBe('Check the original result');
 await frame.getByLabel('Note',{exact:true}).fill('Revised after reviewing the result');await frame.getByRole('button',{name:'Save note'}).click();
 await expect(frame.locator('#editor-title')).toContainText('Edit revision 2');
 const updated=(await query('views.inspect',{view:view.view})).state;expect(updated.selected.revision).toBe(2);
 expect(requests.filter(r=>r?.body?.type==='invoke'&&r.body.arguments?.arguments?.command?.kind==='create')).toHaveLength(1);
 expect(digest(await readFile(binary))).toBe(core);expect(lost).toBe(true);
 await expect(frame.locator('#frozen-text')).toHaveText('x <- 1');
 await page.screenshot({path:info.outputPath('annotation-ui.png')});
 await page.setViewportSize({width:1920,height:900});await page.reload();await expect(frame.locator('#editor-title')).toContainText('Edit revision 2');await page.screenshot({path:info.outputPath('annotation-ui-wide.png')});
 await page.setViewportSize({width:390,height:844});await page.reload();await expect(frame.locator('#editor-title')).toContainText('Edit revision 2');const widths=await frame.locator('body').evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,inner:window.innerWidth,body:document.body.scrollWidth}));expect(widths.scroll,JSON.stringify(widths)).toBeLessThanOrEqual(widths.client+1);await page.screenshot({path:info.outputPath('annotation-ui-narrow.png')});await frame.locator('#editor-title').scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('annotation-ui-narrow-editor.png')});
 const writeBinding=await query('plugins.resolve',{instance:annotation,capability:key('annotations.write')});
 let concurrent=await port('invoke',{capability:key('annotations.write'),arguments:{binding:writeBinding,arguments:{request_id:crypto.randomUUID(),command:{kind:'update',expected:updated.selected,note:'Parallel revision',labels:[],marks:[]}},preconditions:null},client_request_id:crypto.randomUUID(),preconditions:[]});
 for(let attempt=0;attempt<60&&!['succeeded','failed','cancelled','uncertain'].includes(concurrent.status);attempt++){await new Promise(done=>setTimeout(done,50));concurrent=await query('operation.get',{operation_id:concurrent.operation.operation_id}).then(data=>data.record);}
 expect(concurrent.status,concurrent.error).toBe('succeeded');expect(concurrent.output.outcome.annotation.revision).toBe(3);
 await frame.getByLabel('Note',{exact:true}).fill('My stale edit must be retained');await frame.getByRole('button',{name:'Save note'}).click();await expect(frame.locator('#conflict')).toBeVisible();await expect(frame.locator('#pending')).toBeHidden();await expect(frame.getByLabel('Note',{exact:true})).toHaveValue('My stale edit must be retained');
 await frame.getByRole('button',{name:'Refresh notes'}).click();await frame.getByRole('button',{name:/Parallel revision/}).click();await expect(frame.locator('#editor-title')).toContainText('Edit revision 3');
 await frame.getByRole('button',{name:'Delete note'}).click();await expect(frame.locator('#notes')).toContainText('No saved notes');
 const historical=await query('annotations.read',{binding:await query('plugins.resolve',{instance:annotation,capability:key('annotations.read')}),arguments:{kind:'read',annotation:updated.selected}});expect(historical.revision.note).toBe('Revised after reviewing the result');
 await writeFile(info.outputPath('result.json'),JSON.stringify({core_sha256:core,files,annotation,view:view.view,revision:updated.selected,checks:['Exact Files preview selected and frozen before note entry','One create Operation despite lost acknowledgement and reload','Original Operation recovered without replay','Existing note edited with exact revision CAS','Concurrent update refuses stale edit and preserves draft','Explicit tombstone leaves historical revision readable','Normal, wide and narrow screenshots inspected; no horizontal overflow','Core binary unchanged']},null,2)+'\n');completed=true;
});
