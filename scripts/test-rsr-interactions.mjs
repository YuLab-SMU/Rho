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

async function openSurface(page, surfaceId) {
  let compose = page.getByRole("button", { name: "Compose" });
  if (await compose.count() === 0) {
    const rhoMenu = page.locator(".rho-rho-menu");
    const rhoMenuTrigger = page.locator('[aria-label="Rho menu"]');
    const customizeToolbar = page.getByRole("button", { name: "Customize toolbar…" });
    for (let attempt = 0; attempt < 4 && !await customizeToolbar.isVisible(); attempt += 1) {
      if (await rhoMenu.evaluate((menu) => !(menu instanceof HTMLDetailsElement) || !menu.open)) {
        await rhoMenuTrigger.click();
      }
      await page.waitForTimeout(100);
    }
    if (!await customizeToolbar.isVisible()) {
      const state = await page.evaluate(() => {
        const menu = document.querySelector(".rho-rho-menu");
        const panel = document.querySelector(".rho-rho-menu-panel");
        return {
          open: menu?.hasAttribute("open") ?? false,
          panelDisplay: panel == null ? null : getComputedStyle(panel).display,
          panelRects: panel?.getClientRects().length ?? 0,
          panelText: panel?.textContent ?? null,
        };
      });
      throw new Error(`Rho menu did not expose toolbar customization: ${JSON.stringify(state)}`);
    }
    await customizeToolbar.click();
    const dialog = page.getByRole("dialog", { name: "Toolbar components" });
    await dialog.getByRole("checkbox", { name: "Compose" }).check();
    await dialog.getByRole("button", { name: "Done" }).click();
    compose = page.getByRole("button", { name: "Compose" });
  }
  await compose.click();
  const factory = page.locator(`[data-surface-factory="${surfaceId}"]`);
  await factory.getByRole("button", { name: "Open", exact: true }).click();
  await page.locator(`article[data-surface-id="${surfaceId}"]`).waitFor();
}

async function openHistory(page) {
  await openSurface(page, "rho.runs");
}

async function assertDockviewTitleHierarchy(page, surfaceIds) {
  await page.waitForFunction((ids) => ids.every((surfaceId) => {
    const surface = document.querySelector(`article[data-surface-id="${surfaceId}"]`);
    if (!(surface instanceof HTMLElement) || surface.getClientRects().length === 0) return false;
    const instanceId = surface.dataset.instanceId;
    const host = [...document.querySelectorAll("[data-rho-surface-actions-host]")]
      .find((candidate) => candidate.getAttribute("data-rho-surface-actions-host") === instanceId);
    return host?.querySelector("[aria-label^='More actions for']") != null;
  }), surfaceIds);
  const states = await page.evaluate((ids) => ids.map((surfaceId) => {
    const surface = document.querySelector(`article[data-surface-id="${surfaceId}"]`);
    if (!(surface instanceof HTMLElement)) throw new Error(`Missing ${surfaceId}`);
    const instanceId = surface.dataset.instanceId;
    const tab = document.querySelector(`[data-rho-tab-instance-id="${instanceId}"]`);
    const tabTitle = tab?.querySelector(".dv-default-tab-content");
    const header = tab?.closest(".dv-tabs-and-actions-container");
    const host = [...document.querySelectorAll("[data-rho-surface-actions-host]")]
      .find((candidate) => candidate.getAttribute("data-rho-surface-actions-host") === instanceId);
    const action = host?.querySelector("[aria-label^='More actions for']");
    if (!(tab instanceof HTMLElement) || !(tabTitle instanceof HTMLElement)
        || !(header instanceof HTMLElement) || !(action instanceof HTMLElement)) {
      throw new Error(`Incomplete Dockview title hierarchy for ${surfaceId}`);
    }
    const titleRect = tabTitle.getBoundingClientRect();
    const actionRect = action.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    const hit = document.elementFromPoint(
      actionRect.left + actionRect.width / 2,
      actionRect.top + actionRect.height / 2,
    );
    return {
      surfaceId,
      expectedTitle: (surface.getAttribute("aria-label") ?? "").replace(/ component$/, ""),
      tabTitle: tabTitle.textContent?.trim() ?? "",
      innerChromeCount: surface.querySelectorAll(":scope > .rho-surface-chrome").length,
      actionCount: host?.querySelectorAll("[aria-label^='More actions for']").length ?? 0,
      closeCount: tab.closest(".dv-tab")?.querySelectorAll("[aria-label='Close tab']").length ?? 0,
      headerOverflow: header.scrollWidth - header.clientWidth,
      titleActionOverlap: titleRect.right > actionRect.left && actionRect.right > titleRect.left,
      actionContained: actionRect.left >= headerRect.left - 1 && actionRect.right <= headerRect.right + 1
        && actionRect.top >= headerRect.top - 1 && actionRect.bottom <= headerRect.bottom + 1,
      actionHit: hit != null && action.contains(hit),
      contentFollowsHeader: surfaceRect.top >= headerRect.bottom - 2,
    };
  }), surfaceIds);
  for (const state of states) {
    const titleMatches = state.tabTitle === state.expectedTitle
      || state.tabTitle.startsWith(`${state.expectedTitle} · `);
    if (!titleMatches || state.innerChromeCount !== 0
        || state.actionCount !== 1 || state.closeCount !== 1 || state.headerOverflow > 2
        || state.titleActionOverlap || !state.actionContained || !state.actionHit
        || !state.contentFollowsHeader) {
      throw new Error(`Dockview title hierarchy regressed: ${JSON.stringify(state)}`);
    }
  }
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
    await assertDockviewTitleHierarchy(page, ["rho.navigator", "rho.console", "rho.file-source"]);
    const studioChoice = page.getByRole("button", { name: "Studio", exact: true });
    const studioCaption = studioChoice.locator("span");
    if (await studioCaption.evaluate((element) => getComputedStyle(element).opacity) !== "0") {
      throw new Error("side-rail captions were not hidden by default");
    }
    await studioChoice.hover();
    await page.waitForFunction(() => {
      const caption = document.querySelector('.rho-mode-switch button[title="Studio mode"] span');
      return caption != null && getComputedStyle(caption).opacity === "1";
    });
    await page.getByRole("button", { name: "Rho menu", exact: true }).click();
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
    const navigatorToolsTrigger = page.getByRole("button", { name: "Tools for Navigator" });
    await navigatorToolsTrigger.click();
    const navigatorTools = page.getByRole("dialog", { name: "Tools for Navigator" });
    await navigatorTools.getByRole("button", { name: "Focus component" }).waitFor();
    await navigatorTools.getByText("Search the current project tree").waitFor();
    await page.keyboard.press("Escape");
    const filesTab = navigator.getByRole("tab", { name: "Files", exact: true });
    await filesTab.focus();
    await filesTab.press("ArrowRight");
    await navigator.getByRole("tab", { name: "History", exact: true })
      .waitFor({ state: "visible" });
    if (await navigator.getByRole("tab", { name: "History", exact: true }).getAttribute("aria-selected") !== "true") {
      throw new Error("Navigator ArrowRight did not activate History");
    }
    if (await navigator.getByRole("tab", { name: "Artifacts", exact: true }).count() !== 0) {
      throw new Error("Navigator still exposed the retired Artifacts section");
    }
    const recentOutputs = navigator.locator(".rho-navigator-recent");
    if (!await recentOutputs.evaluate((element) => element.open)) {
      await recentOutputs.locator("summary").click();
    }
    if (!await recentOutputs.evaluate((element) => element.open)) {
      throw new Error("Navigator recent outputs did not remain expanded after activation");
    }
    await navigator.getByRole("button", { name: "Open Plots" }).click();
    await page.locator("article[data-surface-id='rho.plots']").waitFor();
    if (await page.locator("article[data-surface-id='rho.artifacts']").count() !== 0) {
      throw new Error("Navigator recent outputs resurrected the retired Artifacts Surface");
    }
    if (await page.getByRole("button", { name: "Open Artifact", exact: true }).count() !== 0) {
      throw new Error("Workbench still exposed an action targeting the retired Artifacts Surface");
    }

    const plugin = page.locator('article[data-surface-id="ui.surface.differential-expression"]');
    await plugin.waitFor();
    const pluginInstanceId = await plugin.getAttribute("data-instance-id");
    const pluginTab = page.locator(`[data-rho-tab-instance-id="${pluginInstanceId}"]`);
    if ((await pluginTab.textContent())?.trim() !== "Differential expression"
        || await plugin.locator(":scope > .rho-surface-chrome").count() !== 0) {
      throw new Error("project component exposed its technical Surface identifier");
    }
    await plugin.getByRole("tab", { name: "Configure", exact: true }).click();
    await plugin.getByLabel("Contrast").waitFor();

    await page.getByRole("tab", { name: "Environment", exact: true }).click();
    const environment = page.locator('article[data-surface-id="rho.environment"]');
    await page.getByRole("button", { name: "More actions for Environment" }).click();
    await page.getByRole("dialog", { name: "More actions for Environment" })
      .getByRole("button", { name: "Activity", exact: true })
      .click();
    await environment.getByText("Operation activity", { exact: true }).waitFor();
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
    const consolePresentation = await consoleSurface.evaluate((surface) => {
      const entries = [...surface.querySelectorAll(".rho-console-entry")];
      const command = entries[0]?.querySelector(".rho-console-command");
      const results = entries[0]?.querySelector(":scope > .rho-console-results");
      const result = results?.querySelector(".rho-console-result");
      if (!(command instanceof HTMLElement) || !(results instanceof HTMLElement)
          || !(result instanceof HTMLElement)) throw new Error("Console command/output fixture is incomplete");
      const commandStyle = getComputedStyle(command);
      const entryStyle = getComputedStyle(entries[0]);
      const resultStyle = getComputedStyle(result);
      const commandRect = command.getBoundingClientRect();
      const resultsRect = results.getBoundingClientRect();
      return {
        entryCount: entries.length,
        groupStarts: entries.map((entry) => entry.getAttribute("data-runtime-group-start")),
        workspaceLabels: entries.flatMap((entry) =>
          [...entry.querySelectorAll(".rho-console-workspace-label")]
            .map((label) => label.textContent?.trim() ?? "")
        ),
        commandBackground: commandStyle.backgroundColor,
        entryBackground: entryStyle.backgroundColor,
        commandBorderWidth: Number.parseFloat(commandStyle.borderInlineStartWidth),
        commandPadding: Number.parseFloat(commandStyle.paddingInlineStart),
        commandOverflow: command.scrollWidth - command.clientWidth,
        outputGap: resultsRect.top - commandRect.bottom,
        resultBorderWidth: Number.parseFloat(resultStyle.borderLeftWidth),
        resultBorderColor: resultStyle.borderLeftColor,
      };
    });
    if (consolePresentation.entryCount < 2
        || consolePresentation.groupStarts[0] !== "true"
        || consolePresentation.groupStarts[1] !== "false"
        || JSON.stringify(consolePresentation.workspaceLabels) !== JSON.stringify(["Workspace R"])) {
      throw new Error(`Console repeated or lost a consecutive Workspace label: ${JSON.stringify(consolePresentation)}`);
    }
    if (consolePresentation.commandBackground === consolePresentation.entryBackground
        || consolePresentation.commandBorderWidth < 3
        || consolePresentation.commandPadding < 7
        || consolePresentation.commandOverflow > 1
        || consolePresentation.outputGap < 7
        || consolePresentation.resultBorderWidth < 2
        || consolePresentation.resultBorderColor === "rgba(0, 0, 0, 0)") {
      throw new Error(`Console command/output boundary is not visually explicit: ${JSON.stringify(consolePresentation)}`);
    }
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
    await openSurface(page, "rho.plots");
    const plots = page.locator('article[data-surface-id="rho.plots"]');
    const thumbnail = plots.locator("img.rho-domain-output-image").first();
    await thumbnail.waitFor({ state: "visible" });
    await thumbnail.evaluate((image) => {
      if (!(image instanceof HTMLImageElement)) throw new Error("Plot thumbnail is not an image");
      if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) return;
      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("Plot thumbnail did not decode")), 5_000);
        image.addEventListener("load", () => {
          window.clearTimeout(timeout);
          resolve(undefined);
        }, { once: true });
        image.addEventListener("error", () => {
          window.clearTimeout(timeout);
          reject(new Error("Plot thumbnail failed to decode"));
        }, { once: true });
      });
    });
    const plotState = await plots.evaluate((surface) => ({
      text: surface.textContent ?? "",
      sources: [...surface.querySelectorAll("img")].map((image) => image.getAttribute("src") ?? ""),
    }));
    if (plotState.sources.length === 0 || plotState.sources.some((source) => !source.startsWith("data:image/png;base64,"))) {
      throw new Error(`mock Plot thumbnails did not use PNG data URLs: ${JSON.stringify(plotState.sources)}`);
    }
    if (/preview unavailable|payload_json|data_base64|project_root/i.test(plotState.text)) {
      throw new Error("mock Plots exposed a failed preview or raw transport payload");
    }
    await context.close();
  }

  {
    const { context, page } = await openWorkbench();
    await openHistory(page);
    const history = page.locator('article[data-surface-id="rho.runs"]');
    const geometry = await history.evaluate(async (surface) => {
      surface.style.width = "220px";
      surface.style.maxWidth = "220px";
      surface.style.flex = "0 0 220px";
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const toolbar = surface.querySelector(".rho-runtime-history-toolbar");
      const summary = surface.querySelector(".rho-runtime-history-summary");
      const title = summary?.querySelector("strong");
      const subtitle = summary?.querySelector("small");
      const search = toolbar?.querySelector('input[aria-label="Filter History"]');
      const list = surface.querySelector(".rho-runtime-history-list");
      const detail = surface.querySelector(".rho-runtime-history-detail");
      if (!(toolbar instanceof HTMLElement) || !(summary instanceof HTMLElement)
          || !(title instanceof HTMLElement) || !(subtitle instanceof HTMLElement)
          || !(search instanceof HTMLElement) || !(list instanceof HTMLElement)
          || !(detail instanceof HTMLElement)) throw new Error("History narrow-layout fixture is incomplete");
      const fragments = (element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      };
      const toolbarRect = toolbar.getBoundingClientRect();
      const searchRect = search.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      const detailRect = detail.getBoundingClientRect();
      return {
        surfaceWidth: surface.getBoundingClientRect().width,
        toolbarHeight: toolbarRect.height,
        toolbarOverflow: toolbar.scrollWidth - toolbar.clientWidth,
        titleFragments: fragments(title),
        subtitleFragments: fragments(subtitle),
        titleWhiteSpace: getComputedStyle(title).whiteSpace,
        subtitleWhiteSpace: getComputedStyle(subtitle).whiteSpace,
        searchContained: searchRect.left >= toolbarRect.left - 1 && searchRect.right <= toolbarRect.right + 1,
        stackedBody: Math.abs(listRect.left - detailRect.left) <= 1 && detailRect.top >= listRect.bottom - 1,
      };
    });
    if (geometry.surfaceWidth > 222 || geometry.toolbarOverflow > 2 || geometry.toolbarHeight > 140) {
      throw new Error(`narrow History toolbar overflowed or grew vertically: ${JSON.stringify(geometry)}`);
    }
    if (geometry.titleFragments > 1 || geometry.subtitleFragments > 1
        || geometry.titleWhiteSpace !== "nowrap" || geometry.subtitleWhiteSpace !== "nowrap") {
      throw new Error(`narrow History summary wrapped into a text column: ${JSON.stringify(geometry)}`);
    }
    if (!geometry.searchContained || !geometry.stackedBody) {
      throw new Error(`narrow History did not keep its controls and stacked body contained: ${JSON.stringify(geometry)}`);
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
    const narrowSurfaceIds = await page.locator("article[data-surface-id]").evaluateAll((surfaces) => surfaces
      .filter((surface) => surface instanceof HTMLElement && surface.getClientRects().length > 0)
      .map((surface) => surface.getAttribute("data-surface-id"))
      .filter((surfaceId) => ["rho.navigator", "rho.console", "rho.file-source"].includes(surfaceId)));
    if (narrowSurfaceIds.length > 0) await assertDockviewTitleHierarchy(page, narrowSurfaceIds);
    await context.close();
  }

  {
    const { context, page } = await openWorkbench("&vibe=information-flow&agent_runtime=ready", { width: 1440, height: 900 });
    if (await page.getByRole("button", { name: "Environment realtime information" }).count() !== 0) {
      throw new Error("the retired Environment resource taskbar is still mounted");
    }
    const mountedAgentSurface = page.locator("article[data-surface-id='rho.agent']");
    await mountedAgentSurface.waitFor();
    await mountedAgentSurface.getByRole("region", { name: "Agent Environment Doctor" }).waitFor();
    const mountedConversationPicker = mountedAgentSurface.getByLabel(/^Conversation for /);
    if (await mountedConversationPicker.inputValue() !== "agent-conversation:mock-shared") {
      throw new Error("the mounted Agent fixture did not begin on its declared default Conversation");
    }
    const initialAgentEvidence = (await evidence(page)).agentInstances?.find(
      (instance) => instance.id === "instance:agent-shared",
    );
    if (initialAgentEvidence == null) {
      throw new Error("the mounted Agent fixture did not expose exact durable evidence");
    }
    const newConversationButton = mountedAgentSurface.getByRole("button", { name: "New", exact: true });
    await newConversationButton.click();
    await page.waitForFunction(({ generation, instanceId, surfaceRevision }) => {
      const agent = document.querySelector("article[data-surface-id='rho.agent']");
      const picker = agent?.querySelector("select");
      const button = [...(agent?.querySelectorAll("button") ?? [])]
        .find((candidate) => candidate.textContent === "New");
      const hook = document.querySelector("#rsrPreviewEvidence");
      const durable = hook == null
        ? null
        : JSON.parse(hook.textContent ?? "{}").agentInstances?.find(
          (instance) => instance.id === instanceId,
        );
      return picker instanceof HTMLSelectElement
        && picker.value.startsWith("agent-conversation:mock-")
        && picker.value !== "agent-conversation:mock-shared"
        && button instanceof HTMLButtonElement
        && !button.disabled
        && durable?.generation === generation
        && durable?.conversationId === picker.value
        && durable.surfaceRevision > surfaceRevision;
    }, {
      generation: initialAgentEvidence.generation,
      instanceId: initialAgentEvidence.id,
      surfaceRevision: initialAgentEvidence.surfaceRevision,
    });
    if (!await newConversationButton.isEnabled()) {
      throw new Error("the Agent New workflow did not settle its exact durable selection");
    }
    const createdConversationId = await mountedConversationPicker.inputValue();
    if (createdConversationId !== "agent-conversation:mock-2") {
      throw new Error(`Agent New selected ${createdConversationId} instead of its exact returned Conversation`);
    }

    const createdAgentEvidence = (await evidence(page)).agentInstances?.find(
      (instance) => instance.id === initialAgentEvidence.id,
    );
    if (createdAgentEvidence == null) {
      throw new Error("the Agent New workflow did not retain exact durable evidence");
    }
    await mountedConversationPicker.selectOption("");
    await page.waitForFunction(({ generation, instanceId, surfaceRevision }) => {
      const agent = document.querySelector("article[data-surface-id='rho.agent']");
      const picker = agent?.querySelector("select");
      const hook = document.querySelector("#rsrPreviewEvidence");
      const durable = hook == null
        ? null
        : JSON.parse(hook.textContent ?? "{}").agentInstances?.find(
          (instance) => instance.id === instanceId,
        );
      return picker instanceof HTMLSelectElement
        && picker.value === ""
        && durable?.generation === generation
        && durable?.conversationId == null
        && durable.surfaceRevision > surfaceRevision;
    }, {
      generation: createdAgentEvidence.generation,
      instanceId: createdAgentEvidence.id,
      surfaceRevision: createdAgentEvidence.surfaceRevision,
    });

    const emptyAgentEvidence = (await evidence(page)).agentInstances?.find(
      (instance) => instance.id === initialAgentEvidence.id,
    );
    if (emptyAgentEvidence == null) {
      throw new Error("the no-conversation Agent state did not expose durable evidence");
    }
    const sendPrompt = "Trace the exact no-conversation Send identity";
    const agentComposer = mountedAgentSurface.locator(".rho-agent-composer textarea");
    await agentComposer.fill(sendPrompt);
    const sendButton = mountedAgentSurface.getByRole("button", { name: "Send", exact: true });
    await sendButton.click();
    await page.waitForFunction(({ generation, instanceId, surfaceRevision, prompt }) => {
      const agent = document.querySelector("article[data-surface-id='rho.agent']");
      const picker = agent?.querySelector("select");
      const exactTurn = agent?.querySelector("[data-turn-id='agent-turn:mock-2']");
      const newButton = [...(agent?.querySelectorAll("button") ?? [])]
        .find((candidate) => candidate.textContent === "New");
      const hook = document.querySelector("#rsrPreviewEvidence");
      const durable = hook == null
        ? null
        : JSON.parse(hook.textContent ?? "{}").agentInstances?.find(
          (instance) => instance.id === instanceId,
        );
      return picker instanceof HTMLSelectElement
        && picker.value === "agent-conversation:mock-3"
        && durable?.generation === generation
        && durable?.conversationId === picker.value
        && durable.surfaceRevision > surfaceRevision
        && exactTurn instanceof HTMLElement
        && exactTurn.textContent?.includes(prompt)
        && exactTurn.textContent?.includes(`Mock act response for: ${prompt}`)
        && newButton instanceof HTMLButtonElement
        && !newButton.disabled;
    }, {
      generation: emptyAgentEvidence.generation,
      instanceId: emptyAgentEvidence.id,
      surfaceRevision: emptyAgentEvidence.surfaceRevision,
      prompt: sendPrompt,
    });
    if (await sendButton.isEnabled()) {
      throw new Error("the settled Agent Send left an empty composer unexpectedly actionable");
    }
    if (await agentComposer.inputValue() !== "") {
      throw new Error("the no-conversation Agent Send workflow did not clear the admitted composer");
    }
    const mismatchedConversationId = await mountedConversationPicker.inputValue();
    if (mismatchedConversationId !== "agent-conversation:mock-3") {
      throw new Error("the no-conversation Agent Send did not retain its exact returned Conversation");
    }
    if (mismatchedConversationId === "agent-conversation:mock-shared") {
      throw new Error("the mounted Agent fixture did not retain its distinct empty Conversation");
    }

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

    const exactAgentReference = vibeWorkspace.locator("[data-block-id='block:vibe-agent-work']");
    await exactAgentReference.click();
    await page.waitForFunction(() =>
      document.querySelector("[data-block-id='block:vibe-agent-work']")?.getAttribute("data-vibe-active") === "true"
    );

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

    const selectedAgentRecord = vibeWorkspace.locator("button[data-exploration-conversation]", {
      hasText: "Project direction",
    });
    await selectedAgentRecord.click();
    await page.waitForFunction(() => {
      const selected = document.querySelector("button[data-exploration-conversation][aria-current='true']");
      const task = document.querySelector(".rho-vibe-exploration-task");
      return selected?.textContent?.includes("Project direction") === true
        && task?.textContent?.includes("What should we inspect first?") === true;
    });

    const agentRecordTrigger = vibeWorkspace.getByRole("button", {
      name: "在 Vibe 中查看 Agent 记录",
      exact: true,
    });
    await agentRecordTrigger.waitFor();
    await agentRecordTrigger.click();
    const agentRecordHost = vibeWorkspace.locator(".rho-vibe-agent-record-host");
    await agentRecordHost.waitFor();
    if (await page.locator('.rho-statusbar[data-workspace-mode="vibe"]').count() !== 1) {
      throw new Error("opening the local Agent record host switched away from Vibe");
    }
    if (await page.locator(".rho-canvas-studio, article[data-surface-id='rho.agent']").count() !== 0) {
      throw new Error("opening the local Agent record host mounted a trusted Studio Surface");
    }
    await agentRecordHost.getByRole("heading", { name: "Project direction", exact: true }).waitFor();
    await agentRecordHost.getByRole("region", { name: "Agent 收到的任务" })
      .getByText("What should we inspect first?", { exact: true })
      .waitFor();
    await agentRecordHost.getByRole("region", { name: "Agent 最终回复" })
      .getByText("Start with the project structure and runtime health.", { exact: true })
      .waitFor();
    await agentRecordHost.getByText("显示项目最近的 Agent 工作；尚未与当前手稿内容建立精确对应。", { exact: true }).waitFor();
    await agentRecordHost.getByText("文件修改建议", { exact: false }).waitFor();
    const publicRecordText = await agentRecordHost.textContent() ?? "";
    for (const privateText of ["analysis.R", "Reviewed by Agent"]) {
      if (publicRecordText.includes(privateText)) {
        throw new Error(`Vibe Agent public record leaked trusted detail: ${privateText}`);
      }
    }
    for (const trustedAction of [
      "Approve",
      "Reject",
      "Apply",
      "Undo applied edit",
      "Stop",
      "Retry",
      "Context",
      "Send",
    ]) {
      if (await agentRecordHost.getByRole("button", { name: trustedAction, exact: true }).count() !== 0) {
        throw new Error(`Vibe Agent public record exposed trusted action: ${trustedAction}`);
      }
    }
    if (await agentRecordHost.getByText(
      "Auto-approve project tools for this conversation",
      { exact: true },
    ).count() !== 0 || await agentRecordHost.locator("textarea, .rho-agent-approval, .rho-agent-file-proposal").count() !== 0) {
      throw new Error("Vibe Agent public record exposed trusted Agent controls");
    }

    await agentRecordHost.getByRole("button", { name: "在 Studio 中深入检查", exact: true }).click();
    await page.locator('.rho-statusbar[data-workspace-mode="studio"]').waitFor();
    const exactAgentSurface = page.locator("article.rho-surface-focused[data-surface-id='rho.agent']");
    await exactAgentSurface.waitFor();
    const conversationPicker = exactAgentSurface.getByLabel(/^Conversation for /);
    if (await conversationPicker.inputValue() !== "agent-conversation:mock-shared") {
      throw new Error("the explicit Studio handoff did not preserve the exact Agent Conversation");
    }
    if (await exactAgentSurface.getAttribute("data-instance-id") === "instance:agent-shared") {
      throw new Error("the explicit Studio handoff reused the mismatched default Agent instance");
    }
    await exactAgentSurface.locator('[data-turn-id="agent-turn:mock-1"]').waitFor();
    await exactAgentSurface.getByText("What should we inspect first?", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Vibe", exact: true }).click();
    await page.locator('.rho-statusbar[data-workspace-mode="vibe"]').waitFor();
    await vibeWorkspace.waitFor();
    if (await vibeWorkspace.getAttribute("data-layout") !== "focus-exploration") {
      throw new Error("the one-shot Agent return did not restore the exploration focus");
    }
    if (await vibeWorkspace.locator(".rho-vibe-agent-record-host").count() !== 0) {
      throw new Error("the one-shot Agent return remounted the local record host as trusted UI");
    }

    await layerNavigation.getByRole("button", { name: "三联总览", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector(".rho-vibe-workspace")?.getAttribute("data-layout") === "overview"
    );
    const exactArtifactReference = vibeWorkspace.locator("[data-block-id='block:vibe-artifact']");
    await exactArtifactReference.click();
    await page.waitForFunction(() =>
      document.querySelector("[data-block-id='block:vibe-artifact']")?.getAttribute("data-vibe-active") === "true"
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
      const path = statusbar?.querySelector(".rho-statusbar-path");
      return {
        environmentMetrics: statusbar?.querySelectorAll(".rho-environment-taskbar-metric").length ?? 0,
        pathDisplay: path == null ? null : getComputedStyle(path).display,
      };
    });
    if (intermediateStatus.environmentMetrics !== 0 || intermediateStatus.pathDisplay !== "none") {
      throw new Error(`Vibe intermediate status bar retained retired Environment metrics: ${JSON.stringify(intermediateStatus)}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    const verificationLayer = layerNavigation.getByRole("button", { name: "查验与结论", exact: true });
    await verificationLayer.focus();
    await verificationLayer.press("Enter");
    await page.waitForFunction(() =>
      document.querySelector(".rho-vibe-workspace")?.getAttribute("data-layout") === "focus-verification"
    );
    const artifactCandidate = vibeWorkspace.locator(".rho-vibe-verification-artifact");
    await artifactCandidate.waitFor();
    if (await artifactCandidate.getByRole("button", { name: "在 Studio 中查看", exact: true }).count() !== 0) {
      throw new Error("Vibe artifact verification still targeted the retired Artifacts Surface");
    }
    if (await page.locator("[data-surface-id='rho.artifacts']").count() !== 0) {
      throw new Error("Vibe artifact verification mounted the retired Artifacts Surface");
    }
    const openStudio = page.getByRole("button", { name: "Studio", exact: true });
    await openStudio.focus();
    await openStudio.press("Enter");
    await page.locator(".rho-canvas-studio").waitFor();
    if (await page.locator("[data-surface-id='rho.artifacts']").count() !== 0) {
      throw new Error("Studio mode restored a retired Artifacts Surface");
    }
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
    const { context, page } = await openWorkbench("&vibe=information-flow", { width: 720, height: 450 });
    await page.getByRole("button", { name: "Vibe", exact: true }).click();
    const vibeWorkspace = page.locator(".rho-vibe-workspace");
    await vibeWorkspace.waitFor();
    const layerNavigation = vibeWorkspace.getByRole("navigation", { name: "Vibe information layer" });
    await layerNavigation.getByRole("button", { name: "自主探索", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector(".rho-vibe-workspace")?.getAttribute("data-layout") === "focus-exploration"
    );
    await vibeWorkspace.getByRole("button", {
      name: "在 Vibe 中查看 Agent 记录",
      exact: true,
    }).click();
    const agentRecordHost = vibeWorkspace.locator(".rho-vibe-agent-record-host");
    await agentRecordHost.waitFor();
    const narrowOverflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - window.innerWidth,
      host: (() => {
        const host = document.querySelector(".rho-vibe-agent-record-host");
        return host == null ? Number.POSITIVE_INFINITY : host.scrollWidth - host.clientWidth;
      })(),
    }));
    if (narrowOverflow.document > 2 || narrowOverflow.host > 2) {
      throw new Error(`narrow Agent record host overflowed horizontally: ${JSON.stringify(narrowOverflow)}`);
    }
    if (await page.locator('.rho-statusbar[data-workspace-mode="vibe"]').count() !== 1
      || await page.locator(".rho-canvas-studio, article[data-surface-id='rho.agent']").count() !== 0) {
      throw new Error("narrow local Agent record host escaped into Studio");
    }

    const shortHeight = await agentRecordHost.evaluate((host) => {
      const candidates = [
        host,
        host.closest(".rho-vibe-exploration"),
        host.closest(".rho-vibe-region-body"),
        host.closest(".rho-vibe-region"),
        host.closest(".rho-vibe-regions"),
        host.closest(".rho-vibe-workspace"),
      ].filter((candidate) => candidate != null);
      const scrolling = candidates.filter((candidate) => {
        const overflowY = getComputedStyle(candidate).overflowY;
        return /(auto|scroll)/.test(overflowY)
          && candidate.scrollHeight > candidate.clientHeight + 1;
      });
      host.scrollTop = host.scrollHeight;
      const hostRect = host.getBoundingClientRect();
      const footer = host.querySelector(".rho-vibe-agent-record-actions");
      const footerRect = footer?.getBoundingClientRect() ?? null;
      const buttons = [...(footer?.querySelectorAll("button") ?? [])];
      return {
        hostScrollable: host.scrollHeight > host.clientHeight + 1,
        hostScrollTop: host.scrollTop,
        scrollOwnerCount: scrolling.length,
        hostIsOnlyScrollOwner: scrolling.length === 1 && scrolling[0] === host,
        footerVisible: footerRect != null
          && footerRect.top >= Math.max(0, hostRect.top) - 1
          && footerRect.bottom <= Math.min(window.innerHeight, hostRect.bottom) + 1,
        buttonsReachable: buttons.length === 2 && buttons.every((button) => {
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0
            && rect.top >= Math.max(0, hostRect.top) - 1
            && rect.bottom <= Math.min(window.innerHeight, hostRect.bottom) + 1
            && rect.left >= Math.max(0, hostRect.left) - 1
            && rect.right <= Math.min(window.innerWidth, hostRect.right) + 1;
        }),
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    if (!shortHeight.hostScrollable || shortHeight.hostScrollTop <= 0
      || !shortHeight.hostIsOnlyScrollOwner || shortHeight.scrollOwnerCount !== 1) {
      throw new Error(`short-height Agent record host did not keep one scroll owner: ${JSON.stringify(shortHeight)}`);
    }
    if (!shortHeight.footerVisible || !shortHeight.buttonsReachable) {
      throw new Error(`short-height Agent record footer actions were not reachable: ${JSON.stringify(shortHeight)}`);
    }
    if (shortHeight.documentOverflow > 2) {
      throw new Error(`short-height Agent record host introduced ${shortHeight.documentOverflow}px horizontal overflow`);
    }
    const secondaryActions = agentRecordHost.locator(".rho-vibe-agent-record-actions button");
    for (let index = 0; index < await secondaryActions.count(); index += 1) {
      await secondaryActions.nth(index).focus();
      if (!await secondaryActions.nth(index).evaluate((button) => document.activeElement === button)) {
        throw new Error(`short-height Agent record footer action ${index + 1} was not keyboard reachable`);
      }
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
  process.stdout.write("RSR real-interaction acceptance passed: identity, resize, Dockview title hierarchy, Navigator/plugin tabs, retired Artifacts Surface, component modes, Source/Console grouping/History, Plot thumbnails, rejection recovery, docking, narrow layout, and Vibe overview/intermediate-preview/local-Agent-record/focus/narrow editing contracts\n");
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
