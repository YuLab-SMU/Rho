/** Disposable native R acceptance for the independently built Packages and Help packages. */
import { test, expect, type Page } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
let directory: string, project: string, database: string, url: URL, host: ReturnType<typeof spawn>;
let r: any, helpInstance: any, packagesInstance: any;
let completed = false;
async function port(method: string, params: any) {
  const reply = await fetch(new URL("/api/host", url), { method: "POST", headers: {
    Authorization: `Bearer ${url.hash.slice(7)}`, "Content-Type": "application/json", "X-Rho-Studio-Window": "packages-control",
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
async function openView(window: string, state = {}) { return invoke("windows.open_view", { view: { instance: packagesInstance, contribution: "packages", window, configuration: { source: r, help: helpInstance, help_group: null }, state }, expected_layout_version: 0, group: null }); }
test.beforeAll(async () => {
  test.setTimeout(120000);
  expect(process.env.RHO_R_PLUGIN_PACKAGE).toBeTruthy(); expect(process.env.RHO_HELP_PLUGIN_PACKAGE).toBeTruthy(); expect(process.env.RHO_PACKAGES_PLUGIN_PACKAGE).toBeTruthy();
  directory = await mkdtemp(join(tmpdir(), "rho-packages-native-")); project = join(directory, "project"); await mkdir(project); project = await realpath(project); database = join(directory, "state.sqlite");
  const snapshot = (path: string, target: string) => JSON.parse(execFileSync(resolve("../target/debug/rho"), ["--database", database, "plugins", "snapshot", path, "--target", target], { encoding: "utf8" })).result;
  const packages = snapshot(process.env.RHO_PACKAGES_PLUGIN_PACKAGE!, "ui-web");
  const native = snapshot(process.env.RHO_R_PLUGIN_PACKAGE!, "aarch64-apple-darwin"), ui = snapshot(process.env.RHO_HELP_PLUGIN_PACKAGE!, "ui-web");
  await startHost();
  r = (await invoke("plugins.activate", { revision: native.revision, artifact: native.artifacts[0], target: "aarch64-apple-darwin", alias: "r",
    configuration: { ark: await realpath(process.env.RHO_ARK!), r_home: await realpath(process.env.RHO_R_HOME!), execution_timeout_seconds: 30 } })).instance.identity;
  helpInstance = (await invoke("plugins.activate", { revision: ui.revision, artifact: ui.artifacts[0], target: "ui-web", alias: "help", configuration: {} })).instance.identity;
  packagesInstance = (await invoke("plugins.activate", { revision: packages.revision, artifact: packages.artifacts[0], target: "ui-web", alias: "packages", configuration: {} })).instance.identity;
});
test.afterAll(async () => {
  await stopHost();
  if (directory && completed) await rm(directory, { recursive: true, force: true });
  else if (directory) console.error(`Incomplete disposable Packages acceptance retained: ${directory}`);
});

test("ordinary Packages navigates to exact native Help, preserves read-only inspection and closes independently of R", async ({ page }, info) => {
  test.setTimeout(180000);
  const binding = async (id: string, version = 1) => query("plugins.resolve", { instance: r, capability: { id, version } });
  await invoke("r.create_session", { binding: await binding("r.create_session"), arguments: {} });
  const session = (await query("r.session", { binding: await binding("r.session"), arguments: {} })).session_id;
  const execute = await binding("r.execute", 2);
  const run = (code: string) => port("invoke", { capability: { id: "r.execute", version: 2 }, client_request_id: crypto.randomUUID(), preconditions: [],
    arguments: { binding: execute, arguments: { expected_session: session, run: { code, output_mode: "console", source: { view_id: "fixture", kind: "console", label: "Packages acceptance" } } } } });
  const setup = await run('invisible(loadNamespace("tools")); invisible(loadNamespace("utils")); .packages_before <- list(search = search(), namespaces = loadedNamespaces(), libs = .libPaths())');
  expect(setup.status, JSON.stringify(setup.error)).toBe("succeeded");
  let view = (await openView("packages-native")).view; await show(page, view);
  const frame = page.frameLocator('iframe[title="packages"]'), filter = frame.getByRole("textbox", { name: "Search Packages" });
  await filter.fill("stats");
  await frame.getByRole("button", { name: /^stats,/ }).click();
  await expect(frame.getByRole("button", { name: "Documentation", exact: true })).toBeEnabled();
  for (const width of [1440, 1920, 390]) {
    await page.setViewportSize({ width, height: 900 }); await expect.poll(() => filter.evaluate(() => innerWidth)).toBeGreaterThan(width - 20);
    expect(await filter.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await filter.evaluate(() => document.fonts.ready); await page.screenshot({ path: info.outputPath(`packages-native-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await frame.getByRole("button", { name: "Documentation", exact: true }).click();
  let saved: any, navigation: any;
  await expect.poll(async () => {
    saved = await query("views.inspect", { view: view.view }); const receipt = saved.state.actions?.receipt;
    if (!receipt) return "not observed";
    navigation = (await query("operation.get", { operation_id: receipt.id })).record; return navigation.status;
  }).toBe("succeeded");
  expect(navigation.operation.caller).toEqual({ kind: "plugin", id: view.view });
  const help = navigation.output.view, copy = help.configuration.copy;
  expect(help.instance).toEqual(helpInstance); expect(help.configuration.source).toEqual(r);
  expect(copy).toMatchObject({ nativeSession: session, package: "stats" });
  const observed = await query("r.packages", { binding: await binding("r.packages"), arguments: { expected_session: session, observation_id: copy.observation, package_name: "stats" } });
  expect(observed.status, JSON.stringify(observed)).toBe("ready");
  expect(observed.data.packages.some((entry: any) => entry.library_path === copy.libraryPath && entry.version === copy.version)).toBe(true);
  expect(navigation.output.layout.layout.selected).toBe(help.view);
  // The shared window observes the atomic placement and mounts Help itself.
  const helpFrame = page.frameLocator('iframe[title="help"]');
  await expect(filter).toBeHidden();
  await page.setViewportSize({ width: 390, height: 900 });
  await helpFrame.getByRole("textbox", { name: "Filter Help topics" }).fill("lm");
  await helpFrame.getByRole("button", { name: /^lm topic/ }).click();
  await expect(helpFrame.locator(".help-content")).toContainText("Fitting Linear Models");
  await expect(helpFrame.locator(".help-version")).toHaveText(copy.version);
  await page.screenshot({ path: info.outputPath("packages-help-native-390.png") });
  const executions = async () => (await query("operation.list_recent", { limit: 100 })).operations.filter((item: any) => item.capability.id === "r.execute");
  expect(await executions()).toHaveLength(1);
  await page.getByRole('tab', { name: 'Help', exact: true }).locator('[data-layout-path$="/button/close"]').click();
  await expect(page.locator('iframe[title="help"]')).toHaveCount(0);
  await expect(filter).toBeVisible();
  await frame.getByRole("button", { name: "Inspect Operation", exact: true }).click();
  await expect(frame.getByText("Open documentation: succeeded", { exact: false })).toBeVisible();
  const verified = await run('stopifnot(identical(.packages_before$search, search()), setequal(.packages_before$namespaces, loadedNamespaces()), identical(.packages_before$libs, .libPaths()))');
  expect(verified.status, JSON.stringify(verified.error)).toBe("succeeded"); expect(await executions()).toHaveLength(2);
  const working = run("Sys.sleep(5); packages_finished <- TRUE");
  await expect(frame.locator(".package-busy")).toContainText("R busy");
  await expect(frame.getByRole("button", { name: "Refresh Packages", exact: true })).toBeDisabled();
  await filter.fill("base"); await invoke("views.close", { view: view.view });
  saved = await query("views.inspect", { view: view.view }); expect(saved.closed).toBe(true); expect(saved.state.packages.packages.filter).toBe("base");
  expect((await query("r.inspection_state", { binding: await binding("r.inspection_state"), arguments: { expected_session: session } })).status).toBe("busy");
  expect((await working).status).toBe("succeeded");
  // Reopen choices in a fresh empty window, preserving the exact original R.
  view = (await openView("packages-reopened", saved.state)).view; await show(page, view);
  await expect(filter).toHaveValue("base"); await expect(frame.locator(".package-list")).toContainText("The R Base Package");
  expect((await query("r.session", { binding: await binding("r.session"), arguments: {} })).session_id).toBe(session); expect(await executions()).toHaveLength(3);
  await invoke("views.close", { view: view.view }); await invoke("plugins.release", { instance: packagesInstance });
  await invoke("plugins.release", { instance: helpInstance }); await invoke("plugins.release", { instance: r }); completed = true;
});
