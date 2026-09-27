import {test,expect} from '@playwright/test';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,realpath,readFile,writeFile,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {buildStudioPlugin} from '../../scripts/build-studio-plugin.mjs';
import {buildUiFixture,buildControlFixture} from '../../scripts/fixtures/plugin-ui.mjs';
let directory:string,project:string,url:URL,host:ReturnType<typeof spawn>,completed=false,studioView:any,parentView:any,subject:any;
const windowId='studio-test-window',nativeTarget='aarch64-apple-darwin';
async function port(target:string|null,method:string,params:any,window=windowId){
  const reply=await fetch(new URL('/api/host',url),{method:'POST',headers:{Authorization:`Bearer ${url.hash.slice(7)}`,'Content-Type':'application/json','X-Rho-Studio-Window':window},body:JSON.stringify({project_root:project,frame:{id:crypto.randomUUID(),test_project:target,request:{method,params}}})}).then(r=>r.json());
  if(!reply.ok)throw Error(reply.error);return reply.result;
}
async function query(target:string|null,id:string,args:any){return(await port(target,'query_snapshot',{capability:{id,version:1},arguments:args})).data;}
async function invoke(target:string|null,id:string,args:any,window=windowId){const result=await port(target,'invoke',{capability:{id,version:1},arguments:args,preconditions:[],client_request_id:crypto.randomUUID()},window);if(result.status!=='succeeded')await writeFile(join(directory,'failed-native-observation.json'),JSON.stringify({operation:result,instances:await query(null,'plugins.instances',{limit:20})},null,2));expect(result.status,result.error).toBe('succeeded');return result.output;}
test.beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),'rho-studio-backend-browser-'));project=join(directory,'analysis');await mkdir(project);project=await realpath(project);
  const database=join(directory,'state.sqlite'),binary=resolve('../target/debug/rho');
  const snapshot=(path:string,target='ui-web')=>JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',path,'--target',target],{encoding:'utf8'})).result;
  const studio=snapshot(buildStudioPlugin(join(directory,'studio')));
  const subjectPath=buildUiFixture(directory),backendPath=buildControlFixture(directory);
  const manifest=JSON.parse(await readFile(join(subjectPath,'plugin.json'),'utf8')),backend=JSON.parse(await readFile(join(backendPath,'plugin.json'),'utf8'));
  manifest.name='Disposable native example';manifest.backend=backend.backend;manifest.capabilities=backend.capabilities;
  manifest.capabilities.push({capability:{id:'fixture.read',version:1},kind:'query',title:'Native fixture observation',description:'Read this exact native instance',input_schema:{type:'object'},output_schema:{type:'object'},examples:[{}],required_scopes:['plugins.read'],effects:[],cancellation:'unsupported',preflight:null,recovery_schema:true});
  manifest.requires.push({capability:{id:'plugins.resolve',version:1},scopes:['plugins.read']},{capability:{id:'fixture.read',version:1},scopes:['plugins.read']});
  manifest.source.files.push('backend.py');await copyFile(join(backendPath,'backend.py'),join(subjectPath,'backend.py'));
  const main=await readFile(join(subjectPath,'src/main.js'),'utf8');
  await writeFile(join(subjectPath,'src/main.js'),main.replace('const client=await connectPluginView();',`const client=await connectPluginView();
const binding=(await client.query({id:'plugins.resolve',version:1},{capability:{id:'fixture.answer',version:2},instance:client.view.instance})).data;
const readBinding=(await client.query({id:'plugins.resolve',version:1},{capability:{id:'fixture.read',version:1},instance:client.view.instance})).data;
const environment=(await client.query({id:'fixture.read',version:1},{binding:readBinding,arguments:{action:'environment'}})).data;
const origin=document.createElement('output');origin.id='native-project';origin.textContent=environment.environment.project_root;document.body.append(origin);`).replace('binding:client.view.configuration.binding','binding'));
  await writeFile(join(subjectPath,'build.mjs'),"import{cpSync,copyFileSync,chmodSync}from'node:fs';cpSync('src','dist',{recursive:true});copyFileSync('backend.py','dist/backend');chmodSync('dist/backend',0o755);\n");
  await writeFile(join(subjectPath,'plugin.json'),JSON.stringify(manifest,null,2));execFileSync(process.execPath,[join(subjectPath,'build.mjs')],{cwd:subjectPath});subject=snapshot(subjectPath,nativeTarget);
  host=spawn(binary,['--database',database,'--project',project,'--plugins-only','workbench'],{stdio:['ignore','pipe','pipe']});
  url=new URL(await new Promise<string>((done,reject)=>{let out='',errors='';const timer=setTimeout(()=>reject(Error(`Host startup timed out: ${errors}`)),40000);host.stderr!.on('data',b=>errors+=b);host.stdout!.on('data',b=>{out+=b;const found=out.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);if(found){clearTimeout(timer);done(found[0]);}});host.once('exit',code=>{clearTimeout(timer);reject(Error(`Host exited ${code}: ${errors}`));});}));
  const parent=(await invoke(null,'plugins.activate',{revision:subject.revision,artifact:subject.artifacts[0],target:nativeTarget,alias:'analysis',configuration:{}})).instance.identity;
  parentView=(await invoke(null,'windows.open_view',{expected_layout_version:0,group:null,view:{instance:parent,window:'analysis-window',contribution:'view',configuration:{},state:{text:'Analysis draft'}}},'analysis-window')).view;
  const instance=(await invoke(null,'plugins.activate',{revision:studio.revision,artifact:studio.artifacts[0],target:'ui-web',alias:'studio',configuration:{}})).instance.identity;
  studioView=(await invoke(null,'windows.open_view',{expected_layout_version:0,group:null,view:{instance,window:windowId,contribution:'studio',configuration:{},state:{}}})).view;
});
test.afterAll(async()=>{if(host?.exitCode===null){host.kill('SIGINT');await new Promise<void>(done=>host.once('exit',()=>done()));}if(directory&&completed)await rm(directory,{recursive:true,force:true});else if(directory)console.error(`Studio backend fixture retained at ${directory}`);});
test('ordinary Studio creates, recovers, opens and stops a separate native test',async({page,context},info)=>{
  test.setTimeout(180000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const parent=await context.newPage(),address=new URL(url);address.searchParams.set('window','analysis-window');await parent.goto(address.href);
  const analysis=parent.frameLocator('iframe');await expect(analysis.locator('#native-project')).toHaveText(project);await analysis.getByLabel('View note').fill('Unsaved analysis 中文 Ω');
  address.searchParams.set('window',windowId);await page.bringToFront();await page.goto(address.href);
  const frame=page.locator(`[data-plugin-frame="${studioView.view}"]`).frameLocator('iframe');
  await frame.getByRole('button',{name:'Choose revision',exact:true}).click();await frame.getByRole('button',{name:/Disposable native example ·/}).click();await frame.locator('#close-chooser').click();
  await frame.getByRole('button',{name:'Build & preview',exact:true}).click();await frame.getByRole('button',{name:'Build checkpoint',exact:true}).click();
  await expect(frame.locator('#build-status')).toContainText('Build succeeded',{timeout:30000});
  await frame.getByRole('button',{name:'Use selected build',exact:true}).click();await frame.getByLabel('Test project name',{exact:true}).fill('Native test · 中文 Ω');
  await frame.locator('#preview-settings summary').click();await frame.getByLabel('Initial view state',{exact:true}).fill(JSON.stringify({text:'Test draft'}));
  let lost=false;await page.route('**/api/plugin-view',async route=>{const body=route.request().postDataJSON()?.message?.body;if(!lost&&body?.type==='invoke'&&body.capability.id==='plugins.test_create'){lost=true;const response=await route.fetch(),reply=await response.json();expect(reply.ok).toBe(true);await route.fulfill({response,json:{id:reply.id,ok:false,error:'Fixture lost the original test creation acknowledgement'}});}else await route.continue();});
  await frame.getByRole('button',{name:'New disposable test project',exact:true}).click();await expect(frame.locator('#test-pending')).toBeVisible();
  await page.reload();await frame.getByRole('button',{name:'Build & preview',exact:true}).click();await expect(frame.locator('#test-pending')).toBeVisible();
  await frame.getByRole('button',{name:'Inspect original test result',exact:true}).click();await expect(frame.locator('#test-pending')).toBeHidden();await expect(frame.locator('#test-project')).toContainText('live in this Host');await page.unroute('**/api/plugin-view');
  const tests=await query(null,'plugins.test_projects',{limit:20});expect(tests.projects).toHaveLength(1);const observed=tests.projects[0],id=observed.project.id;
  expect(observed.project.source_project).not.toBe(observed.project.project);expect(observed.project.selection.instances.subject.revision).toBe(subject.revision);
  await frame.getByRole('button',{name:'Open test view',exact:true}).click();await expect(frame.locator('#test-project')).toContainText('view open');
  const popup=context.waitForEvent('page');await frame.getByRole('button',{name:'Open test workspace',exact:true}).click();const child=await popup;child.on('pageerror',e=>errors.push(e.message));
  await expect(child.getByRole('note')).toContainText('Disposable test workspace · Native test');expect(new URL(child.url()).searchParams.get('test-project')).toBe(id);
  expect(await child.evaluate(()=>window.opener===null)).toBe(true);const testFrame=child.frameLocator('iframe');await expect(testFrame.locator('#native-project')).toHaveText(observed.project.directory);await expect(testFrame.getByLabel('View note')).toHaveValue('Test draft');
  await testFrame.getByRole('button',{name:'Answer native input',exact:true}).click();await expect(testFrame.locator('#result')).toHaveText('Answer accepted');await testFrame.getByLabel('View note').fill('Unsaved test state 中文');
  const openedLayout=await query(id,'windows.layout',{window:windowId}),testViewId=openedLayout.layout.selected;
  await page.bringToFront();
  for(const width of [1440,1920,390,220]){await page.setViewportSize({width,height:900});await expect.poll(async()=>Math.abs(await frame.locator('body').evaluate(()=>innerWidth)-width)).toBeLessThan(5);await frame.locator('body').evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));await frame.locator('#backend-test h3').evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));await frame.locator('body').evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));expect(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await expect(frame.locator('#backend-test h3')).toBeInViewport();await page.screenshot({path:info.outputPath(`studio-backend-${width}.png`)});if(width<=390){await frame.locator('#test-lifecycle .actions').evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));await frame.locator('body').evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));await expect(frame.getByRole('button',{name:'Close test view',exact:true})).toBeInViewport();await page.screenshot({path:info.outputPath(`studio-backend-controls-${width}.png`)});}}
  await page.setViewportSize({width:1440,height:900});await frame.getByRole('button',{name:'Close test view',exact:true}).click();await expect(frame.locator('#test-project')).toContainText('view closed');
  expect((await query(id,'views.inspect',{view:testViewId})).state.text).toBe('Unsaved test state 中文');
  const childLayout=await query(id,'windows.layout',{window:windowId});expect(childLayout.layout.views??[]).toEqual([]);
  const viewRecord=(await query(null,'operation.list_recent',{limit:100})).operations;expect(viewRecord.filter((r:any)=>r.capability.id==='plugins.test_create')).toHaveLength(1);
  await frame.getByRole('button',{name:'Stop test project',exact:true}).click();await expect(frame.locator('#test-project')).toContainText('stopped');await expect(frame.getByRole('button',{name:'Open test workspace',exact:true})).toBeDisabled();
  expect((await query(null,'plugins.test_project',{id})).observed_in_this_host).toBe(false);await page.screenshot({path:info.outputPath('studio-backend-stopped.png')});
  await expect(analysis.getByLabel('View note')).toHaveValue('Unsaved analysis 中文 Ω');expect((await query(null,'views.inspect',{view:parentView.view})).state.text).toBe('Analysis draft');expect(errors).toEqual([]);expect(lost).toBe(true);completed=true;
});
