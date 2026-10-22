import fs from 'node:fs/promises';
import path from 'node:path';
import {digest,canonical} from '@rho-workspace/plugin-contracts';
import {RhoClient} from '../../dist/client.js';
import {TaskRouting} from '../../dist/task-routing.js';
import {caps} from './presentation.mjs';
export async function assignFixturePresenter(f,a,name='presentation'){
 const file=path.join(f.root,name+'.private.json'),observerFile=path.join(f.root,name+'-observer.private.json');
 const connection=await f.service.agentConnection(a.project.id,name,file,undefined,undefined,'layered-presentation');
 await f.service.agentConnection(a.project.id,name+'-observer',observerFile,['binding.activity.append']);
 const presenter=await RhoClient.fromFile(file);
 f.service.registerNativeAdapter({projectId:a.project.id,taskId:'grades',registrationId:name,principal:'agent:'+digest(a.project.id+':'+name).slice(0,32),adapterPrincipal:'agent:'+digest(a.project.id+':'+name+'-observer').slice(0,32),externalSessionId:name,transportCapabilities:caps,proof:{kind:'claude-code-init',sessionId:name,clientVersion:'2.1.306'}});
 const binding=await presenter.call('binding.open',{externalSessionId:name,adapter:'claude-code-mcp',attachment:{taskId:'grades',role:'presentation',adapterRegistrationId:name,transportCapabilities:caps}});
 const old=await new TaskRouting(a.project).read();
 const routed=await a.call('task.routing.put',{taskId:'grades',expectedVersion:old.version,changeId:'assign-'+name,compositionId:'results',participants:[...old.participants.filter(p=>p.role==='business'),{bindingId:binding.id,role:'presentation'}],feedbackOwnerBindingId:old.feedbackOwnerBindingId,presenterBindingId:binding.id,policyRef:old.policyRef});
 return {file,presenter,binding,connection,routed};
}
export async function fixtureVisibility(f,a,id='fixture-visible'){
 const pair=await f.service.browser.createPairing(a.project.root),session=await f.service.browser.pair(pair.code),browser=new RhoClient({url:f.service.url,token:session.token});
 const snap=await browser.call('observation.snapshot',{projectId:a.project.id}),composition=snap.compositions.find(c=>c.compositionId==='results'),witness=snap.presentation.witnesses.find(w=>w.compositionVersion===composition.version),q={offset:0,limit:200,sort:null,filter:null};
 const input={projectId:a.project.id,taskId:'grades',compositionId:'results',compositionVersion:composition.version,witnessId:witness.witnessId,viewId:'original',observationId:id,clientId:session.principalId,clientEpoch:'epoch',rendererBuild:JSON.parse(await fs.readFile(new URL('../../dist/web/renderer.json',import.meta.url))).rendererBuild,evidence:'dom-visible',coverage:{kind:'table-dom',resource:a.ref,query:q,loadedRows:8,visibleRows:[{entityKey:'STU-008',columns:['student_id','score']}],namespace:'class-A',rowValuesDigest:digest(canonical([a.ref,'class-A',q,[['STU-008',[['student_id','STU-008'],['score',180]]]]])),documentVisible:true,panelWithinViewport:true,keyCellsWithinViewport:true,framesAfterData:2,occlusion:'element-hit-tested'},time:{browserObservedAt:new Date().toISOString(),performanceNowMs:10,clockDomain:'browser-clock'}};
 await browser.call('view.observe',input);return{witness,input,browser};
}
