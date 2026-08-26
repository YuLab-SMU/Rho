// S8: restart persistence, project isolation, bounded project discovery,
// oversized-file refusal, and the three documented visual review sizes.

import fs from "node:fs";
import path from "node:path";

import {
  AssertionFailure,
  assertEqual,
  assertIncludes,
  openProject,
  openSurface,
  runConsole,
  sleep,
  sourceProjectFile,
  truncate,
  waitReady,
  waitRuntimeReady,
  waitUntil,
  withTimeout,
} from "./helpers.mjs";

const CONSOLE_DRAFT = "# RHO_S8_RESTART_DRAFT (intentionally unsent)";
const CONSOLE_INPUT = '[data-surface-id="rho.console"] textarea[aria-label^="Code for "]';

function resolved(value) {
  return path.resolve(String(value));
}

async function consoleDraft(ctx) {
  const result = await waitUntil("Console draft input", async () => {
    const matches = await withTimeout(ctx.query(CONSOLE_INPUT), 10_000, "Console draft query");
    return matches.length > 0 ? { value: matches[0]?.value ?? "" } : null;
  }, { timeoutMs: 30_000 });
  return result.value;
}

async function prepareReviewLayout(ctx) {
  await openProject(ctx, ctx.fixtures.workingProject);
  await waitRuntimeReady(ctx);
  const ready = await ctx.ready();
  if (ready.activeMode !== "studio") {
    await ctx.act({ kind: "set_mode", mode: "studio" });
    await waitUntil("Studio mode active", async () => {
      const current = await ctx.ready();
      return current.activeMode === "studio" ? true : null;
    }, { timeoutMs: 20_000 });
  }
  // open_surface focuses an existing placement through an asynchronous
  // profile mutation. Avoid emitting redundant focus mutations for the
  // default Navigator/Console pair; back-to-back profile writes would race
  // their expected revision in the real app.
  for (const surfaceId of ["rho.navigator", "rho.console"]) {
    const mounted = await ctx.query(`[data-surface-id="${surfaceId}"]`);
    if (mounted.length === 0) await openSurface(ctx, surfaceId);
  }
}

async function reviewWindow(ctx, width, height) {
  const resized = await ctx.setWindow(width, height);
  await sleep(1_000);
  const shell = await ctx.query(".rho-studio-shell");
  if (shell.length === 0) throw new AssertionFailure("Studio shell disappeared after window resize");
  const ready = await withTimeout(ctx.ready(), 10_000, "ready after window resize");
  return {
    requestedLogicalSize: { width, height },
    bridgeResponse: resized,
    activeProject: ready.projectPath,
    activeMode: ready.activeMode,
    deterministicLayoutLimit: "the fixed automation vocabulary cannot read scrollWidth/clientWidth; overlap and page-level overflow are decided by the per-frame visual verdict",
  };
}

export default async function s8(ctx) {
  await ctx.gate("s8", "restart-persistence", async () => {
    await prepareReviewLayout(ctx);
    await ctx.act({ kind: "type", selector: CONSOLE_INPUT, text: CONSOLE_DRAFT });
    assertEqual(await consoleDraft(ctx), CONSOLE_DRAFT, "Console draft before restart");
    // Moving focus to a real toolbar button triggers the Console's onBlur
    // persistence path without submitting the draft.
    await ctx.act({
      kind: "click",
      selector: '[data-surface-id="rho.navigator"] [aria-label="More actions for Navigator"]',
    });
    await sleep(1_000);

    await ctx.restart();
    const ready = await waitReady(ctx, 120_000);
    assertEqual(resolved(ready.projectPath), resolved(ctx.fixtures.workingProject), "restored project");
    assertEqual(ready.activeMode, "studio", "restored workspace mode");
    const restoredDraft = await consoleDraft(ctx);
    const draftRestored = restoredDraft === CONSOLE_DRAFT;
    if (!draftRestored) {
      throw new AssertionFailure(
        `restart persistence: unsent Console draft restored as ${JSON.stringify(restoredDraft)} instead of ${JSON.stringify(CONSOLE_DRAFT)}`,
      );
    }
    return {
      projectPath: ready.projectPath,
      activeMode: ready.activeMode,
      restoredDraft,
      draftRestored,
      observation: draftRestored
        ? "active project, Studio mode, and the unsent Console draft survived a real process restart"
        : "active project and Studio mode survived restart, but the persisted unsent Console draft restored empty (recorded product gap)",
    };
  }, {
    fatal: false,
    screenshot: "s8-restart",
    criteria: [
      "重启后状态栏仍显示 working-project，Workspace R 状态清晰且无错误遮挡",
      "Console 输入框保留未提交的 RHO_S8_RESTART_DRAFT 文本，未被误执行为 transcript",
      "Navigator、Console 与状态栏恢复为可用布局，无重复 surface 或空白占位异常",
    ],
  });

  await ctx.gate("s8", "unicode-project", async () => {
    const ready = await openProject(ctx, ctx.fixtures.unicodeProject);
    await waitRuntimeReady(ctx);
    assertEqual(resolved(ready.projectPath), resolved(ctx.fixtures.unicodeProject), "Unicode project path");
    const generated = await sourceProjectFile(ctx, "examples/single-cell-qc/01-generate-qc-data.R");
    assertIncludes(generated.preview, "Generated 240 cells across 4 samples", "Unicode QC generator");
    const marker = await runConsole(
      ctx,
      'rho_s8_unicode_marker <- normalizePath(getwd(), winslash = "/", mustWork = TRUE); cat("RHO_S8_UNICODE_MARKER=", rho_s8_unicode_marker, "\\n", sep = "")',
      { label: "Unicode project marker" },
    );
    assertIncludes(marker.preview, "路径 含 空格/acceptance-project", "Unicode marker output");
    const generatedFile = path.join(ctx.fixtures.unicodeProject, "data", "cell-qc.csv");
    if (!fs.existsSync(generatedFile)) {
      throw new AssertionFailure("Unicode project QC generator did not create data/cell-qc.csv");
    }
    await openSurface(ctx, "rho.navigator");
    return {
      projectPath: ready.projectPath,
      generatedFile: path.relative(ctx.fixtures.unicodeProject, generatedFile),
      markerPreview: truncate(marker.preview, 300),
    };
  }, {
    screenshot: "s8-unicode-project",
    criteria: [
      "状态栏完整、可辨认地显示包含中文和空格的 路径 含 空格/acceptance-project，路径不与状态项重叠",
      "Navigator 与 Console 在 Unicode 项目下正常呈现，不出现乱码、替换字符或错误折行",
      "QC 生成后的项目仍保持可交互，surface chrome 和底部状态栏无裁切",
    ],
  });

  await ctx.gate("s8", "project-isolation", async () => {
    const ready = await openProject(ctx, ctx.fixtures.workingProject);
    await waitRuntimeReady(ctx);
    assertEqual(resolved(ready.projectPath), resolved(ctx.fixtures.workingProject), "working project path");
    const directory = await waitUntil("working-project runtime directory", async () => {
      const result = await runConsole(
        ctx,
        'cat("RHO_S8_GETWD=", normalizePath(getwd(), winslash = "/", mustWork = TRUE), "\\n", sep = "")',
        { label: "working-project directory probe" },
      );
      return result.preview.includes(resolved(ctx.fixtures.workingProject)) ? result : null;
    }, { timeoutMs: 60_000, intervalMs: 1_000 });
    const probe = await runConsole(
      ctx,
      'cat("RHO_S8_CROSS_PROJECT=", exists("rho_s8_unicode_marker", envir = .GlobalEnv, inherits = FALSE), "\\n", sep = "")',
      { label: "cross-project workspace probe" },
    );
    const isolated = probe.preview.includes("RHO_S8_CROSS_PROJECT=FALSE");
    if (!isolated) {
      throw new AssertionFailure(
        `project isolation: Runtime directory switched to working-project, but probe returned ${JSON.stringify(truncate(probe.preview, 240))}`,
      );
    }
    return {
      activeProject: (await ctx.ready()).projectPath,
      unicodeGeneratedFileStillExists: fs.existsSync(
        path.join(ctx.fixtures.unicodeProject, "data", "cell-qc.csv"),
      ),
      runtimeDirectory: truncate(directory.preview, 240),
      workspaceProbe: truncate(probe.preview, 240),
      isolated,
      observation: isolated
        ? "the Unicode project's R marker is absent after switching back to working-project"
        : "the Runtime changed getwd() to working-project but retained the Unicode project's GlobalEnv marker (recorded cross-project workspace leak)",
    };
  }, { fatal: false });

  await ctx.gate("s8", "large-project-bound", async () => {
    await openProject(ctx, ctx.fixtures.largeProject);
    await openSurface(ctx, "rho.navigator");
    const snapshot = await waitUntil("large-project Resource bound", async () => {
      const value = await withTimeout(ctx.snapshot(), 10_000, "large-project snapshot");
      return value.counts.resources > 0 ? value : null;
    }, { timeoutMs: 60_000 });
    const sourceFileCount = fs.readdirSync(ctx.fixtures.largeProject)
      .filter((name) => name.endsWith(".R")).length;
    assertEqual(sourceFileCount, 2_100, "large-project fixture source count");
    assertEqual(snapshot.counts.resources, 2_000, "bounded Resource count");
    const navigator = await ctx.query('[data-surface-id="rho.navigator"]');
    const navigatorText = navigator[0]?.text ?? "";
    const warningVisible = /(?:showing the first|truncat|file limit|too many files|2,000 files)/iu.test(
      `${navigatorText}\n${snapshot.visibleText}`,
    );
    if (!warningVisible) {
      throw new AssertionFailure(
        "large-project bound: discovery capped at 2,000 Resources but Navigator exposed no truncation warning",
      );
    }
    return {
      fixtureSourceFiles: sourceFileCount,
      projectedResources: snapshot.counts.resources,
      warningVisible,
      navigatorText: truncate(navigatorText, 500),
      observation: warningVisible
        ? "Navigator exposes the documented bounded-discovery warning"
        : "project discovery is correctly capped at 2,000 Resources, but the current Navigator exposes no truncation warning (recorded product gap)",
    };
  }, {
    fatal: false,
    screenshot: "s8-large-project",
    criteria: [
      "对照 detail.fixtureSourceFiles=2100 与 projectedResources=2000 复核有界发现；若无 warning，必须按 detail.observation 记录为当前产品缺口",
      "2,000 条 Resource 的边界项目仍保持 Navigator 可滚动、标签对齐，无冻结、重叠或页级横向滚动",
    ],
  });

  await ctx.gate("s8", "oversized-file-refusal", async () => {
    await openProject(ctx, ctx.fixtures.oversizedProject);
    await openSurface(ctx, "rho.navigator");
    await waitUntil("oversized file in Navigator", async () => {
      const matches = await ctx.query('[data-nav-file="over-8MiB.txt"]');
      return matches.length > 0 ? true : null;
    }, { timeoutMs: 30_000 });
    await ctx.act({ kind: "click", selector: '[data-nav-file="over-8MiB.txt"]' });
    const refusal = await waitUntil("oversized-file refusal", async () => {
      const errors = await ctx.query(".rho-resource-error", { all: true });
      const text = errors.map((error) => error.text ?? "").join("\n");
      return /too large/iu.test(text) ? text : null;
    }, { timeoutMs: 30_000 });
    assertIncludes(refusal.toLowerCase(), "too large", "oversized-file refusal");
    return {
      fileBytes: fs.statSync(path.join(ctx.fixtures.oversizedProject, "over-8MiB.txt")).size,
      refusal: truncate(refusal, 500),
      observation: "the 9 MiB file stays unopened and the source surface reports the 8 MiB boundary truthfully",
    };
  }, {
    screenshot: "s8-oversized-refusal",
    criteria: [
      "9 MiB 文件没有渲染为编辑器内容；显式 refusal 文本说明文件过大且可读",
      "错误状态位于目标 file surface 内，不被工具栏遮挡，不造成整体布局溢出",
    ],
  });

  await prepareReviewLayout(ctx);
  await ctx.gate("s8", "window-900x700", () => reviewWindow(ctx, 900, 700), {
    screenshot: "s8-window-900x700",
    criteria: [
      "900×700 下无 surface、菜单、状态栏或 Console composer 相互遮挡",
      "页面级无横向滚动；窄 surface 按设计压缩/换行，关键操作仍可辨认",
      "工作区仍是视觉主区域，Navigator 与底部状态信息保持可用",
    ],
  });
  await ctx.gate("s8", "window-1024x680", () => reviewWindow(ctx, 1024, 680), {
    screenshot: "s8-window-1024x680",
    criteria: [
      "1024×680 下无重叠、裁切或页面级横向滚动，Console 输入与 Run 操作完整可见",
      "Surface 标题栏、dock tab 和底部状态栏文字清楚，长项目路径采用可理解的收缩策略",
      "工作区层级清晰，空白和间距没有挤压成不可用控件",
    ],
  });
  await ctx.gate("s8", "window-1920x1080", () => reviewWindow(ctx, 1920, 1080), {
    screenshot: "s8-window-1920x1080",
    criteria: [
      "1920×1080 下主工作 surface 占据主要视觉面积，不出现无意义的大块 chrome 或失衡留白",
      "Navigator、Console、Agent/Environment 与状态栏的层级和分隔清晰，文本密度舒适",
      "整体无重叠、裁切或页级横向滚动，高分辨率下边线和字号仍清晰",
    ],
  });

  ctx.skipGate(
    "s8",
    "windows-installer-human-observation",
    "removed gate (2026-08-26 authorization): SmartScreen wording, Windows Credential Manager contents, 125% display scaling, and uninstall behavior require human observation; this removal does not replace exact-candidate installation, signing, distribution, or release gates",
  );
  ctx.skipGate(
    "s8",
    "keyboard-only-human-sweep",
    "removed gate (2026-08-26 authorization): the keyboard-only navigation and shortcut sweep requires human observation and is not asserted as automated evidence",
  );
}
