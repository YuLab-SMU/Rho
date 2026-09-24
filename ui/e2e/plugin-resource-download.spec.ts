import { test, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, realpath, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildDownloadUiFixture, buildDownloadBackendFixture } from "../../scripts/fixtures/plugin-download.mjs";

let directory: string, project: string, url: URL, process_: ReturnType<typeof spawn>, view: any, instance: any;
let completed = false;
const windowId = "external.download-window";
async function port(method: string, params: any) {
  const reply = await fetch(new URL("/api/host", url), { method: "POST", headers: { Authorization: `Bearer ${url.hash.slice(7)}`, "Content-Type": "application/json", "X-Rho-Studio-Window": windowId },
    body: JSON.stringify({ project_root: project, frame: { id: crypto.randomUUID(), request: { method, params } } }) }).then(r => r.json());
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}
async function invoke(id: string, args: any) {
  const result = await port("invoke", { capability: { id, version: 1 }, arguments: args, preconditions: [], client_request_id: crypto.randomUUID() });
  expect(result.status, JSON.stringify(result.error)).toBe("succeeded"); return result.output;
}
async function query(id: string, args: any) { return (await port("query_snapshot", { capability: { id, version: 1 }, arguments: args })).data; }

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "rho-external-ui-"));
  project = join(directory, "project"); await mkdir(project); project = await realpath(project);
  const plugin = buildDownloadUiFixture(directory), database = join(directory, "state.sqlite");
  const installed = JSON.parse(execFileSync(resolve("../target/debug/rho"), ["--database", database, "plugins", "snapshot", plugin], { encoding: "utf8" })).result;
  const native = JSON.parse(execFileSync(resolve("../target/debug/rho"), ["--database", database, "plugins", "snapshot", buildDownloadBackendFixture(directory), "--target", "aarch64-apple-darwin"], { encoding: "utf8" })).result;
  process_ = spawn(resolve("../target/debug/rho"), ["--database", database, "--project", project, "workbench"], { stdio: ["ignore", "pipe", "pipe"] });
  url = new URL(await new Promise<string>((done, reject) => {
    let output = "", errors = "";
    const timer = setTimeout(() => reject(new Error(`Fixture Host startup timed out: ${errors}`)), 40000);
    process_.stderr!.on("data", b => errors += b);
    process_.stdout!.on("data", b => { output += b; const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-z0-9]+/); if (found) { clearTimeout(timer); done(found[0]); } });
    process_.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture Host exited ${code}: ${errors}`)); });
  }));
  const nativeInstance = (await invoke("plugins.activate", { revision: native.revision, artifact: native.artifacts[0], target: "aarch64-apple-darwin", alias: "native", configuration: {} })).instance;
  instance = (await invoke("plugins.activate", { revision: installed.revision, artifact: installed.artifacts[0], target: "ui-web", alias: "external", configuration: {} })).instance;
  const binding = await query("plugins.resolve", { capability: { id: "fixture.answer", version: 2 }, instance: nativeInstance.identity });
  const originalBinding = await query("plugins.resolve", { capability: { id: "fixture.read", version: 1 }, instance: nativeInstance.identity });
  const download_reference = (await query("fixture.read", { binding: originalBinding, arguments: { action: "resource_put" } })).reference;
  view = await invoke("views.open", { instance: instance.identity, contribution: "view", window: windowId, configuration: { binding, download_reference, external_url: "https://rho-external.invalid/document?read=1#topic" }, state: { text: "Initial Ω" } });
});
test.afterAll(async () => {
  if (process_?.exitCode === null) {
    process_.kill("SIGINT"); await new Promise<void>(done => process_.once("exit", () => done()));
  }
  if (directory && completed) await rm(directory, { recursive: true, force: true });
  else if (directory) console.error(`External UI fixture retained at ${directory}`);
});
test('scoped SDK downloads verify the exact original, refuse automatic actions and stop before a closed view can download', async ({ page, context }, info) => {
 const address=new URL(url);address.searchParams.set('window',windowId);address.searchParams.set('plugin-view',view.view);
 const downloads:string[]=[];page.on('download',download=>downloads.push(download.suggestedFilename()));await page.goto(address.href);
 const frame=page.frameLocator('iframe');await expect(frame.locator('#automatic-download')).toContainText('explicit Export action');expect(downloads).toEqual([]);
 const before=await query('operation.list_recent',{limit:100}),pending=page.waitForEvent('download');
 await frame.getByRole('button',{name:'Download original',exact:true}).click();const download=await pending;
 expect(download.suggestedFilename()).toBe('原始文件 α.bin');await download.saveAs(info.outputPath('downloaded-original.bin'));expect(await download.failure()).toBeNull();
 const bytes=await readFile(info.outputPath('downloaded-original.bin')),reference=view.configuration.download_reference;
 expect(bytes.length).toBe(reference.bytes);expect('sha256:'+createHash('sha256').update(bytes).digest('hex')).toBe(reference.digest);
 expect(bytes.every((value,index)=>value===index%251)).toBe(true);await expect(frame.locator('#download-result')).toHaveText('Original download requested');
 expect(await query('operation.list_recent',{limit:100})).toEqual(before);expect(context.pages()).toHaveLength(1);
 await frame.getByRole('button',{name:'Try foreign original',exact:true}).click();await expect(frame.locator('#download-result')).toContainText(/resource|original|not found/i);
 expect(downloads).toEqual(['原始文件 α.bin']);
 let release!:()=>void,sawRead!:()=>void,held=false;const gate=new Promise<void>(resolve=>release=resolve),observed=new Promise<void>(resolve=>sawRead=resolve);
 await page.route('**/api/plugin-view',async route=>{
  const body=route.request().postDataJSON()?.message?.body;
  if(!held&&body?.type==='query'&&body.capability?.id==='resources.read'){
   held=true;const response=await route.fetch();sawRead();await gate;await route.fulfill({response});
  }else await route.continue();
 });
 await frame.getByRole('button',{name:'Download original',exact:true}).click();await observed;
 try{await invoke('views.close',{view:view.view,mode:{kind:'flush'}});expect((await query('views.inspect',{view:view.view})).closed).toBe(true);}finally{release();}
 await expect(frame.locator('#download-result')).toContainText(/closed|closure|view connection|unavailable/i);
 expect(downloads).toEqual(['原始文件 α.bin']);expect((await query('plugins.instance',{instance:instance.identity})).instance.state).toBe('active');
 await invoke('plugins.release',{instance:instance.identity});completed=true;
});
