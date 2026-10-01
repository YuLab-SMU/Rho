import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildUiFixture,buildControlFixture} from './plugin-ui.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const definitions=JSON.parse(fs.readFileSync(path.join(root,'sdk/plugin-protocol/schema/resource-transfer-response.json'),'utf8')).$defs;
/** Disposable protocol fixtures only. Publishing known bytes from a fixture
 * query tests the native resource channel, not a production scientific query. */
export function buildDownloadBackendFixture(directory){
 const project=buildControlFixture(directory),file=path.join(project,'plugin.json'),manifest=JSON.parse(fs.readFileSync(file,'utf8'));
 manifest.capabilities.push({capability:{id:'fixture.read',version:1},kind:'query',title:'Read fixture original',description:'Publish a known disposable original for resource transport acceptance.',
  input_schema:{type:'object',properties:{action:{const:'resource_put'}},required:['action'],additionalProperties:false},examples:[{action:'resource_put'}],
  output_schema:{$defs:definitions,type:'object',properties:{reference:{$ref:'#/$defs/ResourceReference'}},required:['reference'],additionalProperties:false},
  recovery_schema:true,required_scopes:['plugins.read'],effects:[],cancellation:'unsupported',preflight:null});
 fs.writeFileSync(file,JSON.stringify(manifest,null,2));return project;
}
export function buildDownloadUiFixture(directory){
 const project=buildUiFixture(directory),file=path.join(project,'plugin.json'),manifest=JSON.parse(fs.readFileSync(file,'utf8'));
 manifest.requires.push({capability:{id:'resources.read',version:1},scopes:['resources.read']});
 manifest.views[0].configuration_schema.$defs=definitions;
 manifest.views[0].configuration_schema.properties.download_reference={$ref:'#/$defs/ResourceReference'};
 manifest.views[0].configuration_schema.required=['download_reference'];
 fs.writeFileSync(file,JSON.stringify(manifest,null,2));
 fs.appendFileSync(path.join(project,'src/main.js'),`\nconst original=client.view.configuration.download_reference;
const automaticDownload=document.createElement('output');automaticDownload.id='automatic-download';document.body.append(automaticDownload);
client.downloadResource(original,'Unrequested.bin').then(()=>automaticDownload.textContent='Unexpected automatic download',error=>automaticDownload.textContent=error.message);
const downloadResult=document.createElement('output');downloadResult.id='download-result';document.body.append(downloadResult);
for(const corrupt of [false,true]){const button=document.createElement('button');button.textContent=corrupt?'Try foreign original':'Download original';downloadResult.before(button);
button.onclick=async()=>{downloadResult.textContent='Collecting original';try{await client.downloadResource(corrupt?{...original,resource:'foreign'}:original,'原始文件 α.bin');downloadResult.textContent='Original download requested';}catch(error){downloadResult.textContent=error.message;}};}
`);
 execFileSync(process.execPath,[path.join(project,'build.mjs')],{cwd:project,stdio:'inherit'});return project;
}
