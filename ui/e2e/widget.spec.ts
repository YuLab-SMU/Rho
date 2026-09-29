import { test, expect, type Page } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let directory: string;
let project: string;
let url: string;
let host: ReturnType<typeof spawn>;

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "rho-widget-ui-"));
  await mkdir(join(directory, "widget-project"));
  project = await realpath(join(directory, "widget-project"));
  const rHome = execFileSync("R", ["RHOME"], { encoding: "utf8" }).trim();
  host = spawn(resolve("../target/debug/rho"), [
    "--database", join(directory, "records.sqlite"),
    "--project", project,
    "--r-home", rHome,
    "--fixed-workspace", "workbench",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  url = await new Promise<string>((accept, reject) => {
    let output = "", errors = "";
    const timer = setTimeout(() => reject(new Error(`Host startup timed out: ${errors}`)), 40000);
    host.stderr!.on("data", data => { errors += data; });
    host.stdout!.on("data", data => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-z0-9]+/);
      if (match) { clearTimeout(timer); accept(match[0]); }
    });
    host.once("exit", code => { clearTimeout(timer); reject(new Error(`Host exited ${code}: ${errors}`)); });
  });
});

test.afterAll(async () => {
  if (host?.exitCode === null) {
    host.kill("SIGINT");
    await new Promise<void>(accept => host.once("exit", () => accept()));
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function runR(page: Page, code: string, invoked: string[]) {
  const before = invoked.length;
  const input = page.getByRole("textbox", { name: "Console Input" });
  await input.fill(code);
  await page.locator(".console-prompt .primary").first().click();
  await expect.poll(() => invoked.length, { timeout: 30000 }).toBe(before + 1);
  await expect(page.locator(".console-status > span").first()).toHaveText("Ready", { timeout: 30000 });
}

async function showPanel(page: Page, name: string) {
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

test("DT widgets are delivered through isolated HTML view capabilities and stay separate from plots", async ({ page }, testInfo) => {
  test.setTimeout(120000);
  const invoked: string[] = [];
  await page.on("request", request => {
    if (!request.url().includes("/api/host") || request.method() !== "POST") return;
    try {
      const body = request.postDataJSON();
      if (body?.frame?.request?.method === "invoke") invoked.push(body.frame.request.params.capability.id);
    } catch { /* Non-JSON requests are not operation submissions. */ }
  });

  await page.goto(url);
  await expect(page.getByRole("textbox", { name: "Console Input" })).toBeVisible();
  const beforeEmptyViewer = invoked.length;
  await showPanel(page, "Viewer");
  await expect(page.locator(".panel-empty")).toContainText("No HTML output selected");
  expect(invoked.slice(beforeEmptyViewer)).toEqual([]);

  await runR(page, 'stopifnot(requireNamespace("DT", quietly=TRUE)); print(DT::datatable(data.frame(widget_label="first", value=1:3), options=list(pageLength=3)))', invoked);
  await runR(page, 'plot(1:4, main="plot-between-widgets")', invoked);
  await runR(page, 'print(DT::datatable(data.frame(widget_label="second", value=4:6), options=list(pageLength=3)))', invoked);

  await expect(page.locator(".viewer-history-item")).toHaveCount(2, { timeout: 30000 });
  const viewer = page.locator(".viewer-panel:visible");
  const frame = viewer.locator("iframe.viewer-frame");
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  const firstSrc = await frame.getAttribute("src");
  expect(firstSrc).toMatch(/^\/view\/html\/[0-9a-f]{64}$/);
  expect(firstSrc).not.toContain("?");
  expect(firstSrc).not.toContain("bearer");
  await expect(frame.contentFrame().locator(".dataTables_wrapper")).toBeVisible({ timeout: 30000 });
  await expect(frame.contentFrame().locator("body")).toContainText("second");

  await viewer.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => frame.getAttribute("src")).not.toBe(firstSrc);
  await expect(frame.contentFrame().locator(".dataTables_wrapper")).toBeVisible({ timeout: 30000 });
  await expect(frame.contentFrame().locator("body")).toContainText("second");

  await showPanel(page, "Plots");
  await expect(page.locator(".plot-original img:visible")).toHaveCount(1, { timeout: 30000 });
  await showPanel(page, "Viewer");
  await expect(page.locator(".viewer-history-item")).toHaveCount(2);

  for (const width of [1440, 1920, 600]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`viewer-${width}.png`), fullPage: true });
    expect(await viewer.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  expect(invoked.filter(id => id === "workspace.run_r")).toHaveLength(3);
});
