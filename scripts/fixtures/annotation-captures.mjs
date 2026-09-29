import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export function buildCaptureSource(directory) {
  const output = path.join(directory,'capture-source'); fs.mkdirSync(output);
  fs.copyFileSync(fileURLToPath(new URL('annotation-capture-source.py',import.meta.url)),path.join(output,'backend.py'));
  fs.mkdirSync(path.join(output,'dist'));
  fs.copyFileSync(path.join(output,'backend.py'),path.join(output,'dist/backend.py'));
  fs.chmodSync(path.join(output,'dist/backend.py'),0o755);
  fs.writeFileSync(path.join(output,'dependencies.lock'),'Python 3 standard library; no external dependencies.\n');
  fs.writeFileSync(path.join(output,'BUILD.md'),'Copy backend.py to dist/backend.py and make it executable. Run that artifact using the existing Python 3. No compilation or installation.\n');
  fs.writeFileSync(path.join(output,'plugin.json'),JSON.stringify({protocol_version:1,id:'example.capture-source',name:'Capture fixture',version:'1',license:'AGPL-3.0-only',description:'Disposable resource transport peer',
    source:{files:['backend.py'],lockfiles:['dependencies.lock'],build_instructions:'BUILD.md',build:null},dependencies:{},requires:[],optional_requires:[],views:[],contexts:[],
    capabilities:[{capability:{id:'fixture.capture.resource',version:1},kind:'query',title:'Capture fixture resource',description:'Publish a retained fixture PNG',input_schema:{type:'object',properties:{damaged:{type:'boolean'}},required:['damaged'],additionalProperties:false},examples:[{damaged:false}],output_schema:true,recovery_schema:true,required_scopes:['resources.read'],effects:[],cancellation:'unsupported',preflight:null}],
    backend:{executable:'dist/backend.py',arguments:[]},configuration_schema:{type:'object',additionalProperties:false},default_configuration:{}}));
  return output;
}

export async function annotationCaptures({notes, captureSource, reference, pluginQuery, invoke, binding, query}) {
  const source = await pluginQuery(captureSource,'fixture.capture.resource',{damaged:false});
  const input = {request_id:'image-original',reference:source.reference};
  assert.ok(source.reference.bytes>65536);
  const importImage = (arguments_, request, expected='succeeded') => binding(notes,'annotations.capture.import').then(binding=>invoke('annotations.capture.import',{binding,arguments:arguments_},request,expected));
  const imported = await importImage(input,'host-image-original');
  const capture = imported.output.outcome.capture;
  assert.equal(capture.width,256); assert.equal(capture.height,256);
  assert.equal(capture.original_media,false); assert.equal(capture.sha256,source.reference.digest);
  const freeze = {request_id:'image-anchor',command:{kind:'freeze',reference,inclusion:{kind:'document'},anchor:{kind:'captured_view',capture}}};
  const frozen = await invoke('annotations.write',{binding:await binding(notes,'annotations.write'),arguments:freeze});
  const created = await invoke('annotations.write',{binding:await binding(notes,'annotations.write'),arguments:{request_id:'image-note',command:{kind:'create',evidence_id:frozen.output.outcome.evidence_id,note:'Captured view with a marked region',labels:[],marks:[{kind:'rectangle',x:0.1,y:0.2,width:0.4,height:0.3}],continued_from:null}}});
  const annotation = created.output.outcome.annotation;
  const retained = await pluginQuery(notes,'annotations.read',{kind:'read',annotation});
  assert.deepEqual(retained.evidence.anchor,{kind:'captured_view',capture});
  assert.equal(retained.revision.marks.length,1);
  const contextInput={reference:{provider:notes,contribution:'annotations',window:reference.window,selector:annotation},inclusion:{kind:'note_and_evidence'},max_bytes:16384};
  const context=await pluginQuery(notes,'annotations.context.preview',contextInput);
  assert.match(context.text,/256 × 256 image\/png/);
  assert.match(context.text,/not included in this text context/);
  assert.deepEqual(context.resources,[]);
  assert.deepEqual(context.data.anchor,{kind:'captured_view',capture});
  const imageBytes = async () => {
    const parts=[]; let offset=0;
    for(let count=0;count<129;count++) {
      const chunk=await pluginQuery(notes,'annotations.capture.read',{capture,offset,limit:65536});
      assert.deepEqual(chunk.capture,capture); assert.equal(chunk.offset,offset);
      const bytes=Buffer.from(chunk.base64,'base64'); assert.ok(bytes.length<=65536); parts.push(bytes);
      if(chunk.next===null) {
        const result=Buffer.concat(parts); assert.equal(result.length,capture.byte_size);
        assert.equal('sha256:'+createHash('sha256').update(result).digest('hex'),capture.sha256); return result;
      }
      assert.equal(chunk.next,offset+bytes.length); offset=chunk.next;
    }
    throw Error('Capture read exceeded its bounded page count');
  };
  const bytes=await imageBytes();
  const damaged=await pluginQuery(captureSource,'fixture.capture.resource',{damaged:true});
  await importImage({request_id:'damaged-image',reference:damaged.reference},'host-damaged-image','failed');
  assert.equal((await pluginQuery(notes,'annotations.read',{kind:'receipt',request_id:'damaged-image'})).receipt,null);
  const report={capture,resource:source.reference,annotation,original_operation:imported.operation.operation_id,damaged_image_refused:true,restart_verified:false};
  return {report, async afterRestart() {
    assert.equal((await query('plugins.instance',{instance:captureSource})).instance.state,'suspended');
    assert.deepEqual((await importImage(input)).output,imported.output);
    assert.equal((await importImage(input,'host-image-original')).operation.operation_id,imported.operation.operation_id);
    assert.deepEqual(await pluginQuery(notes,'annotations.read',{kind:'read',annotation}),retained);
    assert.deepEqual(await imageBytes(),bytes);
    assert.deepEqual(await pluginQuery(notes,'annotations.context.preview',contextInput),context);
    assert.equal((await query('plugins.instance',{instance:captureSource})).instance.state,'suspended');
    report.restart_verified=true;
  }};
}
