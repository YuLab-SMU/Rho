// S2: run the deterministic single-cell QC fixture in the real Workspace R
// session, prove its 240/217 data contract, and verify that the visualization
// execution adds exactly two records to the current Plots session.

import {
  assertEqual,
  assertIncludes,
  domainRecords,
  isolateSurfaces,
  openProject,
  openSurface,
  runConsole,
  sleep,
  sourceProjectFile,
  truncate,
  waitRuntimeReady,
  waitUntil,
} from "./helpers.mjs";

const QC_DIRECTORY = "examples/single-cell-qc";

function qcScript(fileName) {
  return `${QC_DIRECTORY}/${fileName}`;
}

async function waitForPlotsSurface(ctx) {
  return waitUntil("Plots surface loaded", async () => {
    const headers = await ctx.query('[data-surface-id="rho.plots"] .rho-domain-toolbar strong');
    const header = headers[0]?.text ?? "";
    return header.length > 0 && !header.includes("Loading") ? header : null;
  }, { timeoutMs: 30_000 });
}

export default async function s2(ctx) {
  await ctx.gate("s2", "qc-data-generation", async () => {
    await openProject(ctx, ctx.fixtures.workingProject);
    await waitRuntimeReady(ctx);
    await openSurface(ctx, "rho.console");

    const result = await sourceProjectFile(ctx, qcScript("01-generate-qc-data.R"));
    assertIncludes(result.preview, "Generated 240 cells across 4 samples.", "QC generation output");
    assertIncludes(result.preview, "Saved deterministic input to data/cell-qc.csv", "QC generation output");
    return {
      status: result.status,
      execution_id: result.execution_id,
      preview: truncate(result.preview, 300),
    };
  });

  await ctx.gate("s2", "qc-analysis", async () => {
    const result = await sourceProjectFile(ctx, qcScript("02-analyze-qc.R"));
    assertIncludes(result.preview, "QC result: 217 of 240 cells passed.", "QC analysis output");

    // Recompute the acceptance facts in the live session rather than relying
    // only on fixture prose. The marker also proves both generated files are
    // present under the active project root.
    const probe = await runConsole(ctx, [
      'cat("RHO_QC_ROWS=", nrow(cell_qc), "\\n", sep = "")',
      'cat("RHO_QC_PASS=", sum(cell_qc$qc_pass), "\\n", sep = "")',
      'cat("RHO_QC_SAMPLES=", length(unique(cell_qc$sample_id)), "\\n", sep = "")',
      'cat("RHO_QC_FILES=", file.exists("data/cell-qc.csv") && file.exists("output/qc-summary.csv"), "\\n", sep = "")',
    ].join("; "), { label: "QC acceptance probe" });
    assertIncludes(probe.preview, "RHO_QC_ROWS=240", "QC acceptance probe");
    assertIncludes(probe.preview, "RHO_QC_PASS=217", "QC acceptance probe");
    assertIncludes(probe.preview, "RHO_QC_SAMPLES=4", "QC acceptance probe");
    assertIncludes(probe.preview, "RHO_QC_FILES=TRUE", "QC acceptance probe");
    return {
      analysis_execution_id: result.execution_id,
      probe_execution_id: probe.execution_id,
      rows: 240,
      passing: 217,
      samples: 4,
      generated_files: ["data/cell-qc.csv", "output/qc-summary.csv"],
      preview: truncate(result.preview, 500),
    };
  });

  await ctx.gate("s2", "qc-two-plots", async () => {
    // Capture the session baseline first: S2 can run independently or after
    // S1, whose tour already creates one plot. Only records introduced by
    // 03-visualize-qc.R count toward the exact-two assertion.
    await openSurface(ctx, "rho.plots");
    await isolateSurfaces(ctx, ["rho.navigator", "rho.console", "rho.plots"]);
    const baselineHeader = await waitForPlotsSurface(ctx);
    const baseline = await domainRecords(ctx, "rho.plots");
    const baselineIds = new Set(baseline.map((record) => record.id));

    const result = await sourceProjectFile(ctx, qcScript("03-visualize-qc.R"));
    assertIncludes(result.preview, "Created two plots.", "QC visualization output");

    const records = await waitUntil("two new QC plot records", async () => {
      const found = await domainRecords(ctx, "rho.plots");
      const added = found.filter((record) => !baselineIds.has(record.id));
      return added.length >= 2 ? found : null;
    }, { timeoutMs: 45_000 });
    await sleep(3_000);

    const settled = await domainRecords(ctx, "rho.plots");
    const added = settled.filter((record) => !baselineIds.has(record.id));
    assertEqual(added.length, 2, "plots added by 03-visualize-qc.R");

    const thumbnails = await ctx.query(
      '[data-surface-id="rho.plots"] .rho-domain-output-image, [data-surface-id="rho.plots"] .rho-domain-output-preview',
      { all: true },
    );
    const previewUnavailable = added.filter((record) => record.text.includes("Preview unavailable")).length;
    return {
      execution_id: result.execution_id,
      baseline_header: baselineHeader,
      baseline_plot_count: baseline.length,
      session_plot_count: records.length,
      added_plot_count: added.length,
      added_plot_ids: added.map((record) => record.id),
      added_plots: added.map((record) => truncate(record.text, 300)),
      thumbnail_nodes: thumbnails.length,
      preview_unavailable: previewUnavailable,
      observation: previewUnavailable === 0
        ? "both new QC plot records have non-error thumbnail state"
        : `${previewUnavailable} new QC plot thumbnail(s) report Preview unavailable`,
    };
  }, {
    screenshot: "s2-qc-plots",
    criteria: [
      "Plots gallery 同时展示本次新增的两张 QC 图；`Preview unavailable` 或仅有占位符均判为失败",
      "library complexity 散点图可辨认绿色通过点、红色复核点，坐标标题为 Detected features / Total counts",
      "mitochondrial percentage 箱线图可辨认四个样本、20% 红色虚线阈值以及 Mitochondrial reads (%) 轴标题",
      "两张图的缩略图、记录元数据与状态互不遮挡，文本可读且没有页级横向滚动",
    ],
  });

  ctx.skipGate(
    "s2",
    "data-viewer-surface",
    "Removed gate authorized 2026-08-26: the current Studio workbench has no Data Viewer surface for search, sort, paging, or export; backend data-view commands do not constitute visual evidence.",
  );
}
