import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
const compiler=process.env.RHO_PLUGIN_TSC;
try {
  if(compiler) execFileSync(process.execPath,[compiler,'--project','tsconfig.json'],{cwd:root,stdio:'inherit'});
  else execFileSync('tsc',['--project','tsconfig.json'],{cwd:root,stdio:'inherit'});
} catch(error) { console.error('Viewer build failed. Select an existing TypeScript compiler; no tools were installed.');throw error; }
for(const name of ['index.html','style.css']) fs.copyFileSync(new URL('src/'+name,import.meta.url),new URL('dist/src/'+name,import.meta.url));
