// Real R-owned scientific context summaries through public plugin ports.
// This tests annotation evidence and recovery, not the pending annotation editor.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function annotationScientific({r, notes, window, binding, invoke, pluginQuery, query, port}) {
  const session = (await invoke('r.create_session', {binding:await binding(r,'r.create_session'),arguments:{}})).output.session_id;
  const native = async (id,args) => {
    const observation=await port('query_snapshot',{capability:{id,version:1},arguments:{binding:await binding(r,id),arguments:{expected_session:session,...args}}});
    assert.equal(observation.status,'ready');assert.ok(['complete','partial'].includes(observation.completeness));
    const result=observation.data;assert.equal(result.completeness,observation.completeness);
    assert.equal(result.status,'ready',JSON.stringify(result)); assert.equal(result.session_id,session);
    return result.data;
  };
  const execute = async (text, objectSize = 3) => invoke('r.execute',{binding:await binding(r,'r.execute'),arguments:{expected_session:session,
    code:`annotation_object <- seq_len(${objectSize}); writeLines(${JSON.stringify(text)}, "annotation-viewer.html"); getOption("viewer")("annotation-viewer.html"); plot(1:3, main = "Annotation source"); cat("Original Console annotation output\\n"); 1L`}});
  const source = async (kind,text,matches=()=>true) => {
    let after=null;
    for(let page=0;page<20;page++) {
      const found=await pluginQuery(r,`r.context.${kind}.search`,{window,text,after,limit:20});
      const matching=found.items.filter(item=>matches(item.reference));
      if(matching.length) { assert.equal(matching.length,1); return matching[0].reference; }
      if(found.next===null) break;
      after=found.next;
    }
    throw Error(`Missing observed ${kind} source`);
  };
  const observeHelp = async () => {
    const grouped=await native('r.packages',{filter:'parallel',grouped:true});
    const copies=await native('r.packages',{observation_id:grouped.observation_id,package_name:'parallel'});
    assert.ok(copies.packages.length); const library_path=copies.packages[0].library_path;
    const index=await native('r.package_index',{observation_id:grouped.observation_id,package:'parallel',library_path,limit:2});
    const help=await native('r.read_help',{observation_id:grouped.observation_id,package:'parallel',library_path,topic:'mclapply',expected_index_files:index.files,limit_bytes:16384,format:'text'});
    assert.equal(help.found,true);assert.match(help.text,/mclapply/);
    return source('help','parallel::mclapply',reference=>reference.selector.observation===grouped.observation_id);
  };
  const write=(request_id,command,request=randomUUID(),expected='succeeded')=>
    binding(notes,'annotations.write').then(binding=>invoke('annotations.write',{binding,arguments:{request_id,command}},request,expected));
  const retained=[];
  async function freeze(kind,reference,inclusion,note) {
    const preview=await pluginQuery(r,`r.context.${kind}.preview`,{reference,inclusion,max_bytes:16384});
    assert.equal(preview.truncated,false);assert.deepEqual(preview.resources,[]);
    assert.ok(preview.data.annotation_source.source_id);
    const command={kind:'freeze',reference,inclusion,anchor:{kind:'whole_item'}};
    const request=`scientific-${kind}-freeze`,hostRequest=`host-${request}`;
    const frozen=await write(request,command,hostRequest);
    const create={kind:'create',evidence_id:frozen.output.outcome.evidence_id,note,labels:[],marks:[],continued_from:null};
    const saved=await write(`scientific-${kind}-note`,create);
    const annotation=saved.output.outcome.annotation;
    const record=await pluginQuery(notes,'annotations.read',{kind:'read',annotation});
    assert.equal(record.evidence.fragment.text,preview.text);
    assert.deepEqual(record.evidence.selection.reference,reference);
    assert.equal(record.evidence.source.source_version,preview.data.annotation_source.source_version);
    const notePreview={reference:{provider:notes,contribution:'annotations',window,selector:annotation},inclusion:{kind:'note_and_evidence'},max_bytes:16384};
    const context=await pluginQuery(notes,'annotations.context.preview',notePreview);
    assert.ok(context.text.includes(note));assert.ok(context.text.includes(preview.text));
    assert.equal(context.data.source_status,'unknown');
    const item={kind,reference,preview,command,request,hostRequest,frozen,create,saved,annotation,record,notePreview,context};
    retained.push(item);return item;
  }
  const help=await freeze('help',await observeHelp(),{kind:'excerpt'},'Review this exact installed Help excerpt · 中文 Ω');
  // A new observation of the same installed topic is not a new content version.
  const freshHelp=await observeHelp();
  const freshPreview=await pluginQuery(r,'r.context.help.preview',{reference:freshHelp,inclusion:{kind:'excerpt'},max_bytes:16384});
  assert.deepEqual(freshPreview.data.annotation_source,help.preview.data.annotation_source);
  const html='<html><body>Original retained Viewer evidence · 中文 🧬</body></html>';
  const first=await execute(html);
  const viewer=await freeze('viewer',await source('viewer',first.operation.operation_id),{kind:'text'},'Review this exact saved HTML output · 中文 🧬');
  assert.equal(viewer.preview.text,html+'\n');
  assert.equal(viewer.reference.selector.operation,first.operation.operation_id);
  const observeObject=async()=>{
    const observed=await native('r.observe_object',{name:'annotation_object',path:[]});
    return source('objects','annotation_object',ref=>ref.selector.object_ref===observed.object_ref);
  };
  const objectNote=await freeze('objects',await observeObject(),{kind:'summary'},'Review the bounded object summary');
  const freshObject=await observeObject();
  const freshObjectPreview=await pluginQuery(r,'r.context.objects.preview',{reference:freshObject,inclusion:{kind:'summary'},max_bytes:16384});
  assert.notEqual(freshObject.selector.object_ref,objectNote.reference.selector.object_ref);
  assert.equal(freshObjectPreview.data.annotation_version_scope,'bounded_object_summary');
  assert.deepEqual(freshObjectPreview.data.annotation_source,objectNote.preview.data.annotation_source);
  const observePackage=async()=>{
    const grouped=await native('r.packages',{filter:'parallel',grouped:true});
    const copies=await native('r.packages',{observation_id:grouped.observation_id,package_name:'parallel',grouped:true,mode:'installed',filter:''});
    assert.ok(copies.packages.length);
    const library=copies.packages[0].library_path;
    return source('packages','parallel',ref=>ref.selector.observation===grouped.observation_id&&ref.selector.library===library);
  };
  const packageNote=await freeze('packages',await observePackage(),{kind:'metadata'},'Review this installed-copy metadata');
  const freshPackage=await observePackage();
  const freshPackagePreview=await pluginQuery(r,'r.context.packages.preview',{reference:freshPackage,inclusion:{kind:'metadata'},max_bytes:16384});
  assert.notEqual(freshPackage.selector.observation,packageNote.reference.selector.observation);
  assert.equal(freshPackagePreview.data.annotation_version_scope,'installed_copy_metadata');
  assert.deepEqual(freshPackagePreview.data.annotation_source,packageNote.preview.data.annotation_source);
  const substitutedPackage=structuredClone(packageNote.command);substitutedPackage.reference.selector.library='/not-the-original-library';
  await write('substituted-package-copy',substitutedPackage,randomUUID(),'failed');
  assert.equal((await pluginQuery(notes,'annotations.read',{kind:'receipt',request_id:'substituted-package-copy'})).receipt,null);
  const consoleNote=await freeze('console',await source('console',first.operation.operation_id),{kind:'transcript'},'Review this original Console run');
  assert.ok(consoleNote.preview.text.includes('Original Console annotation output'));
  const codePreview=await pluginQuery(r,'r.context.console.preview',{reference:consoleNote.reference,inclusion:{kind:'code'},max_bytes:16384});
  assert.deepEqual(codePreview.data.annotation_source,consoleNote.preview.data.annotation_source,'Code and transcript bind the same original run');
  const plots=await freeze('plots',await source('plots',first.operation.operation_id),{kind:'metadata'},'Review this original plot artifact');
  assert.equal(plots.reference.selector.plots.length,1);
  assert.equal(plots.reference.selector.plots[0].operation,first.operation.operation_id);
  assert.ok(plots.preview.text.includes('no image content is included'));
  const next=await execute('<html><body>Later Viewer output must not replace the original note.</body></html>',5);
  await write('stale-object-summary',objectNote.command,randomUUID(),'failed');
  assert.equal((await pluginQuery(notes,'annotations.read',{kind:'receipt',request_id:'stale-object-summary'})).receipt,null);
  const changedObject=await observeObject();
  const changedObjectPreview=await pluginQuery(r,'r.context.objects.preview',{reference:changedObject,inclusion:{kind:'summary'},max_bytes:16384});
  assert.equal(changedObjectPreview.data.annotation_source.source_id,objectNote.preview.data.annotation_source.source_id);
  assert.notEqual(changedObjectPreview.data.annotation_source.source_version,objectNote.preview.data.annotation_source.source_version);
  const nextRef=await source('viewer',next.operation.operation_id);
  const nextPreview=await pluginQuery(r,'r.context.viewer.preview',{reference:nextRef,inclusion:{kind:'text'},max_bytes:16384});
  assert.notEqual(nextPreview.data.annotation_source.source_id,viewer.preview.data.annotation_source.source_id);
  assert.notEqual(nextPreview.data.annotation_source.source_version,viewer.preview.data.annotation_source.source_version);
  assert.deepEqual(await pluginQuery(r,'r.context.viewer.preview',{reference:viewer.reference,inclusion:{kind:'text'},max_bytes:16384}),viewer.preview);
  for (const item of [consoleNote,plots]) {
    const fresh=await pluginQuery(r,`r.context.${item.kind}.preview`,{reference:item.reference,inclusion:item.command.inclusion,max_bytes:16384});
    assert.deepEqual(fresh,item.preview,'Later execution cannot replace an original source');
    const nextReference=await source(item.kind,next.operation.operation_id);
    const later=await pluginQuery(r,`r.context.${item.kind}.preview`,{reference:nextReference,inclusion:item.command.inclusion,max_bytes:16384});
    assert.notEqual(later.data.annotation_source.source_id,item.preview.data.annotation_source.source_id);
    const forged=structuredClone(item.command);
    const resource=item.kind==='console'?forged.reference.selector.events:forged.reference.selector.plots[0].reference;
    resource.digest='sha256:'+'0'.repeat(64);
    await write(`forged-${item.kind}-resource`,forged,randomUUID(),'failed');
    assert.equal((await pluginQuery(notes,'annotations.read',{kind:'receipt',request_id:`forged-${item.kind}-resource`})).receipt,null);
  }
  // A caller cannot substitute another resource digest under the old Operation.
  const forged=structuredClone(viewer.command);forged.reference.selector.reference.digest='sha256:'+'0'.repeat(64);
  await write('forged-viewer-resource',forged,randomUUID(),'failed');
  assert.equal((await pluginQuery(notes,'annotations.read',{kind:'receipt',request_id:'forged-viewer-resource'})).receipt,null);
  for(const item of retained) assert.deepEqual(await pluginQuery(notes,'annotations.read',{kind:'read',annotation:item.annotation}),item.record);
  const report={session,r,notes,sources:retained.map(item=>({kind:item.kind,source:item.record.evidence.source,reference:item.reference,annotation:item.annotation,freeze_operation:item.frozen.operation.operation_id})),executions:[first.operation.operation_id,next.operation.operation_id],same_help_content_identity:true,original_viewer_retained:true,forged_resource_refused:true,restart_verified:false};
  return {report,cases:retained.map(({context,notePreview})=>({context,notePreview})),async afterRestart(){
    assert.equal((await query('plugins.instance',{instance:r})).instance.state,'suspended');
    for(const item of retained){
      assert.deepEqual((await write(item.request,item.command)).output,item.frozen.output);
      assert.equal((await write(item.request,item.command,item.hostRequest)).operation.operation_id,item.frozen.operation.operation_id);
      assert.deepEqual((await write(`scientific-${item.kind}-note`,item.create)).output,item.saved.output);
      assert.deepEqual(await pluginQuery(notes,'annotations.read',{kind:'read',annotation:item.annotation}),item.record);
      assert.deepEqual(await pluginQuery(notes,'annotations.context.preview',item.notePreview),item.context);
      const unavailable=`unavailable-${item.kind}-freeze`;
      await write(unavailable,item.command,randomUUID(),'failed');
      assert.equal((await pluginQuery(notes,'annotations.read',{kind:'receipt',request_id:unavailable})).receipt,null);
    }
    assert.equal((await query('plugins.instance',{instance:r})).instance.state,'suspended','Frozen evidence and failed new capture cannot restart R');
    report.restart_verified=true;
  }};
}
