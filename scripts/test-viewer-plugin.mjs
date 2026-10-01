import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildViewerPlugin} from './build-viewer-plugin.mjs';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rho-viewer-unit-'));
try {
  const plugin=buildViewerPlugin(path.join(directory,'viewer'));
  const manifest=JSON.parse(fs.readFileSync(path.join(plugin,'plugin.json'),'utf8'));
  const rManifest=JSON.parse(fs.readFileSync(new URL('../plugins/r/plugin.json',import.meta.url),'utf8'));
  for(const grant of manifest.requires.filter(g=>g.capability.id.startsWith('r.')))
    assert.deepEqual([...grant.scopes].sort(),[...rManifest.capabilities.find(cap=>JSON.stringify(cap.capability)===JSON.stringify(grant.capability)).required_scopes].sort(),'Viewer grants must match the real R public contract');
  const {outputsFrom,readHistory,mergeHistory}=await import(pathToFileURL(path.join(plugin,'dist/src/outputs.js')));
  const {ComponentAgent}=await import(pathToFileURL(path.join(plugin,'dist/public/agent-input/input.js')));
  const sdk=await import(pathToFileURL(path.join(plugin,'dist/public/plugin-ui/index.js')));
  const {checkComponentAgent}=await import('./fixtures/component-agent.mjs');await checkComponentAgent({ComponentAgent,sdk});
  const {viewerContext}=await import(pathToFileURL(path.join(plugin,'dist/src/agent-source.js')));
  const owner={instance:'r-instance',plugin:'org.rho.r',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)};
  const reference={owner,resource:'html-resource',digest:'sha256:'+'c'.repeat(64),bytes:20,media_type:'text/html'};
  const record={operation:{operation_id:'original-run',capability:{id:'r.execute',version:1},normalized_arguments:{binding:{provider:owner}},accepted_at_ms:42},status:'succeeded',output:{operation_id:'original-run',session_id:'session',outputs:[{reference,native:{operation_id:'original-run',sequence:3,mime_type:'text/html',byte_size:20,sha256:reference.digest}}]}};
  assert.equal(outputsFrom(record,owner)[0].reference.resource,'html-resource');
  const selected=outputsFrom(record,owner)[0],context=viewerContext(owner,'window',selected,'text');
  assert.deepEqual(context.reference.selector,{operation:'original-run',sequence:3,session:'session',reference});
  selected.reference.resource='later';assert.equal(context.reference.selector.reference.resource,'html-resource');
  assert.throws(()=>viewerContext(owner,'window',selected,'unknown'),/Choose/);
  const versioned=structuredClone(record);versioned.operation.capability.version=2;
  const inputSource={view_id:'script-view',label:'分析.R',kind:'file'};
  versioned.operation.normalized_arguments.arguments={run:{code:'1',source:inputSource}};versioned.output.source=structuredClone(inputSource);
  assert.equal(outputsFrom(versioned,owner)[0].reference.resource,'html-resource');
  assert.deepEqual(outputsFrom(versioned,owner)[0].inputSource,inputSource);
  const unlabeled=structuredClone(versioned);delete unlabeled.operation.normalized_arguments.arguments.run.source;delete unlabeled.output.source;
  assert.equal(outputsFrom(unlabeled,owner)[0].inputSource,null);
  versioned.output.source.label='changed.R';assert.throws(()=>outputsFrom(versioned,owner),/source differs/);
  versioned.operation.capability.version=3;assert.deepEqual(outputsFrom(versioned,owner),[],'unknown contracts are not interpreted');
  assert.deepEqual(outputsFrom({...record,status:'running'},owner),[],'uncommitted native outputs cannot become saved output');
  assert.deepEqual(outputsFrom(record,{...owner,revision:'sha256:'+'d'.repeat(64)}),[],'coexisting revisions do not mix');
  for(const version of [1,2]){
    const notStarted=structuredClone(record);notStarted.operation.capability.version=version;notStarted.status='cancelled';
    notStarted.output={operation_id:record.operation.operation_id,started:false};
    assert.deepEqual(outputsFrom(notStarted,owner),[],'pre-start cancellation has no saved media');
    notStarted.output.operation_id='another-run';assert.throws(()=>outputsFrom(notStarted,owner),/original R operation/);
  }
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
  const cursors=[];
  const buried={query:async(cap,args)=>{if(cap.id==='operation.get')return {data:{record}};cursors.push(args.before_cursor);return {data:args.before_cursor===null?{operations:[],next_cursor:17}:{operations:[{operation_id:'original-run',capability:record.operation.capability,status:'succeeded'}],next_cursor:null}};}};
  assert.equal((await readHistory(buried,owner,null)).items.length,1,'unrelated recent operations must not hide a saved Viewer output');
  assert.deepEqual(cursors,[null,17]);
  const many=Array.from({length:220},(_,index)=>({...page.items[0],operation:`run-${index}`,accepted:index}));
  const history=mergeHistory(many.slice(20),many.slice(0,20),{operation_id:'run-215',resource_id:reference.resource},true);
  assert.equal(history.length,200);assert.equal(history[0].operation,'run-219');
  assert.ok(history.some(output=>output.operation==='run-215'));assert.ok(history.some(output=>output.operation==='run-0'));
  assert.equal(mergeHistory(history,[many[219]],null,false).length,200,'refresh merges exact identities without duplicates');
  console.log('Independent Viewer builds from public SDKs; original status, revision, digest, media and operation identities verified.');
}finally{fs.rmSync(directory,{recursive:true,force:true});}
