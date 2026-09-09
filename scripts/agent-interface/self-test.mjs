// Parser and acceptance-assertion checks only. No model, Rho, R, or mock Agent run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseRpc,digest} from './runtime.mjs';
import {nativeReadPath} from './agent.mjs';
import {RecordingProxy,operationRecord,textResponseBytes,explicitReadTaskAction,assertOperationIdentities,assertConsumedEvidence} from './proxy.mjs';
import {createScenario,CORE_CASES,ADDITIONAL_CASES,FINAL_SCHEMA,availableModuleList,numeric,assertSkillResourceRead,assertSuccessfulAnalysis,acceptedInputReplies,assertSavedCapture,assertImageProvenance} from './scenarios.mjs';
assert.deepEqual(parseRpc('data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n'),[{jsonrpc:'2.0',id:1,result:{ok:true}}]);
assert.deepEqual(parseRpc('{"id":2,"result":null}'),[{id:2,result:null}]);
assert.equal(digest('α🙂'),digest(Buffer.from('α🙂','utf8')));
const file='/private/skill folder/SKILL.md';assert.equal(nativeReadPath(`cat '${file}'`,[file]),file);assert.equal(nativeReadPath(`/bin/zsh -lc "cat '${file}'"`,[file]),file);
for(const command of [`cat '${file}'; cat /tmp/answers`,`cat '${file}' | head`,`cat /tmp/answers`,`python -c "print('answer')"`,`cat '${file}' > /tmp/a`,`cat $(find /tmp -name SKILL.md)`])assert.equal(nativeReadPath(command,[file]),null,command);
assert.equal(CORE_CASES.length,10);assert.equal(ADDITIONAL_CASES.length,4);assert.ok(FINAL_SCHEMA.required.includes('facts'));
const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-acceptance-selftest-')));
try {for(const id of [...CORE_CASES,...ADDITIONAL_CASES]){const s=createScenario(id,1,directory,directory);assert.equal(typeof s.setup,'function');assert.equal(typeof s.verify,'function');assert.ok(s.requiredFacts.length>0);await assert.rejects(()=>s.checkFacts({facts:[]}));} }
finally {fs.rmSync(directory,{recursive:true,force:true});}

const record={operation:{operation_id:'op-original'},status:'succeeded'};
assert.equal(operationRecord('rho.operation.get.v1',{data:{record,output_contract:{capability:{id:'workspace.run_r',version:1}}}}),record);
assert.equal(operationRecord('rho.operation.get',record),record);
assert.equal(operationRecord('rho.workspace.run_r.v1',record),record);
assert.equal(operationRecord('rho.application.context.v1',{data:{record}}),null);
assert.equal(operationRecord('rho.operation.request_cancellation.v1',{accepted:true,operation:record}),record);

numeric(new Map([['estimate','6.0']]),'estimate',6);
numeric(new Map([['estimate','6e0']]),'estimate',6);
for(const value of ['', 'NaN', 'six', '6 units', '6.1'])assert.throws(()=>numeric(new Map([['estimate',value]]),'estimate',6));
const op=(id,request)=>({operation:{operation_id:id,client_request_id:request,caller:{kind:'agent',id:'agent'},principal:{kind:'human',id:'principal'},idempotency_scope:'/project',capability:{id:'workspace.run_r',version:1},normalized_arguments:{code:'same legitimate verification'}},status:'succeeded'});
assertOperationIdentities([op('one','first'),op('two','second')]);
assert.throws(()=>assertOperationIdentities([op('one','same'),op('two','same')]));
const receipt=(operation)=>({window:{window_id:'w',incarnation:'i'},request_id:'request',save:{operation_id:operation}});
assert.throws(()=>assertOperationIdentities([], [receipt('one'),receipt('two')]));
assertOperationIdentities([], [receipt('one'),receipt('one')]);

const expectedResource=Buffer.from('αbeta');
const skillPage=(offset,length,kind='text',ref='skill-identity')=>({status:'ready',data:{skill_ref:ref,source_ref:'source-identity',skill_digest:'skill-digest',manifest_digest:'manifest-digest',kind,
  resource:{path:'references/method.md',resource_ref:'resource-identity',sha256:digest(expectedResource),byte_size:expectedResource.length},offset,
  text:kind==='text'?expectedResource.subarray(offset,offset+length).toString('utf8'):null,bytes:kind==='bytes'?[...expectedResource.subarray(offset,offset+length)]:null,
  next_offset:offset+length<expectedResource.length?offset+length:null,complete:offset+length===expectedResource.length}});
assert.equal(assertSkillResourceRead([skillPage(2,4),skillPage(0,2)],'references/method.md',expectedResource).sha256,digest(expectedResource));
assertSkillResourceRead([skillPage(0,2),skillPage(2,4,'bytes')],'references/method.md',expectedResource);
assertSkillResourceRead([skillPage(0,6,'bytes')],'references/method.md',expectedResource);
assert.throws(()=>assertSkillResourceRead([skillPage(0,2)],'references/method.md',expectedResource));
assert.throws(()=>assertSkillResourceRead([skillPage(0,2),skillPage(2,4,'text','other-skill')],'references/method.md',expectedResource));
const report={facts:[{key:'estimate',value:'6.0',evidence:['original operation one']}],operation_ids:['one']};
assertSuccessfulAnalysis(report,{records:()=>[op('one','calculation')]},[]);
assert.throws(()=>assertSuccessfulAnalysis(report,{records:()=>[{...op('one','calculation'),status:'accepted'}]},[]));
const response=(name,args,value,error=false)=>({call:{sequence:1,rpc:{method:'tools/call',params:{name,arguments:args}}},result:{isError:error,structuredContent:{result:value}}});
const evidence=[response('rho.workspace.run_r.v1',{},op('one','calculation'))];
assertConsumedEvidence(report,evidence);
assert.throws(()=>assertConsumedEvidence({...report,operation_ids:['fabricated']},evidence));
assert.throws(()=>assertConsumedEvidence({...report,facts:[{key:'estimate',evidence:['unseen identifier']}]},evidence));
const replies={responses:[response('rho.workspace.respond_input.v1',{operation_id:'one'},null,true),response('rho.workspace.respond_input',{operation_id:'one'},{submitted:true})]};
assert.equal(acceptedInputReplies(replies,'one').length,1);
assert.equal(acceptedInputReplies(replies,'other').length,0);

const savedText='analysis_note <- "updated"\n',savedHash=digest(savedText),saveWindow={window_id:'w',incarnation:'i'};
const saveReceipt={window:saveWindow,capture:{document:{document_id:'d'},path:'analysis.R',sha256:savedHash,utf8_bytes:Buffer.byteLength(savedText)},save:{state:'succeeded',operation_id:'saved'}};
const saveRecord={operation:{operation_id:'saved',capability:{id:'project.apply_patch'}},status:'succeeded',output:{after:{files:[{path:'analysis.R',sha256:savedHash}]}}};
const saveProof={receipt:saveReceipt,record:saveRecord,disk:savedText,captureText:savedText,window:saveWindow,documentId:'d',path:'analysis.R'};
assertSavedCapture(saveProof);assert.throws(()=>assertSavedCapture({...saveProof,disk:savedText+'later user\n'}));
assert.throws(()=>assertSavedCapture({...saveProof,window:{window_id:'other',incarnation:'i'}}));

const media={operation_id:'plot-original',sequence:2,mime_type:'image/png',byte_size:10,sha256:'sha256:original',display_id:null};
const uri=`rho-output://original/${Buffer.from(JSON.stringify(media)).toString('base64url')}`;
const imageResponse=(sequence,crop)=>({...response('rho.output.view.v1',{reference:media,...(crop?{crop}:{})},{status:'ready',data:{reference:media,original_width:200,original_height:100,crop:crop??{x:0,y:0,width:200,height:100},preview_width:100,preview_height:50,preview_sha256:'sha256:preview',preview_byte_size:4}}),call:{sequence,rpc:{params:{name:'rho.output.view.v1',arguments:{reference:media,...(crop?{crop}:{})}}}},result:{structuredContent:{result:{status:'ready',data:{reference:media,original_width:200,original_height:100,crop:crop??{x:0,y:0,width:200,height:100},preview_width:100,preview_height:50,preview_sha256:'sha256:preview',preview_byte_size:4}}},content:[{type:'resource_link',uri}]}});
const imageProof={responses:[imageResponse(1),imageResponse(2,{x:100,y:0,width:100,height:100})],images:[{sequence:1,sha256:'sha256:preview',bytes:4},{sequence:2,sha256:'sha256:preview',bytes:4}]};
assertImageProvenance(imageProof,media);assert.throws(()=>assertImageProvenance({...imageProof,images:[imageProof.images[0]]},media));
assert.throws(()=>assertImageProvenance(imageProof,{...media,operation_id:'unrelated'}));

const meterDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'rho-image-meter-'));
try {
  const proxy=new RecordingProxy({seedRecords:[]},{},meterDirectory),original=Buffer.alloc(4*1024*1024+7,19);
  const reference={...media,byte_size:original.length,sha256:digest(original)},token=Buffer.from(JSON.stringify(reference)).toString('base64url'),manifestUri=`rho-output://manifest/${token}`;
  proxy.observeImageResources({params:{name:'rho.output.view.v1'}},{structuredContent:{result:{data:{reference}}},content:[{type:'resource_link',uri:manifestUri}]});
  const chunks=[];for(let offset=0;offset<original.length;offset+=65536)chunks.push({uri:`rho-output://chunk/${offset}/${token}`,offset,byte_size:Math.min(65536,original.length-offset)});
  proxy.observeImageResources({method:'resources/read',params:{uri:manifestUri}},{contents:[{uri:manifestUri,text:JSON.stringify({reference,chunk_bytes:65536,chunks})}]});
  for(const [index,chunk] of chunks.entries()){
    const value={contents:[{uri:chunk.uri,mimeType:'application/octet-stream',blob:original.subarray(chunk.offset,chunk.offset+chunk.byte_size).toString('base64')}]},binding=proxy.imageResources.get(chunk.uri);
    assert.equal(textResponseBytes(value,binding),Buffer.byteLength(JSON.stringify(value))-Buffer.byteLength(value.contents[0].blob));
    assert.equal(textResponseBytes(value),Buffer.byteLength(JSON.stringify(value)),'unbound octet-stream data must remain metered as text');
    proxy.extractImages(value,index+1,binding);
  }
  await proxy.close();assert.deepEqual(proxy.violations,[]);assert.equal(proxy.images.reduce((total,image)=>total+image.bytes,0),original.length);
  assert.equal(JSON.parse(fs.readFileSync(path.join(meterDirectory,'transport.json'),'utf8')).original_reassemblies[0].complete,true);
} finally {fs.rmSync(meterDirectory,{recursive:true,force:true});}

const imageResult={result:{content:[{type:'text',text:'α🙂'},{type:'image',mimeType:'image/png',data:'YWJjZA=='}]}};
assert.equal(textResponseBytes(imageResult),Buffer.byteLength(JSON.stringify(imageResult))-8);
assert.equal(availableModuleList([{module:'session',available:true},{module:'environment',available:false}]),'session');
assert.equal(availableModuleList([{module:'session',available:true},{module:'environment',available:true}]),'environment,session');
assert.equal(explicitReadTaskAction('package_copies','rho.workspace.help.v1',{}),true);
assert.equal(explicitReadTaskAction('discovery','rho.workspace.respond_input.v1',{}),false);
assert.equal(explicitReadTaskAction('selected_draft','rho.application.bind_method.v1',{}),false);
assert.equal(explicitReadTaskAction('recovery_disconnect','rho.application.control.v1',{action:{kind:'run_file'}}),true);
assert.equal(explicitReadTaskAction('recovery_disconnect','rho.application.control.v1',{action:{kind:'edit_document'}}),false);
console.log('Harness parser and assertion checks passed. No Agent acceptance runs executed.');
