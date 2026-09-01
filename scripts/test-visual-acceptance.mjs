#!/usr/bin/env node

// Self-test for the visual acceptance lane. This test never launches the
// application; it covers the harness evidence model, the scenario registry,
// fixture generation equivalence, and the bridge fail-closed contract as
// static source assertions.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVIDENCE_SCHEMA,
  LEGACY_EVIDENCE_SCHEMA,
  SCENARIOS,
  STARTUP_LOG_MAX_BYTES,
  STARTUP_TERMINAL_MESSAGE_PREFIX,
  acceptanceLaunchEnvironment,
  acceptanceMissingCredentialEnvironmentName,
  acquireAppLock,
  acquireRunWriterLock,
  consecutivePngHashesMatch,
  createHermeticAgentConfig,
  dispatchRealDebugAction,
  finalizeStatus,
  assertExecutableIdentity,
  parseStartupJsonl,
  pngSha256,
  readExecutableIdentity,
  readStartupJsonl,
  releaseRunWriterLock,
  reconcileScenarioStatuses,
  readCommittedEvidence,
  refreshLedger,
  releaseAppLock,
  renderReport,
  reviewableFrameProblem,
  runEvidenceClassCheck,
  runForegroundedRealDebugOperation,
  scenarioResults,
  startupRecordTokenIsPresent,
  summarizeEvidence,
  terminalStartupRecord,
  mutateCompletedRun,
} from "./visual-acceptance.mjs";
import {
  STARTUP_BROWSER_FRAME_MATRIX,
  STARTUP_BROWSER_EXPECTATIONS,
  STARTUP_BROWSER_LABELS,
  STARTUP_BROWSER_STATES,
  STARTUP_BROWSER_VIEWPORTS,
  captureStartupBrowserFrames,
  validateStartupBrowserFrameMatrix,
} from "./visual-acceptance/startup-browser.mjs";
import {
  compensatedWindowSize,
  validateAgentComposerGeometry,
  validateNavigatorControlsGeometry,
} from "./visual-acceptance/s0-startup.mjs";
import {
  VIBE_AGENT_HOST_SELECTORS,
  VIBE_AGENT_HOST_VIEWPORT,
  enterVibeAfterProjectSwitch,
  sameAgentPublicRecord,
} from "./visual-acceptance/s9-vibe.mjs";
import {
  acceptedProjectReady,
  assertDirectoryIdentity,
  assertFrontendBuildId,
  createExclusiveEvidenceOutput,
  currentSourceFrontendBuildId,
  ensureSecureDirectory,
  readDirectoryIdentity,
  readFrontendBuildId,
  secureContainedPath,
  writeExclusiveArtifact,
} from "./visual-acceptance/helpers.mjs";
import {
  VIBE_AGENT_BROWSER_FRAME_MATRIX,
  captureVibeAgentBrowserFrames,
  classifyNarrowVibeScrollOwners,
  validateVibeAgentBrowserFrameMatrix,
} from "./visual-acceptance/vibe-agent-browser.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const driverFile = path.join(repositoryRoot, "scripts", "visual-acceptance.mjs");
const canonicalTemporaryRoot = fs.realpathSync(os.tmpdir());

// The real app and every browser/mock collector bind to one deterministic
// desktop/dist identity. Missing, malformed, or mismatched identities fail
// before evidence can be combined.
{
  const temporary = fs.mkdtempSync(path.join(canonicalTemporaryRoot, "rho-frontend-build-id-"));
  try {
    fs.writeFileSync(
      path.join(temporary, "build-identity.json"),
      `${JSON.stringify({ build_id: "0123456789ab" })}\n`,
    );
    assert.equal(readFrontendBuildId(temporary), "0123456789ab");
    assert.equal(
      assertFrontendBuildId("0123456789ab", "0123456789ab", "self-test app"),
      "0123456789ab",
    );
    assert.throws(
      () => assertFrontendBuildId("0123456789ab", "abcdefabcdef", "self-test app"),
      /frontend build identity mismatch.*0123456789ab.*abcdefabcdef/,
    );
    fs.writeFileSync(
      path.join(temporary, "build-identity.json"),
      `${JSON.stringify({ build_id: "not-a-build" })}\n`,
    );
    assert.throws(() => readFrontendBuildId(temporary), /12-character lowercase SHA prefix/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// Browser/mock evidence binds every recursive dist asset byte, not only the
// self-declared build ID. Equal-size replacement and any symlink fail closed.
{
  const temporary = fs.mkdtempSync(path.join(canonicalTemporaryRoot, "rho-dist-byte-identity-"));
  const dist = path.join(temporary, "dist");
  try {
    ensureSecureDirectory(path.join(dist, "assets"), { create: true });
    fs.writeFileSync(path.join(dist, "index.html"), "<html>alpha</html>\n");
    fs.writeFileSync(path.join(dist, "assets", "app.js"), "export const value = 'a';\n");
    const first = readDirectoryIdentity(dist);
    assert.deepEqual(assertDirectoryIdentity(first, readDirectoryIdentity(dist), "self-test dist"), first);
    fs.writeFileSync(path.join(dist, "assets", "app.js"), "export const value = 'b';\n");
    const replaced = readDirectoryIdentity(dist);
    assert.equal(replaced.bytes, first.bytes, "dist tamper fixture preserves total byte count");
    assert.throws(
      () => assertDirectoryIdentity(first, replaced, "self-test dist"),
      /self-test dist changed/,
    );
    fs.symlinkSync(path.join(dist, "index.html"), path.join(dist, "assets", "linked.html"));
    assert.throws(() => readDirectoryIdentity(dist), /must not contain symlinks/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// Evidence roots and descendants are lexical, real directories/files only.
// A symlinked ancestor cannot redirect a run, and a symlinked frame never
// becomes reviewable even when its target has the expected bytes.
{
  const temporary = fs.mkdtempSync(path.join(canonicalTemporaryRoot, "rho-secure-evidence-path-"));
  try {
    const realParent = path.join(temporary, "real-parent");
    fs.mkdirSync(realParent);
    const linkedParent = path.join(temporary, "linked-parent");
    fs.symlinkSync(realParent, linkedParent);
    assert.throws(
      () => createExclusiveEvidenceOutput(path.join(linkedParent, "run")),
      /must be a real directory/,
    );

    const run = path.join(temporary, "run");
    createExclusiveEvidenceOutput(run);
    ensureSecureDirectory(path.join(run, "screenshots"), { create: true });
    const external = path.join(temporary, "external.png");
    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("linked-frame")]);
    fs.writeFileSync(external, png);
    fs.symlinkSync(external, path.join(run, "screenshots", "frame.png"));
    assert.match(
      reviewableFrameProblem(run, {
        screenshot_capture_status: "PASS",
        screenshot_bytes: png.length,
        screenshot_sha256: createHash("sha256").update(png).digest("hex"),
        screenshot: "screenshots/frame.png",
        criteria: ["visible"],
      }),
      /must not contain symlinks/,
    );
    assert.throws(
      () => secureContainedPath(run, path.join(run, "screenshots", "frame.png")),
      /must not contain symlinks/,
    );

    const linkedScreenshotsRun = path.join(temporary, "linked-screenshots-run");
    createExclusiveEvidenceOutput(linkedScreenshotsRun);
    const externalScreenshots = path.join(temporary, "external-screenshots");
    fs.mkdirSync(externalScreenshots);
    fs.writeFileSync(path.join(externalScreenshots, "frame.png"), png);
    fs.symlinkSync(externalScreenshots, path.join(linkedScreenshotsRun, "screenshots"));
    assert.match(
      reviewableFrameProblem(linkedScreenshotsRun, {
        screenshot_capture_status: "PASS",
        screenshot_bytes: png.length,
        screenshot_sha256: createHash("sha256").update(png).digest("hex"),
        screenshot: "screenshots/frame.png",
        criteria: ["visible"],
      }),
      /must be a real directory/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// The mutable target/debug path is evidence only while its exact bytes remain
// the same. Equal-size replacement is still detected by SHA-256.
{
  const temporary = fs.mkdtempSync(path.join(canonicalTemporaryRoot, "rho-app-identity-"));
  const binary = path.join(temporary, "rho-desktop");
  try {
    fs.writeFileSync(binary, Buffer.from("exact-debug-binary-a"));
    const expected = readExecutableIdentity(binary);
    assert.equal(expected.bytes, 20);
    assert.deepEqual(assertExecutableIdentity(expected, readExecutableIdentity(binary)), expected);
    fs.writeFileSync(binary, Buffer.from("exact-debug-binary-b"));
    const replacement = readExecutableIdentity(binary);
    assert.equal(replacement.bytes, expected.bytes);
    assert.throws(
      () => assertExecutableIdentity(expected, replacement, "self-test binary"),
      /self-test binary changed/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// Real-debug DOM actions must never overtake the bounded, fail-closed exact-app
// foreground confirmation. This pure ordering test launches neither app nor
// AppleScript.
{
  const action = { kind: "click", selector: "#navigator-files" };
  const order = [];
  let finishActivation;
  let markActivationStarted;
  const activationFinished = new Promise((resolve) => { finishActivation = resolve; });
  const activationStarted = new Promise((resolve) => { markActivationStarted = resolve; });
  const pending = dispatchRealDebugAction({
    pid: 42,
    action,
    activate: async (pid) => {
      assert.equal(pid, 42);
      order.push("activation-started");
      markActivationStarted();
      await activationFinished;
      order.push("activation-finished");
    },
    command: async (request) => {
      order.push("command");
      return request;
    },
  });

  await activationStarted;
  assert.deepEqual(order, ["activation-started"], "bridge command waits for exact-app activation");
  finishActivation();
  assert.deepEqual(await pending, { command: "act", action });
  assert.deepEqual(
    order,
    ["activation-started", "activation-finished", "command"],
    "activation completes before real-debug action dispatch",
  );

  const gateOrder = [];
  assert.equal(await runForegroundedRealDebugOperation({
    pid: 43,
    activate: async (pid) => gateOrder.push(`activate:${pid}`),
    operation: async () => {
      gateOrder.push("check");
      return "checked";
    },
  }), "checked");
  assert.deepEqual(gateOrder, ["activate:43", "check"]);

  let evidenceActivations = 0;
  assert.equal(await runEvidenceClassCheck({
    evidenceClass: "real_debug_app",
    pid: 44,
    activate: async () => { evidenceActivations += 1; },
    check: async () => "real",
  }), "real");
  assert.equal(evidenceActivations, 1);
  assert.equal(await runEvidenceClassCheck({
    evidenceClass: "browser_mock",
    pid: 44,
    activate: async () => { evidenceActivations += 1; },
    check: async () => "browser",
  }), "browser");
  assert.equal(evidenceActivations, 1, "browser/mock checks never activate the real app");
  await assert.rejects(
    runEvidenceClassCheck({
      evidenceClass: "unknown",
      pid: 44,
      activate: async () => { evidenceActivations += 1; },
      check: async () => "unknown",
    }),
    /unsupported visual evidence class/,
  );

  let rejectedDispatches = 0;
  await assert.rejects(
    dispatchRealDebugAction({
      pid: 45,
      action,
      activate: async () => { throw new Error("foreground denied"); },
      command: async () => {
        rejectedDispatches += 1;
        return null;
      },
    }),
    /foreground denied/,
  );
  assert.equal(rejectedDispatches, 0, "failed foreground confirmation prevents dispatch");
}

// VIBE-1R keeps the exact public Agent record in Vibe without mounting the
// trusted Studio Surface. The browser/mock frame compares this bounded tuple
// and owns arbitrary runtime geometry; fresh real app-data separately proves
// only the honest empty host without widening the debug bridge vocabulary.
{
  validateVibeAgentBrowserFrameMatrix();
  assert.deepEqual(VIBE_AGENT_HOST_VIEWPORT, { width: 720, height: 450 });
  assert.deepEqual(
    VIBE_AGENT_BROWSER_FRAME_MATRIX.map((frame) => ({
      name: frame.name,
      viewport: frame.viewport,
      geometry: frame.geometry,
      evidence_class: frame.evidence_class,
    })),
    [{
      name: "s9-vibe-agent-record-browser-wide",
      viewport: { width: 1440, height: 900 },
      geometry: "wide",
      evidence_class: "browser_mock",
    }, {
      name: "s9-vibe-agent-record-browser-narrow-short",
      viewport: { width: 720, height: 450 },
      geometry: "narrow_short",
      evidence_class: "browser_mock",
    }],
  );
  assert.equal(VIBE_AGENT_HOST_SELECTORS.mountedAgentSurface, '[data-surface-id="rho.agent"]');
  assert.equal(VIBE_AGENT_HOST_SELECTORS.trigger.includes('data-agent-record-trigger="record"'), true);
  assert.equal(VIBE_AGENT_HOST_SELECTORS.startTrigger.includes('data-agent-record-trigger="start"'), true);

  const source = {
    heading: "Inspect runtime health",
    statusKind: "completed",
    statusText: "已完成",
    task: "Inspect the project runtime.",
    latestActivity: "Read runtime snapshot",
    outcome: "Runtime is healthy.",
    error: "",
  };
  const host = {
    heading: "Inspect runtime health",
    statusKind: "completed",
    statusText: "已完成",
    task: "Inspect the project runtime.",
    activities: ["Read project files", "Read runtime snapshot"],
    outcome: "Runtime is healthy.",
    error: "",
  };
  assert.equal(sameAgentPublicRecord(source, host), true, "the same bounded public record is accepted");
  assert.equal(
    sameAgentPublicRecord(source, { ...host, task: "A different Turn task" }),
    false,
    "a different Turn task fails closed",
  );
  assert.equal(
    sameAgentPublicRecord(source, { ...host, activities: ["Read project files"] }),
    false,
    "a changed latest activity fails closed",
  );
  assert.equal(
    sameAgentPublicRecord(source, { ...host, statusKind: "waiting", statusText: "等待你处理" }),
    false,
    "a changed Turn status fails closed",
  );

  const localOnly = classifyNarrowVibeScrollOwners([
    { kind: "host", overflowY: "auto", scrollHeight: 900, clientHeight: 300 },
    { kind: "ancestor", overflowY: "hidden", scrollHeight: 450, clientHeight: 300 },
    { kind: "document", overflowY: "visible", scrollHeight: 450, clientHeight: 450 },
  ]);
  assert.deepEqual(localOnly, {
    pageVerticalOverflow: false,
    scrollOwnerCount: 1,
    hostIsOnlyScrollOwner: true,
  });
  const pageOverflow = classifyNarrowVibeScrollOwners([
    { kind: "host", overflowY: "auto", scrollHeight: 900, clientHeight: 300 },
    { kind: "document", overflowY: "visible", scrollHeight: 452, clientHeight: 450 },
  ]);
  assert.equal(pageOverflow.pageVerticalOverflow, true);
  assert.equal(pageOverflow.scrollOwnerCount, 2, "page overflow is a second vertical scroll owner");
  assert.equal(pageOverflow.hostIsOnlyScrollOwner, false, "page overflow fails the local single-owner contract");
  const canvasOverflow = classifyNarrowVibeScrollOwners([
    { kind: "host", overflowY: "auto", scrollHeight: 900, clientHeight: 300 },
    { kind: "ancestor", overflowY: "auto", scrollHeight: 452, clientHeight: 450 },
    { kind: "document", overflowY: "visible", scrollHeight: 450, clientHeight: 450 },
  ]);
  assert.equal(canvasOverflow.pageVerticalOverflow, false);
  assert.equal(canvasOverflow.scrollOwnerCount, 2, "an overflowing canvas ancestor is a second scroll owner");
  assert.equal(canvasOverflow.hostIsOnlyScrollOwner, false);
  const descendantOverflow = classifyNarrowVibeScrollOwners([
    { kind: "host", overflowY: "auto", scrollHeight: 900, clientHeight: 300 },
    { kind: "descendant", overflowY: "scroll", scrollHeight: 310, clientHeight: 200 },
    { kind: "document", overflowY: "visible", scrollHeight: 450, clientHeight: 450 },
  ]);
  assert.equal(descendantOverflow.scrollOwnerCount, 2, "an overflowing host descendant is a second scroll owner");
  assert.equal(descendantOverflow.hostIsOnlyScrollOwner, false);
}

// S9 must never turn an arbitrary stale mutation into a broad retry, and the
// project helper must match exact normalized paths plus same-root activation.
{
  let calls = 0;
  await assert.rejects(
    () => enterVibeAfterProjectSwitch({
      act: async () => {
        calls += 1;
        throw new Error("surface_request.project_revision has a stale revision");
      },
      ready: async () => ({ activeMode: "studio" }),
    }),
    /stale revision/,
  );
  assert.equal(calls, 1, "S9 issues one set_mode mutation on rejection");

  const ready = (projectPath, projectRevision) => ({
    rsrReady: true,
    projectPath,
    evidence: { projectRevision },
  });
  assert.equal(
    acceptedProjectReady(ready("/a/foo", 7), ready("/b/foo", 8), "/a/foo"),
    false,
    "same basename does not satisfy a different full project path",
  );
  assert.equal(
    acceptedProjectReady(ready("/a/space project", 7), ready("/a/space project/.", 8), "/a/space project"),
    true,
    "normalized exact project paths are accepted",
  );
  assert.equal(
    acceptedProjectReady(ready("/a/foo", 7), ready("/a/foo", 7), "/a/foo"),
    false,
    "same-root activation requires a newer project revision",
  );
  assert.equal(
    acceptedProjectReady(ready("/a/foo", 7), ready("/a/foo", 8), "/a/foo"),
    true,
    "same-root activation accepts a strictly newer project revision",
  );
}

// STARTUP-INFO-1 owns an exact, reviewable browser/mock matrix: four held
// command-bound states at four geometries plus two project-active media modes.
{
  validateStartupBrowserFrameMatrix();
  assert.equal(STARTUP_BROWSER_FRAME_MATRIX.length, 18);
  assert.equal(STARTUP_BROWSER_STATES.length, 4);
  assert.deepEqual(
    STARTUP_BROWSER_VIEWPORTS.map(({ width, height }) => `${width}x${height}`),
    ["1920x1080", "1024x680", "900x700", "720x450"],
  );
  assert.equal(
    STARTUP_BROWSER_FRAME_MATRIX.filter((frame) => frame.evidence_class === "browser_mock").length,
    18,
  );
  assert.deepEqual(
    STARTUP_BROWSER_FRAME_MATRIX.filter((frame) => frame.capture_mode === "full_scrollable_page")
      .map((frame) => ({ name: frame.name, viewport: frame.viewport, media: frame.media })),
    [{
      name: "s0-startup-project-attention-720x450",
      viewport: { width: 720, height: 450 },
      media: "standard",
    }],
    "only the scrollable narrow attention frame records full-page evidence",
  );
  assert.equal(
    STARTUP_BROWSER_FRAME_MATRIX.filter((frame) => frame.capture_mode === "viewport").length,
    17,
  );
  assert.deepEqual(
    STARTUP_BROWSER_FRAME_MATRIX.filter((frame) => frame.media !== "standard")
      .map((frame) => `${frame.state}:${frame.viewport.width}x${frame.viewport.height}:${frame.media}`),
    [
      "project-active:1024x680:reduced-motion",
      "project-active:1024x680:forced-colors",
    ],
  );
  assert.deepEqual(STARTUP_BROWSER_LABELS, ["R runtime", "Workspace R", "Project"]);
  assert.deepEqual(STARTUP_BROWSER_EXPECTATIONS, {
    "runtime-active": {
      states: ["active", "waiting", "waiting"],
      stateText: ["In progress", "Waiting", "Waiting"],
      summary: "Checking your R installation.",
      details: [null, null, null],
    },
    "workspace-active": {
      states: ["complete", "active", "waiting"],
      stateText: ["Complete", "In progress", "Waiting"],
      summary: "Starting Workspace R.",
      details: ["R version: 4.5.1", null, null],
    },
    "project-active": {
      states: ["complete", "complete", "active"],
      stateText: ["Complete", "Complete", "In progress"],
      summary: "Restoring your project.",
      details: ["R version: 4.5.1", "Workspace R is ready · Process 4242", null],
    },
    "project-attention": {
      states: ["complete", "complete", "attention"],
      stateText: ["Complete", "Complete", "Needs attention"],
      summary: "Project needs attention.",
      details: ["R version: 4.5.1", "Workspace R is ready · Process 4242", null],
    },
  });
}

// The real-debug S0 first-view gate must reject the pre-Studio narrow composer
// failure, where text ink escaped individual Ask/Plan/Act cells and the
// textarea collapsed into a near-vertical column even though outer grid boxes
// still reported contained geometry.
{
  const geometry = ({
    clientWidth = 154,
    scrollWidth = clientWidth,
    width = clientWidth,
    height = 30,
    left = 0,
    top = 0,
    overflowX = "visible",
    textOverflow = "clip",
  } = {}) => ({
    client_width: clientWidth,
    client_height: height,
    scroll_width: scrollWidth,
    scroll_height: height,
    computed: {
      display: "block",
      overflow_x: overflowX,
      overflow_y: "visible",
      text_overflow: textOverflow,
      white_space: "normal",
      overflow_wrap: "normal",
      word_break: "normal",
    },
    rect: { left, top, right: left + width, bottom: top + height, width, height },
  });
  const textarea = geometry({ width: 154, height: 60, top: 0 });
  const elements = [
    { text: "", geometry: textarea },
    ...["Review context", "Send", "Ask", "Plan", "Act", "Ask about this project", "DeepSeek V4 Flash"]
      .map((text, index) => ({ text, geometry: geometry({ width: 120, top: 70 + index * 40 }) })),
  ];
  const fixture = {
    page: {
      "HTML document": geometry({ clientWidth: 1024, width: 1024, height: 680 }),
      "document body": geometry({ clientWidth: 1024, width: 1024, height: 680 }),
      "Studio shell": geometry({ clientWidth: 1024, width: 1024, height: 680 }),
    },
    expectedViewport: { width: 1024, height: 680 },
    surface: geometry({ clientWidth: 180, width: 180, height: 536 }),
    composer: geometry({ clientWidth: 170, width: 172, height: 300 }),
    controls: geometry({ clientWidth: 154, width: 154, height: 220 }),
    mode: geometry({ clientWidth: 154, width: 154, height: 36 }),
    textarea,
    elements,
  };
  assert.equal(validateAgentComposerGeometry(fixture).measurableControls, 8);
  assert.throws(
    () => validateAgentComposerGeometry({
      ...fixture,
      elements: fixture.elements.map((element) => element.text === "Ask"
        ? {
            ...element,
            geometry: geometry({ clientWidth: 20, scrollWidth: 48, width: 20, top: element.geometry.rect.top }),
          }
        : element),
    }),
    /visible horizontal content overflow/,
    "an individual visible-overflow mode button fails even when its outer mode grid fits",
  );
  assert.throws(
    () => validateAgentComposerGeometry({
      ...fixture,
      elements: fixture.elements.map((element) => element.text === "Ask"
        ? {
            ...element,
            geometry: geometry({
              clientWidth: 20,
              scrollWidth: 48,
              width: 20,
              top: element.geometry.rect.top,
              overflowX: "visible",
              textOverflow: "ellipsis",
            }),
          }
        : element),
    }),
    /visible horizontal content overflow/,
    "ellipsis without non-visible overflow containment cannot hide overflowing ink",
  );
  const collapsedTextarea = geometry({ clientWidth: 42, width: 42, height: 120, top: 0 });
  assert.throws(
    () => validateAgentComposerGeometry({
      ...fixture,
      textarea: collapsedTextarea,
      elements: [{ text: "", geometry: collapsedTextarea }, ...fixture.elements.slice(1)],
    }),
    /too narrow|narrow column/,
    "the legacy near-vertical textarea fails despite contained outer composer geometry",
  );
  assert.throws(
    () => validateAgentComposerGeometry({
      ...fixture,
      page: {
        ...fixture.page,
        "HTML document": geometry({ clientWidth: 1024, scrollWidth: 1030, width: 1024, height: 680 }),
      },
    }),
    /HTML document overflows horizontally/,
    "page-level horizontal overflow fails closed",
  );
  assert.throws(
    () => validateAgentComposerGeometry({
      ...fixture,
      page: {
        ...fixture.page,
        "HTML document": geometry({ clientWidth: 1449, width: 1449, height: 680 }),
      },
    }),
    /HTML viewport is 1449x680, expected 1024x680/,
    "a restored wide window cannot masquerade as the requested 1024x680 S0 frame",
  );

  const navigatorFixture = {
    surface: geometry({ clientWidth: 124, width: 124, height: 268, top: 32 }),
    header: geometry({ clientWidth: 124, width: 124, height: 32 }),
    navigator: geometry({ clientWidth: 124, width: 124, height: 268, top: 32 }),
    controls: geometry({ clientWidth: 124, width: 124, height: 112, top: 32 }),
    tabs: geometry({ clientWidth: 88, width: 88, height: 76, top: 32 }),
    tabButtons: [
      { label: "Files", geometry: geometry({ clientWidth: 52, width: 52, height: 32, left: 4, top: 36 }) },
      { label: "History", geometry: geometry({ clientWidth: 64, width: 64, height: 32, left: 4, top: 72 }) },
    ],
    searchButton: {
      label: "Search project files",
      geometry: geometry({ clientWidth: 28, width: 28, height: 28, left: 92, top: 74 }),
    },
  };
  assert.equal(validateNavigatorControlsGeometry(navigatorFixture).controls.length, 3);
  assert.throws(
    () => validateNavigatorControlsGeometry({
      ...navigatorFixture,
      tabs: geometry({ clientWidth: 88, scrollWidth: 218, width: 88, height: 40, top: 32 }),
      tabButtons: navigatorFixture.tabButtons.map((button, index) => ({
        ...button,
        geometry: geometry({
          clientWidth: button.geometry.client_width,
          width: button.geometry.rect.width,
          height: 32,
          left: 4 + index * 70,
          top: 36,
        }),
      })),
    }),
    /Navigator tablist overflows horizontally|clipped outside its container/,
    "the former one-line 124px Navigator strip fails when tabs extend behind clipped bounds",
  );
  assert.throws(
    () => validateNavigatorControlsGeometry({
      ...navigatorFixture,
      searchButton: {
        ...navigatorFixture.searchButton,
        geometry: geometry({ clientWidth: 24, width: 24, height: 28, left: 96, top: 74 }),
      },
    }),
    /smaller than the 28px token target/,
    "a visible but undersized Navigator search target fails reachability",
  );
  assert.deepEqual(
    compensatedWindowSize(
      { width: 1024, height: 680 },
      { client_width: 1024, client_height: 648 },
      { width: 1024, height: 680 },
    ),
    { width: 1024, height: 712 },
    "macOS title-bar chrome is compensated from measured HTML geometry instead of weakening the target viewport",
  );
}

// The pre-ready readiness source is bounded JSONL. It identifies one terminal
// runtime record by a stable token, tolerates only a concurrently-written tail,
// and proves consecutive frame equality from PNG bytes rather than timers.
{
  const temporary = fs.mkdtempSync(path.join(canonicalTemporaryRoot, "rho-startup-jsonl-"));
  const logFile = path.join(temporary, "startup.jsonl");
  const frameA = path.join(temporary, "a.png");
  const frameB = path.join(temporary, "b.png");
  try {
    const terminalLine = JSON.stringify({
      timestamp: "2026-08-26T12:00:01Z",
      event: { message: `${STARTUP_TERMINAL_MESSAGE_PREFIX} node is not R` },
    });
    const source = [
      JSON.stringify({ timestamp: "2026-08-26T12:00:00Z", event: { message: "shell setup" } }),
      terminalLine,
      "{half-written",
    ].join("\n");
    const parsed = parseStartupJsonl(source);
    assert.equal(parsed.length, 2, "only an incomplete final JSONL record may be ignored");
    const terminal = terminalStartupRecord(parsed);
    assert.equal(terminal?.record.event.message, `${STARTUP_TERMINAL_MESSAGE_PREFIX} node is not R`);
    assert.equal(terminal?.token, terminalStartupRecord(parseStartupJsonl(`${terminalLine}\n`))?.token);
    assert.equal(startupRecordTokenIsPresent([
      ...parsed,
      { timestamp: "later", event: { message: `${STARTUP_TERMINAL_MESSAGE_PREFIX} another failure` } },
    ], terminal.token), true, "the original terminal token remains valid when later log records append");
    assert.throws(
      () => parseStartupJsonl("{bad}\n"),
      /JSONL line 1 is invalid/,
      "a completed malformed JSONL line must fail closed",
    );

    fs.writeFileSync(logFile, `${terminalLine}\n`);
    assert.equal(terminalStartupRecord(readStartupJsonl(logFile))?.token, terminal?.token);
    assert.throws(
      () => readStartupJsonl(logFile, terminalLine.length - 1),
      /exceeds.*acceptance bound/,
    );
    fs.writeFileSync(logFile, "😀".repeat(9));
    assert.equal(fs.statSync(logFile).size, 36, "the over-limit fixture is measured in actual UTF-8 bytes");
    assert.throws(
      () => readStartupJsonl(logFile, 35),
      /exceeds.*35-byte acceptance bound/,
      "the fd reader must reject the maxBytes+1 byte rather than trusting an earlier stat",
    );
    assert.equal(STARTUP_LOG_MAX_BYTES, 1024 * 1024);

    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("stable-frame")]);
    fs.writeFileSync(frameA, png);
    fs.writeFileSync(frameB, png);
    const firstHash = pngSha256(frameA);
    const secondHash = pngSha256(frameB);
    assert.equal(consecutivePngHashesMatch(null, firstHash), false);
    assert.equal(consecutivePngHashesMatch(firstHash, secondHash), true);
    fs.appendFileSync(frameB, "changed");
    assert.equal(consecutivePngHashesMatch(firstHash, pngSha256(frameB)), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// The V6 Agent fixture is isolated from the operator's Rho home, contains no
// literal credential, and points at a run-specific environment name that the
// child launch always removes.
{
  const temporary = fs.mkdtempSync(path.join(canonicalTemporaryRoot, "rho-agent-config-"));
  try {
    const expectedEnvironmentName = acceptanceMissingCredentialEnvironmentName(temporary);
    const fixture = createHermeticAgentConfig(temporary);
    assert.equal(fixture.rhoHome, path.join(temporary, "rho-home"));
    assert.equal(fixture.configPath, path.join(fixture.rhoHome, "config.yaml"));
    assert.equal(fixture.credentialEnvironmentName, expectedEnvironmentName);
    const yaml = fs.readFileSync(fixture.configPath, "utf8");
    assert.match(yaml, /^schema_version: 6$/mu);
    assert.match(yaml, /^revision: 1$/mu);
    assert.match(yaml, /^  - capability: agent\.chat$/mu);
    assert.match(yaml, new RegExp(`^    api_key_env: ${expectedEnvironmentName}$`, "mu"));
    assert.doesNotMatch(yaml, /^\s*api_key:/mu, "the fixture must not persist a literal credential");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(fixture.rhoHome).mode & 0o777, 0o700);
      assert.equal(fs.statSync(fixture.configPath).mode & 0o777, 0o600);
    }
    assert.throws(
      () => createHermeticAgentConfig(temporary),
      /hermetic Rho home already exists; refusing reuse/,
      "an acceptance run must not reuse or overwrite a canonical config fixture",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// The intentionally bad Rscript fixture and missing Agent credential are
// child-local. A following ordinary launch must not mutate its source env.
{
  const output = "/tmp/rho-acceptance";
  const missingCredentialEnvironmentName = acceptanceMissingCredentialEnvironmentName(output);
  const parentEnvironment = {
    KEEP_ME: "yes",
    RHO_RSCRIPT: "/caller/rscript",
    [missingCredentialEnvironmentName]: "ambient-secret-must-not-survive",
  };
  const bad = acceptanceLaunchEnvironment(output, {
    parentEnvironment,
    rscript: process.execPath,
  });
  const normal = acceptanceLaunchEnvironment(output, { parentEnvironment });
  assert.equal(bad.RHO_RSCRIPT, process.execPath);
  assert.equal(normal.RHO_RSCRIPT, "/caller/rscript");
  assert.equal(normal.RHO_HOME, "/tmp/rho-acceptance/rho-home");
  assert.equal(normal.KEEP_ME, "yes");
  assert.equal(normal[missingCredentialEnvironmentName], undefined);
  assert.equal(parentEnvironment.RHO_RSCRIPT, "/caller/rscript", "launch env construction must not mutate its source");
  assert.equal(
    parentEnvironment[missingCredentialEnvironmentName],
    "ambient-secret-must-not-survive",
    "credential scrubbing must not mutate the caller's environment",
  );
}

function evidenceRecord(runDirectory, { scenarios = [], gates = [], error = null } = {}) {
  return {
    schema: EVIDENCE_SCHEMA,
    ledger_revision: 0,
    status: "FAIL",
    started_at: "2026-08-26T00:00:00.000Z",
    finished_at: null,
    output: runDirectory,
    app: "/tmp/rho-desktop",
    platform: "test",
    scenarios,
    gates,
    error,
  };
}

function writeEvidence(runDirectory, evidence) {
  fs.mkdirSync(path.join(runDirectory, "screenshots"), { recursive: true });
  evidence.finished_at ??= "2026-08-26T00:01:00.000Z";
  refreshLedger(runDirectory, evidence);
}

async function reviewFrame(runDirectory, frame, verdict = "pass") {
  let reviewedGate;
  const evidence = await mutateCompletedRun(runDirectory, `self-test:${frame}`, (mutable) => {
    const matching = mutable.gates.filter((gate) => gate.screenshot === `screenshots/${frame}.png`);
    if (matching.length !== 1) throw new Error(`no unique gate captured frame ${frame}`);
    const [gate] = matching;
    const frameFile = path.join(runDirectory, gate.screenshot);
    if (!fs.existsSync(frameFile)) throw new Error("frame is not reviewable: screenshot artifact is unreadable");
    if (!Array.isArray(gate.criteria) || gate.criteria.length === 0) throw new Error("frame is not reviewable: criteria missing");
    if (gate.screenshot_capture_status !== "PASS") throw new Error(`frame is not reviewable: capture status ${gate.screenshot_capture_status}`);
    gate.visual_status = verdict.toUpperCase();
    gate.visual_note = "self-test review";
    gate.status = gate.deterministic_status === "FAIL" || gate.visual_status === "FAIL" ? "FAIL" : "PASS";
    reviewedGate = gate;
  }, { verifyCandidate: () => undefined });
  return {
    visual_status: reviewedGate.visual_status,
    run_status: evidence.status,
    scenarios: scenarioResults(evidence),
  };
}

// v1 remains readable historical evidence but is immutable. Removing the
// schema or the v2 identity fields cannot downgrade a ledger into that path.
{
  const temporary = fs.mkdtempSync(path.join(canonicalTemporaryRoot, "rho-visual-schema-"));
  const invoke = (command, run, extra = []) => execFileSync(process.execPath, [
    driverFile,
    command,
    "--run",
    run,
    ...extra,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    for (const [name, evidence, expected] of [
      ["legacy", { schema: LEGACY_EVIDENCE_SCHEMA, finished_at: "2026-08-27T00:00:00.000Z" }, /v1 evidence is read-only|exit/i],
      ["missing-schema", { finished_at: "2026-08-27T00:00:00.000Z" }, /unsupported or missing.*schema|exit/i],
    ]) {
      const run = path.join(temporary, name);
      fs.mkdirSync(run);
      const evidenceFile = path.join(run, "evidence.json");
      fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence)}\n`);
      const before = fs.readFileSync(evidenceFile);
      assert.throws(
        () => invoke("finalize", run),
        expected,
        `${name} finalize must reject without mutation`,
      );
      assert.deepEqual(fs.readFileSync(evidenceFile), before);
      assert.equal(fs.existsSync(path.join(run, ".writer.lock")), false);
    }

    const incompleteRun = path.join(temporary, "incomplete-v2");
    const incomplete = evidenceRecord(incompleteRun, {
      scenarios: [{ id: "s1", title: "tour", status: "PASS", duration_ms: 1, error: null }],
      gates: [{ scenario: "s1", name: "ok", deterministic_status: "PASS", visual_status: "N/A", status: "PASS", screenshot: null, criteria: [] }],
    });
    incomplete.frontend_build_identity = null;
    incomplete.debug_app_identity = null;
    writeEvidence(incompleteRun, incomplete);
    const beforeCommit = fs.readFileSync(path.join(incompleteRun, "ledger-commit.json"));
    const beforeEvidence = fs.readFileSync(path.join(incompleteRun, "evidence.json"));
    assert.throws(() => invoke("finalize", incompleteRun), /identity evidence is incomplete|exit/i);
    assert.deepEqual(fs.readFileSync(path.join(incompleteRun, "ledger-commit.json")), beforeCommit);
    assert.deepEqual(fs.readFileSync(path.join(incompleteRun, "evidence.json")), beforeEvidence);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// scenario registry is complete and every module exists
{
  const ids = SCENARIOS.map((scenario) => scenario.id);
  assert.deepEqual(ids, ["s0", "s1", "s2", "s3", "s7", "s8", "s9"]);
  assert.equal(new Set(ids).size, ids.length, "scenario ids must be unique");
  for (const scenario of SCENARIOS) {
    const file = path.join(repositoryRoot, "scripts", "visual-acceptance", scenario.file);
    assert.ok(fs.existsSync(file), `scenario module is missing: ${scenario.file}`);
    assert.ok(scenario.title.length > 0, `scenario ${scenario.id} needs a title`);
  }
}

// non-fatal gates still make their owning scenario fail after aggregation
{
  const evidence = {
    schema: EVIDENCE_SCHEMA,
    status: "FAIL",
    started_at: "",
    finished_at: null,
    output: "/tmp/run",
    app: "/tmp/rho-desktop",
    platform: "test",
    scenarios: [{ id: "s8", title: "boundaries", status: "PASS", duration_ms: 1, error: null }],
    gates: [
      { scenario: "s8", name: "isolation", deterministic_status: "FAIL", visual_status: "N/A", status: "FAIL", screenshot: null, criteria: [] },
      { scenario: "s8", name: "next-independent-gate", deterministic_status: "PASS", visual_status: "PASS", status: "PASS", screenshot: "screenshots/next.png", criteria: ["c"] },
    ],
    error: null,
  };
  reconcileScenarioStatuses(evidence);
  assert.equal(evidence.scenarios[0].status, "FAIL");
}

// scenario aggregation preserves execution errors, rejects zero-gate success,
// and truthfully exposes partial coverage as SKIP.
{
  const errored = evidenceRecord("/tmp/run", {
    scenarios: [{ id: "s3", title: "agent", status: "PASS", duration_ms: 4, error: "stream ended early" }],
    gates: [
      { scenario: "s3", name: "mounted", deterministic_status: "PASS", visual_status: "N/A", status: "PASS", screenshot: null, criteria: [] },
    ],
  });
  finalizeStatus(errored);
  assert.equal(errored.scenarios[0].status, "FAIL", "scenario.error must survive gate reconciliation");
  assert.equal(errored.status, "FAIL");

  const empty = evidenceRecord("/tmp/run", {
    scenarios: [{ id: "s0", title: "startup", status: "PASS", duration_ms: 1, error: null }],
  });
  finalizeStatus(empty);
  assert.equal(empty.scenarios[0].status, "FAIL", "a scenario cannot pass without gate evidence");
  assert.match(empty.scenarios[0].error, /no gate evidence/i);
  assert.equal(empty.status, "FAIL");

  const mixed = evidenceRecord("/tmp/run", {
    scenarios: [{ id: "s3", title: "agent", status: "PASS", duration_ms: 2, error: null }],
    gates: [
      { scenario: "s3", name: "surface", deterministic_status: "PASS", visual_status: "N/A", status: "PASS", screenshot: null, criteria: [] },
      { scenario: "s3", name: "credential", deterministic_status: "SKIP", visual_status: "N/A", status: "SKIP", screenshot: null, criteria: [] },
    ],
  });
  finalizeStatus(mixed);
  assert.equal(mixed.scenarios[0].status, "SKIP", "mixed PASS/SKIP must not claim full scenario PASS");
  assert.equal(mixed.status, "PASS", "an auditable SKIP is a valid non-failing run outcome");
  assert.deepEqual(scenarioResults(mixed), [{ id: "s3", status: "SKIP", duration_ms: 2, error: null }]);

  const report = renderReport(errored);
  assert.match(report, /## Scenarios/);
  assert.match(report, /stream ended early/);
}

// a harness/startup error can never become PASS merely because no gates ran
{
  const evidence = {
    schema: EVIDENCE_SCHEMA,
    status: "FAIL",
    started_at: "",
    finished_at: null,
    output: "/tmp/run",
    app: "/tmp/rho-desktop",
    platform: "test",
    scenarios: [],
    gates: [],
    error: "bridge failed to start",
  };
  finalizeStatus(evidence);
  assert.equal(evidence.status, "FAIL");
}

// evidence model: gate states drive the final status truthfully
{
  const evidence = {
    schema: EVIDENCE_SCHEMA,
    status: "FAIL",
    started_at: new Date().toISOString(),
    finished_at: null,
    app: "/tmp/rho-desktop",
    platform: "test",
    scenarios: [],
    gates: [
      { scenario: "s1", name: "deterministic-only", deterministic_status: "PASS", visual_status: "N/A", status: "PASS", screenshot: null, criteria: [] },
      { scenario: "s1", name: "visual-pass", deterministic_status: "PASS", visual_status: "PASS", status: "PASS", screenshot: "screenshots/a.png", criteria: ["c"] },
      { scenario: "s2", name: "visual-pending", deterministic_status: "PASS", visual_status: "PENDING", status: "PENDING", screenshot: "screenshots/b.png", criteria: ["c"] },
      { scenario: "s3", name: "agent-skip", deterministic_status: "SKIP", visual_status: "N/A", status: "SKIP", screenshot: null, criteria: [] },
    ],
    error: null,
  };
  const summary = summarizeEvidence(evidence);
  assert.equal(summary.gates, 4);
  assert.equal(summary.passed, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.visual_pending, 1);
  const report = renderReport(evidence);
  assert.match(report, /visual-pending/);
  assert.match(report, /PENDING/);
}

// run directories are immutable: a caller must choose a fresh evidence root
{
  const temporary = fs.mkdtempSync(path.join(canonicalTemporaryRoot, "rho-visual-existing-run-"));
  try {
    assert.throws(
      () => execFileSync(process.execPath, [
        path.join(repositoryRoot, "scripts", "visual-acceptance.mjs"),
        "run",
        "--app",
        process.execPath,
        "--output",
        temporary,
      ], { stdio: ["ignore", "pipe", "pipe"] }),
      /output directory already exists|exit/i,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// Standalone browser collectors claim a fresh root atomically, integrated
// collectors reject finalized ledgers, and screenshot writes are exclusive so
// a rerun cannot replace a frame that was already reviewed.
{
  const temporary = fs.mkdtempSync(path.join(canonicalTemporaryRoot, "rho-visual-collector-integrity-"));
  const distRoot = path.join(temporary, "dist");
  fs.mkdirSync(distRoot);
  fs.writeFileSync(path.join(distRoot, "index.html"), "<!doctype html><html></html>\n");
  fs.writeFileSync(
    path.join(distRoot, "build-identity.json"),
    `${JSON.stringify({ build_id: "0123456789ab" })}\n`,
  );
  try {
    const claimed = path.join(temporary, "claimed");
    createExclusiveEvidenceOutput(claimed);
    assert.throws(
      () => createExclusiveEvidenceOutput(claimed),
      /output already exists.*immutable/,
    );

    const reviewedFrame = path.join(claimed, "reviewed.png");
    writeExclusiveArtifact(reviewedFrame, Buffer.from("reviewed evidence"));
    assert.throws(
      () => writeExclusiveArtifact(reviewedFrame, Buffer.from("replacement bytes")),
      /artifact already exists.*refusing overwrite/,
    );
    assert.equal(fs.readFileSync(reviewedFrame, "utf8"), "reviewed evidence");

    const finalized = path.join(temporary, "finalized");
    fs.mkdirSync(finalized);
    fs.writeFileSync(
      path.join(finalized, "evidence.json"),
      `${JSON.stringify({ finished_at: "2026-08-27T00:00:00.000Z" })}\n`,
    );
    await assert.rejects(
      captureStartupBrowserFrames({ output: finalized, distRoot, expectedBuildId: "0123456789ab" }),
      /cannot append to finalized evidence/,
    );
    await assert.rejects(
      captureVibeAgentBrowserFrames({ output: finalized, distRoot, expectedBuildId: "0123456789ab" }),
      /cannot append to finalized evidence/,
    );

    const mismatch = path.join(temporary, "build-mismatch");
    fs.mkdirSync(mismatch);
    await assert.rejects(
      captureStartupBrowserFrames({
        output: mismatch,
        distRoot,
        expectedBuildId: "abcdefabcdef",
      }),
      /frontend build identity mismatch/,
      "collector must reject a dist build that differs from the real-app-bound build before Chromium launch",
    );

    const exactDist = readDirectoryIdentity(distRoot);
    const originalIndex = fs.readFileSync(path.join(distRoot, "index.html"));
    const changedIndex = Buffer.from(originalIndex);
    changedIndex[changedIndex.length - 2] ^= 0x01;
    fs.writeFileSync(path.join(distRoot, "index.html"), changedIndex);
    const changedDist = readDirectoryIdentity(distRoot);
    assert.equal(changedDist.bytes, exactDist.bytes, "collector tamper preserves exact dist byte count");
    const byteMismatch = path.join(temporary, "byte-mismatch");
    fs.mkdirSync(byteMismatch);
    await assert.rejects(
      captureStartupBrowserFrames({
        output: byteMismatch,
        distRoot,
        expectedBuildId: "0123456789ab",
        expectedDistIdentity: exactDist,
      }),
      /dist bytes changed/,
      "collector must reject changed dist bytes before Chromium launch",
    );
    fs.writeFileSync(path.join(distRoot, "index.html"), originalIndex);

    const staleDist = path.join(temporary, "stale-dist");
    fs.mkdirSync(staleDist);
    assert.notEqual(currentSourceFrontendBuildId(repositoryRoot), "0123456789ab");
    await assert.rejects(
      captureVibeAgentBrowserFrames({ output: staleDist, distRoot }),
      /frontend build identity mismatch/,
      "standalone collector must reject desktop/dist built from stale frontend source",
    );

    for (const collector of ["startup-browser.mjs", "vibe-agent-browser.mjs"]) {
      const existing = path.join(temporary, `existing-${collector}`);
      fs.mkdirSync(existing);
      assert.throws(
        () => execFileSync(process.execPath, [
          path.join(repositoryRoot, "scripts", "visual-acceptance", collector),
          "--output",
          existing,
        ], { stdio: ["ignore", "pipe", "pipe"] }),
        /output already exists|exit/i,
        `${collector} must reject an existing standalone output root before launching Chromium`,
      );
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// a frame without a recorded visual verdict keeps the run out of PASS
{
  const evidence = evidenceRecord("/tmp/run", {
    scenarios: [{ id: "s1", title: "tour", status: "PASS", duration_ms: 1, error: null }],
    gates: [
      { scenario: "s1", name: "pending", deterministic_status: "PASS", visual_status: "PENDING", status: "PENDING", screenshot: "screenshots/x.png", criteria: [] },
    ],
  });
  assert.equal(summarizeEvidence(evidence).visual_pending, 1, "pending visual review must stay visible");
  finalizeStatus(evidence);
  assert.equal(evidence.scenarios[0].status, "PENDING");
  assert.equal(evidence.status, "FAIL", "finalize must keep a pending frame out of PASS");
}

// A review verdict is accepted only for a captured, intact PNG with explicit
// criteria. Capture failure is irreversible, and finalization revalidates a
// previously reviewed artifact so deleting it cannot leave a false PASS.
{
  const temporary = fs.mkdtempSync(path.join(canonicalTemporaryRoot, "rho-visual-review-"));
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    Buffer.from("self-test-frame"),
  ]);
  const makeEvidence = (runDirectory, overrides = {}) => evidenceRecord(runDirectory, {
    scenarios: [{ id: "s1", title: "tour", status: "PENDING", duration_ms: 1, error: null }],
    gates: [{
      scenario: "s1",
      name: "frame",
      evidence_class: "browser_mock",
      deterministic_status: "PASS",
      screenshot_capture_status: "PASS",
      visual_status: "PENDING",
      visual_note: null,
      status: "PENDING",
      error: null,
      screenshot: "screenshots/frame.png",
      screenshot_bytes: png.length,
      screenshot_sha256: createHash("sha256").update(png).digest("hex"),
      criteria: ["the component is visible"],
      ...overrides,
    }],
  });
  try {
    const missingRun = path.join(temporary, "missing");
    writeEvidence(missingRun, makeEvidence(missingRun));
    await assert.rejects(
      reviewFrame(missingRun, "frame"),
      /not reviewable|unreadable|exit/i,
      "a missing screenshot cannot be reviewed into PASS",
    );

    const failedRun = path.join(temporary, "capture-failed");
    writeEvidence(failedRun, makeEvidence(failedRun, { screenshot_capture_status: "FAIL" }));
    fs.writeFileSync(path.join(failedRun, "screenshots", "frame.png"), png);
    await assert.rejects(
      reviewFrame(failedRun, "frame"),
      /not reviewable|capture status|exit/i,
      "an explicit capture failure cannot be overwritten by review",
    );

    const noCriteriaRun = path.join(temporary, "no-criteria");
    writeEvidence(noCriteriaRun, makeEvidence(noCriteriaRun, { criteria: [] }));
    fs.writeFileSync(path.join(noCriteriaRun, "screenshots", "frame.png"), png);
    await assert.rejects(
      reviewFrame(noCriteriaRun, "frame"),
      /not reviewable|criteria|exit/i,
      "a frame without visual criteria cannot be reviewed",
    );

    const validRun = path.join(temporary, "valid");
    writeEvidence(validRun, makeEvidence(validRun));
    const frameFile = path.join(validRun, "screenshots", "frame.png");
    fs.writeFileSync(frameFile, png);
    const review = await reviewFrame(validRun, "frame");
    assert.equal(review.visual_status, "PASS");
    assert.equal(review.run_status, "PASS");
    assert.deepEqual(review.scenarios, [{ id: "s1", status: "PASS", duration_ms: 1, error: null }]);
    const manifest = JSON.parse(fs.readFileSync(path.join(validRun, "visual-review-manifest.json"), "utf8"));
    assert.equal(manifest.schema, "rho_visual_acceptance_visual_review_v2");
    assert.equal(manifest.ledger_revision, readCommittedEvidence(validRun).evidence.ledger_revision);
    assert.equal(manifest.frames[0].evidence_class, "browser_mock");
    assert.equal(manifest.frames[0].screenshot_sha256, createHash("sha256").update(png).digest("hex"));

    const tampered = Buffer.from(png);
    tampered[tampered.length - 1] ^= 0xff;
    assert.equal(tampered.length, png.length, "tamper fixture preserves the recorded byte count");
    fs.writeFileSync(frameFile, tampered);
    const finalized = await mutateCompletedRun(
      validRun,
      "self-test-finalize",
      () => undefined,
      { verifyCandidate: () => undefined },
    );
    assert.equal(finalized.status, "FAIL", "same-size screenshot tampering before finalize invalidates the run");
    assert.deepEqual(scenarioResults(finalized), [{ id: "s1", status: "FAIL", duration_ms: 1, error: null }]);
    const invalidated = readCommittedEvidence(validRun).evidence;
    assert.equal(invalidated.gates[0].screenshot_capture_status, "FAIL");
    assert.equal(invalidated.gates[0].visual_status, "FAIL");
    assert.match(invalidated.gates[0].error, /SHA-256 mismatch/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// Completed-run mutations are serialized at the run root. Two concurrent
// reviews preserve both verdicts, a live run rejects review immediately, and
// a candidate replacement after the atomic ledger write forces a new FAIL
// revision instead of leaving the just-written PASS behind.
{
  const temporary = fs.mkdtempSync(path.join(canonicalTemporaryRoot, "rho-visual-run-writer-"));
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("concurrent")]);
  const gate = (name) => ({
    scenario: "s1",
    name,
    evidence_class: "browser_mock",
    deterministic_status: "PASS",
    screenshot_capture_status: "PASS",
    visual_status: "PENDING",
    visual_note: null,
    status: "PENDING",
    error: null,
    screenshot: `screenshots/${name}.png`,
    screenshot_bytes: png.length,
    screenshot_sha256: createHash("sha256").update(png).digest("hex"),
    criteria: ["visible"],
  });
  try {
    const concurrentRun = path.join(temporary, "concurrent");
    const concurrent = evidenceRecord(concurrentRun, {
      scenarios: [{ id: "s1", title: "tour", status: "PENDING", duration_ms: 1, error: null }],
      gates: [gate("a"), gate("b")],
    });
    writeEvidence(concurrentRun, concurrent);
    fs.writeFileSync(path.join(concurrentRun, "screenshots", "a.png"), png);
    fs.writeFileSync(path.join(concurrentRun, "screenshots", "b.png"), png);
    await Promise.all(["a", "b"].map((name, index) => mutateCompletedRun(
      concurrentRun,
      `concurrent-review:${name}`,
      async (mutable) => {
        if (index === 0) await new Promise((resolve) => setTimeout(resolve, 40));
        const target = mutable.gates.find((candidate) => candidate.name === name);
        target.visual_status = "PASS";
        target.status = "PASS";
      },
      { verifyCandidate: () => undefined },
    )));
    const concurrentResult = readCommittedEvidence(concurrentRun).evidence;
    assert.deepEqual(concurrentResult.gates.map((item) => item.visual_status), ["PASS", "PASS"]);
    assert.equal(concurrentResult.ledger_revision, 3, "initial commit plus two serialized reviews");
    assert.equal(concurrentResult.status, "PASS");
    assert.equal(fs.existsSync(path.join(concurrentRun, ".writer.lock")), false);

    const liveRun = path.join(temporary, "live");
    createExclusiveEvidenceOutput(liveRun);
    ensureSecureDirectory(path.join(liveRun, "screenshots"), { create: true });
    const live = evidenceRecord(liveRun, {
      scenarios: [{ id: "s1", title: "tour", status: "PASS", duration_ms: 0, error: null }],
      gates: [{ scenario: "s1", name: "live", deterministic_status: "PASS", visual_status: "N/A", status: "PASS", screenshot: null, criteria: [] }],
    });
    refreshLedger(liveRun, live);
    const liveLock = await acquireRunWriterLock(liveRun, "live-owner");
    await assert.rejects(
      mutateCompletedRun(liveRun, "early-review", () => undefined, { verifyCandidate: () => undefined }),
      /still live.*finished_at/,
    );
    releaseRunWriterLock(liveLock);
    assert.equal(readCommittedEvidence(liveRun).evidence.ledger_revision, 1);

    for (const commandKind of ["record-review", "finalize"]) {
      const raceRun = path.join(temporary, `post-write-${commandKind}`);
      const raced = evidenceRecord(raceRun, {
        scenarios: [{ id: "s1", title: "tour", status: "PASS", duration_ms: 1, error: null }],
        gates: [{ scenario: "s1", name: "ok", deterministic_status: "PASS", visual_status: "N/A", status: "PASS", screenshot: null, criteria: [] }],
      });
      writeEvidence(raceRun, raced);
      let verification = 0;
      await assert.rejects(
        mutateCompletedRun(
          raceRun,
          `race:${commandKind}`,
          (mutable) => { mutable.gates[0].visual_note = commandKind; },
          {
            verifyCandidate: () => {
              verification += 1;
              if (verification === 2) throw new Error("exact debug app was replaced after write");
            },
          },
        ),
        /candidate identity changed after ledger mutation/,
      );
      const failed = readCommittedEvidence(raceRun).evidence;
      assert.equal(failed.status, "FAIL", `${commandKind} replacement race leaves durable FAIL`);
      assert.match(failed.error, /exact debug app was replaced after write/);
      assert.equal(failed.ledger_revision, 3, "attempted mutation plus fail-closed repair are separate committed revisions");
    }

    const tornRun = path.join(temporary, "torn");
    writeEvidence(tornRun, evidenceRecord(tornRun, {
      scenarios: [{ id: "s1", title: "tour", status: "PASS", duration_ms: 1, error: null }],
      gates: [{ scenario: "s1", name: "ok", deterministic_status: "PASS", visual_status: "N/A", status: "PASS", screenshot: null, criteria: [] }],
    }));
    fs.appendFileSync(path.join(tornRun, "report.md"), "tampered\n");
    assert.throws(() => readCommittedEvidence(tornRun), /report\.md does not match its commit/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// Lock recovery protects the mkdir -> owner.json creation window, never
// steals a live PID, and reclaims orphaned/corrupt records after the grace.
{
  const temporary = fs.mkdtempSync(path.join(canonicalTemporaryRoot, "rho-visual-lock-"));
  const lockDirectory = path.join(temporary, "window.lock");
  const lockOptions = { lockDirectory, timeoutMs: 25, pollIntervalMs: 5 };
  try {
    fs.mkdirSync(lockDirectory);
    fs.writeFileSync(path.join(lockDirectory, "owner.json"), JSON.stringify({ pid: process.pid }));
    await assert.rejects(
      acquireAppLock("contender", { ...lockOptions, orphanGraceMs: 0 }),
      /lock wait timed out/,
      "a live lock owner must not be stolen",
    );
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDirectory, "owner.json"), "utf8")).pid, process.pid);
    releaseAppLock(lockDirectory);

    fs.mkdirSync(lockDirectory);
    await assert.rejects(
      acquireAppLock("contender", { ...lockOptions, orphanGraceMs: 1_000 }),
      /lock wait timed out/,
      "a fresh ownerless lock must receive a safe creation grace",
    );
    const old = new Date(Date.now() - 5_000);
    fs.utimesSync(lockDirectory, old, old);
    await acquireAppLock("orphan-recovery", { ...lockOptions, orphanGraceMs: 50 });
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDirectory, "owner.json"), "utf8")).owner, "orphan-recovery");
    releaseAppLock(lockDirectory);

    fs.mkdirSync(lockDirectory);
    const corruptOwner = path.join(lockDirectory, "owner.json");
    fs.writeFileSync(corruptOwner, "{not-json");
    fs.utimesSync(corruptOwner, old, old);
    fs.utimesSync(lockDirectory, old, old);
    await acquireAppLock("corrupt-recovery", { ...lockOptions, orphanGraceMs: 50 });
    assert.equal(JSON.parse(fs.readFileSync(corruptOwner, "utf8")).owner, "corrupt-recovery");
  } finally {
    releaseAppLock(lockDirectory);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// fixture generation equivalence (real generation, temporary root)
{
  const temporary = fs.mkdtempSync(path.join(canonicalTemporaryRoot, "rho-visual-fixtures-"));
  const output = path.join(temporary, "fixtures");
  try {
    execFileSync(process.execPath, [
      path.join(repositoryRoot, "test", "acceptance-project", "tools", "prepare-fixtures.mjs"),
      "--output",
      output,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    const working = path.join(output, "working-project");
    const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    assert.equal(git(working, ["rev-list", "--count", "HEAD"]), "1", "working project has exactly the baseline commit");
    assert.ok(fs.existsSync(path.join(working, "examples", "rho-workbench-tour.R")), "working project carries the tour");

    const conflict = path.join(output, "conflict-project");
    assert.ok(
      git(conflict, ["status", "--porcelain"]).split("\n").includes("UU examples/git-review-demo.txt"),
      "conflict project ships the staged UU conflict",
    );

    const unicode = path.join(output, "路径 含 空格", "acceptance-project");
    assert.ok(fs.existsSync(path.join(unicode, "examples", "rho-workbench-tour.R")), "unicode/space project exists");
    assert.ok(!fs.existsSync(path.join(unicode, ".git")), "unicode project is not a git repository");

    const large = path.join(output, "large-project-2100");
    assert.equal(fs.readdirSync(large).filter((entry) => entry.endsWith(".R")).length, 2100);

    const oversized = path.join(output, "oversized-file-project", "over-8MiB.txt");
    assert.equal(fs.statSync(oversized).size, 9 * 1024 * 1024);

    assert.throws(
      () => execFileSync(process.execPath, [
        path.join(repositoryRoot, "test", "acceptance-project", "tools", "prepare-fixtures.mjs"),
        "--output",
        output,
      ], { stdio: ["ignore", "pipe", "pipe"] }),
      /already exists|exit/i,
      "an existing output root fails closed",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// bridge fail-closed contract (static source assertions; no build required)
{
  const bridgeSource = fs.readFileSync(path.join(repositoryRoot, "desktop", "src-tauri", "src", "acceptance_bridge.rs"), "utf8");
  const mainSource = fs.readFileSync(path.join(repositoryRoot, "desktop", "src-tauri", "src", "main.rs"), "utf8");
  const driverSource = fs.readFileSync(driverFile, "utf8");
  const s0Source = fs.readFileSync(path.join(repositoryRoot, "scripts", "visual-acceptance", "s0-startup.mjs"), "utf8");
  const startupBrowserSource = fs.readFileSync(
    path.join(repositoryRoot, "scripts", "visual-acceptance", "startup-browser.mjs"),
    "utf8",
  );
  const s9Source = fs.readFileSync(
    path.join(repositoryRoot, "scripts", "visual-acceptance", "s9-vibe.mjs"),
    "utf8",
  );
  const vibeAgentBrowserSource = fs.readFileSync(
    path.join(repositoryRoot, "scripts", "visual-acceptance", "vibe-agent-browser.mjs"),
    "utf8",
  );
  const vibeCssSource = fs.readFileSync(
    path.join(repositoryRoot, "desktop", "ui", "src", "styles", "vibe.css"),
    "utf8",
  );
  const workbenchSource = fs.readFileSync(path.join(repositoryRoot, "desktop", "ui", "src", "app", "workbench", "WorkbenchRoot.tsx"), "utf8");
  const automationSource = fs.readFileSync(
    path.join(repositoryRoot, "desktop", "ui", "src", "acceptance", "automation.ts"),
    "utf8",
  );
  assert.match(bridgeSource, /127\.0\.0\.1/, "bridge binds loopback only");
  assert.doesNotMatch(bridgeSource, /0\.0\.0\.0/, "bridge must never bind a wildcard address");
  assert.match(bridgeSource, /RHO_ACCEPTANCE_BRIDGE/, "bridge requires the explicit environment flag");
  assert.match(bridgeSource, /RHO_ACCEPTANCE_OUTPUT/, "bridge requires an explicit output directory");
  assert.match(
    bridgeSource,
    /fn resolve_app_data_dir[\s\S]{0,2200}?app-data/,
    "an enabled bridge resolves run-local application data below its output root",
  );
  assert.match(
    bridgeSource,
    /acceptance app-data directory must not be a symlink/,
    "run-local application data rejects symlink escape",
  );
  assert.match(
    bridgeSource,
    /fn screenshot_not_implemented\(\) -> Response/,
    "the cross-platform screenshot fallback keeps a testable response shape",
  );
  assert.match(
    mainSource,
    /#\[cfg\(debug_assertions\)\][\s\S]{0,400}?acceptance_bridge/,
    "the bridge startup is compile-gated to debug builds",
  );
  assert.match(
    mainSource,
    /application_data_dir_override\(\)[\s\S]{0,500}?app_local_data_dir\(\)/,
    "ordinary Tauri application data is only the non-acceptance fallback",
  );
  assert.match(
    workbenchSource,
    /existing != null && placement != null/,
    "open_surface must not treat an unplaced catalog instance as mounted",
  );
  assert.doesNotMatch(automationSource, /\beval\s*\(/, "the frontend automation surface must not evaluate source text");
  assert.doesNotMatch(automationSource, /\bnew\s+Function\b/, "the automation surface must not synthesize functions");

  const preReadyStart = driverSource.indexOf("async function capturePreReadyRuntimeAttention");
  const preReadyEnd = driverSource.indexOf("async function runLane", preReadyStart);
  assert.ok(preReadyStart >= 0 && preReadyEnd > preReadyStart, "pre-ready startup gate source is present");
  const preReadySource = driverSource.slice(preReadyStart, preReadyEnd);
  assert.doesNotMatch(preReadySource, /\.command\s*\(|\/eval\b/, "pre-ready startup capture must never use frontend automation");
  assert.match(preReadySource, /bridge\.setWindow\(1024, 680\)/, "pre-ready capture uses the existing window route");
  assert.match(preReadySource, /bridge\.screenshot\(probeName\)/, "pre-ready capture uses the existing screenshot route");
  assert.match(preReadySource, /startupRecordTokenIsPresent\(readStartupJsonl\(logFile\), terminal\.token\)/, "pre-ready screenshot probes retain the same terminal startup record token");
  assert.match(preReadySource, /residualChild = child/, "an unterminated bad-R child remains explicit");
  assert.match(preReadySource, /return \{ record, residualChild \}/, "pre-ready capture returns residual ownership to the lane driver");

  const runLaneSource = driverSource.slice(preReadyEnd, driverSource.indexOf("function parseOptions", preReadyEnd));
  const residualBranch = runLaneSource.slice(
    runLaneSource.indexOf("if (residualChild != null)"),
    runLaneSource.indexOf("const launch = async"),
  );
  assert.match(residualBranch, /state\.child = residualChild/, "the finalizer retains the residual PID-bearing child");
  assert.match(residualBranch, /residualFixtureBlocksKeepApp = true/, "--keep-app cannot preserve a failed fixture as a normal app");
  assert.match(residualBranch, /throw new AcceptanceError/, "a residual fixture blocks the ready-path launch");
  assert.match(runLaneSource, /transferAppLock\(`termination-pending:\$\{state\.child\.pid\}`/, "the finalizer transfers lock ownership when the residual PID still survives");
  assert.match(runLaneSource, /verifyCurrentCandidateIdentities\(evidence\)/, "run finalization rechecks source, dist, and exact app bytes");
  assert.match(runLaneSource, /assertExecutableIdentity\([\s\S]{0,220}?readExecutableIdentity\(appPath\)/, "every debug-app spawn is bound to the recorded binary identity");

  const readStart = driverSource.indexOf("export function readStartupJsonl");
  const readEnd = driverSource.indexOf("export function terminalStartupRecord", readStart);
  const boundedReadSource = driverSource.slice(readStart, readEnd);
  assert.doesNotMatch(boundedReadSource, /fs\.statSync\(|fs\.readFileSync\(/, "startup JSONL must not use stat-then-unbounded-read");
  assert.match(boundedReadSource, /fs\.openSync\(file, "r"\)/);
  assert.match(boundedReadSource, /maxBytes \+ 1 - bytesRead/);
  assert.match(boundedReadSource, /fs\.readSync\(/);
  assert.match(boundedReadSource, /finally \{[\s\S]*fs\.closeSync\(descriptor\)/, "the bounded descriptor closes on success and rejection");

  const projectOpenIndex = s0Source.indexOf('ctx.gate("s0", "project-open"');
  const warmIndex = s0Source.indexOf('ctx.gate("s0", "warm-restart-ready"');
  const browserIndex = s0Source.indexOf("ctx.captureStartupBrowserFrames()");
  const navigatorIndex = s0Source.indexOf('ctx.gate("s0", "navigator-file-tree"');
  assert.ok(
    projectOpenIndex < warmIndex && warmIndex < browserIndex && browserIndex < navigatorIndex,
    "S0 records cold/project/warm behavior before independent browser and Navigator visual gates",
  );
  assert.match(startupBrowserSource, /inspectNarrowReachability/);
  assert.match(startupBrowserSource, /scrollIntoViewIfNeeded\(\)/, "720×450 evidence checks scroll reachability");
  assert.match(startupBrowserSource, /focusedActions/, "720×450 attention actions are keyboard reachable");
  assert.match(startupBrowserSource, /scrolling\.some\(\(candidate\) => candidate\.maxScroll > 0\)/, "the attention evidence requires real vertical overflow");
  assert.match(startupBrowserSource, /fullPage: frame\.capture_mode === "full_scrollable_page"/, "only the matrix-selected frame receives Playwright full-page capture");

  const emptyHostFrameIndex = s9Source.indexOf('ctx.gate("s9", "empty-agent-record-host"');
  const narrowVerificationIndex = s9Source.indexOf('ctx.gate("s9", "narrow-verification"');
  const browserFramesIndex = s9Source.indexOf("ctx.captureVibeAgentBrowserFrames()");
  assert.ok(
    emptyHostFrameIndex >= 0
      && emptyHostFrameIndex < narrowVerificationIndex
      && narrowVerificationIndex < browserFramesIndex,
    "S9 records fresh real-app emptiness before the separately labelled exact browser/mock frames",
  );
  assert.match(s9Source, /assertEqual\(ready\.activeMode, "vibe"/, "the host gate proves the primary entry does not switch mode");
  assert.match(s9Source, /mounted Studio Agent surfaces while the Vibe host is open/, "the host gate rejects a mounted trusted Agent Surface");
  assert.match(s9Source, /VIBE_AGENT_HOST_SELECTORS\.startTrigger/, "fresh real-app evidence uses the state-specific local start entry");
  assert.match(s9Source, /openProject\(ctx, ctx\.fixtures\.unicodeProject\)/, "real empty-host evidence uses a project isolated from any S3 Agent record");
  assert.match(s9Source, /record_state:\s*"empty"/, "fresh real-app evidence never fabricates a Conversation or Turn");
  assert.match(s9Source, /exact Conversation\/Turn and geometry are browser_mock facts/, "S9 records the real\/mock authority boundary");
  assert.doesNotMatch(s9Source, /evidenceClass:\s*"browser_mock"/, "real-debug S9 frames must not be mislabeled as browser mock evidence");
  assert.match(driverSource, /captureVibeAgentBrowserFrames/, "the visual ledger imports the independent Vibe browser frame collector");
  assert.match(driverSource, /captureVibeAgentBrowserFrames:\s*async/, "S9 receives a bounded browser-frame context hook");
  const contextStart = driverSource.indexOf("const context = {");
  const actStart = driverSource.indexOf("act: (action)", contextStart);
  const readyStart = driverSource.indexOf("ready:", actStart);
  const actSource = driverSource.slice(actStart, readyStart);
  assert.match(actSource, /dispatchRealDebugAction/);
  assert.match(actSource, /pid:\s*state\.child\?\.pid/);
  assert.match(actSource, /activate:\s*activateApp/);
  assert.match(actSource, /command:\s*\(request\)\s*=>\s*state\.bridge\.command\(request\)/);
  assert.doesNotMatch(actSource, /settled|retry/i);

  const gateStart = driverSource.indexOf("gate: async", contextStart);
  const skipGateStart = driverSource.indexOf("skipGate:", gateStart);
  const gateSource = driverSource.slice(gateStart, skipGateStart);
  assert.match(gateSource, /runEvidenceClassCheck/);
  assert.match(gateSource, /evidenceClass/);
  assert.match(gateSource, /browser\/mock screenshots must use their isolated collector/);

  assert.match(vibeAgentBrowserSource, /sameAgentPublicRecord\(source, projected\)/, "browser/mock compares the same bounded Conversation\/Turn public tuple");
  assert.match(vibeAgentBrowserSource, /rho-vibe-exploration-link-exact/, "browser/mock separately proves the exact manuscript-reference host path");
  assert.match(vibeAgentBrowserSource, /article\[data-surface-id\][\s\S]{0,160}?count\(\), 0/, "browser/mock requires zero mounted Studio Surfaces");
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
    assert.match(
      vibeAgentBrowserSource,
      new RegExp(`"${trustedAction.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}"`),
      `browser/mock checks the real trusted Agent action label ${trustedAction}`,
    );
  }
  assert.match(vibeAgentBrowserSource, /Auto-approve project tools for this conversation/, "browser/mock checks the real trusted auto-approve label");
  assert.match(vibeAgentBrowserSource, /element\.scrollTop = element\.scrollHeight/, "720×450 evidence scrolls the local host to its footer");
  assert.match(vibeAgentBrowserSource, /candidate = candidate\.parentElement/, "720×450 evidence inspects the full host ancestor chain");
  assert.match(vibeAgentBrowserSource, /document\.scrollingElement/, "720×450 evidence includes page-level vertical overflow");
  assert.match(vibeAgentBrowserSource, /element\.querySelectorAll\("\*"\)/, "720×450 evidence includes descendant vertical scroll owners");
  assert.match(vibeAgentBrowserSource, /hostIsOnlyScrollOwner/, "720×450 evidence requires the host to be the only scroll owner");
  assert.match(vibeAgentBrowserSource, /footerVisible/, "720×450 evidence requires the footer inside host and viewport bounds");
  assert.match(vibeAgentBrowserSource, /buttonsReachable/, "720×450 evidence requires both Studio secondary targets in bounds");
  assert.match(vibeAgentBrowserSource, /await button\.focus\(\)/, "720×450 evidence focuses each Studio secondary action");
  const geometryIndex = vibeAgentBrowserSource.indexOf("record.detail.assertions = await inspectExactAgentHost");
  const screenshotIndex = vibeAgentBrowserSource.indexOf("await page.screenshot", geometryIndex);
  assert.ok(
    geometryIndex >= 0 && screenshotIndex > geometryIndex,
    "browser/mock screenshot is captured after the footer-reached geometry/focus assertions",
  );
  const fontsReadyIndex = vibeAgentBrowserSource.indexOf("await page.evaluate(() => document.fonts.ready)");
  const rootGeometryIndex = vibeAgentBrowserSource.indexOf("const rootGeometry = await page.evaluate", fontsReadyIndex);
  assert.ok(
    fontsReadyIndex >= 0 && rootGeometryIndex > fontsReadyIndex,
    "Vibe geometry settles fonts before measuring scroll ownership and capturing the frame",
  );
  assert.doesNotMatch(vibeAgentBrowserSource, /__rhoAutomation|acceptance-eval|\/eval\b/, "browser/mock does not widen the real-app bridge vocabulary");

  const hostStyleStart = vibeCssSource.indexOf(".rho-vibe-agent-record-host {");
  const hostStyleEnd = vibeCssSource.indexOf("}", hostStyleStart);
  assert.ok(hostStyleStart >= 0 && hostStyleEnd > hostStyleStart, "Vibe Agent host containment style is present");
  const hostStyle = vibeCssSource.slice(hostStyleStart, hostStyleEnd);
  assert.match(hostStyle, /min-width:\s*0/, "the local host can shrink without horizontal page overflow");
  assert.match(hostStyle, /height:\s*100%/, "the local host is bounded by the exploration region");
  assert.match(hostStyle, /min-height:\s*0/, "the local host may become a nested scroll container");
  assert.match(hostStyle, /overflow:\s*auto/, "the Agent record scrolls inside its Vibe host");
  assert.match(
    vibeCssSource,
    /@container \(max-width: 22rem\)[\s\S]*?\.rho-vibe-agent-record-actions button,[\s\S]*?width:\s*100%/,
    "narrow Agent record footer actions reflow to reachable full-width targets",
  );
}

console.log("Visual acceptance harness self-test passed (registry, startup/Vibe matrices, evidence integrity, JSONL/hash/env isolation, locks, fixtures, bridge fail-closed)");
