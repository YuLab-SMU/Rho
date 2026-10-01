// Reconcile retained acceptance evidence. This does not run product checks or
// convert missing/partial/historical evidence into a current pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..'),dir=path.join(root,'target/plugin-refactor');
const [previous,output]=process.argv.slice(2);assert.ok(previous&&output&&previous!==output,'Use previous matrix and distinct output');
const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name)));
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const report=JSON.parse(fs.readFileSync(previous));
const bundle=read('m6-bundle-refresh.json'),delivery=read('m6-delivery-results.json'),relocation=read('m6-bundle-acceptance.json');
assert.equal(delivery.status,'verified_delivery_scope');assert.equal(relocation.completed,true);
const manifestPath=path.join(bundle.bundle,'rho-bundle.json');
assert.equal(digest(fs.readFileSync(manifestPath)),bundle.manifest_sha256);
let bytes=fs.statSync(manifestPath).size;
for(const file of bundle.manifest.files){const content=fs.readFileSync(path.join(bundle.bundle,file.file));assert.equal(content.length,file.bytes);assert.equal(digest(content),file.sha256);bytes+=content.length;}
assert.equal(bytes,bundle.total_bytes);
const changed=execFileSync('git',['diff','--name-only',bundle.source_commit,'HEAD','--','crates','plugins','sdk','ui/src','r'],{cwd:root,encoding:'utf8'}).trim();
assert.equal(changed,'','Runtime source changed after the delivered source: requalify affected evidence');
const ime=read('m6-system-ime.json');assert.equal(ime.completed,true);assert.equal(ime.manual_ime.status,'passed_annotations_system_ime');assert.equal(ime.manual_ime.candidate_window.observed,true);
const reviewed=read('m6-live-matrix-reviewed.json');assert.equal(reviewed.retained_review.completed,true);assert.equal(reviewed.retained_review.checked.length,6);
const objects=read('m6-live-objects-results.json');assert.equal(objects.completed,true);assert.equal(objects.live_provider.targeted_restart_verified,true);
const replacement=objects.live_provider.matrix.attempts;assert.equal(replacement.length,3);assert.ok(replacement.every(item=>item.id==='objects'&&item.status==='passed'));
const attempts=reviewed.live_provider.matrix.attempts.map(item=>{
  const next=item.id==='objects'?{...replacement.find(next=>next.repetition===item.repetition),replaces:{report:'m6-live-matrix-results.json',status:item.status,reason:item.reason}}:structuredClone(item);
  if(item.id==='plots'){next.status='partial';next.reason='Metadata boundary passed; original visual-color recognition is not proved. Image diagnostic failed separately.';}
  return next;
});
assert.equal(attempts.length,33);assert.equal(new Set(attempts.map(item=>`${item.id}:${item.repetition}`)).size,33);
const counts=Object.fromEntries(['passed','partial','failed','not_run'].map(status=>[status,attempts.filter(item=>item.status===status).length]));
assert.equal(Object.values(counts).reduce((a,b)=>a+b),33);
const hostLog=fs.readFileSync(path.join(dir,'m6-host-ports.log'),'utf8');assert.match(hostLog,/test result: ok\. 13 passed; 0 failed; 0 ignored/);
const priorScope=execFileSync('git',['diff','--name-only','c69a26019a22612fcbadf42640c4a331801990e9',bundle.source_commit,'--','crates','ui/src'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);
assert.deepEqual(priorScope.sort(),['crates/plugins/src/instance_recovery.rs','crates/plugins/src/service_handlers.rs']);

report.status='assessment_complete_with_open_requirements';
report.full_product_acceptance=false;
report.scope='User requested acceptance of existing capabilities and explicit retention of gaps; does not claim all 33 scenarios ran or passed';
report.audited_at=new Date().toISOString();
report.checkout=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
report.delivery={bundle:bundle.bundle,core_source_commit:bundle.source_commit,manifest_sha256:bundle.manifest_sha256,core_sha256:bundle.core_sha256,bytes,packages:bundle.packages.map(item=>({name:item.name,version:item.version,...item.new})),reused:bundle.reused};
report.changed_core_boundary={files:priorScope,check:'cargo test -p rho-host --test plugins --locked --offline',result:'13 passed; 0 failed; 0 ignored',log:'m6-host-ports.log',limits:'Existing Host port cases; not a fresh execution of every historical 50-case test or every saved-contract conflict/pagination branch'};
for(const item of report.requirements){
  item.previous_assessment={status:item.status,limits:item.limits};
  item.status='retained_prior_scope';
  item.limits='Retained evidence applies to its original artifacts and stated scope. The two changed core admission files have current Host-port coverage; this is not a complete rerun on the delivered package set.';
}
function revise(id,status,evidence,limits){const item=report.requirements.find(item=>item.id===id);assert.ok(item,id);item.status=status;item.evidence=[...new Set([...(item.evidence??[]),...evidence])];item.limits=limits;delete item.next_work;}
revise('equal_packages','verified_delivered_set',['m6-bundle-acceptance.json','m6-delivery-results.json'],'All sixteen exact delivered archives pass disposable relocation/import/retry/remove/empty-start/restore. No user installation or publication.');
revise('final_delivery','verified_development_bundle',['m6-bundle-refresh.json','m6-bundle-acceptance.json','m6-delivery-results.json'],'Exact bytes/hashes checked again by this audit. Imported Studio and delivered SDK → actual Files patch/recovery pass. Ad hoc signature only; no Developer ID signing, notarization or publication.');
revise('visual_runtime_components','verified_delivered_scoped_runtime',['m6-delivery-results.json'],'Delivered declaration/definition editor, compiled SDK, real Files observation/patch/original-operation recovery pass. Snapshot polling only; no native push or arbitrary action recovery claim.');
revise('annotation_ui','verified_reviewed_foundation',['annotation-version-browser','annotation-foundation-files','annotation-foundation-viewer','annotation-foundation-entries','m6-system-ime.json'],'AN01–AN06 foundation has eight entries, Files quote/Viewer image save→draft→refresh/source-change, history/CAS, keyboard and 600/320px evidence. Real-model quality is separate.');
revise('usability','partially_verified_controls',['m6-system-ime.json','m6-ime-composition.png','m6-ime-saved.png'],'Real macOS/Edge Chinese IME passes in Annotations; native candidate visibility is user-confirmed. Other Agent/Editor controls and OS/input methods are not established by this run. Retained normal/wide/narrow, pointer/focus/clipboard evidence remains scoped to its original views.');
for(const id of ['faults','isolation'])revise(id,'prior_cases_plus_current_host_boundary',['m6-host-ports.log','m6-bundle-acceptance.json'],'Historical 50-case evidence retained. Current 13 Host-port cases and delivered archive corruption/containment checks pass; no new claim about untested branches or an OS sandbox.');
report.requirements.push({id:'real_provider_matrix',requirement:'Eleven original intents across seven profiles, three repetitions each',status:'assessed_with_gaps',counts,attempts,evidence:['m6-live-matrix-results.json','m6-live-matrix-reviewed.json','m6-live-objects-results.json'],limits:'18 document-dependent cases not run. Three Plots metadata cases are partial, not substitutes for the original visual-color intent. Six completed runs were checked through their original public records without another model/R loop.'});
report.requirements.push({id:'real_vision_quality',requirement:'Actual image input and grounded visible-image answer',status:'failed_diagnostic',evidence:['m6-live-matrix-results.json'],diagnostic:reviewed.live_provider.vision,limits:'Qwen3.8-27B received the diagnostic PNG through the real service with HTTP 200 but emitted no visible text. Current image gate rejected it; full annotated-image interpretation/followup was not run. No vision pass is claimed.'});
report.approved_scope={
  PS01:['equal_packages','isolation','final_delivery'],PS02:['scene_continuity','time_machine'],PS03:['bidirectional_editing','visual_runtime_components','studio_self_development'],PS04:['time_machine','version_coexistence'],PS05:['faults','visual_runtime_components'],PS06:['version_coexistence','scene_continuity'],PS07:['usability'],
  AN01:['annotation_ui'],AN02:['annotation_ui','real_vision_quality'],AN03:['annotation_ui'],AN04:['annotation_ui'],AN05:['annotation_ui'],AN06:['annotation_ui','usability'],
};
report.excluded_proposals=['HV01–HV07','R01–R03'];
report.open_requirements=[
  '18 document-dependent real-model scenarios lack scoped Editor edit/save/captured-run tools; they remain not_run.',
  'Original three Plots visual-color scenarios remain unverified; metadata-only behavior is partial evidence.',
  'Qwen3.8-27B failed the real image diagnostic; annotated-image quality and text-only followup remain unrun.',
  'Actual system IME evidence is limited to Annotations in macOS Edge; other controls/OS are not covered.',
  'Historical scene/version/Python/Studio-self evidence retains original artifact scope; no complete current-bundle rerun or global release claim.',
];
report.evidence_index={};
for(const name of new Set(report.requirements.flatMap(item=>item.evidence??[]))){
  const file=path.resolve(dir,name);assert.ok(fs.existsSync(file),`Missing retained evidence ${name}`);
  if(fs.statSync(file).isFile())report.evidence_index[name]={bytes:fs.statSync(file).size,sha256:digest(fs.readFileSync(file))};
  else report.evidence_index[name]={kind:'retained_browser_directory',entries:fs.readdirSync(file).length};
}
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,status:report.status,full_product_acceptance:false,counts,bytes,requirements:report.requirements.length}));
