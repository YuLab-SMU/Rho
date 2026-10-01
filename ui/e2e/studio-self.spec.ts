import {test,expect} from '@playwright/test';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,realpath,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,delimiter} from 'node:path';
import {createHash} from 'node:crypto';
import {buildStudioPlugin} from '../../scripts/build-studio-plugin.mjs';
let directory:string,project:string,url:URL,host:ReturnType<typeof spawn>,completed=false,original:any,studioView:any,initial:any;
const windowId='studio-self-window',binary=resolve('../target/debug/rho');
async function port(method:string,params:any){const response=await fetch(new URL('/api/host',url),{method:'POST',headers:{Authorization:`Bearer ${url.hash.slice(7)}`,'Content-Type':'application/json','X-Rho-Studio-Window':windowId},body:JSON.stringify({project_root:project,frame:{id:crypto.randomUUID(),request:{method,params}}})}).then(r=>r.json());if(!response.ok)throw Error(response.error);return response.result;}
async function query(id:string,args:any){return(await port('query_snapshot',{capability:{id,version:1},arguments:args})).data;}
async function invoke(id:string,args:any){const result=await port('invoke',{capability:{id,version:1},arguments:args,client_request_id:crypto.randomUUID(),preconditions:[]});expect(result.status,result.error).toBe('succeeded');return result.output;}
async function allOperations(){const operations:any[]=[];let before_cursor:number|null=null;for(let page=0;page<20;page++){const result=await query('operation.list_recent',{limit:100,before_cursor});operations.push(...result.operations);if(result.next_cursor===null)return operations;before_cursor=result.next_cursor;}throw Error('Fixture operation history exceeded its 2000-record bound.');}
test.beforeAll(async()=>{
 directory=await mkdtemp(join(tmpdir(),'rho-studio-self-'));project=join(directory,'project');await mkdir(project);project=await realpath(project);
 const database=join(directory,'state.sqlite'),archive=process.env.RHO_STUDIO_PLUGIN_ARCHIVE;
 original=JSON.parse(execFileSync(binary,['--database',database,'plugins',...(archive?['import',resolve(archive)]:['snapshot',buildStudioPlugin(join(directory,'studio')),'--target','ui-web'])],{encoding:'utf8'})).result;
 // Expose only the already installed compiler through the build's existing PATH contract.
 host=spawn(binary,['--database',database,'--project',project,'workbench'],{env:{...process.env,PATH:resolve('node_modules/.bin')+delimiter+process.env.PATH},stdio:['ignore','pipe','pipe']});
 url=new URL(await new Promise<string>((done,reject)=>{let out='',errors='';const timer=setTimeout(()=>reject(Error(`Host startup timed out: ${errors}`)),40000);host.stderr!.on('data',b=>errors+=b);host.stdout!.on('data',b=>{out+=b;const found=out.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);if(found){clearTimeout(timer);done(found[0]);}});host.once('exit',code=>{clearTimeout(timer);reject(Error(`Host exited ${code}: ${errors}`));});}));
 const inspection=await query('plugins.inspect',{revision:original.revision});expect(inspection.summary.plugin).toBe('org.rho.studio');
 const instance=(await invoke('plugins.activate',{revision:original.revision,artifact:inspection.artifacts[0].id,target:'ui-web',alias:'studio',configuration:{}})).instance.identity;
 studioView=await invoke('views.open',{instance,window:windowId,contribution:'studio',configuration:{},state:{}});
 initial=await invoke('scenarios.checkpoint',{scenario:'self-development',expected_head:null,name:'Studio self development',instances:{studio:{plugin:instance.plugin,revision:instance.revision,artifact:instance.artifact,configuration:{},dependencies:{}}},providers:[],layout:{kind:'tabs',id:'studio-tabs',selected:'studio-view',views:[{id:'studio-view',instance:'studio',contribution:'studio',configuration:{},state:{},state_revision:original.revision,resource:null}]}});
 await invoke('scenarios.apply',{window:windowId,revision:initial.id,expected_layout_version:0,instances:{studio:instance},views:{'studio-view':studioView.view}});
});
test.afterAll(async()=>{if(host?.exitCode===null){host.kill('SIGINT');await new Promise<void>(done=>host.once('exit',()=>done()));}if(directory&&completed)await rm(directory,{recursive:true,force:true});else if(directory)console.error(`Studio self fixture retained at ${directory}`);});
test('Studio branches, builds, previews and replaces itself while retaining its original instance',async({page},info)=>{
 test.setTimeout(180000);const requests:any[]=[];page.on('request',request=>{if(request.url().endsWith('/api/plugin-view'))requests.push(request.postDataJSON()?.message);});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const address=new URL(url);address.searchParams.set('window',windowId);await page.goto(address.href);
 const frame=page.locator(`[data-plugin-frame="${studioView.view}"]`).frameLocator('iframe'),source=frame.getByRole('textbox',{name:'Source editor',exact:true});
 await frame.getByRole('button',{name:'Choose revision',exact:true}).click();await frame.locator(`#revision-list [data-revision="${original.revision}"]`).click();
 await frame.getByLabel('Development branch name').fill('studio-self-edit');await frame.getByRole('button',{name:'Create branch from selected',exact:true}).click();
 await frame.getByRole('button',{name:'Source files',exact:true}).click();await frame.getByRole('button',{name:'src/index.html',exact:true}).click();
 await expect(frame.locator('#path')).toHaveText('src/index.html');await expect(source).toHaveValue(/<h1>Plugin Studio<\/h1>/);
 const html=await source.inputValue();expect(html).toContain('<h1>Plugin Studio</h1>');const edited=html.replace('<h1>Plugin Studio</h1>','<h1>My Plugin Studio</h1>');await source.fill(edited);
 await frame.getByRole('button',{name:'Checkpoint',exact:true}).click();await expect(frame.locator('#notice')).toContainText('Source checkpoint');
 const branch=(await query('plugins.branches',{plugin:'org.rho.studio',after:null,limit:100})).branches.find((b:any)=>b.name==='studio-self-edit'),checkpoint=branch.head;expect(checkpoint).not.toBe(original.revision);
 await frame.getByRole('button',{name:'Build & preview',exact:true}).click();await frame.getByRole('button',{name:'Build checkpoint',exact:true}).click();await expect(frame.locator('#build-status')).toContainText('Build succeeded',{timeout:60000});
 const built=await query('plugins.inspect',{revision:checkpoint});expect(built.artifacts).toHaveLength(1);
 await frame.getByText('Preview configuration and fixture data',{exact:true}).click();
 await frame.getByLabel('Exact query fixtures',{exact:true}).fill(JSON.stringify([
  {capability:{id:'windows.scenario',version:1},arguments:{window:windowId},data:{window:windowId,scenario:null}},
  {capability:{id:'plugins.instances',version:1},arguments:{after:null,limit:100},data:{instances:[],next:null,total:0}},
 ]));
 await frame.getByRole('button',{name:'Start preview',exact:true}).click();await expect(page.locator('[data-plugin-preview=fixture]')).toBeVisible();
 const previewLayout=await query('windows.layout',{window:windowId}),preview=await query('views.inspect',{view:previewLayout.layout.selected});expect(preview.purpose).toBe('fixture_preview');expect(preview.instance.revision).toBe(checkpoint);
 const previewFrame=page.locator(`[data-plugin-frame="${preview.view}"]`).frameLocator('iframe');await expect(previewFrame.getByRole('heading',{name:'My Plugin Studio',exact:true})).toBeVisible();await expect(previewFrame.locator('#error')).toBeHidden();
 await previewFrame.getByRole('button',{name:'Save draft',exact:true}).click();await expect(previewFrame.locator('#sync')).toHaveText('Draft synchronized');expect((await query('views.inspect',{view:preview.view})).state.fixture_content).toContain('schema');await page.reload();await expect(previewFrame.getByRole('heading',{name:'My Plugin Studio',exact:true})).toBeVisible();await expect(previewFrame.getByRole('button',{name:'Choose revision',exact:true})).toBeEnabled();
 await page.screenshot({path:info.outputPath('studio-self-preview.png')});
 await page.getByRole('tab',{name:'Plugin Studio',exact:true}).first().click();await frame.locator('body').evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));await page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));await frame.getByRole('button',{name:'Build & preview',exact:true}).click();await frame.getByRole('button',{name:'Close preview view',exact:true}).click();await expect(frame.locator('#preview-instance')).toContainText('view closed');await frame.getByRole('button',{name:'Release preview',exact:true}).click();await frame.locator('#close-development').click();
 await frame.getByRole('button',{name:'Apply to scenario',exact:true}).click();await frame.getByLabel('Target scenario',{exact:true}).selectOption(initial.id);await expect(frame.getByLabel('Instance alias',{exact:true})).toHaveValue('studio');
 await frame.getByLabel('New view state by view ID',{exact:true}).fill('{"studio-view":{}}');await frame.getByRole('button',{name:'Stage selected build',exact:true}).click();await frame.getByRole('button',{name:'Save scenario checkpoint',exact:true}).click();await frame.getByRole('button',{name:'Prepare instances',exact:true}).click();await expect(frame.locator('#scenario-lifecycle')).toContainText('ready to apply');
 const originalState=(await query('views.inspect',{view:studioView.view})).state;expect(originalState.draft).toBeTruthy();
 await frame.getByRole('button',{name:'Apply to this window',exact:true}).click();
 await expect.poll(async()=>(await query('windows.scenario',{window:windowId})).scenario.instances.studio.revision).toBe(checkpoint);
 const applied=(await query('windows.scenario',{window:windowId})).scenario,newView=applied.views['studio-view'];expect(newView).not.toBe(studioView.view);
 const revised=page.locator(`[data-plugin-frame="${newView}"]`).frameLocator('iframe');await expect(revised.getByRole('heading',{name:'My Plugin Studio',exact:true})).toBeVisible();await expect(revised.getByRole('button',{name:'Choose revision',exact:true})).toBeEnabled();
 expect((await query('plugins.instance',{instance:studioView.instance})).instance.state).toBe('active');expect((await query('views.inspect',{view:studioView.view})).closed).toBe(false);
 await page.reload();await expect(revised.getByRole('heading',{name:'My Plugin Studio',exact:true})).toBeVisible();await page.screenshot({path:info.outputPath('studio-self-applied.png')});
 // The revised Studio restores its previous scenario as another checkpoint.
 await revised.getByRole('button',{name:'Apply to scenario',exact:true}).click();await revised.getByLabel('Target scenario',{exact:true}).selectOption(applied.revision);await revised.locator(`#scenario-history [data-revision="${initial.id}"]`).click();await revised.getByRole('button',{name:'Restore as new checkpoint',exact:true}).click();
 await revised.getByRole('button',{name:'Prepare instances',exact:true}).click();await expect(revised.locator('#scenario-lifecycle')).toContainText('ready to apply');await revised.getByRole('button',{name:'Apply to this window',exact:true}).click();
 await expect.poll(async()=>(await query('windows.scenario',{window:windowId})).scenario.instances.studio.revision).toBe(original.revision);
 // A fresh Studio has no inherited private editor state or retained-view list.
 // The scenario restores the old revision in default state; reopen the retained
 // original explicitly through the public layout port to verify its exact draft.
 const restoredWindow=await query('windows.scenario',{window:windowId});
 const restoredFrame=page.locator(`[data-plugin-frame="${restoredWindow.scenario.views['studio-view']}"]`).frameLocator('iframe');
 await expect(restoredFrame.getByRole('heading',{name:'Plugin Studio',exact:true})).toBeVisible();
 const layout=await query('windows.layout',{window:windowId});
 await invoke('windows.update_layout',{window:windowId,expected_version:layout.version,layout:{kind:'tabs',id:'retained-studio-tabs',selected:studioView.view,views:[studioView.view,restoredWindow.scenario.views['studio-view']]}});
 await expect(frame.getByRole('heading',{name:'Plugin Studio',exact:true})).toBeVisible();
 // The original view may retain the acknowledged-or-lost application request;
 // inspect it explicitly rather than dispatching a second application.
 await frame.getByRole('button',{name:'Apply to scenario',exact:true}).click();
 if(await frame.locator('#scenario-pending').isVisible())await frame.getByRole('button',{name:'Inspect original scenario request',exact:true}).click();
 await expect(frame.locator('#scenario-pending')).toBeHidden();await frame.locator('#close-scenario').click();await expect(source).toHaveValue(edited);
 const restored=(await query('windows.scenario',{window:windowId})).scenario;expect(restored.revision).not.toBe(initial.id);expect(restored.revision).not.toBe(applied.revision);expect((await query('scenarios.get',{revision:restored.revision})).parent).toBe(applied.revision);
 expect((await query('plugins.instance',{instance:applied.instances.studio})).instance.state).toBe('active');expect((await query('plugins.inspect',{revision:original.revision})).artifacts).toHaveLength(1);
 const operations=await allOperations();expect(operations.filter((r:any)=>r.capability.id==='plugins.build')).toHaveLength(1);expect(requests.filter(message=>message?.view===preview.view&&['documents.stage','documents.save'].includes(message.body?.capability?.id))).toHaveLength(0);expect(errors).toEqual([]);
 await page.screenshot({path:info.outputPath('studio-self-restored.png')});
 await writeFile(info.outputPath('studio-self-result.json'),JSON.stringify({original:studioView.instance,checkpoint,artifact:built.artifacts[0].id,applied:applied.revision,restored:restored.revision,old_view:studioView.view,new_view:newView,core_sha256:createHash('sha256').update(await readFile(binary)).digest('hex'),checks:['Self source edited/checkpointed/built through original Studio','Revised Studio rendered in fixture preview then closed/released','Own scenario replaced through Studio; reload shows revised UI','Revised Studio restores old revision as new scenario checkpoint; explicit public layout reopening retains original source draft and both instances'],limits:['Existing compiler exposed via test Host PATH; no tool installation or native builds','Fresh revised Studio restores default view state; original view reopened explicitly via public layout port, not automatic retained-map transfer','OS IME and annotation UI review not covered']},null,2)+'\n');completed=true;
});
