import { test, expect, type Page } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, realpath, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let directory: string, project: string, url: string, ark: string, rHome: string, host: ReturnType<typeof spawn>;
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "rho-runtime-ui-")); project = join(directory, "study"); await mkdir(project); project = await realpath(project);
  ark = join(directory, "ark"); await copyFile(resolve("../target/debug/ark"), ark);
  rHome = execFileSync("R", ["RHOME"], { encoding: "utf8" }).trim();
  execFileSync(process.execPath, ["scripts/bootstrap-recovery-component.mjs", "--ark", ark, "--r", join(rHome,"bin/R")], { cwd: resolve(".."), encoding: "utf8" });
  await startHost();
});
async function startHost() {
  host = spawn(resolve("../target/debug/rho"), ["--database", join(directory, "records.sqlite"), "--ark", ark, "--r-home", rHome, "--project", project, "workbench"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_DATA_HOME: join(directory, "app-data") } });
  url = await new Promise((accept, reject) => {
    let stdout = "", stderr = ""; const timer = setTimeout(() => reject(new Error(`Host timeout: ${stderr}`)), 40000);
    host.stdout!.on("data", data => { stdout += data; const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-z0-9]+/); if (match) { clearTimeout(timer); accept(match[0]); } });
    host.stderr!.on("data", data => { stderr += data; }); host.once("exit", code => { clearTimeout(timer); reject(new Error(`Host exited ${code}: ${stderr}`)); });
  });
}
test.afterAll(async () => { if (host?.exitCode === null) { host.kill("SIGINT"); await new Promise<void>(accept => host.once("exit", () => accept())); } if (directory) await rm(directory, { recursive: true, force: true }); });
async function native(method: string, id: string, args: unknown) {
  const parsed = new URL(url), token = new URLSearchParams(parsed.hash.slice(1)).get("token");
  const params = method === "invoke" ? { client_request_id: crypto.randomUUID(), capability: { id, version: 1 }, arguments: args, preconditions: [] } : { capability: { id, version: 1 }, arguments: args };
  const result = await fetch(`${parsed.origin}/api/host`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ project_root: project, frame: { id: crypto.randomUUID(), request: { method, params } } }) });
  const reply = await result.json(); expect(reply.ok, reply.error).toBe(true); return reply.result;
}
const query = async (id: string, args: unknown) => (await native("query_snapshot", id, args)).data;
async function invoke(id: string, args: unknown) { const result = await native("invoke", id, args); expect(result.status, result.error).toBe("succeeded"); return result.output; }
async function sessions(page: Page) { await page.getByRole("button", { name: "Session", exact: true }).click(); await page.getByRole("menuitem", { name: "R Sessions…", exact: true }).click(); await expect(page.locator(".runtime-page")).toBeVisible(); }

test("real multi-session management, graph coverage, restoration and empty restart", async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(url); await expect(page.getByRole("textbox", { name: "Console Input" })).toBeVisible();
  await expect.poll(async () => (await query("runtime.instance", { workspace_instance_id: "main" })).state).toBe("ready");
  await invoke("workspace.run_r", { workspace_instance_id: "main", code: "samples <- data.frame(condition=rep(c('control','treated'),each=12),value=1:24); model <- lm(value~condition,samples); db <- new('externalptr')" });
  const main = await query("runtime.instance", { workspace_instance_id: "main" });
  const copy = await invoke("workspace.checkpoint_capture", { workspace_instance_id: "main", expected_session: main.native_session_id, automatic: false, max_bytes: 10485760, max_seconds: 10, include_names: null, exclude_names: [], include_patterns: [], exclude_patterns: [] });
  expect(copy.report.saved_names).toContain("model"); expect(copy.report.skipped.map((x: { name: string }) => x.name)).toEqual(["db"]);
  const consoleInput = page.getByRole("textbox", { name: "Console Input" }); await consoleInput.fill("# unsent console draft");
  await page.getByRole("button", { name: "File", exact: true }).click(); await page.getByRole("menuitem", { name: "New R File", exact: true }).click();
  const editor = page.locator(".document-panel:visible .cm-content"); await editor.fill("# retained editor draft\nx <- 123");
  await sessions(page); await page.getByRole("tab", { name: "Recovery copies" }).click();
  await expect(page.locator(".runtime-coverage")).toContainText("db"); await expect(page.locator(".runtime-coverage")).toContainText("Live connection or external resource");
  await expect(page.locator(".runtime-page").getByText(/objects restored from/)).toHaveCount(0);
  await page.getByRole("button", { name: "Pin copy", exact: true }).click(); await expect(page.getByRole("button", { name: "Unpin copy", exact: true })).toBeVisible();
  for (const width of [1440, 1920, 1024, 600]) {
    await page.setViewportSize({ width, height: 950 });
    if (width === 600) { await page.getByRole("button", { name: /Main.*R 4/ }).click(); await page.locator(".runtime-copy-list button").first().click(); }
    await page.screenshot({ path: `../target/studio-browser/runtime-copies-${width}.png` });
    expect(await page.locator(".runtime-page").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.getByRole("button", { name: "Restore in new session…", exact: true }).click();
  await page.getByRole("textbox", { name: "Session name" }).fill("Recovered");
  await page.getByLabel("Use as execution target when ready").uncheck();
  await page.getByRole("button", { name: "Restore in new session", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Restore in new session", exact: true })).toHaveCount(0);
  await expect(page.locator(".runtime-session-row")).toHaveCount(2);
  const catalog = await query("runtime.instances", { limit: 20 }); expect(catalog.instances[0].workspace_instance_id).toBe("main");
  const restored = catalog.instances.find((entry: { name: string }) => entry.name === "Recovered");
  await invoke("workspace.run_r", { workspace_instance_id: restored.workspace_instance_id, code: "stopifnot(inherits(model,'lm'),length(predict(model))==24,!exists('db',inherits=FALSE))" });
  await page.getByRole("button", { name: /Recovered.*R 4/ }).click(); await page.getByRole("tab", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Restart R…", exact: true }).click();
  await page.getByRole("button", { name: "Restart with empty memory", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Recovered restarted" })).toBeVisible(); await page.getByRole("button", { name: "Done", exact: true }).click();
  await invoke("workspace.run_r", { workspace_instance_id: restored.workspace_instance_id, code: "stopifnot(!exists('model',inherits=FALSE))" });
  await invoke("workspace.run_r", { workspace_instance_id: "main", code: "stopifnot(inherits(model,'lm'),exists('db',inherits=FALSE))" });
  await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
  await expect(consoleInput).toHaveText("# unsent console draft");
  await expect(editor).toContainText("# retained editor draft");
  const target = page.locator(".session-target"); await target.click(); await page.keyboard.press("Escape"); await expect(target).toBeFocused();
  await target.click(); await page.getByRole("menuitem").filter({ hasText: "Recovered" }).focus(); await page.keyboard.press("Enter"); await expect(target).toContainText("Recovered");
  await target.click(); await page.getByRole("menuitem").filter({ hasText: "Main" }).focus(); await page.keyboard.press("Enter"); await expect(consoleInput).toHaveText("# unsent console draft");
  const running = native("invoke", "workspace.run_r", { workspace_instance_id: restored.workspace_instance_id, code: "Sys.sleep(2)" });
  await expect.poll(async () => !!(await query("workspace.console_state", { workspace_instance_id: restored.workspace_instance_id })).current).toBe(true);
  await target.click(); await expect(page.getByRole("menuitem").filter({ hasText: "Recovered" })).toContainText("Running"); await page.keyboard.press("Escape");
  expect((await running).status).toBe("succeeded");
  expect(errors).toEqual([]);
});

test("session creation waits for readiness, settings inherit and narrow navigation retains drafts", async ({ page }) => {
  test.setTimeout(90000);
  await page.goto(url); await expect(page.getByRole("textbox", { name: "Console Input" })).toBeVisible();
  await sessions(page); await page.getByRole("button", { name: "＋ New session…", exact: true }).click();
  await page.getByRole("textbox", { name: "Session name" }).fill("Scratch"); await expect(page.getByRole("button", { name: "Create session", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Create session", exact: true }).click(); await expect(page.getByRole("dialog", { name: "New R session", exact: true })).toHaveCount(0);
  await expect(page.locator(".runtime-heading")).toContainText("Scratch");
  await page.getByRole("button", { name: "More ▾", exact: true }).click(); await page.getByRole("menuitem", { name: "Session settings", exact: true }).click();
  await page.getByLabel("Minimum interval (seconds)").fill("600"); await page.getByRole("button", { name: "Save settings", exact: true }).click(); await expect(page.getByText("Recovery settings saved.")).toBeVisible();
  const catalog = await query("runtime.instances", { limit: 20 }), scratch = catalog.instances.find((entry: { name: string }) => entry.name === "Scratch");
  expect(scratch.policy.value.automatic_interval_seconds).toBe(600);
  const row = page.locator(".runtime-setting-row").filter({ has: page.getByLabel("Minimum interval (seconds)") }); await row.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect.poll(async () => (await query("runtime.instance", { workspace_instance_id: scratch.workspace_instance_id })).policy.instance.automatic_interval_seconds).toBeNull();
  await page.setViewportSize({ width: 600, height: 900 }); await page.screenshot({ path: "../target/studio-browser/runtime-settings-600.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("radio", { name: /^Off/ }).check(); await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect.poll(async () => (await query("runtime.instance", { workspace_instance_id: scratch.workspace_instance_id })).policy.value.mode).toBe("off");
  await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
  await invoke("workspace.run_r", { workspace_instance_id: scratch.workspace_instance_id, code: "off_value <- 1L" });
  await sessions(page); await page.locator(".runtime-session-row").filter({ hasText: "Scratch" }).click();
  await page.getByRole("button", { name: "Restart R…", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restart with empty memory", exact: true })).toBeDisabled();
  await page.getByLabel("Continue without a fresh complete recovery copy").check();
  await page.getByRole("button", { name: "Restart with empty memory", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Scratch restarted" })).toBeVisible(); await page.getByRole("button", { name: "Done", exact: true }).click();
  await invoke("workspace.run_r", { workspace_instance_id: scratch.workspace_instance_id, code: "stopifnot(!exists('off_value',inherits=FALSE))" });
  const settings = await query("runtime.settings", { workspace_instance_id: scratch.workspace_instance_id });
  await invoke("runtime.update_settings", { scope: "instance", workspace_instance_id: scratch.workspace_instance_id, expected_version: settings.instance_version, overrides: { ...settings.effective.instance, mode: null } });
});

test("bounded copy lists read the complete immutable coverage before presenting details", async ({ page }) => {
  await page.goto(url); await expect(page.getByRole("textbox", { name: "Console Input" })).toBeVisible();
  await invoke("workspace.run_r", { workspace_instance_id: "main", code: "for(i in 1:80) assign(sprintf('unprotected_resource_%03d_long_name',i),new('externalptr')); rm(i)" });
  const main = await query("runtime.instance", { workspace_instance_id: "main" });
  await invoke("workspace.checkpoint_capture", { workspace_instance_id: "main", expected_session: main.native_session_id, max_bytes: 10485760, max_seconds: 10 });
  const catalog = await query("workspace.checkpoints", { workspace_instance_id: "main", limit: 20 });
  expect(catalog.entries[0].details_complete).toBe(false);
  expect(catalog.entries[0].skipped_count).toBeGreaterThan(catalog.entries[0].manifest.report.skipped.length);
  await sessions(page); await page.locator(".runtime-session-row").filter({ hasText: "Main" }).click(); await page.getByRole("tab", { name: "Recovery copies" }).click();
  await expect(page.locator(".runtime-coverage")).toContainText("unprotected_resource_080_long_name");
  await invoke("workspace.run_r", { workspace_instance_id: "main", code: "rm(list=ls(pattern='^unprotected_resource_'))" });
});

test("quit confirms active work ended and saves objects before stopping local sessions", async ({ page }) => {
  test.setTimeout(90000);
  await page.goto(url); await expect(page.getByRole("textbox", { name: "Console Input" })).toBeVisible();
  await expect.poll(async () => (await query("runtime.instance", { workspace_instance_id: "main" })).state).toBe("ready");
  await invoke("workspace.run_r", { workspace_instance_id: "main", code: "if (exists('db',inherits=FALSE)) rm(db); quit_sentinel <- 4321L" });
  const active = native("invoke", "workspace.run_r", { workspace_instance_id: "main", code: "Sys.sleep(20)" });
  await expect.poll(async () => !!(await query("workspace.console_state", { workspace_instance_id: "main" })).current).toBe(true);
  const queued = native("invoke", "workspace.run_r", { workspace_instance_id: "main", code: "should_not_run <- TRUE" });
  await expect.poll(async () => (await query("workspace.console_state", { workspace_instance_id: "main" })).pending.length).toBe(1);
  await page.getByRole("button", { name: "File", exact: true }).click(); await page.getByRole("menuitem", { name: "Quit Workbench…", exact: true }).click();
  await page.getByRole("button", { name: "Stop sessions and quit", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Workbench stopped", exact: true })).toBeVisible({ timeout: 45000 });
  expect((await active).status).toBe("cancelled"); expect((await queued).status).toBe("cancelled");
  await expect.poll(() => host.exitCode).toBe(0);
  await startHost(); await page.goto(url);
  await expect.poll(async () => (await query("runtime.instance", { workspace_instance_id: "main" })).state).toBe("ready");
  await invoke("workspace.run_r", { workspace_instance_id: "main", code: "stopifnot(quit_sentinel==4321L,!exists('should_not_run',inherits=FALSE))" });
});
