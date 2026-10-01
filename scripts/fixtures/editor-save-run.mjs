import assert from 'node:assert/strict';

export async function checkEditorSaveRun({EditorController,make,edit,wait}) {
  const capture=await make('captured=1',false),path=capture.controller.document.path;
  let observed;capture.r.sessionGate=new Promise(resolve=>observed=resolve);
  const request=capture.controller.saveAndRun();edit(capture.controller,'later=2');
  await wait(()=>capture.r.queries.some(query=>query.cap.id==='r.session'));observed();await request;
  assert.equal(capture.r.attempts.length,0,'file admission is not success');
  assert.equal(capture.controller.pending.raw,'\ufeffcaptured=1');assert.equal(capture.stored().code.text,'captured=1');
  assert.equal(capture.stored().fileRun.save.intent.request,capture.stored().save.intent.request);
  edit(capture.controller,'latest=3');await capture.finishFile();await capture.controller.inspectSave();
  assert.equal(capture.controller.fileRun.phase,'ready');assert.equal(capture.r.attempts.length,0,'inspection is not R submission');
  assert.equal(capture.controller.document.raw,'\ufefflatest=3');assert.equal(capture.native.files.get(path),'\ufeffcaptured=1');
  await capture.controller.advanceSavedRun();assert.equal(capture.r.attempts.length,1);
  assert.equal(capture.r.attempts[0].args.arguments.run.code,'captured=1');assert.equal(capture.r.attempts[0].args.arguments.run.source.kind,'file');
  assert.equal(capture.r.attempts[0].args.binding.target,'session');assert.equal(capture.controller.fileRun.phase,'submitting');
  capture.finish();await capture.controller.inspectCode();await capture.controller.dismissCode();assert.equal(capture.controller.fileRun,null);

  const unchanged=await make('already_saved=1',false);await unchanged.controller.save();await unchanged.finishFile();await unchanged.controller.inspectSave();
  const writes=unchanged.native.attempts.length;await unchanged.controller.saveAndRun();
  assert.equal(unchanged.native.attempts.length,writes);assert.equal(unchanged.r.attempts.length,1,'unchanged native bytes need no artificial file write');

  const changed=await make('same=1',false);await changed.controller.save();await changed.finishFile();await changed.controller.inspectSave();
  const query=changed.client.query;let observations=0;
  changed.client.query=async(cap,args)=>{if(cap.id==='files.snapshot'&&++observations===2)changed.native.files.set(changed.controller.document.path,'external');return query(cap,args);};
  await assert.rejects(changed.controller.saveAndRun(),/saved file changed/);assert.equal(changed.r.attempts.length,0);
  assert.equal(changed.controller.fileRun.phase,'ready');await changed.controller.dismissCode();

  const absent=await make();absent.r.session=null;await assert.rejects(absent.controller.saveAndRun('new.R'),/Start the selected/);
  assert.equal(absent.native.attempts.length,0);assert.equal(absent.r.attempts.length,0);
  const invalid=await make();await assert.rejects(invalid.controller.saveAndRun('../outside.R'),/path/);await assert.rejects(invalid.controller.saveAndRun('plain.txt'),/R file/);
  assert.equal(invalid.native.attempts.length,0);assert.equal(invalid.r.queries.length,0);

  const conflict=await make();await conflict.controller.saveAndRun('new.R');conflict.native.files.set('new.R','external');await conflict.finishFile();await conflict.controller.inspectSave();
  await conflict.controller.advanceSavedRun();assert.equal(conflict.r.attempts.length,0);await assert.rejects(conflict.controller.retryCode(),/file save must be confirmed/);
  await assert.rejects(conflict.controller.dismissCode(),/original file save/);await conflict.controller.acknowledgeFileFailure();
  assert.equal(conflict.controller.code,null);assert.equal(conflict.controller.fileRun,null);assert.equal(conflict.native.files.get('new.R'),'external');

  const receipt=await make();await receipt.controller.saveAndRun('receipt.R');await receipt.finishFile();
  receipt.native.records[0].output.after.files[0].sha256='sha256:'+'e'.repeat(64);
  await assert.rejects(receipt.controller.inspectSave(),/receipt/);await receipt.controller.advanceSavedRun();assert.equal(receipt.r.attempts.length,0);

  const lostFile=await make();lostFile.native.lost=true;await assert.rejects(lostFile.controller.saveAndRun('lost.R'),/acknowledgement lost/);
  const fileRequest=lostFile.controller.pending.intent.request;await lostFile.controller.retrySave();assert.equal(lostFile.native.attempts[1].options.requestId,fileRequest);
  await lostFile.finishFile();await lostFile.controller.inspectSave();await lostFile.controller.advanceSavedRun();assert.equal(lostFile.r.attempts.length,0,'failed chain needs explicit continuation');
  await lostFile.controller.continueSavedRun();assert.equal(lostFile.r.attempts.length,1);assert.equal(lostFile.native.mutations,1);

  const lostR=await make();await lostR.controller.saveAndRun('lost-r.R');await lostR.finishFile();await lostR.controller.inspectSave();lostR.r.lost=true;
  await assert.rejects(lostR.controller.advanceSavedRun(),/acknowledgement lost/);const original=lostR.controller.code.intent.request;
  await lostR.controller.retryCode();assert.equal(lostR.r.attempts[1].options.requestId,original);assert.equal(lostR.r.records.length,1);assert.equal(lostR.native.mutations,1);

  const interrupted=await make();let release;interrupted.native.gate=new Promise(resolve=>release=resolve);
  const saving=interrupted.controller.saveAndRun('closing.R');await wait(()=>interrupted.native.records.length===1);
  edit(interrupted.controller,'later=9');const closing=interrupted.controller.pause();release();await saving;await closing;
  assert.equal(interrupted.r.attempts.length,0);interrupted.controller.stop();await interrupted.finishFile();
  interrupted.client.view={...interrupted.client.view,view:'reopened-saved-run'};
  const reopened=new EditorController(interrupted.client,interrupted.configuration);await reopened.open();await reopened.inspectSave();await reopened.advanceSavedRun();
  assert.equal(reopened.document.raw,'later=9');assert.equal(reopened.fileRun.phase,'ready');assert.equal(interrupted.r.attempts.length,0);
  await assert.rejects(reopened.continueSavedRun(),/original open view/);await assert.rejects(reopened.retryCode(),/file save must be confirmed/);
  await reopened.dismissCode();assert.equal(reopened.code,null);assert.equal(interrupted.r.attempts.length,0);

  const paused=await make();await paused.controller.saveAndRun('pause.R');await paused.finishFile();await paused.controller.pause();paused.controller.resume();
  await paused.controller.inspectSave();await paused.controller.advanceSavedRun();assert.equal(paused.r.attempts.length,0,'resume does not restart a chain');
  await paused.controller.continueSavedRun();assert.equal(paused.r.attempts.length,1,'original view may explicitly continue a verified capture');

  const beforeR=await make();await beforeR.controller.saveAndRun('prepared.R');await beforeR.finishFile();await beforeR.controller.inspectSave();
  let sync;beforeR.state.settlementGate=new Promise(resolve=>sync=resolve);const admissions=beforeR.state.records.length;
  const advancing=beforeR.controller.advanceSavedRun();await wait(()=>beforeR.state.records.length>admissions);
  const pauseBeforeR=beforeR.controller.pause();sync();await assert.rejects(advancing,/preparing to close/);await pauseBeforeR;
  assert.equal(beforeR.r.attempts.length,0);assert.equal(beforeR.stored().fileRun.phase,'ready','unattempted R admission rolls back only its local preparation');

  const unaccepted=await make();unaccepted.state.failPersist=true;await assert.rejects(unaccepted.controller.saveAndRun('unsent.R'),/acknowledgement lost/);
  assert.equal(unaccepted.native.attempts.length,0);assert.equal(unaccepted.r.attempts.length,0);assert.equal(unaccepted.controller.code,null);assert.equal(unaccepted.controller.fileRun,null);

  const uncertain=await make();await uncertain.controller.saveAndRun('uncertain.R');uncertain.native.records[0].status=uncertain.native.records[0].outcome='uncertain';
  await uncertain.controller.inspectSave();await uncertain.controller.advanceSavedRun();await assert.rejects(uncertain.controller.acknowledgeFileFailure(),/no confirmed failure/);
  assert.equal(uncertain.r.attempts.length,0);assert.ok(uncertain.controller.fileRun);

  const changedSession=await make();await changedSession.controller.saveAndRun('bound.R');changedSession.r.session='replacement-session';
  await changedSession.finishFile();await changedSession.controller.inspectSave();await changedSession.controller.advanceSavedRun();
  assert.equal(changedSession.r.attempts[0].args.arguments.expected_session,'session','a saved run never binds a replacement session');

  const forged=await make();await forged.controller.saveAndRun('forged.R');await forged.controller.pause();forged.controller.stop();
  const payload=forged.stored();payload.fileRun.raw='other';await forged.owner.save(new TextEncoder().encode(JSON.stringify(payload)));forged.client.view.state=structuredClone(forged.owner.snapshot);
  await assert.rejects(new EditorController(forged.client,forged.configuration).open(),/saved run differs/);
  console.log('Editor saved-run checks passed: exact click capture, verified native save before R admission, later edits, no-write path, failure/uncertainty, idempotent recovery, close fences and explicit original-view continuation.');
}
