import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromDesktop = createRequire(join(repositoryRoot, "desktop", "package.json"));
const { chromium } = requireFromDesktop("playwright-core");
const outputRoot = join(repositoryRoot, "desktop", "dist");
const artifactRoot = mkdtempSync(join(tmpdir(), "rho-rsr-interactions-"));
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/favicon.ico") {
    response.writeHead(204).end();
    return;
  }
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = normalize(join(outputRoot, relativePath));
  if (candidate !== outputRoot && !candidate.startsWith(`${outputRoot}${sep}`)) {
    response.writeHead(403).end();
    return;
  }
  let bytes;
  try {
    bytes = readFileSync(candidate);
  } catch {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentTypes.get(extname(candidate)) ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  response.end(bytes);
});

await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
if (address == null || typeof address === "string") throw new Error("interaction server has no port");

async function launchSystemChromium() {
  const candidates = process.env.RHO_RSR_BROWSER == null
    ? [{ channel: "chrome" }, { channel: "msedge" }]
    : [{ executablePath: process.env.RHO_RSR_BROWSER }];
  const failures = [];
  for (const candidate of candidates) {
    try {
      return await chromium.launch({
        ...candidate,
        headless: true,
        args: [
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-default-apps",
          "--disable-sync",
          "--no-default-browser-check",
          "--no-first-run",
        ],
      });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`No supported system Chromium could be launched:\n${failures.join("\n")}`);
}

const browser = await launchSystemChromium();
let currentPage = null;
let succeeded = false;

async function openWorkbench(query = "", viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  currentPage = page;
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${address.port}/?project=%2Ftmp%2Frsr-interaction${query}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => document.documentElement.dataset.rsrReady === "true", null, { timeout: 15_000 });
  await page.locator('[data-editor-ready="true"]').waitFor({ timeout: 15_000 });
  if (browserErrors.length > 0) throw new Error(`browser emitted errors: ${browserErrors.join(" | ")}`);
  return { context, page, browserErrors };
}

async function evidence(page) {
  return page.locator("#rsrPreviewEvidence").evaluate((element) => JSON.parse(element.textContent ?? "{}"));
}

async function openHistory(page) {
  let compose = page.getByRole("button", { name: "Compose" });
  if (await compose.count() === 0) {
    await page.getByRole("button", { name: "Customize toolbar" }).click();
    const dialog = page.getByRole("dialog", { name: "Toolbar components" });
    await dialog.getByRole("checkbox", { name: "Compose" }).check();
    await dialog.getByRole("button", { name: "Done" }).click();
    compose = page.getByRole("button", { name: "Compose" });
  }
  await compose.click();
  const factory = page.locator('[data-surface-factory="rho.runs"]');
  await factory.getByRole("button", { name: "Open", exact: true }).click();
  await page.locator('article[data-surface-id="rho.runs"]').waitFor();
}

try {
  {
    const { context, page } = await openWorkbench();
    const declared = JSON.parse(await page.locator("body").evaluate(async () =>
      (await fetch("./build-identity.json", { cache: "no-store" })).text()
    ));
    const htmlBuildId = await page.locator("html").getAttribute("data-rsr-build-id");
    if (htmlBuildId !== declared.build_id || (await evidence(page)).buildId !== declared.build_id) {
      throw new Error("DOM, preview evidence, and generated build identity disagree");
    }
    await page.getByLabel("Rho menu").click();
    await page.getByRole("button", { name: new RegExp(`Development build\\s+${declared.build_id}`) }).waitFor();

    const separator = page.locator('[role="separator"][aria-orientation="vertical"]:visible').first();
    const box = await separator.boundingBox();
    if (box == null) throw new Error("no visible horizontal layout boundary is pointer-resizable");
    const initialRevision = (await evidence(page)).layoutRevision;
    const resizedPane = page.locator('article[data-surface-id="rho.navigator"]');
    const beforeWidth = (await resizedPane.boundingBox())?.width ?? 0;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 64, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction((revision) => {
      const hook = document.querySelector("#rsrPreviewEvidence");
      return hook != null && JSON.parse(hook.textContent ?? "{}").layoutRevision > revision;
    }, initialRevision);
    const afterWidth = (await resizedPane.boundingBox())?.width ?? 0;
    if (afterWidth <= beforeWidth + 24) throw new Error(`pointer resize did not materially change width: ${beforeWidth} -> ${afterWidth}`);
    await context.close();
  }

  {
    const { context, page } = await openWorkbench("&plugin=surface");
    const navigator = page.locator('article[data-surface-id="rho.navigator"]');
    const filesTab = navigator.getByRole("tab", { name: "Files", exact: true });
    await filesTab.focus();
    await filesTab.press("ArrowRight");
    await navigator.getByRole("tab", { name: "History", exact: true })
      .waitFor({ state: "visible" });
    if (await navigator.getByRole("tab", { name: "History", exact: true }).getAttribute("aria-selected") !== "true") {
      throw new Error("Navigator ArrowRight did not activate History");
    }
    const recentOutputs = navigator.locator(".rho-navigator-recent");
    if (!await recentOutputs.evaluate((element) => element.open)) {
      await recentOutputs.locator("summary").click();
    }
    if (!await recentOutputs.evaluate((element) => element.open)) {
      throw new Error("Navigator recent outputs did not remain expanded after activation");
    }
    await navigator.getByRole("button", { name: "View all outputs" }).click();
    await page.waitForFunction(() =>
      document.querySelector('article[data-surface-id="rho.navigator"] [role="tab"][aria-selected="true"]')
        ?.textContent?.trim() === "Artifacts"
    );
    if (await navigator.getByRole("tab", { name: "Artifacts", exact: true }).getAttribute("aria-selected") !== "true") {
      throw new Error("Navigator recent-output action did not activate Artifacts");
    }

    const plugin = page.locator('article[data-surface-id="ui.surface.differential-expression"]');
    await plugin.waitFor();
    if (await plugin.locator(".rho-surface-title strong").first().textContent() !== "Differential expression") {
      throw new Error("project component exposed its technical Surface identifier");
    }
    await plugin.getByRole("tab", { name: "Configure", exact: true }).click();
    await plugin.getByLabel("Contrast").waitFor();

    await page.getByRole("tab", { name: "Environment", exact: true }).click();
    const environment = page.locator('article[data-surface-id="rho.environment"]');
    await environment.getByRole("button", { name: "More actions for Environment" }).click();
    await page.getByRole("dialog", { name: "More actions for Environment" })
      .getByRole("button", { name: "Requests", exact: true })
      .click();
    await environment.getByText("No environment operations yet", { exact: true }).waitFor();
    await context.close();
  }

  {
    const { context, page } = await openWorkbench("&fixture=source-gaps&scenario_trace=1");
    const consoleSurface = page.locator('article[data-surface-id="rho.console"]');
    await consoleSurface.click({ position: { x: 24, y: 24 } });
    const consoleInput = consoleSurface.getByLabel(/^Code for /);
    await consoleInput.fill("1 + 1");
    await consoleInput.press("Enter");
    await consoleSurface.getByText("Mock evaluation: 1 + 1", { exact: true }).waitFor({ timeout: 10_000 });
    const editor = page.locator('.monaco-editor[role="code"]');
    await editor.click({ position: { x: 80, y: 38 } });
    const runShortcut = process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";
    await page.keyboard.press(runShortcut);
    await page.locator(".line-numbers.active-line-number").getByText("3", { exact: true }).waitFor();
    await page.keyboard.press(runShortcut);
    await page.waitForFunction(() => globalThis.__RHO_RSR_SCENARIO_TRACE__?.runtimeExecuteAttempts.length >= 2);
    await consoleSurface.waitFor({ timeout: 10_000 });
    await consoleSurface.getByText("Mock evaluation: library(ggplot2)", { exact: true }).waitFor({ timeout: 10_000 });
    if (await page.getByText("Selection or current R expression is empty or incomplete.", { exact: true }).count() > 0) {
      throw new Error("blank-gap Source execution regressed to an incomplete-selection error");
    }
    await openHistory(page);
    await page.locator('[data-domain-id^="runtime-execution:mock-"]').first().waitFor({ timeout: 10_000 });
    await context.close();
  }

  {
    const { context, page } = await openWorkbench("&fixture=source-gaps&fault=runtime-execute&scenario_trace=1");
    await page.locator('article[data-surface-id="rho.console"]').click({ position: { x: 24, y: 24 } });
    const editor = page.locator('.monaco-editor[role="code"]');
    await editor.click({ position: { x: 80, y: 38 } });
    const runShortcut = process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";
    await page.keyboard.press(runShortcut);
    await page.locator(".line-numbers.active-line-number").getByText("3", { exact: true }).waitFor();
    await page.keyboard.press(runShortcut);
    await page.waitForFunction(() => globalThis.__RHO_RSR_SCENARIO_TRACE__?.runtimeExecuteRejections === 1);
    await page.getByText("Injected Runtime rejection: execution was not admitted and no run was recorded.", { exact: true }).waitFor({ timeout: 10_000 });
    await openHistory(page);
    if (await page.locator('[data-domain-id^="runtime-execution:mock-"]').count() !== 0) {
      throw new Error("rejected execution was falsely recorded in History");
    }
    await context.close();
  }

  {
    const { context, page } = await openWorkbench();
    const source = page.locator('[data-rho-tab-instance-id="instance:navigator"]');
    const target = page.locator('article[data-surface-id="rho.file-source"]');
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (sourceBox == null || targetBox == null) throw new Error("pointer docking source or target is not visible");
    const initialRevision = (await evidence(page)).layoutRevision;
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 12, sourceBox.y + sourceBox.height / 2 + 12, { steps: 2 });
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 });
    await page.locator(".dv-drop-target:visible").first().waitFor({ timeout: 5_000 });
    await page.mouse.up();
    await page.waitForFunction((revision) => {
      const hook = document.querySelector("#rsrPreviewEvidence");
      return hook != null && JSON.parse(hook.textContent ?? "{}").layoutRevision > revision;
    }, initialRevision);
    await context.close();
  }

  {
    const { context, page } = await openWorkbench("", { width: 760, height: 680 });
    const recovery = page.getByRole("button", { name: /^Show collapsed / }).first();
    if (await recovery.count() > 0) {
      const label = await recovery.getAttribute("aria-label");
      await recovery.click();
      if (label != null) await page.getByRole("button", { name: label }).waitFor({ state: "detached" });
    } else {
      for (const surfaceId of ["rho.navigator", "rho.file-source", "rho.console", "rho.agent"]) {
        await page.locator(`article[data-surface-id="${surfaceId}"]`).waitFor();
      }
    }
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (horizontalOverflow > 2) throw new Error(`narrow recovery introduced ${horizontalOverflow}px horizontal overflow`);
    await context.close();
  }

  {
    const { context, page } = await openWorkbench("&vibe=information-flow", { width: 1440, height: 900 });
    await page.getByRole("button", { name: "Vibe", exact: true }).click();
    const vibeWorkspace = page.locator(".rho-vibe-workspace");
    await vibeWorkspace.waitFor();
    if (await vibeWorkspace.getAttribute("data-layout") !== "overview") {
      throw new Error("Vibe did not open in the three-layer overview");
    }
    const regions = vibeWorkspace.locator(".rho-vibe-region");
    if (await regions.count() !== 3) {
      throw new Error(`Vibe overview rendered ${await regions.count()} regions instead of three`);
    }
    for (const region of ["manuscript", "exploration", "verification"]) {
      if (!await regions.filter({ has: page.locator(`.rho-vibe-region-body > .rho-vibe-${region}`) }).isVisible()) {
        throw new Error(`Vibe overview did not expose the ${region} information layer`);
      }
    }
    if (!await vibeWorkspace.getByLabel("当前对应关系").isVisible()) {
      throw new Error("Vibe overview did not expose the current correspondence path");
    }
    if ((await vibeWorkspace.locator(".rho-vibe-workspace-header").textContent())?.includes("· r")) {
      throw new Error("Vibe exposed its internal Page revision in the default header");
    }

    const layerNavigation = vibeWorkspace.getByRole("navigation", { name: "Vibe information layer" });
    const explorationLayer = layerNavigation.getByRole("button", { name: "自主探索", exact: true });
    await explorationLayer.focus();
    await explorationLayer.press("Enter");
    await page.waitForFunction(() =>
      document.querySelector(".rho-vibe-workspace")?.getAttribute("data-layout") === "focus-exploration"
    );
    if (!await vibeWorkspace.locator('.rho-vibe-region[data-region="exploration"] .rho-vibe-region-body').isVisible()) {
      throw new Error("Vibe exploration focus did not expose the autonomous-exploration layer");
    }
    for (const region of ["manuscript", "verification"]) {
      if (await vibeWorkspace.locator(`.rho-vibe-region[data-region="${region}"] .rho-vibe-region-body`).isVisible()) {
        throw new Error(`Vibe exploration focus left the ${region} region body expanded`);
      }
    }
    await layerNavigation.getByRole("button", { name: "三联总览", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector(".rho-vibe-workspace")?.getAttribute("data-layout") === "overview"
    );
    if (await vibeWorkspace.locator(".rho-vibe-region-body:visible").count() !== 3) {
      throw new Error("Vibe did not restore all three information layers after leaving focus mode");
    }

    await page.setViewportSize({ width: 900, height: 800 });
    await page.waitForFunction(() => {
      const workspace = document.querySelector(".rho-vibe-workspace");
      if (workspace?.getAttribute("data-layout") !== "overview") return false;
      const regions = [...workspace.querySelectorAll(".rho-vibe-region")];
      return regions.length === 3 && regions.every((region) => {
        const body = region.querySelector(".rho-vibe-region-body");
        const bodyVisible = body != null && getComputedStyle(body).display !== "none";
        return region.getAttribute("data-active") === "true" ? bodyVisible : !bodyVisible;
      });
    });
    if (await vibeWorkspace.locator('.rho-vibe-region[data-active="false"] .rho-vibe-region-header:visible').count() !== 2) {
      throw new Error("Vibe intermediate overview did not preserve two readable preview bands");
    }
    const intermediateOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (intermediateOverflow > 2) {
      throw new Error(`Vibe intermediate overview introduced ${intermediateOverflow}px horizontal overflow`);
    }
    const intermediateStatus = await page.evaluate(() => {
      const statusbar = document.querySelector('.rho-statusbar[data-workspace-mode="vibe"]');
      const items = [...(statusbar?.querySelectorAll(".rho-statusbar-item") ?? [])];
      const path = statusbar?.querySelector(".rho-statusbar-path");
      return {
        labels: items.map((item) => item.textContent?.trim() ?? ""),
        clipped: items.some((item) => item.scrollWidth > item.clientWidth + 1),
        pathDisplay: path == null ? null : getComputedStyle(path).display,
      };
    });
    if (intermediateStatus.clipped || intermediateStatus.pathDisplay !== "none") {
      throw new Error(`Vibe intermediate status bar clipped authoritative labels: ${JSON.stringify(intermediateStatus)}`);
    }
    if (!intermediateStatus.labels.some((label) => label.startsWith("Workspace R"))
      || !intermediateStatus.labels.some((label) => label.startsWith("Agent runtime"))) {
      throw new Error(`Vibe intermediate status bar lost a runtime label: ${JSON.stringify(intermediateStatus.labels)}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    const verificationLayer = layerNavigation.getByRole("button", { name: "查验与结论", exact: true });
    await verificationLayer.focus();
    await verificationLayer.press("Enter");
    await page.waitForFunction(() =>
      document.querySelector(".rho-vibe-workspace")?.getAttribute("data-layout") === "focus-verification"
    );
    const openExactArtifact = vibeWorkspace.getByRole("button", { name: "在 Studio 中查看", exact: true }).first();
    await openExactArtifact.focus();
    await openExactArtifact.press("Enter");
    await page.locator(".rho-canvas-studio").waitFor();
    await page.locator("[data-surface-id='rho.artifacts'] [data-domain-id='artifact:plot-1']").waitFor();
    const returnToVibe = page.getByRole("button", { name: "Vibe", exact: true });
    await returnToVibe.focus();
    await returnToVibe.press("Enter");
    await vibeWorkspace.waitFor();
    if (await vibeWorkspace.getAttribute("data-layout") !== "focus-verification") {
      throw new Error("Vibe did not restore the verification focus after the exact Studio round trip");
    }
    if (await vibeWorkspace.locator("[data-block-id='block:vibe-artifact']").getAttribute("data-vibe-active") !== "true") {
      throw new Error("Vibe did not restore the exact manuscript block after the Studio round trip");
    }
    await context.close();
  }

  {
    const { context, page } = await openWorkbench("&vibe=information-flow", { width: 720, height: 700 });
    await page.getByRole("button", { name: "Vibe", exact: true }).click();
    const vibeWorkspace = page.locator(".rho-vibe-workspace");
    await vibeWorkspace.waitFor();
    const layerNavigation = vibeWorkspace.getByRole("navigation", { name: "Vibe information layer" });
    if (await vibeWorkspace.locator(".rho-vibe-region:visible").count() !== 1) {
      throw new Error("Vibe narrow layout did not reduce the workspace to one complete information layer");
    }
    if (!await vibeWorkspace.locator('.rho-vibe-region[data-region="manuscript"]').isVisible()) {
      throw new Error("Vibe narrow layout did not preserve the active manuscript layer");
    }
    const narrowVerification = layerNavigation.getByRole("button", { name: "查验与结论", exact: true });
    await narrowVerification.focus();
    await narrowVerification.press("Enter");
    await page.waitForFunction(() => {
      const workspace = document.querySelector(".rho-vibe-workspace");
      return workspace?.getAttribute("data-active-region") === "verification"
        && workspace?.getAttribute("data-layout") === "focus-verification";
    });
    if (!await vibeWorkspace.locator('.rho-vibe-region[data-region="verification"]').isVisible()) {
      throw new Error("Vibe narrow switcher did not expose the verification layer");
    }
    if (await vibeWorkspace.locator('.rho-vibe-region[data-region="manuscript"]').isVisible()) {
      throw new Error("Vibe narrow switcher left the previous manuscript layer visible");
    }

    const narrowManuscript = layerNavigation.getByRole("button", { name: "手稿", exact: true });
    await narrowManuscript.focus();
    await narrowManuscript.press("Enter");
    const manuscript = vibeWorkspace.locator('.rho-vibe-region[data-region="manuscript"]');
    await manuscript.waitFor({ state: "visible" });
    const editor = manuscript.getByRole("textbox", { name: / working manuscript$/ });
    await editor.click({ position: { x: 96, y: 36 } });
    await editor.press("End");
    await editor.pressSequentially(" Interaction checked.");
    const saveNow = manuscript.getByRole("button", { name: "Save now", exact: true });
    await saveNow.focus();
    await saveNow.press("Enter");
    await manuscript.getByText("Saved", { exact: true }).waitFor();

    const toolbarOverflow = await manuscript.getByRole("toolbar", { name: "Working manuscript formatting" }).evaluate((element) =>
      element.scrollWidth - element.clientWidth
    );
    if (toolbarOverflow > 2) throw new Error(`Vibe manuscript toolbar overflowed by ${toolbarOverflow}px at 200%-equivalent geometry`);
    const switcherOverflow = await layerNavigation.evaluate((element) => element.scrollWidth - element.clientWidth);
    if (switcherOverflow > 2) throw new Error(`Vibe information-layer switcher overflowed by ${switcherOverflow}px at 200%-equivalent geometry`);
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (horizontalOverflow > 2) throw new Error(`Vibe 200%-equivalent layout introduced ${horizontalOverflow}px horizontal overflow`);
    await context.close();
  }

  succeeded = true;
  process.stdout.write("RSR real-interaction acceptance passed: identity, resize, Navigator/plugin tabs, component modes, Source/Console/History, rejection recovery, docking, narrow layout, and Vibe overview/intermediate-preview/focus/narrow editing contracts\n");
} catch (error) {
  if (currentPage != null && !currentPage.isClosed()) {
    await currentPage.screenshot({ path: join(artifactRoot, "failure.png"), fullPage: true }).catch(() => undefined);
    writeFileSync(join(artifactRoot, "failure.html"), await currentPage.content().catch(() => ""));
  }
  process.stderr.write(`RSR interaction artifacts: ${artifactRoot}\n`);
  throw error;
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (succeeded) rmSync(artifactRoot, { recursive: true, force: true });
}
