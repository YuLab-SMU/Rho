import {test,expect} from '@playwright/test';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,realpath,readFile,writeFile,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {buildManagerPlugin} from '../../scripts/build-manager-plugin.mjs';
import {buildUiFixture} from '../../scripts/fixtures/plugin-ui.mjs';
let directory:string,project:string,url:URL,host:ReturnType<typeof spawn>,completed=false;
let manager:any,original:any,managerView:any,originalView:any,first:any,second:any,secondPackage:any;
const windowId='manager-window';
async function port(method:string,params:any){
  const result=await fetch(new URL('/api/host',url),{method:'POST',headers:{Authorization:`Bearer ${url.hash.slice(7)}`,'Content-Type':'application/json','X-Rho-Studio-Window':windowId},
    body:JSON.stringify({project_root:project,frame:{id:crypto.randomUUID(),request:{method,params}}})}).then(r=>r.json());
  if(!result.ok)throw Error(result.error);return result.result;
}
async function query(id:string,args:any){return(await port('query_snapshot',{capability:{id,version:1},arguments:args})).data;}
async function invoke(id:string,args:any){const r=await port('invoke',{capability:{id,version:1},arguments:args,client_request_id:crypto.randomUUID(),preconditions:[]});expect(r.status,r.error).toBe('succeeded');return r.output;}
const wanted=(identity:any)=>({plugin:identity.plugin,revision:identity.revision,artifact:identity.artifact,configuration:{},dependencies:{}});
const savedView=(id:string,alias:string,view:any)=>({id,instance:alias,contribution:view.contribution,configuration:view.configuration,state:view.state,state_revision:view.instance.revision,resource:null});
test.beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),'rho-manager-browser-'));project=join(directory,'project');await mkdir(project);project=await realpath(project);
  const database=join(directory,'state.sqlite'),binary=resolve('../target/debug/rho');
  const snapshot=(path:string)=>JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',path],{encoding:'utf8'})).result;
  const managerPackage=snapshot(buildManagerPlugin(join(directory,'manager')));
  const ui=buildUiFixture(directory),manifest=JSON.parse(await readFile(join(ui,'plugin.json'),'utf8'));
  manifest.requires=manifest.requires.filter((r:any)=>r.capability.id!=='fixture.answer');
  manifest.description='Inspect retained reports and keep a Unicode analysis note across scene switches.';
  await writeFile(join(ui,'plugin.json'),JSON.stringify(manifest));const firstPackage=snapshot(ui);
  const newer=join(directory,'newer');await cp(ui,newer,{recursive:true});manifest.name='Independent View · comparison';manifest.version='2.0';await writeFile(join(newer,'plugin.json'),JSON.stringify(manifest));secondPackage=snapshot(newer);
  host=spawn(binary,['--database',database,'--project',project,'--plugins-only','workbench'],{stdio:['ignore','pipe','pipe']});
  url=new URL(await new Promise<string>((done,reject)=>{let out='',errors='';const timer=setTimeout(()=>reject(Error(`Host startup timed out: ${errors}`)),40000);
    host.stderr!.on('data',b=>errors+=b);host.stdout!.on('data',b=>{out+=b;const found=out.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);if(found){clearTimeout(timer);done(found[0]);}});host.once('exit',code=>{clearTimeout(timer);reject(Error(`Host exited ${code}: ${errors}`));});}));
  const activate=async(pkg:any,alias:string)=>(await invoke('plugins.activate',{revision:pkg.revision,artifact:pkg.artifacts[0],target:'ui-web',alias,configuration:{}})).instance.identity;
  manager=await activate(managerPackage,'manager');original=await activate(firstPackage,'original-report');
  originalView=(await invoke('windows.open_view',{expected_layout_version:0,group:null,view:{instance:original,window:windowId,contribution:'view',configuration:{},state:{text:'Saved note'}}})).view;
  const initialLayout=await query('windows.layout',{window:windowId});
  managerView=(await invoke('windows.open_view',{expected_layout_version:1,group:initialLayout.layout.id,view:{instance:manager,window:windowId,contribution:'manager',configuration:{},state:{}}})).view;
  const managerDefinition=savedView('manager-view','manager',managerView),originalDefinition=savedView('report-view','report',originalView);
  first=await invoke('scenarios.checkpoint',{scenario:'analysis',expected_head:null,name:'R analysis',instances:{manager:wanted(manager),report:wanted(original)},providers:[],layout:{kind:'tabs',id:'analysis-tabs',selected:'manager-view',views:[managerDefinition,originalDefinition]}});
  const nextIdentity={...original,revision:secondPackage.revision,artifact:secondPackage.artifacts[0]};
  second=await invoke('scenarios.checkpoint',{scenario:'comparison',expected_head:null,name:'Report comparison',instances:{manager:wanted(manager),report:wanted(nextIdentity)},providers:[],layout:{kind:'tabs',id:'comparison-tabs',selected:'manager-view',views:[managerDefinition,{...originalDefinition,state_revision:nextIdentity.revision,state:{text:'Comparison checkpoint'}}]}});
});
test.afterAll(async()=>{if(host?.exitCode===null){host.kill('SIGINT');await new Promise<void>(done=>host.once('exit',()=>done()));}if(directory&&completed)await rm(directory,{recursive:true,force:true});else if(directory)console.error(`Manager fixture retained at ${directory}`);});
test('ordinary manager inspects revisions, prepares scenes and keeps original live drafts',async({page},info)=>{
  test.setTimeout(180000);
  const address=new URL(url);address.searchParams.set('window',windowId);address.searchParams.set('plugin-window','');
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(address.href);
  const region=(id:string)=>page.locator(`[data-plugin-frame="${id}"]`),frame=region(managerView.view).frameLocator('iframe');
  await expect(frame.getByRole('heading',{name:'Plugins',exact:true})).toBeVisible();
  const resize=async(width:number)=>{
    await page.setViewportSize({width,height:900});
    await expect.poll(async()=>Math.abs((await region(managerView.view).boundingBox())!.width-width)).toBeLessThan(5);
    await expect.poll(async()=>Math.abs(await frame.locator('body').evaluate(()=>innerWidth)-width)).toBeLessThan(5);
    // The containing frame and its opaque compositor layer settle separately.
    // Observe geometry and two paint frames, not a fixed sleep after resizing.
    await frame.locator('body').evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
    await page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
  };

  const countBefore=(await query('plugins.instances',{after:null,limit:100})).total;
  await frame.getByRole('button',{name:/Independent View · comparison Inspect retained/}).click();
  await expect(frame.getByText(secondPackage.revision,{exact:true})).toBeVisible();
  for(const width of [1440,1920,390,220]){
    await resize(width);
    expect(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    await page.screenshot({path:info.outputPath(`manager-inspection-${width}.png`)});
    if(width<=390){await frame.getByRole('button',{name:'Back to list'}).click();await expect(frame.locator('#list [aria-pressed=true]')).toBeFocused();await page.screenshot({path:info.outputPath(`manager-list-${width}.png`)});await frame.locator('#list [aria-pressed=true]').click();}
  }
  expect((await query('plugins.instances',{after:null,limit:100})).total).toBe(countBefore);
  await page.setViewportSize({width:1440,height:900});
  await frame.getByRole('button',{name:'Create branch',exact:true}).click();await expect(frame.locator('#notice')).toContainText('Created branch');
  await expect(frame.getByRole('button',{name:'Remove revision',exact:true})).toBeDisabled();
  expect((await query('plugins.inspect',{revision:secondPackage.revision})).summary.revision).toBe(secondPackage.revision);
  // A live unsynchronized field is retained, including its actual iframe.
  await page.getByRole('tab',{name:'Independent View',exact:true}).click();
  const note=region(originalView.view).frameLocator('iframe').getByLabel('View note');await note.fill('Unsaved analysis 中文 Ω');
  const lifetime=await note.evaluate(()=>{(window as any).lifetime=crypto.randomUUID();return(window as any).lifetime;});
  await page.getByRole('tab',{name:'Plugins',exact:true}).click();
  await frame.getByRole('button',{name:'Scenarios',exact:true}).click();
  // The scientific starter is ordinary Manager UI. Missing delivered packages
  // stay missing, and a saved choice never starts a runtime or changes a scene.
  await frame.getByRole('button',{name:'New R workspace',exact:true}).click();
  const workspace=frame.getByRole('dialog',{name:'New R workspace',exact:true});
  await expect(workspace).toBeVisible();
  await workspace.getByLabel('Workspace name',{exact:true}).fill('Scientific study 中文');
  await workspace.getByLabel('Existing Ark executable',{exact:true}).fill('/existing/ark');
  await workspace.getByLabel('Existing R home',{exact:true}).fill('/existing/R');
  await expect(workspace.getByLabel('R runtime',{exact:true})).toContainText('No revision');
  for(const width of [1440,1920,390,220]){
    await resize(width);
    await workspace.evaluate(element=>element.scrollTop=0);
    expect(await workspace.evaluate(element=>{const box=element.getBoundingClientRect();return box.left>=0&&box.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth;})).toBe(true);
    await page.screenshot({path:info.outputPath(`manager-workspace-${width}.png`)});
    await workspace.getByRole('button',{name:'Prepare workspace',exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:info.outputPath(`manager-workspace-bottom-${width}.png`)});
  }
  await workspace.getByRole('button',{name:'Prepare workspace',exact:true}).click();
  await expect(workspace.getByRole('alert')).toContainText('Select an installed r artifact');
  expect((await query('plugins.instances',{after:null,limit:100})).total).toBe(countBefore);
  await workspace.getByRole('button',{name:'Keep choices and close',exact:true}).click();
  await frame.getByRole('button',{name:'New R workspace',exact:true}).click();
  await expect(workspace.getByLabel('Workspace name',{exact:true})).toHaveValue('Scientific study 中文');
  await workspace.getByRole('button',{name:'Keep choices and close',exact:true}).click();
  await resize(1440);
  await frame.getByRole('button',{name:/R analysis Checkpoint/}).click();
  await frame.getByRole('button',{name:'Review switch',exact:true}).click();
  await frame.getByLabel('Instance for manager',{exact:true}).selectOption(manager.instance);
  await frame.getByLabel('View for manager-view',{exact:true}).selectOption(managerView.view);
  await frame.getByLabel('Instance for report',{exact:true}).selectOption(original.instance);
  await expect(frame.getByLabel('View for manager-view',{exact:true})).toHaveValue(managerView.view);
  await frame.getByLabel('View for report-view',{exact:true}).selectOption(originalView.view);
  await frame.getByRole('button',{name:'Prepare selection',exact:true}).click();
  await expect(frame.getByRole('button',{name:'Switch to R analysis',exact:true})).toBeEnabled();
  let lost=false;
  await page.route('**/api/plugin-view',async route=>{
    const body=route.request().postDataJSON()?.message?.body;
    if(!lost&&body?.type==='invoke'&&body.capability.id==='scenarios.apply'){
      lost=true;const response=await route.fetch(),reply=await response.json();
      expect(reply.ok).toBe(true);await route.fulfill({response,json:{id:reply.id,ok:false,error:'Fixture lost the committed acknowledgement'}});
    }else await route.continue();
  });
  await frame.getByRole('button',{name:'Switch to R analysis',exact:true}).click();
  await expect.poll(async()=>(await query('windows.scenario',{window:windowId})).scenario?.revision).toBe(first.id);
  await expect(frame.getByRole('button',{name:'Inspect original request',exact:true})).toBeVisible();
  await frame.getByRole('button',{name:'Installed',exact:true}).click();await frame.getByRole('button',{name:/Independent View · comparison Inspect retained/}).click();
  await expect(frame.getByRole('heading',{name:'Independent View · comparison',exact:true})).toBeVisible();await expect(frame.getByRole('button',{name:'Create branch',exact:true})).toBeDisabled();
  await frame.getByRole('button',{name:'Inspect original request',exact:true}).click();
  await expect(frame.locator('#recovery')).toBeHidden();
  expect(lost).toBe(true);expect((await query('operation.list_recent',{limit:100})).operations.filter((r:any)=>r.capability.id==='scenarios.apply')).toHaveLength(1);
  await page.unroute('**/api/plugin-view');
  await frame.getByRole('button',{name:'Scenarios',exact:true}).click();
  await expect(frame.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
  await frame.getByRole('button',{name:/Report comparison Checkpoint/}).click();await frame.getByRole('button',{name:'Review switch',exact:true}).click();
  await frame.getByLabel('Instance for manager',{exact:true}).selectOption(manager.instance);
  await frame.getByLabel('View for manager-view',{exact:true}).selectOption(managerView.view);
  await frame.getByRole('button',{name:'Prepare selection',exact:true}).click();
  await expect(frame.getByRole('button',{name:'Switch to Report comparison',exact:true})).toBeEnabled();
  for(const width of [1440,1920,390,220]){await resize(width);expect(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await page.screenshot({path:info.outputPath(`manager-scenario-${width}.png`)});}
  await page.setViewportSize({width:1440,height:900});
  await frame.getByRole('button',{name:'Switch to Report comparison',exact:true}).click();
  await expect.poll(async()=>(await query('windows.scenario',{window:windowId})).scenario?.revision).toBe(second.id);
  const selected=(await query('windows.scenario',{window:windowId})).scenario;
  await expect(page.getByRole('tab',{name:'Independent View',exact:true})).toHaveAttribute('aria-controls',`flexlayout-tab-${selected.views['report-view']}`);
  expect(selected.instances.report.revision).toBe(secondPackage.revision);expect(selected.instances.report.instance).not.toBe(original.instance);
  expect((await query('plugins.instance',{instance:original})).instance.state).toBe('active');expect((await query('views.inspect',{view:originalView.view})).closed).toBe(false);
  // Restore by explicitly selecting original live instance and view.
  await expect(frame.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
  await frame.getByRole('button',{name:/R analysis Checkpoint/}).click();await frame.getByRole('button',{name:'Review switch',exact:true}).click();
  await frame.getByLabel('Instance for manager',{exact:true}).selectOption(manager.instance);await frame.getByLabel('Instance for report',{exact:true}).selectOption(original.instance);
  await frame.getByLabel('View for manager-view',{exact:true}).selectOption(managerView.view);
  // Original hidden view is a retained record; selecting it is explicit.
  await frame.getByLabel('View for report-view',{exact:true}).selectOption(originalView.view);
  await frame.getByRole('button',{name:'Prepare selection',exact:true}).click();await expect(frame.getByRole('button',{name:'Switch to R analysis',exact:true})).toBeEnabled();await frame.getByRole('button',{name:'Switch to R analysis',exact:true}).click();
  await expect.poll(async()=>(await query('windows.scenario',{window:windowId})).scenario?.revision).toBe(first.id);
  await expect(page.getByRole('tab',{name:'Independent View',exact:true})).toHaveAttribute('aria-controls',`flexlayout-tab-${originalView.view}`);
  await page.getByRole('tab',{name:'Independent View',exact:true}).click();await expect(note).toHaveValue('Unsaved analysis 中文 Ω');expect(await note.evaluate(()=>(window as any).lifetime)).toBe(lifetime);
  await page.getByRole('tab',{name:'Plugins',exact:true}).click();await frame.getByRole('button',{name:'Instances',exact:true}).click();
  await expect(frame.locator('#list')).toContainText('original-report');await page.screenshot({path:info.outputPath('manager-instances-1440.png')});
  await frame.getByRole('button',{name:/^original-report example/}).click();
  for(const width of [1440,1920,390,220]){await resize(width);expect(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await page.screenshot({path:info.outputPath(`manager-instance-detail-${width}.png`)});}
  await page.setViewportSize({width:1440,height:900});await frame.getByRole('button',{name:'Open view',exact:true}).click();
  await expect(frame.getByRole('dialog')).toBeVisible();await frame.getByLabel('Initial state',{exact:true}).fill('{"text":"Explicitly reopened"}');
  for(const width of [1440,390,220]){await resize(width);expect(await frame.getByRole('dialog').evaluate(e=>e.scrollWidth>e.clientWidth)).toBe(false);await page.screenshot({path:info.outputPath(`manager-open-view-${width}.png`)});}
  await page.setViewportSize({width:1440,height:900});await frame.getByRole('button',{name:'Open view',exact:true}).last().click();
  await expect(page.getByRole('tab',{name:'Independent View',exact:true})).toHaveCount(2);
  const openSummaries=(await query('operation.list_recent',{limit:100})).operations.filter((r:any)=>r.capability.id==='windows.open_view');
  const openRecords=(await Promise.all(openSummaries.map(async(r:any)=>(await query('operation.get',{operation_id:r.operation_id})).record))).filter(r=>r.operation.caller.id===managerView.view);
  expect(openRecords).toHaveLength(1);const opened=openRecords[0].output.view;
  expect(opened.instance).toEqual(original);await expect(region(opened.view).frameLocator('iframe').getByLabel('View note')).toHaveValue('Explicitly reopened');
  await page.getByRole('tab',{name:'Plugins',exact:true}).click();
  await frame.getByRole('button',{name:'Scenarios',exact:true}).click();await frame.getByRole('button',{name:'New scenario',exact:true}).click();
  await frame.getByLabel('Scenario definition',{exact:true}).fill('{ invalid source 中文');await frame.getByRole('button',{name:'Save checkpoint',exact:true}).click();await expect(frame.locator('#edit-error')).toContainText('JSON');
  await frame.getByRole('button',{name:'Keep draft and close',exact:true}).click();await frame.getByRole('button',{name:'Continue draft',exact:true}).click();await expect(frame.getByLabel('Scenario definition',{exact:true})).toHaveValue('{ invalid source 中文');
  // A native pre-admission schema rejection leaves the draft editable.
  await frame.getByLabel('Scenario definition',{exact:true}).fill('{"invalid":true}');await frame.getByRole('button',{name:'Save checkpoint',exact:true}).click();
  await expect(frame.locator('#edit-error')).not.toBeEmpty();await expect(frame.locator('#recovery')).toBeHidden();
  const draft={scenario:'recovered-draft',expected_head:null,name:'Recovered draft',instances:{},providers:[],layout:{kind:'empty'}};
  await frame.getByLabel('Scenario definition',{exact:true}).fill(JSON.stringify(draft));await frame.getByRole('button',{name:'Save checkpoint',exact:true}).click();
  await expect(frame.getByRole('dialog')).toBeHidden();await expect(frame.getByRole('heading',{name:'Recovered draft',exact:true})).toBeVisible();
  const saved=(await query('scenarios.list',{after:null,limit:100})).scenarios.find((s:any)=>s.scenario===draft.scenario);
  expect((await query('windows.scenario',{window:windowId})).scenario.revision,'checkpoint saving does not switch').toBe(first.id);
  await frame.getByRole('button',{name:'Edit checkpoint',exact:true}).click();
  await expect(frame.getByRole('dialog')).toBeVisible();
  const child=JSON.parse(await frame.getByLabel('Scenario definition',{exact:true}).inputValue());child.name='Recovered child';
  await frame.getByLabel('Scenario definition',{exact:true}).fill(JSON.stringify(child));await frame.getByRole('button',{name:'Save checkpoint',exact:true}).click();
  await expect(frame.getByRole('heading',{name:'Recovered child',exact:true})).toBeVisible();
  const newer=(await query('scenarios.list',{after:null,limit:100})).scenarios.find((s:any)=>s.scenario===draft.scenario);
  expect((await query('scenarios.get',{revision:newer.revision})).parent).toBe(saved.revision);
  expect((await query('scenarios.get',{revision:saved.revision})).name).toBe('Recovered draft');
  await expect(page.getByRole('button',{name:'Use saved layout',exact:true})).toHaveCount(0);
  expect(errors).toEqual([]);completed=true;
});
