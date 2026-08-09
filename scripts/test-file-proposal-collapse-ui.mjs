import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const html = read("desktop", "dist", "index.html");
const css = read("desktop", "dist", "styles.css");
const js = read("desktop", "dist", "app.js");

assert.match(
  html,
  /<details id="fileEditPanel"[^>]*role="region"[^>]*aria-labelledby="fileEditPanelTitle"[^>]*open>/,
  "File proposals must use a native disclosure that opens by default",
);
assert.match(html, /<summary class="file-edit-header">[\s\S]*id="fileEditPanelTitle"[\s\S]*id="fileEditPath"[\s\S]*<\/summary>/);
assert.match(html, /<div class="file-edit-detail">[\s\S]*id="fileEditBefore"[\s\S]*id="fileEditAfter"[\s\S]*id="fileEditAccept"[\s\S]*id="fileEditReject"[\s\S]*id="fileEditUndo"/);

assert.match(css, /\.file-edit-header::before[^}]*content:\s*">"/);
assert.match(css, /\.file-edit-panel\[open\] \.file-edit-header::before[^}]*rotate\(90deg\)/);
assert.match(css, /\.file-edit-header \.technical-meta[^}]*text-overflow:\s*ellipsis/);

assert.match(js, /const proposalChanged = panel\.dataset\.proposalKey !== proposal\.key;/);
assert.match(js, /panel\.dataset\.proposalKey = proposal\.key;/);
assert.match(js, /if \(proposalChanged\) panel\.open = true;/);
assert.match(js, /delete panel\.dataset\.proposalKey;/);
assert.match(js, /\$\("#fileEditPath"\)\.title = proposal\.path;/);
assert.match(js, /fileEditUndoVerifiedKey: null/);
assert.match(js, /const undoAvailable = accepted[\s\S]*state\.fileEditUndoVerifiedKey === proposal\.key/);
assert.match(js, /async function verifyFileEditUndo\(\)/);
assert.match(js, /\$\("#fileEditPanel"\)\.open = false;/);
assert.match(js, /void verifyFileEditUndo\(\);/);
assert.match(js, /decision === "stale"/);
assert.match(js, /expectedAfterSha256: undo\.afterSha256/);
assert.match(js, /state\.fileEditUndo = null;[\s\S]*state\.fileEditUndoVerifiedKey = null;/);

console.log("File proposal collapse contract checks passed.");
