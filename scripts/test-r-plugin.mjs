import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
assert.ok(process.env.RHO_ARK && process.env.RHO_R_HOME,"Explicitly set RHO_ARK and RHO_R_HOME; this test creates only disposable native sessions");
const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"rho-r-plugin-acceptance-")));
const source=path.join(directory,"package");
try {
  // Cargo builds and tests are deliberately serial and use the same target tree.
  execFileSync(process.execPath,[path.join(root,"scripts/build-r-plugin.mjs"),source],{cwd:root,stdio:"inherit"});
  execFileSync("cargo",["test","-p","rho-host","--test","r_plugin_real_r","--locked","--","--ignored","--nocapture"],{
    cwd:root,stdio:"inherit",env:{...process.env,CARGO_BUILD_JOBS:"1",RHO_R_PLUGIN_PACKAGE:source}});
  console.log("Independent native R plugin passed original-Operation, revision coexistence, cancellation, input during drain and retained-output acceptance.");
} finally { fs.rmSync(directory,{recursive:true,force:true}); }
