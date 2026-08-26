// S7: read-only Git review. The fixture is changed out-of-band, read-only Git
// commands provide the deterministic oracle, and the current rho.git surface
// is inspected without inventing stage/restore/commit controls.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  AssertionFailure,
  assertIncludes,
  domainRecords,
  openProject,
  openSurface,
  sleep,
  truncate,
  waitUntil,
  withTimeout,
} from "./helpers.mjs";

const REMOVED_GATE_REASON =
  "removed gate (2026-08-26 authorization): reviewable Git mutations have no current-UI surface";

function git(project, args) {
  return execFileSync("git", ["-C", project, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function gitSurfaceText(ctx, timeoutMs = 20_000) {
  await ctx.act({ kind: "click", selector: '[aria-label="Refresh rho.git"]' }).catch(() => undefined);
  return waitUntil("Git surface settled", async () => {
    const matches = await withTimeout(
      ctx.query('[data-surface-id="rho.git"]'),
      10_000,
      "Git surface query",
    );
    const text = matches[0]?.text ?? "";
    return text.length > 0 && !text.includes("Loading") ? text : null;
  }, { timeoutMs });
}

async function focusedGitInstance(ctx) {
  const matches = await ctx.query('[data-surface-id="rho.git"]', {
    attribute: "data-instance-id",
  });
  const instanceId = matches[0]?.value;
  if (typeof instanceId !== "string" || instanceId.length === 0) {
    throw new AssertionFailure("mounted rho.git surface has no data-instance-id");
  }
  return instanceId;
}

async function setGitMode(ctx, modeId) {
  await openSurface(ctx, "rho.git");
  const instanceId = await focusedGitInstance(ctx);
  const currentMode = async () => {
    const snapshot = await withTimeout(ctx.snapshot(), 10_000, "Git mode snapshot");
    return snapshot.surfaces.find((surface) => surface.instance_id === instanceId)?.mode_id ?? null;
  };
  if (await currentMode() === modeId) return instanceId;

  await ctx.act({ kind: "click", selector: '[data-surface-id="rho.git"] [aria-label="More actions for Git"]' });
  const choices = await ctx.query(
    '[data-surface-id="rho.git"] .rho-menu-popover-panel button[aria-pressed]',
    { all: true, attribute: "aria-pressed" },
  );
  const target = choices.find((choice) => choice.text.trim().replace(/^✓\s*/u, "") ===
    (modeId === "history" ? "History" : "Changes"));
  if (target == null) {
    throw new AssertionFailure(`Git ${modeId} mode control is unavailable`);
  }
  // Exactly one alternate Git mode is aria-pressed=false. The fixed
  // automation vocabulary intentionally does not accept arbitrary text
  // selectors, so target that bounded control after verifying its label.
  await ctx.act({
    kind: "click",
    selector: '[data-surface-id="rho.git"] .rho-menu-popover-panel button[aria-pressed="false"]',
  });
  await waitUntil(`Git mode ${modeId}`, async () => (await currentMode()) === modeId, {
    timeoutMs: 20_000,
  });
  return instanceId;
}

export default async function s7(ctx) {
  await ctx.gate("s7", "status-changes", async () => {
    await openProject(ctx, ctx.fixtures.workingProject);
    const demoFile = path.join(ctx.fixtures.workingProject, "examples", "git-review-demo.txt");
    const baseline = fs.readFileSync(demoFile, "utf8");
    const edited = baseline
      .replace(
        "This line is intentionally plain so it can be edited.",
        "This line was edited out-of-band by the visual acceptance lane (first hunk).",
      )
      .replace(
        "Edit this line separately to create a second diff hunk.",
        "Edited out-of-band by the visual acceptance lane to create a second diff hunk.",
      );
    if (edited === baseline) {
      throw new AssertionFailure("git-review-demo.txt fixture sentences not found; fixture drifted");
    }
    fs.writeFileSync(demoFile, edited);
    const notesDirectory = path.join(ctx.fixtures.workingProject, "notes");
    fs.mkdirSync(notesDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(notesDirectory, "manual-review.md"),
      "# Manual review notes\n\nUntracked file created by the s7 visual acceptance lane.\n",
    );

    const porcelain = git(ctx.fixtures.workingProject, [
      "status", "--porcelain", "--untracked-files=all",
    ]);
    assertIncludes(porcelain, " M examples/git-review-demo.txt", "read-only Git status oracle");
    assertIncludes(porcelain, "?? notes/manual-review.md", "read-only Git status oracle");
    await sleep(1_000);

    await setGitMode(ctx, "changes");
    const surfaceText = await gitSurfaceText(ctx);
    const branchVisible = /\bmain\b/u.test(surfaceText);
    const changesVisible = surfaceText.includes("modified") || surfaceText.includes("untracked");
    const emptyState = surfaceText.includes("No repository entries");
    if (!branchVisible || !changesVisible) {
      throw new AssertionFailure(
        `rho.git status visibility: read-only oracle reports branch main with 1 modified + 1 untracked file, but surface rendered ${JSON.stringify(truncate(surfaceText, 300))}`,
      );
    }
    return {
      oracle: { branch: "main", modified: 1, untracked: 1 },
      branchVisible,
      changesVisible,
      emptyState,
      surfaceText: truncate(surfaceText, 500),
      observation: changesVisible && branchVisible
        ? "rho.git Changes shows the read-only branch and working-tree counts"
        : "rho.git Changes renders an empty state although the read-only oracle reports 1 modified + 1 untracked file; the status object is currently dropped while domain records are collected (recorded product gap)",
    };
  }, {
    fatal: false,
    screenshot: "s7-status",
    criteria: [
      "对照 detail.oracle 与 detail.observation 复核 rho.git Changes 的真实呈现；若为空态，不把缺失的 status/diff 伪记为可见",
      "Git surface 的标题、空态或记录均可读，无重叠、裁切或页级横向滚动",
    ],
  });

  await ctx.gate("s7", "history-log", async () => {
    const oracleLog = git(ctx.fixtures.workingProject, ["log", "-1", "--pretty=%s"]).trim();
    assertIncludes(oracleLog, "test: acceptance project baseline", "read-only Git log oracle");
    await setGitMode(ctx, "history");
    const records = await waitUntil("Git history records", async () => {
      const found = await domainRecords(ctx, "rho.git");
      return found.length > 0 ? found : null;
    }, { timeoutMs: 20_000 });
    const text = records.map((record) => record.text).join("\n");
    assertIncludes(text, "test: acceptance project baseline", "rho.git History");
    return {
      oracleLog,
      historyCount: records.length,
      history: records.map((record) => truncate(record.text, 240)),
    };
  }, {
    screenshot: "s7-history",
    criteria: [
      "History 模式展示 baseline commit，提交标题、作者、日期与短 hash 信息可辨认",
      "历史记录在窄 Git surface 内换行/截断合理，不与状态标签或工具栏重叠",
    ],
  });

  await ctx.gate("s7", "diff-observation", async () => {
    const diff = git(ctx.fixtures.workingProject, ["diff", "--", "examples/git-review-demo.txt"]);
    assertIncludes(diff, "first hunk", "read-only Git diff oracle");
    assertIncludes(diff, "second diff hunk", "read-only Git diff oracle");
    await setGitMode(ctx, "changes");
    const text = await gitSurfaceText(ctx);
    const diffVisible = text.includes("first hunk") && text.includes("second diff hunk");
    if (!diffVisible) {
      throw new AssertionFailure(
        `rho.git diff visibility: read-only oracle contains both changed hunks (${Buffer.byteLength(diff)} bytes), but Changes rendered ${JSON.stringify(truncate(text, 300))}`,
      );
    }
    return {
      oracleDiffBytes: Buffer.byteLength(diff),
      diffVisible,
      observation: diffVisible
        ? "both changed hunks are visible in rho.git"
        : "the read-only Git oracle contains both hunks, but the current rho.git surface has no file-diff presentation (recorded product gap, not a fabricated pass)",
    };
  }, {
    fatal: false,
    screenshot: "s7-diff",
    criteria: [
      "两个相隔较远的 diff hunk 都应在只读 Git 视图可辨认；空态截图应与 deterministic FAIL 一致，不能被记为可见",
      "diff 行号、增删内容与文件名若存在，应在窄 surface 内保持可读且无横向页面溢出",
    ],
  });

  await ctx.gate("s7", "conflict-observation", async () => {
    await openProject(ctx, ctx.fixtures.conflictProject);
    const conflictFile = path.join(ctx.fixtures.conflictProject, "examples", "git-review-demo.txt");
    const onDisk = fs.readFileSync(conflictFile, "utf8");
    assertIncludes(onDisk, "<<<<<<< HEAD", "on-disk conflict fixture");
    assertIncludes(onDisk, ">>>>>>> acceptance-conflict", "on-disk conflict fixture");
    const porcelain = git(ctx.fixtures.conflictProject, ["status", "--porcelain"]);
    assertIncludes(porcelain, "UU examples/git-review-demo.txt", "read-only conflict oracle");

    await setGitMode(ctx, "changes");
    const gitText = await gitSurfaceText(ctx);
    let markersInSourceView = false;
    let sourceViewError = null;
    try {
      await openSurface(ctx, "rho.navigator");
      await ctx.act({ kind: "click", selector: '[data-nav-file="examples/git-review-demo.txt"]' });
      await ctx.act({ kind: "wait", until: { text: "<<<<<<< HEAD" }, timeout_ms: 20_000 });
      markersInSourceView = true;
    } catch (error) {
      sourceViewError = error instanceof Error ? error.message : String(error);
    }
    const conflictLanguageInGit = /\b(conflict|unmerged|resolve|merge in progress)\b/iu.test(gitText);
    return {
      oracleStatus: "UU examples/git-review-demo.txt",
      markersInSourceView,
      sourceViewError,
      conflictLanguageInGit,
      gitSurfaceText: truncate(gitText, 500),
      observation: conflictLanguageInGit
        ? "rho.git surfaces explicit conflict language"
        : markersInSourceView
          ? "rho.git has no conflict banner; the conflict is visible only as raw markers in the source view"
          : "neither an explicit rho.git conflict state nor readable source markers were observed",
    };
  }, {
    screenshot: "s7-conflict",
    criteria: [
      "对照 detail.oracleStatus 复核真实 UU 冲突；没有 Git banner 时，源视图中的 <<<<<<< / ======= / >>>>>>> markers 必须可读",
      "不得把项目路径 conflict-project 中的单词 conflict 误判为冲突横幅",
      "源视图与 Git surface 并排时无控件重叠，marker 行未被渲染成不可辨认的碎片",
    ],
  });

  ctx.skipGate("s7", "hunk-stage", REMOVED_GATE_REASON);
  ctx.skipGate("s7", "hunk-restore", REMOVED_GATE_REASON);
  ctx.skipGate("s7", "commit", REMOVED_GATE_REASON);
}
