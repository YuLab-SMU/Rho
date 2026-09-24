import { test, expect, type Page } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, realpath, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let directory: string, project: string, database: string, url: URL, host: ReturnType<typeof spawn>;
let rLeft: any, rRight: any, viewer: any, leftSession: string, rightSession: string;
let leftRevision: string, rightRevision: string;
const windowId = "viewer-control";
async function port(method: string, params: any) {
  const reply = await fetch(new URL("/api/host", url), { method: "POST", headers: {
    Authorization: `Bearer ${url.hash.slice(7)}`, "Content-Type": "application/json", "X-Rho-Studio-Window": windowId,
  }, body: JSON.stringify({ project_root: project, frame: { id: crypto.randomUUID(), request: { method, params } } }) }).then(r => r.json());
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}
async function invoke(id: string, args: any) {
  const record = await port("invoke", { client_request_id: crypto.randomUUID(), capability: { id, version: 1 }, arguments: args, preconditions: [] });
  expect(record.status, JSON.stringify(record.error)).toBe("succeeded"); return record.output;
}
async function query(id: string, args: any) { return (await port("query_snapshot", { capability: { id, version: 1 }, arguments: args })).data; }
async function startHost() {
  host = spawn(resolve("../target/debug/rho"), ["--database", database, "--project", project, "workbench"], { stdio: ["ignore", "pipe", "pipe"] });
  url = new URL(await new Promise<string>((done, reject) => {
    let out = "", errors = "";
    const timer = setTimeout(() => reject(new Error(`Disposable Host startup deadline: ${errors}`)), 40000);
    host.stderr!.on("data", data => errors += data);
    host.stdout!.on("data", data => { out += data; const found = out.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-z0-9]+/); if (found) { clearTimeout(timer); done(found[0]); } });
    host.once("exit", code => { clearTimeout(timer); reject(new Error(`Disposable Host exited ${code}: ${errors}`)); });
  }));
}
async function stopHost() {
  if (host?.exitCode === null && host.signalCode === null) {
    host.kill("SIGINT");
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => { host.kill("SIGKILL"); reject(new Error("Disposable Host did not finish shutdown")); }, 30000);
      host.once("exit", () => { clearTimeout(timer); done(); });
    });
  }
}
function snapshot(path: string, parent?: string, native = false) {
  return JSON.parse(execFileSync(resolve("../target/debug/rho"), ["--database", database, "plugins", "snapshot", path, "--target", native ? "aarch64-apple-darwin" : "ui-web", ...(parent ? ["--parent", parent] : [])], { encoding: "utf8" })).result;
}
async function activate(revision: any, alias: string, native = false) {
  return (await invoke("plugins.activate", { revision: revision.revision, artifact: revision.artifacts[0], target: native ? "aarch64-apple-darwin" : "ui-web", alias,
    configuration: native ? { ark: await realpath(process.env.RHO_ARK!), r_home: await realpath(process.env.RHO_R_HOME!), execution_timeout_seconds: 30 } : {} })).instance.identity;
}
async function createSession(instance: any) {
  const binding = await query("plugins.resolve", { instance, capability: { id: "r.create_session", version: 1 } });
  return (await invoke("r.create_session", { binding, arguments: {} })).session_id;
}
async function execute(instance: any, session: string, code: string, accepted = false, version = 1) {
  const binding = await query("plugins.resolve", { instance, capability: { id: "r.execute", version } });
  const arguments_ = version === 1 ? { expected_session: session, code } : { expected_session: session, run: { code, source: { view_id: "viewer-script", label: "分析 · viewer.R", kind: "file" } } };
  return port("invoke", { capability: { id: "r.execute", version }, client_request_id: crypto.randomUUID(),
    arguments: { binding, arguments: arguments_ }, preconditions: [], return_after_acceptance: accepted });
}
async function openView(source: any, window: string, state = {}) {
  return invoke("views.open", { instance: viewer, contribution: "viewer", window, configuration: { source }, state });
}
async function show(page: Page, view: any) {
  const address = new URL(url); address.searchParams.set("window", view.window); address.searchParams.set("plugin-view", view.view);
  await page.goto(address.href);
}
function document(page: Page) { return page.frameLocator("iframe").frameLocator("iframe"); }
async function releaseNative(instance: any) {
  await expect.poll(async () => (await query("plugins.instance", { instance })).retained_calls).toBe(0);
  await invoke("plugins.release", { instance });
}

test.beforeAll(async () => {
  test.setTimeout(120000);
  expect(process.env.RHO_R_PLUGIN_PACKAGE).toBeTruthy(); expect(process.env.RHO_VIEWER_PLUGIN_PACKAGE).toBeTruthy();
  directory = await mkdtemp(join(tmpdir(), "rho-viewer-browser-"));
  project = join(directory, "project"); await mkdir(project); project = await realpath(project); database = join(directory, "state.sqlite");
  const left = snapshot(process.env.RHO_R_PLUGIN_PACKAGE!, undefined, true); leftRevision = left.revision;
  // Editing a development manifest cannot change the already snapshotted artifact.
  const manifestPath = join(process.env.RHO_R_PLUGIN_PACKAGE!, "plugin.json");
  const original = await readFile(manifestPath, "utf8"), manifest = JSON.parse(original); manifest.version = "0.1.1";
  let right: any;
  try { await writeFile(manifestPath, JSON.stringify(manifest)); right = snapshot(process.env.RHO_R_PLUGIN_PACKAGE!, left.revision, true); }
  finally { await writeFile(manifestPath, original); }
  rightRevision = right.revision;
  const ui = snapshot(process.env.RHO_VIEWER_PLUGIN_PACKAGE!);
  await startHost(); rLeft = await activate(left, "left-r", true); rRight = await activate(right, "right-r", true); viewer = await activate(ui, "viewer");
  leftSession = await createSession(rLeft); rightSession = await createSession(rRight);
  expect(leftSession).not.toBe(rightSession); expect(rLeft.revision).not.toBe(rRight.revision);
});
test.afterAll(async () => { await stopHost(); if (directory) await rm(directory, { recursive: true, force: true }); });

test("ordinary Viewer presents real retained HTML across revisions, closure and restart", async ({ page, context, request }) => {
  test.setTimeout(180000);
  let left = await openView(rLeft, "viewer-left");
  const right = await openView(rRight, "viewer-right");
  const secondPage = await context.newPage();
  const calls: string[] = [], faults: string[] = [];
  page.on("pageerror", error => faults.push(error.message));
  page.on("request", request => {
    if (request.url().includes("/api/plugin-view")) { const body = request.postDataJSON()?.message?.body; calls.push(`${body?.type}:${body?.capability?.id ?? "self"}`); }
  });
  await show(page, left); await show(secondPage, right);
  await expect(page.frameLocator("iframe").locator("#message")).toContainText("No HTML output selected");
  const first = await execute(rLeft, leftSession, `f <- tempfile(fileext='.html'); writeLines('<h1>Left · 中文 Ω</h1><input aria-label="Widget note"><button onclick="this.textContent=String(Number(this.textContent)+1)">0</button>', f); getOption('viewer')(f); 21`);
  expect(first.status).toBe("succeeded");
  const second = await execute(rRight, rightSession, `stopifnot(requireNamespace('DT', quietly=TRUE)); print(DT::datatable(data.frame(origin='Right revision', value=1:3), options=list(pageLength=3))); 42`);
  expect(second.status, JSON.stringify(second.error)).toBe("succeeded");
  await expect(document(page).getByRole("heading")).toHaveText("Left · 中文 Ω");
  await document(page).getByRole("button", { name: "0", exact: true }).click(); await expect(document(page).getByRole("button", { name: "1", exact: true })).toBeVisible();
  await document(page).getByRole("textbox", { name: "Widget note" }).fill("中文输入 αβ");
  await page.keyboard.press("End"); await page.keyboard.insertText(" ✓");
  await expect(document(page).getByRole("textbox")).toHaveValue("中文输入 αβ ✓");
  await expect(document(secondPage).locator(".dataTables_wrapper")).toBeVisible();
  await expect(document(secondPage).locator("body")).toContainText("Right revision");
  await document(secondPage).locator('input[type="search"]').fill('missing-row');
  await expect(document(secondPage).locator('tbody')).toContainText('No matching records');
  await document(secondPage).locator('input[type="search"]').fill('Right revision');
  await expect(document(secondPage).locator('tbody tr')).toHaveCount(3);
  const source = page.frameLocator("iframe").locator("#source-details");
  expect(await source.textContent()).toContain(rLeft.revision); expect(await source.textContent()).not.toContain(rRight.revision);
  const isolation = await page.frames()[2].evaluate(async (origin) => {
    let parentBlocked=false,topBlocked=false,apiBlocked=false,storageBlocked=false;
    try { void parent.document.body; } catch { parentBlocked=true; }
    try { void top!.document.body; } catch { topBlocked=true; }
    try { void localStorage.length; } catch { storageBlocked=true; }
    try { await fetch(origin + '/api/info'); } catch { apiBlocked=true; }
    return {parentBlocked,topBlocked,apiBlocked,storageBlocked};
  }, url.origin);
  expect(isolation).toEqual({parentBlocked:true,topBlocked:true,apiBlocked:true,storageBlocked:true});
  const outerSrc = await page.locator("iframe").getAttribute("src");
  const assets = await request.get(new URL(outerSrc!,url.origin).href);
  expect(assets.headers()["content-security-policy"]).toContain("frame-src 'none'");
  expect(await page.frameLocator("iframe").locator("iframe").getAttribute("sandbox")).toBe("allow-scripts");
  const before = await page.frameLocator("iframe").locator("iframe").elementHandle();
  await page.frameLocator("iframe").getByRole("button",{name:"Refresh",exact:true}).click();
  await expect.poll(()=>before!.evaluate(frame=>frame.isConnected)).toBe(false);
  await expect(document(page).getByRole("button",{name:"0",exact:true})).toBeVisible();
  const third = await execute(rLeft,leftSession,`f <- tempfile(fileext='.html'); writeLines('<h1>Left later output</h1>',f); getOption('viewer')(f); 84`,false,2);
  expect(third.status).toBe("succeeded");
  await expect(document(page).getByRole("heading")).toHaveText("Left later output");
  expect(await source.textContent()).toContain("Input: 分析 · viewer.R (file)");
  await page.setViewportSize({width:390,height:900});
  await page.frameLocator("iframe").locator("summary").click();
  await page.screenshot({path:'../target/plugin-refactor/viewer-v2-source-390.png'});
  await page.frameLocator("iframe").locator("summary").click();
  await page.setViewportSize({width:1440,height:900});
  const outer=page.frameLocator("iframe");
  await expect(outer.locator(".history-item")).toHaveCount(2);
  await outer.locator(".history-item").filter({hasText:first.operation.operation_id.slice(0,8)}).click();
  await expect(document(page).getByRole("heading")).toHaveText("Left · 中文 Ω");
  await expect.poll(async()=>(await query("views.inspect",{view:left.view})).state.follow).toBe(false);
  await page.reload(); await expect(document(page).getByRole("heading")).toHaveText("Left · 中文 Ω");
  const reloaded = await query("views.inspect", { view: left.view });
  await invoke("views.close", { view: left.view, mode: { kind: "retain_acknowledged", expected_version: reloaded.state_version } });
  left = await openView(rLeft, "viewer-flush", reloaded.state); await show(page, left);
  await expect(document(page).getByRole("heading")).toHaveText("Left · 中文 Ω");
  for(const width of [1440,1920,390]) {
    await page.setViewportSize({width,height:900});
    await secondPage.setViewportSize({width,height:900});
    expect(await outer.locator("body").evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
    expect(await secondPage.frameLocator("iframe").locator("body").evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
    await page.screenshot({path:`../target/plugin-refactor/viewer-${width}.png`});
    await secondPage.screenshot({path:`../target/plugin-refactor/viewer-dt-${width}.png`});
  }
  await outer.locator("summary").click();
  const detailsBox=await source.boundingBox(); expect(detailsBox).not.toBeNull();
  expect(detailsBox!.x).toBeGreaterThanOrEqual(0); expect(detailsBox!.x+detailsBox!.width).toBeLessThanOrEqual(390);
  await page.screenshot({path:'../target/plugin-refactor/viewer-source-390.png'});
  await outer.locator("summary").click();
  const running=await execute(rLeft,leftSession,"writeLines('started','viewer-run-started'); Sys.sleep(2); continuation <- 123; continuation",true);
  await expect.poll(async()=>{try{await access(join(project,'viewer-run-started'));return true;}catch{return false;}}).toBe(true);
  const saved = await query("views.inspect",{view:left.view});
  await invoke("views.close",{view:left.view}); await page.goto("about:blank");
  await expect.poll(async()=>(await port("get_operation",{operation_id:running.operation.operation_id})).status).toBe("succeeded");
  const reopened=await openView(rLeft,"viewer-reopened",saved.state);
  await show(page,reopened); await expect(document(page).getByRole("heading")).toHaveText("Left · 中文 Ω");
  expect((await port("get_operation",{operation_id:running.operation.operation_id})).output.value).toBe(123);
  await releaseNative(rLeft); await releaseNative(rRight);
  await invoke("plugins.remove",{revision:rightRevision}); await invoke("plugins.remove",{revision:leftRevision});
  await outer.getByRole("button",{name:"Refresh",exact:true}).click();
  await expect(document(page).getByRole("heading")).toHaveText("Left · 中文 Ω");
  expect(calls.every(call=>call.startsWith('query:')||['set_state:self','register_close_handler:self','observe_lifecycle:self','prepare_close:self','refuse_close:self'].includes(call))).toBe(true);
  const viewerRevision=viewer.revision,viewerArtifact=viewer.artifact;
  await stopHost(); await secondPage.close(); await startHost();
  viewer=(await invoke("plugins.activate",{revision:viewerRevision,artifact:viewerArtifact,target:'ui-web',alias:'restored-viewer',configuration:{}})).instance.identity;
  const restored=await openView(rLeft,"viewer-restored",saved.state);
  await show(page,restored); await expect(document(page).getByRole("heading")).toHaveText("Left · 中文 Ω");
  const instances=await query("plugins.instances",{after:null,limit:100});
  expect(instances.instances.filter((item:any)=>item.observed_in_this_host&&item.instance.identity.plugin==='org.rho.r')).toHaveLength(0);
  await invoke("views.close",{view:restored.view}); await invoke("plugins.release",{instance:viewer});
  expect(faults).toEqual([]);
});
