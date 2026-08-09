import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), "utf8");
const js = read("desktop", "dist", "app.js");
const main = read("desktop", "src-tauri", "src", "main.rs");
const agentLlm = read("desktop", "src-tauri", "src", "agent_llm.rs");
const coordinator = read("crates", "rho-server", "src", "coordinator.rs");
const store = read("crates", "rho-store", "src", "lib.rs");
const migration = read("crates", "rho-store", "src", "migration.rs");
const bridge = read("r", "rho.bridge", "R", "execute.R");
const adapter = read("r", "rho.agent", "R", "aisdk_adapter.R");
const contract = read("docs", "plans", "active-2026-08-07-problems-agent-repair-spec.md");

assert.match(contract, /PROBLEMS-AGENT-REPAIR-2/);
assert.match(contract, /PROBLEMS-AGENT-REPAIR-3 Installed Acceptance Correction/);
assert.match(contract, /PROBLEMS-AGENT-REPAIR-4 Console Error-Site Entry Correction/);
assert.match(contract, /PROBLEMS-AGENT-REPAIR-5 Parser-Token Correction/);
assert.match(contract, /explicitly authorized its complete resolution on 2026-08-08/);
assert.match(contract, /range_kind=user_selection/);
assert.match(contract, /same action-state helper/);
assert.match(contract, /does not navigate[\s\S]{0,40}Problems/);

assert.match(bridge, /parse\(text = code, keep\.source = TRUE\)/);
assert.match(bridge, /attr\(expressions, "srcref", exact = TRUE\)/);
assert.match(bridge, /function\(error\)[\s\S]*stage = if \(isTRUE\(parse_active\)\) "parse" else "evaluation"/);
assert.match(bridge, /function\(error\)[\s\S]*range_kind = if \(is\.null\(error_range\)\)/);
assert.ok(bridge.includes('"^<text>:([1-9][0-9]{0,7}):([1-9][0-9]{0,6}):"'));
assert.match(bridge, /rho_execution_parse_token_range\(error, code\)/);
assert.doesNotMatch(bridge, /unexpected.*source_range/i);

assert.match(store, /pub\(crate\) const SCHEMA_VERSION: i64 = 12/);
for (const column of [
  "error_start_line",
  "error_start_column",
  "error_end_line",
  "error_end_column",
  "error_range_kind",
]) {
  assert.ok(store.includes(column) || migration.includes(column), `${column} must be durable`);
}
assert.match(store, /fn migrate_v9_to_v11/);
assert.match(store, /fn migrate_v10_to_v11/);
assert.match(migration, /fn rebuild_runs_error_range_kind_v11/);
assert.match(migration, /error_range_kind IN \('r_expression', 'r_parse_token'\)/);
assert.match(store, /finish_run_with_error_range/);
assert.match(store, /validate_run_error_range/);
assert.match(store, /rejects_invalid_problem_ranges_and_projects_partial_history_as_unknown/);

assert.match(coordinator, /fn translated_run_error_range/);
assert.match(coordinator, /utf16_column_at_character_boundary/);
assert.match(coordinator, /project_relative_diagnostic_source/);
assert.match(coordinator, /Some\("evaluation"\), Some\("r_expression"\)/);
assert.match(coordinator, /Some\("parse"\), Some\("r_parse_token"\)/);
assert.match(coordinator, /Current editor context:/);
assert.match(coordinator, /exact executed code[\s\S]{0,180}do not require the user to restate or manually select a known error range/);

assert.match(main, /struct ExecuteSourceRange/);
assert.match(main, /validate_execute_source_range_shape/);
assert.match(main, /task_kind: Option<String>/);
assert.match(main, /"agent_turn" \| "problem_repair"/);
assert.match(main, /task_kind == "problem_repair" && mode != "ask"/);
assert.match(main, /task_kind == "agent_turn"[\s\S]{0,160}mode == "act"/);
assert.match(main, /resolve_model_and_credential_for_task/);

assert.match(agentLlm, /task_kind == "problem_repair"/);
assert.match(agentLlm, /mode == "ask"/);
assert.match(agentLlm, /resolve_model_for_turn_with_settings\(settings, requested_model_id, "act"\)/);
assert.match(agentLlm, /route\.capability == "agent\.act"/);
assert.match(agentLlm, /function_call/);
assert.match(agentLlm, /credential is missing/);

assert.match(adapter, /rho_runtime_profile_model_reference <- function\(profile\)/);
assert.match(adapter, /identical\(profile\$provider_kind, "registered"\)[\s\S]*profile\$registered_provider_id/);
assert.match(adapter, /aisdk::register_provider\(registration_id, function\(\) provider\)/);
assert.match(adapter, /rho_runtime_profile_capability_models <- function\(profile, resolved_model = NULL\)[\s\S]*expected_model <- rho_runtime_profile_model_reference\(profile\)/);

assert.match(js, /source_range: request\.sourceRange \?\? null/);
assert.match(js, /function problemExactRange\(problem\)/);
assert.match(js, /\["r_expression", "r_parse_token"\]\.includes\(problem\.range_kind\)/);
assert.match(js, /function currentProblemSelectionRange\(problem\)/);
assert.match(js, /rangeKind: "user_selection"/);
assert.match(js, /function problemRunContext\(detail\)/);
assert.match(js, /traceback: boundedProblemTextList\(problem\.traceback\)/);
assert.match(js, /selectExactProblemRange\(problem, repairRange\)/);
assert.match(js, /problemExpectedSourceText\(problem, runDetail, repairRange\)/);
assert.match(js, /taskKind: "problem_repair", mode: "ask"/);
assert.match(js, /taskKind === "agent_turn" && mode === "act" && state\.actAutoApprove/);
assert.match(js, /label: "Fix with Agent"/);
assert.match(js, /label: "Select code for Agent"/);
assert.match(js, /label: "Set up Agent repair"/);
assert.match(js, /function configureProblemRepairButton\(button, problem/);
assert.match(js, /configureProblemRepairButton\(fix, problem\)/);
assert.match(js, /configureProblemRepairButton\(entry\.button, entry\.problem/);
assert.match(js, /state\.agentLlm\.routingExpandedCapability = "agent\.act"/);

assert.match(js, /run\.run_id === runId && run\.project_root === mockLastProject/);
assert.match(js, /run\.project_root === mockLastProject && run\.error_message/);
assert.match(js, /function runProblemRepairMockProbe\(fileProblem, consoleProblem, parseProblem\)/);
assert.match(js, /parse_token:/);
assert.match(js, /range_kind: "r_parse_token"/);
for (const evidence of [
  "foreign_project_blocked",
  "stale_source_blocked",
  "failed_request_recovered",
  "project_switch_blocked",
  "source_unchanged_before_accept",
]) assert.ok(js.includes(evidence), `${evidence} preview evidence must exist`);
assert.match(js, /previewParams\.get\("state"\) === "repair-probe"/);
assert.match(js, /repair_probe: state\.problemRepairPreviewProbe/);

console.log("Problems/Console shared Agent repair R5 contract checks passed.");
