import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rho-r-types-'));
try{
  fs.cpSync(path.join(root,'plugins/r/sdk'),path.join(directory,'sdk'),{recursive:true});
  fs.writeFileSync(path.join(directory,'package.json'),' {"type":"module"}');
  fs.writeFileSync(path.join(directory,'consumer.ts'),`import type {ExecuteR,RExecutionOutput,REventsObservation,ReadREvents,CheckRCode,ConsoleState,RespondInput} from './sdk/index.js';
const execute:ExecuteR={expected_session:'native',run:{code:'中文 <- 42',source:{view_id:'document',label:'分析.R',kind:'selection'},output_mode:'console'}};
const check:CheckRCode={expected_session:execute.expected_session,code:execute.run.code};
const events:ReadREvents={expected_session:execute.expected_session,operation_id:'original',after_sequence:0,limit:100};
const notStarted:RExecutionOutput={operation_id:'original',started:false};
// @ts-expect-error An actual native run requires its complete result, not this pre-start shape.
const contradictory:RExecutionOutput={operation_id:'original',started:true};
function observe(page:REventsObservation){return [page.session_id,page.output.next_sequence,page.output.has_more,page.output.gap] as const;}
function output(value:RExecutionOutput){if ('started' in value)return value.operation_id;return value.source?.label??value.report.digest;}
function answer(state:ConsoleState):RespondInput|null{const input=state.input;return input?{session_id:input.session_id,operation_id:input.operation_id,request_id:input.request_id,reply_id:'answer',value:'中文'}:null;}
void [execute,check,events,notStarted,contradictory,observe,output,answer];
`);
  execFileSync(process.execPath,[path.join(root,'ui/node_modules/typescript/bin/tsc'),'--noEmit','--strict','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--rootDir',directory,path.join(directory,'consumer.ts')],{cwd:directory,stdio:'inherit'});
  console.log('Independent R protocol consumer compiles with only public declarations.');
}finally{fs.rmSync(directory,{recursive:true,force:true});}
