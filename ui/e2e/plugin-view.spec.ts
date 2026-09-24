import { test, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildUiFixture, buildControlFixture } from "../../scripts/fixtures/plugin-ui.mjs";

let directory: string, project: string, url: URL, process_: ReturnType<typeof spawn>, view: any, instance: any;
let completed = false;
const windowId = "external.view-window";
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
  const plugin = buildUiFixture(directory), database = join(directory, "state.sqlite");
  const installed = JSON.parse(execFileSync(resolve("../target/debug/rho"), ["--database", database, "plugins", "snapshot", plugin], { encoding: "utf8" })).result;
  const native = JSON.parse(execFileSync(resolve("../target/debug/rho"), ["--database", database, "plugins", "snapshot", buildControlFixture(directory), "--target", "aarch64-apple-darwin"], { encoding: "utf8" })).result;
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
  view = await invoke("views.open", { instance: instance.identity, contribution: "view", window: windowId, configuration: { binding }, state: { text: "Initial Ω" } });
});
test.afterAll(async () => {
  if (process_?.exitCode === null) {
    process_.kill("SIGINT"); await new Promise<void>(done => process_.once("exit", () => done()));
  }
  if (directory && completed) await rm(directory, { recursive: true, force: true });
  else if (directory) console.error(`External UI fixture retained at ${directory}`);
});
test("external UI SDK runs in an opaque frame with persistent scoped state", async ({ page, request, context }) => {
  const address = new URL(url); address.searchParams.set("window", windowId); address.searchParams.set("plugin-view", view.view);
  const faults: string[] = []; page.on("pageerror", error => faults.push(error.message));
  await page.goto(address.href);
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("#connection")).toHaveText("Connected");
  await expect(frame.locator("#automatic-copy")).toContainText("explicit Copy action");
  await expect(frame.getByLabel("View note")).toHaveValue("Initial Ω");
  await frame.getByLabel("View note").fill("中文输入 · αβ Ω");
  await page.keyboard.press("End"); await page.keyboard.insertText(" ✓");
  await frame.getByRole("button", { name: "Save note" }).click();
  await expect(frame.locator("#result")).toHaveText("Saved");
  expect((await query("views.inspect", { view: view.view })).state.text).toBe("中文输入 · αβ Ω ✓");
  // Chromium's permission override denies permissions not listed, including
  // clipboard-write. Enable read only for assertions, then restore normal
  // gesture-based writes. Production receives no clipboard-read permission.
  const copiedText = async () => {
    await context.grantPermissions(["clipboard-read"], { origin: url.origin });
    try { return await page.evaluate(() => navigator.clipboard.readText()); }
    finally { await context.clearPermissions(); }
  };
  const beforeCopy = await query("operation.list_recent", { limit: 100 });
  await frame.getByRole("button", { name: "Copy note", exact: true }).click();
  await expect(frame.locator("#result")).toHaveText("Copied");
  expect(await copiedText()).toBe("中文输入 · αβ Ω ✓");
  await frame.getByRole("button", { name: "Copy after collection", exact: true }).click();
  await expect(frame.locator("#result")).toHaveText("Collecting");
  await expect(frame.locator("#result")).toHaveText("Copied after collection", { timeout: 12000 });
  expect(await copiedText()).toBe("中文输入 · αβ Ω ✓ · collected");
  await frame.getByRole("button", { name: "Copy failing collection", exact: true }).click();
  await expect(frame.locator("#result")).toHaveText("Original copy observation expired");
  expect(await copiedText()).toBe("中文输入 · αβ Ω ✓ · collected");
  expect(await query("operation.list_recent", { limit: 100 })).toEqual(beforeCopy);
  let releaseRead!: () => void, sawRead!: () => void, held = false;
  const readGate = new Promise<void>(resolve => releaseRead = resolve), observedRead = new Promise<void>(resolve => sawRead = resolve);
  await page.route("**/api/plugin-view", async route => {
    if (!held && route.request().postDataJSON()?.message?.body?.type === "query") {
      held = true;
      const response = await route.fetch(); sawRead();
      await readGate; await route.fulfill({ response });
    } else await route.continue();
  });
  await frame.getByRole("button", { name: "Read plugins", exact: true }).click();
  await observedRead;
  await frame.getByRole("button", { name: "Save note" }).click();
  try {
    await expect.poll(async () => (await query("views.inspect", { view: view.view })).state_version).toBe(2);
  } finally { releaseRead(); }
  await expect(frame.locator("#result")).toHaveText("Plugins: 2");
  await page.unroute("**/api/plugin-view");
  await frame.getByRole("button", { name: "Try undeclared read" }).click();
  await expect(frame.locator("#result")).toContainText("not granted");
  await frame.getByRole("button", { name: "Answer native input", exact: true }).click();
  await expect(frame.locator("#result")).toHaveText("Answer accepted");
  await frame.getByRole("button", { name: "Try undeclared control" }).click();
  await expect(frame.locator("#result")).toContainText("not granted");
  const isolation = await page.frames()[1].evaluate(async () => {
    let parentBlocked = false, storageBlocked = false, apiBlocked = false, clipboardBlocked = false;
    try { void parent.document.body; } catch { parentBlocked = true; }
    try { void sessionStorage.getItem("rho-token"); } catch { storageBlocked = true; }
    try { await fetch("/api/info"); } catch { apiBlocked = true; }
    try { await navigator.clipboard.writeText("Direct iframe write must fail"); } catch { clipboardBlocked = true; }
    return { parentBlocked, storageBlocked, apiBlocked, clipboardBlocked, token: new URL(location.href).hash.includes("token=") };
  });
  expect(isolation).toEqual({ parentBlocked: true, storageBlocked: true, apiBlocked: true, clipboardBlocked: true, token: false });
  expect(await page.locator("iframe").getAttribute("sandbox")).toBe("allow-scripts");
  const assets = await request.get(new URL(await page.locator("iframe").getAttribute("src") as string, url.origin).href);
  expect(assets.headers()["content-security-policy"]).toContain("sandbox allow-scripts");
  const blocked = await request.post(new URL("/api/info", url).href, { headers: { Origin: "null", Authorization: `Bearer ${url.hash.slice(7)}` } });
  expect(blocked.status()).toBe(403);
  await page.reload();
  await expect(frame.locator("#connection")).toHaveText("Connected");
  await expect(frame.getByLabel("View note")).toHaveValue("中文输入 · αβ Ω ✓");
  await frame.getByRole("button", { name: "Read plugins", exact: true }).click();
  await expect(frame.locator("#result")).toHaveText("Plugins: 2");
  await page.screenshot({ path: "../target/plugin-refactor/external-ui-wide.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(frame.getByRole("button", { name: "Save note" })).toBeVisible();
  await page.screenshot({ path: "../target/plugin-refactor/external-ui-narrow.png" });
  await frame.getByRole("button", { name: "Copy after collection", exact: true }).click();
  await expect(frame.locator("#result")).toHaveText("Collecting");
  await invoke("views.close", { view: view.view });
  await expect(frame.locator("#result")).toContainText("view connection", { timeout: 12000 });
  expect(await copiedText()).toBe("中文输入 · αβ Ω ✓ · collected");
  const still = await query("plugins.instance", { instance: instance.identity }); expect(still.instance.state).toBe("active");
  await frame.getByRole("button", { name: "Read plugins", exact: true }).click();
  await expect(frame.locator("#result")).toContainText("view connection");
  await invoke("plugins.release", { instance: instance.identity });
  expect(faults).toEqual([]);
  completed = true;
});
