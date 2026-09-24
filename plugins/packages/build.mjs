import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
const dependencies=path.join(root,'node_modules');
let borrowed=false;
try {
  if(!fs.existsSync(dependencies)) {
    if(!process.env.RHO_PLUGIN_NODE_MODULES) throw new Error('Select an existing dependency directory with RHO_PLUGIN_NODE_MODULES.');
    fs.symlinkSync(fs.realpathSync(process.env.RHO_PLUGIN_NODE_MODULES),dependencies,'dir');borrowed=true;
  }
  const manifest=JSON.parse(fs.readFileSync(new URL('package.json',import.meta.url),'utf8'));
  for(const [name,version] of Object.entries({...manifest.dependencies,...manifest.devDependencies})) {
    const installed=JSON.parse(fs.readFileSync(path.join(dependencies,name,'package.json'),'utf8'));
    if(installed.version!==version) throw new Error(`${name} requires ${version}; installed ${installed.version}.`);
  }
  execFileSync(process.execPath,[path.join(dependencies,'typescript/bin/tsc'),'--project','tsconfig.json'],{cwd:root,stdio:'inherit'});
  execFileSync(process.execPath,[path.join(dependencies,'vite/bin/vite.js'),'build','--base=./','--outDir=dist'],{cwd:root,stdio:'inherit'});
  const lock=JSON.parse(fs.readFileSync(new URL('dependencies.lock',import.meta.url),'utf8'));
  const notices=[];
  for(const name of Object.keys(lock.packages).sort()) {
    const directory=path.join(dependencies,name.replace(/^node_modules\//,''));
    if(!fs.existsSync(directory)) {
      if(lock.packages[name].optional) continue; // Other-platform optional packages.
      throw new Error(`Missing locked dependency ${name}.`);
    }
    const installed=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
    if(installed.version!==lock.packages[name].version) throw new Error(`${name} differs from dependencies.lock.`);
    for(const file of fs.readdirSync(directory).filter(file=>/^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(file))) {
      const location=path.join(directory,file);
      if(fs.statSync(location).isFile()) notices.push(`${installed.name} ${installed.version} — ${file}\n\n${fs.readFileSync(location,'utf8')}`);
    }
  }
  fs.writeFileSync(path.join(root,'dist/THIRD-PARTY-NOTICES.txt'),notices.join('\n\n────────────────────────────────────────\n\n'));
} catch(error) { console.error('Packages build failed. No dependencies or tools were installed.');throw error; }
finally { if(borrowed) fs.unlinkSync(dependencies); }
