import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const ark=process.env.RHO_ARK || path.resolve(root,"target/debug",process.platform==="win32"?"ark.exe":"ark");
assert.ok(fs.existsSync(ark),"Set RHO_ARK to an installed Ark executable.");
const rProbe=spawnSync("Rscript",["--vanilla","-e","cat(R.home())"],{encoding:"utf8"});
assert.equal(rProbe.status,0,rProbe.stderr);
const env={...process.env,RHO_ARK:ark,RHO_R_HOME:process.env.RHO_R_HOME || rProbe.stdout.trim()};
// Cold compilation is not an environment-runtime timeout. Build the same test
// target first, then keep the existing bounded execution check below.
const compiled=spawnSync("cargo",["test","--manifest-path","Cargo.toml","-p","rho-host","--test","environment","--locked","--no-run"],{
  cwd:root,env,stdio:"inherit",timeout:900_000,
});
assert.equal(compiled.status,0,compiled.error?.message || compiled.signal || "Environment test build failed.");
const result=spawnSync("cargo",["test","--manifest-path","Cargo.toml","-p","rho-host","--test","environment","--locked","--","--ignored","--nocapture","--test-threads=1"],{
  cwd:root,env,stdio:"inherit",timeout:180_000,
});
assert.equal(result.status,0,result.error?.message || result.signal || "Environment integration failed.");
console.log("Verified pak/renv, installer cancellation, live-library retention, quarantine/restore/purge, lost-commit recovery, namespace probes, restart binding and unchanged user library.");
console.log("Fixed CLI Environment composition is retired; ordinary-plugin acceptance uses test-environment-plugin.mjs.");
