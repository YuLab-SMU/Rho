import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const js = read("desktop", "dist", "app.js");
const css = read("desktop", "dist", "styles.css");
const bridge = read("r", "rho.bridge", "R", "workspace.R");

assert.match(js, /\["qc", "qc_paged", "qc_types"\]/);
assert.match(js, /cell_states: \["value", "value", "value", "empty"/);
assert.match(js, /cell_states: \["na", "na", "nan", "na"/);
assert.match(js, /type: "logical"[\s\S]*type: "integer"[\s\S]*type: "double"[\s\S]*type: "character"[\s\S]*type: "factor"[\s\S]*type: "date"/);
assert.match(js, /function dataViewerCellPresentation\(value, state\)/);
assert.match(js, /state === "na"[\s\S]*state === "nan"[\s\S]*state === "pos_inf"[\s\S]*state === "neg_inf"[\s\S]*state === "empty"/);
assert.match(js, /row\.cell_states\?\.\[columnIndex\] \|\| fallbackState/);
assert.match(js, /type\.textContent = column\.type \|\| "value"/);
assert.match(js, /column\.classes[\s\S]*column\.page_missing_count/);
assert.match(js, /page_missing_count: pageRows\.filter\(\(row\) => \["na", "nan"\]\.includes\(row\.cell_states\[index\]\)\)\.length/);
assert.doesNotMatch(js, /cellValue === null \|\| cellValue === undefined \|\| cellValue === ""/);

assert.match(css, /\.data-viewer-column-type\s*\{/);
assert.match(css, /\.data-viewer-table \.numeric-value\s*\{[^}]*text-align:\s*right/);
assert.match(css, /\.data-viewer-table \.empty-value\s*\{/);
assert.match(css, /\.data-viewer-table \.non-finite\s*\{/);

assert.match(bridge, /rho_viewer_column_type <- function/);
assert.match(bridge, /rho_viewer_column_metadata <- function/);
assert.match(bridge, /rho_viewer_cell_state <- function/);
assert.match(bridge, /cell_states = unname\(lapply\(source_values, rho_viewer_cell_state\)\)/);

console.log("Data Viewer type/missing-value UI contract checks passed.");
