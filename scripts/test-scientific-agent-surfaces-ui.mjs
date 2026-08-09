import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const html = read("desktop", "dist", "index.html");
const css = read("desktop", "dist", "styles.css");
const js = read("desktop", "dist", "app.js");

assert.match(html, /styles\.css\?v=0\.4\.0-dev\.25(?:&amp;|&)rev=m3-scientific-review-v3/);
assert.match(html, /app\.js\?v=0\.4\.0-dev\.25(?:&amp;|&)rev=m3-scientific-review-v3/);

for (const icon of ["check", "clock-3", "circle-x", "ban", "triangle-alert", "info", "image", "bot", "file-diff", "package-check"]) {
  assert.match(html, new RegExp(`id="icon-${icon}"`), `Missing M3 icon ${icon}`);
  assert.match(html + js, new RegExp(`(?:#icon-|\\")${icon}`), `Unused M3 icon ${icon}`);
}

assert.match(js, /function presentationState\(status\)/);
assert.match(js, /function createStateMarker\(status, label\)/);
assert.match(js, /function createStateChip\(label, status = "neutral"\)/);
assert.match(js, /chip\.title = label/);
assert.match(css, /\.state-marker\.state-completed/);
assert.match(css, /\.state-chip\.state-cancelled,[\s\S]*\.state-chip\.state-failed/);

assert.match(html, /id="approvalPanel"[^>]*role="region"[^>]*aria-labelledby="approvalPanelTitle"/);
assert.match(html, /Agent approval/);
assert.match(html, /id="fileEditPanel"[^>]*role="region"[^>]*aria-labelledby="fileEditPanelTitle"/);
assert.match(html, /File proposal/);
assert.match(html, /Environment request/);
assert.match(js, /\$\("#approvalPanel"\)\.dataset\.state = approval \? "waiting" : "empty"/);
assert.match(js, /panel\.dataset\.state = decision \|\| "waiting"/);

assert.match(html, /id="plotEmpty"[^>]*class="empty-state surface-state"[^>]*data-state="empty"/);
assert.match(js, /showPlotSurfaceState\(\s*"failed",\s*"Plot preview unavailable"/);
assert.match(js, /JSON\.parse\(\(selectedPlot \|\| plots\[0\]\)\.payload_json \|\| "null"\)/);
assert.match(js, /payload\?\.\["image\/png"\]/);
assert.match(js, /parseJsonObject\(plot\?\.payload_json\)\?\.\["rho\/pruned"\]/);
assert.match(js, /function executionHasRenderablePlot\(response\)/);
assert.match(js, /event\?\.type === "display_data"/);
assert.match(js, /function normalizeBase64Padding\(value\)/);
assert.match(js, /core\.length % 4 === 1/);
assert.match(js, /paddingLength && compact\.length % 4 !== 0/);
assert.match(js, /data:image\/png;base64,\$\{encoded\}/);
assert.match(js, /image\.onerror = \(\) =>/);
assert.match(
  js,
  /if \(executionHasRenderablePlot\(response\)\) plotExecutionId = response\.execution_id \|\| null;[\s\S]*if \(plotExecutionId\) \{[\s\S]*item\.run_id === plotExecutionId[\s\S]*switchDockTab\("plots"\);/,
  "A direct execution that returns a plot must select that run's plot and reveal Plots",
);
assert.match(html, /id="problemEmpty"[^>]*data-state="completed"/);
assert.match(js, /icon\.textContent = \{ error: "E", warning: "W", info: "i" \}/);
assert.match(css, /\.problem-icon\.error/);

assert.match(html, /id="environmentContract" class="environment-contract surface-status-row"/);
assert.match(html, /id="renderCapability" class="environment-contract surface-status-row"/);
assert.match(js, /renderStatusItems\(\$\("#environmentContract"\)/);
assert.match(js, /setStateChip\(\$\("#environmentOperationDialogState"\)/);
assert.match(js, /previewState === "approval"/);
assert.match(js, /previewState === "file-proposal"/);
assert.match(js, /previewParams\.get\("state"\) === "invalid-plot"/);

assert.doesNotMatch(js, /approval_requests\s*=\s*environment_operation_requests|environment_operation_requests\s*=\s*approval_requests/);
assert.match(js, /invoke\("respond_approval"/);
assert.match(js, /invoke\("respond_environment_operation"/);
assert.match(js, /let commandError = null/);
assert.match(js, /loadEnvironmentOperationData\(\{ quiet: true \}\)/);
assert.match(js, /current\.status !== "requested"/);
assert.match(js, /refreshEnvironment\(\{ quiet: true \}\)/);
assert.match(js, /This request is no longer current/);

console.log("Scientific and Agent surface contract checks passed.");
