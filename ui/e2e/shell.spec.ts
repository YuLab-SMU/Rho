import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let directory: string, project: string, url: string, host: ReturnType<typeof spawn>;
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "rho-shell-"));
  project = join(directory, "study"); await mkdir(project);
  host = spawn(resolve("../target/debug/rho"), ["--database", join(directory, "state.sqlite"), "--project", project, "--fixed-workspace", "workbench"], { stdio: ["ignore", "pipe", "pipe"] });
  url = await new Promise<string>((resolve, reject) => {
    let output = "", errors = "";
    const timer = setTimeout(() => reject(new Error(`Shell Host startup timed out: ${errors}`)), 40000);
    host.stderr!.on("data", data => { errors += data; });
    host.stdout!.on("data", data => { output += data; const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-z0-9]+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    host.once("exit", code => { clearTimeout(timer); reject(new Error(`Shell Host exited ${code}: ${errors}`)); });
  });
});
test.afterAll(async () => {
  if (host?.exitCode === null) { host.kill("SIGINT"); await new Promise<void>(resolve => host.once("exit", () => resolve())); }
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function api(path: string, body?: unknown) {
  const parsed = new URL(url), token = new URLSearchParams(parsed.hash.slice(1)).get("token");
  return fetch(parsed.origin + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}
// A managed Host routes every live R request to an explicit instance.
const INSTANCE_FREE = ["workspace.list_outputs", "workspace.read_output", "workspace.output_events"];
const nativeArguments = (id: string, args: unknown) => id.startsWith("workspace.") && !INSTANCE_FREE.includes(id)
  ? { workspace_instance_id: "main", ...(args as object) } : args;
async function queryNative(id: string, args: unknown = {}) {
  const info = await (await api("/api/info")).json();
  const response = await api("/api/host", { project_root: info.project_root, frame: { id: crypto.randomUUID(), request: { method: "query_snapshot", params: { capability: { id, version: 1 }, arguments: nativeArguments(id, args) } } } });
  expect(response.ok).toBe(true);
  const reply = await response.json();
  expect(reply.ok, reply.error).toBe(true);
  return reply.result;
}
async function resetLayout(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Reset Layout", exact: true }).click();
}
async function newFile(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "New R File", exact: true }).click();
}

test("workspace shell retains module placement, drafts and pinned resource metrics", async ({ page }) => {
  await page.goto(url); await resetLayout(page);
  const rail = page.getByRole('navigation', { name: 'Workspace modules' });
  const footer = page.getByRole('contentinfo', { name: 'Workspace status' });
  await expect(rail).toBeVisible();
  const nativeBefore = (await queryNative('workspace.runtime_status')).data.session_id;
  await newFile(page);
  const draft = page.locator('.document-panel:visible .cm-content');
  await draft.fill('# shell draft survives navigation\nvalue <- 42');
  const filesGroup = page.locator('.flexlayout__tabset').filter({ has: page.getByRole('tab', { name: 'Files', exact: true }) });
  const original = (await filesGroup.boundingBox())!;
  await filesGroup.getByRole('button', { name: 'Collapse Group', exact: true }).click();
  await rail.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Files', exact: true })).toBeVisible();
  expect(Math.abs((await filesGroup.boundingBox())!.width - original.width)).toBeLessThan(3);
  await rail.getByRole('button', { name: 'Editor', exact: true }).click();
  await expect(draft).toContainText('shell draft survives navigation');
  await expect(rail.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute('aria-current', 'true');
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  await expect(rail).toHaveClass(/is-expanded/);
  expect((await rail.boundingBox())!.width).toBe(168);
  await page.getByRole('button', { name: 'Customize status bar', exact: true }).click();
  for (const name of ['R CPU', 'R memory', 'Project disk']) {
    const item = page.getByRole('menuitemcheckbox', { name, exact: true });
    if (await item.getAttribute('aria-checked') !== 'true') await item.click();
    await expect(item).toHaveAttribute('aria-checked', 'true');
  }
  await expect(page.getByRole('menuitemcheckbox', { name: 'Project disk', exact: true })).toBeVisible();
  await page.screenshot({ path: '../target/studio-browser/shell-metric-options.png' });
  await page.keyboard.press('Escape');
  await expect(footer.locator('[data-metric="statusDisk"]')).toContainText(/\d+%/);
  await expect(footer.locator('[data-metric="statusMemory"]')).toContainText(/\d+.*[MG]iB/);
  await expect(footer.locator('[data-metric="statusCpu"]')).toContainText(/\d+\.\d%/);
  await expect(footer.getByRole('button', { name: 'Drafts synced', exact: true })).toBeVisible();
  await page.reload();
  await expect(rail).toHaveClass(/is-expanded/);
  await expect(footer.locator('.status-metric')).toHaveCount(3);
  await expect(draft).toContainText('shell draft survives navigation');
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  for (const width of [1920, 1440, 1024, 800, 600]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => (await rail.boundingBox())!.width).toBe(48);
    for (const key of ['statusCpu', 'statusMemory', 'statusDisk']) {
      const metric = footer.locator(`[data-metric="${key}"]`); await expect(metric).toBeVisible();
      const box = (await metric.boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    }
    await page.screenshot({ path: `../target/studio-browser/shell-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Customize status bar', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'R CPU', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('menuitemcheckbox', { name: 'R CPU', exact: true })).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(footer.locator('[data-metric="statusCpu"]')).toHaveCount(0);
  await expect(footer.locator('.status-metric')).toHaveCount(2);
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New Console View', exact: true }).click();
  await rail.getByRole('button', { name: 'Console', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /^Console 2/ })).toBeVisible();
  await page.getByRole('menuitem', { name: /^Console 2/ }).click();
  expect((await queryNative('workspace.runtime_status')).data.session_id).toBe(nativeBefore);
  await expect(draft).toContainText('shell draft survives navigation');
});

test("workspace shell shows input and connection loss without reporting stale resources as current", async ({ page }) => {
  await page.goto(url); await resetLayout(page);
  const footer = page.getByRole('contentinfo', { name: 'Workspace status' });
  await page.getByRole('button', { name: 'Customize status bar', exact: true }).click();
  const memory = page.getByRole('menuitemcheckbox', { name: 'R memory', exact: true });
  if (await memory.getAttribute('aria-checked') !== 'true') await memory.click();
  await expect(memory).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: 'Console Input' }).fill('answer <- readline("Shell answer: ")');
  await page.locator('.console-prompt .primary').first().click();
  await expect(footer).toContainText('Waiting for R input');
  const consoleGroup = page.locator('.flexlayout__tabset').filter({ has: page.getByRole('tab', { name: 'Console', exact: true }) });
  await consoleGroup.getByRole('button', { name: 'Collapse Group', exact: true }).click();
  await footer.getByRole('button', { name: /Waiting for R input/ }).click();
  await expect(page.getByRole('tab', { name: 'Console', exact: true })).toBeVisible();
  const pending = (await queryNative('workspace.console_state')).data.input;
  expect(pending).toBeTruthy();
  await page.screenshot({ path: '../target/studio-browser/shell-input.png' });
  // Answer through the existing native input owner; navigation did not submit it.
  await api('/api/host', { project_root: (await (await api('/api/info')).json()).project_root,
    frame: { id: crypto.randomUUID(), request: { method: 'respond_input', params: { session_id: pending.session_id, operation_id: pending.operation_id, request_id: pending.request_id, reply_id: crypto.randomUUID(), value: 'yes' } } } });
  await expect.poll(async () => (await queryNative('workspace.console_state')).data.input).toBeNull();
  await page.route('**/api/info', route => route.abort());
  await expect(footer).toContainText('Connection lost');
  await expect(footer.locator('[data-metric="statusMemory"]')).toContainText('Unknown');
  await page.screenshot({ path: '../target/studio-browser/shell-disconnected.png' });
  await page.unroute('**/api/info');
});
