#!/usr/bin/env node

// Deterministic browser/mock frames for the pre-Workbench startup ledger.
// The browser fixture is held at command boundaries by mock.ts through the
// `startup_frame` query parameter. This module deliberately uses the built
// `desktop/dist` output and a locally installed Chromium; it never downloads a
// browser or manufactures timer-driven stage transitions.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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

export const STARTUP_BROWSER_STATES = Object.freeze([
  "runtime-active",
  "workspace-active",
  "project-active",
  "project-attention",
]);

export const STARTUP_BROWSER_VIEWPORTS = Object.freeze([
  Object.freeze({ width: 1920, height: 1080 }),
  Object.freeze({ width: 1024, height: 680 }),
  Object.freeze({ width: 900, height: 700 }),
  Object.freeze({ width: 720, height: 450 }),
]);

function frameName(state, viewport, media = "standard") {
  const suffix = media === "standard" ? "" : `-${media}`;
  return `s0-startup-${state}-${viewport.width}x${viewport.height}${suffix}`;
}

const standardFrames = STARTUP_BROWSER_STATES.flatMap((state) =>
  STARTUP_BROWSER_VIEWPORTS.map((viewport) => {
    const fullScrollablePage = state === "project-attention"
      && viewport.width === 720
      && viewport.height === 450;
    return Object.freeze({
      state,
      viewport,
      media: "standard",
      capture_mode: fullScrollablePage ? "full_scrollable_page" : "viewport",
      name: frameName(state, viewport),
      evidence_class: "browser_mock",
    });
  }),
);
const activeMediaViewport = STARTUP_BROWSER_VIEWPORTS[1];

export const STARTUP_BROWSER_FRAME_MATRIX = Object.freeze([
  ...standardFrames,
  Object.freeze({
    state: "project-active",
    viewport: activeMediaViewport,
    media: "reduced-motion",
    capture_mode: "viewport",
    name: frameName("project-active", activeMediaViewport, "reduced-motion"),
    evidence_class: "browser_mock",
  }),
  Object.freeze({
    state: "project-active",
    viewport: activeMediaViewport,
    media: "forced-colors",
    capture_mode: "viewport",
    name: frameName("project-active", activeMediaViewport, "forced-colors"),
    evidence_class: "browser_mock",
  }),
]);

export function validateStartupBrowserFrameMatrix(
  matrix = STARTUP_BROWSER_FRAME_MATRIX,
) {
  assert.equal(matrix.length, 18, "startup browser acceptance requires exactly 18 frames");
  assert.equal(new Set(matrix.map((frame) => frame.name)).size, 18, "startup frame names must be unique");
  for (const state of STARTUP_BROWSER_STATES) {
    const standard = matrix.filter((frame) => frame.state === state && frame.media === "standard");
    assert.deepEqual(
      standard.map((frame) => `${frame.viewport.width}x${frame.viewport.height}`),
      STARTUP_BROWSER_VIEWPORTS.map((viewport) => `${viewport.width}x${viewport.height}`),
      `${state} must cover every canonical startup viewport in order`,
    );
  }
  assert.deepEqual(
    matrix.filter((frame) => frame.media !== "standard").map((frame) => ({
      state: frame.state,
      viewport: `${frame.viewport.width}x${frame.viewport.height}`,
      media: frame.media,
    })),
    [
      { state: "project-active", viewport: "1024x680", media: "reduced-motion" },
      { state: "project-active", viewport: "1024x680", media: "forced-colors" },
    ],
  );
  assert.ok(matrix.every((frame) => frame.evidence_class === "browser_mock"));
  assert.deepEqual(
    matrix.filter((frame) => frame.capture_mode === "full_scrollable_page").map((frame) => frame.name),
    ["s0-startup-project-attention-720x450"],
    "only the scrollable 720x450 attention frame may capture the full page",
  );
  assert.equal(matrix.filter((frame) => frame.capture_mode === "viewport").length, 17);
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

export const STARTUP_BROWSER_EXPECTATIONS = Object.freeze({
  "runtime-active": Object.freeze({
    states: ["active", "waiting", "waiting"],
    stateText: ["In progress", "Waiting", "Waiting"],
    summary: "Checking your R installation.",
    details: [null, null, null],
  }),
  "workspace-active": Object.freeze({
    states: ["complete", "active", "waiting"],
    stateText: ["Complete", "In progress", "Waiting"],
    summary: "Starting Workspace R.",
    details: ["R version: 4.5.1", null, null],
  }),
  "project-active": Object.freeze({
    states: ["complete", "complete", "active"],
    stateText: ["Complete", "Complete", "In progress"],
    summary: "Restoring your project.",
    details: ["R version: 4.5.1", "Workspace R is ready · Process 4242", null],
  }),
  "project-attention": Object.freeze({
    states: ["complete", "complete", "attention"],
    stateText: ["Complete", "Complete", "Needs attention"],
    summary: "Project needs attention.",
    details: ["R version: 4.5.1", "Workspace R is ready · Process 4242", null],
  }),
});

export const STARTUP_BROWSER_LABELS = Object.freeze(["R runtime", "Workspace R", "Project"]);

async function inspectNarrowReachability(page, frame) {
  if (frame.viewport.width !== 720 || frame.viewport.height !== 450) return null;
  const lastRow = page.locator(".rho-startup-step").last();
  await lastRow.scrollIntoViewIfNeeded();
  assert.equal(await lastRow.isVisible(), true, "the last startup row must remain scroll-reachable");

  const actions = page.locator(".rho-startup-actions button");
  const actionCount = await actions.count();
  const focusedActions = [];
  for (let index = 0; index < actionCount; index += 1) {
    const action = actions.nth(index);
    await action.scrollIntoViewIfNeeded();
    assert.equal(await action.isVisible(), true, "narrow startup recovery actions must remain visible");
    assert.equal(await action.isEnabled(), true, "narrow startup recovery actions must remain enabled");
    const box = await action.boundingBox();
    assert.ok(
      box != null && box.y >= 0 && box.y + box.height <= frame.viewport.height,
      "narrow startup recovery actions must scroll into the 720x450 viewport",
    );
    await action.focus();
    assert.equal(await action.evaluate((element) => document.activeElement === element), true);
    focusedActions.push((await action.textContent())?.trim() ?? "");
  }

  const scrolling = await page.evaluate(() => {
    const candidates = [document.querySelector(".rho-startup-shell"), document.scrollingElement]
      .filter((candidate) => candidate != null);
    const results = candidates.map((candidate) => {
      const maxScroll = Math.max(0, candidate.scrollHeight - candidate.clientHeight);
      candidate.scrollTop = maxScroll;
      return {
        maxScroll,
        reachedBottom: Math.abs(candidate.scrollTop - maxScroll) <= 2,
      };
    });
    for (const candidate of candidates) candidate.scrollTop = 0;
    window.scrollTo(0, 0);
    return results;
  });
  assert.ok(scrolling.every((candidate) => candidate.reachedBottom), "narrow startup content must scroll to its end");
  assert.equal(actionCount, frame.state === "project-attention" ? 2 : 0);
  if (frame.state === "project-attention") {
    assert.ok(
      scrolling.some((candidate) => candidate.maxScroll > 0),
      "the 720x450 attention layout must remain a genuinely scrollable single column",
    );
    assert.deepEqual(focusedActions, ["Choose project", "Retry"]);
    await page.locator(".rho-startup-attention h2").focus();
  }
  return { scrolling, focusedActions };
}

async function inspectStartupFrame(page, frame) {
  const expected = STARTUP_BROWSER_EXPECTATIONS[frame.state];
  await page.locator(".rho-startup-ledger").waitFor({ timeout: 15_000 });
  await page.waitForFunction((states) => {
    const rows = [...document.querySelectorAll(".rho-startup-step")];
    return rows.length === states.length
      && rows.every((row, index) => row.getAttribute("data-state") === states[index]);
  }, expected.states, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);

  const result = await page.evaluate(({ state, media }) => {
    const isVisible = (element) => {
      if (element == null) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const rows = [...document.querySelectorAll(".rho-startup-step")];
    const root = document.documentElement;
    const wordmarks = [...document.querySelectorAll(".rho-startup-wordmark")];
    const activeRows = rows.filter((row) => row.getAttribute("aria-current") === "step");
    const alert = document.querySelector(".rho-startup-attention[role='alert']");
    const actionLabels = alert == null
      ? []
      : [...alert.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");
    const attentionHeading = alert?.querySelector("h2") ?? null;
    const marker = document.querySelector(".rho-startup-step[data-state='active'] .rho-startup-step-marker");
    return {
      title: document.querySelector("h1")?.textContent?.trim() ?? "",
      wordmarks: wordmarks.map((wordmark) => wordmark.textContent?.trim() ?? ""),
      rowStates: rows.map((row) => row.getAttribute("data-state")),
      rowLabels: rows.map((row) => row.querySelector(".rho-startup-step-label")?.textContent?.trim() ?? ""),
      rowLabelsVisible: rows.map((row) => isVisible(row.querySelector(".rho-startup-step-label"))),
      rowStateText: rows.map((row) => row.querySelector(".rho-startup-step-state")?.textContent?.trim() ?? ""),
      rowStateTextVisible: rows.map((row) => isVisible(row.querySelector(".rho-startup-step-state"))),
      rowDetails: rows.map((row) => row.querySelector(".rho-startup-step-detail")?.textContent?.trim() ?? null),
      rowDetailsVisible: rows.map((row) => {
        const detail = row.querySelector(".rho-startup-step-detail");
        return detail == null ? null : isVisible(detail);
      }),
      summary: document.querySelector(".rho-startup-summary")?.textContent?.trim() ?? "",
      summaryVisible: isVisible(document.querySelector(".rho-startup-summary")),
      activeRows: activeRows.length,
      alert: alert != null,
      actionLabels,
      attentionFocused: attentionHeading != null && document.activeElement === attentionHeading,
      text: document.body.textContent ?? "",
      horizontalOverflow: root.scrollWidth - window.innerWidth,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      forcedColors: matchMedia("(forced-colors: active)").matches,
      activeAnimation: marker == null ? null : getComputedStyle(marker, "::after").animationName,
      expectedAttention: state === "project-attention",
      media,
    };
  }, { state: frame.state, media: frame.media });

  assert.equal(result.title, "Opening your workspace");
  assert.deepEqual(result.wordmarks, ["Rho"], "startup shell must render one intact Rho wordmark");
  assert.deepEqual(result.rowStates, expected.states);
  assert.deepEqual(result.rowLabels, STARTUP_BROWSER_LABELS);
  assert.deepEqual(result.rowLabelsVisible, [true, true, true]);
  assert.deepEqual(result.rowStateText, expected.stateText);
  assert.deepEqual(result.rowStateTextVisible, [true, true, true]);
  assert.equal(result.summary, expected.summary);
  assert.equal(result.summaryVisible, true);
  assert.deepEqual(result.rowDetails, expected.details);
  assert.ok(result.rowDetailsVisible.every((visible) => visible == null || visible));
  assert.equal(result.rowDetails[2], null, "active/attention Project must not fabricate a completed project fact");
  assert.equal(result.activeRows, frame.state === "project-attention" ? 0 : 1);
  assert.equal(result.alert, frame.state === "project-attention");
  if (frame.state === "project-attention") {
    assert.deepEqual(result.actionLabels, ["Choose project", "Retry"]);
    assert.equal(result.attentionFocused, true, "new startup attention must receive focus once");
  }
  assert.doesNotMatch(result.text, /RRho|Surface|\bETA\b|estimated|remaining|\d+\s*%/i);
  assert.ok(result.horizontalOverflow <= 2, `startup frame overflowed by ${result.horizontalOverflow}px`);
  if (frame.media === "reduced-motion") {
    assert.equal(result.reducedMotion, true);
    assert.equal(result.activeAnimation, "none");
  }
  if (frame.media === "forced-colors") assert.equal(result.forcedColors, true);
  return { ...result, narrow: await inspectNarrowReachability(page, frame) };
}

function frameCriteria(frame) {
  return [
    `${frame.viewport.width}×${frame.viewport.height} 下三阶段启动台账完整可读，当前阶段与已完成事实层级清楚`,
    "只显示一个 Rho 字标；无 RRho、Surface、百分比、ETA、重叠或页级横向滚动",
    frame.state === "project-attention"
      ? "Project 失败保留 R runtime 与 Workspace R 已完成事实，Choose project 与 Retry 操作清楚可达"
      : "活动阶段由命令边界固定，不依赖计时器轮换或伪造完成状态",
    frame.media === "reduced-motion"
      ? "reduced-motion 下活动标记不播放动画且状态仍可辨认"
      : frame.media === "forced-colors"
        ? "forced-colors 下台账、焦点和状态边界仍可辨认"
        : "窗口收窄时阅读顺序、状态标签和长事实自然回流",
    frame.capture_mode === "full_scrollable_page"
      ? "逻辑 viewport 仍为 720×450；本 PNG 是完整纵向滚动页证据，恢复按钮必须在未压缩文字或 targets 的单列布局中完整出现"
      : "本 PNG 保持该逻辑 viewport 的首屏裁切，不冒充完整滚动页",
  ];
}

export async function captureStartupBrowserFrames({
  output,
  onRecord = () => undefined,
  distRoot = outputRoot,
  expectedBuildId = null,
  expectedDistIdentity = null,
} = {}) {
  validateStartupBrowserFrameMatrix();
  if (typeof output !== "string" || output.length === 0) throw new Error("startup browser output is required");
  if (!fs.existsSync(path.join(distRoot, "index.html"))) {
    throw new Error(`built RSR frontend is missing: ${path.join(distRoot, "index.html")}`);
  }
  assertCollectorOutputOpen(output);
  const distBuildId = readFrontendBuildId(distRoot);
  const distIdentity = readDirectoryIdentity(distRoot);
  if (expectedDistIdentity != null) {
    assertDirectoryIdentity(expectedDistIdentity, distIdentity, "startup browser dist bytes");
  }
  const currentSourceBuildId = currentSourceFrontendBuildId(repositoryRoot);
  const boundBuildId = expectedBuildId ?? currentSourceBuildId;
  assertFrontendBuildId(boundBuildId, currentSourceBuildId, "startup browser current source");
  assertFrontendBuildId(boundBuildId, distBuildId, "startup browser dist");
  const screenshots = path.join(output, "screenshots");
  ensureSecureDirectory(screenshots, { create: true });
  const server = staticServer(distRoot);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("startup browser server has no port");

  let browser = null;
  const records = [];
  try {
    browser = await launchSystemChromium();
    for (const frame of STARTUP_BROWSER_FRAME_MATRIX) {
      const context = await browser.newContext({
        viewport: frame.viewport,
        deviceScaleFactor: 1,
        colorScheme: "light",
        reducedMotion: frame.media === "reduced-motion" ? "reduce" : "no-preference",
        forcedColors: frame.media === "forced-colors" ? "active" : "none",
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
        scenario: "s0",
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
          startup_frame: frame.state,
          viewport: frame.viewport,
          media: frame.media,
          capture_mode: frame.capture_mode,
          capture_note: frame.capture_mode === "full_scrollable_page"
            ? "Logical viewport is 720x450; PNG captures the complete vertical scrollable page."
            : "PNG captures the logical viewport only.",
          source: "desktop/dist browser mock",
          frontend_build_id: boundBuildId,
          dist_identity_start: distIdentity,
        },
      };
      try {
        const query = new URLSearchParams({ startup_frame: frame.state });
        await page.goto(`http://127.0.0.1:${address.port}/?${query}`, { waitUntil: "domcontentloaded" });
        const renderedBuildId = await page.locator("html").getAttribute("data-rsr-build-id");
        assertFrontendBuildId(boundBuildId, renderedBuildId, `${frame.name} browser document`);
        record.detail.rendered_frontend_build_id = renderedBuildId;
        record.detail.assertions = await inspectStartupFrame(page, frame);
        if (browserErrors.length > 0) throw new Error(`browser emitted errors: ${browserErrors.join(" | ")}`);
      } catch (error) {
        record.deterministic_status = "FAIL";
        record.status = "FAIL";
        record.error = error instanceof Error ? error.message : String(error);
      }
      try {
        const screenshotBytes = await page.screenshot({
          animations: "disabled",
          fullPage: frame.capture_mode === "full_scrollable_page",
        });
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
    "startup browser final source",
  );
  assertFrontendBuildId(
    boundBuildId,
    readFrontendBuildId(distRoot),
    "startup browser final dist",
  );
  const finalDistIdentity = readDirectoryIdentity(distRoot);
  assertDirectoryIdentity(distIdentity, finalDistIdentity, "startup browser final dist bytes");
  for (const record of records) record.detail.dist_identity_final = finalDistIdentity;
  const failed = records.filter((record) => record.status === "FAIL");
  if (failed.length > 0) {
    throw new Error(`startup browser acceptance failed for ${failed.map((record) => record.name).join(", ")}`);
  }
  return records;
}

async function main() {
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex < 0 || process.argv[outputIndex + 1] == null) {
    throw new Error("usage: startup-browser.mjs --output <new-directory>");
  }
  const output = path.resolve(process.argv[outputIndex + 1]);
  if (fs.existsSync(output)) {
    throw new Error(`startup browser output already exists; evidence is immutable: ${output}`);
  }
  const expectedBuildId = currentSourceFrontendBuildId(repositoryRoot);
  assertFrontendBuildId(expectedBuildId, readFrontendBuildId(outputRoot), "startup browser dist");
  const expectedDistIdentity = readDirectoryIdentity(outputRoot);
  createExclusiveEvidenceOutput(output);
  const records = await captureStartupBrowserFrames({ output, expectedBuildId, expectedDistIdentity });
  writeExclusiveArtifact(
    path.join(output, "startup-browser-evidence.json"),
    `${JSON.stringify(records, null, 2)}\n`,
  );
  process.stdout.write(`Captured ${records.length} startup browser/mock frames in ${output}\n`);
}

const invokedPath = process.argv[1] == null ? null : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`startup-browser: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
