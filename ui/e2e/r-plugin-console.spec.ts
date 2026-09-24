import { test, expect, type Page } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
let directory: string, project: string, database: string, url: URL, host: ReturnType<typeof spawn>;
let r: any, consoleInstance: any, rRevision: string;
let completed = false;
async function port(method: string, params: any) {
  const reply = await fetch(new URL("/api/host", url), { method: "POST", headers: {
    Authorization: `Bearer ${url.hash.slice(7)}`, "Content-Type": "application/json", "X-Rho-Studio-Window": "console-control",
  }, body: JSON.stringify({ project_root: project, frame: { id: crypto.randomUUID(), request: { method, params } } }) }).then(response => response.json());
  if (!reply.ok) throw new Error(reply.error); return reply.result;
}
async function invoke(id: string, arguments_: any) {
  const record = await port("invoke", { capability: { id, version: 1 }, client_request_id: crypto.randomUUID(), arguments: arguments_, preconditions: [] });
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
async function openView(window: string, state = {}) { return invoke("views.open", { instance: consoleInstance, contribution: "console", window, configuration: { source: r }, state }); }
async function completedCode(code: string) {
  await expect.poll(async () => {
    const recent = await query("operation.list_recent", { limit: 25 });
    for (const item of recent.operations) {
      if (item.capability.id !== "r.execute") continue;
      const record = (await query("operation.get", { operation_id: item.operation_id })).record;
      if (record.operation.normalized_arguments.arguments?.run?.code === code) return record.status;
    }
    return "not observed";
  }).toBe("succeeded");
}
test.beforeAll(async () => {
  test.setTimeout(120000);
  expect(process.env.RHO_R_PLUGIN_PACKAGE).toBeTruthy(); expect(process.env.RHO_CONSOLE_PLUGIN_PACKAGE).toBeTruthy();
  directory = await mkdtemp(join(tmpdir(), "rho-console-native-")); project = join(directory, "project"); await mkdir(project); project = await realpath(project); database = join(directory, "state.sqlite");
  const snapshot = (path: string, target: string) => JSON.parse(execFileSync(resolve("../target/debug/rho"), ["--database", database, "plugins", "snapshot", path, "--target", target], { encoding: "utf8" })).result;
  const native = snapshot(process.env.RHO_R_PLUGIN_PACKAGE!, "aarch64-apple-darwin"), ui = snapshot(process.env.RHO_CONSOLE_PLUGIN_PACKAGE!, "ui-web"); rRevision = native.revision;
  await startHost();
  r = (await invoke("plugins.activate", { revision: native.revision, artifact: native.artifacts[0], target: "aarch64-apple-darwin", alias: "r",
    configuration: { ark: await realpath(process.env.RHO_ARK!), r_home: await realpath(process.env.RHO_R_HOME!), execution_timeout_seconds: 30 } })).instance.identity;
  consoleInstance = (await invoke("plugins.activate", { revision: ui.revision, artifact: ui.artifacts[0], target: "ui-web", alias: "console", configuration: {} })).instance.identity;
});
test.afterAll(async () => {
  await stopHost();
  if (directory && completed) await rm(directory, { recursive: true, force: true });
  else if (directory) console.error(`Incomplete disposable Console acceptance retained: ${directory}`);
});

test("ordinary Console runs and cancels original R work while preserving drafts and retained transcript", async ({ page }, info) => {
  test.setTimeout(180000);
  let view = await openView("console-native"); await show(page, view);
  const outer = page.frameLocator("iframe"), input = outer.getByRole("textbox", { name: "Console Input", exact: true }), transcript = outer.getByRole("textbox", { name: "Console Transcript", exact: true });
  await expect(outer.locator("#status")).toContainText("R has not started");
  const inspectionBinding = await query("plugins.resolve", { instance: r, capability: { id: "r.inspection_state", version: 1 } });
  const inspectionState = (expected_session: string | null = null) => query("r.inspection_state", { binding: inspectionBinding, arguments: { expected_session } });
  expect(await inspectionState()).toMatchObject({ session_id: null, status: "unavailable", cache_key: null });
  await outer.getByRole("button", { name: "Start R", exact: true }).click();
  await expect(outer.locator("#status")).toContainText("Ready", { timeout: 30000 });
  await expect.poll(async () => (await inspectionState()).status).toBe("ready");
  const initialInspection = await inspectionState();
  expect(initialInspection.cache_key).toEqual(expect.any(String));
  await expect(inspectionState("foreign-session")).rejects.toThrow();
  await expect(query("r.inspection_state", { binding: { ...inspectionBinding, target: "foreign-session" },
    arguments: { expected_session: initialInspection.session_id } })).rejects.toThrow();
  await input.fill("cat('console-live 中文\\n'); answer <- readline('Your answer: '); 11; 22");
  await input.press("Meta+Enter"); await expect(input).toHaveText("");
  await expect(transcript).toContainText("console-live 中文");
  await expect(outer.getByRole("button", { name: "Answer Here" })).toBeVisible();
  const busyInspection = await inspectionState(initialInspection.session_id);
  expect(busyInspection.status).toBe("busy");
  expect(busyInspection.cache_key).not.toBe(initialInspection.cache_key);
  await input.fill("next draft 中文 αβ");
  await outer.getByRole("button", { name: "Answer Here" }).click();
  await outer.getByRole("textbox", { name: "R Input Answer" }).fill("αβ");
  await outer.getByRole("button", { name: "Send Answer" }).click();
  await expect(transcript).toContainText("[1] 22");
  await completedCode("cat('console-live 中文\\n'); answer <- readline('Your answer: '); 11; 22");
  expect((await transcript.textContent())!.match(/\[1\] 11/g)).toHaveLength(1);
  await expect(input).toContainText("next draft 中文 αβ");
  await outer.getByRole("button", { name: "Pause Queue" }).click();
  await expect(outer.getByRole("button", { name: "Resume Queue" })).toBeVisible();
  await input.fill("cat('queue-one\\n')"); await outer.getByRole("button", { name: "Run", exact: true }).click(); await expect(input).toHaveText("");
  await input.fill("should_not_exist <- 99"); await outer.getByRole("button", { name: "Run", exact: true }).click(); await expect(input).toHaveText("");
  await expect(outer.locator("#status")).toContainText("2 queued");
  await outer.getByRole("button", { name: "Queue", exact: true }).click();
  await outer.locator("#details-content section").filter({ hasText: "should_not_exist" }).getByRole("button", { name: "Cancel Pending", exact: true }).click();
  await expect(transcript).toContainText("Cancelled");
  await expect(outer.locator("#status")).toContainText("1 queued");
  await outer.getByRole("button", { name: "Resume Queue" }).click();
  await expect(outer.locator("#status")).toContainText("0 queued");
  await input.fill("stopifnot(!exists('should_not_exist')); cat('queue-verified\\n')"); await input.press("Meta+Enter");
  await expect(transcript).toContainText("queue-verified");
  await completedCode("stopifnot(!exists('should_not_exist')); cat('queue-verified\\n')");
  await expect(outer.locator("#status")).toContainText("Ready");
  // These contributed queries were added to the independent R package after
  // this Host binary was built. The generic Host must discover and serve them.
  const sessionRead = await query("plugins.resolve", { instance: r, capability: { id: "r.session", version: 1 } });
  const session = (await query("r.session", { binding: sessionRead, arguments: {} })).session_id;
  const observe = await query("plugins.resolve", { instance: r, capability: { id: "r.observe_object", version: 1 } });
  let object: any;
  await expect.poll(async () => {
    object = await query("r.observe_object", { binding: observe, arguments: { expected_session: session, name: "answer" } });
    return object.status;
  }).toBe("ready");
  const readObject = await query("plugins.resolve", { instance: r, capability: { id: "r.read_object", version: 1 } });
  const value = await query("r.read_object", { binding: readObject, arguments: { expected_session: session, object_ref: object.data.object_ref, kind: "values" } });
  expect(value.status).toBe("ready");
  expect(value.data.values[0].text).toBe("αβ");
  const readyInspection = await inspectionState(session);
  expect(readyInspection.status).toBe("ready");
  expect(readyInspection.cache_key).not.toBe(busyInspection.cache_key);
  const fastBinding = await query("plugins.resolve", { instance: r, capability: { id: "r.execute", version: 1 } });
  // The entire native run occurs between readiness reads. A UI must still learn
  // that its retained object pages no longer describe the current workspace.
  await invoke("r.execute", { binding: fastBinding, arguments: { expected_session: session, code: "inspection_fast <- 42L" } });
  await expect.poll(async () => (await inspectionState(session)).status).toBe("ready");
  const afterFast = await inspectionState(session);
  expect(afterFast.cache_key).not.toBe(readyInspection.cache_key);
  await query("r.observe_object", { binding: observe, arguments: { expected_session: session, name: "inspection_fast" } });
  expect((await inspectionState(session)).cache_key).toBe(afterFast.cache_key);
  const failed = await port("invoke", { capability: { id: "r.execute", version: 1 }, client_request_id: crypto.randomUUID(),
    arguments: { binding: fastBinding, arguments: { expected_session: session, code: "inspection_failed <- 43L; stop('inspection failure fixture')" } }, preconditions: [] });
  expect(failed.status).toBe("failed");
  await expect.poll(async () => (await inspectionState(session)).status).toBe("ready");
  expect((await inspectionState(session)).cache_key).not.toBe(afterFast.cache_key);
  // A failed script can have changed R memory before its error. The original
  // Operation stays failed while the read-only observation exposes that change.
  const changedBeforeFailure = await query("r.observe_object", { binding: observe, arguments: { expected_session: session, name: "inspection_failed" } });
  expect(changedBeforeFailure.status).toBe("ready");
  const failedValue = await query("r.read_object", { binding: readObject, arguments: { expected_session: session, object_ref: changedBeforeFailure.data.object_ref, kind: "values" } });
  expect(failedValue.data.values[0].number).toBe(43);
  await expect(outer.getByRole("button", { name: "Resume Queue" })).toBeVisible();
  await outer.getByRole("button", { name: "Resume Queue" }).click();
  await expect(outer.getByRole("button", { name: "Pause Queue" })).toBeVisible();
  // These runs originated outside the Console view and finished between its
  // live polls. Wait for history discovery before checking the resulting UI.
  await expect(transcript).toContainText("inspection_failed <- 43L");
  await expect(transcript).toContainText("inspection failure fixture");
  for (const width of [1440, 1920, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.frames()[1].evaluate(() => innerWidth)).toBe(width);
    await input.fill("saved draft 中文");
    await page.frames()[1].evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await page.screenshot({ path: info.outputPath(`console-real-r-${width}.png`) });
    expect(await page.frames()[1].evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  }
  await expect.poll(async () => (await query("views.inspect", { view: view.view })).state.input).toBe("saved draft 中文");
  await page.reload(); await expect(input).toContainText("saved draft 中文");
  await expect(outer.locator("#status")).toContainText("Ready");
  const reloaded = await query("views.inspect", { view: view.view });
  // A document lost to reload cannot attest to its old buffer. Explicitly keep
  // its acknowledged version, then use one fresh document for flush acceptance.
  await invoke("views.close", { view: view.view, mode: { kind: "retain_acknowledged", expected_version: reloaded.state_version } });
  view = await openView("console-flush", reloaded.state); await show(page, view);
  await expect(outer.locator("#status")).toContainText("Ready");
  const read = await query("plugins.resolve", { instance: r, capability: { id: "r.session", version: 1 } });
  await input.fill("Sys.sleep(5); cat('finished-after-close\\n')"); await input.press("Meta+Enter"); await expect(input).toHaveText("");
  await expect.poll(async () => (await query("r.session", { binding: read, arguments: {} })).state).toBe("busy");
  await input.fill("reopened draft 中文");
  await invoke("views.close", { view: view.view });
  const saved = await query("views.inspect", { view: view.view });
  expect(saved.state.input).toBe("reopened draft 中文");
  expect((await query("r.session", { binding: read, arguments: {} })).state).toBe("busy");
  await expect.poll(async () => (await query("r.session", { binding: read, arguments: {} })).state).toBe("idle");
  await completedCode("Sys.sleep(5); cat('finished-after-close\\n')");
  view = await openView("console-reopened", saved.state); await show(page, view);
  await expect(input).toContainText("reopened draft 中文"); await expect(transcript).toContainText("finished-after-close");
  await expect.poll(async () => (await query("plugins.instance", { instance: r })).retained_calls).toBe(0);
  await invoke("plugins.release", { instance: r }); await invoke("plugins.remove", { revision: rRevision });
  await page.reload(); await expect(transcript).toContainText("[1] 22"); await expect(transcript).toContainText("finished-after-close");
  await expect(outer.locator("#observation-error")).toContainText("Live observation unavailable");
  await expect(outer.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
  const offline = await query("views.inspect", { view: view.view });
  await invoke("views.close", { view: view.view, mode: { kind: "retain_acknowledged", expected_version: offline.state_version } });
  await invoke("plugins.release", { instance: consoleInstance });
  completed = true;
});
