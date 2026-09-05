import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const ark=process.env.RHO_NEXT_ARK || path.resolve(root,"../target/debug",process.platform==="win32"?"ark.exe":"ark");
assert.ok(fs.existsSync(ark),"Set RHO_NEXT_ARK to an installed Ark executable.");
const rProbe=spawnSync("Rscript",["--vanilla","-e","cat(R.home())"],{encoding:"utf8"});
assert.equal(rProbe.status,0,rProbe.stderr);
const env={...process.env,RHO_NEXT_ARK:ark,RHO_NEXT_R_HOME:process.env.RHO_NEXT_R_HOME || rProbe.stdout.trim()};
const result=spawnSync("cargo",["test","--manifest-path","Cargo.toml","-p","rho-next-host","--test","environment","--locked","--","--ignored","--nocapture","--test-threads=1"],{
  cwd:root,env,stdio:"inherit",timeout:180_000,
});
assert.equal(result.status,0,result.error?.message || result.signal || "Environment integration failed.");
console.log("Verified pak plan/install, confirmed installer cancellation, renv restore, namespace probes, source/library tampering, restart binding and unchanged user library.");
const run=(command,args,options={})=>{
  const output=spawnSync(command,args,{cwd:root,encoding:"utf8",timeout:120_000,...options});
  assert.equal(output.status,0,output.error?.message || output.stderr || output.signal);
  return output.stdout;
};
run("cargo",["build","--manifest-path","Cargo.toml","-p","rho-next-cli","--locked"],{stdio:"inherit"});
const metadata=JSON.parse(run("cargo",["metadata","--manifest-path","Cargo.toml","--no-deps","--format-version","1","--locked"]));
const binary=path.join(metadata.target_directory,"debug",process.platform==="win32"?"rho-next.exe":"rho-next");
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"rho-next-environment-cli-"));
try{
  const project=path.join(directory,"project");fs.mkdirSync(project);
  fs.cpSync(path.join(root,"host/tests/fixtures/rhonextfixture"),path.join(project,"pkg"),{recursive:true});
  const database=path.join(directory,"state/next.sqlite");
  const common=["--database",database,"--project",project];
  const rscript=path.join(env.RHO_NEXT_R_HOME,"bin",process.platform==="win32"?"Rscript.exe":"Rscript");
  const invoke=(id,capability,arguments_)=>JSON.parse(run(binary,[...common,"--rscript",rscript,"invoke",
    "--client-request-id",id,"--capability",capability,"--arguments",JSON.stringify(arguments_)]));
  const plan=invoke("plan","environment.plan",{manager:"pak",packages:["local::pkg"]});
  assert.equal(plan.operation.status,"succeeded");
  const realized=invoke("realize","environment.realize",{plan_operation_id:plan.operation.operation.operation_id});
  assert.equal(realized.operation.status,"succeeded");
  const answer=JSON.parse(run(binary,[...common,"--ark",ark,"--r-home",env.RHO_NEXT_R_HOME,
    "--environment",realized.operation.operation.operation_id,"invoke","--client-request-id","use",
    "--code","rhonextfixture::fixture_answer()"]));
  assert.equal(answer.operation.status,"succeeded");
  assert.equal(answer.operation.output.value,42);
  console.log("Verified CLI environment planning, realization and --environment activation in a new Ark session.");
}finally{fs.rmSync(directory,{recursive:true,force:true});}
