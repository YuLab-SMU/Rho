import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function prepareAnnotationSource(destination) {
  assert.ok(destination,'Specify a new package directory');
  const parent=fs.realpathSync(path.dirname(path.resolve(destination))),output=path.join(parent,path.basename(destination));
  assert.ok(output!==root&&!output.startsWith(root+path.sep),'Use a separate package directory');
  fs.mkdirSync(output);
  for(const [from,to] of [['plugins/annotations','.'],['crates/plugin-protocol','public/native/plugin-protocol'],['crates/plugin-sdk','public/native/plugin-sdk']])
    fs.cpSync(path.join(root,from),path.join(output,to),{recursive:true,filter:source=>!/[\\/](?:target|dist|node_modules)(?:[\\/]|$)/.test(source)});
  fs.copyFileSync(path.join(root,'LICENSE'),path.join(output,'LICENSE'));
  fs.copyFileSync(path.join(root,'Cargo.lock'),path.join(output,'Cargo.lock'));
  const cargoFile=path.join(output,'backend/Cargo.toml'),original=fs.readFileSync(cargoFile,'utf8');
  assert.ok(original.includes('../../../crates/plugin-sdk'));
  fs.writeFileSync(cargoFile,original.replace('../../../crates/plugin-sdk','../public/native/plugin-sdk'));
  fs.writeFileSync(path.join(output,'Cargo.toml'),'[workspace]\nresolver = "3"\nmembers = ["api", "backend", "backend/owner", "backend/store", "public/native/plugin-protocol", "public/native/plugin-sdk"]\n');
  const installed=name=>fs.realpathSync(execFileSync('rustup',['which',name],{encoding:'utf8'}).trim());
  const env={...process.env,RHO_PLUGIN_CARGO:installed('cargo'),RUSTC:installed('rustc'),RUSTDOC:installed('rustdoc'),CARGO_TARGET_DIR:path.join(root,'target')};
  const metadata=JSON.parse(execFileSync(env.RHO_PLUGIN_CARGO,['metadata','--offline','--format-version','1'],{cwd:output,env,encoding:'utf8',maxBuffer:16*1024*1024}));
  const packages=metadata.packages.filter(p=>!p.source);
  assert.deepEqual(packages.map(p=>p.name).sort(),['rho-annotation-api','rho-annotation-backend','rho-annotation-owner','rho-annotation-store','rho-plugin-protocol','rho-plugin-sdk']);
  for(const p of packages){assert.ok(p.manifest_path.startsWith(output+path.sep));for(const d of p.dependencies)if(d.path)assert.ok(d.path.startsWith(output+path.sep));}
  return {output, env};
}
export function buildAnnotationPlugin(destination,{workspace=true}={}) {
  const {output, env}=prepareAnnotationSource(destination);
  if(workspace)execFileSync(env.RHO_PLUGIN_CARGO,['build','-p','rho-annotation-backend','--bins','--locked','--offline'],{cwd:root,env,stdio:'inherit'});
  execFileSync(process.execPath,[path.join(output,'build.mjs'),...(workspace?['--reuse-native']:[])],{cwd:output,env,stdio:'inherit'});
  const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{assert.ok(!entry.isSymbolicLink());if(['dist','target'].includes(entry.name))return [];const file=path.join(dir,entry.name);return entry.isDirectory()?walk(file):[path.relative(output,file).split(path.sep).join('/')];});
  const manifest=JSON.parse(fs.readFileSync(path.join(output,'plugin.json'),'utf8'));
  manifest.source.files=walk(output).filter(file=>file!=='plugin.json'&&!manifest.source.lockfiles.includes(file)).sort();
  fs.writeFileSync(path.join(output,'plugin.json'),JSON.stringify(manifest,null,2)+'\n');
  return output;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length<=4&&process.argv.slice(3).every(a=>['--workspace','--independent'].includes(a)),'Usage: node scripts/build-annotation-plugin.mjs /new/package [--workspace | --independent]');
  console.log(buildAnnotationPlugin(process.argv[2],{workspace:!process.argv.includes('--independent')}));
}
