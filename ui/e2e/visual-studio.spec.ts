import {test,expect} from '@playwright/test';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,realpath,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {buildVisualPlugin} from '../../scripts/fixtures/visual-plugin.mjs';
import {buildStudioPlugin} from '../../scripts/build-studio-plugin.mjs';
let directory:string,project:string,url:URL,host:ReturnType<typeof spawn>,completed=false,original:any,studioView:any,initial:any,subject:any,subjectView:any;
const windowId='visual-studio-window',binary=resolve('../target/debug/rho');
async function port(method:string,params:any){const response=await fetch(new URL('/api/host',url),{method:'POST',headers:{Authorization:`Bearer ${url.hash.slice(7)}`,'Content-Type':'application/json','X-Rho-Studio-Window':windowId},body:JSON.stringify({project_root:project,frame:{id:crypto.randomUUID(),request:{method,params}}})}).then(r=>r.json());if(!response.ok)throw Error(response.error);return response.result;}
async function query(id:string,args:any){return(await port('query_snapshot',{capability:{id,version:1},arguments:args})).data;}
async function invoke(id:string,args:any){const result=await port('invoke',{capability:{id,version:1},arguments:args,client_request_id:crypto.randomUUID(),preconditions:[]});expect(result.status,result.error).toBe('succeeded');return result.output;}
test.beforeAll(async()=>{
 directory=await mkdtemp(join(tmpdir(),'rho-visual-studio-'));project=join(directory,'project');await mkdir(project);project=await realpath(project);
 const database=join(directory,'state.sqlite');
 const snapshot=(source:string)=>JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',source,'--target','ui-web'],{encoding:'utf8'})).result;
 original=snapshot(buildStudioPlugin(join(directory,'studio')));subject=snapshot(buildVisualPlugin(join(directory,'subject')));
 host=spawn(binary,['--database',database,'--project',project,'workbench'],{stdio:['ignore','pipe','pipe']});
 url=new URL(await new Promise<string>((done,reject)=>{let out='',errors='';const timer=setTimeout(()=>reject(Error(`Host startup timed out: ${errors}`)),40000);host.stderr!.on('data',b=>errors+=b);host.stdout!.on('data',b=>{out+=b;const found=out.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);if(found){clearTimeout(timer);done(found[0]);}});host.once('exit',code=>{clearTimeout(timer);reject(Error(`Host exited ${code}: ${errors}`));});}));
 const instances:any={},views:any={};
 for(const [alias,source,contribution] of [['studio',original,'studio'],['report',subject,'report']] as const){
  const inspection=await query('plugins.inspect',{revision:source.revision});const instance=(await invoke('plugins.activate',{revision:source.revision,artifact:inspection.artifacts[0].id,target:'ui-web',alias,configuration:{}})).instance.identity;
  instances[alias]=instance;views[alias]=await invoke('views.open',{instance,window:windowId,contribution,configuration:{},state:{}});
 }
 studioView=views.studio;subjectView=views.report;
 initial=await invoke('scenarios.checkpoint',{scenario:'declarative-development',expected_head:null,name:'Declarative development',instances:Object.fromEntries(Object.entries(instances).map(([alias,i]:any)=>[alias,{plugin:i.plugin,revision:i.revision,artifact:i.artifact,configuration:{},dependencies:{}}])),providers:[],layout:{kind:'tabs',id:'development-tabs',selected:'studio-view',views:Object.entries(instances).map(([alias,i]:any)=>({id:`${alias}-view`,instance:alias,contribution:alias,configuration:{},state:{},state_revision:i.revision,resource:null}))}});
 await invoke('scenarios.apply',{window:windowId,revision:initial.id,expected_layout_version:0,instances,views:{'studio-view':studioView.view,'report-view':subjectView.view}});
});
test.afterAll(async()=>{if(host?.exitCode===null){host.kill('SIGINT');await new Promise<void>(done=>host.once('exit',()=>done()));}if(directory&&completed)await rm(directory,{recursive:true,force:true});else if(directory)console.error(`Visual Studio fixture retained at ${directory}`);});
test('declaration edits change built preview and applied ordinary plugin while old revision survives',async({page},info)=>{
 test.setTimeout(120000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const address=new URL(url);address.searchParams.set('window',windowId);await page.goto(address.href);
 const frame=page.locator(`[data-plugin-frame="${studioView.view}"]`).frameLocator('iframe'),source=frame.getByRole('textbox',{name:'Source editor',exact:true});
 const old=page.locator(`[data-plugin-frame="${subjectView.view}"]`).frameLocator('iframe');
 await page.getByRole('tab',{name:'Declarative Report',exact:true}).click();await expect(old.getByText('Original declaration',{exact:true})).toBeVisible();await old.getByRole('button',{name:'Remember selection',exact:true}).click();await expect(old.locator('#receipt')).toHaveText('original');
 await page.getByRole('tab',{name:'Plugin Studio',exact:true}).click();await frame.getByRole('button',{name:'Choose revision',exact:true}).click();await frame.locator(`#revision-list [data-revision="${subject.revision}"]`).click();await frame.getByLabel('Development branch name').fill('declaration-change');await frame.getByRole('button',{name:'Create branch from selected',exact:true}).click();
 await frame.getByRole('button',{name:'Declaration',exact:true}).click();await expect(source).toHaveValue(/Original declaration/);
 const declaration=JSON.parse(await source.inputValue());declaration.nodes.title.properties.text='Built from edited declaration 中文';declaration.nodes.save.properties.text='Remember revised selection';declaration.nodes.save.events.click[0].value='revised';
 await source.fill(JSON.stringify(declaration,null,2));await frame.getByRole('button',{name:'Canvas',exact:true}).click();await expect(frame.locator('#canvas')).toContainText('Built from edited declaration 中文');
 await frame.getByRole('button',{name:'Checkpoint',exact:true}).click();await expect(frame.locator('#notice')).toContainText('Source checkpoint');
 const branch=(await query('plugins.branches',{plugin:'example.declarative-report',after:null,limit:100})).branches.find((b:any)=>b.name==='declaration-change'),checkpoint=branch.head;
 await frame.getByRole('button',{name:'Build & preview',exact:true}).click();await frame.getByRole('button',{name:'Build checkpoint',exact:true}).click();await expect(frame.locator('#build-status')).toContainText('Build succeeded');
 await frame.getByText('Preview configuration and fixture data',{exact:true}).click();await frame.getByLabel('Exact query fixtures',{exact:true}).fill(JSON.stringify([{capability:{id:'plugins.list',version:1},arguments:{after:null,limit:10},data:{total:73}}]));await frame.getByRole('button',{name:'Start preview',exact:true}).click();
 await expect(page.locator('[data-plugin-preview=fixture]')).toBeVisible();
 const previewLayout=await query('windows.layout',{window:windowId}),preview=await query('views.inspect',{view:previewLayout.layout.selected});expect(preview.purpose).toBe('fixture_preview');
 const previewFrame=page.locator(`[data-plugin-frame="${preview.view}"]`).frameLocator('iframe');await expect(previewFrame.getByText('Built from edited declaration 中文',{exact:true})).toBeVisible();await expect(previewFrame.locator('[data-visual-node=count]')).toHaveText('73');await expect(previewFrame.getByRole('alert')).toBeHidden();await previewFrame.getByRole('button',{name:'Remember revised selection',exact:true}).click();await expect(previewFrame.locator('#receipt')).toHaveText('revised');
 await page.screenshot({path:info.outputPath('declaration-preview.png')});
 await page.getByRole('tab',{name:'Plugin Studio',exact:true}).click();await frame.locator('body').evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));await page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));await frame.getByRole('button',{name:'Close preview view',exact:true}).click();await expect(frame.locator('#preview-instance')).toContainText('view closed');await frame.getByRole('button',{name:'Release preview',exact:true}).click();await frame.locator('#close-development').click();
 await frame.getByRole('button',{name:'Apply to scenario',exact:true}).click();await frame.getByLabel('Target scenario',{exact:true}).selectOption(initial.id);await expect(frame.getByLabel('Instance alias',{exact:true})).toHaveValue('report');await frame.getByLabel('New view state by view ID',{exact:true}).fill('{"report-view":{}}');
 await frame.getByRole('button',{name:'Stage selected build',exact:true}).click();await frame.getByRole('button',{name:'Save scenario checkpoint',exact:true}).click();await frame.getByRole('button',{name:'Prepare instances',exact:true}).click();await expect(frame.locator('#scenario-lifecycle')).toContainText('ready to apply');await frame.getByRole('button',{name:'Apply to this window',exact:true}).click();
 await expect.poll(async()=>(await query('windows.scenario',{window:windowId})).scenario.instances.report.revision).toBe(checkpoint);
 const applied=(await query('windows.scenario',{window:windowId})).scenario,revised=page.locator(`[data-plugin-frame="${applied.views['report-view']}"]`).frameLocator('iframe');
 await expect(page.locator(`[data-plugin-frame="${applied.views['report-view']}"]`)).toBeAttached();
 await page.getByRole('tab',{name:'Declarative Report',exact:true}).click();await expect(revised.getByText('Built from edited declaration 中文',{exact:true})).toBeVisible();await expect(revised.locator('[data-visual-node=count]')).toHaveText(String((await query('plugins.list',{after:null,limit:10})).total));await expect(revised.getByRole('alert')).toBeHidden();
 await revised.getByRole('button',{name:'Remember revised selection',exact:true}).click();await expect(revised.locator('#receipt')).toHaveText('revised');await page.reload();await expect(revised.locator('#receipt')).toHaveText('revised');
 expect((await query('views.inspect',{view:subjectView.view})).state.selection).toBe('original');expect((await query('plugins.instance',{instance:subjectView.instance})).instance.state).toBe('active');
 await page.screenshot({path:info.outputPath('declaration-applied.png')});expect(errors).toEqual([]);
 await writeFile(info.outputPath('result.json'),JSON.stringify({original:subject.revision,checkpoint,instance:applied.instances.report,core_sha256:createHash('sha256').update(await readFile(binary)).digest('hex'),checks:['Outside-checkout package builds exact validated declaration','Studio declaration edit and inert canvas share source checkpoint','Ordinary native build emits changed declaration','Fixture preview renders changed text, action and exact query fixture','Scenario apply renders changed declaration and reads live public catalog','Explicit view-state action survives reload; old instance and state retained'],limits:['No scientific invoke action in this fixture','Subscriptions and custom/media lifecycle covered by separate component browser test']},null,2)+'\n');completed=true;
});
