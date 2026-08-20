import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const html = read("desktop", "dist", "index.html");
const js = read("desktop", "dist", "app.js");
const rust = read("desktop", "src-tauri", "src", "main.rs");
const coordinator = read("crates", "rho-server", "src", "coordinator.rs");
const bridge = read("r", "rho.bridge", "R", "workspace.R");

assert.match(html, /id="dataViewerFilter"[^>]*type="search"[^>]*placeholder="Search all rows"/);
assert.match(html, /id="dataViewerStatus"[^>]*aria-live="polite"/);
assert.match(html, /id="dataViewerPageSize"[\s\S]*?<option value="50" selected>50<\/option>/);

assert.match(js, /state\.dataViewer\.queryTimer = setTimeout\([\s\S]*?loadDataViewPage\(\{ rowOffset: 0 \}\);[\s\S]*?}, 250\)/);
assert.match(js, /const pageRequestId = \+\+state\.dataViewer\.pageRequestId/);
assert.match(js, /if \(pageRequestId !== state\.dataViewer\.pageRequestId\) return null/);
assert.match(js, /query: state\.dataViewer\.query,[\s\S]*sort_column: state\.dataViewer\.sortColumn,[\s\S]*sort_direction: state\.dataViewer\.sortDirection/);
assert.match(js, /const sorted = state\.dataViewer\.sortColumn === column\.index/);
assert.match(js, /state\.dataViewer\.sortColumn = column\.index/);
assert.match(js, /query: page\.query,[\s\S]*sort_column: page\.sort_column,[\s\S]*sort_direction: page\.sort_direction,[\s\S]*workspace: currentViewerWorkspace\(\)/);
assert.match(js, /let rows = needle[\s\S]*?sourceRows\.filter[\s\S]*?if \(sortColumn !== null\)[\s\S]*?rows\.sort[\s\S]*?const pageRows = rows\.slice/);
assert.match(js, /source_total_rows: sourceTotalRows,[\s\S]*total_rows: rows\.length/);
assert.match(js, /request\.object_name === "qc_paged" \? 60 : request\.object_name === "qc_types" \? 6 : 12/);
assert.match(js, /\{ index: 0, name: "sample"/);
assert.doesNotMatch(js, /fetchDataViewerPage/);
assert.doesNotMatch(js, /Apply filter: check if any cell/);
assert.doesNotMatch(js, /rowText\.toLowerCase\(\)\.includes/);

for (const source of [rust, coordinator]) {
  assert.match(source, /query/);
  assert.match(source, /sort_column/);
  assert.match(source, /sort_direction/);
}
assert.match(rust, /fn data_view_artifact_metadata\(/);
assert.match(rust, /"query": page\.get\("query"\)/);
assert.match(rust, /"sort_column": page\.get\("sort_column"\)/);
assert.match(rust, /serde_json::to_string\(&data_view_artifact_metadata\(/);
assert.match(coordinator, /query = \{\}, sort_column = \{\}, sort_direction = \{\}/);
assert.match(bridge, /rho_viewer_matching_rows/);
assert.match(bridge, /rho_viewer_sorted_rows/);
assert.match(bridge, /source_total_rows = as\.integer\(materialized\$total_rows\)/);

console.log("Data Viewer broker-query UI contract checks passed.");
