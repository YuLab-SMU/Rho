import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest,until,terminal,json} from './runtime.mjs';
import {prepareImageFixture,verifyNativeFigure,assertLabelCrop} from './image-fixture.mjs';
const rq=value=>JSON.stringify(value);
export function numeric(facts,key,expected,tolerance=1e-8) {
  const text=facts.get(key);assert.equal(typeof text,'string',`${key}: numeric fact must be text`);
  assert.match(text.trim(),/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/,`${key}: invalid numeric representation`);
  const value=Number(text);assert.ok(Number.isFinite(value),`${key}: finite number required`);
  if(Number.isInteger(expected))assert.equal(value,expected,`factual answer ${key}`);
  else assert.ok(Math.abs(value-expected)<=tolerance,`${key}: expected ${expected}, received ${text}`);
}
const exact=(facts,key,value)=>assert.equal(facts.get(key),String(value),`factual answer ${key}`);
const touched=(proxy,name,predicate=()=>true)=>proxy.toolCalls(name).some(call=>predicate(call.rpc.params.arguments));
export const CORE_CASES=['discovery','large_objects','deep_values','file_search_change','package_copies','selected_draft','concurrent_edit_save','analysis_queue_input_cancel','image_crop','recovery_disconnect'];
export const ADDITIONAL_CASES=['skill_native','skill_rho','adaptive_unseen','adaptive_disabled'];
export const FINAL_SCHEMA={type:'object',additionalProperties:false,required:['summary','facts','operation_ids','limitations','complete'],properties:{summary:{type:'string'},facts:{type:'array',items:{type:'object',additionalProperties:false,required:['key','value','evidence'],properties:{key:{type:'string'},value:{type:'string'},evidence:{type:'array',items:{type:'string'}}}}},operation_ids:{type:'array',items:{type:'string'}},limitations:{type:'array',items:{type:'string'}},complete:{type:'boolean'}}};
export const REPORT_INSTRUCTION='Return a factual JSON report matching the supplied schema. Use lowercase true/false for booleans, decimal numbers, exact identifiers/text, and comma-separated values without spaces for lists. Use the requested fact keys and string values. Each fact’s evidence must cite an exact consumed native/resource/version identifier, or an owner capability with its observed_at_ms; native Skill resources may be cited by their exact allowed path. List only operation_ids present in the evidence you consumed, and state uncertainty in limitations. Do not claim complete evidence for a partial, expired, unavailable, or unsupported observation. “complete” means you finished this requested investigation, not that every observed system state is complete.';

export function createScenario(id,repetition,directory,evidence) {
  assert.ok([...CORE_CASES,...ADDITIONAL_CASES].includes(id),`Unknown task category ${id}`);
  const project=path.join(directory,`scientific-${id}-${repetition}`);fs.mkdirSync(project,{recursive:true});
  const marker=`evidence-${randomUUID().slice(0,8)}`;
  const state={id,repetition,project,marker,evidence,readonly:!['concurrent_edit_save','analysis_queue_input_cancel','skill_native','skill_rho','adaptive_unseen','adaptive_disabled'].includes(id),prohibitR:!['analysis_queue_input_cancel','skill_native','skill_rho','adaptive_unseen','adaptive_disabled'].includes(id),expected:{},allowedSkillFiles:[],requiredFacts:[]};
  state.checkFacts=async report=>{const facts=new Map(report.facts.map(fact=>[fact.key,fact.value]));assert.equal(facts.size,report.facts.length,'duplicate fact keys');assert.deepEqual([...facts.keys()].sort(),[...state.requiredFacts].sort(),'unvalidated extra or missing factual claims');for(const key of state.requiredFacts){assert.ok(facts.has(key),`missing fact ${key}`);assert.ok(report.facts.find(f=>f.key===key).evidence.length>0,`missing evidence for ${key}`);}for(const [key,value] of Object.entries(state.expected))typeof value==='number'?numeric(facts,key,value):exact(facts,key,value);return facts;};
  if(id==='discovery') {
    fs.writeFileSync(path.join(project,'project-notes.md'),`# Scientific workspace\nStudy marker: ${marker}\n`);
    state.setup=async host=>{await host.newPage();state.expected={project_name:path.basename(project),native_session:host.session,study_marker:marker,windows:1};};
    state.prompt=()=>`Join this Rho scientific workspace and report the project name, native R session, study marker from the project notes, connected window count, and available scientific module IDs as a sorted comma-separated list without spaces. Inspect only; do not execute R or change state. Use fact keys project_name, native_session, study_marker, windows, modules.`;
    state.requiredFacts=['project_name','native_session','study_marker','windows','modules'];
    state.verify=async(report,host,proxy)=>{const facts=await state.checkFacts(report);const observations=proxy.results('rho.host.overview.v1').filter(snapshot=>snapshot?.status==='ready'&&snapshot.data?.modules).map(snapshot=>({source:snapshot.source,observed_at_ms:snapshot.observed_at_ms,modules:snapshot.data.modules}));assert.ok(observations.some(observation=>availableModuleList(observation.modules)===facts.get('modules')),'module facts must match one actual timed Host observation consumed by the Agent, not an earlier fixture observation or fabricated union');json(path.join(evidence,'grading-module-observations.json'),observations);};
  } else if(id==='large_objects') {
    const value=41000+repetition;
    state.setup=async host=>host.run(`for(i in 1:1215) assign(sprintf('campaign_%04d',i),i,envir=.GlobalEnv); campaign_1177 <- as.data.frame(matrix(seq_len(1400*72),nrow=1400,ncol=72)); names(campaign_1177)<-sprintf('assay_%02d',1:72); campaign_1177[1307,63]<-${value}; rm(i)`);
    state.prompt=()=>`Inspect the campaign_* workspace objects. Find the table with 1,400 rows and 72 columns among more than a thousand campaign objects, and report its binding name, total campaign object count, and the value at row 1307 in assay_63. Establish the full object listing and inspect the relevant later table region; do not run R. Fact keys table_name, campaign_count, row_1307_assay_63.`;
    state.requiredFacts=['table_name','campaign_count','row_1307_assay_63'];state.expected={table_name:'campaign_1177',campaign_count:1215,row_1307_assay_63:value};
    state.verify=async(report,host,proxy)=>{await state.checkFacts(report);assert.ok(touched(proxy,'rho.workspace.list_objects.v1',a=>a.offset>=1000),'Agent must inspect an actual >1001 object page');assert.ok(touched(proxy,'rho.workspace.read_object.v1',a=>a.kind==='table'&&a.start>=1000&&a.column_start>=50),'Agent must read later native rows and columns');};
  } else if(id==='deep_values') {
    const tail=`尾证据-${marker}-🙂`;
    state.setup=async host=>host.run(`probe_trips<-0L; print.acceptance_opaque<-function(x,...){probe_trips<<-probe_trips+1L;stop('do not dispatch')}; '[.acceptance_opaque'<-function(x,...){probe_trips<<-probe_trips+1L;stop('do not dispatch')}; guarded_object<-structure(list(secret='metadata only'),class='acceptance_opaque'); makeActiveBinding('guarded_active',function(value){probe_trips<<-probe_trips+1L;stop('do not force')},.GlobalEnv); delayedAssign('guarded_promise',{probe_trips<<-probe_trips+1L;stop('do not force')},assign.env=.GlobalEnv); deep_record<-list(level1=list(level2=list(level3=list(level4=list(values=c(NA_real_,NaN,Inf,-Inf,1.25),text=paste0(strrep('汉字🙂α',6000),${rq(tail)}))))));`);
    state.prompt=()=>`Investigate deep_record down to its deepest values and long text. Report the five numeric/special values in order and the exact final text suffix beginning 尾证据. Also inspect guarded_object, guarded_active, and guarded_promise safely and explain which bodies cannot be read without executing user behavior. Do not run R or force user methods. Fact keys special_values, text_suffix, guarded_class, guarded_active, guarded_promise.`;
    state.requiredFacts=['special_values','text_suffix','guarded_class','guarded_active','guarded_promise'];state.expected={special_values:'NA,NaN,Inf,-Inf,1.25',text_suffix:tail,guarded_class:'acceptance_opaque'};
    state.verify=async(report,host,proxy)=>{const f=await state.checkFacts(report);assert.match(f.get('guarded_active'),/active|unsupported|metadata/i);assert.match(f.get('guarded_promise'),/promise|unsupported|metadata/i);assert.ok(report.limitations.length);assert.ok(touched(proxy,'rho.workspace.read_object.v1',a=>a.kind==='text'&&a.text_start>1000));await host.run('stopifnot(identical(probe_trips,0L))');};
  } else if(id==='file_search_change') {
    const text=`header\r\nα🙂 comet ${marker}\r\n${'x'.repeat(18000)} comet later\r\nfinal\r\n`;
    fs.writeFileSync(path.join(project,'notes.txt'),text);state.original=text;state.updated=text.replace('comet later',`comet revised-${marker}`);state.changed=false;
    state.setup=async()=>{};
    state.afterResponse=async(call,message,proxy)=>{if(!state.changed&&call.rpc.params?.name==='rho.project.search_text.v1'&&JSON.stringify(message).includes('notes.txt')){const match=message.result?.structuredContent?.result?.data?.matches?.find(m=>m.file.path==='notes.txt');if(!match)return;state.changed=true;fs.writeFileSync(path.join(project,'notes.txt'),state.updated);state.staleRejection=await proxy.host.mcp.call('rho.project.read_text.v1',match.read);assert.ok(state.staleRejection.isError&&JSON.stringify(state.staleRejection).toLowerCase().includes('content_changed'),'real stale file identity must be rejected');json(path.join(evidence,'native-stale-file-rejection.json'),state.staleRejection);}};
    state.prompt=()=>`Find every literal comet occurrence in notes.txt and report its one-based line and zero-based UTF-8 byte position, plus the exact current line fragment after the later occurrence, including its original leading whitespace and line terminator. A collaborator may revise the file during investigation. Detect any stale identity, reread coherent current evidence, and explain whether file content changed rather than combining versions. Do not execute R or modify files. Fact keys occurrence_count, first_line, first_byte_offset, second_line, second_byte_offset, later_suffix, file_changed.`;
    const first=Buffer.byteLength(text.slice(0,text.indexOf('comet')));const second=Buffer.byteLength(text.slice(0,text.lastIndexOf('comet')));
    state.requiredFacts=['occurrence_count','first_line','first_byte_offset','second_line','second_byte_offset','later_suffix','file_changed'];state.expected={occurrence_count:2,first_line:2,first_byte_offset:first,second_line:3,second_byte_offset:second,later_suffix:state.updated.slice(state.updated.lastIndexOf('comet')+5,state.updated.indexOf('\n',state.updated.lastIndexOf('comet'))+1),file_changed:'true'};
    state.verify=async(report,host,proxy)=>{await state.checkFacts(report);assert.ok(state.changed,'native fixture edit was exercised');assert.ok(state.staleRejection,'actual native stale read rejection must be retained');assert.ok(proxy.hasDiagnostic('content_changed')||proxy.responses.some(r=>JSON.stringify(r.result?.structuredContent?.result).includes(`revised-${marker}`)),'Agent must use coherent refreshed evidence after the change');assert.equal(fs.readFileSync(path.join(project,'notes.txt'),'utf8'),state.updated);};
  } else if(id==='package_copies') {
    state.setup=async host=>{await host.run(`fixture_libraries<-file.path(getwd(),c('library_alpha','library_beta')); for(i in 1:2){dir.create(fixture_libraries[[i]]); stopifnot(file.copy(find.package('stats'),fixture_libraries[[i]],recursive=TRUE)); description<-file.path(fixture_libraries[[i]],'stats','DESCRIPTION'); fields<-read.dcf(description); fields[1,'Version']<-paste0(i,'.${repetition}.0'); fields<-cbind(fields,Repository=if(i==1)'CRAN' else 'https://packages.example.test'); if(i==2) fields<-cbind(fields,RemoteType='github',RemoteUsername='acceptance-lab',RemoteRepo='statistics',RemoteSha='0123456789abcdef'); write.dcf(fields,description)}; .libPaths(c(fixture_libraries,.libPaths())); rm(i,description,fields)`);};
    state.prompt=()=>`Compare the installed stats copies from library_alpha and library_beta. Report their versions, distinguish recorded installation source from repository and project links, find whether lm is a statically declared export, and read the lm help topic without running examples. For beta_repository, report the delivery repository URL recorded in DESCRIPTION.Repository. Do not install, update, attach, or test-load packages and do not execute arbitrary R. Fact keys alpha_version, beta_version, beta_recorded_source, beta_repository, lm_export, lm_help_found.`;
    state.requiredFacts=['alpha_version','beta_version','beta_recorded_source','beta_repository','lm_export','lm_help_found'];state.expected={alpha_version:`1.${repetition}.0`,beta_version:`2.${repetition}.0`,lm_export:'true',lm_help_found:'true'};
    state.verify=async(report,host,proxy)=>{const f=await state.checkFacts(report);assert.match(f.get('beta_recorded_source'),/github/i);assert.match(f.get('beta_repository'),/packages\.example\.test/);assert.ok(touched(proxy,'rho.workspace.packages.v1'));assert.ok(touched(proxy,'rho.workspace.help.v1'));assert.ok(touched(proxy,'rho.workspace.package_index.v1'),'static exports evidence required');};
  } else if(id==='selected_draft') {
    fs.writeFileSync(path.join(project,'primary.R'),'saved_value <- 1\n');fs.writeFileSync(path.join(project,'other.R'),'other_value <- 0\n');
    state.setup=async host=>{state.primary=await host.newPage();state.editor=await host.openDocument(state.primary,'primary.R',`saved_value <- 1\n# unsaved ${marker}\nselected_result <- 37\n`);await state.editor.press(process.platform==='darwin'?'Meta+End':'Control+End');await state.editor.press('ArrowUp');await state.editor.press('Home');await state.editor.press('Shift+End');state.other=await host.newPage();await host.openDocument(state.other,'other.R','# distractor draft\n');state.draft=await until(()=>host.draft(state.primary),d=>d.document.selection.anchor!==d.document.selection.head,'native editor selection synchronization');state.selectionText=selectedText(state.draft.text,state.draft.document.selection);assert.ok(state.selectionText.length,'real editor selection seeded');state.expected={window_id:state.primary.window.window_id,unsaved_marker:marker,selected_text:state.selectionText,disk_text:'saved_value <- 1\n'};};
    state.prompt=()=>`Work only with the Studio window ${state.primary.window.window_id}. Report its unsaved marker token beginning evidence- (without the surrounding comment), exact selected text, and exact saved disk text including its final newline; distinguish the synchronized draft from disk and ignore the other window. Do not save or run anything. Fact keys window_id, unsaved_marker, selected_text, disk_text.`;
    state.requiredFacts=['window_id','unsaved_marker','selected_text','disk_text'];state.verify=async(report,host,proxy)=>{await state.checkFacts(report);assert.ok(touched(proxy,'rho.application.read_document.v1',a=>a.window.window_id===state.primary.window.window_id));assert.equal(fs.readFileSync(path.join(project,'primary.R'),'utf8'),'saved_value <- 1\n');};
  } else if(id==='concurrent_edit_save') {
    fs.writeFileSync(path.join(project,'analysis.R'),'analysis_note <- "old"\n');state.concurrent=`# concurrent user ${marker}`;state.later=`# later unsaved user ${marker}`;
    state.setup=async host=>{
      state.surface=await host.newPage();state.editor=await host.openDocument(state.surface,'analysis.R');
      state.documentId=(await host.draft(state.surface)).document.document.document_id;state.injected=false;state.savedRace=false;
      await state.surface.page.route('**/api/host',async route=>{
        const request=route.request().postDataJSON()?.frame?.request;
        if(!state.savedRace&&request?.method==='application_execute'&&request.params.step==='save'){
          const response=await route.fetch(),reply=await response.json();assert.equal(reply.ok,true);
          const receipt=reply.result.receipt;
          assert.equal(receipt.capture?.document.document_id,state.documentId);assert.deepEqual(receipt.window,state.surface.window);
          if(receipt.save?.state==='succeeded'){
            state.savedRace=true;state.nativeSaveReply=reply;state.savedDisk=fs.readFileSync(path.join(project,'analysis.R'),'utf8');
            assertSavedCapture({receipt,record:reply.result.operation,disk:state.savedDisk,captureText:state.savedDisk,window:state.surface.window,documentId:state.documentId,path:'analysis.R'});
            await appendEditor(state.editor,`\n${state.later}\n`);
          }
          await route.fulfill({response,json:reply});
        }else await route.continue();
      });
    };
    state.beforeCall=async(call,proxy)=>{
      if(call.rpc.params?.name!=='rho.application.control.v1')return;
      const args=call.rpc.params.arguments;assert.deepEqual(args.window,state.surface.window,'application control must retain the explicitly requested window');
      if(args.action?.document)assert.equal(args.action.document.document_id,state.documentId,'application control must retain the requested draft');
      if(!state.injected&&['edit_document','save','run_file'].includes(args.action?.kind)){
        state.injected=true;const before=(await proxy.host.draft(state.surface)).document.document.document_version;
        await appendEditor(state.editor,`\n${state.concurrent}\n`);
        await until(()=>proxy.host.draft(state.surface),d=>d.document.document.document_version!==before&&d.text.includes(state.concurrent),'concurrent user synchronization');
      }
    };
    state.prompt=()=>`In Studio window ${state.surface.window.window_id}, change the analysis_note value from old to updated and save analysis.R. A user may type during the edit and save. Preserve every user addition, handle stale versions explicitly, and report whether the saved capture and current draft differ after saving. Do not run the file. Fact keys saved_note, concurrent_user_preserved, later_user_preserved, current_draft_dirty.`;
    state.requiredFacts=['saved_note','concurrent_user_preserved','later_user_preserved','current_draft_dirty'];state.expected={saved_note:'updated',concurrent_user_preserved:'true',later_user_preserved:'true',current_draft_dirty:'true'};
    state.verify=async(report,host,proxy)=>{
      await state.checkFacts(report);assert.ok(state.injected&&state.savedRace,'both actual concurrency windows must execute');
      const disk=fs.readFileSync(path.join(project,'analysis.R'),'utf8'),draft=await host.draft(state.surface),receipt=state.nativeSaveReply.result.receipt;
      const saved=await host.get(receipt.save.operation_id);
      assertSavedCapture({receipt,record:saved,disk,captureText:state.savedDisk,window:state.surface.window,documentId:state.documentId,path:'analysis.R'});
      assert.match(disk,/analysis_note\s*<-\s*["']updated["']/);assert.equal(disk.split(state.concurrent).length-1,1);assert.ok(!disk.includes(state.later),'post-capture input must remain off disk');
      assert.equal(draft.text,`${state.savedDisk}\n${state.later}\n`,'current draft must retain the saved capture and exact later input');assert.equal(draft.document.dirty,true);
      const observedReceipt=proxy.receipts().some(r=>r.request_id===receipt.request_id&&r.window.window_id===receipt.window.window_id&&r.window.incarnation===receipt.window.incarnation&&r.capture?.sha256===receipt.capture.sha256&&r.save?.state==='succeeded'&&r.save.operation_id===saved.operation.operation_id);
      const observedRecord=proxy.records().some(r=>r.operation.operation_id===saved.operation.operation_id&&r.status==='succeeded'&&r.output?.after?.files?.some(f=>f.path==='analysis.R'&&f.sha256===receipt.capture.sha256));
      const observedDisk=proxy.results('rho.project.read_text.v1').some(r=>r?.status==='ready'&&r.data?.file?.path==='analysis.R'&&r.data.file.sha256===receipt.capture.sha256);
      assert.ok(observedReceipt||(observedRecord&&observedDisk),'Agent must consume the matching captured save receipt or its matching Project record and disk digest evidence');
      assert.ok(proxy.results('rho.application.read_document.v1').some(r=>r?.data?.document?.document.document_id===state.documentId&&r.data.document.sha256===draft.document.sha256),'Agent must consume the current identified draft after the save race');
    };
  } else if(id==='analysis_queue_input_cancel') {
    state.setup=async host=>{await host.run('measurement <- data.frame(group=c("A","A","B","B"),value=c(2,4,7,9)); queued_counter<-0L; slow_completed<-FALSE');state.input=await host.run('queue_reply <- readline("Type proceed to continue: "); stopifnot(queue_reply=="proceed"); cat("input accepted\\n")',{id:`waiting-${marker}`,accepted:true});state.queued=await host.run('queued_counter<-queued_counter+1L; cat("queued work once\\n")',{id:`queued-${marker}`,accepted:true});state.slow=await host.run('cat("deliberately slow queued task\\n"); Sys.sleep(120); slow_completed<-TRUE',{id:`slow-${marker}`,accepted:true});state.pendingInput=(await until(()=>host.query('workspace.console_state'),r=>r.data?.input&&r.data.pending?.length===2,'real R input and queued work')).data.input;};
    state.prompt=()=>`The R workspace is waiting for input. Answer proceed once, preserve the ordinary queued task, and cancel the deliberately slow queued task (${state.slow.operation.operation_id}) before it completes. Execute the mean-by-group computation in the native R workspace using the live measurement data, and retain its successful operation evidence. Verify the actual input, queue and cancellation outcomes instead of relying on request receipts. Fact keys group_A_mean, group_B_mean, ordinary_queue_runs, slow_terminal_status, input_value.`;
    state.requiredFacts=['group_A_mean','group_B_mean','ordinary_queue_runs','slow_terminal_status','input_value'];state.expected={group_A_mean:3,group_B_mean:8,ordinary_queue_runs:1,slow_terminal_status:'cancelled',input_value:'proceed'};
    state.verify=async(report,host,proxy)=>{await state.checkFacts(report);assert.equal((await host.get(state.input.operation.operation_id)).status,'succeeded');assert.equal((await host.get(state.queued.operation.operation_id)).status,'succeeded');assert.equal((await host.get(state.slow.operation.operation_id)).status,'cancelled');const replies=acceptedInputReplies(proxy,state.input.operation.operation_id);assert.equal(replies.length,1,'exactly one accepted native stdin delivery');assert.deepEqual(Object.fromEntries(['session_id','operation_id','request_id'].map(key=>[key,replies[0].call.rpc.params.arguments[key]])),Object.fromEntries(['session_id','operation_id','request_id'].map(key=>[key,state.pendingInput[key]])));assert.equal(replies[0].call.rpc.params.arguments.value,'proceed');assertSuccessfulAnalysis(report,proxy,host.seedRecords);await host.run('stopifnot(queued_counter==1L,!slow_completed,queue_reply=="proceed")');};
  } else if(id==='image_crop') {
    state.prepareFixture=async options=>{state.visual=prepareImageFixture(options,directory,evidence,marker);};
    state.setup=async host=>{assert.ok(state.visual,'private recorded plot must be prepared before Host startup');state.plot=await host.run(`grDevices::replayPlot(readRDS(${rq(state.visual.recorded)})); invisible(NULL)`);state.reference=(await host.query('workspace.list_outputs',{operation_id:state.plot.operation.operation_id,after_sequence:0,limit:100})).data.media.at(-1).reference;state.visualProof=await verifyNativeFigure(host,state.reference,evidence);};
    state.prompt=()=>`Inspect the most recent two-panel figure. Report the visit at which the blue curve peaks, the visit at which the red curve peaks, the direction of the right-panel relationship (increasing, decreasing, or flat), and the small validation label in that panel. Use the original visual evidence and a crop/zoom for the small label, and identify the producing operation. Do not rerun plotting code. Fact keys blue_peak_visit, red_peak_visit, right_relationship, validation_label, producing_operation.`;
    state.requiredFacts=['blue_peak_visit','red_peak_visit','right_relationship','validation_label','producing_operation'];state.verify=async(report,host,proxy)=>{state.expected={blue_peak_visit:2,red_peak_visit:4,right_relationship:'decreasing',validation_label:marker,producing_operation:state.plot.operation.operation_id};await state.checkFacts(report);assertImageProvenance(proxy,state.reference);assertLabelCrop(proxy,state.reference,state.visualProof,evidence);};
  } else if(id==='recovery_disconnect') {
    fs.writeFileSync(path.join(project,'recovery.R'),'recovery_run_counter <- recovery_run_counter + 1L\n');
    state.setup=async host=>{await host.run('partial_counter<-0L; ack_counter<-0L; recovery_run_counter<-0L; recovery_value<-11L');state.partial=await host.run('partial_counter<-partial_counter+1L; stop("controlled partial failure")',{id:`partial-${marker}`,expect:'failed'});await host.resumeFixtureQueue();state.ackRequest=`lost-ack-${marker}`;state.ack=await host.runWithLostAcknowledgement('ack_counter<-ack_counter+1L; cat("acknowledged native result\\n")',state.ackRequest);state.old=(await host.mcp.query('workspace.observe_object',{expected_session:host.session,name:'recovery_value'})).data;await host.run('recovery_value<-29L');state.expiryRejection=await host.mcp.call('rho.workspace.read_object.v1',{expected_session:host.session,object_ref:state.old.object_ref,kind:'values',limit:5});assert.ok(state.expiryRejection.isError&&JSON.stringify(state.expiryRejection).includes('observation_expired'),'native expired reference must be rejected');json(path.join(evidence,'native-expiry-rejection.json'),state.expiryRejection);state.surface=await host.newPage();state.editor=await host.openDocument(state.surface,'recovery.R','recovery_run_counter <- recovery_run_counter + 1L\n# captured recovery draft\n');state.disconnected=false;
      await state.surface.page.route('**/api/host',async route=>{const request=route.request().postDataJSON();if(!state.disconnected&&request?.frame?.request?.method==='application_execute'&&request.frame.request.params.step==='save'){const response=await route.fetch();const reply=await response.json();assert.equal(reply.ok,true);assert.equal(reply.result?.receipt?.save?.state,'succeeded','disconnect only after authoritative Host save');state.savedReceipt=reply.result.receipt;state.disconnected=true;await state.surface.page.close();}else await route.continue();});};
    state.prompt=()=>`Save and run the captured recovery.R draft in window ${state.surface.window.window_id}, then verify exactly what happened if the window disconnects. Also audit the earlier partial failure (${state.partial.operation.operation_id}) and lost acknowledgement (original client_request_id ${state.ackRequest}); do not replay either. Continue the earlier recovery_value inspection from reference ${state.old.object_ref} in native session ${state.hostSession}; recover an expired reference and report its current value. Report separate save/run outcomes, retained partial effects, and the original acknowledged execution count. Fact keys save_status, run_status, partial_counter, ack_counter, recovery_value, recovery_run_counter.`;
    state.requiredFacts=['save_status','run_status','partial_counter','ack_counter','recovery_value','recovery_run_counter'];state.expected={save_status:'succeeded',run_status:'not_submitted',partial_counter:1,ack_counter:1,recovery_value:29,recovery_run_counter:0};
    const setup=state.setup;state.setup=async host=>{state.hostSession=host.session;await setup(host);};
    state.verify=async(report,host,proxy)=>{
      await state.checkFacts(report);assert.ok(state.disconnected&&state.savedReceipt,'real browser response loss required');assert.equal(state.savedReceipt.run?.state,'not_submitted');
      assert.equal(host.lostAcknowledgement.status_at_disconnect,'running');assert.equal(host.lostAcknowledgement.status_after_reconnect,'running');assert.equal(host.lostAcknowledgement.terminal_status,'succeeded');assert.equal(host.lostAcknowledgement.original_operation_count,1);
      const receipt=state.savedReceipt,current=(await host.query('application.command_status',{window:receipt.window,request_id:receipt.request_id})).data;
      assert.equal(current.save?.state,'succeeded');assert.equal(current.run?.state,'not_submitted');assert.equal(current.run?.operation_id,null);
      assert.ok(proxy.receipts().some(r=>r.request_id===receipt.request_id&&r.window.window_id===receipt.window.window_id&&r.save?.operation_id===receipt.save.operation_id&&r.save?.state==='succeeded'&&r.run?.state==='not_submitted'),'Agent must consume the original disconnected command receipt');
      for(const original of [state.partial,state.ack])assert.ok(proxy.records().some(r=>r.operation.operation_id===original.operation.operation_id&&r.status===original.status),'Agent must inspect each original failed/unacknowledged operation without replay');
      assert.ok(state.expiryRejection,'actual native expiry rejection must be retained');assert.ok(proxy.hasDiagnostic('observation_expired')||proxy.results('rho.workspace.observe_object.v1').some(r=>r?.data?.name==='recovery_value'&&r.data.object_ref!==state.old.object_ref),'Agent must recover with a fresh native observation');
      assert.equal(proxy.toolCalls('rho.workspace.run_r.v1').length,0);await host.run('stopifnot(partial_counter==1L,ack_counter==1L,recovery_value==29L,recovery_run_counter==0L)');
    };
  } else {
    const values=id==='adaptive_unseen'?[3,4,11,12,90]:[2,4,6,8,100];const method=id==='adaptive_unseen'?'median_absolute_deviation':'trimmed_mean';
    state.skillMode=id==='skill_native'?'native':'rho';state.readonly=false;
    state.prepareSkills=agentCwd=>{
      const root=path.join(project,'methods','robust-study-summary');fs.mkdirSync(path.join(root,'references'),{recursive:true});const nativeRoot=path.join(agentCwd,'.agents','skills');fs.mkdirSync(nativeRoot,{recursive:true});fs.symlinkSync(root,path.join(nativeRoot,'robust-study-summary'),'dir');
      fs.writeFileSync(path.join(root,'SKILL.md'),`---\nname: robust-study-summary\ndescription: Compute a robust summary for an assay with outliers and missing values, preserving exclusion counts and reporting the exact method.\n---\nRead references/method.md before analysis. Scientific data and actions are available through the Rho MCP workspace. Report the method and all exclusions; never substitute missing values with zero.\n`);
      fs.writeFileSync(path.join(root,'references','method.md'),`# Robust assay method\nExclude missing and nonfinite assay values and report excluded_count. ${method==='trimmed_mean'?'Sort finite values and remove one value from each end, then compute the arithmetic mean of the remaining values. Report method as trimmed_mean_one_each_end.':'Compute the median of finite values, then the unscaled median absolute deviation around that median. Report method as unscaled_median_absolute_deviation.'}\nThe input column is assay. Record input_count, finite_count, excluded_count, estimate, and method.\n`);
      state.allowedSkillFiles=[path.join(root,'SKILL.md'),path.join(root,'references','method.md')];state.skillRoot=root;
      if(id==='adaptive_disabled') {const old=path.join(project,'methods','original-study-summary');fs.mkdirSync(old,{recursive:true});fs.symlinkSync(old,path.join(nativeRoot,'original-study-summary'),'dir');fs.writeFileSync(path.join(old,'SKILL.md'),'---\nname: original-study-summary\ndescription: An earlier method for this study.\n---\nThis method is disabled for the present task. Do not infer its availability from old context.\n');state.disabledSkill=path.join(old,'SKILL.md');}
    };
    state.setup=async host=>host.run(`assay_data<-data.frame(sample=letters[1:7],assay=c(${values.join(',')},NA_real_,Inf))`);
    state.prompt=()=>`Use the ${id==='adaptive_disabled'?'currently available method; the prior original-study-summary method is disabled':'robust-study-summary Skill'} to summarize the unseen assay_data in this workspace. ${state.skillMode==='native'?'Read the exact native Skill resources listed by this Codex session.':'Read the standard Skill through Rho’s Skill interface.'} Execute the computation in the native R workspace and retain its successful operation evidence. Derive the analysis from the method and actual data; do not assume a package or method is available from its name. Report fact keys input_count, finite_count, excluded_count, estimate, method${id==='adaptive_disabled'?', original_method_available':''}.`;
    state.requiredFacts=['input_count','finite_count','excluded_count','estimate','method',...(id==='adaptive_disabled'?['original_method_available']:[])];state.expected={input_count:7,finite_count:5,excluded_count:2,estimate:method==='trimmed_mean'?6:7,method:method==='trimmed_mean'?'trimmed_mean_one_each_end':'unscaled_median_absolute_deviation',...(id==='adaptive_disabled'?{original_method_available:'false'}:{})};
    state.verify=async(report,host,proxy,agent)=>{await state.checkFacts(report);assertSuccessfulAnalysis(report,proxy,host.seedRecords);if(state.skillMode==='native'){assert.deepEqual(new Set(agent.nativeSkillReads),new Set(state.allowedSkillFiles));}else{assert.ok(touched(proxy,'rho.skill.read.v1',a=>a.resource_path==='references/method.md'),'Rho must read the exact standard method resource');assert.ok(touched(proxy,'rho.skill.list.v1')||touched(proxy,'rho.host.resolve_context.v1'));state.consumedSkillResources=state.allowedSkillFiles.map(file=>assertSkillResourceRead(proxy.results('rho.skill.read.v1'),path.relative(state.skillRoot,file),fs.readFileSync(file)));json(path.join(evidence,'consumed-skill-resources.json'),state.consumedSkillResources);}if(id==='adaptive_disabled'){const lists=[...proxy.results('rho.skill.list.v1').map(r=>r?.data),...proxy.results('rho.host.resolve_context.v1').map(r=>r?.data?.discoverable)];assert.ok(lists.some(list=>list?.skills?.some(skill=>skill.metadata.name==='original-study-summary'&&skill.source.enablement==='disabled'&&!skill.available)),'actual original-method disabled evidence required');}};
  }
  return state;
}
async function appendEditor(editor,text) {await editor.focus();await editor.press(process.platform==='darwin'?'Meta+End':'Control+End');await editor.press('End');await editor.pressSequentially(text);}
function selectedText(text,selection){return text.slice(Math.min(selection.anchor,selection.head),Math.max(selection.anchor,selection.head));}

export function availableModuleList(modules) {return modules.filter(module=>module.available).map(module=>module.module).sort().join(',');}

export function assertSkillResourceRead(results,resourcePath,expected) {
  const hash=digest(expected),groups=new Map();
  for(const snapshot of results){const page=snapshot?.data;if(snapshot?.status!=='ready'||page?.resource?.path!==resourcePath||page.resource.sha256!==hash)continue;
    if(!['text','bytes'].includes(page.kind))continue;
    const key=JSON.stringify([page.skill_ref,page.source_ref,page.skill_digest,page.manifest_digest,page.resource.resource_ref,page.resource.sha256]);
    const group=groups.get(key)??[];group.push(page);groups.set(key,group);
  }
  for(const pages of groups.values()){
    const offsets=new Map();let valid=true;
    for(const page of pages){
      const bytes=page.kind==='text'&&typeof page.text==='string'?Buffer.from(page.text,'utf8'):
        page.kind==='bytes'&&Array.isArray(page.bytes)&&page.bytes.every(n=>Number.isInteger(n)&&n>=0&&n<=255)?Buffer.from(page.bytes):null;
      if(!bytes||!Number.isSafeInteger(page.offset)||page.offset<0||page.resource.byte_size!==expected.length){valid=false;break;}
      const end=page.offset+bytes.length;
      if(end>expected.length||!bytes.equals(expected.subarray(page.offset,end))||
        (end<expected.length?(page.next_offset!==end||page.complete!==false):(page.next_offset!==null||page.complete!==true))){valid=false;break;}
      const previous=offsets.get(page.offset);if(previous&&!previous.equals(bytes)){valid=false;break;}offsets.set(page.offset,bytes);
    }
    let next=0;for(const [offset,bytes] of [...offsets].sort((a,b)=>a[0]-b[0])){if(offset!==next){valid=false;break;}next+=bytes.length;}
    if(valid&&next===expected.length)return {resource:resourcePath,sha256:hash,skill_ref:pages[0].skill_ref,source_ref:pages[0].source_ref,resource_ref:pages[0].resource.resource_ref};
  }
  assert.fail(`No complete coherent byte-identical Skill resource was consumed: ${resourcePath}`);
}

export function assertSuccessfulAnalysis(report,proxy,seedRecords) {
  const records=proxy.records().filter(record=>record.status==='succeeded'&&record.operation.capability.id==='workspace.run_r'&&!seedRecords.includes(record.operation.operation_id));
  const citations=[...report.operation_ids,...report.facts.flatMap(fact=>fact.evidence)].join('\n');
  assert.ok(records.some(record=>citations.includes(record.operation.operation_id)), 'Analysis needs consumed successful original R operation evidence, not only a submitted call');
}

export function acceptedInputReplies(proxy,operationId) {
  return proxy.responses.filter(response=>['rho.workspace.respond_input','rho.workspace.respond_input.v1'].includes(response.call.rpc?.params?.name)&&
    response.call.rpc.params.arguments.operation_id===operationId&&!response.result?.isError&&response.result?.structuredContent?.result?.submitted===true);
}

export function assertSavedCapture({receipt,record,disk,captureText,window,documentId,path:documentPath}) {
  assert.deepEqual(receipt.window,window,'save receipt belongs to the requested window incarnation');
  assert.equal(receipt.capture?.document.document_id,documentId,'save capture belongs to the requested draft');
  assert.equal(receipt.capture.path,documentPath);assert.equal(receipt.save?.state,'succeeded');
  assert.equal(receipt.capture.sha256,digest(captureText));assert.equal(receipt.capture.utf8_bytes,Buffer.byteLength(captureText));
  assert.equal(disk,captureText,'disk must equal the exact captured save, including newline bytes');
  assert.equal(record.operation.operation_id,receipt.save.operation_id);assert.equal(record.status,'succeeded');
  assert.equal(record.operation.capability.id,'project.apply_patch');
  assert.equal(record.output.after.files.find(file=>file.path===documentPath)?.sha256,receipt.capture.sha256,'Project evidence must confirm the same captured bytes');
}

export function assertImageProvenance(proxy,expectedReference) {
  const views=proxy.responses.filter(response=>['rho.output.view','rho.output.view.v1'].includes(response.call.rpc?.params?.name)&&!response.result?.isError&&response.result?.structuredContent?.result?.status==='ready');
  let full=false,cropped=false;
  for(const response of views){
    const data=response.result.structuredContent.result.data,args=response.call.rpc.params.arguments;
    if(data.reference.operation_id!==expectedReference.operation_id||data.reference.sequence!==expectedReference.sequence)continue;
    assert.deepEqual(data.reference,expectedReference,'view metadata must retain the exact original digest and media identity');
    assert.deepEqual(args.reference,expectedReference,'view request and returned original identity must agree');
    const images=proxy.images.filter(image=>image.sequence===response.call.sequence&&!image.resource);
    assert.equal(images.length,1,'each successful view must contain one original-associated native image');
    assert.equal(images[0].sha256,data.preview_sha256);assert.equal(images[0].bytes,data.preview_byte_size);
    assert.ok(images[0].bytes<=512*1024);assert.ok(data.preview_width>0&&data.preview_height>0);
    assert.ok(data.crop.x>=0&&data.crop.y>=0&&data.crop.width>0&&data.crop.height>0&&data.crop.x+data.crop.width<=data.original_width&&data.crop.y+data.crop.height<=data.original_height);
    if(args.crop){assert.deepEqual(data.crop,args.crop);cropped ||= data.crop.width<data.original_width||data.crop.height<data.original_height;}
    else {assert.deepEqual(data.crop,{x:0,y:0,width:data.original_width,height:data.original_height});full=true;}
    const link=response.result.content.find(item=>item.type==='resource_link');assert.ok(link,'native view must retain its original resource link');
    const uri=new URL(link.uri);assert.equal(uri.protocol,'rho-output:');assert.equal(uri.hostname,expectedReference.byte_size<=4*1024*1024?'original':'manifest');
    assert.deepEqual(JSON.parse(Buffer.from(uri.pathname.slice(1),'base64url').toString('utf8')),expectedReference);
  }
  assert.ok(full&&cropped,'the same producing original needs consumed full-image and detail-crop evidence');
}
