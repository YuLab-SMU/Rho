// Parser and acceptance-assertion checks only. No model, Rho, R, or mock Agent run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseRpc,digest} from './runtime.mjs';
import {nativeReadPath} from './agent.mjs';
import {operationRecord,textResponseBytes,explicitReadTaskAction} from './proxy.mjs';
import {createScenario,CORE_CASES,ADDITIONAL_CASES,FINAL_SCHEMA,availableModuleList} from './scenarios.mjs';
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
