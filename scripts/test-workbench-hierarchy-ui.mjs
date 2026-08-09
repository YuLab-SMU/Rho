import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "desktop", "dist", "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "desktop", "dist", "styles.css"), "utf8");
const js = fs.readFileSync(path.join(root, "desktop", "dist", "app.js"), "utf8");

assert.match(html, /styles\.css\?v=0\.4\.0-dev\.26(?:&amp;|&)rev=m(?:2-workbench|3-scientific-review-v3)/);
assert.match(html, /app\.js\?v=0\.4\.0-dev\.26(?:&amp;|&)rev=m(?:2-workbench|3-scientific-review-v3)/);

for (const icon of [
  "wand-sparkles",
  "replace",
  "braces",
  "save",
  "list-start",
  "fast-forward",
  "maximize-2",
  "minimize-2",
]) {
  assert.match(html, new RegExp(`id="icon-${icon}"`), `Missing workbench icon ${icon}`);
  assert.match(html + js, new RegExp(`#icon-${icon}`), `Unused workbench icon ${icon}`);
}

assert.match(html, /class="editor-actions" role="toolbar" aria-label="Editor actions"/);
for (const id of [
  "editorFormatButton",
  "editorCheckCodeButton",
  "editorRenameButton",
  "editorExtractButton",
  "saveFileButton",
  "editorRunButton",
  "editorRunFileButton",
]) {
  const button = html.match(new RegExp(`<button id="${id}"[\\s\\S]*?<\\/button>`))?.[0] ?? "";
  assert.ok(button, `Missing editor action ${id}`);
  assert.match(button, /aria-label="[^"]+"/);
  assert.match(button, /<svg class="ui-icon" aria-hidden="true">/);
}

for (const label of ["Open documents", "Project sidebar", "Execution panels", "Context panels", "Agent work surfaces"]) {
  assert.match(html, new RegExp(`role="tablist" aria-label="${label}"`), `Missing labeled tablist ${label}`);
}
assert.match(js, /activate\.setAttribute\("role", "tab"\)/);
assert.match(js, /activate\.setAttribute\("aria-selected", String\(selected\)\)/);
assert.match(js, /button\.setAttribute\("aria-selected", String\(selected\)\)/);

assert.match(js, /function normalizeHumanPreset\(value\)/);
assert.match(js, /\["code", "analyze", "agent"\]\.includes\(value\) \? value : "code"/);
assert.match(js, /state\.humanPreset = normalized;/);
assert.match(js, /state\.humanPreset = normalizeHumanPreset\(session\.human_preset\);/);
assert.match(js, /applyWorkbenchLayout\(button\.dataset\.layout\);\s*scheduleSessionSave\(\);/);

assert.match(js, /currentHandle\.setAttribute\("aria-valuemin", String\(Math\.round\(currentLimits\[currentPanel\]\[0\]\)\)\)/);
assert.match(js, /currentHandle\.setAttribute\("aria-valuemax", String\(Math\.round\(currentLimits\[currentPanel\]\[1\]\)\)\)/);
assert.match(js, /icon\.setAttribute\("href", "#icon-maximize-2"\)/);
assert.match(js, /icon\.setAttribute\("href", "#icon-minimize-2"\)/);
assert.match(js, /human_preset:\s*state\.humanPreset/);
assert.match(js, /dock_expanded:\s*\$\("#toggleDockMaximize"\)\.dataset\.expanded === "true"/);
assert.match(css, /grid-template-rows:\s*minmax\(150px, 1fr\) 8px var\(--dock-height\)/);
assert.match(css, /\.resize-handle\.horizontal\s*\{[^}]*height:\s*8px/);
assert.match(css, /\.editor-actions button\s*\{[^}]*width:\s*28px;[^}]*min-width:\s*28px;[^}]*height:\s*28px/);
assert.match(css, /@media \(max-width:\s*1320px\)[\s\S]*?\.project-switcher\s*\{\s*max-width:\s*220px/);
assert.match(css, /@media \(max-width:\s*960px\)[\s\S]*?\.app-shell\.layout-code\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\) 0/);

console.log("Workbench hierarchy and panel geometry contract checks passed.");
