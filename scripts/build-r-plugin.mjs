import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const destination=process.argv[2];
assert.ok(destination,"Specify a new package directory outside the repository");
const parent=fs.realpathSync(path.dirname(path.resolve(destination)));
const output=path.join(parent,path.basename(destination));
assert.ok(output !== root && !output.startsWith(root+path.sep),"Use an independent directory outside the core checkout");
fs.mkdirSync(output); // Refuse replacing existing source or builds.
for(const [from,to] of [["plugins/r","."],["crates/plugin-protocol","public/plugin-protocol"],
  ["crates/plugin-sdk","public/plugin-sdk"],["vendor/jet-core","vendor/jet-core"]]) {
  fs.cpSync(path.join(root,from),path.join(output,to),{recursive:true,filter:source=>!/[\\/](?:target|dist|node_modules)(?:[\\/]|$)/.test(source)});
}
fs.copyFileSync(path.join(root,"LICENSE"),path.join(output,"LICENSE"));
const changes={
 "api/Cargo.toml":[["../../../crates/plugin-protocol","../public/plugin-protocol"]],
 "backend/Cargo.toml":[["../../../crates/plugin-sdk","../public/plugin-sdk"]],
 "backend/engine/Cargo.toml":[["../../../../crates/plugin-protocol","../../public/plugin-protocol"],["../../../../vendor/jet-core","../../vendor/jet-core"]],
};
for(const [file,pairs] of Object.entries(changes)) {
 let text=fs.readFileSync(path.join(output,file),"utf8");
 for(const [from,to] of pairs){assert.ok(text.includes(from),`${file}: dependency layout changed`);text=text.replace(from,to);}
 fs.writeFileSync(path.join(output,file),text);
}
fs.writeFileSync(path.join(output,"Cargo.toml"),'[workspace]\nresolver = "3"\nmembers = ["public/plugin-protocol", "public/plugin-sdk", "api", "backend", "backend/engine"]\nexclude = ["vendor/jet-core"]\n');
fs.copyFileSync(path.join(root,"Cargo.lock"),path.join(output,"Cargo.lock"));
const installed=name=>fs.realpathSync(execFileSync("rustup",["which",name],{cwd:root,encoding:"utf8"}).trim());
const env={...process.env,RHO_PLUGIN_CARGO:installed("cargo"),RUSTC:installed("rustc"),RUSTDOC:installed("rustdoc"),
 CARGO_BUILD_JOBS:"1",CARGO_TARGET_DIR:path.join(root,"target")};
// Resolve the standalone dependency closure offline, then all builds are locked.
execFileSync(env.RHO_PLUGIN_CARGO,["metadata","--offline","--format-version","1"],{cwd:output,env,stdio:"ignore"});
const metadata=JSON.parse(execFileSync(env.RHO_PLUGIN_CARGO,["metadata","--no-deps","--offline","--format-version","1"],{cwd:output,env,encoding:"utf8"}));
assert.deepEqual(metadata.packages.map(p=>p.name).sort(),["rho-plugin-protocol","rho-plugin-sdk","rho-r-api","rho-r-backend","rho-r-engine"]);
for(const pkg of metadata.packages) for(const dep of pkg.dependencies) if(dep.path) assert.ok(dep.path.startsWith(output+path.sep),`${pkg.name}: source escapes standalone package`);
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
 assert.ok(!entry.isSymbolicLink(),"source package cannot contain symlinks");
 const location=path.join(dir,entry.name);
 return entry.isDirectory()?walk(location):[path.relative(output,location).split(path.sep).join("/")];
});
const manifest=JSON.parse(fs.readFileSync(path.join(output,"plugin.json"),"utf8"));
manifest.source.files=walk(output).filter(file=>file!=="plugin.json" && file!=="Cargo.lock").sort();
fs.writeFileSync(path.join(output,"plugin.json"),JSON.stringify(manifest,null,2)+"\n");
execFileSync(process.execPath,[path.join(output,"build.mjs")],{cwd:output,env,stdio:"inherit"});
console.log(`Independent R plugin source and native artifact: ${output}`);
