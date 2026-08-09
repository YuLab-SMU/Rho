import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "desktop", "dist", "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "desktop", "dist", "styles.css"), "utf8");
const js = fs.readFileSync(path.join(root, "desktop", "dist", "app.js"), "utf8");
const spec = fs.readFileSync(
  path.join(root, "docs", "plans", "active-2026-08-08-task-rail-mode-status-semantics-spec.md"),
  "utf8",
);
const owner = fs.readFileSync(
  path.join(root, "docs", "plans", "accepted-2026-08-01-ux4-p2-direct-surface-spec.md"),
  "utf8",
);

assert.match(spec, /Authorization: the project owner explicitly requested continued implementation\s+of GitHub Issue #9/);
assert.match(spec, /TASK-RAIL-SEMANTICS-1 implementation, automated validation,[\s\S]*contract review complete/);
assert.match(spec, /Status owns status color\. Mode owns a neutral, distinct shape/);
assert.match(owner, /Ask uses MessageCircle, Plan uses ListChecks, and Act uses\s+PencilLine/);

for (const symbol of ["message-circle", "list-checks", "pencil-line"]) {
  assert.match(html, new RegExp(`id="icon-${symbol}"`), `${symbol} must be a local sprite symbol`);
}

assert.match(js, /const TASK_RAIL_MODE_PRESENTATION = Object\.freeze\(\{/);
for (const [mode, label, icon] of [
  ["ask", "Ask", "message-circle"],
  ["plan", "Plan", "list-checks"],
  ["act", "Act", "pencil-line"],
]) {
  assert.match(
    js,
    new RegExp(`${mode}: Object\\.freeze\\(\\{ label: "${label}", icon: "${icon}" \\}\\)`),
    `${label} must have one fixed neutral shape`,
  );
}
assert.match(js, /function taskRailModePresentation\(mode\)/);
assert.match(js, /function createTaskRailModeIcon\(mode\)/);
assert.match(js, /function createTaskRailStatusDot\(status, terminalReason = null\)/);
assert.match(js, /key: "unknown",\s*label: "Agent",\s*icon: "bot"/);
assert.match(js, /wrapper\.setAttribute\("role", "img"\)/);
assert.match(js, /wrapper\.setAttribute\("aria-label", `\$\{presentation\.label\} mode`\)/);
assert.match(js, /wrapper\.title = `\$\{presentation\.label\} mode`/);
assert.match(js, /icon\.setAttribute\("aria-hidden", "true"\)/);
assert.match(js, /dot\.setAttribute\("aria-label", `\$\{label\} status`\)/);
assert.match(js, /dot\.title = `\$\{label\} status`/);
assert.match(js, /item\.setAttribute\("aria-current", "true"\)/);
assert.match(
  js,
  /item\.setAttribute\("aria-label", conversation\.latest_mode[\s\S]{0,180}`\$\{modePresentation\.label\} mode, \$\{statusLabel\} status: \$\{previewText\}`[\s\S]{0,120}`\$\{statusLabel\} conversation: \$\{previewText\}`\)/,
  "Populated conversations keep separate mode/status semantics while empty conversations remain truthfully mode-less",
);
assert.match(js, /item\.append\(status\);\s*if \(modeIcon\) item\.append\(modeIcon\);\s*item\.append\(preview\)/);

assert.doesNotMatch(css, /\.mode-badge\.act/);
assert.doesNotMatch(css, /\.task-rail-item \.mode-badge/);
assert.doesNotMatch(js, /mode-badge/);
assert.match(css, /\.task-mode-icon\s*\{[^}]*display:\s*inline-grid[^}]*color:\s*var\(--muted\)/s);
const modeIconRule = css.match(/\.task-rail-item \.task-mode-icon\s*\{([^}]*)\}/s)?.[1] || "";
assert.doesNotMatch(modeIconRule, /(?:^|;)\s*(?:background|border|border-radius|padding)\s*:/);
assert.match(css, /\.task-mode-icon \.ui-icon\s*\{[^}]*width:\s*15px[^}]*height:\s*15px/s);
assert.match(css, /\.task-rail-item\.active \.task-mode-icon[^}]*color:\s*var\(--accent-strong\)/s);
assert.match(css, /\.task-rail-item:focus-visible \.task-mode-icon[^}]*color:\s*var\(--accent-strong\)/s);
assert.match(css, /\.task-rail-preview\s*\{[^}]*min-width:\s*0/s);
assert.match(css, /\.task-rail-item \.status-dot\.running,[\s\S]{0,180}background:\s*var\(--accent\)/);
assert.match(css, /\.task-rail-item \.status-dot\.completed\s*\{\s*background:\s*var\(--success\)/);
assert.match(css, /\.task-rail-item \.status-dot\.failed\s*\{\s*background:\s*var\(--error\)/);

assert.match(js, /previewState === "task-rail"/);
for (const state of ["completed", "running", "failed"]) {
  assert.match(js, new RegExp(`status = "${state}"`), `preview fixture must cover ${state}`);
}
assert.match(js, /task_rail:\s*\{/);
assert.match(js, /mode_label: modeIcon\?\.getAttribute\("aria-label"\)/);
assert.match(js, /status_label: statusDot\?\.getAttribute\("aria-label"\)/);
assert.match(js, /preview_overflow: Boolean\(preview && preview\.scrollWidth > preview\.clientWidth\)/);
assert.match(js, /mode_background: modeIcon \? getComputedStyle\(modeIcon\)\.backgroundColor : null/);
assert.match(js, /list_overflow: Boolean\(taskRailList && taskRailList\.scrollWidth > taskRailList\.clientWidth\)/);

console.log("Task Rail mode/status semantics contract checks passed.");
