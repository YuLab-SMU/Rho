import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function buildPackagesPlugin(destination) {
  assert.ok(destination,'Specify a new package directory outside the repository');
  const parent=fs.realpathSync(path.dirname(path.resolve(destination))),output=path.join(parent,path.basename(destination));
  assert.ok(output!==root&&!output.startsWith(root+path.sep),'Use an independent directory outside the core checkout');
  fs.mkdirSync(output);
  for(const [from,to] of [['plugins/packages','.'],['sdk/plugin-ui','public/plugin-ui'],['sdk/plugin-protocol','public/plugin-protocol'],['plugins/r/sdk','public/r-protocol']])
    fs.cpSync(path.join(root,from),path.join(output,to),{recursive:true,filter:source=>!/[\\/](?:target|dist|compiled|node_modules)(?:[\\/]|$)/.test(source)});
  fs.copyFileSync(path.join(root,'LICENSE'),path.join(output,'LICENSE'));
  const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    assert.ok(!entry.isSymbolicLink(),'Source package cannot contain symlinks');
    const file=path.join(dir,entry.name);return entry.isDirectory()?walk(file):[path.relative(output,file).split(path.sep).join('/')];
  });
  const manifest=JSON.parse(fs.readFileSync(path.join(output,'plugin.json'),'utf8'));
  manifest.source.files=walk(output).filter(file=>file!=='plugin.json'&&!manifest.source.lockfiles.includes(file)).sort();
  fs.writeFileSync(path.join(output,'plugin.json'),JSON.stringify(manifest,null,2)+'\n');
  execFileSync(process.execPath,[path.join(output,'build.mjs')],{cwd:output,stdio:'inherit',env:{...process.env,RHO_PLUGIN_NODE_MODULES:path.join(root,'ui/node_modules')}});
  return output;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(`Independent Packages package: ${buildPackagesPlugin(process.argv[2])}`);
