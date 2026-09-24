import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {buildObjectsPlugin} from './build-objects-plugin.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
assert.ok(process.env.RHO_ARK&&process.env.RHO_R_HOME,'Set explicit existing RHO_ARK and RHO_R_HOME; only disposable R sessions are tested');
const hostBinary=path.join(root,'target/debug/rho');
const hashHost=()=>createHash('sha256').update(fs.readFileSync(hostBinary)).digest('hex');
const originalHostHash=hashHost();
console.log(`Existing Host SHA-256: ${originalHostHash}`);
const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-r-objects-')));
let completed=false;
try {
  const native=path.join(directory,'r'),objectsPackage=path.join(directory,'objects');
  execFileSync(process.execPath,[path.join(root,'scripts/build-r-plugin.mjs'),native],{cwd:root,stdio:'inherit'});
  buildObjectsPlugin(objectsPackage);
  execFileSync('npm',['run','test:browser','--prefix','ui','--','r-plugin-objects.spec.ts'],{cwd:root,stdio:'inherit',env:{...process.env,RHO_R_PLUGIN_PACKAGE:native,RHO_OBJECTS_PLUGIN_PACKAGE:objectsPackage}});
  assert.equal(hashHost(),originalHostHash,'Independent packages must load without rebuilding the core');
  console.log(`Unchanged Host SHA-256: ${originalHostHash}`);completed=true;
} finally {
  if(completed)fs.rmSync(directory,{recursive:true,force:true});
  else console.error(`Incomplete acceptance packages retained: ${directory}`);
}
