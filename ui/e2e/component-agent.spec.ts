/** Exact Help/Viewer sources through ordinary view opening and Agent draft insertion. */
import {test,expect} from '@playwright/test';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
let directory:string,project:string,url:URL,host:ReturnType<typeof spawn>,r:any,agent:any,help:any,viewer:any,session:string,firstRun:any;
let completed=false;const windowId='component-input-window',binary=resolve('../target/debug/rho');
async function port(method:string,params:any){const result=await fetch(new URL('/api/host',url),{method:'POST',headers:{Authorization:`Bearer ${url.hash.slice(7)}`,'Content-Type':'application/json','X-Rho-Studio-Window':windowId},body:JSON.stringify({project_root:project,frame:{id:crypto.randomUUID(),request:{method,params}}})}).then(r=>r.json());if(!result.ok)throw Error(result.error);return result.result;}
async function query(id:string,args:any){return(await port('query_snapshot',{capability:{id,version:1},arguments:args})).data;}
async function invoke(id:string,args:any,version=1){const result=await port('invoke',{capability:{id,version},arguments:args,preconditions:[],client_request_id:crypto.randomUUID()});expect(result.status,JSON.stringify(result.error)).toBe('succeeded');return result.output;}
async function binding(instance:any,id:string,version=1){return query('plugins.resolve',{instance,capability:{id,version}});}
async function run(code:string){return invoke('r.execute',{binding:await binding(r,'r.execute',2),arguments:{expected_session:session,run:{code,source:{view_id:'fixture',label:'Component context setup',kind:'console'}}}},2);}
async function open(instance:any,contribution:string,configuration:any){const layout=await query('windows.layout',{window:windowId});return(await invoke('windows.open_view',{expected_layout_version:layout.version,group:layout.layout.kind==='tabs'?layout.layout.id:null,view:{instance,contribution,window:windowId,configuration,state:{}}})).view;}
test.beforeAll(async()=>{
 test.setTimeout(180000);
 for(const name of ['RHO_R_PLUGIN_PACKAGE','RHO_AGENT_PLUGIN_PACKAGE','RHO_HELP_PLUGIN_PACKAGE','RHO_VIEWER_PLUGIN_PACKAGE','RHO_ARK','RHO_R_HOME'])if(!process.env[name])throw Error(`Supply retained ${name}; this case does not build or install.`);
 directory=realpathSync(mkdtempSync(join(tmpdir(),'rho-component-agent-')));project=join(directory,'project');mkdirSync(project);const database=join(directory,'state.sqlite');
 const packages:any={};for(const name of ['r','agent','help','viewer'])packages[name]=JSON.parse(execFileSync(binary,['--database',database,'plugins','snapshot',process.env[`RHO_${name.toUpperCase()}_PLUGIN_PACKAGE`]!,'--target',['r','agent'].includes(name)?'aarch64-apple-darwin':'ui-web'],{encoding:'utf8',timeout:90000})).result;
 host=spawn(binary,['--database',database,'--project',project,'workbench'],{stdio:['ignore','pipe','pipe']});
 url=new URL(await new Promise<string>((done,reject)=>{let output='',errors='';const timer=setTimeout(()=>reject(Error(`Host startup deadline: ${errors}`)),60000);host.stderr!.on('data',data=>errors+=data);host.stdout!.on('data',data=>{output+=data;const found=output.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);if(found){clearTimeout(timer);done(found[0]);}});host.once('exit',code=>{clearTimeout(timer);reject(Error(`Host exited ${code}: ${errors}`));});}));
 const activate=async(name:string,configuration:any={},optional:string[]=[])=> (await invoke('plugins.activate',{revision:packages[name].revision,artifact:packages[name].artifacts[0],target:['r','agent'].includes(name)?'aarch64-apple-darwin':'ui-web',alias:name,configuration,optional_capabilities:optional.map(id=>({id,version:1}))})).instance.identity;
 r=await activate('r',{ark:realpathSync(process.env.RHO_ARK!),r_home:realpathSync(process.env.RHO_R_HOME!),execution_timeout_seconds:30},['operation.get','operation.list_recent','resources.read']);
 agent=await activate('agent',{},['plugins.instances','plugins.inspect','r.context.help.preview','r.context.viewer.preview']);
 const helpInstance=await activate('help'),viewerInstance=await activate('viewer');
 session=(await invoke('r.create_session',{binding:await binding(r,'r.create_session'),arguments:{}})).session_id;
 firstRun=await run('invisible(loadNamespace("tools")); invisible(loadNamespace("utils")); writeLines("<h1>Original saved HTML 中文 Ω</h1><p>Exact first output</p>", "original.html"); getOption("viewer")("original.html")');
 const inventory=await query('r.packages',{binding:await binding(r,'r.packages'),arguments:{expected_session:session,filter:'stats',grouped:true}});expect(inventory.status).toBe('ready');
 const copies=await query('r.packages',{binding:await binding(r,'r.packages'),arguments:{expected_session:session,observation_id:inventory.data.observation_id,package_name:'stats'}});
 const installed=copies.data.packages.find((item:any)=>item.name==='stats');expect(installed).toBeTruthy();
 help=await open(helpInstance,'help',{source:r,copy:{nativeSession:session,observation:inventory.data.observation_id,package:'stats',libraryPath:installed.library_path,version:installed.version},topic:'lm'});
 viewer=await open(viewerInstance,'viewer',{source:r});
});
test.afterAll(async()=>{if(host?.exitCode===null)await new Promise<void>((done,reject)=>{const timer=setTimeout(()=>reject(Error('Disposable Host shutdown deadline')),60000);host.once('exit',code=>{clearTimeout(timer);code===0?done():reject(Error(`Host shutdown ${code}`));});host.kill('SIGINT');});if(completed)rmSync(directory,{recursive:true,force:true});else if(directory)console.error(`Component input fixture retained at ${directory}`);});
test('Help and Viewer open Agent with their original exact sources, preserve drafts and recover lost opening replies',async({page},info)=>{
 test.setTimeout(180000);const address=new URL(url);address.searchParams.set('window',windowId);await page.goto(address.href);
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const frame=(view:any)=>page.locator(`[data-plugin-frame="${view.view}"]`).frameLocator('iframe');
 const inputs:any[]=[];let opens=0,lost=false;
 await page.route('**/api/plugin-view',async route=>{const body=route.request().postDataJSON()?.message?.body;
  if(body?.type==='invoke'&&body.capability?.id==='windows.open_view'){opens++;if(opens===2){lost=true;await route.fetch();await route.abort('failed');return;}}await route.continue();});
 for(const [kind,source] of [['Help',help],['Viewer',viewer]] as const){
  await page.getByRole('tab',{name:kind,exact:true}).click();const sender=frame(source);
  if(kind==='Help')await expect(sender.locator('.help-content')).toContainText('Fitting Linear Models');
  else {
   await expect(sender.locator('#refresh')).toBeEnabled();
   // Other view/task operations can push the original R run beyond the first
   // bounded journal page. Select it through the actual history controls.
   for(let page=0;page<8&&await sender.locator('#surface iframe').count()===0&&await sender.getByRole('button',{name:'Load earlier runs'}).isVisible();page++){
    await sender.getByRole('button',{name:'Load earlier runs'}).click();await expect(sender.locator('#earlier')).toBeEnabled();
   }
   await expect(sender.frameLocator('#surface iframe').getByRole('heading')).toHaveText('Original saved HTML 中文 Ω');
  }
  await sender.getByRole('button',{name:'Ask about…',exact:true}).click();const dialog=sender.getByRole('dialog',{name:'Ask about this input'});
  if(kind==='Help')await dialog.getByLabel('Include',{exact:true}).selectOption('excerpt');
  await expect(dialog.locator('[data-input="preview"]')).toContainText(kind==='Help'?'Fitting Linear Models':'Original saved HTML');
  await dialog.getByLabel('Agent instance',{exact:true}).selectOption(agent.instance);await expect(dialog.getByRole('button',{name:'Open Agent',exact:true})).toBeEnabled();
  const captured=(await query('views.inspect',{view:source.view})).state.agent.input;inputs.push(captured);
  if(kind==='Viewer'){
   await run('writeLines("<h1>Later saved output</h1>", "later.html"); getOption("viewer")("later.html")');
   await expect(sender.frameLocator('#surface iframe').getByRole('heading')).toHaveText('Later saved output');
   await expect(dialog.locator('[data-input="preview"]')).toContainText('Original saved HTML');
   await expect.poll(async()=>(await query('views.inspect',{view:source.view})).state.agent.input.reference).toEqual(captured.reference);
   expect(captured.reference.selector.operation).toBe(firstRun.operation_id);
  }
  for(const width of [960,390,220]){await page.setViewportSize({width,height:900});await expect.poll(()=>dialog.evaluate((element,width)=>{const rect=element.getBoundingClientRect();return Math.abs(innerWidth-width)<4&&rect.left>=0&&rect.right<=innerWidth;},width)).toBe(true);expect(await dialog.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await page.screenshot({path:info.outputPath(`${kind.toLowerCase()}-agent-${width}.png`)});}
  await page.setViewportSize({width:960,height:900});await dialog.getByRole('button',{name:'Open Agent',exact:true}).click();
  await expect(page.getByRole('tab',{name:'Agent',exact:true})).toHaveCount(kind==='Help'?1:2);
  if(kind==='Viewer'){
   await page.reload();await page.getByRole('tab',{name:'Viewer',exact:true}).click();await sender.getByRole('button',{name:'Ask about…',exact:true}).click();
   await dialog.getByRole('button',{name:'Check original request',exact:true}).click();await expect(dialog.locator('[data-input="status"]')).toContainText('Agent view opened');
   await dialog.getByRole('button',{name:'Back to source',exact:true}).click();
  }
  await expect.poll(async()=>(await query('views.inspect',{view:source.view})).state.agent.pending).toBeNull();
  const opened=(await query('views.inspect',{view:source.view})).state.agent.opened;await page.getByRole('tab',{name:'Agent',exact:true}).last().click();const receiver=frame(opened);
  await receiver.getByRole('button',{name:'New task',exact:true}).click();await receiver.getByRole('button',{name:'Rho',exact:true}).click();
  const composer=receiver.getByRole('textbox',{name:'Agent message',exact:true});await expect(composer).toBeEnabled();const prompt=`Explain this ${kind} input 中文`;await composer.fill(prompt);
  const task=(await receiver.getByLabel('Select task',{exact:true}).inputValue()).slice(4);const taskBinding=await binding(agent,'agent.model.conversation');const detail=()=>query('agent.model.conversation',{binding:taskBinding,arguments:{conversation_id:task}});
  await expect.poll(async()=>(await detail()).draft).toBe(prompt);await receiver.locator('#component-request summary').click();
  await receiver.getByRole('button',{name:'Preview '+captured.title,exact:true}).click();const preview=receiver.getByRole('dialog',{name:'Choose context'});
  await expect(preview.locator('#context-preview')).toContainText(kind==='Help'?'Fitting Linear Models':'Original saved HTML');await preview.getByRole('button',{name:'Close context'}).click();
  await receiver.getByRole('button',{name:'Add context to draft',exact:true}).click();await expect.poll(async()=>(await detail()).draft_content.context.length).toBe(1);
  expect((await detail()).draft_content.context[0].reference).toEqual(captured.reference);expect((await detail()).draft).toBe(prompt);
  await page.reload();await expect(receiver.locator('#task-state')).toHaveText('Rho · Ready');await expect(receiver.locator('#draft-status')).toHaveText('Draft saved');await expect(composer).toHaveValue(prompt);await expect(receiver.locator('#selected-context')).toContainText(captured.title);await page.screenshot({path:info.outputPath(`${kind.toLowerCase()}-agent-restored.png`)});
 }
 expect(lost).toBe(true);expect(opens).toBe(2);const recent=await query('operation.list_recent',{limit:100});expect(recent.next_cursor).toBeNull();
 expect(recent.operations.filter((item:any)=>item.capability.id==='r.execute')).toHaveLength(2);
 expect(recent.operations.filter((item:any)=>['agent.model.run','agent.native.command'].includes(item.capability.id))).toHaveLength(0);
 expect((await query('r.session',{binding:await binding(r,'r.session'),arguments:{}})).session_id).toBe(session);expect(errors).toEqual([]);
 writeFileSync(info.outputPath('component-agent-result.json'),JSON.stringify({inputs,opened_views:opens,lost_reply_recovered:lost,session,explicit_setup_executions:2,agent_sends:0},null,2));completed=true;
});
