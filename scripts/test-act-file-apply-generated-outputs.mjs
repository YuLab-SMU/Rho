import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const html = read("desktop", "dist", "index.html");
const js = read("desktop", "dist", "app.js");
const rust = read("crates", "rho-server", "src", "coordinator.rs");

assert.match(html, /id="actAutoApprove"[^>]*> Authorize R execution and file changes for this session/);
assert.match(html, /app\.js\?v=0\.4\.0-dev\.26(?:&amp;|&)[^"']*afo=act-output-v1/);
assert.match(js, /actAuthorizedTurnIds: new Set\(\)/);
assert.match(js, /fileEditAutoApplyAttempts: new Set\(\)/);
assert.match(js, /if \(authorizeChanges && response\?\.turn_id\) state\.actAuthorizedTurnIds\.add\(response\.turn_id\)/);
assert.match(js, /function maybeAutoApplyFileEditProposal\(\)/);
assert.match(js, /state\.actAuthorizedTurnIds\.has\(proposal\.turnId\)/);
assert.match(js, /proposal\.editorContext\?\.project_root !== state\.project\.root/);
assert.match(js, /state\.fileEditAutoApplyAttempts\.add\(proposal\.key\)/);
assert.match(js, /acceptFileEditProposal\(\{ automatic: true \}\)/);
assert.match(js, /async function acceptFileEditProposal\(\{ automatic = false \} = \{\}\)/);
assert.match(js, /invoke\("apply_agent_file_edit"/);
assert.match(js, /expectedDiskSha256: snapshot\.expectedDiskSha256/);
assert.match(js, /invoke\("undo_agent_file_edit"/);
assert.doesNotMatch(
  js.slice(js.indexOf("async function acceptFileEditProposal"), js.indexOf("function rejectFileEditProposal")),
  /invoke\(\s*proposal\.operation === "create" \? "project_create_file" : "project_write_file"/,
);
assert.match(js, /generated_file: "Generated file"/);
assert.match(js, /"outputs-generated"/);
assert.match(js, /artifactKind: "generated_file"/);
assert.match(js, /outputPath: "results\/qc-summary\.csv"/);
assert.match(js, /outputPath: "results\/qc-figure\.png"/);

assert.match(rust, /request_type == "workspace\.execute"[\s\S]*capture_generated_output_snapshot/);
assert.match(rust, /artifact_kind: "generated_file"\.to_string\(\)/);
assert.match(rust, /run_id: Some\(request\.execution_id\.clone\(\)\)/);
assert.match(rust, /project_root: project_root\.clone\(\)/);
assert.match(rust, /MAX_GENERATED_OUTPUT_RECORDS: usize = 100/);
assert.match(rust, /if file_type\.is_symlink\(\)/);
assert.match(rust, /ignored_generated_output_directory/);

console.log("Act file apply and generated Outputs contract checks passed.");
