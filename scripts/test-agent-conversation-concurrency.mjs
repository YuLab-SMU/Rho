import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const js = fs.readFileSync(path.join(root, "desktop", "dist", "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "desktop", "dist", "index.html"), "utf8");
const rust = fs.readFileSync(path.join(root, "desktop", "src-tauri", "src", "main.rs"), "utf8");
const server = fs.readFileSync(path.join(root, "crates", "rho-server", "src", "coordinator.rs"), "utf8");
const store = fs.readFileSync(path.join(root, "crates", "rho-store", "src", "lib.rs"), "utf8");
const spec = fs.readFileSync(
  path.join(root, "docs", "plans", "active-2026-08-09-agent-conversation-concurrency-spec.md"),
  "utf8",
);

assert.match(spec, /CONV-3 source\ncheckpoints accepted 2026-08-09/);
assert.match(spec, /CONV-3: Mutation scheduling, retry, and deletion — source checkpoint complete/);
assert.match(spec, /per-path file apply\/Undo lane and digest conflict handling/);

assert.match(rust, /const MAX_CONCURRENT_AGENT_TURNS: usize = 2/);
assert.match(rust, /struct AgentTaskEntry \{[\s\S]*conversation_id: String,[\s\S]*handle:/);
assert.match(rust, /AGENT_CONVERSATION_BUSY/);
assert.doesNotMatch(rust, /AGENT_ACT_EXCLUSIVE/);
assert.match(rust, /AGENT_CONCURRENCY_LIMIT/);
assert.match(rust, /agent_turn_admission_error\([\s\S]*requested_conversation_id\.as_deref\(\),[\s\S]*&mode/);
assert.match(rust, /AgentTaskEntry \{[\s\S]*conversation_id: conversation_id\.clone\(\),[\s\S]*handle: task/);
assert.match(rust, /agent_admission_allows_two_read_only_conversations_and_rejects_a_third/);
assert.match(rust, /agent_admission_rejects_same_conversation_but_allows_bounded_parallel_act/);
assert.match(rust, /struct AgentFileMutationRegistry/);
assert.match(rust, /AGENT_FILE_RESOURCE_STALE/);
assert.match(rust, /async fn apply_agent_file_edit_state/);
assert.match(rust, /async fn undo_agent_file_edit_state/);
assert.match(rust, /async fn retry_agent_turn/);
assert.match(rust, /async fn delete_agent_conversation/);
assert.match(rust, /concurrent_same_file_agent_proposals_apply_once_and_mark_the_other_stale/);
assert.match(rust, /different_agent_files_reach_disk_without_waiting_for_the_global_context_lock/);
assert.match(rust, /cancelling_a_queued_agent_file_claim_prevents_mutation_and_releases_the_claim/);
assert.match(rust, /incomplete_agent_file_mutations_reconcile_from_disk_once_and_per_project/);
assert.match(rust, /file_edit\.mutation_started/);
assert.match(rust, /file_edit\.recovered/);
assert.match(rust, /file_edit\.mutation_not_applied/);
assert.match(rust, /file_edit\.outcome_uncertain/);
assert.match(rust, /struct AppState \{[\s\S]*project_transition_gate: Arc<Mutex<\(\)>>/);
assert.match(rust, /async fn create_agent_conversation\([\s\S]*project_transition_gate\.lock\(\)\.await/);
assert.match(rust, /project_transition_orders_file_claim_before_switch_preflight/);
assert.match(rust, /fn persisted_agent_file_mutation_state/);
assert.match(rust, /AGENT_FILE_ALREADY_DECIDED/);
assert.match(rust, /restore_content_sha256/);
assert.match(rust, /durable pre-Apply editor snapshot/);
assert.match(rust, /agent_file_undo_restores_the_exact_unsaved_editor_snapshot/);
assert.match(rust, /durable_file_mutation_state_rejects_noop_replay_and_unapplied_or_forged_undo/);
assert.match(rust, /retry_source_and_conversation_delete_are_exact_and_project_scoped/);
assert.match(store, /pub fn agent_conversation_turn_ids/);
assert.match(store, /pub fn agent_file_mutation_events/);

const cancelSource = rust.slice(
  rust.indexOf("async fn cancel_agent_turn"),
  rust.indexOf("fn write_source", rust.indexOf("async fn cancel_agent_turn")),
);
assert.match(cancelSource, /get_agent_turn_detail\(&project_root, &turn_id\)/);
assert.match(cancelSource, /project_transition_gate\.lock\(\)\.await/);
assert.match(cancelSource, /\.cancel_turn\(&turn_id, "Agent turn cancelled by the user\."\)/);
assert.doesNotMatch(cancelSource, /\.cancel_all\(/);
assert.match(cancelSource, /agent_workspace_lane\.cancel_turn\(&turn_id\)/);
assert.match(cancelSource, /clear_turn_cancellation\(&turn_id\)/);
assert.match(cancelSource, /request_cancel\(&project_root, run_id\)/);
assert.match(cancelSource, /session\.interrupt\(\)\.await/);
assert.match(cancelSource, /terminal_reason: Some\("user_cancelled"\.to_string\(\)\)/);

assert.match(server, /struct PendingApprovalWaiter \{[\s\S]*turn_id: Option<String>/);
assert.match(server, /pub async fn respond_for_turn\(/);
assert.match(server, /pub async fn cancel_turn\(&self, turn_id: &str/);
assert.match(server, /pending_approval_cancellation_is_scoped_to_the_owning_turn/);
assert.match(server, /pub struct AgentWorkspaceLane/);
assert.match(server, /event_type: "resource\.waiting"\.to_string\(\)/);
assert.match(server, /dispatch_workspace_request_with_execution_id\([\s\S]*Some\(&execution_id\)/);
assert.match(server, /cancelling_a_queued_workspace_claim_releases_no_shared_capacity/);
assert.match(server, /workspace_lane_serializes_two_claims_and_completes_both/);
assert.match(server, /workspace_lane_cancellation_returns_only_the_owning_active_run/);
assert.match(store, /pub fn interrupt_agent_environment_operations/);
assert.match(store, /AND source = 'agent'[\s\S]*AND status IN \('requested', 'approved', 'running'\)/);
assert.match(store, /interrupting_agent_environment_operation_is_exact_turn_only/);
assert.match(rust, /pending_count: agent_tasks\.len\(\)/);
assert.match(rust, /stopping_multiple_agent_tasks_persists_each_terminal_reason_once/);

assert.match(js, /agentSubmissionPending: false/);
assert.match(js, /function activeAgentConversations\(\)/);
assert.match(js, /function agentTurnAdmissionState\(mode = state\.agentMode, taskKind = "agent_turn"\)/);
assert.match(js, /active\.length >= 2/);
assert.doesNotMatch(js, /mode === "act" && active\.length > 0/);
assert.doesNotMatch(js, /AGENT_ACT_EXCLUSIVE/);
assert.match(js, /state\.agentBusy = state\.agentSubmissionPending \|\| Boolean\(state\.activeAgentTurnId\)/);
assert.match(js, /aggregate\.push\(`\$\{runningCount\} running`\)/);
assert.match(js, /aggregate\.push\(`\$\{waitingCount\} waiting approval/);
assert.match(js, /const admission = agentTurnAdmissionState\(mode, taskKind\);[\s\S]*if \(admission\.reason\)/);
assert.match(js, /\$\("#agentModelSelector"\)\.disabled = false/);
assert.match(js, /previewState === "parallel-turns"/);
assert.match(js, /previewState === "retry-delete"/);
for (const previewState of ["file-proposal-recovered", "file-proposal-not-applied", "file-proposal-uncertain"]) {
  assert.ok(js.includes(`"${previewState}"`), `Deterministic preview state ${previewState} must exist`);
}
assert.match(js, /agent_header: \$\("#agentState"\)\.textContent/);
assert.match(js, /cancel_visible: !\$\("#agentCancelButton"\)\.classList\.contains\("hidden"\)/);
assert.match(js, /invoke\("apply_agent_file_edit"/);
assert.match(js, /invoke\("undo_agent_file_edit"/);
assert.match(js, /expectedDiskSha256: snapshot\.expectedDiskSha256/);
assert.match(js, /isAgentFileResourceStale/);
assert.match(js, /function durableFileEditProjection\(proposal\)/);
assert.match(js, /decision: "uncertain"/);
assert.match(js, /decision: "not_applied"/);
assert.match(js, /file_edit\.mutation_started/);
assert.match(js, /file_edit\.recovered/);
assert.match(js, /file_edit\.outcome_uncertain/);
assert.match(js, /mockAgentFileMutationClaims/);
assert.match(js, /function mockAgentFileMutationState\(turn, request\)/);
assert.match(js, /function mockRequireAgentFileApplyAvailable\(mutation\)/);
assert.match(js, /function mockRequireAgentFileUndoLedger\(mutation\)/);
assert.match(js, /AGENT_FILE_ALREADY_DECIDED/);
assert.match(js, /restore_content_sha256/);
assert.match(js, /if \(command === "retry_agent_turn"\)/);
assert.match(js, /if \(command === "delete_agent_conversation"\)/);
assert.match(js, /invoke\("retry_agent_turn", \{ turnId \}\)/);
assert.match(js, /invoke\("delete_agent_conversation"/);
assert.match(html, /id="agentRetryTurnButton"/);
assert.match(html, /id="agentDeleteConversationButton"/);

const composerSource = js.slice(
  js.indexOf("function syncAgentComposerState"),
  js.indexOf("function syncAgentModeControl"),
);
assert.doesNotMatch(
  composerSource,
  /agentConversations\.some\(\(conversation\) => \["running", "waiting"\]\.includes\(conversation\.status\)\)/,
  "One unrelated running Conversation must not globally disable the composer",
);

console.log("Agent Conversation bounded-concurrency contract checks passed.");
