import {assignFixturePresenter as assign,fixtureVisibility as visible} from './support/presenter.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Ajv} from 'ajv';
import {digest,canonical} from '@rho-workspace/plugin-contracts';
import {RhoService} from '../dist/server.js';
import {RhoClient} from '../dist/client.js';
import {TaskRouting} from '../dist/task-routing.js';
import {protocol} from '../dist/protocol.js';
import {presentationFixture,query,caps} from './support/presentation.mjs';
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'rho-presenter-')),service=await new RhoService({root,stateDir:path.join(root,'state'),coreBinary:'/missing',rscript:'/missing',plugins:['agent','files','tables']}).start();return{root,service,close:async()=>{await service.close();await fs.rm(root,{recursive:true,force:true});}};}
test('assigned presentation role indexes only display operations and cannot read feedback, documents, full snapshots or raw layout',async()=>{
 const f=await fixture();try{const a=await presentationFixture(f.root,f.service),p=await assign(f,a);await a.publish();
 const index=await p.presenter.call('capability.index',{role:'presentation',query:{...query,owner:'rho'}});assert.deepEqual(index.entries.map(e=>e.id).sort(),['workspace.enhance','workspace.observe']);
 assert.equal(index.scopeHint.callerBindingId,p.binding.id);assert.equal(p.connection.methods.includes('protocol.describe'),false);assert.equal(p.connection.methods.includes('capability.list'),false);
 for(const method of ['observation.snapshot','document.read','feedback.read','composition.apply','binding.activity'])await assert.rejects(p.presenter.call(method,{}),e=>e.error.kind==='unauthorized');
 await assert.rejects(p.presenter.call('capability.index',{role:'business',query}),e=>e.error.kind==='scope');
 const projection=await p.presenter.call('workspace.observe',{taskId:'grades',compositionId:'results',query});assert.equal(projection.ownerSummary.totalRows,8);assert.equal(projection.gap,true);assert.equal(JSON.stringify(projection).includes('messageText'),false);
 const ajv=new Ajv({strict:false,allowUnionTypes:true,validateFormats:false});assert.ok(ajv.validate(protocol.responses['workspace.observe'],projection),JSON.stringify(ajv.errors));
 const paged={taskId:'grades',compositionId:'results',query:{...query,limit:1}},first=await p.presenter.call('workspace.observe',paged);assert.equal(first.complete,false);assert.ok(first.basisWitness);assert.equal(first.ownerSummary,null);
 await a.call('composition.apply',{compositionId:'results',expectedVersion:1,changeId:'advance-page',operations:[{op:'props',id:'candidate',props:{title:'Current candidate'}}]});
 await assert.rejects(p.presenter.call('workspace.observe',{...paged,query:{...paged.query,cursor:first.next}}),e=>e.error.kind==='stale');
 }finally{await f.close();}
});
test('enhancement uses exact visible basis, protects authorship/layout and returns the original receipt after layout or assignment generations advance',async()=>{
 const f=await fixture();try{const a=await presentationFixture(f.root,f.service),p=await assign(f,a);await a.publish();await a.call('view.protection.set',{compositionId:'results',expectedVersion:1,changeId:'protect-source',viewId:'original',protected:true});const v=await visible(f,a);
 const input={taskId:'grades',compositionId:'results',presenterBindingId:p.binding.id,presenterGeneration:1,expectedVersion:v.input.compositionVersion,changeId:'enhance-1',basisWitnessId:v.witness.witnessId,basisObservationId:v.input.observationId,enhancement:{emphasisViewId:'candidate',title:'Candidate review',note:'候选表已就绪。请对照原表核实；此说明不是领域正确性判断。'}};
 const result=await p.presenter.call('workspace.enhance',input);assert.equal(result.commitVersion,3);assert.equal(result.witnessState,'retained');
 const c=await a.call('composition.read',{compositionId:'results'}),note=c.views.find(v=>v.component==='rho.agent-note');assert.equal(note.props.authorBindingId,p.binding.id);assert.equal(c.nodes.find(v=>v.id==='original').protected,true);assert.equal(c.views.find(v=>v.id==='original').bindings.data.id,a.ref.id);
 await a.call('composition.apply',{compositionId:'results',expectedVersion:3,changeId:'background',operations:[{op:'props',id:'candidate',props:{title:'Human title'}}]});
 const repeated=await p.presenter.call('workspace.enhance',input);assert.equal(repeated.commitVersion,3);assert.equal(repeated.currentVersion,4);assert.equal(repeated.witness.compositionVersion,3);
 await assert.rejects(a.call('composition.apply',{compositionId:'results',expectedVersion:4,changeId:'forged-note',operations:[{op:'props',id:note.id,props:{...note.props,text:'Forged content'}}]}),e=>e.error.kind==='scope');
 await assert.rejects(p.presenter.call('workspace.enhance',{...input,changeId:'stale-new'}),e=>e.error.kind==='stale');
 const p2=await assign(f,a,'replacement');assert.equal(p2.routed.current.presenter.generation,2);await assert.rejects(p.presenter.call('workspace.enhance',input),e=>e.error.kind==='scope');
 const old=await new TaskRouting(a.project).read();await a.call('task.routing.put',{taskId:'grades',expectedVersion:old.version,changeId:'return-original',compositionId:'results',participants:[old.participants[0],{bindingId:p.binding.id,role:'presentation'}],feedbackOwnerBindingId:old.feedbackOwnerBindingId,presenterBindingId:p.binding.id,policyRef:old.policyRef});
 assert.equal((await new TaskRouting(a.project).read()).presenter.generation,3);assert.equal((await p.presenter.call('workspace.enhance',input)).commitVersion,3);assert.equal(f.service.bridge.owned.size,0);
 }finally{await f.close();}
});

test('ordinary layout undo can restore original authenticated note history while raw writes cannot forge it',async()=>{
 const f=await fixture();try{const a=await presentationFixture(f.root,f.service),p=await assign(f,a);await a.publish();let v=await visible(f,a,'visible-1');
 const first={taskId:'grades',compositionId:'results',presenterBindingId:p.binding.id,presenterGeneration:1,expectedVersion:1,changeId:'note-1',basisWitnessId:v.witness.witnessId,basisObservationId:v.input.observationId,enhancement:{emphasisViewId:'candidate',note:'Original authenticated note'}};
 await p.presenter.call('workspace.enhance',first);v=await visible(f,a,'visible-2');
 await p.presenter.call('workspace.enhance',{...first,expectedVersion:2,changeId:'note-2',basisWitnessId:v.witness.witnessId,basisObservationId:v.input.observationId,enhancement:{emphasisViewId:'candidate',note:'Updated authenticated note'}});
 const undone=await a.call('composition.undo',{compositionId:'results',expectedVersion:3,changeId:'undo-note-layout'});assert.equal(undone.views.find(v=>v.component==='rho.agent-note').props.text,'Original authenticated note');
 assert.equal(f.service.bridge.owned.size,0);
 }finally{await f.close();}
});
