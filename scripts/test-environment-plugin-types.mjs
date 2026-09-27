import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rho-environment-types-'));
try {
  fs.cpSync(path.join(root,'plugins/environment/sdk'),path.join(directory,'sdk'),{recursive:true});
  fs.writeFileSync(path.join(directory,'package.json'),'{"type":"module"}');
  fs.writeFileSync(path.join(directory,'consumer.ts'),`import type {EnvironmentLibrary,EnvironmentConfiguration,EnvironmentResult,EnvironmentRecovery,EnvironmentSnapshot,EnvironmentPlan,EnvironmentRealization,ResourceReference,RetentionView,MaterialChange,EnvironmentCleanupArguments,EnvironmentChangeTrashArguments} from './sdk/index.js';
function library(value:EnvironmentLibrary){return [value.binding.provider,value.source.provider,value.realization,value.library_digest,value.report];}
const configuration:EnvironmentConfiguration={rscript:null,storage_root:null,checkpoint_reader:null,timeout_seconds:300};
const selectedReader:EnvironmentConfiguration={...configuration,checkpoint_reader:{plugin:'org.rho.r',instance:'reader',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)}};
// @ts-expect-error Reader selection needs the complete exact identity, not an alias.
const ambiguousReader:EnvironmentConfiguration={...configuration,checkpoint_reader:'r'};
function result(value:EnvironmentResult):ResourceReference{return value.report;}
function recovery(value:EnvironmentRecovery){return [value.operation,value.native_recovery,value.automatic_reexecution];}
function snapshot(value:EnvironmentSnapshot){return [value.status,value.observation?.packages,value.observation?.truncated];}
function plan(value:EnvironmentPlan){return [value.lock_digest,value.local_sources.map(source=>source.sha256)];}
function realization(value:EnvironmentRealization){return [value.verified,value.library_digest,value.plan_operation_id];}
function retention(value:RetentionView):EnvironmentCleanupArguments|null{return value.can_quarantine&&value.material.stage?{operation_id:value.source_operation_id,expected_fingerprint:value.material.stage.fingerprint}:null;}
function trash(value:MaterialChange,fingerprint:string):EnvironmentChangeTrashArguments{return {cleanup_operation_id:value.cleanup_operation_id,expected_fingerprint:fingerprint};}
const materialKind:EnvironmentResult['kind']='material';
// @ts-expect-error A result preserves the original report owner, bytes and digest.
const invalid:EnvironmentResult={operation:'original',kind:'plan',report:'raw-id',verified:null};
// @ts-expect-error A cached observation is not a committed execution outcome.
const wrong:EnvironmentSnapshot={status:'succeeded',observation:null,notices:[]};
void [library,configuration,selectedReader,ambiguousReader,result,recovery,snapshot,plan,realization,retention,trash,materialKind,invalid,wrong];
`);
  execFileSync(process.execPath,[path.join(root,'ui/node_modules/typescript/bin/tsc'),'--noEmit','--strict','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--rootDir',directory,path.join(directory,'consumer.ts')],{cwd:directory,stdio:'inherit'});
  console.log('Independent Environment contract consumer compiled using only public declarations.');
} finally {fs.rmSync(directory,{recursive:true,force:true});}
