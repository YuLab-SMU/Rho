// S0: cold start, project open, and the first-view Navigator file tree.

import {
  assertIncludes,
  openProject,
  openSurface,
  waitReady,
  waitRuntimeReady,
} from "./helpers.mjs";

export default async function s0(ctx) {
  await ctx.gate("s0", "app-ready", async () => {
    const ready = await waitReady(ctx);
    return {
      kernelStatus: ready.kernelStatus,
      activeMode: ready.activeMode,
      restoredProject: ready.projectPath,
    };
  });

  await ctx.gate("s0", "project-open", async () => {
    const ready = await openProject(ctx, ctx.fixtures.workingProject);
    assertIncludes(ready.projectPath ?? "", "working-project", "ready().projectPath");
    // A Workspace R runtime must come up for the opened project; later
    // scenarios depend on this being reachable right after project open.
    const snapshot = await waitRuntimeReady(ctx);
    return {
      projectPath: ready.projectPath,
      kernelStatus: ready.kernelStatus,
      runtimes: snapshot.runtimes,
    };
  });

  await ctx.gate("s0", "navigator-file-tree", async () => {
    await openSurface(ctx, "rho.navigator");
    const files = await ctx.query('[data-surface-id="rho.navigator"] [data-nav-file]', {
      all: true,
      attribute: "data-nav-file",
    });
    const paths = files.map((file) => file.value ?? "");
    assertIncludes(paths.join("\n"), "examples/rho-workbench-tour.R", "Navigator file tree");
    assertIncludes(paths.join("\n"), "reports/cell-qc-report.Rmd", "Navigator file tree");
    const statusbar = await ctx.query(".rho-statusbar");
    assertIncludes(statusbar[0]?.text ?? "", "working-project", "status bar project path");
    return { fileCount: paths.length, statusbar: statusbar[0]?.text ?? null };
  }, {
    screenshot: "s0-first-view",
    criteria: [
      "Navigator 文件树层级清晰（examples/、reports/、.rho/ 等顶层目录可辨认，子项缩进正确）",
      "文件夹与文件的图标/字形和标签文本可读，无截断重叠",
      "底部状态栏显示 Workspace R 运行状态与当前项目路径",
      "整体布局无页级横向滚动条，无元素互相遮挡",
    ],
  });
}
