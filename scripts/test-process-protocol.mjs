import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-process-types-'));
try {
  fs.cpSync(path.join(root, 'plugins/process/sdk'), path.join(directory, 'sdk'), {recursive: true});
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(directory, 'consumer.ts'), `import type {RunLocalArguments,ProcessReport,ProcessRunResult,ProcessRunRecovery,ProcessStatus,ProcessReconciliation,ResourceReference} from './sdk/index.js';
const request:RunLocalArguments={program:'/usr/bin/printf',args:['中文'],stdin:null,timeout_ms:1000,output_limit_bytes:65536};
function bytes(report:ProcessReport){return new Uint8Array(report.stdout.bytes);}
function result(value:ProcessRunResult):ResourceReference{return value.report;}
function recovery(value:ProcessRunRecovery){return [value.operation,value.report_transfer_confirmed,value.automatic_reexecution,value.stdout?.eof];}
function status(value:ProcessStatus){return value.activities.map(item=>[item.operation,item.phase]);}
function reconcile(value:ProcessReconciliation){return [value.completeness,value.remaining.map(item=>item.started_at_seconds)];}
// @ts-expect-error Native scheduling cannot claim a committed operation outcome.
const invalid:ProcessStatus={activities:[{operation:'op-1',phase:'succeeded'}],capacity:16};
// @ts-expect-error Raw resource identity alone cannot substitute for a bound reference.
const missing:ProcessRunResult={operation:'op-1',report:'resource-1',pid:null,termination:'exited',exit_code:0,exit_signal:null};
void [request,bytes,result,recovery,status,reconcile,invalid,missing];
`);
  execFileSync(process.execPath, [path.join(root, 'ui/node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', directory, path.join(directory, 'consumer.ts')], {cwd: directory, stdio: 'inherit'});
  console.log('Independent Process contract consumer compiled with only public declarations.');
} finally { fs.rmSync(directory, {recursive: true, force: true}); }
