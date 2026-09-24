import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildViewerPlugin} from './build-viewer-plugin.mjs';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rho-viewer-unit-'));
try {
  const plugin=buildViewerPlugin(path.join(directory,'viewer'));
  const {outputsFrom,readHistory,mergeHistory}=await import(pathToFileURL(path.join(plugin,'dist/src/outputs.js')));
  const owner={instance:'r-instance',plugin:'org.rho.r',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)};
  const reference={owner,resource:'html-resource',digest:'sha256:'+'c'.repeat(64),bytes:20,media_type:'text/html'};
  const record={operation:{operation_id:'original-run',capability:{id:'r.execute',version:1},normalized_arguments:{binding:{provider:owner}},accepted_at_ms:42},status:'succeeded',output:{operation_id:'original-run',session_id:'session',outputs:[{reference,native:{operation_id:'original-run',sequence:3,mime_type:'text/html',byte_size:20,sha256:reference.digest}}]}};
  assert.equal(outputsFrom(record,owner)[0].reference.resource,'html-resource');
  assert.deepEqual(outputsFrom({...record,status:'running'},owner),[],'uncommitted native outputs cannot become saved output');
  assert.deepEqual(outputsFrom(record,{...owner,revision:'sha256:'+'d'.repeat(64)}),[],'coexisting revisions do not mix');
  for(const field of ['operation_id','mime_type','byte_size','sha256']) {
    const forged=structuredClone(record);forged.output.outputs[0].native[field]='changed';
    assert.throws(()=>outputsFrom(forged,owner),/inconsistent/);
  }
  const unqualifiedDigest=structuredClone(record);unqualifiedDigest.output.outputs[0].native.sha256='c'.repeat(64);
  assert.throws(()=>outputsFrom(unqualifiedDigest,owner),/inconsistent/,'native digest already includes its algorithm prefix');
  const calls=[];
  const reader={query:async(cap,args)=>{calls.push({cap,args});return cap.id==='operation.list_recent'?{data:{operations:[{operation_id:'original-run',capability:record.operation.capability,status:'succeeded'}],next_cursor:9}}:{data:{record}};}};
  const page=await readHistory(reader,owner,17);assert.equal(page.items.length,1);assert.equal(page.next,9);
  assert.deepEqual(calls.map(c=>c.cap.id),['operation.list_recent','operation.get']);assert.equal(calls[0].args.before_cursor,17);
  const many=Array.from({length:220},(_,index)=>({...page.items[0],operation:`run-${index}`,accepted:index}));
  const history=mergeHistory(many.slice(20),many.slice(0,20),{operation_id:'run-215',resource_id:reference.resource},true);
  assert.equal(history.length,200);assert.equal(history[0].operation,'run-219');
  assert.ok(history.some(output=>output.operation==='run-215'));assert.ok(history.some(output=>output.operation==='run-0'));
  assert.equal(mergeHistory(history,[many[219]],null,false).length,200,'refresh merges exact identities without duplicates');
  console.log('Independent Viewer builds from public SDKs; original status, revision, digest, media and operation identities verified.');
}finally{fs.rmSync(directory,{recursive:true,force:true});}
