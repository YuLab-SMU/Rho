import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "desktop", "dist", "index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "desktop", "dist", "app.js"), "utf8");
const rust = fs.readFileSync(path.join(root, "desktop", "src-tauri", "src", "main.rs"), "utf8");
const project = fs.readFileSync(path.join(root, "desktop", "src-tauri", "src", "project.rs"), "utf8");
const store = fs.readFileSync(path.join(root, "crates", "rho-store", "src", "lib.rs"), "utf8");
const migration = fs.readFileSync(path.join(root, "crates", "rho-store", "src", "migration.rs"), "utf8");
const spec = fs.readFileSync(
  path.join(root, "docs", "plans", "active-2026-08-09-agent-conversation-concurrency-spec.md"),
  "utf8",
);

function productionFunction(name) {
  const source = js.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
  assert.ok(source, `Production function ${name} must be available to the contract test`);
  return Function(`"use strict"; return (${source});`)();
}

assert.match(spec, /Issue #5 authorized end-to-end, CONV-1 through CONV-3 source\s+checkpoints accepted 2026-08-09/);
assert.match(spec, /Conversation owns conversational context\. Turn owns one execution\./);
assert.match(spec, /at most one nonterminal Turn may belong to a given\s+Conversation/i);
assert.match(spec, /CONV-3-R1: selected Conversation recovery amendment/);
assert.match(spec, /selected_agent_conversation_id/);

assert.match(html, /id="taskRailNew"[^>]*aria-label="New conversation"/);
assert.match(html, /id="taskRailList"[^>]*aria-label="Agent conversations"/);
assert.match(html, /id="agentRetryTurnButton"[^>]*>Retry turn<\/button>/);
assert.match(html, /id="agentDeleteConversationButton"[^>]*>Delete conversation<\/button>/);
assert.match(js, /agentConversations:\s*\[\]/);
assert.match(js, /selectedConversationId:\s*null/);
assert.match(js, /if \(command === "list_agent_conversations"\)/);
assert.match(js, /if \(command === "create_agent_conversation"\)/);
assert.match(js, /if \(command === "retry_agent_turn"\)/);
assert.match(js, /if \(command === "delete_agent_conversation"\)/);
assert.match(js, /invoke\("list_agent_conversations", \{ limit: 50 \}\)/);
assert.match(js, /invoke\("list_agent_turns", \{ conversationId: preferredConversationId, limit: 50 \}\)/);
assert.match(js, /state\.agentConversations = \[\];[\s\S]{0,220}state\.selectedConversationId = null;[\s\S]{0,180}state\.agentActivityExpanded\.clear\(\)/);
assert.match(js, /loadAgentData\(\{ quiet: true \}\),[\s\S]{0,120}loadRunData\(\{ quiet: true \}\)/);
assert.match(js, /item\.project_root === mockLastProject && \(!args\.status \|\| item\.status === args\.status\)/);
assert.match(js, /agentRefreshRequestSequence:\s*0/);
assert.match(js, /const requestIsCurrent = \(\) => requestSequence === state\.agentRefreshRequestSequence[\s\S]{0,180}projectRoot === state\.project\.root/);
const loadAgentDataSource = js.slice(
  js.indexOf("async function loadAgentData"),
  js.indexOf("function isStaleInformationError"),
);
assert.match(loadAgentDataSource, /invoke\("list_agent_turns"/);
assert.match(loadAgentDataSource, /invoke\("get_agent_turn_detail"/);
assert.ok(
  (loadAgentDataSource.match(/if \(!requestIsCurrent\(\)\) return false;/g) || []).length >= 3,
  "Agent history responses must be rejected after each asynchronous project-owned stage",
);
assert.match(loadAgentDataSource, /if \(!requestIsCurrent\(\)\) return false;[\s\S]*state\.agentConversations = conversations/);
assert.match(js, /item\.dataset\.conversationId = conversation\.conversation_id/);
assert.match(js, /async function selectTaskConversation\(conversationId\)/);
assert.match(js, /const conversationId = taskKind === "agent_turn" && !selectedConversation\?\.legacy_unthreaded[\s\S]{0,120}\? state\.selectedConversationId[\s\S]{0,80}: null/);
assert.match(js, /if \(status === "interrupted" && terminalReason === "user_cancelled"\) return "Cancelled"/);
assert.match(js, /previewState === "conversation-switch"/);
assert.match(js, /previewState === "session-recovery"/);
assert.match(js, /async function runAgentConversationSessionRecoveryMockProbe\(\)/);
assert.match(js, /project_a_exact_restore: Boolean\(savedProjectAId\)/);
assert.match(js, /project_a_selected_was_non_first: selectedProjectAConversationWasNonFirst/);
assert.match(js, /project_b_rejected_foreign_id: Boolean\(savedProjectAId\)/);
assert.match(js, /session_recovery: state\.agentSessionRecoveryPreviewProbe \|\| null/);
assert.match(js, /selected_conversation_id: state\.selectedConversationId/);
assert.match(js, /function normalizedSessionAgentConversationId\(value\)/);
assert.match(js, /selected_agent_conversation_id: normalizedSessionAgentConversationId\(state\.selectedConversationId\)/);
assert.match(
  js,
  /const session = loadEmergencySession\(state\.project\.root\) \|\| response\.session \|\| \{\};[\s\S]{0,180}state\.selectedConversationId = normalizedSessionAgentConversationId\([\s\S]{0,100}session\.selected_agent_conversation_id/,
);
assert.match(
  loadAgentDataSource,
  /preferredAgentConversationId\([\s\S]{0,100}conversations,[\s\S]{0,100}state\.selectedConversationId/,
  "A restored selection must be validated against the active project's authoritative list",
);
assert.match(
  loadAgentDataSource,
  /if \(previouslySelectedConversationId !== preferredConversationId\) scheduleSessionSave\(\)/,
  "A stale or foreign saved selection must persist its repaired current-project fallback",
);
const createConversationSource = js.slice(
  js.indexOf("async function startNewAgentTask"),
  js.indexOf("async function selectTaskConversation"),
);
const selectConversationSource = js.slice(
  js.indexOf("async function selectTaskConversation"),
  js.indexOf("async function retrySelectedAgentTurn"),
);
assert.match(createConversationSource, /state\.selectedConversationId = conversation\.conversation_id;[\s\S]*scheduleSessionSave\(\)/);
assert.match(selectConversationSource, /state\.selectedConversationId = conversationId;[\s\S]*scheduleSessionSave\(\)/);

const normalizeSessionId = productionFunction("normalizedSessionAgentConversationId");
assert.equal(normalizeSessionId("agent_conversation_selected"), "agent_conversation_selected");
for (const malformed of [null, "", " agent_conversation_selected", "agent_conversation_selected\n", "x".repeat(257)]) {
  assert.equal(normalizeSessionId(malformed), null, `Malformed session ID ${JSON.stringify(malformed)} must fall back`);
}
assert.equal(normalizeSessionId("会".repeat(100)), null, "The 256-byte ID bound must include UTF-8 width");

const chooseConversation = productionFunction("preferredAgentConversationId");
const projectBConversations = [
  { conversation_id: "agent_conversation_b_first", status: "completed", pending_request_id: null },
  { conversation_id: "agent_conversation_b_running", status: "running", pending_request_id: null },
];
assert.equal(
  chooseConversation(projectBConversations, "agent_conversation_a_foreign"),
  "agent_conversation_b_running",
  "A foreign-project saved ID must fall back using only the active project's list",
);
assert.equal(
  chooseConversation(projectBConversations, "agent_conversation_b_first"),
  "agent_conversation_b_first",
  "An exact current-project saved ID must be restored",
);
assert.equal(chooseConversation([], "agent_conversation_deleted"), null);
assert.match(js, /new_conversation_disabled: \$\("#taskRailNew"\)\.disabled/);
assert.match(
  js,
  /const approval = state\.pendingApprovals\.find\(\(item\) => item\.turn_id === state\.selectedTurnId\) \|\| null/,
  "Approval projection must stay bound to the selected turn",
);
assert.doesNotMatch(
  js,
  /pendingApprovals\.find\(\(item\) => item\.turn_id === state\.selectedTurnId\)\s*\|\|\s*state\.pendingApprovals\[0\]/,
  "Another conversation's approval must never be projected as selected",
);

assert.match(rust, /async fn run_agent\([\s\S]*conversation_id: Option<String>/);
assert.match(rust, /create_agent_turn_in_conversation\([\s\S]*&conversation_id/);
assert.match(rust, /async fn list_agent_conversations\(/);
assert.match(rust, /async fn create_agent_conversation\(/);
assert.match(rust, /async fn retry_agent_turn\(/);
assert.match(rust, /async fn delete_agent_conversation\(/);
assert.match(rust, /fn list_agent_turns\([\s\S]*conversation_id: Option<String>/);
assert.match(rust, /list_agent_turns_for_conversation\(&project_root, &conversation_id, limit\)/);
assert.match(project, /pub selected_agent_conversation_id: Option<String>/);
assert.match(project, /const MAX_AGENT_CONVERSATION_ID_BYTES: usize = 256/);
assert.match(project, /fn selected_agent_conversation_session_is_compatible_and_project_scoped\(\)/);

assert.match(store, /const SCHEMA_VERSION: i64 = 12/);
assert.match(store, /Agent Conversation already has a running turn/);
assert.match(store, /Agent Conversation belongs to a different project/);
assert.match(store, /Legacy project history is read-only; start a new conversation/);
assert.match(store, /fn migrates_v11_agent_turns_into_read_only_project_conversations\(\)/);
assert.match(store, /fn rolls_back_v11_conversation_migration_after_injected_failure_and_recovers\(\)/);
assert.match(store, /fn rejects_malformed_v11_agent_project_identity_without_advancing_schema\(\)/);
assert.match(store, /fn rejects_current_schema_with_a_cross_project_conversation_mapping\(\)/);
assert.match(migration, /CREATE TABLE agent_conversations/);
assert.match(migration, /CREATE TABLE agent_conversation_turns/);
assert.match(migration, /Legacy project history/);

console.log("Agent Conversation UI and broker contract checks passed.");
