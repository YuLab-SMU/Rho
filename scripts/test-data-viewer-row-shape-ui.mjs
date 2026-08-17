import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const js = read("desktop", "dist", "app.js");
const rust = read("desktop", "src-tauri", "src", "main.rs");
const bridge = read("r", "rho.bridge", "R", "workspace.R");

const helperStart = js.indexOf("function dataViewerProtocolError(");
const helperEnd = js.indexOf("\nfunction renderDataViewer()", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "Data Viewer validation helpers are present");
const helperSource = js.slice(helperStart, helperEnd);
const context = {};
vm.runInNewContext(`${helperSource}\nthis.viewerHelpers = { validateDataViewerPage, dataViewerReadFailure, dataViewerErrorFallback };`, context);
const helpers = context.viewerHelpers;

const validPage = {
  columns: [{ index: 0 }, { index: 1 }],
  rows: [{ cells: ["S1", "10"], cell_states: ["value", "value"] }],
};
assert.equal(helpers.validateDataViewerPage(validPage), validPage);
assert.throws(
  () => helpers.validateDataViewerPage({
    columns: validPage.columns,
    rows: [{ cells: { sample: "S1", reads: "10" }, cell_states: { sample: "value", reads: "value" } }],
  }),
  /cells and cell states must be arrays/,
);
assert.throws(
  () => helpers.validateDataViewerPage({
    columns: validPage.columns,
    rows: [{ cells: ["S1"], cell_states: ["value"] }],
  }),
  /must align with the returned columns/,
);

const protocolFailure = helpers.dataViewerReadFailure(Object.assign(
  new Error("Data Viewer response cells and cell states must be arrays."),
  { error_code: "viewer_protocol_error" },
));
assert.equal(protocolFailure.error_code, "viewer_protocol_error");
assert.equal(
  helpers.dataViewerErrorFallback(protocolFailure),
  "The data page could not be shown. Refresh the object and try again.",
);
const staleFailure = helpers.dataViewerReadFailure("stale_view_revision: workspace revision changed");
assert.equal(staleFailure.error_code, "stale_view_revision");
assert.equal(
  helpers.dataViewerErrorFallback(staleFailure),
  "The source changed; refresh this object before continuing.",
);
assert.equal(helpers.dataViewerReadFailure(new TypeError("row.cells.forEach is not a function")).error_code, "viewer_read_failed");

assert.match(bridge, /cells = unname\(row_values\)/);
assert.match(bridge, /cell_states = unname\(lapply\(source_values, rho_viewer_cell_state\)\)/);
assert.match(rust, /desktop smoke data viewer cells were not an array/);
assert.match(rust, /desktop smoke data viewer cell states were not an array/);
assert.match(rust, /row arrays were not aligned with columns/);
assert.doesNotMatch(
  js.slice(js.indexOf("async function loadDataViewPage("), js.indexOf("\nasync function inspectEnvironmentObject(")),
  /state\.dataViewer\.error = \{ message: String\(error\), error_code: "stale_view_revision" \}/,
);

console.log("Data Viewer row-shape and truthful-error contract checks passed.");
