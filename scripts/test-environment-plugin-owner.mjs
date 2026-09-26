// Independent native Environment sources; these unit tests never start R.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-independent-environment-')));
const installed=name=>fs.realpathSync(execFileSync('rustup',['which',name],{cwd:root,encoding:'utf8'}).trim());
const env={...process.env,RUSTC:installed('rustc'),RUSTDOC:installed('rustdoc'),CARGO_TARGET_DIR:path.join(root,'target'),CARGO_BUILD_JOBS:'2'};
const cargo=installed('cargo');
const target=execFileSync(env.RUSTC,['-vV'],{encoding:'utf8'}).match(/^host: (.+)$/m)?.[1];assert.ok(target);
let complete=false;
try {
  const parts=['plugins/environment/api','plugins/environment/backend/owner','plugins/process/api','plugins/process/backend/engine','plugins/process/backend/owner','crates/plugin-protocol'];
  for(const part of parts)fs.cpSync(path.join(root,part),path.join(temporary,part),{recursive:true,filter:file=>!/[\\/](?:target|dist|node_modules)(?:[\\/]|$)/.test(file)});
  fs.writeFileSync(path.join(temporary,'Cargo.toml'),`[workspace]\nresolver = "3"\nmembers = ${JSON.stringify(parts)}\n`);
  fs.copyFileSync(path.join(root,'Cargo.lock'),path.join(temporary,'Cargo.lock'));
  const metadata=JSON.parse(execFileSync(cargo,['metadata','--offline','--filter-platform',target,'--format-version','1'],{cwd:temporary,env,encoding:'utf8',maxBuffer:16*1024*1024}));
  const members=metadata.packages.filter(pkg=>metadata.workspace_members.includes(pkg.id));
  assert.deepEqual(members.map(pkg=>pkg.name).sort(),['rho-environment-api','rho-environment-owner','rho-plugin-protocol','rho-process-api','rho-process-engine','rho-process-owner']);
  for(const pkg of members)for(const dependency of pkg.dependencies)if(dependency.path)assert.ok(dependency.path.startsWith(temporary+path.sep),`${pkg.name}: dependency leaves independent source`);
  execFileSync(cargo,['test','-p','rho-environment-api','-p','rho-environment-owner','--lib','--locked','--offline'],{cwd:temporary,env,stdio:'inherit'});
  complete=true;
  console.log('Independent Environment API/native-owner checks passed using only public/plugin sources. No R runtime or package installation was started.');
} finally {
  if(complete)fs.rmSync(temporary,{recursive:true,force:true});else console.error(`Independent Environment evidence retained at ${temporary}`);
}
