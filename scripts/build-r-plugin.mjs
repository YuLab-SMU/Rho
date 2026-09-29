import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {rSourceCopies, excludedRSource, rBuildInputDigest, recordRBuild} from './r-plugin-artifact.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const destination=process.argv[2];
assert.ok(destination,"Specify a new package directory outside the repository");
assert.ok(process.argv.slice(3).every(arg=>arg==='--workspace') && process.argv.length<=4, 'Usage: node scripts/build-r-plugin.mjs DEST [--workspace]');
const workspace=process.argv.includes('--workspace');
const parent=fs.realpathSync(path.dirname(path.resolve(destination)));
const output=path.join(parent,path.basename(destination));
assert.ok(output !== root && !output.startsWith(root+path.sep),"Use an independent directory outside the core checkout");
const inputs=rBuildInputDigest();
fs.mkdirSync(output); // Refuse replacing existing source or builds.
for(const [from,to] of rSourceCopies) {
  fs.cpSync(path.join(root,from),path.join(output,to),{recursive:true,filter:source=>{
    assert.ok(!fs.lstatSync(source).isSymbolicLink(),'Package source must not contain symlinks');
    return !excludedRSource(source);
  }});
}
fs.copyFileSync(path.join(root,"LICENSE"),path.join(output,"LICENSE"));
const changes={
 "api/Cargo.toml":[["../../../crates/plugin-protocol","../public/plugin-protocol"]],
 "backend/Cargo.toml":[["../../../crates/plugin-sdk","../public/plugin-sdk"],["../../environment/api","../environment/api"]],
 "environment/api/Cargo.toml":[["../../../crates/plugin-protocol","../../public/plugin-protocol"]],
 "process/api/Cargo.toml":[["../../../crates/plugin-protocol","../../public/plugin-protocol"]],
 "backend/engine/Cargo.toml":[["../../../../crates/plugin-protocol","../../public/plugin-protocol"],["../../../../vendor/jet-core","../../vendor/jet-core"]],
};
for(const [file,pairs] of Object.entries(changes)) {
 let text=fs.readFileSync(path.join(output,file),"utf8");
 for(const [from,to] of pairs){assert.ok(text.includes(from),`${file}: dependency layout changed`);text=text.replace(from,to);}
 fs.writeFileSync(path.join(output,file),text);
}
fs.writeFileSync(path.join(output,"Cargo.toml"),'[workspace]\nresolver = "3"\nmembers = ["public/plugin-protocol", "public/plugin-sdk", "api", "backend", "backend/engine", "environment/api", "process/api"]\nexclude = ["vendor/jet-core"]\n');
fs.copyFileSync(path.join(root,"Cargo.lock"),path.join(output,"Cargo.lock"));
const installed=name=>fs.realpathSync(execFileSync("rustup",["which",name],{cwd:root,encoding:"utf8"}).trim());
const env={...process.env,RHO_PLUGIN_CARGO:installed("cargo"),RUSTC:installed("rustc"),RUSTDOC:installed("rustdoc"),
 CARGO_BUILD_JOBS:process.env.CARGO_BUILD_JOBS ?? "1",CARGO_TARGET_DIR:path.join(root,"target")};
// Metadata validates the independent source closure without compiling it or
// fetching dependencies for unrelated platforms.
const target=execFileSync(env.RUSTC,['-vV'],{encoding:'utf8'}).match(/^host: (.+)$/m)?.[1];
assert.ok(target,'Installed compiler did not identify its target');
const metadata=JSON.parse(execFileSync(env.RHO_PLUGIN_CARGO,["metadata","--offline","--filter-platform",target,"--format-version","1"],{cwd:output,env,encoding:"utf8",maxBuffer:16*1024*1024}));
assert.deepEqual(metadata.packages.filter(p=>metadata.workspace_members.includes(p.id)).map(p=>p.name).sort(),["rho-environment-api","rho-plugin-protocol","rho-plugin-sdk","rho-process-api","rho-r-api","rho-r-backend","rho-r-engine"]);
for(const pkg of metadata.packages) {
  if(!pkg.source)assert.ok(pkg.manifest_path.startsWith(output+path.sep),`${pkg.name}: source leaves standalone package`);
  for(const dep of pkg.dependencies)if(dep.path)assert.ok(dep.path.startsWith(output+path.sep),`${pkg.name}: source escapes standalone package`);
}
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
 assert.ok(!entry.isSymbolicLink(),"source package cannot contain symlinks");
 const location=path.join(dir,entry.name);
 return entry.isDirectory()?walk(location):[path.relative(output,location).split(path.sep).join("/")];
});
const manifest=JSON.parse(fs.readFileSync(path.join(output,"plugin.json"),"utf8"));
manifest.source.files=walk(output).filter(file=>file!=="plugin.json" && file!=="Cargo.lock").sort();
fs.writeFileSync(path.join(output,"plugin.json"),JSON.stringify(manifest,null,2)+"\n");
if(workspace) {
  execFileSync(env.RHO_PLUGIN_CARGO,['build','--locked','--offline','-p','rho-r-backend','--bin','rho-r-backend'],{cwd:root,env,stdio:'inherit'});
  fs.mkdirSync(path.join(output,'dist'),{recursive:true});
  fs.copyFileSync(path.join(root,'target/debug/rho-r-backend'),path.join(output,'dist/rho-r-backend'));
  fs.chmodSync(path.join(output,'dist/rho-r-backend'),0o755);
} else execFileSync(process.execPath,[path.join(output,"build.mjs")],{cwd:output,env,stdio:"inherit"});
recordRBuild(output,inputs,root,workspace?'workspace':'independent');
console.log(`${workspace?'Workspace-built':'Independent'} R plugin source and native artifact: ${output}`);
