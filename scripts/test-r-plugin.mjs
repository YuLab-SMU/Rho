import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {rAcceptanceOptions, verifyRBuild} from './r-plugin-artifact.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const options=rAcceptanceOptions(process.argv.slice(2));
let source=options.packagePath ? verifyRBuild(options.packagePath) : null;
assert.ok(process.env.RHO_ARK && process.env.RHO_R_HOME,"Explicitly set RHO_ARK and RHO_R_HOME; this test creates only disposable native sessions");
if(options.build) {
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"rho-r-plugin-acceptance-")));
  source=path.join(directory,"package");
  console.log(`Retained R package: ${source}`);
  execFileSync(process.execPath,[path.join(root,"scripts/build-r-plugin.mjs"),source],{cwd:root,stdio:"inherit"});
  source=verifyRBuild(source);
}
// Reuse preserves the exact native artifact; only the affected Host fixture
// compiles here. Keep package/receipt even after a later-stage failure.
execFileSync("cargo",["test","-p","rho-host","--test","r_plugin_real_r","--locked","--","--ignored","--nocapture"],{
  cwd:root,stdio:"inherit",env:{...process.env,CARGO_BUILD_JOBS:"1",RHO_R_PLUGIN_PACKAGE:source}});
console.log("Retained native R plugin passed original-Operation, revision coexistence, original-commit queue recovery, pending cancellation, input/queue controls during drain and retained-output/context acceptance.");
