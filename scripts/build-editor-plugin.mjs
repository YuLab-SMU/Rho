import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function buildEditorPlugin(destination, {workspace = true} = {}) {
  assert.ok(destination,'Specify a new package directory outside the repository');
  const parent=fs.realpathSync(path.dirname(path.resolve(destination))),output=path.join(parent,path.basename(destination));
  assert.ok(output!==root&&!output.startsWith(root+path.sep),'Use an independent directory outside the core checkout');
  fs.mkdirSync(output);
  for(const [from,to] of [['plugins/editor','.'],['crates/plugin-protocol','public/native/plugin-protocol'],['crates/plugin-sdk','public/native/plugin-sdk'],['sdk/plugin-ui','public/plugin-ui'],['sdk/plugin-protocol','public/plugin-protocol'],['plugins/files/sdk','public/files-protocol'],['plugins/r/sdk','public/r-protocol']])
    fs.cpSync(path.join(root,from),path.join(output,to),{recursive:true,filter:source=>!/[\\/](?:target|dist|compiled|node_modules)(?:[\\/]|$)/.test(source)});
  fs.copyFileSync(path.join(root,'LICENSE'),path.join(output,'LICENSE'));
  const cargoFile=path.join(output,'backend/Cargo.toml');
  const cargoSource=fs.readFileSync(cargoFile,'utf8');
  assert.ok(cargoSource.includes('../../../crates/plugin-sdk'),'Editor backend dependency layout changed');
  fs.writeFileSync(cargoFile,cargoSource.replace('../../../crates/plugin-sdk','../public/native/plugin-sdk'));
  fs.writeFileSync(path.join(output,'Cargo.toml'),'[workspace]\nresolver = "3"\nmembers = ["backend", "public/native/plugin-protocol", "public/native/plugin-sdk"]\n');
  fs.copyFileSync(path.join(root,'Cargo.lock'),path.join(output,'Cargo.lock'));
  const installed=name=>fs.realpathSync(execFileSync('rustup',['which',name],{cwd:root,encoding:'utf8'}).trim());
  const env={...process.env,RHO_PLUGIN_CARGO:installed('cargo'),RUSTC:installed('rustc'),RUSTDOC:installed('rustdoc'),
    RHO_PLUGIN_NODE_MODULES:path.join(root,'ui/node_modules'),CARGO_BUILD_JOBS:process.env.CARGO_BUILD_JOBS??'2',CARGO_TARGET_DIR:path.join(root,'target')};
  const target=execFileSync(env.RUSTC,['-vV'],{encoding:'utf8'}).match(/^host: (.+)$/m)?.[1];
  assert.ok(target,'Installed compiler did not identify its target');
  const metadata=JSON.parse(execFileSync(env.RHO_PLUGIN_CARGO,['metadata','--offline','--filter-platform',target,'--format-version','1'],{cwd:output,env,encoding:'utf8',maxBuffer:16*1024*1024}));
  const packages=metadata.packages.filter(pkg=>metadata.workspace_members.includes(pkg.id));
  assert.deepEqual(packages.map(pkg=>pkg.name).sort(),['rho-editor-backend','rho-plugin-protocol','rho-plugin-sdk']);
  for(const pkg of packages)for(const dependency of pkg.dependencies)if(dependency.path)
    assert.ok(dependency.path.startsWith(output+path.sep),`${pkg.name}: dependency leaves standalone source`);
  const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    assert.ok(!entry.isSymbolicLink(),'Source package cannot contain symlinks');
    const file=path.join(dir,entry.name);return entry.isDirectory()?walk(file):[path.relative(output,file).split(path.sep).join('/')];
  });
  const manifest=JSON.parse(fs.readFileSync(path.join(output,'plugin.json'),'utf8'));
  manifest.source.files=walk(output).filter(file=>file!=='plugin.json'&&!manifest.source.lockfiles.includes(file)).sort();
  fs.writeFileSync(path.join(output,'plugin.json'),JSON.stringify(manifest,null,2)+'\n');
  if(workspace) execFileSync(env.RHO_PLUGIN_CARGO,['build','--locked','--offline','-p','rho-editor-backend','--bins'],{cwd:root,stdio:'inherit',env});
  execFileSync(process.execPath,[path.join(output,'build.mjs'),...(workspace?['--reuse-native']:[])],{cwd:output,stdio:'inherit',env});
  return output;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.slice(3).every(arg=>['--workspace','--independent'].includes(arg))&&process.argv.length<=4,
    'Usage: node scripts/build-editor-plugin.mjs /new/package [--workspace | --independent]');
  const workspace=!process.argv.includes('--independent');
  console.log(`${workspace?'Workspace-built':'Independent'} Editor package: ${buildEditorPlugin(process.argv[2],{workspace})}`);
}
