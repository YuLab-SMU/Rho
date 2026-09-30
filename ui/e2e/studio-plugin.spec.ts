import {test,expect} from '@playwright/test';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,realpath,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {buildStudioPlugin} from '../../scripts/build-studio-plugin.mjs';
import {buildUiFixture} from '../../scripts/fixtures/plugin-ui.mjs';
let directory:string,project:string,url:URL,host:ReturnType<typeof spawn>,completed=false,studioView:any,subject:any;
const windowId='studio-window';
const node=(kind='container')=>({kind,children:[],properties:{},style_tokens:{},bindings:{},visible_when:null,events:{},component:null});
const declaration={format_version:1,root:'root',nodes:{root:{...node(),children:['heading','controls','plot']},heading:{...node('text'),properties:{text:'Report overview'},style_tokens:{font_size:'24px'}},controls:{...node('split'),children:['open-report','caption'],properties:{direction:'horizontal'}},'open-report':{...node('button'),properties:{label:'Open report'},events:{click:[{kind:'invoke',capability:{id:'science.should_never_run',version:1},arguments:{}}]}},caption:{...node('text'),properties:{text:'Choose a report to inspect.'},visible_when:{kind:'equals',binding:{source:'report',path:[]},value:{ready:true,count:2}}},plot:{...node('custom'),component:'report-frame'}},data_sources:{report:{capability:{id:'science.fixture_only',version:1},arguments:{},subscribe:false}},components:{'report-frame':{source:'src/ReportFrame.ts',export:'ReportFrame',properties_schema:{},input_schema:{},output_schema:{}}}};
async function port(method:string,params:any){const response=await fetch(new URL('/api/host',url),{method:'POST',headers:{Authorization:`Bearer ${url.hash.slice(7)}`,'Content-Type':'application/json','X-Rho-Studio-Window':windowId},body:JSON.stringify({project_root:project,frame:{id:crypto.randomUUID(),request:{method,params}}})}).then(r=>r.json());if(!response.ok)throw Error(response.error);return response.result;}
async function query(id:string,args:any){return(await port('query_snapshot',{capability:{id,version:1},arguments:args})).data;}
async function allOperations(){const operations:any[]=[];let before_cursor:number|null=null;for(let page=0;page<20;page++){const result=await query('operation.list_recent',{limit:100,before_cursor});operations.push(...result.operations);if(result.next_cursor===null)return operations;before_cursor=result.next_cursor;}throw Error('Fixture operation history exceeded its 2000-record bound.');}
async function invoke(id:string,args:any){let result=await port('invoke',{capability:{id,version:1},arguments:args,client_request_id:crypto.randomUUID(),preconditions:[]});expect(result.status,result.error).toBe('succeeded');return result.output;}
test.beforeAll(async()=>{
 directory=await mkdtemp(join(tmpdir(),'rho-studio-browser-'));project=join(directory,'project');await mkdir(project);project=await realpath(project);
 const database=join(directory,'state.sqlite'),binary=resolve('../target/debug/rho');
 const snapshot=(path:string)=>JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',path],{encoding:'utf8'})).result;
 const studio=snapshot(buildStudioPlugin(join(directory,'studio'))),subjectPath=buildUiFixture(directory);
 const manifest=JSON.parse(await readFile(join(subjectPath,'plugin.json'),'utf8'));manifest.requires=manifest.requires.filter((r:any)=>r.capability.id!=='fixture.answer');manifest.name='Report viewer';manifest.description='Inspect a report while retaining live analysis.';
 await mkdir(join(subjectPath,'views'));await mkdir(join(subjectPath,'src'),{recursive:true});
 await writeFile(join(subjectPath,'views/report.json'),JSON.stringify(declaration,null,2)+'\n');await writeFile(join(subjectPath,'src/ReportFrame.ts'),'export const ReportFrame = () => "Opaque custom report 中文";\n');
 manifest.source.files.push('views/report.json','src/ReportFrame.ts');await writeFile(join(subjectPath,'plugin.json'),JSON.stringify(manifest,null,2));subject=snapshot(subjectPath);
 host=spawn(binary,['--database',database,'--project',project,'--plugins-only','workbench'],{stdio:['ignore','pipe','pipe']});
 url=new URL(await new Promise<string>((done,reject)=>{let out='',errors='';const timer=setTimeout(()=>reject(Error(`Host startup timed out: ${errors}`)),40000);host.stderr!.on('data',b=>errors+=b);host.stdout!.on('data',b=>{out+=b;const found=out.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);if(found){clearTimeout(timer);done(found[0]);}});host.once('exit',code=>{clearTimeout(timer);reject(Error(`Host exited ${code}: ${errors}`));});}));
 const instance=(await invoke('plugins.activate',{revision:studio.revision,artifact:studio.artifacts[0],target:'ui-web',alias:'development',configuration:{}})).instance.identity;
 studioView=(await invoke('windows.open_view',{expected_layout_version:0,group:null,view:{instance,window:windowId,contribution:'studio',configuration:{},state:{}}})).view;
});
test.afterAll(async()=>{if(host?.exitCode===null){host.kill('SIGINT');await new Promise<void>(done=>host.once('exit',()=>done()));}if(directory&&completed)await rm(directory,{recursive:true,force:true});else if(directory)console.error(`Studio fixture retained at ${directory}`);});
test('ordinary Studio edits real source with inert fixtures, shared history and original recovery',async({page},info)=>{
 test.setTimeout(180000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const address=new URL(url);address.searchParams.set('window',windowId);address.searchParams.set('plugin-window','');await page.goto(address.href);
 const region=page.locator(`[data-plugin-frame="${studioView.view}"]`),frame=region.frameLocator('iframe'),source=frame.getByRole('textbox',{name:'Source editor',exact:true});
 await expect(frame.getByRole('heading',{name:'Plugin Studio',exact:true})).toBeVisible();await expect(frame.getByRole('button',{name:'Choose revision',exact:true})).toBeEnabled();
 await frame.getByRole('button',{name:'Choose revision',exact:true}).click();await frame.getByRole('button',{name:/Report viewer ·/}).click();await frame.getByLabel('Development branch name').fill('report-controls');await frame.getByRole('button',{name:'Create branch from selected',exact:true}).click();
 await expect(frame.getByRole('dialog')).toBeHidden();await expect(frame.locator('#subtitle')).toContainText('report-controls');
 // The source package identity is authoritative, even if the fixture ID changes.
 const branches=await query('plugins.branches',{plugin:(await query('plugins.inspect',{revision:subject.revision})).summary.plugin,after:null,limit:100});const branchId=branches.branches[0].id;
 await expect(frame.locator('#canvas')).toContainText('Report overview');const countBefore=(await query('operation.list_recent',{limit:100})).operations.length;
 // Real canvas conditions use structural JSON equality and do not query their source.
 const caption=frame.locator('#canvas [data-node="caption"]');
 await expect(caption).toHaveClass(/condition-hidden/);
 await frame.getByLabel('Fixture data by source name',{exact:true}).fill(JSON.stringify({report:{count:2,ready:true}}));
 await frame.getByRole('button',{name:'Update fixture data',exact:true}).click();
 await expect(caption).not.toHaveClass(/condition-hidden/);
 await frame.getByRole('button',{name:'Save draft',exact:true}).click();
 await expect(frame.locator('#sync')).toHaveText('Draft synchronized');await page.reload();
 await expect(caption).not.toHaveClass(/condition-hidden/);
 await frame.locator('#canvas').getByRole('button',{name:'Open report',exact:true}).click();await expect(frame.locator('#node-id')).toContainText('open-report');
 await frame.getByLabel('Text / label',{exact:true}).fill('Open analysis report');await expect(frame.locator('#canvas').getByRole('button',{name:'Open analysis report',exact:true})).toBeVisible();
 await frame.getByRole('button',{name:'Declaration',exact:true}).click();const valid=await source.inputValue();expect(valid).toContain('Open analysis report');
 await source.fill(valid.slice(0,-8));await expect(frame.locator('#invalid')).toContainText('Source retained');await frame.getByRole('button',{name:'Canvas',exact:true}).click();await expect(frame.locator('#canvas')).toContainText('Open analysis report');
 await frame.getByRole('button',{name:'Save draft',exact:true}).click();await expect(frame.locator('#sync')).toHaveText('Draft synchronized');await page.reload();await expect(frame.locator('#invalid')).toContainText('Source retained');await expect(frame.locator('#canvas')).toContainText('Open analysis report');
 await frame.getByRole('button',{name:'Undo',exact:true}).click();await expect(frame.locator('#invalid')).toBeHidden();await frame.getByRole('button',{name:'Undo',exact:true}).click();await expect(frame.locator('#canvas')).toContainText('Open report');await frame.getByRole('button',{name:'Redo',exact:true}).click();
 // Native composition events keep intermediate text out of the shared history.
 await frame.getByRole('button',{name:'Source files',exact:true}).click();await frame.getByRole('button',{name:'src/ReportFrame.ts',exact:true}).click();
 await expect(source).toHaveValue(/Opaque custom report/);const custom=await source.inputValue();await frame.getByRole('button',{name:'Copy source',exact:true}).click();await expect(frame.locator('#notice')).toHaveText('Source copied.');await page.context().grantPermissions(['clipboard-read'],{origin:url.origin});try{expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(custom);}finally{await page.context().clearPermissions();}await source.evaluate((input,text)=>{const element=input as HTMLTextAreaElement;element.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));element.value=text+'// 中';element.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));element.value=text+'// 中文 Ω';element.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));element.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文 Ω'}));},custom);
 await expect(source).toHaveValue(custom+'// 中文 Ω');await source.press('Meta+z');await expect(source).toHaveValue(custom);await frame.getByRole('button',{name:'Redo',exact:true}).click();await expect(source).toHaveValue(custom+'// 中文 Ω');

 // Hold a successful older save receipt while a newer input arrives.
 let releaseSave!:()=>void,saveStarted!:()=>void;const heldSave=new Promise<void>(resolve=>saveStarted=resolve),release=new Promise<void>(resolve=>releaseSave=resolve);let held=false;
 await page.route('**/api/plugin-view',async route=>{const body=route.request().postDataJSON()?.message?.body;if(!held&&body?.type==='invoke'&&body.capability.id==='documents.save'){held=true;const response=await route.fetch();saveStarted();await release;await route.fulfill({response});}else await route.continue();});
 await source.fill(custom+'// first capture');await heldSave;await source.fill(custom+'// newest 中文 Ω');expect(await source.inputValue()).toBe(custom+'// newest 中文 Ω');releaseSave();await expect(frame.locator('#sync')).toHaveText('Draft synchronized');await page.unroute('**/api/plugin-view');await page.reload();await expect(source).toHaveValue(custom+'// newest 中文 Ω');
 await frame.getByRole('button',{name:'views/report.json',exact:true}).click();await frame.getByRole('button',{name:'Canvas',exact:true}).click();
 await frame.getByRole('button',{name:'caption · text',exact:true}).dragTo(frame.getByRole('button',{name:'root · container',exact:true}));await frame.getByRole('button',{name:'Declaration',exact:true}).click();expect(JSON.parse(await source.inputValue()).nodes.root.children).toContain('caption');await frame.getByRole('button',{name:'Canvas',exact:true}).click();
 await frame.getByRole('button',{name:'Check source',exact:true}).click();await expect(frame.locator('#notice')).toContainText('Source valid');
 let lost=false;await page.route('**/api/plugin-view',async route=>{const body=route.request().postDataJSON()?.message?.body;if(!lost&&body?.type==='invoke'&&body.capability.id==='plugins.checkpoint'){lost=true;const response=await route.fetch(),reply=await response.json();expect(reply.ok).toBe(true);await route.fulfill({response,json:{id:reply.id,ok:false,error:'Fixture lost the committed source acknowledgement'}});}else await route.continue();});
 await frame.getByRole('button',{name:'Checkpoint',exact:true}).click();await expect(frame.getByRole('button',{name:'Inspect original request',exact:true})).toBeVisible();const newHead=(await query('plugins.branch_head',{branch:branchId})).revision;expect(newHead).not.toBe(subject.revision);
 await page.reload();await expect(frame.getByRole('button',{name:'Inspect original request',exact:true})).toBeVisible();await frame.getByRole('button',{name:'Inspect original request',exact:true}).click();await expect(frame.locator('#recovery')).toBeHidden();expect((await query('plugins.branch_head',{branch:branchId})).revision).toBe(newHead);await page.unroute('**/api/plugin-view');
 expect((await query('plugins.inspect',{revision:newHead})).artifacts).toHaveLength(0);expect((await query('plugins.inspect',{revision:subject.revision})).artifacts.length).toBeGreaterThan(0);
 await frame.getByRole('button',{name:'Dismiss notice',exact:true}).click();
 const resize=async(width:number)=>{await page.setViewportSize({width,height:900});await expect(region).toBeVisible();await expect.poll(async()=>{const box=await region.boundingBox();return box?Math.abs(box.width-width):Infinity;}).toBeLessThan(5);await expect.poll(async()=>Math.abs(await frame.locator('body').evaluate(()=>innerWidth)-width)).toBeLessThan(5);await frame.locator('body').evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));await page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));};
 for(const width of [1440,1920,390,220]){await resize(width);expect(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await page.screenshot({path:info.outputPath(`studio-canvas-${width}.png`)});if(width<=390){await frame.getByRole('button',{name:'Source & nodes',exact:true}).click();await expect(frame.locator('#files [aria-current=true]')).toBeFocused();await page.screenshot({path:info.outputPath(`studio-navigation-${width}.png`)});await frame.getByRole('button',{name:'views/report.json',exact:true}).click();await frame.getByRole('button',{name:'Declaration',exact:true}).click();await expect(source).toBeVisible();await page.screenshot({path:info.outputPath(`studio-source-${width}.png`)});await frame.getByRole('button',{name:'Selected node',exact:true}).click();await expect(frame.getByRole('textbox',{name:'Node properties',exact:true})).toBeVisible();await page.screenshot({path:info.outputPath(`studio-properties-${width}.png`)});await frame.getByRole('button',{name:'Back to editor',exact:true}).click();await frame.getByRole('button',{name:'Canvas',exact:true}).click();}}
 await resize(1440);await frame.getByRole('button',{name:'History',exact:true}).click();await expect(frame.locator('#revisions button')).toHaveCount(2);await frame.getByText('src/ReportFrame.ts · changed',{exact:true}).click();await expect(frame.locator('#changes')).toContainText('中文 Ω');await page.screenshot({path:info.outputPath('studio-history-wide.png')});
 await resize(390);await frame.locator('#revisions button').first().click();await expect(frame.getByRole('button',{name:'Back to checkpoints',exact:true})).toBeVisible();await page.screenshot({path:info.outputPath('studio-history-narrow.png')});await frame.getByRole('button',{name:'Back to checkpoints',exact:true}).click();await expect(frame.locator('#revisions [aria-current=true]')).toBeFocused();
 await frame.locator('#revisions button').last().click();await frame.getByRole('button',{name:'Restore source as checkpoint',exact:true}).click();await expect(frame.locator('#notice')).toContainText('History restored');const restoredHead=(await query('plugins.branch_head',{branch:branchId})).revision;expect(restoredHead).not.toBe(subject.revision);expect(restoredHead).not.toBe(newHead);expect((await query('plugins.inspect',{revision:restoredHead})).parent).toBe(newHead);
 expect((await query('plugins.compare',{before:subject.revision,after:restoredHead})).files).toHaveLength(0);
 await frame.getByRole('button',{name:'Back to editor',exact:true}).click();await resize(1440);
 await frame.getByRole('button',{name:'Build & preview',exact:true}).click();await expect(frame.getByRole('heading',{name:'Preview & diagnostics',exact:true})).toBeVisible();
 await expect(frame.locator('#development-source')).toContainText('not built');
 let lostBuild=false;await page.route('**/api/plugin-view',async route=>{const body=route.request().postDataJSON()?.message?.body;if(!lostBuild&&body?.type==='invoke'&&body.capability.id==='plugins.build'){lostBuild=true;const response=await route.fetch(),reply=await response.json();expect(reply.ok).toBe(true);await route.fulfill({response,json:{id:reply.id,ok:false,error:'Fixture lost the original build acknowledgement'}});}else await route.continue();});
 await frame.getByRole('button',{name:'Build checkpoint',exact:true}).click();await expect(frame.locator('#development-pending')).toBeVisible();
 await expect.poll(async()=>(await query('plugins.inspect',{revision:restoredHead})).artifacts.length).toBe(1);
 await page.reload();await expect(frame.getByRole('button',{name:'Build & preview',exact:true})).toBeEnabled();await frame.getByRole('button',{name:'Build & preview',exact:true}).click();
 await frame.getByRole('button',{name:'Inspect original result',exact:true}).click();await expect(frame.locator('#development-pending')).toBeHidden();await expect(frame.locator('#build-status')).toContainText('Build succeeded');await page.unroute('**/api/plugin-view');
 expect((await query('operation.list_recent',{limit:100})).operations.filter((r:any)=>r.capability.id==='plugins.build')).toHaveLength(1);
 await frame.getByText('Preview configuration and fixture data',{exact:true}).click();
 await frame.getByLabel('Initial view state',{exact:true}).fill(JSON.stringify({text:'Preview 中文 Ω'}));
 await frame.getByLabel('Exact query fixtures',{exact:true}).fill(JSON.stringify([{capability:{id:'plugins.list',version:1},arguments:{after:null,limit:10},data:{total:73}}]));
 await frame.getByRole('button',{name:'Start preview',exact:true}).click();
 await expect(page.locator('[data-plugin-preview=fixture]')).toBeVisible();
 const previews=(await query('plugins.instances',{after:null,limit:100,include_previews:true})).instances.filter((item:any)=>item.instance.purpose==='fixture_preview');expect(previews).toHaveLength(1);expect(previews[0].instance.identity.revision).toBe(restoredHead);
 const previewLayout=await query('windows.layout',{window:windowId});expect(previewLayout.layout.kind).toBe('tabs');const previewRecord=await query('views.inspect',{view:previewLayout.layout.selected});expect(previewRecord.purpose).toBe('fixture_preview');
 const previewFrame=page.locator(`[data-plugin-frame="${previewRecord.view}"]`).frameLocator('iframe');
 await expect(previewFrame.getByLabel('View note',{exact:true})).toHaveValue('Preview 中文 Ω');await previewFrame.getByRole('button',{name:'Read plugins',exact:true}).click();await expect(previewFrame.locator('#result')).toHaveText('Plugins: 73');
 await previewFrame.getByLabel('View note',{exact:true}).fill('Retain this preview draft 中文');
 await page.getByRole('tab',{name:'Plugin Studio',exact:true}).click();await expect(region).toBeVisible();await expect(frame.locator('#preview-instance')).toBeVisible();await expect(frame.locator('#preview-instance')).toContainText('view open');
 for(const width of [1440,1920,390,220]){await resize(width);await frame.locator('#development-dialog').evaluate(dialog=>dialog.scrollTop=0);expect(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await page.screenshot({path:info.outputPath(`studio-development-${width}.png`)});}
 await resize(1440);await frame.getByRole('button',{name:'Close preview view',exact:true}).click();await expect(frame.locator('#preview-instance')).toContainText('view closed');
 expect((await query('views.inspect',{view:previewRecord.view})).state.text).toBe('Retain this preview draft 中文');
 await frame.getByRole('button',{name:'Release preview',exact:true}).click();await expect(frame.locator('#preview-lifecycle')).toBeHidden();
 expect((await query('plugins.instance',{instance:previews[0].instance.identity})).instance.state).toBe('released');expect(lostBuild).toBe(true);
 // A long declared build can be stopped only through its original accepted Operation.
 await frame.getByRole('button',{name:'Back to editor',exact:true}).click();await frame.getByRole('button',{name:'Source files',exact:true}).click();await frame.getByRole('button',{name:'build.mjs',exact:true}).click();
 await expect(frame.locator('#path')).toHaveText('build.mjs');await expect(source).toBeEnabled();const recipe=await source.inputValue();expect(recipe).toContain("import{cpSync}from'node:fs'");await source.fill('await new Promise(done=>setTimeout(done,30000));\n'+recipe);await frame.getByRole('button',{name:'Checkpoint',exact:true}).click();await expect(frame.locator('#notice')).toContainText('Source checkpoint');
 const slowHead=(await query('plugins.branch_head',{branch:branchId})).revision;expect(slowHead).not.toBe(restoredHead);
 await frame.getByRole('button',{name:'Build & preview',exact:true}).click();await frame.getByLabel('Build timeout (minutes)',{exact:true}).fill('60');await frame.getByRole('button',{name:'Build checkpoint',exact:true}).click();
 await expect(frame.locator('#build-status')).toContainText('Build running');await expect(frame.getByRole('button',{name:'Request build stop',exact:true})).toBeEnabled();
 const pendingBuild=(await query('operation.list_recent',{limit:100})).operations.find((record:any)=>record.capability.id==='plugins.build'&&record.status==='running');expect(pendingBuild).toBeTruthy();
 expect((await query('operation.get',{operation_id:pendingBuild.operation_id})).record.operation.normalized_arguments.timeout_ms).toBe(3600000);
 await page.screenshot({path:info.outputPath('studio-build-running.png')});
 await frame.getByRole('button',{name:'Request build stop',exact:true}).click();
 await expect.poll(async()=>(await query('operation.get',{operation_id:pendingBuild.operation_id})).record.status).toBe('cancelled');
 await expect.poll(()=>frame.locator('#development-pending').evaluate(el=>el.hidden||!(document.getElementById('inspect-development') as HTMLButtonElement).disabled)).toBe(true);
 if(await frame.getByRole('button',{name:'Inspect original result',exact:true}).isEnabled())await frame.getByRole('button',{name:'Inspect original result',exact:true}).click();
 await expect(frame.locator('#build-status')).toContainText('Build cancelled');await expect(frame.locator('#development-pending')).toBeHidden();await expect(frame.getByRole('button',{name:'Start preview',exact:true})).toBeDisabled();
 expect((await query('plugins.inspect',{revision:slowHead})).artifacts).toHaveLength(0);expect((await query('plugins.inspect',{revision:restoredHead})).artifacts).toHaveLength(1);
 await page.screenshot({path:info.outputPath('studio-build-cancelled.png')});
 const operations=await allOperations();expect(operations.filter((r:any)=>r.capability.id==='plugins.checkpoint')).toHaveLength(3);expect(operations.filter((r:any)=>r.capability.id==='science.should_never_run'||r.capability.id==='science.fixture_only')).toHaveLength(0);expect(countBefore).toBeGreaterThan(0);expect(errors).toEqual([]);expect(lost).toBe(true);completed=true;
});
