// Test-only protocol fault: preserve owner/native evidence and registered schemas,
// then alter the proposed outcome before Core commits it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
export function recoveryFaultPackage(source, destination) {
  assert.ok(!fs.existsSync(destination), 'Refuse replacing a fault fixture');
  fs.cpSync(source, destination, {recursive:true});
  const faultSource='#!'+process.execPath+'\n'+String.raw`
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const child=spawn(fileURLToPath(new URL('./rho-r-backend',import.meta.url)),[],{stdio:['pipe','pipe','inherit']});
process.stdin.pipe(child.stdin);child.stdin.on('error',()=>{});
let buffered=Buffer.alloc(0);
child.stdout.on('data',chunk=>{
  buffered=Buffer.concat([buffered,chunk]);
  while(buffered.length>=4){const size=buffered.readUInt32BE(0);if(size===0||size>1048576)throw new Error('Invalid test backend frame');if(buffered.length<size+4)break;
    const frame=JSON.parse(buffered.subarray(4,size+4));buffered=buffered.subarray(size+4);
    if(frame.body.type==='commit_plan'&&frame.body.data.output?.reference&&frame.body.data.output?.manifest)frame.body.data.output={invalid_checkpoint_output:true};
    if(frame.body.type==='commit_plan'&&typeof frame.body.data.output?.pinned==='boolean'&&typeof frame.body.data.output?.deleted==='boolean'){frame.body.data.outcome='uncertain';frame.body.data.error='Fixture: native intent retained without a confirmed logical outcome';}
    const encoded=Buffer.from(JSON.stringify(frame)),header=Buffer.alloc(4);header.writeUInt32BE(encoded.length);process.stdout.write(Buffer.concat([header,encoded]));
  }
});
child.on('error',error=>{console.error(error);process.exit(1);});
child.on('close',code=>{process.stdin.destroy();process.stdout.write(Buffer.alloc(0),()=>process.exit(code??1));});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
`;
  fs.writeFileSync(path.join(destination,'recovery-fault.mjs'),faultSource);
  fs.writeFileSync(path.join(destination,'dist/recovery-fault.mjs'),faultSource,{mode:0o755});
  fs.appendFileSync(path.join(destination,'build.mjs'),'\nfs.copyFileSync(path.join(root,"recovery-fault.mjs"),path.join(root,"dist/recovery-fault.mjs"));\nfs.chmodSync(path.join(root,"dist/recovery-fault.mjs"),0o755);\n');
  const manifest=JSON.parse(fs.readFileSync(path.join(destination,'plugin.json'),'utf8'));
  manifest.version='0.1.1';manifest.backend.executable='dist/recovery-fault.mjs';manifest.source.files.push('recovery-fault.mjs');
  fs.writeFileSync(path.join(destination,'plugin.json'),JSON.stringify(manifest,null,2)+'\n');
  return destination;
}
