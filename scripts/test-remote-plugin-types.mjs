import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-remote-types-'));
try {
  fs.cpSync(path.join(root, 'plugins/remote/sdk'), path.join(directory, 'sdk'), {recursive: true});
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(directory, 'consumer.ts'), `import type {RemoteConfiguration,RemoteStatus,RemoteRunResult,RemoteRunRecovery,RemoteExecutionReport,SlurmSnapshot,SlurmCancellation,SlurmSourceArguments,ResourceReference} from './sdk/index.js';
const disconnected:RemoteConfiguration={target:null};
const source:SlurmSourceArguments={submission_operation_id:'original'};
function result(value:RemoteRunResult):ResourceReference{return value.report;}
function bytes(value:RemoteExecutionReport){return new Uint8Array(value.transport.stdout.bytes);}
function recovery(value:RemoteRunRecovery){return [value.operation,value.native_outcome,value.report_transfer_confirmed,value.automatic_reexecution];}
function snapshot(value:SlurmSnapshot){return [value.source_operation,value.status,value.lookup?.jobs];}
function cancellation(value:SlurmCancellation){return [value.request_sent,value.after?.state];}
function status(value:RemoteStatus){return [value.target?.host_alias,value.target_key,value.activities.map(item=>item.phase)];}
// @ts-expect-error A read result must distinguish a busy observation from committed execution success.
const invalid:SlurmSnapshot={source_operation:'original',status:'succeeded',lookup:null,notice:''};
// @ts-expect-error A raw resource identifier lacks its bound owner and digest.
const missing:RemoteRunResult={operation:'op',target:{host_alias:'fixture',project_root:'/project',slurm_cluster:null},report:'resource',remote_exit_code:0,native_outcome:'succeeded'};
void [disconnected,source,result,bytes,recovery,snapshot,cancellation,status,invalid,missing];
`);
  execFileSync(process.execPath, [path.join(root, 'ui/node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', directory, path.join(directory, 'consumer.ts')], {cwd: directory, stdio: 'inherit'});
  console.log('Independent Remote contract consumer compiled with only public declarations.');
} finally { fs.rmSync(directory, {recursive: true, force: true}); }
