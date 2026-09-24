/** Disposable native R acceptance for the independently built Help package. */
import { test, expect, type Page } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
let directory: string, project: string, database: string, url: URL, host: ReturnType<typeof spawn>;
let r: any, helpInstance: any, copy: any;
let completed = false;
async function port(method: string, params: any) {
  const reply = await fetch(new URL("/api/host", url), { method: "POST", headers: {
    Authorization: `Bearer ${url.hash.slice(7)}`, "Content-Type": "application/json", "X-Rho-Studio-Window": "help-control",
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
  const address = new URL(url); address.searchParams.set("window", view.window); address.searchParams.set("plugin-view", view.view); await page.goto(address.href);
}
async function openView(window: string, state = {}) { return invoke("views.open", { instance: helpInstance, contribution: "help", window, configuration: { source: r, copy, topic: "lm" }, state }); }
test.beforeAll(async () => {
  test.setTimeout(120000);
  expect(process.env.RHO_R_PLUGIN_PACKAGE).toBeTruthy(); expect(process.env.RHO_HELP_PLUGIN_PACKAGE).toBeTruthy();
  directory = await mkdtemp(join(tmpdir(), "rho-help-native-")); project = join(directory, "project"); await mkdir(project); project = await realpath(project); database = join(directory, "state.sqlite");
  const snapshot = (path: string, target: string) => JSON.parse(execFileSync(resolve("../target/debug/rho"), ["--database", database, "plugins", "snapshot", path, "--target", target], { encoding: "utf8" })).result;
  const native = snapshot(process.env.RHO_R_PLUGIN_PACKAGE!, "aarch64-apple-darwin"), ui = snapshot(process.env.RHO_HELP_PLUGIN_PACKAGE!, "ui-web");
  await startHost();
  r = (await invoke("plugins.activate", { revision: native.revision, artifact: native.artifacts[0], target: "aarch64-apple-darwin", alias: "r",
    configuration: { ark: await realpath(process.env.RHO_ARK!), r_home: await realpath(process.env.RHO_R_HOME!), execution_timeout_seconds: 30 } })).instance.identity;
  helpInstance = (await invoke("plugins.activate", { revision: ui.revision, artifact: ui.artifacts[0], target: "ui-web", alias: "help", configuration: {} })).instance.identity;
});
test.afterAll(async () => {
  await stopHost();
  if (directory && completed) await rm(directory, { recursive: true, force: true });
  else if (directory) console.error(`Incomplete disposable Help acceptance retained: ${directory}`);
});

test("ordinary Help reads one observed native copy, closes without ending R and reopens saved choices", async ({ page }, info) => {
  test.setTimeout(180000);
  const binding = async (id: string, version = 1) => query("plugins.resolve", { instance: r, capability: { id, version } });
  await invoke("r.create_session", { binding: await binding("r.create_session"), arguments: {} });
  const session = (await query("r.session", { binding: await binding("r.session"), arguments: {} })).session_id;
  const execute = await binding("r.execute", 2);
  const run = (code: string) => port("invoke", { capability: { id: "r.execute", version: 2 }, client_request_id: crypto.randomUUID(), preconditions: [],
    arguments: { binding: execute, arguments: { expected_session: session, run: { code, output_mode: "console", source: { view_id: "fixture", kind: "console", label: "Help acceptance" } } } } });
  // Explicit fixture setup supplies the existing static rendering providers.
  // Queries themselves must never load namespaces or create an execution.
  const setup = await run('invisible(loadNamespace("tools")); invisible(loadNamespace("utils")); .help_before <- list(search = search(), namespaces = loadedNamespaces(), libs = .libPaths())');
  expect(setup.status, JSON.stringify(setup.error)).toBe("succeeded");
  const inventory = await query("r.packages", { binding: await binding("r.packages"), arguments: { expected_session: session, filter: "stats", grouped: true } });
  expect(inventory.status, JSON.stringify(inventory)).toBe("ready");
  const copies = await query("r.packages", { binding: await binding("r.packages"), arguments: { expected_session: session, observation_id: inventory.data.observation_id, package_name: "stats" } });
  const installed = copies.data.packages.find((entry: any) => entry.name === "stats"); expect(installed).toBeTruthy();
  copy = { nativeSession: session, observation: inventory.data.observation_id, package: "stats", libraryPath: installed.library_path, version: installed.version };
  let view = await openView("help-native"); await show(page, view);
  const frame = page.frameLocator("iframe");
  await expect(frame.locator(".help-content")).toContainText("Fitting Linear Models");
  await expect(frame.locator(".help-version")).toHaveText(installed.version);
  const executions = async () => (await query("operation.list_recent", { limit: 100 })).operations.filter((item: any) => item.capability.id === "r.execute");
  expect(await executions()).toHaveLength(1);
  for (const width of [1440, 1920, 390]) {
    await page.setViewportSize({ width, height: 900 }); await expect.poll(() => frame.locator(".help-panel").evaluate(() => innerWidth)).toBe(width);
    expect(await frame.locator(".help-panel").evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await frame.locator(".help-panel").evaluate(() => document.fonts.ready); await page.screenshot({ path: info.outputPath(`help-native-${width}.png`) });
  }
  await frame.getByRole("button", { name: "Topics", exact: true }).click();
  const filter = frame.getByRole("textbox", { name: "Filter Help topics" }); await filter.fill("lm");
  await expect(frame.locator(".help-topic-list")).toContainText("Fitting Linear Models");
  await page.screenshot({ path: info.outputPath("help-native-topics-390.png") });
  await frame.getByRole("button", { name: "Topics", exact: true }).click();
  // Native content and index reads preserve R search paths, libraries and loaded
  // namespaces. This explicit verification is a separate scientific Operation.
  const verified = await run('stopifnot(identical(.help_before$search, search()), setequal(.help_before$namespaces, loadedNamespaces()), identical(.help_before$libs, .libPaths()))');
  expect(verified.status, JSON.stringify(verified.error)).toBe("succeeded"); expect(await executions()).toHaveLength(2);
  const working = run("Sys.sleep(5); help_finished <- TRUE");
  await expect.poll(async () => (await query("r.inspection_state", { binding: await binding("r.inspection_state"), arguments: { expected_session: session } })).status).toBe("busy");
  await frame.getByRole("button", { name: "Raw", exact: true }).click();
  await invoke("views.close", { view: view.view });
  const saved = await query("views.inspect", { view: view.view }); expect(saved.closed).toBe(true); expect(saved.state.choices).toMatchObject({ topic: "lm", filter: "lm", raw: true });
  expect((await query("r.inspection_state", { binding: await binding("r.inspection_state"), arguments: { expected_session: session } })).status).toBe("busy");
  expect((await working).status).toBe("succeeded");
  view = await openView("help-native", saved.state); await show(page, view);
  await expect(frame.locator(".help-raw")).toContainText("Fitting Linear Models");
  expect((await query("r.session", { binding: await binding("r.session"), arguments: {} })).session_id).toBe(session);
  expect(await executions()).toHaveLength(3);
  await invoke("views.close", { view: view.view });
  await invoke("plugins.release", { instance: helpInstance }); await invoke("plugins.release", { instance: r }); completed = true;
});
