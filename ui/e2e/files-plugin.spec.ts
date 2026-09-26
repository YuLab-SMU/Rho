/** Actual independent combined Files backend/UI. The Editor target is a route
 * fixture only; this test does not claim an implemented ordinary Editor. */
import { test, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
let directory: string, project: string, url: URL, process_: ReturnType<typeof spawn>, view: any, instance: any, editor: any;
let completed = false;
const windowId = "files-independent-window", binary = resolve("../target/debug/rho");
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
async function port(method: string, params: any) {
  const reply = await fetch(new URL("/api/host", url), { method: "POST", headers: { Authorization: `Bearer ${url.hash.slice(7)}`, "Content-Type": "application/json", "X-Rho-Studio-Window": windowId },
    body: JSON.stringify({ project_root: project, frame: { id: crypto.randomUUID(), request: { method, params } } }) }).then(r => r.json());
  if (!reply.ok) throw new Error(reply.error); return reply.result;
}
async function invoke(id: string, args: any) {
  const record = await port("invoke", { capability: { id, version: 1 }, arguments: args, preconditions: [], client_request_id: crypto.randomUUID() });
  expect(record.status, JSON.stringify(record.error)).toBe("succeeded"); return record.output;
}
async function query(id: string, args: any) { return (await port("query_snapshot", { capability: { id, version: 1 }, arguments: args })).data; }
function editorFixture() {
  const root = join(directory, "editor-route"); mkdirSync(join(root, "dist"), { recursive: true });
  const html = `<!doctype html><meta charset="utf-8"><h1>Editor route fixture</h1><pre id="file"></pre><script>
  const nonce=new URLSearchParams(location.hash.slice(1)).get('rho-view-nonce');
  addEventListener('message',event=>{if(event.source===parent&&event.data?.type==='rho:view:connect'&&event.data.nonce===nonce)
    document.querySelector('#file').textContent=JSON.stringify(event.data.view.configuration,null,2);});
  parent.postMessage({type:'rho:view:ready',nonce},'*');</script>`;
  writeFileSync(join(root, "index.html"), html); writeFileSync(join(root, "dist/index.html"), html);
  writeFileSync(join(root, "BUILD.md"), "Copy index.html into dist/index.html."); writeFileSync(join(root, "dependencies.lock"), "No dependencies.");
  writeFileSync(join(root, "plugin.json"), JSON.stringify({ protocol_version: 1, id: "fixture.editor-route", name: "Editor route fixture", version: "1", description: "Observe an explicit Files navigation without editing data", license: "MIT",
    source: { files: ["index.html"], lockfiles: ["dependencies.lock"], build_instructions: "BUILD.md", build: null }, dependencies: {}, requires: [], capabilities: [], contexts: [], backend: null,
    views: [{ id: "editor", title: "Editor route fixture", entrypoint: "dist/index.html", state_schema: { type: "object" }, configuration_schema: { type: "object" }, resource_kinds: [] }], configuration_schema: { type: "object" }, default_configuration: {} }));
  return root;
}
test.beforeAll(async () => {
  test.setTimeout(600000);
  directory = realpathSync(mkdtempSync(join(tmpdir(), "rho-files-ui-native-"))); project = join(directory, "project"); mkdirSync(project);
  for (const path of ["analysis.R", "notes.txt", "分析结果.R", ".hidden.R", "a-very-long-file-name-for-layout-observation-and-reading-the-full-path.R"]) writeFileSync(join(project, path), `# ${path}\n`);
  mkdirSync(join(project, "data")); writeFileSync(join(project, "data", "sample.csv"), "sample,value\na,1\n");
  execFileSync("git", ["init", "-q", project]);
  const before = digest(binary), packagePath = process.env.RHO_FILES_PLUGIN_PACKAGE ?? join(directory, "files");
  if (!process.env.RHO_FILES_PLUGIN_PACKAGE) execFileSync(process.execPath, [resolve("../scripts/build-files-plugin.mjs"), packagePath], { stdio: "inherit" });
  expect(digest(binary)).toBe(before);
  const database = join(directory, "state.sqlite"), snapshot = (path: string, target: string) => JSON.parse(execFileSync(binary, ["--database", database, "plugins", "snapshot", path, "--target", target], { encoding: "utf8" })).result;
  const files = snapshot(packagePath, "aarch64-apple-darwin"), target = snapshot(editorFixture(), "ui-web");
  process_ = spawn(binary, ["--database", database, "--project", project, "workbench"], { stdio: ["ignore", "pipe", "pipe"] });
  url = new URL(await new Promise<string>((done, reject) => {
    let output = "", errors = ""; const timer = setTimeout(() => reject(new Error(`Files fixture Host startup timed out: ${errors}`)), 90000);
    process_.stderr!.on("data", b => errors += b); process_.stdout!.on("data", b => { output += b; const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-z0-9]+/); if (found) { clearTimeout(timer); done(found[0]); } });
    process_.once("exit", code => { clearTimeout(timer); reject(new Error(`Files fixture Host exited ${code}: ${errors}`)); });
  }));
  instance = (await invoke("plugins.activate", { revision: files.revision, artifact: files.artifacts[0], target: "aarch64-apple-darwin", alias: "files", configuration: {} })).instance;
  editor = (await invoke("plugins.activate", { revision: target.revision, artifact: target.artifacts[0], target: "ui-web", alias: "editor-route", configuration: {} })).instance;
  view = (await invoke("windows.open_view", { expected_layout_version: 0, group: null,
    view: { instance: instance.identity, contribution: "files", window: windowId, configuration: { editor: editor.identity, editor_group: null }, state: {} } })).view;
});
test.afterAll(async () => {
  if (process_?.exitCode === null) { process_.kill("SIGINT"); await new Promise<void>(done => process_.once("exit", () => done())); }
  if (directory && completed) rmSync(directory, { recursive: true, force: true }); else if (directory) console.error(`Files fixture retained at ${directory}`);
});
test("independent Files lists, searches, captures state and opens an exact Editor target in the generic window", async ({ page }, info) => {
  test.setTimeout(180000);
  const address = new URL(url); address.searchParams.set("window", windowId); address.searchParams.set("plugin-window", "");
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); await page.goto(address.href);
  const region = (id: string) => page.locator(`[data-plugin-frame="${id}"]`), frame = region(view.view).frameLocator("iframe");
  const filter = frame.getByRole("textbox", { name: "Filter Directory Entries" });
  await expect(frame.getByRole("button", { name: "R analysis.R", exact: true })).toBeVisible();
  await expect(frame.getByRole("button", { name: "R .hidden.R", exact: true })).toHaveCount(0);
  for (const width of [1440, 1920, 390, 220]) {
    await page.setViewportSize({ width, height: 900 }); await filter.click(); await expect(filter).toBeFocused();
    await filter.evaluate(() => document.fonts.ready);
    expect(await filter.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: info.outputPath(`files-native-${width}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await frame.getByRole("checkbox", { name: "Hidden files" }).check(); await expect(frame.getByRole("button", { name: "R .hidden.R", exact: true })).toBeVisible();
  await filter.fill("分析"); await expect(frame.getByRole("button", { name: "R 分析结果.R", exact: true })).toBeVisible();
  await expect(frame.getByRole("button", { name: "R analysis.R", exact: true })).toHaveCount(0);
  await filter.fill(""); await frame.getByRole("button", { name: "› data", exact: true }).click(); await expect(frame.getByRole("button", { name: "▤ sample.csv", exact: true })).toBeVisible();
  await frame.getByRole("combobox", { name: "File Search Scope" }).selectOption("project");
  const search = frame.getByRole("textbox", { name: "Search Project Files" });
  await search.fill("notes"); await search.dispatchEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true });
  await expect(frame.getByRole("button", { name: "notes.txt", exact: true })).toHaveCount(0);
  await search.press("Enter"); await expect(frame.getByRole("button", { name: "notes.txt", exact: true })).toBeVisible();
  await search.fill("sample"); await frame.getByRole("button", { name: "Search", exact: true }).click();
  await expect(frame.getByRole("button", { name: "data/sample.csv", exact: true })).toBeVisible();
  await frame.getByRole("button", { name: "data/sample.csv", exact: true }).click();
  await frame.getByRole("button", { name: "Open", exact: true }).click();
  const editorTab = page.getByRole("tab", { name: "Editor route fixture", exact: true }); await expect(editorTab).toBeVisible();
  const layout = await query("windows.layout", { window: windowId });
  const opened = await query("views.inspect", { view: layout.layout.selected });
  expect(opened.instance).toEqual(editor.identity); expect(opened.configuration.source).toEqual(instance.identity);
  expect(opened.configuration.file).toMatchObject({ path: "data/sample.csv", kind: "regular", sha256: `sha256:${digest(join(project, "data/sample.csv"))}` });
  expect(opened.window).toBe(windowId);
  const filesTab = page.getByRole("tab", { name: "Files", exact: true }); await filesTab.click();
  await frame.getByRole("combobox", { name: "File Search Scope" }).selectOption("directory"); await filter.fill("保留 中文");
  await filter.dispatchEvent("compositionstart"); await filesTab.locator('[data-layout-path$="/button/close"]').click();
  await expect(page.getByRole("button", { name: "Try closing again", exact: true })).toBeVisible();
  await filter.dispatchEvent("compositionend"); await page.getByRole("button", { name: "Try closing again", exact: true }).click();
  await expect(region(view.view)).toHaveCount(0);
  const closed = await query("views.inspect", { view: view.view }); expect(closed.closed).toBe(true);
  expect(closed.state.files).toMatchObject({ showHiddenFiles: true, expandedDirectories: ["", "data"], fileSearch: { filter: "保留 中文", selected: "data/sample.csv" } });
  expect((await query("plugins.instance", { instance: instance.identity })).instance.state).toBe("active");
  const current = await query("windows.layout", { window: windowId });
  const reopened = (await invoke("windows.open_view", { expected_layout_version: current.version, group: current.layout.id,
    view: { instance: instance.identity, contribution: "files", window: windowId, configuration: view.configuration, state: closed.state } })).view;
  const restored = region(reopened.view).frameLocator("iframe"); await expect(restored.getByRole("textbox", { name: "Filter Directory Entries" })).toHaveValue("保留 中文");
  await expect(restored.getByRole("checkbox", { name: "Hidden files" })).toBeChecked();
  await restored.getByRole("textbox", { name: "Filter Directory Entries" }).fill("");
  writeFileSync(join(project, "external-created.R"), "# External native mutation\n");
  await restored.getByRole("button", { name: "Refresh Files" }).click(); await expect(restored.getByRole("button", { name: "R external-created.R", exact: true })).toBeVisible();
  await restored.getByRole("button", { name: "Open…", exact: true }).click(); await expect(restored.getByRole("dialog")).toBeVisible();
  await restored.getByLabel("Path within this project").fill("../outside"); await restored.getByLabel("Path within this project").press("Enter");
  await expect(restored.getByRole("dialog")).toContainText("inside the project"); await page.keyboard.press("Escape"); await expect(restored.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("tab", { name: "Files", exact: true }).locator('[data-layout-path$="/button/close"]').click(); await expect(region(reopened.view)).toHaveCount(0);
  await invoke("views.close", { view: opened.view, mode: { kind: "retain_acknowledged", expected_version: opened.state_version } });
  await invoke("plugins.release", { instance: instance.identity }); await invoke("plugins.release", { instance: editor.identity });
  expect(errors).toEqual([]); completed = true;
});
