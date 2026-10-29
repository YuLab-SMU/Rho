import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {declarationValidator} from '@rho-workspace/plugin-tables';
import {Files} from '@rho-workspace/plugin-files';
import {EvidenceExporter,verifyEvidence} from '../dist/evidence-export.js';
test('a selected evidence package survives source deletion, retries exactly and detects tampering',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rho-evidence-export-'));
 try{
 const files=new Files(root,'p');await fs.writeFile(path.join(root,'analysis.py'),'print("你好")\n');const resource=await files.capture('analysis.py');
 const thread={annotationId:'q',version:2,anchor:{kind:'resource',resource},messages:[{draft:{text:'Check this <script>bad()</script>'}},{author:'agent:test',draft:{text:'Done'},resources:[resource]}],decisions:[]};
 const exporter=new EvidenceExporter(root,{thread:async()=>thread,resources:()=>files.list(),bytes:r=>files.bytes(r),observations:async()=>({turns:[],omitted:0})});
 const preview=await exporter.preview('q');await fs.rm(path.join(root,'analysis.py'));
 const input={annotationId:'q',exportId:'one',expectedDigest:preview.digest};const result=await exporter.export(input);
 assert.equal(result.state,'complete');assert.equal(preview.analysisEvidenceCompleteness,'not-established');assert.deepEqual(await exporter.export(input),result);
 const target=path.join(root,result.destination);assert.equal((await verifyEvidence(target)).verified,true);
 const html=await fs.readFile(path.join(target,'index.html'),'utf8');assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
 await assert.rejects(exporter.export({...input,expectedDigest:'0'.repeat(64)}),e=>e.kind==='conflict');
 const manifest=JSON.parse(await fs.readFile(path.join(target,'evidence.json'),'utf8'));await fs.writeFile(path.join(target,manifest.inventory[0].path),'tampered');
 await assert.rejects(verifyEvidence(target),e=>e.kind==='condition');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('unavailable typed previews preserve original files and declare the gap; inventories cannot omit selected files',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rho-evidence-preview-'));
 try{
 const files=new Files(root,'p',{},[declarationValidator]);await fs.writeFile(path.join(root,'table.csv'),'id,n\na,0\n');const resource=await files.capture('table.csv',{declaration:{path:'table.csv',kind:'table',format:{encoding:'csv',columns:[{name:'id',type:'string',nullValues:[]},{name:'n',type:'number',nullValues:[]}],key:{column:'id',namespace:'test'}}}});
 const thread={annotationId:'q',version:1,anchor:{kind:'resource',resource},messages:[{draft:{text:'Review this.'}}]};
 const sources={thread:async()=>thread,resources:()=>files.list(),bytes:r=>files.bytes(r),observations:async()=>({turns:[],omitted:0}),table:async()=>{throw Error('unavailable')}};
 const exporter=new EvidenceExporter(root,sources),preview=await exporter.preview('q');
 const result=await exporter.export({annotationId:'q',exportId:'gap',expectedDigest:preview.digest});assert.ok(result.gaps.some(g=>g.includes('typed table preview')));
 const target=path.join(root,result.destination);assert.equal((await verifyEvidence(target)).verified,true);
 const manifest=JSON.parse(await fs.readFile(path.join(target,'evidence.json'),'utf8'));manifest.inventory=manifest.inventory.filter(f=>f.path==='index.html');await fs.writeFile(path.join(target,'evidence.json'),JSON.stringify(manifest));await assert.rejects(verifyEvidence(target),e=>e.kind==='invalid');
 const limited=new EvidenceExporter(root,sources,{maxBytes:1});await assert.rejects(limited.preview('q'),e=>e.kind==='limit');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('default evidence selection excludes known connection and authentication files without altering their bytes',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rho-evidence-private-'));
 try{
 const files=new Files(root,'p');await fs.writeFile(path.join(root,'connection.json'),'{"credential":"fixture"}');const r=await files.capture('connection.json');
 const thread={annotationId:'q',anchor:{resource:r},messages:[]};const exporter=new EvidenceExporter(root,{thread:async()=>thread,resources:()=>files.list(),bytes:r=>files.bytes(r),observations:async()=>({turns:[],omitted:0})});
 const preview=await exporter.preview('q');assert.equal(preview.files.length,0);assert.ok(preview.gaps.some(g=>g.includes('credential file excluded')));assert.equal((await files.bytes(r)).data.toString(),'{"credential":"fixture"}');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
