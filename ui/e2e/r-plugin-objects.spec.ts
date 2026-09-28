/** Disposable native R acceptance for the independently built Objects package. */
import { test, expect, type Page } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
let directory: string, project: string, database: string, url: URL, host: ReturnType<typeof spawn>;
let r: any, objectsInstance: any;
let completed = false;
async function port(method: string, params: any) {
  const reply = await fetch(new URL("/api/host", url), { method: "POST", headers: {
    Authorization: `Bearer ${url.hash.slice(7)}`, "Content-Type": "application/json", "X-Rho-Studio-Window": "objects-control",
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
async function openView(window: string, state = {}) {
  const layout = await query("windows.layout", { window });
  return (await invoke("windows.open_view", { expected_layout_version: layout.version,
    group: layout.layout.kind === "tabs" ? layout.layout.id : null,
    view: { instance: objectsInstance, contribution: "objects", window, configuration: { source: r, object_group: null }, state } })).view;
}
test.beforeAll(async () => {
  test.setTimeout(120000);
  expect(process.env.RHO_R_PLUGIN_PACKAGE).toBeTruthy(); expect(process.env.RHO_OBJECTS_PLUGIN_PACKAGE).toBeTruthy();
  directory = await mkdtemp(join(tmpdir(), "rho-objects-native-")); project = join(directory, "project"); await mkdir(project); project = await realpath(project); database = join(directory, "state.sqlite");
  const snapshot = (path: string, target: string) => JSON.parse(execFileSync(resolve("../target/debug/rho"), ["--database", database, "plugins", "snapshot", path, "--target", target], { encoding: "utf8" })).result;
  const native = snapshot(process.env.RHO_R_PLUGIN_PACKAGE!, "aarch64-apple-darwin"), ui = snapshot(process.env.RHO_OBJECTS_PLUGIN_PACKAGE!, "ui-web");
  await startHost();
  r = (await invoke("plugins.activate", { revision: native.revision, artifact: native.artifacts[0], target: "aarch64-apple-darwin", alias: "r",
    configuration: { ark: await realpath(process.env.RHO_ARK!), r_home: await realpath(process.env.RHO_R_HOME!), execution_timeout_seconds: 30 } })).instance.identity;
  objectsInstance = (await invoke("plugins.activate", { revision: ui.revision, artifact: ui.artifacts[0], target: "ui-web", alias: "objects", configuration: {} })).instance.identity;
});
test.afterAll(async () => {
  await stopHost();
  if (directory && completed) await rm(directory, { recursive: true, force: true });
  else if (directory) console.error(`Incomplete disposable Objects acceptance retained: ${directory}`);
});

test("ordinary Objects reads exact native objects and captures navigation and explicit plotting", async ({ page }, info) => {
  test.setTimeout(180000);
  const view = await openView("objects-native");
  await show(page, view);
  const frame = page.locator("[data-plugin-frame]").first().frameLocator("iframe"), filter = frame.getByRole("textbox", { name: "Filter Objects" });
  await expect(filter).toBeVisible();
  const binding = async (id: string, version = 1) => query("plugins.resolve", { instance: r, capability: { id, version } });
  const readiness = await binding("r.inspection_state");
  expect(await query("r.inspection_state", { binding: readiness, arguments: { expected_session: null } })).toMatchObject({ session_id: null, status: "unavailable" });
  await invoke("r.create_session", { binding: await binding("r.create_session"), arguments: {} });
  const session = (await query("r.session", { binding: await binding("r.session"), arguments: {} })).session_id;
  const execute = await binding("r.execute", 2);
  const fixture = await port("invoke", { capability: { id: "r.execute", version: 2 }, client_request_id: crypto.randomUUID(), preconditions: [],
    arguments: { binding: execute, arguments: { expected_session: session, run: {
      code: 'answer <- 42L; label <- "中文 αβ"; palette <- c("#2863d6", "#25775b", "#b33f49"); data <- head(datasets::iris); nested <- list(child = data); plot <- ggplot2::ggplot(data, ggplot2::aes(Sepal.Length, Sepal.Width)) + ggplot2::geom_point()',
      output_mode: "console", source: { view_id: "fixture", kind: "console", label: "Objects acceptance" },
    } } } });
  expect(fixture.status, JSON.stringify(fixture.error)).toBe("succeeded");
  await expect(frame.locator(".directory-content").getByText("42", { exact: true })).toBeVisible();
  await expect(frame.locator(".directory-content").getByText('"中文 αβ"', { exact: true })).toBeVisible();
  await expect(frame.locator('[aria-label="Color #2863d6"]:visible')).toBeVisible();
  const executions = async () => (await query("operation.list_recent", { limit: 100 })).operations.filter((item: any) => item.capability.id === "r.execute");
  expect(await executions()).toHaveLength(1);
  for (const width of [1440, 1920, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => filter.evaluate(() => innerWidth)).toBeGreaterThan(width - 20);
    await expect(filter).toBeVisible();
    await filter.click(); await expect(filter).toBeFocused();
    expect(await filter.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await filter.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: info.outputPath(`objects-native-directory-${width}.png`) });
  }
  const lifetime = await filter.evaluate(() => { (window as any).objectsLifetime = crypto.randomUUID(); return (window as any).objectsLifetime; });
  await frame.getByRole("button", { name: "Open data in New Tab", exact: true }).click();
  let detail: any;
  await expect.poll(async () => {
    const layout = await query("windows.layout", { window: view.window });
    const group = layout.layout;
    if (!group?.selected) return false;
    detail = await query("views.inspect", { view: group.selected }); return detail.contribution === "object";
  }).toBe(true);
  expect(detail.configuration).toEqual({ source: r, object_group: null, object: { name: "data", path: [] } });
  expect(detail.state.nativeSession).toBe(session); expect(detail.instance).toEqual(objectsInstance);
  expect(await executions()).toHaveLength(1);
  // The composed window selects the contributed inspector automatically while
  // retaining the exact directory document and its state.
  const detailFrame = page.locator(`[data-plugin-frame="${detail.view}"]`).frameLocator("iframe");
  await expect(filter).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(detailFrame.getByRole("grid")).toBeVisible();
  await expect(detailFrame.getByRole("columnheader", { name: /Sepal.Length/ })).toBeVisible();
  await expect(detailFrame.getByRole("grid")).toContainText("setosa");
  for (const width of [1440, 1920, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => detailFrame.locator(".object-viewer").evaluate(() => innerWidth)).toBeGreaterThan(width - 20);
    await expect(detailFrame.getByRole("grid")).toBeVisible();
    expect(await detailFrame.locator(".object-viewer").evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: info.outputPath(`objects-native-table-${width}.png`) });
  }
  // A real close gesture flushes the inspector and restores the same directory.
  await page.getByRole("tab", { name: "Object", exact: true }).locator('[data-layout-path$="/button/close"]').click();
  await expect(page.locator(`[data-plugin-frame="${detail.view}"]`)).toHaveCount(0);
  await expect(filter).toBeVisible();
  expect(await filter.evaluate(() => (window as any).objectsLifetime)).toBe(lifetime);
  const plot = frame.locator(".object-entry").filter({ has: frame.locator('.object-name code', { hasText: /^plot$/ }) });
  await plot.locator(".object-name").click();
  await expect(plot.getByRole("button", { name: "Render plot", exact: true })).toBeVisible();
  await plot.getByRole("button", { name: "Render plot", exact: true }).click();
  let saved: any, operation: any;
  await expect.poll(async () => {
    saved = await query("views.inspect", { view: view.view });
    const receipt = saved.state.actions?.receipt;
    if (receipt?.capability !== "r.execute") return "not observed";
    operation = (await query("operation.get", { operation_id: receipt.id })).record;
    return operation.status;
  }).toBe("succeeded");
  expect(operation.operation.caller).toEqual({ kind: "plugin", id: view.view });
  expect(operation.operation.normalized_arguments.binding.provider).toEqual(r);
  expect(operation.operation.normalized_arguments.arguments).toMatchObject({ expected_session: session,
    run: { code: 'print(get("plot", envir = .GlobalEnv, inherits = FALSE))', source: { view_id: view.view, label: "Objects" } } });
  expect(operation.output.outputs.some((item: any) => item.reference.media_type === "image/png")).toBe(true);
  expect(await executions()).toHaveLength(2);
  // Verify actual pointer routing in the composed window after responsive
  // inspector use, with no keyboard substitute for this action.
  await frame.getByRole("button", { name: "Inspect Operation", exact: true }).click();
  await expect(frame.getByText("Plot execution: succeeded", { exact: false })).toBeVisible();
  await filter.fill("palette");
  await invoke("views.close", { view: view.view });
  saved = await query("views.inspect", { view: view.view });
  expect(saved.state.objects.objectViews["directory:filter"]).toBe("palette");
  expect((await query("r.session", { binding: await binding("r.session"), arguments: {} })).session_id).toBe(session);
  const reopened = await openView("objects-native", saved.state); await show(page, reopened);
  await expect(filter).toHaveValue("palette"); await expect(frame.locator('[aria-label="Color #2863d6"]:visible')).toBeVisible();
  await frame.getByRole("button", { name: "Inspect Operation", exact: true }).click();
  await expect(frame.getByText("Plot execution: succeeded", { exact: false })).toBeVisible();
  expect(await executions()).toHaveLength(2);
  // Lose one actual native result, save its original identity separately, then
  // inspect it from a replacement view through the bounded journal page.
  await filter.fill("");
  let lostReply = false;
  await page.route("**/api/plugin-view", async route => {
    const body = route.request().postDataJSON()?.message?.body;
    if (!lostReply && body?.type === "invoke" && body.capability?.id === "r.execute") {
      lostReply = true;
      await route.fetch(); await route.abort(); return;
    }
    await route.continue();
  });
  await plot.getByRole("button", { name: "Render plot", exact: true }).click();
  await expect.poll(() => lostReply).toBe(true);
  await page.unrouteAll({ behavior: "wait" });
  // A lost HTTP reply disconnects the containing channel. Reconnect its saved
  // document explicitly before using the plugin's retained-request controls.
  await expect(page.getByRole("button", { name: "Reconnect this view", exact: true })).toBeVisible();
  const disconnected = await query("views.inspect", { view: reopened.view });
  expect(disconnected.state.actions.pending).toMatchObject({ view: reopened.view, capability: "r.execute" });
  expect(await executions()).toHaveLength(3);
  await page.getByRole("button", { name: "Reconnect this view", exact: true }).click();
  await expect(frame.getByText("Action unconfirmed", { exact: false })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Set Aside", exact: true })).toBeEnabled();
  await frame.getByRole("button", { name: "Set Aside", exact: true }).click();
  await expect(frame.getByText("Requests set aside (1)", { exact: true })).toBeVisible();
  saved = await query("views.inspect", { view: reopened.view });
  const retained = saved.state.actions.retained[0];
  expect(retained.view).toBe(reopened.view);
  expect(saved.state.actions.pending).toBeNull();
  expect(await executions()).toHaveLength(3);
  await invoke("views.close", { view: reopened.view });
  saved = await query("views.inspect", { view: reopened.view });
  const recovery = await openView("objects-native", saved.state); await show(page, recovery);
  await expect(frame.getByText("Requests set aside (1)", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("objects-native-retained.png") });
  await frame.getByRole("button", { name: "Inspect Saved Request", exact: true }).click();
  await expect(frame.getByText("Requests set aside (1)", { exact: true })).toBeHidden();
  await expect(frame.getByText("Plot execution: succeeded", { exact: false })).toBeVisible();
  const recovered = await query("views.inspect", { view: recovery.view });
  expect(recovered.state.actions.retained).toEqual([]);
  expect(recovered.state.actions.receipt).toMatchObject({ view: retained.view, request: retained.request, capability: "r.execute" });
  const recoveredRecord = (await query("operation.get", { operation_id: recovered.state.actions.receipt.id })).record;
  expect(recoveredRecord.operation.normalized_arguments).toEqual(retained.arguments);
  expect(recoveredRecord.output.outputs.some((item: any) => item.reference.media_type === "image/png")).toBe(true);
  expect(await executions()).toHaveLength(3);
  await page.screenshot({ path: info.outputPath("objects-native-recovered.png") });
  await invoke("views.close", { view: recovery.view });
  await invoke("plugins.release", { instance: objectsInstance }); await invoke("plugins.release", { instance: r });
  completed = true;
});
