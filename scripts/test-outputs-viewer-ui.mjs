import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync("desktop/dist/index.html", "utf8");
const css = fs.readFileSync("desktop/dist/styles.css", "utf8");
const js = fs.readFileSync("desktop/dist/app.js", "utf8");
const project = fs.readFileSync("desktop/src-tauri/src/project.rs", "utf8");
const main = fs.readFileSync("desktop/src-tauri/src/main.rs", "utf8");

assert.match(html, /id="viewerRegion" class="viewer-region hidden"/);
assert.match(html, /id="viewerSourcePane"/);
assert.match(html, /id="viewerPreviewPane"/);
assert.match(html, /data-viewer-mode="both"/);
assert.match(html, />Outputs <span id="plotCount"/);
assert.match(html, /id="agentOutputsSummary"/);
assert.match(html, /id="artifactOpenViewerButton"/);
assert.match(html, /vendor\/viewer\/marked\.umd\.js/);
assert.match(html, /vendor\/viewer\/purify\.min\.js/);
assert.match(html, /vendor\/viewer\/katex\.min\.js/);
assert.match(html, /vendor\/viewer\/katex-auto-render\.min\.js/);
assert.match(html, /vendor\/viewer\/katex\.min\.css/);
assert.match(html, /vendor\/viewer\/papaparse\.min\.js/);
assert.match(html, /app\.js\?v=0\.4\.0-dev\.25/);

assert.match(project, /MAX_VIEWER_FILE_BYTES: u64 = 4 \* 1024 \* 1024/);
assert.match(project, /MAX_VIEWER_HTML_BYTES: u64 = 32 \* 1024 \* 1024/);
assert.match(project, /media_type == "text\/html"[\s\S]*MAX_VIEWER_HTML_BYTES/);
assert.match(project, /pub fn read_viewer_file\(root: &Path, relative: &str\)/);
assert.match(project, /"rho\.viewer_file\.v1"/);
assert.match(project, /"html" => \("text\/html", "utf-8"\)/);
assert.match(project, /"md" => \("text\/markdown", "utf-8"\)/);
assert.match(project, /"csv" => \("text\/csv", "utf-8"\)/);
assert.match(project, /"tsv" => \("text\/tab-separated-values", "utf-8"\)/);
assert.match(project, /"r" => \("text\/x-r", "utf-8"\)/);
assert.match(project, /"png" => \("image\/png", "base64"\)/);
assert.match(project, /content_encoding/);
assert.match(main, /viewer_read_file/);

assert.match(js, /function viewerSafeMarkdown\(content\)/);
assert.match(js, /window\.renderMathInElement\(container/);
assert.match(js, /left: "\$\$", right: "\$\$", display: true/);
assert.match(js, /output: "html"/);
assert.match(js, /window\.DOMPurify\.sanitize/);
assert.match(js, /FORBID_TAGS: \["script", "style", "iframe", "object", "embed", "form", "base", "meta"\]/);
assert.match(js, /frame\.setAttribute\("sandbox", "allow-scripts"\)/);
assert.doesNotMatch(js, /sandbox", "allow-scripts allow-same-origin/);
assert.match(js, /connect-src 'none'/);
assert.match(js, /const navigationGuard = document\.createElement\("script"\)/);
assert.match(js, /event\.target instanceof Element \? event\.target\.closest\("a\[href\]"\) : null/);
assert.match(js, /event\.preventDefault\(\);[\s\S]*if \(!href\.startsWith\("#"\)\) \{[\s\S]*event\.stopImmediatePropagation\(\)/);
assert.match(js, /fragment = decodeURIComponent\(fragment\)/);
assert.match(js, /document\.getElementById\(fragment\) \|\| document\.getElementsByName\(fragment\)\[0\]/);
assert.match(js, /target\?\.scrollIntoView\(\{ block: "start" \}\)/);
assert.match(js, /csp\.after\(navigationGuard\)/);
assert.match(js, /function viewerRenderTable\(content, extension\)/);
assert.match(js, /viewer-image-output/);
assert.match(js, /viewer-code-output/);
assert.match(js, /agent-inline-output-image/);
assert.match(js, /data:" \+ result\.media_type \+ ";base64,"/);
assert.match(js, /window\.Papa\.parse/);
assert.match(js, /VIEWER_TABLE_ROW_LIMIT = 500/);
assert.match(js, /VIEWER_TABLE_COLUMN_LIMIT = 100/);
assert.match(js, /VIEWER_HTML_LIMIT = 32 \* 1024 \* 1024/);
assert.match(js, /viewerPathExtension\(input\.path\) === "html" \? VIEWER_HTML_LIMIT : VIEWER_FILE_LIMIT/);
assert.match(js, /new Blob\(\[String\(input\.content\)\]\)\.size > contentLimit/);
assert.match(js, /This file is too large to preview\. Open it as source instead\./);
assert.match(js, /result\.project_root !== state\.project\.root/);
assert.match(js, /function openViewerForActiveDocument\(\)/);
assert.match(js, /sourceIsActiveDocument/);
assert.match(js, /classList\.toggle\("hidden", !viewer\.sourcePath \|\| sourceIsActiveDocument\)/);
assert.match(js, /await openDocument\(state\.viewer\.sourcePath\);\s*closeViewer\(\)/);
assert.match(js, /function findCompletedRenderArtifact\(job\)/);
assert.match(js, /artifact_\$\{job\.job_id\}_render/);
assert.match(js, /if \(activeDocumentCanRender\(\)\)/);
assert.match(js, /Preview Active Document/);

const loadRunDataStart = js.indexOf("async function loadRunData(");
const loadRunDataEnd = js.indexOf("async function loadGitStatus(", loadRunDataStart);
assert.notEqual(loadRunDataStart, -1, "Run data loader must exist");
assert.notEqual(loadRunDataEnd, -1, "Run data loader boundary must exist");
const loadRunData = js.slice(loadRunDataStart, loadRunDataEnd);
const firstPlotRender = loadRunData.indexOf("renderPlots();");
const artifactDetailLoad = loadRunData.indexOf('invoke("get_artifact_record"');
const agentConsoleSync = loadRunData.indexOf("syncAgentRunsToConsole(state.runs)");
assert.ok(firstPlotRender >= 0 && firstPlotRender < artifactDetailLoad, "Plot history must render before saved-output detail loads");
assert.ok(firstPlotRender < agentConsoleSync, "Plot history must render before Agent Console synchronization");
assert.match(js, /projectRefreshSequence: 0/);
assert.match(loadRunData, /const refreshSequence = state\.projectRefreshSequence/);
assert.match(loadRunData, /const projectRoot = state\.project\.root/);
assert.match(loadRunData, /refreshSequence !== state\.projectRefreshSequence \|\| projectRoot !== state\.project\.root/);
assert.match(js, /await hydrateProject\(response\);\s*void Promise\.all\(\[[\s\S]{0,180}loadAgentData\(\{ quiet: true \}\),[\s\S]{0,120}loadRunData\(\{ quiet: true \}\),[\s\S]{0,120}refreshEnvironment\(\{ quiet: true \}\),?[\s\S]{0,40}\]\);/);
assert.match(js, /state\.runs = \[\];[\s\S]*state\.artifacts = \[\];[\s\S]*renderAgentOutputs\(\);/);
assert.match(js, /function capturePanelViewport\(panel, keySelector = null\)/);
assert.match(js, /function restorePanelViewport\(panel, viewport, keySelector = null\)/);
assert.match(js, /function renderAgentOutputs\(\)[\s\S]*capturePanelViewport\(list, "data-output-key"\)[\s\S]*restorePanelViewport\(list, viewport, "data-output-key"\)/);
assert.match(js, /function renderAgentTimeline\(\)[\s\S]*capturePanelViewport\(panel, "data-turn-id"\)[\s\S]*restorePanelViewport\(panel, viewport, "data-turn-id"\)/);
assert.match(js, /card\.dataset\.outputKey = agentOutputKey\(entry\.kind, entry\.id\)/);
assert.match(
  loadRunData,
  /try \{\s*const detail = await invoke\("get_artifact_record"[\s\S]*?\} catch \(error\) \{[\s\S]*?state\.selectedArtifactDetail = listedArtifact/,
  "Saved-output detail failure must be isolated from core Outputs rendering",
);

assert.match(css, /\.workspace\.viewer-open \.editor-region \{ display: none; \}/);
assert.match(css, /\.viewer-body \{ display: grid; grid-template-columns:/);
assert.match(css, /\.workspace\.viewer-open \.viewer-region\.viewer-mode-preview/);
assert.match(css, /@media \(max-width: 960px\)[\s\S]*\.viewer-body \{ grid-template-columns: minmax\(0, 1fr\); \}/);
assert.match(css, /\.agent-outputs-panel \{ display: flex; flex-direction: column;/);
assert.match(css, /\.agent-outputs-list \{[^}]*overflow-y: scroll/);

console.log("Outputs Viewer UI contract checks passed.");
