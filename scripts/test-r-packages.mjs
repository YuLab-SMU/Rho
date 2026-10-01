import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {buildPackagesPlugin} from './build-packages-plugin.mjs';
import {buildHelpPlugin} from './build-help-plugin.mjs';
import {retainedRPackage} from './r-plugin-artifact.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const native=retainedRPackage();
assert.ok(process.env.RHO_ARK&&process.env.RHO_R_HOME,'Set explicit existing RHO_ARK and RHO_R_HOME; only disposable R sessions are tested');
const hostBinary=path.join(root,'target/debug/rho');
const hashHost=()=>createHash('sha256').update(fs.readFileSync(hostBinary)).digest('hex');
const originalHostHash=hashHost();
console.log(`Existing Host SHA-256: ${originalHostHash}`);
const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-r-packages-')));
let completed=false;
try {
  const helpPackage=path.join(directory,'help'),packagesPackage=path.join(directory,'packages');
  buildHelpPlugin(helpPackage); buildPackagesPlugin(packagesPackage);
  execFileSync('npm',['run','test:browser','--prefix','ui','--','r-plugin-packages.spec.ts', ...process.argv.slice(2)],{cwd:root,stdio:'inherit',env:{...process.env,RHO_R_PLUGIN_PACKAGE:native,RHO_HELP_PLUGIN_PACKAGE:helpPackage,RHO_PACKAGES_PLUGIN_PACKAGE:packagesPackage}});
  assert.equal(hashHost(),originalHostHash,'Independent packages must load without rebuilding the core');
  console.log(`Unchanged Host SHA-256: ${originalHostHash}`);completed=true;
} finally {
  if(completed)fs.rmSync(directory,{recursive:true,force:true});
  else console.error(`Incomplete acceptance packages retained: ${directory}`);
}
