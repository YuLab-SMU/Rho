import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "desktop", "dist", "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "desktop", "dist", "styles.css"), "utf8");
const js = fs.readFileSync(path.join(root, "desktop", "dist", "app.js"), "utf8");

assert.match(html, /styles\.css\?v=0\.4\.0-dev\.24(?:&amp;|&)rev=m(?:1-shell|2-workbench|3-scientific-review-v3)/);

for (const token of [
  "--surface-app",
  "--surface-raised",
  "--surface-selected",
  "--text-primary",
  "--text-disabled",
  "--border-focus",
  "--control-compact",
  "--control-default",
  "--shadow-menu",
  "--duration-fast",
]) {
  assert.match(css, new RegExp(`${token}:`), `Missing interface token ${token}`);
}

for (const icon of ["rotate-ccw", "square", "play", "plus", "file-text", "shield-check"]) {
  assert.match(html, new RegExp(`id="icon-${icon}"`), `Missing local icon ${icon}`);
  assert.match(html, new RegExp(`href="#icon-${icon}"`), `Unused local icon ${icon}`);
}

const topActions = html.match(/<div class="top-actions">([\s\S]*?)<\/div>\s*<\/header>/)?.[1] ?? "";
assert.ok(topActions, "Top actions must remain a bounded shell group");
assert.doesNotMatch(topActions, /[↻■▶]/, "Primary shell actions must not use text glyph icons");
assert.match(topActions, /id="restartButton"[^>]*title="Restart Workspace R"[^>]*aria-label="Restart Workspace R"/);
assert.match(topActions, /id="interruptButton"[^>]*title="Interrupt R"[^>]*aria-label="Interrupt R"/);
assert.match(html, /id="taskRailNew"[^>]*title="New conversation"[^>]*aria-label="New conversation"/);

assert.match(css, /\.ui-icon\s*\{[^}]*stroke-width:\s*1\.75/);
assert.match(css, /button:focus-visible,[\s\S]*outline-offset:\s*2px/);
assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
assert.match(css, /body\.agent-posture \.top-actions\s*\{\s*margin-left:\s*auto/);
assert.match(css, /\.run-button\s*\{[^}]*width:\s*148px/);
assert.match(css, /\.document-tab\.active::before/);
assert.match(css, /\.surface-tabs button\.active[^}]*border-bottom-color:\s*var\(--accent\)/);
assert.match(css, /@media \(max-width:\s*960px\)[\s\S]*\.app-shell\.agent-first \.context-panel,[\s\S]*width:\s*100%/);
assert.match(css, /@media \(max-width:\s*1500px\)[\s\S]*\.git-conflict-banner \.conflict-list\s*\{\s*display:\s*none/);
assert.match(js, /scenario === "interface-shell"/);
assert.match(js, /D:\/研究项目\/单细胞 RNA-seq 质量控制与差异分析/);
assert.match(js, /openDocument\("reports\/claim-review-demo\.qmd"\)/);

console.log("Interface foundation and shell contract checks passed.");
