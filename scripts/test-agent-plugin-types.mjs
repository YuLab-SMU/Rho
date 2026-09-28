import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-agent-types-'));
try {
  fs.cpSync(path.join(root, 'plugins/agent/sdk'), path.join(directory, 'sdk'), {recursive: true});
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(directory, 'consumer.ts'), `import type {ComponentAgentStart,ComponentAgentRun,ComponentAgentEventPage,ComponentToolReceipt,ApplicationCommandRequest,ApplicationCommandReceipt,AgentModelRun,ComponentModelSettings,ComponentToolSpec,AgentTaskRequest,AgentTaskDetail,AgentTaskEventPage,ProjectAgentTaskPage,AgentControllerRef,AgentProvider,AgentClientSession,AgentNativeCapabilities,AgentUsageObservation,LocalAgent} from './sdk/index.js';
const controller:AgentControllerRef={window_id:'window',incarnation:'incarnation'};
const providers:AgentProvider[]=['codex','kimi','deepseek'];
function session(value:AgentClientSession):AgentControllerRef{return value.window;}
function discovery(value:LocalAgent){return [value.models,value.capabilities,value.setup_required,value.error];}
function modes(value:AgentNativeCapabilities){return value.modes.map(mode=>[mode.id,mode.name,mode.description]);}
function usage(value:AgentUsageObservation):number|null{return value.total_tokens;}
// @ts-expect-error Correlation identity requires both the window and its incarnation.
const incomplete:AgentControllerRef={window_id:'window'};
// @ts-expect-error Native missing counters remain unknown, not a guaranteed number.
function inventedUsage(value:AgentUsageObservation):number{return value.total_tokens;}
// @ts-expect-error An Agent session includes native identity and bounded observations.
const fabricated:AgentClientSession={window:controller,provider:'kimi',state:'ready'};
function captured(request:AgentTaskRequest){return [request.request_id,request.window.incarnation,request.command.kind];}
function task(value:AgentTaskDetail){return [value.summary.attachment.control_frozen,value.draft.content.context,value.receipts.map(receipt=>receipt.submitted_draft)];}
function events(value:AgentTaskEventPage){return [value.history_gap,value.history_generation,value.events.map(event=>event.usage?.total_tokens)];}
function projection(value:ProjectAgentTaskPage){return value.tasks.map(task=>task.reference.kind);}
// @ts-expect-error A captured send requires the exact draft version.
const uncaptured:AgentTaskRequest['command']={kind:'send',control:{task_id:'task',generation:1}};
function modelCapture(run:AgentModelRun, settings:ComponentModelSettings, tool:ComponentToolSpec){return [run.task_intent?.request_excerpt,run.budget.context_bytes,settings.connection?.credential.kind,tool.parameters];}
// @ts-expect-error A captured model run does not contain plaintext credentials.
function secret(run:AgentModelRun){return run.key;}
function componentRecords(start:ComponentAgentStart,run:ComponentAgentRun,events:ComponentAgentEventPage,tool:ComponentToolReceipt,call:ApplicationCommandRequest,receipt:ApplicationCommandReceipt){return [start.window.incarnation,run.recovery?.unresolved_mutations,events.history_gap,tool.operation_id,call.execution_target?.native_session_id,receipt.applied_document_summaries?.map(document=>document.sha256)];}
// @ts-expect-error Public document captures do not carry fixed scientific view controls.
const fixedView:ApplicationCommandRequest['action']={kind:'open_view',view_type:'objects',expected_context_version:'view'};
// @ts-expect-error Durable component runs contain credential references, never plaintext keys.
function componentSecret(run:ComponentAgentRun){return run.model.api_key;}
void [componentRecords,componentSecret,fixedView,modelCapture,secret,captured,task,events,projection,uncaptured,controller,providers,session,discovery,modes,usage,incomplete,inventedUsage,fabricated];
`);
  execFileSync(process.execPath, [path.join(root, 'ui/node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', directory, path.join(directory, 'consumer.ts')], {cwd: directory, stdio: 'inherit'});
  console.log('Independent Agent contract consumer compiled using only public declarations.');
} finally { fs.rmSync(directory, {recursive: true, force: true}); }
