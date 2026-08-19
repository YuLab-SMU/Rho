import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const html = read("desktop", "dist", "index.html");
const css = read("desktop", "dist", "styles.css");
const js = read("desktop", "dist", "app.js");
const rust = read("desktop", "src-tauri", "src", "main.rs");

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
assert.match(js, /function fileEditProposalStructuralIssue\(proposal\)/);
assert.match(js, /function fileEditProposalPreflight\(proposal\)/);
assert.match(js, /Invalid · select source/);
assert.match(js, /Waiting for Agent/);
assert.match(js, /AGENT_FILE_PROPOSAL_INVALID/);
assert.match(js, /AGENT_FILE_TURN_ACTIVE/);
assert.match(js, /The target file changed after this proposal was created/);
assert.match(js, /expectedAfterSha256: undo\.afterSha256/);
assert.match(js, /state\.fileEditUndo = null;[\s\S]*state\.fileEditUndoVerifiedKey = null;/);

const structuralStart = js.indexOf("function fileEditProposalStructuralIssue(proposal)");
const structuralEnd = js.indexOf("\nfunction fileEditProposalPreflight", structuralStart);
const structuralIssue = new Function(`return (${js.slice(structuralStart, structuralEnd)});`)();
const emptySelection = structuralIssue({
  path: "scatter_plot_example.R",
  operation: "replace_selection",
  content: "replacement",
  editorContext: {
    active_path: "scatter_plot_example.R",
    selection_start: 527,
    selection_end: 527,
    selection_text: "",
  },
});
assert.equal(emptySelection.state, "invalid");
assert.equal(emptySelection.code, "empty_selection");
assert.match(emptySelection.message, /no text was selected/);

const preflightStart = structuralEnd + 1;
const preflightEnd = js.indexOf("\nfunction fileEditOperationLabel", preflightStart);
const preflight = new Function(
  "fileEditProposalStructuralIssue",
  "state",
  `return (${js.slice(preflightStart, preflightEnd)});`,
)(structuralIssue, {
  selectedTurnDetail: null,
  agentTurns: [{ turn_id: "turn-running", status: "running" }],
});
assert.equal(preflight({
  turnId: "turn-running",
  path: "analysis.R",
  operation: "append",
  content: "x",
  editorContext: {},
}).state, "waiting");

const applyStart = rust.indexOf("async fn apply_agent_file_edit_state(");
const applyEnd = rust.indexOf("\nasync fn undo_agent_file_edit_state", applyStart);
const apply = rust.slice(applyStart, applyEnd);
assert.ok(
  apply.indexOf("ensure_agent_file_proposal_turn_terminal")
    < apply.indexOf("agent_file_mutations\n            .register"),
  "The host must reject an active parent turn before registering a mutation claim",
);
assert.ok(
  apply.indexOf("validate_persisted_agent_file_proposal_structure(&proposal)")
    < apply.indexOf('"file_edit.mutation_started"'),
  "The host must reject an invalid proposal before recording mutation admission",
);

console.log("File proposal collapse contract checks passed.");
