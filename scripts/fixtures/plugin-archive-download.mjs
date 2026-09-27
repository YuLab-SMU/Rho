import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildUiFixture} from './plugin-ui.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export function buildArchiveDownloadUiFixture(directory){
 const project=buildUiFixture(directory),file=path.join(project,'plugin.json'),manifest=JSON.parse(fs.readFileSync(file,'utf8'));
 manifest.requires=manifest.requires.filter(item=>item.capability.id!=='fixture.answer');
 manifest.requires.push({capability:{id:'plugins.archive_read',version:1},scopes:['plugins.read']});
 const schema=JSON.parse(fs.readFileSync(path.join(root,'sdk/plugin-protocol/schema/archive-reference.json'),'utf8'));
 manifest.views[0].configuration_schema.properties.archive_reference=schema;
 manifest.views[0].configuration_schema.required=['archive_reference'];
 fs.writeFileSync(file,JSON.stringify(manifest,null,2));
 fs.appendFileSync(path.join(project,'src/main.js'),`\n{const original=client.view.configuration.archive_reference;
const automatic=document.createElement('output');automatic.id='automatic-archive';document.body.append(automatic);
client.downloadArchive(original,'Unrequested.rho-plugin').then(()=>automatic.textContent='Unexpected automatic download',error=>automatic.textContent=error.message);
const result=document.createElement('output');result.id='archive-download-result';document.body.append(result);
for(const corrupt of [false,true]){const button=document.createElement('button');button.textContent=corrupt?'Try foreign archive':'Download archive';result.before(button);
button.onclick=async()=>{result.dataset.status='pending';result.textContent='Collecting archive';try{await client.downloadArchive(corrupt?{...original,archive:'foreign'}:original,'源码与视图 Ω.rho-plugin');result.dataset.status='requested';result.textContent='Archive download requested';}catch(error){result.dataset.status='error';result.textContent=error.message;}};}}
`);
 execFileSync(process.execPath,['--input-type=module','--check'],{cwd:project,input:fs.readFileSync(path.join(project,'src/main.js')),stdio:['pipe','inherit','inherit']});
 execFileSync(process.execPath,[path.join(project,'build.mjs')],{cwd:project,stdio:'inherit'});return project;
}
