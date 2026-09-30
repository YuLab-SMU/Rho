// One retained workspace build for the annotation milestone; no installation or bundle refresh.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildAnnotationPlugin} from './build-annotation-plugin.mjs';
import {buildAgentPlugin} from './build-agent-plugin.mjs';
import {buildEditorPlugin} from './build-editor-plugin.mjs';
const buildFilesPlugin=destination=>{execFileSync(process.execPath,['scripts/build-files-plugin.mjs',destination,'--workspace'],{stdio:'inherit'});return destination;};
import {buildHelpPlugin} from './build-help-plugin.mjs';
import {buildObjectsPlugin} from './build-objects-plugin.mjs';
import {buildPackagesPlugin} from './build-packages-plugin.mjs';
import {buildPlotsPlugin} from './build-plots-plugin.mjs';
import {buildConsolePlugin} from './build-console-plugin.mjs';
import {buildViewerPlugin} from './build-viewer-plugin.mjs';
const builders=new Map([['annotations',buildAnnotationPlugin],['agent',buildAgentPlugin],['editor',buildEditorPlugin],['files',buildFilesPlugin],['help',buildHelpPlugin],['objects',buildObjectsPlugin],['packages',buildPackagesPlugin],['plots',buildPlotsPlugin],['console',buildConsolePlugin],['viewer',buildViewerPlugin],['r',destination=>{execFileSync(process.execPath,['scripts/build-r-plugin.mjs',destination,'--workspace'],{stdio:'inherit'});return destination;}]]);
const receipt='target/plugin-refactor/annotation-foundation-build.json';
const requested=process.argv.slice(2);
if(requested.length>1||requested.some(arg=>!arg.startsWith('--only=')))throw Error('Usage: node scripts/prepare-annotation-foundation.mjs [--only=viewer,files]');
const selected=requested.length?requested[0].slice('--only='.length).split(','):[...builders.keys()];
if(!selected.length||selected.some(name=>!builders.has(name))||new Set(selected).size!==selected.length)throw Error('Choose distinct known plugin names.');
const packages=requested.length?JSON.parse(fs.readFileSync(receipt,'utf8')):{};
const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-annotation-foundation-')));
if(!requested.length)packages.parent=parent;
const stages=[];
for(const name of selected){
 const started=Date.now(),output=builders.get(name)(path.join(parent,name));
 packages[name]=output;stages.push({name,seconds:(Date.now()-started)/1000});
 if(!requested.length){packages.stages=[...stages];fs.writeFileSync(receipt,JSON.stringify(packages,null,2)+'\n');}
}
if(requested.length){packages.refreshes=[...(packages.refreshes??[]),{names:selected,stages}];fs.writeFileSync(receipt,JSON.stringify(packages,null,2)+'\n');}
console.log(JSON.stringify({packages:parent,stages}));
