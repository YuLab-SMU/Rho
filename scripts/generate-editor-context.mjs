import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'rho-editor-context-manifest-'));
try {
  const source=path.join(root,'plugins/editor/plugin.json'),output=path.join(temporary,'plugin.json');
  fs.copyFileSync(source,output);
  execFileSync('cargo',['run','-p','rho-editor-backend','--bin','export-editor-context','--locked','--offline','--',output],{cwd:root,stdio:'inherit'});
  const generated=fs.readFileSync(output,'utf8');
  if(process.argv.includes('--check'))assert.deepEqual(JSON.parse(fs.readFileSync(source,'utf8')),JSON.parse(generated),'Editor context manifest schemas are stale');
  else fs.writeFileSync(source,generated);
  console.log('Editor context manifest matches the public protocol schemas.');
} finally {fs.rmSync(temporary,{recursive:true,force:true});}
