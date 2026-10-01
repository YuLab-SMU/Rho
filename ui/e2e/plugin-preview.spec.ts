import { test, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildUiFixture } from "../../scripts/fixtures/plugin-ui.mjs";

let directory: string, project: string, url: URL, process_: ReturnType<typeof spawn>, view: any, instance: any;
let completed = false;
const windowId = "fixture.preview-window";
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
  directory = await mkdtemp(join(tmpdir(), "rho-fixture-preview-"));
  project = join(directory, "project"); await mkdir(project); project = await realpath(project);
  const plugin = buildUiFixture(directory), database = join(directory, "state.sqlite");
  await writeFile(join(plugin, "src/index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview fixture</title>
    <style>*{box-sizing:border-box}body{margin:0;padding:20px;font:14px/1.5 system-ui;color:#202936}h1{font-size:22px}label{display:block;margin:16px 0 6px}input{width:100%;max-width:480px;padding:8px}button{margin:12px 8px 0 0;padding:6px 10px}output{display:block;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:12px}</style>
    <h1>Preview fixture</h1><p>This view runs from the exact native build artifact.</p><output id="connection">Connecting…</output><label for="note">View note</label><input id="note">
    <button id="save">Save note</button><button id="read">Read fixture</button><button id="missing">Read project</button><button id="write">Try write</button><button id="copy">Copy note</button><output id="result"></output><script type="module" src="./main.js"></script></html>`);
  await writeFile(join(plugin, "src/main.js"), `import {connectPluginView} from './sdk/index.js';
    const client=await connectPluginView(), note=document.querySelector('#note'), result=document.querySelector('#result');
    document.querySelector('#connection').textContent=client.view.purpose==='fixture_preview'?'Connected to fixture preview':'Wrong mode'; note.value=client.view.state.text;
    const action=(id,work)=>document.querySelector(id).onclick=()=>work().catch(error=>result.textContent=error.message);
    action('#save',async()=>{await client.setState({text:note.value});result.textContent='Saved';});
    action('#read',async()=>{const reply=await client.query({id:'plugins.list',version:1},{after:null,limit:10});result.textContent=reply.source+': '+reply.data.total;});
    action('#missing',async()=>{const reply=await client.query({id:'plugins.repository',version:1},{});result.textContent=reply.status+': '+reply.notices[0];});
    action('#write',async()=>{await client.invoke({id:'plugins.branch',version:1},{revision:client.view.instance.revision,name:'forbidden'},{requestId:'must-not-run'});result.textContent='Unexpected write';});
    action('#copy',async()=>{await client.copyText(note.value);result.textContent='Copied';});`);
  await rm(join(plugin,"dist"),{recursive:true,force:true});
  const installed = JSON.parse(execFileSync(resolve("../target/debug/rho"), ["--database", database, "plugins", "snapshot", plugin], { encoding: "utf8" })).result;
  expect(installed.artifacts).toEqual([]);
  process_ = spawn(resolve("../target/debug/rho"), ["--database", database, "--project", project, "workbench"], { stdio: ["ignore", "pipe", "pipe"] });
  url = new URL(await new Promise<string>((done, reject) => {
    let output = "", errors = "";
    const timer = setTimeout(() => reject(new Error(`Preview Host startup timed out: ${errors}`)), 40000);
    process_.stderr!.on("data", b => errors += b);
    process_.stdout!.on("data", b => { output += b; const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/); if (found) { clearTimeout(timer); done(found[0]); } });
    process_.once("exit", code => { clearTimeout(timer); reject(new Error(`Preview Host exited ${code}: ${errors}`)); });
  }));
  const build = await invoke("plugins.build",{revision:installed.revision,timeout_ms:20000});
  expect(build.revision).toBe(installed.revision); expect(build.artifact).toBeTruthy();
  expect((await query("plugins.instances",{after:null,limit:20})).instances).toEqual([]);
  instance = (await invoke("plugins.preview", { revision: installed.revision, artifact: build.artifact, alias: "preview", configuration: {},
    queries: [{ capability:{id:"plugins.list",version:1},arguments:{after:null,limit:10},data:{total:73} }] })).instance;
  view = await invoke("views.open", { instance: instance.identity, contribution: "view", window: windowId, configuration: {}, state: { text: "Initial Ω" } });
});
test.afterAll(async () => {
  if (process_?.exitCode === null) { process_.kill("SIGINT"); await new Promise<void>(done => process_.once("exit", () => done())); }
  if (directory && completed) await rm(directory, { recursive: true, force: true });
  else if (directory) console.error(`Preview fixture retained at ${directory}`);
});
test("native build runs as an isolated immutable fixture view with explicit mode and local state", async ({ page, context, request }, info) => {
  const address = new URL(url); address.searchParams.set("window", windowId); address.searchParams.set("plugin-view", view.view);
  await page.goto(address.href);
  const frame = page.frameLocator("iframe"), notice = page.locator("[data-plugin-preview=fixture]");
  await expect(notice).toHaveText("Fixture preview · Scientific writes disabled");
  await expect(frame.locator("#connection")).toHaveText("Connected to fixture preview");
  await frame.getByRole("button",{name:"Read fixture",exact:true}).click();
  await expect(frame.locator("#result")).toHaveText("fixture_preview: 73");
  expect((await query("plugins.list",{after:null,limit:10})).total).toBe(1);
  await frame.getByRole("button",{name:"Read project",exact:true}).click();
  await expect(frame.locator("#result")).toContainText("unavailable: No fixture matches");
  const before = await query("operation.list_recent",{limit:100});
  await frame.getByRole("button",{name:"Try write",exact:true}).click();
  await expect(frame.locator("#result")).toContainText("fixture previews cannot invoke");
  expect(await query("operation.list_recent",{limit:100})).toEqual(before);
  await frame.getByLabel("View note").fill("中文 · fixture αβ");
  await page.keyboard.press("End"); await page.keyboard.insertText(" ✓");
  await frame.getByRole("button",{name:"Save note",exact:true}).click();
  await expect(frame.locator("#result")).toHaveText("Saved");
  expect((await query("views.inspect",{view:view.view})).state.text).toBe("中文 · fixture αβ ✓");
  await frame.getByRole("button",{name:"Copy note",exact:true}).click();
  await expect(frame.locator("#result")).toHaveText("Copied");
  await context.grantPermissions(["clipboard-read"],{origin:url.origin});
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe("中文 · fixture αβ ✓"); await context.clearPermissions();
  await page.reload();
  await expect(frame.getByLabel("View note")).toHaveValue("中文 · fixture αβ ✓");
  await expect(notice).toBeVisible();
  for (const width of [1440,1920,390,220]) {
    await page.setViewportSize({width,height:900});
    await expect(notice).toBeVisible(); await expect(frame.getByRole("button",{name:"Save note",exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await page.frames()[1].evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath(`fixture-preview-${width}.png`)});
  }
  const assetUrl = new URL((await page.locator("iframe").getAttribute("src"))!,url.origin).href;
  const retained = await query("views.inspect",{view:view.view});
  await invoke("views.close",{view:view.view,mode:{kind:"retain_acknowledged",expected_version:retained.state_version}});
  expect((await request.get(assetUrl)).status()).toBe(404);
  await invoke("plugins.release",{instance:instance.identity});
  expect((await query("plugins.instance",{instance:instance.identity})).instance.state).toBe("released");
  completed = true;
});
