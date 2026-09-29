import { test, expect, type Page } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, copyFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let directory: string;
let project: string;
let url: string;
let host: ReturnType<typeof spawn>;

async function startHost() {
  const ark = join(directory, "ark");
  const rHome = execFileSync("R", ["RHOME"], { encoding: "utf8" }).trim();
  await copyFile(resolve("../target/debug/ark"), ark);
  execFileSync(
    process.execPath,
    ["scripts/bootstrap-recovery-component.mjs", "--ark", ark, "--r", join(rHome, "bin/R")],
    { cwd: resolve(".."), encoding: "utf8" },
  );
  host = spawn(
    resolve("../target/debug/rho"),
    ["--database", join(directory, "records.sqlite"), "--ark", ark, "--r-home", rHome, "--fixed-workspace", "workbench"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RHO_DEMO_PROJECT: project, XDG_DATA_HOME: join(directory, "app-data") },
    },
  );
  url = await new Promise<string>((accept, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Host startup timed out: ${stderr}`)), 40000);
    host.stdout!.on("data", data => {
      stdout += data;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-z0-9]+/);
      if (match) { clearTimeout(timer); accept(match[0]); }
    });
    host.stderr!.on("data", data => { stderr += data; });
    host.once("exit", code => { clearTimeout(timer); reject(new Error(`Host exited ${code}: ${stderr}`)); });
  });
}

async function showPanel(page: Page, name: string) {
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "rho-demo-ui-"));
  await mkdir(join(directory, "demo"), { recursive: true });
  project = await realpath(join(directory, "demo"));
  await startHost();
});

test.afterAll(async () => {
  if (host?.exitCode === null) {
    host.kill("SIGINT");
    await new Promise<void>(resolveExit => host.once("exit", () => resolveExit()));
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("opens the real demo and exposes its files, objects, plots and Viewer output", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto(url);
  await expect(page.getByRole("button", { name: "Open Rho Demo", exact: true })).toBeVisible();
  const demoResponse = page.waitForResponse(
    response => response.url().endsWith("/api/project/demo"),
    { timeout: 90000 },
  );
  await page.getByRole("button", { name: "Open Rho Demo", exact: true }).click();
  expect((await demoResponse).ok()).toBeTruthy();
  await expect(page.getByRole("textbox", { name: "Console Input" })).toBeVisible({ timeout: 90000 });
  await expect(page.getByRole("button", { name: "demo", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open File…", exact: true }).click();
  await page.getByRole("dialog").getByLabel("File Path").fill("run_demo.R");
  await page.getByRole("dialog").getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("button", { name: "Session", exact: true }).click();
  await page.getByRole("menuitem", { name: /Run File/ }).click();

  await expect(page.locator(".console-transcript:visible")).toContainText("Rho demo complete: 1704 observations and 142 countries.", { timeout: 60000 });
  await expect(page.locator(".objects-panel")).toContainText("clean");
  await expect(page.locator(".objects-panel")).toContainText("model");
  await expect(page.locator(".plot-panel:visible .plot-original img")).toBeVisible({ timeout: 30000 });

  await showPanel(page, "Viewer");
  await expect(page.locator(".viewer-panel")).toBeVisible();
  await expect(page.locator("iframe[title=\"HTML Viewer\"]")).toBeVisible({ timeout: 30000 });
  await showPanel(page, "Packages");
  await expect(page.locator(".packages-panel")).toBeVisible();
  await showPanel(page, "Agent");
  await expect(page.locator(".agent-panel")).toBeVisible();
});
