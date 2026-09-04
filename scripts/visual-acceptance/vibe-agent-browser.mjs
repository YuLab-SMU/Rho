#!/usr/bin/env node

// Deterministic browser/mock frames for VIBE-1R's exact Agent-record host.
// Fresh real-app acceptance data intentionally has no authoritative
// Conversation/Turn, so exact-record and arbitrary DOM-geometry assertions
// live here and remain labelled browser_mock. This module uses the built
// desktop/dist output and never widens the debug bridge vocabulary.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  VIBE_AGENT_HOST_SELECTORS,
  VIBE_AGENT_HOST_VIEWPORT,
  sameAgentPublicRecord,
} from "./s9-vibe.mjs";
import {
  assertCollectorOutputOpen,
  assertDirectoryIdentity,
  assertFrontendBuildId,
  createExclusiveEvidenceOutput,
  currentSourceFrontendBuildId,
  ensureSecureDirectory,
  readDirectoryIdentity,
  readFrontendBuildId,
  writeExclusiveArtifact,
} from "./helpers.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const requireFromDesktop = createRequire(path.join(repositoryRoot, "desktop", "package.json"));
const outputRoot = path.join(repositoryRoot, "desktop", "dist");

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

export const VIBE_AGENT_BROWSER_FRAME_MATRIX = Object.freeze([
  Object.freeze({
    name: "s9-vibe-agent-record-browser-wide",
    viewport: Object.freeze({ width: 1440, height: 900 }),
    geometry: "wide",
    evidence_class: "browser_mock",
  }),
  Object.freeze({
    name: "s9-vibe-agent-record-browser-narrow-short",
    viewport: VIBE_AGENT_HOST_VIEWPORT,
    geometry: "narrow_short",
    evidence_class: "browser_mock",
  }),
]);

export function validateVibeAgentBrowserFrameMatrix(
  matrix = VIBE_AGENT_BROWSER_FRAME_MATRIX,
) {
  assert.equal(matrix.length, 2, "VIBE-1R browser acceptance requires wide and narrow/short frames");
  assert.equal(new Set(matrix.map((frame) => frame.name)).size, 2, "VIBE-1R frame names must be unique");
  assert.deepEqual(
    matrix.map((frame) => `${frame.viewport.width}x${frame.viewport.height}:${frame.geometry}`),
    ["1440x900:wide", "720x450:narrow_short"],
  );
  assert.ok(matrix.every((frame) => frame.evidence_class === "browser_mock"));
  return matrix;
}

function staticServer(root) {
  return createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const candidate = path.normalize(path.join(root, relativePath));
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    let bytes;
    try {
      bytes = fs.readFileSync(candidate);
    } catch {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentTypes.get(path.extname(candidate)) ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(bytes);
  });
}

async function launchSystemChromium() {
  const { chromium } = requireFromDesktop("playwright-core");
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

function normalizedText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function optionalText(locator) {
  return await locator.count() === 0 ? "" : normalizedText(await locator.textContent());
}

async function sourcePublicRecord(page) {
  const detail = page.locator(VIBE_AGENT_HOST_SELECTORS.detail);
  const status = detail.locator("header [data-status]");
  return {
    heading: normalizedText(await detail.locator("header h3").textContent()),
    statusKind: normalizedText(await status.getAttribute("data-status")),
    statusText: normalizedText(await status.textContent()),
    task: normalizedText(await detail.locator(".rho-vibe-exploration-task p").textContent()),
    latestActivity: normalizedText(await detail.locator(".rho-vibe-exploration-activity > strong").textContent()),
    outcome: normalizedText(await detail.locator(".rho-vibe-exploration-outcome p").textContent()),
    error: await optionalText(detail.locator(".rho-vibe-exploration-turn-error p")),
  };
}

async function hostedPublicRecord(page) {
  const host = page.locator(VIBE_AGENT_HOST_SELECTORS.host);
  const status = host.locator(".rho-vibe-agent-record-host-header [data-status]");
  return {
    heading: normalizedText(await host.locator(".rho-vibe-agent-record-host-header h3").textContent()),
    statusKind: normalizedText(await status.getAttribute("data-status")),
    statusText: normalizedText(await status.textContent()),
    task: normalizedText(await host.locator(".rho-vibe-exploration-task p").textContent()),
    activities: await host.locator(".rho-vibe-agent-record-activity li > strong").allTextContents()
      .then((values) => values.map(normalizedText)),
    outcome: normalizedText(await host.locator(".rho-vibe-exploration-outcome p").textContent()),
    error: await optionalText(host.locator(".rho-vibe-exploration-turn-error p")),
  };
}

export function classifyNarrowVibeScrollOwners(candidates) {
  assert.ok(Array.isArray(candidates), "narrow Vibe scroll candidates are required");
  const documentCandidates = candidates.filter((candidate) => candidate.kind === "document");
  assert.equal(documentCandidates.length, 1, "narrow Vibe must measure one document scrolling element");
  const overflows = (candidate) => candidate.scrollHeight > candidate.clientHeight + 1;
  const scrolling = candidates.filter((candidate) => overflows(candidate)
    && (candidate.kind === "document" || /(auto|scroll)/.test(candidate.overflowY)));
  return {
    pageVerticalOverflow: overflows(documentCandidates[0]),
    scrollOwnerCount: scrolling.length,
    hostIsOnlyScrollOwner: scrolling.length === 1 && scrolling[0].kind === "host",
  };
}

async function inspectNarrowShortGeometry(page, host) {
  const rawGeometry = await host.evaluate((element) => {
    const ancestorChain = [];
    for (let candidate = element; candidate != null; candidate = candidate.parentElement) {
      ancestorChain.push(candidate);
    }
    const descendants = [...element.querySelectorAll("*")];
    const candidates = [...new Set(
      [...ancestorChain, ...descendants, document.scrollingElement].filter((candidate) => candidate != null),
    )];
    element.scrollTop = element.scrollHeight;
    const hostRect = element.getBoundingClientRect();
    const footer = element.querySelector(".rho-vibe-agent-record-actions");
    const footerRect = footer?.getBoundingClientRect() ?? null;
    const buttons = [...(footer?.querySelectorAll("button") ?? [])];
    const withinHostAndViewport = (rect) => rect.width > 0 && rect.height > 0
      && rect.top >= Math.max(0, hostRect.top) - 1
      && rect.bottom <= Math.min(window.innerHeight, hostRect.bottom) + 1
      && rect.left >= Math.max(0, hostRect.left) - 1
      && rect.right <= Math.min(window.innerWidth, hostRect.right) + 1;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentHorizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
      hostHorizontalOverflow: element.scrollWidth - element.clientWidth,
      hostScrollable: element.scrollHeight > element.clientHeight + 1,
      hostScrollTop: element.scrollTop,
      scrollCandidates: candidates.map((candidate) => ({
        kind: candidate === element
          ? "host"
          : candidate === document.scrollingElement
            ? "document"
            : element.contains(candidate)
              ? "descendant"
            : "ancestor",
        overflowY: getComputedStyle(candidate).overflowY,
        scrollHeight: candidate.scrollHeight,
        clientHeight: candidate.clientHeight,
      })),
      footerVisible: footerRect != null && withinHostAndViewport(footerRect),
      buttonsReachable: buttons.length === 2
        && buttons.every((button) => withinHostAndViewport(button.getBoundingClientRect())),
    };
  });
  const geometry = {
    ...rawGeometry,
    ...classifyNarrowVibeScrollOwners(rawGeometry.scrollCandidates),
  };
  assert.deepEqual(geometry.viewport, VIBE_AGENT_HOST_VIEWPORT);
  assert.ok(geometry.documentHorizontalOverflow <= 2, "narrow host must not create page-level horizontal overflow");
  assert.equal(geometry.pageVerticalOverflow, false, "narrow host must not create page-level vertical overflow");
  assert.ok(geometry.hostHorizontalOverflow <= 2, "narrow host must not overflow its own inline axis");
  assert.equal(geometry.hostScrollable, true, "short-height exact record must scroll inside its host");
  assert.ok(geometry.hostScrollTop > 0, "short-height host must reach its footer by local scrolling");
  assert.equal(geometry.scrollOwnerCount, 1, "short-height exact record must have one scroll owner");
  assert.equal(geometry.hostIsOnlyScrollOwner, true, "the Agent host must be the only record scroll owner");
  assert.equal(geometry.footerVisible, true, "short-height host footer must scroll into view");
  assert.equal(geometry.buttonsReachable, true, "short-height Studio secondary actions must be reachable");

  const buttons = host.locator(".rho-vibe-agent-record-actions button");
  const focusedActions = [];
  for (let index = 0; index < await buttons.count(); index += 1) {
    const button = buttons.nth(index);
    await button.focus();
    assert.equal(await button.evaluate((element) => document.activeElement === element), true);
    focusedActions.push(normalizedText(await button.textContent()));
  }
  assert.deepEqual(focusedActions, ["在 Studio 中继续探索", "在 Studio 中深入检查"]);
  return { ...geometry, focusedActions };
}

async function inspectExactAgentHost(page, frame) {
  await page.waitForFunction(() => document.documentElement.dataset.rsrReady === "true", null, {
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Vibe", exact: true }).click();
  const workspace = page.locator(".rho-vibe-workspace");
  await workspace.waitFor({ timeout: 15_000 });
  const exactAgentReference = workspace.locator("[data-block-id='block:vibe-agent-work']");
  await exactAgentReference.click();
  await page.waitForFunction(() =>
    document.querySelector("[data-block-id='block:vibe-agent-work']")?.getAttribute("data-vibe-active") === "true"
  );
  await workspace.getByRole("navigation", { name: "Vibe information layer" })
    .getByRole("button", { name: "自主探索", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector(".rho-vibe-workspace")?.getAttribute("data-layout") === "focus-exploration"
  );

  const source = await sourcePublicRecord(page);
  assert.equal(source.heading, "Project direction");
  assert.equal(source.task, "What should we inspect first?");
  assert.equal(source.outcome, "Start with the project structure and runtime health.");
  assert.ok(source.latestActivity.length > 0, "exact mock Turn must expose a bounded latest public activity");
  assert.equal(await page.locator(".rho-canvas-studio, article[data-surface-id='rho.agent']").count(), 0);

  await workspace.getByRole("button", { name: "在 Vibe 中查看 Agent 记录", exact: true }).click();
  const host = page.locator(VIBE_AGENT_HOST_SELECTORS.host);
  await host.waitFor();
  assert.equal(await page.locator('.rho-statusbar[data-workspace-mode="vibe"]').count(), 1);
  assert.equal(await page.locator(".rho-canvas-studio, article[data-surface-id='rho.agent']").count(), 0);
  assert.equal(await page.locator("article[data-surface-id]").count(), 0, "Vibe exact host must mount zero Studio Surfaces");
  assert.equal(await workspace.getAttribute("data-layout"), "focus-exploration");
  assert.equal(await workspace.getAttribute("data-active-region"), "exploration");

  const projected = await hostedPublicRecord(page);
  assert.equal(sameAgentPublicRecord(source, projected), true, "host must preserve the exact public Conversation/Turn tuple");
  assert.equal(
    normalizedText(await host.locator(".rho-vibe-exploration-link-exact").textContent()),
    "这项 Agent 工作来自手稿中的精确引用。",
  );
  const labels = (await host.locator(".rho-vibe-agent-record-actions button").allTextContents())
    .map(normalizedText);
  assert.deepEqual(labels, ["在 Studio 中继续探索", "在 Studio 中深入检查"]);
  assert.equal(
    await host.locator("textarea, .rho-agent-composer, [data-surface-id]").count(),
    0,
    "read-only Vibe host must omit trusted Agent controls",
  );
  const trustedAgentActions = [
    "Send",
    "Stop",
    "Retry",
  ];
  for (const trustedAction of trustedAgentActions) {
    assert.equal(
      await host.getByRole("button", { name: trustedAction, exact: true }).count(),
      0,
      `read-only Vibe host must omit trusted Agent action ${trustedAction}`,
    );
  }
  const publicText = normalizedText(await host.textContent());
  for (const privateText of [
    "analysis.R",
    "Reviewed by Agent",
    "agent-conversation:mock-shared",
    "agent-turn:mock-1",
  ]) {
    assert.equal(publicText.includes(privateText), false, `public host leaked ${privateText}`);
  }

  await page.evaluate(() => document.fonts.ready);
  const rootGeometry = await page.evaluate(() => ({
    documentHorizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  }));
  assert.ok(rootGeometry.documentHorizontalOverflow <= 2, "exact Agent frame must not create page-level horizontal overflow");
  const narrowShort = frame.geometry === "narrow_short"
    ? await inspectNarrowShortGeometry(page, host)
    : null;
  return {
    source,
    projected,
    active_mode: "vibe",
    layout: "focus-exploration",
    exact_reference: true,
    mounted_studio_surfaces: 0,
    studio_secondary_actions: labels,
    root_geometry: rootGeometry,
    narrow_short: narrowShort,
  };
}

function frameCriteria(frame) {
  return frame.geometry === "wide"
    ? [
        "browser/mock exact fixture 中，host 可见同一 Conversation/Turn 的标题、状态、任务、公开活动和结果；不显示内部 ID、文件路径/内容或可信 Agent controls",
        "primary entry 后仍处于 Vibe、探索层保持 focus，Studio canvas 与全部 Studio Surface 数量为 0",
        "只读边界和 `在 Studio 中继续探索` / `在 Studio 中深入检查` 次级动作清楚可辨；该帧明确标记为 browser_mock，不冒充 real app-data",
        "1440×900 下 exact record 的 header、任务、公开活动、结果与 footer 构成连续科学记录阅读面，无页级横向溢出或卡片墙",
      ]
    : [
        "browser/mock exact fixture 已在 host 内滚到记录尾部；本帧显示同一 Turn 的公开活动、结果与 footer，不显示内部 ID、文件路径/内容或可信 Agent controls",
        "滚动后仍处于 Vibe、探索层保持 focus，Studio canvas 与全部 Studio Surface 数量为 0；exact tuple 由本 gate 的 deterministic detail 与宽屏帧共同复核",
        "只读边界和 `在 Studio 中继续探索` / `在 Studio 中深入检查` 次级动作完整可见；该帧明确标记为 browser_mock，不冒充 real app-data",
        "逻辑 viewport 为 720×450；host 是唯一纵向滚动 owner，页面与 host 均无横向溢出，footer 两个 Studio 次级动作已滚入 viewport 并获得键盘焦点",
      ];
}

export async function captureVibeAgentBrowserFrames({
  output,
  onRecord = () => undefined,
  distRoot = outputRoot,
  expectedBuildId = null,
  expectedDistIdentity = null,
} = {}) {
  validateVibeAgentBrowserFrameMatrix();
  if (typeof output !== "string" || output.length === 0) throw new Error("Vibe Agent browser output is required");
  if (!fs.existsSync(path.join(distRoot, "index.html"))) {
    throw new Error(`built RSR frontend is missing: ${path.join(distRoot, "index.html")}`);
  }
  assertCollectorOutputOpen(output);
  const distBuildId = readFrontendBuildId(distRoot);
  const distIdentity = readDirectoryIdentity(distRoot);
  if (expectedDistIdentity != null) {
    assertDirectoryIdentity(expectedDistIdentity, distIdentity, "Vibe Agent browser dist bytes");
  }
  const currentSourceBuildId = currentSourceFrontendBuildId(repositoryRoot);
  const boundBuildId = expectedBuildId ?? currentSourceBuildId;
  assertFrontendBuildId(boundBuildId, currentSourceBuildId, "Vibe Agent browser current source");
  assertFrontendBuildId(boundBuildId, distBuildId, "Vibe Agent browser dist");
  const screenshots = path.join(output, "screenshots");
  ensureSecureDirectory(screenshots, { create: true });
  const server = staticServer(distRoot);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Vibe Agent browser server has no port");

  let browser = null;
  const records = [];
  try {
    browser = await launchSystemChromium();
    for (const frame of VIBE_AGENT_BROWSER_FRAME_MATRIX) {
      const context = await browser.newContext({
        viewport: frame.viewport,
        deviceScaleFactor: 1,
        colorScheme: "light",
        reducedMotion: "no-preference",
        forcedColors: "none",
        locale: "en-US",
      });
      const page = await context.newPage();
      const browserErrors = [];
      page.on("pageerror", (error) => browserErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") browserErrors.push(message.text());
      });
      const screenshot = path.join(screenshots, `${frame.name}.png`);
      const record = {
        scenario: "s9",
        name: frame.name,
        evidence_class: frame.evidence_class,
        deterministic_status: "PASS",
        screenshot_capture_status: "PENDING",
        visual_status: "PENDING",
        visual_note: null,
        status: "PENDING",
        error: null,
        screenshot: `screenshots/${frame.name}.png`,
        criteria: frameCriteria(frame),
        at: new Date().toISOString(),
        detail: {
          viewport: frame.viewport,
          geometry: frame.geometry,
          source: "desktop/dist browser mock",
          frontend_build_id: boundBuildId,
          dist_identity_start: distIdentity,
          evidence_boundary:
            "exact Conversation/Turn and arbitrary DOM geometry are browser_mock facts; fresh real app-data is reviewed separately",
        },
      };
      try {
        const query = new URLSearchParams({
          project: "/tmp/rho-vibe-agent-browser",
          vibe: "information-flow",
        });
        await page.goto(`http://127.0.0.1:${address.port}/?${query}`, {
          waitUntil: "domcontentloaded",
        });
        const renderedBuildId = await page.locator("html").getAttribute("data-rsr-build-id");
        assertFrontendBuildId(boundBuildId, renderedBuildId, `${frame.name} browser document`);
        record.detail.rendered_frontend_build_id = renderedBuildId;
        record.detail.assertions = await inspectExactAgentHost(page, frame);
        if (browserErrors.length > 0) throw new Error(`browser emitted errors: ${browserErrors.join(" | ")}`);
      } catch (error) {
        record.deterministic_status = "FAIL";
        record.status = "FAIL";
        record.error = error instanceof Error ? error.message : String(error);
      }
      try {
        const screenshotBytes = await page.screenshot({ animations: "disabled" });
        writeExclusiveArtifact(screenshot, screenshotBytes);
        record.screenshot_bytes = screenshotBytes.length;
        record.screenshot_sha256 = createHash("sha256").update(screenshotBytes).digest("hex");
        record.screenshot_capture_status = "PASS";
      } catch (error) {
        record.screenshot_capture_status = "FAIL";
        record.visual_status = "FAIL";
        record.status = "FAIL";
        const message = error instanceof Error ? error.message : String(error);
        record.error = record.error == null ? `screenshot: ${message}` : `${record.error}; screenshot: ${message}`;
      }
      records.push(record);
      onRecord(record);
      await context.close();
    }
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
  assertFrontendBuildId(
    boundBuildId,
    currentSourceFrontendBuildId(repositoryRoot),
    "Vibe Agent browser final source",
  );
  assertFrontendBuildId(
    boundBuildId,
    readFrontendBuildId(distRoot),
    "Vibe Agent browser final dist",
  );
  const finalDistIdentity = readDirectoryIdentity(distRoot);
  assertDirectoryIdentity(distIdentity, finalDistIdentity, "Vibe Agent browser final dist bytes");
  for (const record of records) record.detail.dist_identity_final = finalDistIdentity;
  const failed = records.filter((record) => record.status === "FAIL");
  if (failed.length > 0) {
    throw new Error(`Vibe Agent browser acceptance failed for ${failed.map((record) => record.name).join(", ")}`);
  }
  return records;
}

async function main() {
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex < 0 || process.argv[outputIndex + 1] == null) {
    throw new Error("usage: vibe-agent-browser.mjs --output <new-directory>");
  }
  const output = path.resolve(process.argv[outputIndex + 1]);
  if (fs.existsSync(output)) {
    throw new Error(`Vibe Agent browser output already exists; evidence is immutable: ${output}`);
  }
  const expectedBuildId = currentSourceFrontendBuildId(repositoryRoot);
  assertFrontendBuildId(expectedBuildId, readFrontendBuildId(outputRoot), "Vibe Agent browser dist");
  const expectedDistIdentity = readDirectoryIdentity(outputRoot);
  createExclusiveEvidenceOutput(output);
  const records = await captureVibeAgentBrowserFrames({ output, expectedBuildId, expectedDistIdentity });
  writeExclusiveArtifact(
    path.join(output, "vibe-agent-browser-evidence.json"),
    `${JSON.stringify(records, null, 2)}\n`,
  );
  process.stdout.write(`Captured ${records.length} Vibe Agent browser/mock frames in ${output}\n`);
}

const invokedPath = process.argv[1] == null ? null : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`vibe-agent-browser: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
