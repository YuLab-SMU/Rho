import { test, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { buildStudioPlugin } from '../../scripts/build-studio-plugin.mjs';
import { buildUiFixture } from '../../scripts/fixtures/plugin-ui.mjs';

let directory: string, project: string, archive: string, subject: any, analysisPackage: any, url: URL, host: ReturnType<typeof spawn>, studioView: any, analysisView: any, completed = false;
const studioWindow = 'archive-studio', analysisWindow = 'archive-analysis';
async function port(method: string, params: any, window = studioWindow) {
  const reply = await fetch(new URL('/api/host', url), { method: 'POST', headers: { Authorization: `Bearer ${url.hash.slice(7)}`, 'Content-Type': 'application/json', 'X-Rho-Studio-Window': window },
    body: JSON.stringify({ project_root: project, frame: { id: crypto.randomUUID(), request: { method, params } } }) }).then(r => r.json());
  if (!reply.ok) throw Error(reply.error); return reply.result;
}
async function query(id: string, args: any) { return (await port('query_snapshot', { capability: { id, version: 1 }, arguments: args })).data; }
async function invoke(id: string, args: any, window = studioWindow) {
  const record = await port('invoke', { capability: { id, version: 1 }, arguments: args, client_request_id: crypto.randomUUID(), preconditions: [] }, window);
  expect(record.status, record.error).toBe('succeeded'); return record.output;
}
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'rho-studio-archive-')); project = join(directory, 'project'); await mkdir(project); project = await realpath(project);
  const binary = resolve('../target/debug/rho'), database = join(directory, 'host.sqlite'), seed = join(directory, 'source-catalog', 'host.sqlite');
  await mkdir(join(directory, 'source-catalog'));
  const cli = (db: string, args: string[]) => JSON.parse(execFileSync(binary, ['--database', db, 'plugins', ...args], { encoding: 'utf8' })).result;
  const studioPackage = cli(database, ['snapshot', buildStudioPlugin(join(directory, 'studio'))]);
  const source = buildUiFixture(directory), manifest = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'));
  manifest.requires = manifest.requires.filter((r: any) => r.capability.id !== 'fixture.answer'); manifest.name = 'Editable report';
  await writeFile(join(source, 'plugin.json'), JSON.stringify(manifest)); const analysis = analysisPackage = cli(database, ['snapshot', source]);
  const local = join(directory, 'local-package'); await cp(source, local, { recursive: true });
  manifest.id = 'example.archive-import'; manifest.name = 'Local report package'; manifest.version = '2.0';
  manifest.description = 'A local archive with Unicode source and an exact built view.';
  manifest.source.files.push('source-note.txt');
  await writeFile(join(local, 'source-note.txt'), 'Archive content 中文 Ω\n'.repeat(12000));
  await writeFile(join(local, 'plugin.json'), JSON.stringify(manifest)); subject = cli(seed, ['snapshot', local]);
  archive = join(directory, '本地报告与完整源码-科学检查-Ω.rho-plugin'); cli(seed, ['export', subject.revision, archive]);
  host = spawn(binary, ['--database', database, '--project', project, '--plugins-only', 'workbench'], { stdio: ['ignore', 'pipe', 'pipe'] });
  url = new URL(await new Promise<string>((done, reject) => {
    let out = '', errors = ''; const timer = setTimeout(() => reject(Error(`Archive Host startup timed out: ${errors}`)), 40000);
    host.stderr!.on('data', bytes => errors += bytes); host.stdout!.on('data', bytes => { out += bytes; const match = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/); if (match) { clearTimeout(timer); done(match[0]); } });
    host.once('exit', code => { clearTimeout(timer); reject(Error(`Archive Host exited ${code}: ${errors}`)); });
  }));
  for (const [pkg, alias, window, contribution] of [[studioPackage, 'studio', studioWindow, 'studio'], [analysis, 'analysis', analysisWindow, 'view']] as const) {
    const instance = (await invoke('plugins.activate', { revision: pkg.revision, artifact: pkg.artifacts[0], target: 'ui-web', alias, configuration: {} }, window)).instance.identity;
    const view = (await invoke('windows.open_view', { expected_layout_version: 0, group: null, view: { instance, window, contribution, configuration: {}, state: contribution === 'view' ? { text: 'Saved analysis' } : {} } }, window)).view;
    if (contribution === 'studio') studioView = view; else analysisView = view;
  }
});
test.afterAll(async () => {
  if (host?.exitCode === null) { host.kill('SIGINT'); await new Promise<void>(done => host.once('exit', () => done())); }
  if (completed) await rm(directory, { recursive: true, force: true }); else if (directory) console.error(`Archive fixture retained at ${directory}`);
});
async function operations(){
 const values:any[]=[];let before_cursor:number|null=null;
 for(let page=0;page<20;page++){const reply=await query('operation.list_recent',{limit:100,before_cursor});values.push(...reply.operations);if(reply.next_cursor===null)return values;before_cursor=reply.next_cursor;}
 throw Error('Studio archive fixture exceeded its bounded operation history.');
}
test('Studio transfers exact checkpoints while preserving unsaved source and recovering original archive requests',async({page,context},info)=>{
 test.setTimeout(180000);
 const address=(window:string)=>{const value=new URL(url);value.searchParams.set('window',window);return value.href;};
 const errors:string[]=[],downloads:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('download',download=>downloads.push(download.suggestedFilename()));
 const other=await context.newPage();await other.goto(address(analysisWindow));const note=other.locator(`[data-plugin-frame="${analysisView.view}"]`).frameLocator('iframe').getByLabel('View note');
 await expect(note).toHaveValue('Saved analysis');await note.fill('Other unsaved scientific draft 中文 Ω');
 await page.goto(address(studioWindow));await page.bringToFront();const frame=page.locator(`[data-plugin-frame="${studioView.view}"]`).frameLocator('iframe');
 await frame.getByRole('button',{name:'Choose revision',exact:true}).click();await frame.getByRole('button',{name:/Editable report ·/}).click();
 await frame.getByLabel('Development branch name').fill('archive-edits');await frame.getByRole('button',{name:'Create branch from selected',exact:true}).click();
 await frame.getByRole('button',{name:'Source files',exact:true}).click();await frame.getByRole('button',{name:'src/main.js',exact:true}).click();
 const source=frame.getByRole('textbox',{name:'Source editor',exact:true});await expect(source).toHaveValue(/connectPluginView/);
 const original=await source.inputValue(),edited=original+'\n// Unsaved source 中文 Ω\n';
 await source.fill(edited);await frame.getByRole('button',{name:'Save draft',exact:true}).click();await expect(frame.locator('#sync')).toHaveText('Draft synchronized');
 const initialCount=(await query('plugins.instances',{after:null,limit:100})).total,baseline=await query('plugins.list',{after:null,limit:100});
 expect(baseline.items.some((item:any)=>item.revision===subject.revision)).toBe(false);
 let lostChunk=false;
 await page.route('**/api/plugin-view',async route=>{const body=route.request().postDataJSON()?.message?.body;if(!lostChunk&&body?.type==='control'&&body.capability.id==='plugins.archive_stage'){
  lostChunk=true;const response=await route.fetch(),reply=await response.json();expect(reply.ok).toBe(true);await route.fulfill({response,json:{...reply,ok:false,result:undefined,error:'Upload acknowledgement lost'}});
 }else await route.continue();});
 await frame.getByRole('button',{name:'Import / export',exact:true}).click();await frame.getByLabel('Local archive',{exact:true}).setInputFiles(archive);
 await frame.getByRole('button',{name:'Upload and inspect',exact:true}).click();await expect(frame.locator('#archive-dialog .dialog-error')).toContainText('acknowledgement lost');
 await page.unroute('**/api/plugin-view');await page.reload();await expect(source).toHaveValue(edited);await expect(frame.locator('#subtitle')).toContainText('archive-edits');
 await frame.getByRole('button',{name:'Import / export',exact:true}).click();await frame.getByRole('button',{name:'Inspect retained upload',exact:true}).click();await expect(frame.locator('#archive-progress')).toContainText('65,536');
 await frame.getByLabel('Local archive',{exact:true}).setInputFiles(archive);await frame.getByRole('button',{name:'Upload and inspect',exact:true}).click();await expect(frame.getByRole('button',{name:'Import revision',exact:true})).toBeEnabled();
 let lostImport=false;
 await page.route('**/api/plugin-view',async route=>{const body=route.request().postDataJSON()?.message?.body;if(!lostImport&&body?.type==='invoke'&&body.capability.id==='plugins.archive_import'){
  lostImport=true;const response=await route.fetch(),reply=await response.json();expect(reply.ok).toBe(true);await route.fulfill({response,json:{...reply,ok:false,result:undefined,error:'Import acknowledgement lost'}});
 }else await route.continue();});
 await frame.getByRole('button',{name:'Import revision',exact:true}).click();await expect(frame.locator('#archive-pending')).toBeVisible();await page.unroute('**/api/plugin-view');await page.reload();await expect(source).toHaveValue(edited);
 await frame.getByRole('button',{name:'Import / export',exact:true}).click();await frame.getByRole('button',{name:'Inspect original archive request',exact:true}).click();await expect(frame.locator('#archive-pending')).toBeHidden();
 await expect(frame.getByRole('button',{name:'Open imported source',exact:true})).toBeDisabled();await expect(frame.locator('#archive-open-help')).toContainText('Checkpoint current edits');
 expect((await operations()).filter(record=>record.capability.id==='plugins.archive_import')).toHaveLength(1);
 await frame.getByRole('button',{name:'Inspect original import',exact:true}).click();await expect(frame.locator('#archive-import-status')).toContainText('confirmed');
 await frame.getByRole('button',{name:'Use current checkpoint',exact:true}).click();await expect(frame.locator('#archive-checkpoint')).toContainText('unsaved source changes are excluded');
 const choice=frame.getByRole('checkbox').first();await choice.focus();await choice.press('Space');await expect(choice).not.toBeChecked();await expect(choice).toBeFocused();
 await frame.getByLabel('Filename',{exact:true}).fill('原始检查点-中文-Ω.rho-plugin');
 let lostExport=false;
 await page.route('**/api/plugin-view',async route=>{const body=route.request().postDataJSON()?.message?.body;if(!lostExport&&body?.type==='invoke'&&body.capability.id==='plugins.archive_export'){
  lostExport=true;const response=await route.fetch(),reply=await response.json();expect(reply.ok).toBe(true);await route.fulfill({response,json:{...reply,ok:false,result:undefined,error:'Export acknowledgement lost'}});
 }else await route.continue();});
 await frame.getByRole('button',{name:'Prepare archive',exact:true}).click();await expect(frame.locator('#archive-pending')).toBeVisible();await page.unroute('**/api/plugin-view');await page.reload();await expect(source).toHaveValue(edited);
 await frame.getByRole('button',{name:'Import / export',exact:true}).click();await frame.getByRole('button',{name:'Inspect original archive request',exact:true}).click();await expect(frame.locator('#archive-pending')).toBeHidden();
 expect(downloads).toEqual([]);await expect(frame.locator('#archive-export-details')).toContainText('Source-only archive');
 const exported=(await operations()).filter(record=>record.capability.id==='plugins.archive_export');expect(exported).toHaveLength(1);
 const receipt=(await query('operation.get',{operation_id:exported[0].operation_id})).record.output;expect(receipt.revision).toBe(analysisPackage.revision);
 for(const width of [1440,1920,390,220]){
  await page.setViewportSize({width,height:1000});await expect.poll(async()=>Math.abs(await frame.locator('body').evaluate(()=>innerWidth)-width)).toBeLessThan(5);
  await frame.locator('#archive-dialog').evaluate(dialog=>dialog.scrollTop=0);await frame.locator('body').evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
  expect(await frame.locator('#archive-dialog').evaluate(dialog=>dialog.scrollWidth>dialog.clientWidth)).toBe(false);await page.screenshot({path:info.outputPath(`studio-archives-${width}.png`)});
  if(width<=390){await frame.getByRole('button',{name:'Download archive',exact:true}).scrollIntoViewIfNeeded();await expect(frame.getByRole('button',{name:'Download archive',exact:true})).toBeInViewport();await page.screenshot({path:info.outputPath(`studio-archives-controls-${width}.png`)});}
 }
 await page.setViewportSize({width:1440,height:1000});await frame.getByRole('button',{name:'Inspect original export',exact:true}).click();await expect(frame.locator('#archive-download-status')).toContainText('confirmed');
 const downloadEvent=page.waitForEvent('download');await frame.getByRole('button',{name:'Download archive',exact:true}).click();const download=await downloadEvent;
 expect(download.suggestedFilename()).toBe('原始检查点-中文-Ω.rho-plugin');await download.saveAs(info.outputPath('checkpoint.rho-plugin'));expect(await download.failure()).toBeNull();
 const bytes=await readFile(info.outputPath('checkpoint.rho-plugin')),parsed=JSON.parse(bytes.toString());expect(bytes.length).toBe(receipt.reference.bytes);expect('sha256:'+createHash('sha256').update(bytes).digest('hex')).toBe(receipt.reference.digest);expect(parsed.revision.id).toBe(analysisPackage.revision);expect(parsed.artifacts).toEqual([]);
 await expect(frame.locator('#archive-download-status')).toContainText('Browser download requested');await frame.getByRole('button',{name:'Discard export',exact:true}).click();
 await frame.locator('#close-archives').click();await expect(source).toHaveValue(edited);await frame.getByRole('button',{name:'Checkpoint',exact:true}).click();await expect(frame.locator('#editing')).not.toContainText('changed');
 const branch=(await query('plugins.branches',{plugin:analysisView.instance.plugin,after:null,limit:100})).branches.find((item:any)=>item.name==='archive-edits');expect(branch.head).not.toBe(analysisPackage.revision);
 await frame.getByRole('button',{name:'Import / export',exact:true}).click();await frame.getByRole('button',{name:'Open imported source',exact:true}).click();await expect(frame.locator('#archive-dialog')).toBeHidden();await expect(frame.locator('#subtitle')).toContainText('example.archive-import / Read-only revision');
 expect((await query('plugins.branch_head',{branch:branch.id})).revision).toBe(branch.head);
 expect((await query('plugins.instances',{after:null,limit:100})).total).toBe(initialCount);expect((await operations()).filter(record=>record.capability.id==='plugins.archive_import')).toHaveLength(1);expect(downloads).toHaveLength(1);
 await frame.getByRole('button',{name:'Import / export',exact:true}).click();await frame.getByRole('button',{name:'Discard transfer',exact:true}).click();await expect(frame.locator('#archive-progress')).toHaveText('No archive selected.');await frame.locator('#close-archives').click();
 await expect(note).toHaveValue('Other unsaved scientific draft 中文 Ω');expect((await query('views.inspect',{view:analysisView.view})).state.text).toBe('Saved analysis');expect(errors).toEqual([]);expect(lostChunk&&lostImport&&lostExport).toBe(true);await other.close();completed=true;
});
