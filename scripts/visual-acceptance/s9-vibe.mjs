// S9: the Vibe information-flow workspace. This scenario is intentionally
// independent from the legacy Page-builder presentation and exercises the
// current manuscript -> autonomous exploration -> verification hierarchy in
// the real debug application. The real-app frames cover the durable new-Page,
// unlinked empty states, and wide/intermediate/focused/narrow hierarchy;
// irregular scientific content, exact targets, keyboard editing, and overflow
// are exercised by test-rsr-interactions.mjs.

import {
  AssertionFailure,
  assertEqual,
  openProject,
  sleep,
  waitForSelector,
  waitReady,
  waitUntil,
} from "./helpers.mjs";

export const VIBE_AGENT_HOST_VIEWPORT = Object.freeze({ width: 720, height: 450 });

export const VIBE_AGENT_HOST_SELECTORS = Object.freeze({
  exploration: '.rho-vibe-region[data-region="exploration"] .rho-vibe-exploration',
  detail: '.rho-vibe-region[data-region="exploration"] .rho-vibe-exploration-detail',
  trigger: '.rho-vibe-region[data-region="exploration"] [data-agent-record-trigger="record"]',
  startTrigger: '.rho-vibe-region[data-region="exploration"] [data-agent-record-trigger="start"]',
  host: '.rho-vibe-region[data-region="exploration"] .rho-vibe-agent-record-host',
  mountedAgentSurface: '[data-surface-id="rho.agent"]',
});

function normalizedPublicText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function sameAgentPublicRecord(source, host) {
  const exactFields = ["heading", "statusKind", "statusText", "task", "outcome", "error"];
  if (exactFields.some((field) => normalizedPublicText(source[field]) !== normalizedPublicText(host[field]))) {
    return false;
  }
  const latestActivity = normalizedPublicText(source.latestActivity);
  return latestActivity.length === 0
    || host.activities.some((activity) => normalizedPublicText(activity) === latestActivity);
}

async function firstText(ctx, selector) {
  const matches = await ctx.query(selector);
  return normalizedPublicText(matches[0]?.text);
}

function agentSurfaceCount(snapshot) {
  return snapshot.surfaces.filter((surface) => surface.surface_id === "rho.agent").length;
}

async function assertAgentHostBoundary(ctx, expectedCatalogCount) {
  const ready = await ctx.ready();
  assertEqual(ready.activeMode, "vibe", "Agent record host application mode");
  const workspaceSurfaces = await ctx.query(VIBE_AGENT_HOST_SELECTORS.mountedAgentSurface, { all: true });
  assertEqual(workspaceSurfaces.length, 0, "mounted Studio Agent surfaces while the Vibe host is open");
  const snapshot = await ctx.snapshot();
  assertEqual(
    agentSurfaceCount(snapshot),
    expectedCatalogCount,
    "Agent SurfaceInstance count after the local host entry",
  );
  const trustedControls = await ctx.query(
    `${VIBE_AGENT_HOST_SELECTORS.host} textarea, `
      + `${VIBE_AGENT_HOST_SELECTORS.host} .rho-agent-approval, `
      + `${VIBE_AGENT_HOST_SELECTORS.host} .rho-agent-file-proposal, `
      + `${VIBE_AGENT_HOST_SELECTORS.host} [data-surface-id]`,
    { all: true },
  );
  assertEqual(trustedControls.length, 0, "trusted Agent controls inside the Vibe record host");
  const boundary = await firstText(ctx, `${VIBE_AGENT_HOST_SELECTORS.host} .rho-vibe-agent-record-boundary`);
  if (!boundary.includes("只读公开记录") || !boundary.includes("Studio")) {
    throw new AssertionFailure("Vibe Agent host did not expose its read-only/Studio authority boundary.");
  }
  return snapshot;
}

async function assertWorkspaceState(ctx, expectedLayout, expectedRegion) {
  const layout = await ctx.query(".rho-vibe-workspace", { attribute: "data-layout" });
  const active = await ctx.query(".rho-vibe-workspace", { attribute: "data-active-region" });
  assertEqual(layout[0]?.value, expectedLayout, "Vibe layout mode");
  assertEqual(active[0]?.value, expectedRegion, "Vibe active information layer");
  const actionErrors = await ctx.query(".rho-action-error", { all: true });
  if (actionErrors.length > 0) {
    throw new AssertionFailure(
      `Vibe frame retained a Workbench action error: ${normalizedPublicText(actionErrors[0]?.text)}`,
    );
  }
}

async function settleVibe(ctx) {
  await waitForSelector(ctx, ".rho-vibe-workspace");
  await waitForSelector(
    ctx,
    ".rho-vibe-exploration-body, .rho-vibe-exploration-state-error, .rho-vibe-exploration-state-empty",
    30_000,
  );
  await waitForSelector(
    ctx,
    ".rho-vibe-verification-unlinked, .rho-vibe-verification-empty, .rho-vibe-verification-failed, .rho-vibe-verification-section",
    30_000,
  );
}

async function chooseRegion(ctx, region) {
  await ctx.act({
    kind: "click",
    selector: `.rho-vibe-region-switcher button[data-region="${region}"]`,
  });
  await waitForSelector(ctx, `.rho-vibe-workspace[data-layout="focus-${region}"]`);
  await sleep(300);
}

export async function enterVibeAfterProjectSwitch(ctx) {
  await ctx.act({ kind: "set_mode", mode: "vibe" });
  await waitUntil("Vibe mode active", async () => {
    const current = await ctx.ready();
    return current.activeMode === "vibe" ? current : null;
  }, { timeoutMs: 20_000 });
}

export default async function s9(ctx) {
  await ctx.gate("s9", "wide-overview", async () => {
    await openProject(ctx, ctx.fixtures.workingProject);
    await waitReady(ctx);
    await ctx.setWindow(1440, 900);
    await enterVibeAfterProjectSwitch(ctx);
    await settleVibe(ctx);
    await ctx.act({ kind: "click", selector: ".rho-vibe-overview-action" });
    await assertWorkspaceState(ctx, "overview", "manuscript");

    const regions = await ctx.query(".rho-vibe-region", { all: true, attribute: "data-region" });
    assertEqual(regions.length, 3, "Vibe semantic region count");
    assertEqual(regions.map((entry) => entry.value).join(","), "manuscript,exploration,verification", "Vibe DOM order");
    const correspondence = await ctx.query(".rho-vibe-correspondence");
    if (!(correspondence[0]?.text ?? "").includes("当前对应")) {
      throw new AssertionFailure("Vibe overview did not expose the correspondence boundary.");
    }
    return {
      layout: "overview",
      region_order: regions.map((entry) => entry.value),
      correspondence: correspondence[0]?.text ?? "",
    };
  }, {
    screenshot: "s9-vibe-overview",
    criteria: [
      "1440×900 下手稿、自主探索、查验与结论按 40/35/25 信息层级呈现，三者是连续工作流而非等权卡片墙",
      "手稿拥有首要阅读权重；自主探索呈现 Agent 记录而非聊天气泡；查验区明确候选产物与科学结论的边界",
      "整体沿用 Rho 黑灰白与状态色、紧凑间距和细分隔线，无渐变、装饰阴影、大圆角或页级横向溢出",
    ],
  });

  await ctx.gate("s9", "intermediate-overview", async () => {
    await ctx.setWindow(900, 800);
    await ctx.act({ kind: "click", selector: ".rho-vibe-overview-action" });
    await assertWorkspaceState(ctx, "overview", "manuscript");
    const previews = await ctx.query(
      '.rho-vibe-region[data-active="false"] .rho-vibe-region-header',
      { all: true },
    );
    assertEqual(previews.length, 2, "intermediate Vibe preview-band count");
    return { layout: "overview", active_region: "manuscript", preview_bands: previews.length };
  }, {
    screenshot: "s9-vibe-intermediate-overview",
    criteria: [
      "900×800 下当前手稿保持完整主阅读面，另外两层收束为清楚可点击的预览带，而不是把三份完整正文挤进窄列",
      "预览带仍说明自主探索与查验职责，用户可直接进入目标层；当前对应关系保持可见",
      "中间宽度无页级横向滚动、重叠或截断，也不引入卡片墙、聊天气泡和装饰性效果",
    ],
  });

  for (const region of ["manuscript", "exploration", "verification"]) {
    await ctx.gate("s9", `focus-${region}`, async () => {
      await ctx.setWindow(1440, 900);
      await chooseRegion(ctx, region);
      await assertWorkspaceState(ctx, `focus-${region}`, region);
      return { layout: `focus-${region}`, active_region: region };
    }, {
      screenshot: `s9-vibe-focus-${region}`,
      criteria: [
        `聚焦 ${region} 时目标信息层占据主阅读宽度，另外两层退为可辨认的返回入口而不伪装成关闭或丢失`,
        "聚焦只改变呈现，不显示虚构的科学状态、因果路径或内部 ID 墙",
        "区域标题、正文、状态和操作无重叠、截断或装饰性容器堆叠",
      ],
    });
  }

  await ctx.gate("s9", "empty-agent-record-host", async () => {
    // S3 may have created a truthful Agent record for workingProject earlier
    // in a full-lane run. Use the separate Unicode fixture project so this
    // real-app frame deterministically owns only the honest no-record state.
    const ready = await openProject(ctx, ctx.fixtures.unicodeProject);
    await waitReady(ctx);
    await enterVibeAfterProjectSwitch(ctx);
    await settleVibe(ctx);
    await ctx.setWindow(1440, 900);
    await chooseRegion(ctx, "exploration");
    await waitForSelector(ctx, VIBE_AGENT_HOST_SELECTORS.startTrigger, 30_000);
    const recordTriggers = await ctx.query(VIBE_AGENT_HOST_SELECTORS.trigger, { all: true });
    if (recordTriggers.length !== 0) {
      throw new AssertionFailure(
        "Fresh real-debug S9 unexpectedly contained an Agent record; its exact-record evidence belongs to browser_mock.",
      );
    }
    const before = await ctx.snapshot();
    const agentCatalogCount = agentSurfaceCount(before);
    const mountedBefore = await ctx.query(VIBE_AGENT_HOST_SELECTORS.mountedAgentSurface, { all: true });
    assertEqual(mountedBefore.length, 0, "mounted Studio Agent surfaces before the local host entry");

    await ctx.act({ kind: "click", selector: VIBE_AGENT_HOST_SELECTORS.startTrigger });
    await waitForSelector(ctx, VIBE_AGENT_HOST_SELECTORS.host, 20_000);
    await waitForSelector(ctx, `${VIBE_AGENT_HOST_SELECTORS.exploration}[data-agent-host-open="true"]`, 20_000);
    await assertWorkspaceState(ctx, "focus-exploration", "exploration");
    await assertAgentHostBoundary(ctx, agentCatalogCount);

    const heading = await firstText(ctx, `${VIBE_AGENT_HOST_SELECTORS.host} h3`);
    assertEqual(heading, "准备新的探索", "fresh real-debug Agent host heading");
    const emptyState = await firstText(ctx, `${VIBE_AGENT_HOST_SELECTORS.host} .rho-vibe-agent-record-empty`);
    if (!emptyState.includes("还没有 Agent 记录") || !emptyState.includes("明确进入 Studio")) {
      throw new AssertionFailure("Fresh real-debug Agent host did not preserve the honest no-record state.");
    }
    const secondaryActions = await ctx.query(
      `${VIBE_AGENT_HOST_SELECTORS.host} .rho-vibe-agent-record-actions button`,
      { all: true },
    );
    const labels = secondaryActions.map((action) => normalizedPublicText(action.text));
    assertEqual(
      labels.join(","),
      "在 Studio 中发起探索",
      "fresh-host explicit Studio secondary action",
    );
    return {
      evidence_class: "real_debug_app",
      project_path: ready.projectPath,
      active_mode: "vibe",
      layout: "focus-exploration",
      mounted_studio_agent_surfaces: 0,
      agent_surface_instance_count_before: agentCatalogCount,
      agent_surface_instance_count_after: agentCatalogCount,
      record_state: "empty",
      heading,
      studio_secondary_actions: labels,
      evidence_boundary:
        "fresh isolated real-app data proves only the state-specific empty host; exact Conversation/Turn and geometry are browser_mock facts",
    };
  }, {
    screenshot: "s9-vibe-empty-agent-record-host",
    criteria: [
      "fresh isolated app-data 下，`开始探索` 在自主探索层内打开诚实的空 Agent host，应用仍处于 Vibe，未伪造 Conversation、Turn、活动或结果",
      "画面中没有 Studio canvas、rho.agent Surface、composer、approval、file apply/undo、credential、设置或其他可信 mutation controls",
      "只读边界明确说明可信操作仍在 Studio；唯一离开动作清楚标为 `在 Studio 中发起探索`",
      "1440×900 下空 host 使用探索层的可用空间，header、空态与 footer 构成连续阅读面，无页级横向滚动、重叠或装饰性卡片墙",
    ],
  });

  await ctx.gate("s9", "narrow-verification", async () => {
    await ctx.setWindow(720, 700);
    await chooseRegion(ctx, "verification");
    await assertWorkspaceState(ctx, "focus-verification", "verification");
    const switcher = await ctx.query(".rho-vibe-region-switcher button[data-region]", {
      all: true,
      attribute: "data-region",
    });
    assertEqual(switcher.length, 3, "narrow Vibe region switcher count");
    return { layout: "focus-verification", switcher: switcher.map((entry) => entry.value) };
  }, {
    screenshot: "s9-vibe-narrow-verification",
    criteria: [
      "720×700 下只展开查验与结论层，三层切换器仍完整可达，DOM/阅读顺序仍为手稿→自主探索→查验与结论",
      "空态说明、当前对应、导出动作与状态栏在单层阅读面内完整可见，无页级横向滚动或控件遮挡",
      "窄屏保持科学编辑工作台的密度，不退化为聊天界面、卡片列表或居中 hero",
    ],
  });

  // Fresh real app-data has no authoritative Conversation/Turn to project.
  // The exact-record and arbitrary geometry facts therefore come from the
  // separately labelled browser/mock fixture, never from this real-app frame.
  await ctx.captureVibeAgentBrowserFrames();
}
