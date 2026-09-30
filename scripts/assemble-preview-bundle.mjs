// Assemble explicitly built packages plus retained archives. No builds or user installation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pluginCommand} from './plugin-set.mjs';
import {sha256} from './rho-bundle.mjs';
import {buildRhoBundle} from './build-rho-bundle.mjs';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){assert.ok(['--previous','--updates','--built','--rho','--out'].includes(args[i])&&args[i+1]&&!options[args[i]]);options[args[i]]=path.resolve(args[i+1]);}
for(const name of ['--previous','--updates','--built','--rho','--out'])assert.ok(options[name],`Supply ${name}`);
const previous=JSON.parse(fs.readFileSync(path.join(options['--previous'],'plugin-set.json')));
const updates=JSON.parse(fs.readFileSync(path.join(options['--updates'],'plugin-set.json')));
const built=JSON.parse(fs.readFileSync(options['--built']));
const setDirectory=options['--out']+'-set';fs.mkdirSync(setDirectory);
const assembly=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-preview-assembly-'))),database=path.join(assembly,'rho.sqlite');
const set={...previous,name:'Rho Preview 3 — workspace-aware Agent',assembly_cli_sha256:sha256(fs.readFileSync(options['--rho'])),packages:[]};
for(const old of previous.packages){
  const filename=path.join(setDirectory,old.file),source=built[old.plugin];
  if(source){
    const snapshot=pluginCommand(options['--rho'],database,'snapshot',source,'--target',old.artifacts[0].target);
    pluginCommand(options['--rho'],database,'export',snapshot.revision,filename);
  }else{
    const update=updates.packages.find(p=>p.plugin===old.plugin),selected=update??old;
    const bytes=fs.readFileSync(path.join(update?options['--updates']:options['--previous'],selected.file));
    assert.equal(sha256(bytes),selected.sha256);assert.equal(bytes.length,selected.bytes);
    fs.writeFileSync(filename,bytes,{flag:'wx'});
  }
  const bytes=fs.readFileSync(filename),archive=JSON.parse(bytes);assert.equal(archive.revision.manifest.id,old.plugin);
  set.packages.push({file:old.file,bytes:bytes.length,sha256:sha256(bytes),plugin:old.plugin,revision:archive.revision.id,artifacts:archive.artifacts.map(a=>({id:a.id,target:a.target}))});
}
fs.writeFileSync(path.join(setDirectory,'plugin-set.json'),JSON.stringify(set,null,2)+'\n');
fs.copyFileSync(new URL('./plugin-set.mjs',import.meta.url),path.join(setDirectory,'plugin-set.mjs'));
const result=buildRhoBundle({rho:options['--rho'],plugins:setDirectory,destination:options['--out']});
console.log(JSON.stringify({bundle:result.directory,set:setDirectory,assembly,manifest_sha256:sha256(fs.readFileSync(path.join(result.directory,'rho-bundle.json')))}));
