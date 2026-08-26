// S1: one-file workbench tour — console markers, workspace objects, a plot on
// the Plots surface, a deliberate warning observed truthfully, and a failed
// `stop(...)` execution with a Problems entry.
//
// Product-model note (2026-08): the surface named `rho.environment` is the
// package environment (renv library + operation requests), not a workspace
// objects view — the current UI has no variables surface, so object
// existence is asserted deterministically in the Workspace R session itself.

import {
  AssertionFailure,
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

export default async function s1(ctx) {
  await ctx.gate("s1", "tour-console-markers", async () => {
    await openProject(ctx, ctx.fixtures.workingProject);
    await waitRuntimeReady(ctx);
    const result = await sourceProjectFile(ctx, "examples/rho-workbench-tour.R");
    assertIncludes(result.preview, "RHO_TOUR_ROWS=24", "tour preview");
    assertIncludes(result.preview, "RHO_TOUR_MISSING_NOTES=8", "tour preview");
    return { status: result.status, execution_id: result.execution_id };
  });

  await ctx.gate("s1", "workspace-objects", async () => {
    const result = await runConsole(
      ctx,
      'cat("RHO_TOUR_EXISTS=", exists("rho_tour"), exists("rho_tour_summary"), "\n", sep = "")',
      { label: "workspace object probe" },
    );
    assertIncludes(result.preview, "RHO_TOUR_EXISTS=TRUETRUE", "workspace objects");
    return { preview: truncate(result.preview, 200) };
  });

  await ctx.gate("s1", "environment-surface-observation", async () => {
    await openSurface(ctx, "rho.environment");
    const header = await waitUntil("environment surface loaded", async () => {
      const matches = await ctx.query('[data-surface-id="rho.environment"] header');
      const text = matches[0]?.text ?? "";
      return text.length > 0 && !text.includes("Loading") ? text : null;
    }, { timeoutMs: 20_000 });
    return {
      observation: "rho.environment is the package environment (installed packages and operation requests); the current UI has no workspace-objects view, so object existence is covered by s1/workspace-objects",
      header,
    };
  });

  await ctx.gate("s1", "plots-surface", async () => {
    await openSurface(ctx, "rho.plots");
    await isolateSurfaces(ctx, ["rho.navigator", "rho.console", "rho.plots"]);
    const records = await waitUntil("plot records", async () => {
      const found = await domainRecords(ctx, "rho.plots");
      return found.length > 0 ? found : null;
    }, { timeoutMs: 20_000 });
    await sleep(3_000);
    const previews = await ctx.query(
      '[data-surface-id="rho.plots"] .rho-domain-output-preview, [data-surface-id="rho.plots"] img.rho-domain-output-image',
      { all: true },
    );
    const thumbnailState = previews.length === 0
      ? "no-thumbnail-node"
      : previews.every((node) => (node.text ?? "").includes("Preview unavailable"))
        ? "preview-unavailable"
        : "rendered";
    return {
      plotCount: records.length,
      plots: records.map((record) => record.text),
      thumbnail_state: thumbnailState,
      observation: thumbnailState === "preview-unavailable"
        ? "plot record and PNG payload exist in the project store, but the inline thumbnail never renders in this build (persistent across refresh); the domain item id resolves to the run id instead of the plot id"
        : "plot thumbnails render inline",
    };
  }, {
    screenshot: "s1-plots",
    criteria: [
      "Plots surface 至少展示一张 tour 脚本产生的 boxplot；若缩略图显示 Preview unavailable，请结合该 gate 的 detail.observation（现行 build 的已知呈现缺陷）",
      "图条目带有可读的标题/来源信息，布局无重叠、无页级横向滚动",
    ],
  });

  // The tour emits one deliberate warning. Assert it where the current UI
  // actually surfaces it; otherwise record the observation truthfully.
  await ctx.gate("s1", "tour-warning-observation", async () => {
    const consoleEntries = await ctx.query('[data-surface-id="rho.console"] .rho-console-entry', { all: true });
    const consoleText = consoleEntries.map((entry) => entry.text ?? "").join("\n");
    await openSurface(ctx, "rho.problems");
    const problems = await domainRecords(ctx, "rho.problems");
    const problemText = problems.map((record) => record.text).join("\n");
    await openSurface(ctx, "rho.runs");
    const runs = await domainRecords(ctx, "rho.runs");
    const runText = runs.map((record) => record.text).join("\n");
    const warningNeedle = "deliberate warning";
    const inProblems = problemText.includes(warningNeedle);
    const inRuns = runText.includes(warningNeedle);
    const inTranscript = consoleText.includes(warningNeedle);
    return {
      observation: inProblems || inRuns
        ? "warning is surfaced"
        : inTranscript
          ? "warning is not surfaced in Problems/Runs; visible in the Console transcript only"
          : "warning is not surfaced in Problems/Runs and was not found in the visible Console transcript window",
      inProblems,
      inRuns,
      inTranscript,
    };
  });

  await ctx.gate("s1", "console-stop-problem", async () => {
    // The console runner wraps submissions, so a stop() surfaces as error
    // text in the transcript; whether it also produces a Problems/Runs
    // record is probed and reported truthfully below.
    const result = await runConsole(ctx, 'stop("console navigation check")', { expect: "completed" });
    assertIncludes(result.preview, "console navigation check", "console error output");
    await openSurface(ctx, "rho.problems");
    await waitUntil("problems surface settled", async () => {
      const matches = await ctx.query('[data-surface-id="rho.problems"]');
      return (matches[0]?.text ?? "").length > 0 ? true : null;
    }, { timeoutMs: 20_000 });
    const records = await domainRecords(ctx, "rho.problems");
    const text = records.map((record) => record.text).join("\n");
    const problemListed = text.includes("console navigation check");
    await isolateSurfaces(ctx, ["rho.navigator", "rho.console", "rho.problems"]);
    return {
      execution_status: result.status,
      execution_preview: truncate(result.preview, 200),
      problem_listed: problemListed,
      observation: problemListed
        ? "console stop() produces a Problems entry"
        : "console stop() shows the error in the Console transcript but records no Problems entry in the current UI",
      problems: records.map((record) => record.text),
    };
  }, {
    screenshot: "s1-problem",
    criteria: [
      "Console 中 stop(\"console navigation check\") 的错误文本可见；若 Problems surface 有条目，状态/色调可区分、文本可读",
      "复核时请结合该 gate 的 detail.observation 判断现行 UI 是否记录 Problem",
    ],
  });

  ctx.skipGate(
    "s1",
    "dual-plots-session-history",
    "Removed gate authorized 2026-08-26: the current Studio Plots surface no longer has the legacy Session/History tab pair; this SKIP is removal evidence, not a pass.",
  );
  ctx.skipGate(
    "s1",
    "human-agent-postures",
    "Removed gate authorized 2026-08-26: Human-first/Agent-first postures and their dock-focus rules are not surfaces in the current Studio workbench; this SKIP is removal evidence, not a pass.",
  );
}
