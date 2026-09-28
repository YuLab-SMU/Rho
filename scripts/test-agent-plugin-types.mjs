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
  fs.writeFileSync(path.join(directory, 'consumer.ts'), `import type {AgentControllerRef,AgentProvider,AgentClientSession,AgentNativeCapabilities,AgentUsageObservation,LocalAgent} from './sdk/index.js';
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
void [controller,providers,session,discovery,modes,usage,incomplete,inventedUsage,fabricated];
`);
  execFileSync(process.execPath, [path.join(root, 'ui/node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', directory, path.join(directory, 'consumer.ts')], {cwd: directory, stdio: 'inherit'});
  console.log('Independent Agent contract consumer compiled using only public declarations.');
} finally { fs.rmSync(directory, {recursive: true, force: true}); }
