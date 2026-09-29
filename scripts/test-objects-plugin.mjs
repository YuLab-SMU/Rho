import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'rho-objects-unit-'));
try {
  for(const [from,to] of [['plugins/objects','.'],['plugins/agent/sdk/component-input','public/agent-input'],['sdk/plugin-ui','public/plugin-ui'],['plugins/r/sdk','public/r-protocol'],['sdk/plugin-protocol','public/plugin-protocol']])
    fs.cpSync(path.join(root,from),path.join(temporary,to),{recursive:true,filter:source=>!/[\\/](?:node_modules|compiled|dist)(?:[\\/]|$)/.test(source)});
  fs.symlinkSync(path.join(root,'ui/node_modules'),path.join(temporary,'node_modules'),'dir');
  const manifest=JSON.parse(fs.readFileSync(path.join(temporary,'package.json'),'utf8'));
  const lock=JSON.parse(fs.readFileSync(path.join(temporary,'dependencies.lock'),'utf8'));
  for(const [name,version] of Object.entries({...manifest.dependencies,...manifest.devDependencies}))
    assert.equal(JSON.parse(fs.readFileSync(path.join(temporary,'node_modules',name,'package.json'),'utf8')).version,version);
  for(const [name,expected] of Object.entries(lock.packages)) {
    const file=path.join(temporary,name,'package.json');
    if(!fs.existsSync(file)) {assert.ok(expected.optional,`Missing locked dependency ${name}`);continue;}
    assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).version,expected.version,`Changed locked dependency ${name}`);
  }
  execFileSync(process.execPath,[path.join(temporary,'node_modules/typescript/bin/tsc'),'--project','tsconfig.json'],{cwd:temporary,stdio:'inherit'});
  execFileSync(process.execPath,[path.join(temporary,'node_modules/vitest/vitest.mjs'),'run'],{cwd:temporary,stdio:'inherit'});
  console.log('Independent Objects model, view components and copy flow passed with public R/plugin declarations and UI SDK.');
} finally {fs.rmSync(temporary,{recursive:true,force:true});}
