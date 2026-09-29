import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, copyFile, chmod, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
let directory:string,url:string,host:ReturnType<typeof spawn>,log:string;
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test.beforeAll(async()=>{
 directory=await mkdtemp(join(tmpdir(),'rho-task-browser-'));const project=join(directory,'study'),bin=join(directory,'bin');await mkdir(project);await mkdir(bin);await mkdir(join(directory,'kimi-home'));
 await writeFile(join(project,'notes.txt'),'Verified context fixture\nsecond line\n');await writeFile(join(project,'analysis.R'),'plot(1:3)\n');await copyFile(resolve('e2e/fixtures/agents/kimi.cjs'),join(bin,'kimi'));await chmod(join(bin,'kimi'),0o755);log=join(directory,'native.jsonl');
 host=spawn(resolve('../target/debug/rho'),['--database',join(directory,'state.sqlite'),'--project',project,'--fixed-workspace', 'workbench',...(process.env.RHO_BROWSER_DEV_ASSETS?['--dev-assets',resolve(process.env.RHO_BROWSER_DEV_ASSETS)]:[])],{env:{...process.env,PATH:`${bin}:${process.env.PATH}`,KIMI_CODE_HOME:join(directory,'kimi-home'),RHO_AGENT_FIXTURE_LOG:log},stdio:['ignore','pipe','pipe']});
 url=await new Promise<string>((resolve,reject)=>{let output='',errors='';const timer=setTimeout(()=>reject(new Error(`Host startup timed out: ${errors}`)),40000);host.stderr!.on('data',d=>errors+=d);host.stdout!.on('data',d=>{output+=d;const match=output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-z0-9]+/);if(match){clearTimeout(timer);resolve(match[0]);}});host.once('exit',code=>{clearTimeout(timer);reject(new Error(`Host exited ${code}: ${errors}`));});});
});
test.afterAll(async()=>{if(host?.exitCode===null){host.kill('SIGINT');await Promise.race([new Promise(r=>host.once('exit',r)),pause(12000)]);if(host.exitCode===null)host.kill('SIGKILL');}if(directory)await rm(directory,{recursive:true,force:true});});
async function nativeCalls(){try{return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));}catch{return[];}}
async function openAgent(page:import('@playwright/test').Page){await page.goto(url);await page.getByRole('button',{name:'Agents',exact:true}).click();await expect(page.getByLabel('Agent panel',{exact:true})).toBeVisible();}
async function newTask(page:import('@playwright/test').Page){const panel=page.getByLabel('Agent panel',{exact:true}),action=panel.locator('button[aria-label="New task"]:visible').first();await action.click();await page.getByRole('menuitem',{name:'Kimi Code',exact:true}).click();await expect(action).toBeEnabled();await expect(panel.getByRole('textbox',{name:'Agent message',exact:true})).toBeEditable();return panel;}

test('one project shares the Agent task list and selector while Kimi and unconfigured Rho retain unsent drafts',async({page})=>{
 const commands:{backend:string,project:string,kind:string}[]=[],modelTests:string[]=[],errors:string[]=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{
  const backend=request.url().match(/\/api\/agents\/(tasks|components)\/command$/)?.[1];
  if(backend){const body=request.postDataJSON();commands.push({backend,project:body.project_root,kind:body.command.kind});}
  if(request.url().endsWith('/api/agents/components/test'))modelTests.push(request.url());
 });
 const promptsBefore=(await nativeCalls()).filter(call=>call.method==='session/prompt').length;
 await openAgent(page);const panel=await newTask(page),input=panel.getByRole('textbox',{name:'Agent message',exact:true});
 const nativeTitle='Kimi draft in shared project',rhoTitle='Rho draft in shared project';
 async function rename(title:string){
  await panel.getByRole('button',{name:'Task actions',exact:true}).click();await page.getByRole('menuitem',{name:'Rename',exact:true}).click();
  const titleInput=panel.getByRole('textbox',{name:'Task title',exact:true});await titleInput.fill(title);await titleInput.press('Enter');
  await expect(panel.locator('.at-task-header .at-title')).toHaveText(title);
 }
 await rename(nativeTitle);await input.fill('Native draft stays unsent.');await expect(panel.locator('.at-draft-status')).toHaveText('Draft saved');
 await panel.locator('button[aria-label="New task"]:visible').first().click();
 await expect(page.getByRole('menuitem')).toHaveText(['Rho','Codex','Kimi Code','DeepSeek Harness']);
 await page.getByRole('menuitem',{name:'Rho',exact:true}).click();
 await expect(input).toBeEditable();await expect(panel.getByRole('button',{name:'Configure Rho',exact:true})).toBeVisible();
 await rename(rhoTitle);await input.fill('Rho draft stays unsent.');await expect(panel.locator('.at-draft-status')).toHaveText('Draft saved');
 await expect(panel.getByRole('button',{name:'Send message',exact:true})).toBeDisabled();
 await panel.getByRole('button',{name:`Select task: ${rhoTitle}`,exact:true}).click();
 const nativeItem=page.getByRole('menuitem').filter({has:page.getByText(nativeTitle,{exact:true})});
 const rhoItem=page.getByRole('menuitem').filter({has:page.getByText(rhoTitle,{exact:true})});
 await expect(nativeItem).toContainText('Kimi Code');await expect(rhoItem).toContainText('Rho');
 await page.screenshot({path:'../target/studio-browser/agent-mixed-project-selector.png'});
 await nativeItem.click();await expect(input).toHaveValue('Native draft stays unsent.');
 await panel.getByRole('button',{name:`Select task: ${nativeTitle}`,exact:true}).click();await rhoItem.click();await expect(input).toHaveValue('Rho draft stays unsent.');
 const group=page.locator('.flexlayout__tabset').filter({has:page.getByRole('tab',{name:'Agent',exact:true})});
 await group.getByRole('button',{name:'Maximize tab set',exact:true}).click();
 const list=panel.getByLabel('Project tasks',{exact:true});await expect(list).toBeVisible();
 const nativeRow=list.locator('.at-task').filter({has:page.getByText(nativeTitle,{exact:true})});
 const rhoRow=list.locator('.at-task').filter({has:page.getByText(rhoTitle,{exact:true})});
 await expect(nativeRow).toContainText('Kimi Code');await expect(rhoRow).toContainText('Rho');
 await nativeRow.click();await expect(input).toHaveValue('Native draft stays unsent.');
 await rhoRow.click();await expect(input).toHaveValue('Rho draft stays unsent.');await expect(rhoRow).toHaveAttribute('aria-current','true');
 await expect(panel).toHaveCount(1);await expect(page.getByRole('tab',{name:'Agent',exact:true})).toHaveCount(1);
 for(const name of ['Rho Assistant','External tasks','Assistant'])await expect(page.getByRole('button',{name,exact:true})).toHaveCount(0);
 await expect(page.getByRole('tab',{name:'Assistant',exact:true})).toHaveCount(0);
 const created=commands.filter(command=>command.kind==='create');expect(created.map(command=>command.backend)).toEqual(['tasks','components']);expect(new Set(created.map(command=>command.project)).size).toBe(1);
 expect(commands.filter(command=>['send','start','configure'].includes(command.kind))).toEqual([]);expect(modelTests).toEqual([]);
 expect((await nativeCalls()).filter(call=>call.method==='session/prompt').length).toBe(promptsBefore);expect(errors).toEqual([]);
 await page.screenshot({path:'../target/studio-browser/agent-mixed-project-tasks.png'});
});

test('manual handoff appends across Rho and native drafts and confirms a lost acknowledgement without sending',async({page})=>{
 const calls:{path:string,body:any}[]=[];page.on('request',request=>{if(/\/api\/agents\/(tasks|components|handoff)\/command$/.test(request.url()))calls.push({path:new URL(request.url()).pathname,body:request.postDataJSON()});});
 const promptsBefore=(await nativeCalls()).filter(call=>call.method==='session/prompt').length;
 await openAgent(page);const panel=await newTask(page),input=panel.getByRole('textbox',{name:'Agent message',exact:true});
 async function rename(title:string){await panel.getByRole('button',{name:'Task actions',exact:true}).click();await page.getByRole('menuitem',{name:'Rename',exact:true}).click();const titleInput=panel.getByRole('textbox',{name:'Task title',exact:true});await titleInput.fill(title);await titleInput.press('Enter');await expect(panel.locator('.at-task-header .at-title')).toHaveText(title);}
 const nativeTitle='Handoff native target',rhoTitle='Handoff Rho source';
 await rename(nativeTitle);await input.fill('Keep the native draft first.');
 await panel.locator('input[type=file]').setInputFiles({name:'target.csv',mimeType:'text/csv',buffer:Buffer.from('a,b\n1,2\n')});await expect(panel.locator('.at-asset')).toContainText('target.csv');await expect(panel.locator('.at-draft-status')).toHaveText('Draft saved');
 await panel.locator('button[aria-label="New task"]:visible').first().click();await page.getByRole('menuitem',{name:'Rho',exact:true}).click();await expect(input).toBeEditable();await rename(rhoTitle);
 await input.fill('Keep the Rho source draft.');
 await panel.locator('input[type=file]').setInputFiles({name:'source.csv',mimeType:'text/csv',buffer:Buffer.from('source,value\nA,3\n')});await expect(panel.locator('.at-asset')).toContainText('source.csv');
 for(const filename of ['notes.txt','analysis.R']){
  await panel.getByRole('button',{name:'Add context',exact:true}).click();const picker=panel.getByRole('dialog',{name:'Add workspace context'});
  await picker.getByLabel('Context source type').selectOption('files');await picker.getByRole('button',{name:new RegExp(filename.replace('.','\\.'))}).click();await picker.getByRole('button',{name:'Add context',exact:true}).click();
 }
 await expect(panel.locator('.at-draft-status')).toHaveText('Draft saved');
 await panel.getByRole('button',{name:'Task actions',exact:true}).click();await page.getByRole('menuitem',{name:'Prepare handoff',exact:true}).click();
 const form=panel.getByRole('region',{name:'Prepare handoff',exact:true}),body=form.getByRole('textbox',{name:'Handoff draft',exact:true});await expect(body).toBeEditable();
 await form.getByRole('combobox',{name:'Send context to',exact:true}).selectOption({label:`${nativeTitle} · Kimi Code`});await expect(form.getByRole('region',{name:'Existing target draft'})).toContainText('Keep the native draft first.');
 await form.getByRole('button',{name:'notes.txt',exact:true}).click();await expect(form.getByRole('region',{name:'Handoff source preview'})).toContainText('Verified context fixture');await form.getByRole('button',{name:'Close handoff source preview'}).click();
 await form.getByRole('button',{name:'Remove analysis.R from handoff',exact:true}).click();
 const forward='Goal: Compare the values.\n\nConfirmed: I reviewed the attached notes.\n\nNext: Explain the difference.';await body.fill(forward);await body.press('Enter');expect(calls.filter(call=>call.path.endsWith('/handoff/command'))).toHaveLength(0);
 // Verify the approved inline form in a constrained panel and a wide Agent workspace.
 await page.setViewportSize({width:1100,height:800});await expect(form.getByRole('button',{name:'Add to draft',exact:true})).toBeEnabled();expect(await form.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);await page.screenshot({path:'../target/studio-browser/agent-handoff-constrained.png'});
 const group=page.locator('.flexlayout__tabset').filter({has:page.getByRole('tab',{name:'Agent',exact:true})});await group.getByRole('button',{name:'Maximize tab set',exact:true}).click();
 await page.setViewportSize({width:386,height:900});await expect.poll(async()=>Math.round((await panel.boundingBox())!.width)).toBe(320);expect(await form.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
 const addBox=await form.getByRole('button',{name:'Add to draft',exact:true}).boundingBox(),formBox=await form.boundingBox();expect(addBox!.y+addBox!.height).toBeLessThanOrEqual(formBox!.y+formBox!.height);
 await page.screenshot({path:'../target/studio-browser/agent-handoff-320.png'});await form.getByRole('region',{name:'Existing target draft'}).scrollIntoViewIfNeeded();await page.screenshot({path:'../target/studio-browser/agent-handoff-320-target.png'});
 await page.setViewportSize({width:1440,height:900});await form.locator('.at-handoff-body').evaluate(node=>node.scrollTop=0);await page.screenshot({path:'../target/studio-browser/agent-handoff-wide.png'});
 const list=panel.getByRole('complementary',{name:'Project tasks',exact:true});await list.locator('.at-task').filter({has:page.getByText(nativeTitle,{exact:true})}).click();await input.fill('Updated native draft remains first.');await expect(panel.locator('.at-draft-status')).toHaveText('Draft saved');
 await list.locator('.at-task').filter({has:page.getByText(rhoTitle,{exact:true})}).click();await expect(body).toHaveValue(forward+'\n');
 await form.getByRole('button',{name:'Add to draft',exact:true}).click();await expect(form.getByRole('alert')).toContainText('The target draft changed');await expect(form.getByRole('region',{name:'Existing target draft'})).toContainText('Updated native draft remains first.');await expect(body).toHaveValue(forward+'\n');expect(calls.filter(call=>call.path.endsWith('/handoff/command'))).toHaveLength(0);
 await form.getByRole('button',{name:'Add to draft',exact:true}).click();await expect(form.getByText('Added to the target draft',{exact:true})).toBeVisible();await form.getByRole('button',{name:'Open target draft',exact:true}).click();
 await expect(input).toHaveValue(new RegExp(`^Updated native draft remains first\\.[\\s\\S]*Goal: Compare the values\\.`));await expect(panel.locator('.at-assets')).toContainText('target.csv');await expect(panel.locator('.at-assets')).not.toContainText('source.csv');await expect(panel.locator('.at-context-chips')).toContainText('notes.txt');await expect(panel.locator('.at-context-chips')).not.toContainText('analysis.R');
 await panel.getByRole('button',{name:'Task actions',exact:true}).click();await page.getByRole('menuitem',{name:'Prepare handoff',exact:true}).click();
 await form.getByRole('combobox',{name:'Send context to',exact:true}).selectOption({label:`${rhoTitle} · Rho`});await expect(form.getByRole('region',{name:'Existing target draft'})).toContainText('Keep the Rho source draft.');
 const reverse='Goal: Follow up in Rho.\n\nConfirmed: The native draft retained the reviewed context.\n\nNext: Review before sending.';await body.fill(reverse);
 let aborted=false;await page.route('**/api/agents/handoff/command',async route=>{const response=await route.fetch();if(!aborted){aborted=true;await route.abort('failed');}else await route.fulfill({response});});
 await form.getByRole('button',{name:'Add to draft',exact:true}).click();await expect(form.getByRole('button',{name:'Check receipt',exact:true})).toBeVisible();
 const beforeReload=calls.filter(call=>call.path.endsWith('/handoff/command'));expect(beforeReload).toHaveLength(2);
 await page.reload();await expect(form.getByRole('button',{name:'Check receipt',exact:true})).toBeVisible();await expect(body).toHaveValue(reverse);await expect(body).not.toBeEditable();
 await form.getByRole('button',{name:'Check receipt',exact:true}).click();await expect(form.getByText('Added to the target draft',{exact:true})).toBeVisible();await page.screenshot({path:'../target/studio-browser/agent-handoff-receipt.png'});
 await form.getByRole('button',{name:'Open target draft',exact:true}).click();await expect(input).toHaveValue(/^Keep the Rho source draft\.[\s\S]*Goal: Follow up in Rho\./);
 expect(((await input.inputValue()).match(/Goal: Follow up in Rho\./g)??[])).toHaveLength(1);await expect(panel.locator('.at-assets')).toContainText('source.csv');await expect(panel.locator('.at-assets')).not.toContainText('target.csv');
 expect(calls.filter(call=>call.path.endsWith('/handoff/command'))).toHaveLength(2);expect(calls.filter(call=>['start','send'].includes(call.body.command?.kind))).toEqual([]);expect((await nativeCalls()).filter(call=>call.method==='session/prompt').length).toBe(promptsBefore);
});

test('Agent activity bridges sending, native thinking and tool gaps in a constrained panel', async ({page}) => {
 await page.setViewportSize({width:1100,height:800});await openAgent(page);const panel=await newTask(page),input=panel.getByRole('textbox',{name:'Agent message',exact:true});
 let release!:()=>void;const held=new Promise<void>(r=>release=r);
 await page.route('**/api/agents/tasks/command',async route=>{if(route.request().postDataJSON().command.kind==='send')await held;await route.continue();});
 await input.fill('activity phases');await panel.getByRole('button',{name:'Send message',exact:true}).click();
 const status=panel.getByRole('status',{name:'Agent activity'});await expect(status).toContainText('Sending message');release();
 await expect(status).toContainText('Thinking');await expect(panel).not.toContainText('private fixture reasoning');
 await page.screenshot({path:'../target/studio-browser/agent-live-thinking.png'});
 await expect(status).toContainText('Using tools');await input.fill('Next draft stays editable');
 await expect(status).toContainText('Working');await page.screenshot({path:'../target/studio-browser/agent-tool-gap.png'});
 await expect(panel.getByText('Activity finished',{exact:true})).toBeVisible();await expect(status).toHaveCount(0);await expect(input).toHaveValue('Next draft stays editable');
});

test('workspace Agent opens without CLI discovery; task drafts survive close, refresh and running work',async({page})=>{
 page.on('dialog',d=>void d.accept());const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const before=await nativeCalls();await openAgent(page);
 expect(await nativeCalls()).toEqual(before);const panel=await newTask(page);const input=panel.getByRole('textbox',{name:'Agent message',exact:true});await input.fill('saved task draft');await expect(panel.locator('.at-draft-status')).toHaveText('Draft saved');
 const box=await panel.boundingBox();expect(box!.x).toBeGreaterThan(650);expect(box!.width).toBeGreaterThan(280);expect(box!.width).toBeLessThan(620);
 await page.reload();await expect(input).toHaveValue('saved task draft');await input.fill('slow task keeps running');await panel.getByRole('button',{name:'Send message',exact:true}).click();await expect(panel.getByRole('button',{name:'Stop Agent',exact:true})).toBeVisible();
 await input.fill('next draft while running');await page.getByRole('tab',{name:'Agent',exact:true}).locator('.flexlayout__tab_button_trailing').click();await expect(panel).toHaveCount(0);await pause(2200);
 await page.getByRole('button',{name:'Agents',exact:true}).click();await expect(input).toHaveValue('next draft while running');await expect(panel.getByText('Completed: slow task keeps running',{exact:true})).toBeVisible();
 await page.screenshot({path:'../target/studio-browser/agent-tasks-normal.png'});expect(errors).toEqual([]);
});

test('native modes and permission responses remain at the composer with independent task state',async({page})=>{
 await openAgent(page);const panel=await newTask(page),input=panel.getByRole('textbox',{name:'Agent message',exact:true});await input.fill('please request permission');await panel.getByRole('button',{name:'Send message',exact:true}).click();
 const request=panel.getByRole('region',{name:'Pending Agent permission'});await expect(request).toBeVisible();await expect(request.getByRole('button').filter({hasText:/Approve|Reject/})).toHaveCount(3);
 await expect(request.locator('pre')).not.toBeVisible();await request.getByText('View request',{exact:true}).click();await expect(request.locator('pre')).toContainText('notes.txt');await request.getByText('View request',{exact:true}).click();
 const permissionBox=await request.boundingBox(),composerBox=await panel.locator('.at-composer').boundingBox();expect(permissionBox!.y+permissionBox!.height).toBeLessThanOrEqual(composerBox!.y);expect(composerBox!.y-permissionBox!.y-permissionBox!.height).toBeLessThan(20);
 await input.fill('a separate next draft');await page.screenshot({path:'../target/studio-browser/agent-tasks-permission.png'});
 await panel.getByRole('button',{name:'Task actions',exact:true}).click();await page.getByRole('menuitem',{name:'Archive',exact:true}).click();await expect(panel.getByText('· Archived',{exact:true})).toBeVisible();
 await page.getByRole('tab',{name:'Agent',exact:true}).locator('.flexlayout__tab_button_trailing').click();await expect(panel).toHaveCount(0);await page.getByRole('button',{name:'1 Agent tasks need attention',exact:true}).click();await page.getByRole('menuitem').filter({hasText:'please request permission'}).click();await expect(request).toBeVisible();
 await request.getByRole('button',{name:'Approve once',exact:true}).click();await expect(panel.getByText('Permission handled.',{exact:true})).toBeVisible();await expect(input).toHaveValue('a separate next draft');
 await panel.getByRole('button',{name:'Task actions',exact:true}).click();await page.getByRole('menuitem',{name:'Unarchive',exact:true}).click();
 await panel.getByRole('button',{name:'Permission mode',exact:true}).click();for(const name of ['Default','Plan','Auto','YOLO'])await expect(page.getByRole('menuitem').filter({has:page.getByText(name,{exact:true})})).toBeVisible();
 await page.getByRole('menuitem').filter({has:page.getByText('Auto',{exact:true})}).click();await expect(panel.getByRole('button',{name:'Permission mode',exact:true})).toContainText('Auto');
 expect((await nativeCalls()).some(c=>c.method==='session/set_mode')).toBe(true);
});

test('attachments and owner-backed context are previewed at the input, including constrained layout',async({page})=>{
 await page.setViewportSize({width:1060,height:800});await openAgent(page);const panel=await newTask(page);await expect(panel.locator('.at-task-list')).toBeHidden();
 await panel.locator('input[type=file]').setInputFiles({name:'sample.csv',mimeType:'text/csv',buffer:Buffer.from('country,value\nA,1\nB,2\n')});await expect(panel.locator('.at-asset')).toContainText('sample.csv');
 await panel.getByRole('button',{name:'Mention workspace information',exact:true}).click();await panel.getByRole('textbox',{name:'Find workspace information',exact:true}).fill('notes');await panel.locator('.at-context-result').filter({hasText:'notes.txt'}).click();
 await expect(panel.getByText('Verified context fixture',{exact:false})).toBeVisible();await panel.getByRole('button',{name:'Add context',exact:true}).last().click();await expect(panel.locator('.at-context-chip')).toContainText('notes.txt');
 expect(await panel.evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);const sendBox=await panel.getByRole('button',{name:'Send message',exact:true}).boundingBox(),panelBox=await panel.boundingBox();expect(sendBox!.y+sendBox!.height).toBeLessThanOrEqual(panelBox!.y+panelBox!.height);await page.screenshot({path:'../target/studio-browser/agent-tasks-constrained.png'});
 await panel.getByRole('textbox',{name:'Agent message',exact:true}).fill('summarize these inputs');await panel.getByRole('button',{name:'Send message',exact:true}).click();await expect(panel.getByText('Completed: summarize these inputs',{exact:true})).toBeVisible();
 expect((await nativeCalls()).some(c=>c.method==='session/prompt'&&c.resources>=3)).toBe(true);
});

test('a second window is read-only until explicit takeover',async({page,context})=>{
 await openAgent(page);const panel=await newTask(page);await panel.getByRole('textbox',{name:'Agent message',exact:true}).fill('shared saved draft');await expect(panel.locator('.at-draft-status')).toHaveText('Draft saved');
 const other=await context.newPage();await openAgent(other);const otherPanel=other.getByLabel('Agent panel',{exact:true});await expect(otherPanel.getByRole('textbox',{name:'Agent message',exact:true})).toHaveAttribute('readonly','');
 await expect(otherPanel.getByRole('textbox',{name:'Agent message',exact:true})).toHaveValue('shared saved draft');await otherPanel.getByRole('button',{name:'Take over',exact:true}).click();await expect(otherPanel.getByRole('textbox',{name:'Agent message',exact:true})).toBeEditable();await expect(panel.getByRole('textbox',{name:'Agent message',exact:true})).toHaveAttribute('readonly','');
 await other.screenshot({path:'../target/studio-browser/agent-tasks-takeover.png'});await other.close();
});

test('wide tasks, real R table and plot references use their owners and the editor stays responsive',async({page})=>{
 await openAgent(page);const panel=await newTask(page);const consoleInput=page.getByRole('textbox',{name:'Console Input',exact:true});
 await consoleInput.fill('agent_table <- data.frame(country=c("A","B"), value=c(1,2)); plot(1:3); cat("context ready\\n")');await page.locator('.console-prompt .primary').first().click();await expect(page.getByText('context ready',{exact:true})).toBeVisible();await expect(page.locator('.console-status > span').first()).toHaveText('Ready');
 await panel.getByRole('button',{name:'Mention workspace information',exact:true}).click();await panel.getByRole('button',{name:'Tables',exact:true}).click();await panel.getByRole('textbox',{name:'Find workspace information',exact:true}).fill('agent_table');await panel.locator('.at-context-result').filter({hasText:'agent_table'}).click();
 await expect(panel.getByRole('columnheader',{name:'country',exact:true})).toBeVisible();await expect(panel.getByRole('cell',{name:'B',exact:true})).toBeVisible();await panel.getByRole('button',{name:'Add context',exact:true}).last().click();
 await panel.getByRole('button',{name:'Mention workspace information',exact:true}).click();await panel.getByRole('button',{name:'Plots',exact:true}).click();await panel.locator('.at-context-result').first().click();await expect(panel.locator('.at-preview-body > img')).toBeVisible();await panel.getByRole('button',{name:'Add context',exact:true}).last().click();
 await consoleInput.fill('editor remains responsive');await expect(consoleInput).toHaveText('editor remains responsive');
 const group=page.locator('.flexlayout__tabset').filter({has:page.getByRole('tab',{name:'Agent',exact:true})});await group.getByRole('button',{name:'Maximize tab set',exact:true}).click();await expect(panel.locator('.at-task-list')).toBeVisible();
 await page.screenshot({path:'../target/studio-browser/agent-tasks-wide-context.png'});await panel.getByRole('textbox',{name:'Agent message',exact:true}).fill('review these references');await panel.getByRole('button',{name:'Send message',exact:true}).click();await expect(panel.getByText('Image received',{exact:true})).toBeVisible();
 await expect(panel.locator('.at-sent-context').filter({hasText:'agent_table'})).toBeVisible();
});

test('dragging Agent to the shared column edge spans Objects and Plots and can be undone',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await openAgent(page);const panel=await newTask(page);
 const input=panel.getByRole('textbox',{name:'Agent message',exact:true});await input.fill('Draft kept while docking');await expect(panel.locator('.at-draft-status')).toHaveText('Draft saved');
 async function place(target:string){
  await page.getByRole('button',{name:'Group Actions: Agent',exact:true}).click();await page.getByRole('menuitem',{name:'Move To…',exact:true}).click();
  await page.getByRole('combobox',{name:'Target Region'}).selectOption(target);await page.getByRole('combobox',{name:'Placement'}).selectOption('Right');await page.getByRole('button',{name:'Move View',exact:true}).click();
 }
 await place('plots-group');
 const group=(name:string)=>page.locator('.flexlayout__tabset').filter({has:page.getByRole('tab',{name,exact:true})});
 const before=await group('Agent').boundingBox(),objectsBefore=await group('Objects').boundingBox();expect(before!.y).toBeGreaterThan(objectsBefore!.y+objectsBefore!.height-5);
 let commands=0;page.on('request',r=>{if(r.url().endsWith('/api/agents/tasks/command'))commands++;});
 const tab=await page.getByRole('tab',{name:'Agent',exact:true}).boundingBox();await page.mouse.move(tab!.x+25,tab!.y+15);await page.mouse.down();await page.mouse.move(tab!.x-45,tab!.y+65,{steps:8});
 const zone=page.locator('.parent-dock-zone[data-region="Objects + Plots"][data-direction="Right"]');await expect(zone).toBeVisible();await expect(page.locator('.parent-dock-targets')).toHaveCount(0);
 const bounds=await zone.boundingBox();await page.mouse.move(bounds!.x+bounds!.width/2,bounds!.y+bounds!.height/2,{steps:12});await page.mouse.move(bounds!.x+bounds!.width/2+1,bounds!.y+bounds!.height/2);await expect(zone).toHaveClass(/active/);
 await expect(page.getByText('Right of Objects + Plots',{exact:true})).toBeVisible();await expect(page.locator('.dock-destination')).toBeVisible();
 const preview=await page.locator('.dock-destination').boundingBox();await page.screenshot({path:'../target/studio-browser/agent-parent-drag-preview.png'});
 await page.mouse.up();await expect(zone).toHaveCount(0);const agent=await group('Agent').boundingBox(),objects=await group('Objects').boundingBox(),plots=await group('Plots').boundingBox();
 expect(agent!.x).toBeGreaterThan(objects!.x+objects!.width-2);expect(Math.abs(agent!.y-objects!.y)).toBeLessThan(3);expect(Math.abs(agent!.y+agent!.height-plots!.y-plots!.height)).toBeLessThan(3);
 expect(Math.abs(agent!.x-preview!.x)).toBeLessThan(3);expect(Math.abs(agent!.height-preview!.height)).toBeLessThan(3);await expect(input).toHaveValue('Draft kept while docking');expect(commands).toBe(0);
 await page.screenshot({path:'../target/studio-browser/agent-parent-drag-result.png'});
 await page.getByRole('button',{name:'View',exact:true}).click();await page.getByRole('menuitem',{name:'Undo Layout Change',exact:true}).click();const undone=await group('Agent').boundingBox();expect(Math.abs(undone!.y-before!.y)).toBeLessThan(3);await expect(input).toHaveValue('Draft kept while docking');
 // Escaping a second drag must remove all previews without moving the panel.
 const again=await page.getByRole('tab',{name:'Agent',exact:true}).boundingBox();await page.mouse.move(again!.x+25,again!.y+15);await page.mouse.down();await page.mouse.move(again!.x-45,again!.y+65,{steps:8});await expect(zone).toBeVisible();await page.keyboard.press('Escape');await page.mouse.up();await expect(zone).toHaveCount(0);expect(Math.abs((await group('Agent').boundingBox())!.y-before!.y)).toBeLessThan(3);
});

test('Agent native IME replaces preedit and waits for committed text before saving or sending',async({page,context})=>{
 await openAgent(page);const panel=await newTask(page),input=panel.getByRole('textbox',{name:'Agent message',exact:true});await input.click();
 const commands:any[]=[];page.on('request',r=>{if(r.url().endsWith('/api/agents/tasks/command'))commands.push(r.postDataJSON().command);});
 await input.evaluate(el=>{const trace:any[]=[];(window as any).__agentImeTrace=trace;const value=Object.getOwnPropertyDescriptor(el,'value')??Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!;Object.defineProperty(el,'value',{get(){return value.get!.call(this);},set(v){trace.push({type:'value-write',value:v});value.set!.call(this,v);},configurable:true});for(const name of ['compositionstart','compositionupdate','compositionend','input'])el.addEventListener(name,e=>trace.push({type:e.type,data:(e as CompositionEvent).data,composing:(e as InputEvent).isComposing,value:(el as HTMLTextAreaElement).value}));});
 const cdp=await context.newCDPSession(page);
 await cdp.send('Input.imeSetComposition',{text:'ni',selectionStart:2,selectionEnd:2});
 await cdp.send('Input.imeSetComposition',{text:'nihao',selectionStart:5,selectionEnd:5});
 const preedit=await page.evaluate(()=>(window as any).__agentImeTrace);expect(preedit.filter((e:any)=>e.type==='value-write')).toHaveLength(0);expect(preedit.filter((e:any)=>e.type==='compositionstart')).toHaveLength(1);
 await expect(input).toHaveValue('nihao');
 // Cross both autosave and summary polling while the native preedit remains active.
 await page.waitForTimeout(1250);expect(commands.filter(c=>c.kind==='save_draft'||c.kind==='send')).toEqual([]);
 await cdp.send('Input.imeSetComposition',{text:'你好',selectionStart:2,selectionEnd:2});
 await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:36});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:36});
 expect(commands.filter(c=>c.kind==='send')).toHaveLength(0);
 await cdp.send('Input.insertText',{text:'你好'});await expect(input).toHaveValue('你好');await expect(panel.locator('.at-draft-status')).toHaveText('Draft saved');
 expect(commands.filter(c=>c.kind==='save_draft').map(c=>c.content.text)).toEqual(['你好']);expect(commands.filter(c=>c.kind==='send')).toHaveLength(0);
 await input.press('Enter');await expect.poll(()=>commands.filter(c=>c.kind==='send').length).toBe(1);await cdp.detach();
});

test('Agent IME stays active across a delayed draft ACK and repeated task snapshots',async({page,context})=>{
 await openAgent(page);const panel=await newTask(page),input=panel.getByRole('textbox',{name:'Agent message',exact:true});
 const saved:string[]=[];let release!:()=>void,accepted!:()=>void;
 const held=new Promise<void>(r=>release=r),received=new Promise<void>(r=>accepted=r);
 await page.route('**/api/agents/tasks/command',async route=>{const c=route.request().postDataJSON().command;if(c.kind==='save_draft'){saved.push(c.content.text);if(saved.length===1){const response=await route.fetch();accepted();await held;await route.fulfill({response});return;}}await route.continue();});
 await input.fill('Before ');await received;await input.press('End');const cdp=await context.newCDPSession(page);
 try{
  await cdp.send('Input.imeSetComposition',{text:'zhong',selectionStart:5,selectionEnd:5});release();
  await page.waitForTimeout(1250);await expect(input).toHaveValue('Before zhong');expect(saved).toEqual(['Before ']);
  await cdp.send('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});await expect(input).toHaveValue('Before 中文');await cdp.send('Input.insertText',{text:'中文'});
  await expect(panel.locator('.at-draft-status')).toHaveText('Draft saved');await expect(input).toHaveValue('Before 中文');expect(saved).toEqual(['Before ','Before 中文']);
  await page.screenshot({path:'../target/studio-browser/agent-ime-committed.png'});
 }finally{release();await cdp.detach();}
});
