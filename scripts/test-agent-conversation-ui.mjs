import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "desktop", "dist", "index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "desktop", "dist", "app.js"), "utf8");
const rust = fs.readFileSync(path.join(root, "desktop", "src-tauri", "src", "main.rs"), "utf8");
const store = fs.readFileSync(path.join(root, "crates", "rho-store", "src", "lib.rs"), "utf8");
const migration = fs.readFileSync(path.join(root, "crates", "rho-store", "src", "migration.rs"), "utf8");
const spec = fs.readFileSync(
  path.join(root, "docs", "plans", "active-2026-08-09-agent-conversation-concurrency-spec.md"),
  "utf8",
);

assert.match(spec, /Issue #5 authorized end-to-end, CONV-1 and CONV-2 source\s+checkpoints accepted 2026-08-09, CONV-3 is not active/);
assert.match(spec, /Conversation owns conversational context\. Turn owns one execution\./);
assert.match(spec, /at most one nonterminal Turn may belong to a given\s+Conversation/i);

assert.match(html, /id="taskRailNew"[^>]*aria-label="New conversation"/);
assert.match(html, /id="taskRailList"[^>]*aria-label="Agent conversations"/);
assert.match(js, /agentConversations:\s*\[\]/);
assert.match(js, /selectedConversationId:\s*null/);
assert.match(js, /if \(command === "list_agent_conversations"\)/);
assert.match(js, /if \(command === "create_agent_conversation"\)/);
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
assert.match(js, /selected_conversation_id: state\.selectedConversationId/);
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
assert.match(rust, /fn list_agent_turns\([\s\S]*conversation_id: Option<String>/);
assert.match(rust, /list_agent_turns_for_conversation\(&project_root, &conversation_id, limit\)/);

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
