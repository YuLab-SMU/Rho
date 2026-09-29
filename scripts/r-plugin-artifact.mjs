// Local evidence beside a retained package, never a runtime cache.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const rSourceCopies=[['plugins/r','.'],['crates/plugin-protocol','public/plugin-protocol'],
  ['crates/plugin-sdk','public/plugin-sdk'],['vendor/jet-core','vendor/jet-core'],
  ['plugins/environment/api','environment/api'],['plugins/process/api','process/api']];
export const excludedRSource=source=>/[\\/](?:target|dist|compiled|node_modules|\.git)(?:[\\/]|$)/.test(source);
function treeDigest(directory, entries, exclude=()=>false) {
  const hash=createHash('sha256');
  function visit(relative) {
    const location=path.join(directory,relative),stat=fs.lstatSync(location);
    assert.ok(!stat.isSymbolicLink(),`Source/artifact must not contain symlinks: ${relative}`);
    if(exclude(location))return;
    if(stat.isDirectory())for(const name of fs.readdirSync(location).sort())visit(path.join(relative,name));
    else {
      assert.ok(stat.isFile(),`Expected regular file: ${relative}`);
      hash.update(JSON.stringify([relative.split(path.sep).join('/'),stat.mode&0o111,createHash('sha256').update(fs.readFileSync(location)).digest('hex')]));
    }
  }
  for(const entry of entries)visit(entry);
  return hash.digest('hex');
}
export function rBuildInputDigest(checkout=root) {
  return treeDigest(checkout,[...rSourceCopies.map(([from])=>from),'Cargo.toml','Cargo.lock','LICENSE',
    'rust-toolchain.toml','scripts/build-r-plugin.mjs','scripts/r-plugin-artifact.mjs'],excludedRSource);
}
export function recordRBuild(packagePath,inputDigest,checkout=root,mode='workspace') {
  assert.ok(['workspace','independent'].includes(mode),'Unknown R build mode');
  assert.equal(rBuildInputDigest(checkout),inputDigest,'R build inputs changed during the build; rebuild before acceptance');
  const receipt={format:1,build_mode:mode,inputs:inputDigest,platform:process.platform,arch:process.arch,package_sha256:treeDigest(packagePath,['.'])};
  fs.writeFileSync(`${packagePath}.build.json`,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  return receipt;
}
export function verifyRBuild(packagePath,checkout=root) {
  const resolved=fs.realpathSync(packagePath),project=fs.realpathSync(checkout);
  assert.ok(resolved!==project&&!resolved.startsWith(project+path.sep),'Use an external R package');
  assert.ok(fs.existsSync(`${resolved}.build.json`),'R package has no build receipt; build one retained package for the milestone');
  const receipt=JSON.parse(fs.readFileSync(`${resolved}.build.json`,'utf8'));
  assert.equal(receipt.format,1,'Unknown R build receipt');
  assert.ok(['workspace','independent'].includes(receipt.build_mode),'R receipt must identify its build mode');
  assert.equal(receipt.platform,process.platform,'R package platform changed');
  assert.equal(receipt.arch,process.arch,'R package architecture changed');
  assert.equal(receipt.inputs,rBuildInputDigest(checkout),'R sources changed; finish focused workspace checks, then build once for the milestone');
  assert.equal(receipt.package_sha256,treeDigest(resolved,['.']),'R package changed after its build');
  return resolved;
}
export function rAcceptanceOptions(argv,environment=process.env) {
  const options={build:false,packagePath:environment.RHO_R_PLUGIN_PACKAGE??null},seen=new Set();
  for(let index=0;index<argv.length;index++) {
    const arg=argv[index];assert.ok(!seen.has(arg),`Repeated option: ${arg}`);seen.add(arg);
    if(arg==='--build')options.build=true;
    else if(arg==='--package') {const value=argv[++index];assert.ok(value&&!value.startsWith('--'),'--package requires a path');options.packagePath=path.resolve(value);}
    else throw Error(`Unknown option: ${arg}`);
  }
  assert.ok(options.build!==Boolean(options.packagePath),'R acceptance requires --package <path> / RHO_R_PLUGIN_PACKAGE (reuse) OR --build (explicit independent build). For development build once with build-r-plugin.mjs DEST --workspace.');
  return options;
}
export function retainedRPackage(environment=process.env) {
  assert.ok(environment.RHO_R_PLUGIN_PACKAGE,'Browser acceptance requires retained RHO_R_PLUGIN_PACKAGE; build once with build-r-plugin.mjs DEST --workspace');
  return verifyRBuild(environment.RHO_R_PLUGIN_PACKAGE);
}
