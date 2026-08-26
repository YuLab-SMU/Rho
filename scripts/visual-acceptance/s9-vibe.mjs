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

async function assertWorkspaceState(ctx, expectedLayout, expectedRegion) {
  const layout = await ctx.query(".rho-vibe-workspace", { attribute: "data-layout" });
  const active = await ctx.query(".rho-vibe-workspace", { attribute: "data-active-region" });
  assertEqual(layout[0]?.value, expectedLayout, "Vibe layout mode");
  assertEqual(active[0]?.value, expectedRegion, "Vibe active information layer");
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

async function enterVibeAfterProjectSwitch(ctx) {
  try {
    await ctx.act({ kind: "set_mode", mode: "vibe" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("stale revision")) throw error;
    // Workbench's rejected mutation refreshes the Profile store before the
    // bridge receives this error. One retry therefore uses the reconciled
    // revision; a second rejection remains a real gate failure.
    await ctx.act({ kind: "set_mode", mode: "vibe" });
  }
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
}
