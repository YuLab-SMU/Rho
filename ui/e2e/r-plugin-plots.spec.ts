/** Disposable native R acceptance for the independently built Plots package. */
import { test, expect, type Page } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
let directory: string, project: string, database: string, url: URL, host: ReturnType<typeof spawn>;
let r: any, plotsInstance: any;
let completed = false;
async function port(method: string, params: any) {
  const reply = await fetch(new URL("/api/host", url), { method: "POST", headers: {
    Authorization: `Bearer ${url.hash.slice(7)}`, "Content-Type": "application/json", "X-Rho-Studio-Window": "plots-control",
  }, body: JSON.stringify({ project_root: project, frame: { id: crypto.randomUUID(), request: { method, params } } }) }).then(response => response.json());
  if (!reply.ok) throw new Error(reply.error); return reply.result;
}
async function invoke(id: string, arguments_: any) {
  const record = await port("invoke", { capability: { id, version: 1 }, client_request_id: crypto.randomUUID(), arguments: arguments_, preconditions: [] });
  if (id === "plugins.activate" && record.status !== "succeeded") {
    console.error("Unpublished activation observation:", JSON.stringify(await query("plugins.instances", { limit: 10 })));
  }
  expect(record.status, JSON.stringify(record.error)).toBe("succeeded"); return record.output;
}
async function query(id: string, args: any) { return (await port("query_snapshot", { capability: { id, version: 1 }, arguments: args })).data; }
async function startHost() {
  host = spawn(resolve("../target/debug/rho"), ["--database", database, "--project", project, "workbench"], { stdio: ["ignore", "pipe", "pipe"] });
  url = new URL(await new Promise<string>((done, reject) => {
    let output = "", errors = "";
    const timer = setTimeout(() => reject(new Error(`Disposable Host startup deadline: ${errors}`)), 40000);
    host.stderr!.on("data", data => errors += data);
    host.stdout!.on("data", data => { output += data; const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-z0-9]+/); if (found) { clearTimeout(timer); done(found[0]); } });
    host.once("exit", code => { clearTimeout(timer); reject(new Error(`Disposable Host exited ${code}: ${errors}`)); });
  }));
}
async function stopHost() {
  if (host?.exitCode === null && host.signalCode === null) {
    host.kill("SIGINT");
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => { host.kill("SIGKILL"); reject(new Error("Disposable Host did not confirm shutdown")); }, 30000);
      host.once("exit", () => { clearTimeout(timer); done(); });
    });
  }
}
async function show(page: Page, view: any) {
  const address = new URL(url); address.searchParams.set("window", view.window); address.searchParams.set("plugin-window", ""); await page.goto(address.href);
}
async function openView(window: string, state = {}) { return (await invoke("windows.open_view", { view: { instance: plotsInstance, contribution: "plots", window, configuration: { source: r, selection: null, pinned: false, plot_group: null }, state }, expected_layout_version: 0, group: null })).view; }
test.beforeAll(async () => {
  test.setTimeout(120000);
  expect(process.env.RHO_R_PLUGIN_PACKAGE).toBeTruthy(); expect(process.env.RHO_PLOTS_PLUGIN_PACKAGE).toBeTruthy();
  directory = await mkdtemp(join(tmpdir(), "rho-plots-native-")); project = join(directory, "project"); await mkdir(project); project = await realpath(project); database = join(directory, "state.sqlite");
  const snapshot = (path: string, target: string) => JSON.parse(execFileSync(resolve("../target/debug/rho"), ["--database", database, "plugins", "snapshot", path, "--target", target], { encoding: "utf8" })).result;
  const native = snapshot(process.env.RHO_R_PLUGIN_PACKAGE!, "aarch64-apple-darwin"), ui = snapshot(process.env.RHO_PLOTS_PLUGIN_PACKAGE!, "ui-web");
  await startHost();
  r = (await invoke("plugins.activate", { revision: native.revision, artifact: native.artifacts[0], target: "aarch64-apple-darwin", alias: "r",
    configuration: { ark: await realpath(process.env.RHO_ARK!), r_home: await realpath(process.env.RHO_R_HOME!), execution_timeout_seconds: 30 } })).instance.identity;
  plotsInstance = (await invoke("plugins.activate", { revision: ui.revision, artifact: ui.artifacts[0], target: "ui-web", alias: "plots", configuration: {} })).instance.identity;
});
test.afterAll(async () => {
  await stopHost();
  if (directory && completed) await rm(directory, { recursive: true, force: true });
  else if (directory) console.error(`Incomplete disposable Plots acceptance retained: ${directory}`);
});

test("ordinary Plots reads native PNG outputs, captures view choices and retains originals after R release",async({page},info)=>{
 test.setTimeout(180000);
 const binding=async(id:string,version=1)=>query('plugins.resolve',{instance:r,capability:{id,version}});
 await invoke('r.create_session',{binding:await binding('r.create_session'),arguments:{}});
 const session=(await query('r.session',{binding:await binding('r.session'),arguments:{}})).session_id,execute=await binding('r.execute',2);
 const run=(code:string)=>port('invoke',{capability:{id:'r.execute',version:2},client_request_id:crypto.randomUUID(),preconditions:[],arguments:{binding:execute,arguments:{expected_session:session,run:{code,output_mode:'console',source:{view_id:'fixture',kind:'console',label:'Native plot acceptance'}}}}});
 const first=await run('plot(1:5, (1:5)^2, main="Original plot", col="#2863d6", pch=19)');expect(first.status,JSON.stringify(first.error)).toBe('succeeded');
 const original=first.output.outputs.find((item:any)=>item.reference.media_type==='image/png');expect(original).toBeTruthy();
 let view=await openView('plots-native');await show(page,view);
 const frame=page.locator('[data-plugin-frame]').first().frameLocator('iframe'),canvas=frame.getByLabel('Plot Canvas');
 await expect(frame.locator('.plot-original img')).toBeVisible();await expect.poll(()=>frame.locator('.plot-original img').evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBeGreaterThan(0);
 for(const width of [1440,1920,390]){
  await page.setViewportSize({width,height:900});await expect.poll(()=>canvas.evaluate(()=>innerWidth)).toBeGreaterThan(width-20);
  expect(await canvas.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await canvas.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:info.outputPath(`plots-native-${width}.png`)});
 }
 await frame.getByRole('button',{name:'Details',exact:true}).click();await expect(frame.getByRole('dialog')).toContainText(original.reference.digest);await expect(frame.getByRole('dialog')).toContainText('Native plot acceptance');await page.keyboard.press('Escape');
 const executions=async()=>(await query('operation.list_recent',{limit:100})).operations.filter((item:any)=>item.capability.id==='r.execute');expect(await executions()).toHaveLength(1);
 await frame.getByRole('button',{name:'Plot Actions',exact:true}).click();await frame.getByRole('menuitem',{name:'Open Plot in New View',exact:true}).click();
 let saved:any,navigation:any;
 await expect.poll(async()=>{
  saved=await query('views.inspect',{view:view.view});const receipt=saved.state.actions?.receipt;if(!receipt)return 'not observed';navigation=(await query('operation.get',{operation_id:receipt.id})).record;return navigation.status;
 }).toBe('succeeded');
 const pinned=navigation.output.view;expect(pinned.instance).toEqual(plotsInstance);expect(pinned.configuration).toEqual({source:r,selection:{operation_id:first.operation.operation_id,resource_id:original.reference.resource},pinned:true,plot_group:null});
 const second=await run('plot(5:1, main="Later plot", col="#25775b", pch=19)');expect(second.status).toBe('succeeded');
 // The same window observes and selects the newly pinned view without reload.
 const comparisonFrame=page.locator(`[data-plugin-frame="${pinned.view}"]`).frameLocator('iframe');
 await expect(comparisonFrame.locator('.plot-original img')).toBeVisible();await expect(comparisonFrame.locator('.panel-footer')).toContainText('Pinned plot');
 await expect(canvas).toBeHidden();
 await expect(comparisonFrame.getByLabel('Select Plot 1')).toHaveAttribute('aria-pressed','true');await expect(comparisonFrame.getByLabel('Plot History').getByRole('button',{name:/Select Plot/})).toHaveCount(2);
 await page.screenshot({path:info.outputPath('plots-native-pinned-390.png')});
 await page.getByRole('tab',{name:'Plots',exact:true}).nth(1).locator('[data-layout-path$="/button/close"]').click();
 await expect(page.locator(`[data-plugin-frame="${pinned.view}"]`)).toHaveCount(0);await expect(canvas).toBeVisible();
 await expect(frame.getByLabel('Select Plot 2')).toHaveAttribute('aria-pressed','true');
 await page.screenshot({path:info.outputPath('plots-native-follow-390.png')});
 await frame.getByRole('button',{name:'Inspect Operation',exact:true}).click();
 await frame.getByRole('button',{name:'Zoom In',exact:true}).click();
 const working=run('Sys.sleep(5); plot_finished <- TRUE');await expect.poll(async()=>(await query('r.inspection_state',{binding:await binding('r.inspection_state'),arguments:{expected_session:session}})).status).toBe('busy');
 await frame.getByRole('button',{name:'Plot Actions',exact:true}).click();await frame.getByRole('menuitem',{name:'Hide Plot History',exact:true}).click();await invoke('views.close',{view:view.view});
 saved=await query('views.inspect',{view:view.view});expect(saved.closed).toBe(true);expect(saved.state.plots.plotViews.plots.history).toBe(false);
 expect((await query('r.inspection_state',{binding:await binding('r.inspection_state'),arguments:{expected_session:session}})).status).toBe('busy');expect((await working).status).toBe('succeeded');
 await invoke('plugins.release',{instance:r});
 view=await openView('plots-retained',saved.state);await show(page,view);await expect(frame.locator('.plot-original img')).toBeVisible();await expect(frame.getByLabel('Plot History')).toHaveCount(0);
 expect(await executions()).toHaveLength(3);await invoke('views.close',{view:view.view});await invoke('plugins.release',{instance:plotsInstance});completed=true;
});
