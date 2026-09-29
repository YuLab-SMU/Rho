import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {rAcceptanceOptions,rBuildInputDigest,rSourceCopies,recordRBuild,verifyRBuild} from './r-plugin-artifact.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const parse=args=>rAcceptanceOptions(args,{});
assert.throws(()=>parse([]),/R acceptance requires/);
assert.equal(parse(['--build']).build,true);
assert.equal(parse(['--package','/tmp/package']).packagePath,'/tmp/package');
assert.equal(rAcceptanceOptions([],{RHO_R_PLUGIN_PACKAGE:'/tmp/package'}).packagePath,'/tmp/package');
for(const args of [['--build','--package','/tmp/package'],['--package'],['--package','--build'],['--build','--build'],['--workspace'],['--typo']])assert.throws(()=>parse(args));
const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-r-workflow-')));
const write=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
try {
  const checkout=path.join(directory,'checkout'),pkg=path.join(directory,'package');
  for(const [source] of rSourceCopies)write(path.join(checkout,source,'source.rs'),source);
  for(const source of ['Cargo.toml','Cargo.lock','LICENSE','rust-toolchain.toml','scripts/build-r-plugin.mjs','scripts/r-plugin-artifact.mjs'])write(path.join(checkout,source),source);
  write(path.join(pkg,'plugin.json'),'{}');write(path.join(pkg,'dist/rho-r-backend'),'fixture');
  const inputs=rBuildInputDigest(checkout);
  assert.throws(()=>verifyRBuild(pkg,checkout),/no build receipt/);
  const receipt=recordRBuild(pkg,inputs,checkout,'workspace');assert.equal(receipt.build_mode,'workspace');
  assert.equal(verifyRBuild(pkg,checkout),pkg);
  const source=path.join(checkout,'plugins/r/source.rs');write(source,'changed');
  assert.throws(()=>verifyRBuild(pkg,checkout),/R sources changed/);
  assert.throws(()=>recordRBuild(pkg,inputs,checkout),/changed during the build/);
  write(source,'plugins/r');
  write(path.join(checkout,'docs/notes.md'),'unrelated edit');
  assert.equal(verifyRBuild(pkg,checkout),pkg);
  fs.appendFileSync(path.join(pkg,'dist/rho-r-backend'),'modified');assert.throws(()=>verifyRBuild(pkg,checkout),/package changed/);
  write(path.join(pkg,'dist/rho-r-backend'),'fixture');
  fs.chmodSync(path.join(pkg,'dist/rho-r-backend'),0o755);assert.throws(()=>verifyRBuild(pkg,checkout),/package changed/);
  fs.chmodSync(path.join(pkg,'dist/rho-r-backend'),0o644);
  fs.symlinkSync(source,path.join(pkg,'escape'));assert.throws(()=>verifyRBuild(pkg,checkout),/symlinks/);fs.unlinkSync(path.join(pkg,'escape'));
  for(const field of ['build_mode','platform','arch','format']) {
    fs.writeFileSync(`${pkg}.build.json`,JSON.stringify({...receipt,[field]:'unknown'}));assert.throws(()=>verifyRBuild(pkg,checkout));
  }
  fs.writeFileSync(`${pkg}.build.json`,JSON.stringify(receipt));assert.equal(verifyRBuild(pkg,checkout),pkg);
  assert.throws(()=>verifyRBuild(checkout,checkout),/external R package/);
  const independent=path.join(directory,'independent');write(path.join(independent,'plugin.json'),'{}');
  assert.equal(recordRBuild(independent,inputs,checkout,'independent').build_mode,'independent');
  assert.equal(verifyRBuild(independent,checkout),independent);

  // Observe the real entry points. A missing/stale selection must stop before
  // any compiler, renderer or native R fixture can start.
  const bin=path.join(directory,'bin'),marker=path.join(directory,'cargo-started');
  write(path.join(bin,'cargo'),'#!/bin/sh\nprintf "%s\\n" "$@" > "$RHO_WORKFLOW_MARKER"\nexit 99\n');fs.chmodSync(path.join(bin,'cargo'),0o755);
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,RHO_WORKFLOW_MARKER:marker,RHO_ARK:'/fixture/ark',RHO_R_HOME:'/fixture/R'};
  delete env.RHO_R_PLUGIN_PACKAGE;
  for(const runner of ['test-r-plugin.mjs','test-r-help.mjs','test-r-viewer.mjs','test-r-console.mjs','test-r-packages.mjs','test-r-plots.mjs','test-r-objects-plugin.mjs']) {
    for(const candidate of [null,pkg]) {
      const environment={...env,...(candidate?{RHO_R_PLUGIN_PACKAGE:candidate}:{})};
      const result=spawnSync(process.execPath,[path.join(root,'scripts',runner)],{env:environment,encoding:'utf8',timeout:5000});
      assert.equal(result.status,1,result.stderr);assert.match(result.stderr,candidate?/R sources changed/:/acceptance requires/);
      assert.ok(!fs.existsSync(marker),`${runner} started Cargo before validating reuse`);
    }
  }
  // A valid receipt reaches only the Host test, retaining both artifact and
  // receipt when that stage fails. The sentinel is not a real Cargo process.
  const current=path.join(directory,'current');write(path.join(current,'plugin.json'),'{}');write(path.join(current,'dist/rho-r-backend'),'sentinel fixture');
  recordRBuild(current,rBuildInputDigest(),root,'workspace');
  const run=spawnSync(process.execPath,[path.join(root,'scripts/test-r-plugin.mjs'),'--package',current],{env,encoding:'utf8',timeout:5000});
  assert.equal(run.status,1,run.stderr);
  assert.deepEqual(fs.readFileSync(marker,'utf8').trim().split('\n'),['test','-p','rho-host','--test','r_plugin_real_r','--locked','--','--ignored','--nocapture']);
  assert.equal(verifyRBuild(current),current);
} finally {fs.rmSync(directory,{recursive:true,force:true});}
console.log('R acceptance reuses exact source/artifact receipts, rejects stale or modified packages before execution, and preserves packages after Host-stage failure. No real Cargo or R process ran.');
