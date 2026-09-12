import { useEffect, useRef, useState } from "react";
import { useApplication, useInstanceConsole, useInstanceOperations, useInstanceSession, useNavigation, usePersistence, useRuntimeSessions, useSession } from "./context";
import { Modal } from "./primitives";
import { copyTime, environmentLabel, rLabel, requireSucceeded } from "./runtime-presentation";
import { message } from "./shared/ports";
import type { WorkspaceInstance } from "./generated/WorkspaceInstance";
import type { CheckpointEntry } from "./generated/CheckpointEntry";
import type { RuntimeLaunchBinding } from "./generated/RuntimeLaunchBinding";
import type { RProbe } from "./generated/RProbe";
import type { RuntimeTarget } from "./runtime-ports";

/** Late native replies remain in Operations, even when their initiating form closed. */
function useAction() {
  const session = useSession(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const live = useRef(true), running = useRef(false), epoch = session.epoch;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const run = async (work: () => Promise<unknown>, done?: () => void) => {
    if (running.current) return;
    running.current = true;
    setBusy(true); setError("");
    try { await work(); if (live.current && session.epoch === epoch) done?.(); }
    catch (e) { if (live.current && session.epoch === epoch) setError(message(e)); }
    finally { running.current = false; if (live.current && session.epoch === epoch) setBusy(false); }
  };
  return { busy, error, run };
}

export function NewSessionDialog({ onClose, onCreated }: { onClose(): void; onCreated?(id: string): void }) {
  const owner = useRuntimeSessions(), session = useSession(), navigation = useNavigation(), state = owner.getSnapshot(), action = useAction();
  const current = owner.selected, defaultR = session.r?.current;
  const choices = new Map<string, { label: string; binding: RuntimeLaunchBinding }>();
  for (const instance of state.instances.values()) if (!choices.has(instance.binding.r_executable)) choices.set(instance.binding.r_executable, { label: `Same as ${instance.name}${instance.installation ? ` · R ${instance.installation.r_version}` : ""}`, binding: instance.binding });
  if (defaultR?.usable && !choices.has(defaultR.selection.executable)) choices.set(defaultR.selection.executable, { label: `Default · R ${defaultR.version}`, binding: { r_executable: defaultR.selection.executable, ark_executable: defaultR.selection.ark, environment_realization_id: null, library_path: null, checkpoint_helper_path: null } });
  for (const candidate of session.r?.candidates ?? []) if (!choices.has(candidate.executable)) choices.set(candidate.executable, { label: candidate.executable, binding: { r_executable: candidate.executable, ark_executable: candidate.ark, environment_realization_id: null, library_path: null, checkpoint_helper_path: null } });
  const [name, setName] = useState(state.total === 0 ? "Main" : "Scratch"), [r, setR] = useState(current?.binding.r_executable ?? defaultR?.selection.executable ?? choices.keys().next().value ?? ""), [environment, setEnvironment] = useState(current?.binding.environment_realization_id ?? ""), [select, setSelect] = useState(true), [probe, setProbe] = useState<RProbe | null>(null), [checking, setChecking] = useState(false), [probeError, setProbeError] = useState("");
  const binding = choices.get(r)?.binding, ark = binding?.ark_executable;
  useEffect(() => {
    let active = true; setProbe(null); setProbeError("");
    if (!r || !ark) return;
    setChecking(true);
    void session.probeR({ executable: r, ark }).then(result => { if (active) setProbe(result); }).catch(e => { if (active) setProbeError(message(e)); }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [r, ark, session]);
  const environments = [...state.instances.values()].filter(instance => instance.binding.r_executable === r && instance.binding.environment_realization_id);
  const create = () => action.run(async () => {
    if (!binding || !probe?.usable) throw new Error("Choose an available R installation first.");
    const matched = environments.find(instance => instance.binding.environment_realization_id === environment);
    const selectedBinding = matched ? matched.binding : { ...binding, environment_realization_id: null, library_path: null };
    const result = requireSucceeded(await owner.createInstance(name.trim(), selectedBinding, { selectWhenReady: select }));
    const output = result.output as unknown as WorkspaceInstance;
    if (output.state !== "ready") throw new Error("The session is not ready. Inspect its launch result before continuing.");
    await owner.refreshInstances(); onCreated?.(output.workspace_instance_id);
  }, onCreated ? undefined : onClose);
  return <Modal title="New R session" description="Choose an installed R and dependency environment. No dependencies are installed here." onClose={onClose}><form className="runtime-form" onSubmit={event => { event.preventDefault(); void create(); }}>
    <label>Session name<input autoFocus maxLength={80} value={name} onChange={event => setName(event.target.value)} disabled={action.busy} /></label>
    <label>R installation<select value={r} onChange={event => { setR(event.target.value); setEnvironment(""); }} disabled={action.busy}><option value="" disabled>Choose an installed R</option>{[...choices].map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label>
    <label>Dependency environment<select value={environment} disabled={action.busy} onChange={event => setEnvironment(event.target.value)}><option value="">R installation libraries</option>{[...new Map(environments.map(instance => [instance.binding.environment_realization_id!, instance])).values()].map(instance => <option key={instance.binding.environment_realization_id!} value={instance.binding.environment_realization_id!}>Same as {instance.name} · verified during launch</option>)}</select></label>
    <div className="runtime-notice"><strong>Starts with empty memory</strong><p>Or restore a recovery copy into a new session.</p><button type="button" className="runtime-link" disabled={!current} onClick={() => { onClose(); navigation.openSessions(current?.workspace_instance_id ?? null, "copies"); }}>Choose copy…</button></div>
    <label className="checkbox"><input type="checkbox" checked={select} onChange={event => setSelect(event.target.checked)} />Use as execution target when ready</label>
    <p className="muted">Recovery: inherited from this project</p>{checking && <p role="status">Checking R installation…</p>}{(probeError || (probe && !probe.usable)) && <p role="alert">{probeError || probe?.diagnostics.join(" ") || "This R installation is unavailable."}</p>}
    {(!choices.size || (probe && !probe.usable)) && <button type="button" onClick={() => { onClose(); navigation.setDialog("settings"); }}>Configure R installations</button>}
    {action.error && <p role="alert" className="error">{action.error}</p>}<div className="runtime-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={action.busy || checking || !probe?.usable || !name.trim()}>{action.busy ? "Creating session…" : "Create session"}</button></div>
  </form></Modal>;
}

export function RenameSessionDialog({ instance, onClose }: { instance: WorkspaceInstance; onClose(): void }) {
  const owner = useRuntimeSessions(), [name, setName] = useState(instance.name), [expectedName] = useState(instance.name), action = useAction();
  return <Modal title={`Rename ${instance.name}`} description="Change the session name. Its identity and objects remain the same." onClose={onClose}><form className="runtime-form" onSubmit={event => { event.preventDefault(); void action.run(async () => requireSucceeded(await owner.renameInstance(instance.workspace_instance_id, name.trim(), expectedName)), onClose); }}><label>Session name<input autoFocus maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>{action.error && <p role="alert">{action.error}</p>}<button className="primary" disabled={action.busy || !name.trim()}>Rename</button></form></Modal>;
}

export function RestoreSessionDialog({ instance, copy, onClose }: { instance: WorkspaceInstance; copy: CheckpointEntry; onClose(): void }) {
  const owner = useRuntimeSessions(), session = useSession(), action = useAction(), [name, setName] = useState(`${instance.name} restored`), [select, setSelect] = useState(true), [choice, setChoice] = useState("");
  const matches = [...owner.getSnapshot().instances.values()].filter(value => value.installation?.r_version === copy.manifest.report.r_version && value.installation.platform === copy.manifest.report.platform);
  const bindings = new Map(matches.map(value => [value.workspace_instance_id, { label: `Same as ${value.name} · ${environmentLabel(value)}`, binding: value.binding }]));
  const defaultR = session.r?.current;
  if (defaultR?.usable && defaultR.version === copy.manifest.report.r_version) bindings.set("default-r", { label: `Default R ${defaultR.version} · R installation libraries`, binding: { r_executable: defaultR.selection.executable, ark_executable: defaultR.selection.ark, environment_realization_id: null, library_path: null, checkpoint_helper_path: null } });
  return <Modal title="Restore in new session" description={`Restoring creates a separate session. ${instance.name} stays available.`} onClose={onClose}><form className="runtime-form" onSubmit={event => { event.preventDefault(); void action.run(async () => requireSucceeded(await owner.restoreInNewSession(instance.workspace_instance_id, copy.manifest.checkpoint_id, name.trim(), select, bindings.get(choice)?.binding)), onClose); }}><p>{copyTime(copy.manifest.created_at_ms)} · {copy.saved_count} saved · {copy.skipped_count} not protected</p><p>R {copy.manifest.report.r_version} · {copy.manifest.report.platform}. The saved dependency environment must still be available.</p><label>R and dependency environment<select value={choice} onChange={event => setChoice(event.target.value)}><option value="">Saved R and dependency environment</option>{[...bindings].map(([id, option]) => <option key={id} value={id}>{option.label}</option>)}</select></label><p className="muted">Version, architecture and package contents are checked before objects are restored. An alternative does not bypass validation.</p><label>Session name<input autoFocus maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label><label className="checkbox"><input type="checkbox" checked={select} onChange={event => setSelect(event.target.checked)} />Use as execution target when ready</label>{action.error && <p className="error" role="alert">{action.error}</p>}<div className="runtime-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={action.busy || !name.trim() || !copy.available}>{action.busy ? "Restoring…" : "Restore in new session"}</button></div></form></Modal>;
}

export function SelectedCopyDialog({ instance, onClose }: { instance: WorkspaceInstance; onClose(): void }) {
  const owner = useRuntimeSessions(), action = useAction(), [names, setNames] = useState(""), [limit, setLimit] = useState(2048);
  const [target] = useState(() => owner.captureTarget(instance.workspace_instance_id));
  return <Modal title="Save selected objects" description="Enter one exact object name per line. Unsupported object graphs remain excluded." onClose={onClose}><form className="runtime-form" onSubmit={event => { event.preventDefault(); void action.run(async () => { requireSucceeded(await owner.captureCheckpoint(target, { include_names: names.split(/\r?\n/).filter(Boolean), include_patterns: [], max_bytes: limit * 1024 ** 2 })); await owner.refreshCheckpoints(instance.workspace_instance_id); }, onClose); }}><label>Object names<textarea autoFocus rows={5} value={names} onChange={event => setNames(event.target.value)} /></label><label>Maximum payload (MiB)<input type="number" min={1} step={1} value={limit} onChange={event => setLimit(Number(event.target.value))} /></label><p className="muted">Project storage and free-space limits still apply.</p>{action.error && <p role="alert">{action.error}</p>}<button className="primary" disabled={action.busy || !names.trim() || !Number.isSafeInteger(limit) || limit < 1}>Save recovery copy</button></form></Modal>;
}

export function LifecycleDialog({ instance, action: kind, onClose, review }: { instance: WorkspaceInstance; action: "restart" | "stop"; onClose(): void; review(): void }) {
  const id = instance.workspace_instance_id, owner = useRuntimeSessions(), session = useInstanceSession(id), console = useInstanceConsole(id), operations = useInstanceOperations(id), action = useAction();
  const [target] = useState(() => owner.captureTarget(id)), [save, setSave] = useState(true), [discard, setDiscard] = useState(false), [finished, setFinished] = useState(false);
  const current = owner.getInstance(id) ?? instance, catalog = owner.recoveryFor(id), latest = catalog?.entries.find(entry => entry.manifest.checkpoint_id === current.protection.latest_checkpoint_id), protection = current.protection;
  useEffect(() => { void owner.refreshCheckpoints(id).catch(() => {}); }, [id, owner]);
  const changed = current.native_session_id !== target.nativeSessionId, blockers = console.consoleState?.current || console.consoleState?.pending.length || current.blockers.filter(blocker => blocker.kind !== "observation").length;
  const unprotected = instance.policy.value.mode === "off" || !protection.capture_available || !!protection.skipped_objects;
  const submit = () => action.run(async () => {
    requireSucceeded(await (kind === "restart" ? owner.restartInstance(target, discard) : owner.stopInstance(target, !save || discard)));
    setFinished(true);
  });
  return <Modal title={finished ? `${instance.name} ${kind === "restart" ? "restarted" : "stopped"}` : `${kind === "restart" ? "Restart" : "Stop"} ${instance.name}?`} description={kind === "restart" ? "Start a fresh R process with empty memory." : "Stop this R process and free its memory."} onClose={onClose}>
    <div className="runtime-form"><div className="runtime-notice"><strong>{rLabel(instance)}</strong><p>{environmentLabel(instance)}</p><p>{protection.latest_checkpoint_id ? `Recovery copy saved · ${copyTime(protection.saved_at_ms)}` : "No recovery copy available"}</p><p>{protection.saved_objects ?? 0} objects saved · {protection.skipped_objects ?? 0} not protected</p>{protection.activity_since_copy && <p>R has been active since this copy.</p>}</div>
      {kind === "stop" && !finished && <label className="checkbox"><input type="checkbox" checked={save} onChange={event => setSave(event.target.checked)} />Save a fresh recovery copy first</label>}
      {unprotected && <div className="runtime-notice attention"><strong>{instance.policy.value.mode === "off" ? "Recovery is off; current objects will not be saved" : protection.capture_available ? `${protection.skipped_objects} objects won’t be protected` : "Recovery capture is unavailable"}</strong>{latest && <p>{latest.manifest.report.skipped.map(item => item.name).join(", ")}</p>}<button className="runtime-link" onClick={review}>Review object coverage →</button>{!finished && <label className="checkbox"><input type="checkbox" checked={discard} onChange={event => setDiscard(event.target.checked)} />Continue without a fresh complete recovery copy</label>}</div>}
      <p className="muted">{kind === "restart" ? "Files, synchronized drafts and recorded outputs remain. Objects will not be restored automatically after this restart." : "The session, files and recovery copies remain. When you open it again, Rho continues from its latest usable copy according to its recovery settings."}</p>
      {!!blockers && !finished && <div className="runtime-notice"><p>Finish or interrupt active work before {kind === "restart" ? "restarting" : "stopping"}.</p>{console.consoleState?.current && <button disabled={action.busy} onClick={() => void action.run(() => operations.cancel(console.consoleState!.current!.operation_id))}>Interrupt current run</button>}{!!console.consoleState?.pending.length && <button disabled={action.busy} onClick={() => void action.run(() => console.cancelPending())}>Cancel waiting runs</button>}{current.blockers.map(blocker => <p key={blocker.reference}>{blocker.label}</p>)}</div>}
      {action.error && <p className="error" role="alert">{action.error}</p>}{changed && !finished && <p role="alert">The R session changed. Close this panel and review its current state.</p>}
      <div className="runtime-actions">{finished ? <button className="primary" onClick={onClose}>Done</button> : <><button onClick={onClose}>{kind === "stop" ? "Keep running" : "Cancel"}</button><button className="primary" disabled={action.busy || !session.connected || changed || !!blockers || ((save || kind === "restart") && unprotected && !discard)} onClick={() => void submit()}>{action.busy ? "Waiting for the operation…" : kind === "restart" ? "Restart with empty memory" : save && !discard ? `Save and stop ${instance.name}` : `Stop ${instance.name}`}</button></>}</div>
    </div>
  </Modal>;
}

export function QuitWorkbenchDialog({ onClose }: { onClose(): void }) {
  const owner = useRuntimeSessions(), session = useSession(), persistence = usePersistence(), application = useApplication(), navigation = useNavigation(), action = useAction();
  const [reviewed] = useState(() => [...owner.getSnapshot().instances.values()].filter(value => value.native_session_id).map(value => ({ name: value.name, target: { workspaceInstanceId: value.workspace_instance_id, nativeSessionId: value.native_session_id!, continuationLineageId: value.continuation_lineage_id } as RuntimeTarget })));
  const [progress, setProgress] = useState(new Map<string, string>()), [discard, setDiscard] = useState(new Set<string>()), [finished, setFinished] = useState(false);
  const syncDrafts = async () => {
    // Bridge synchronization can update persistent view fragments while it awaits
    // its acknowledgement. Flush those fragments afterwards, before checking both.
    for (let attempt = 0; attempt < 3; attempt++) {
      await application.flush(); await persistence.flush();
      if (!persistence.unsynced && application.draftsSynced) return;
      if (persistence.syncError) throw new Error(persistence.syncError);
    }
    throw new Error("Draft synchronization has not completed. Keep this window open.");
  };
  const quit = () => action.run(async () => {
    await syncDrafts();
    for (const { name, target } of reviewed) {
      const value = owner.getInstance(target.workspaceInstanceId);
      if (value?.state === "stopped" && value.native_session_id === null) continue;
      if (value?.native_session_id !== target.nativeSessionId) throw new Error(`${name} changed since this panel opened. Review its current session before quitting.`);
      setProgress(previous => new Map(previous).set(target.workspaceInstanceId, "Stopping active work and saving supported objects…"));
      try { requireSucceeded(await owner.stopForQuit(target, discard.has(target.workspaceInstanceId))); }
      catch (e) { setProgress(previous => new Map(previous).set(target.workspaceInstanceId, message(e))); throw e; }
      setProgress(previous => new Map(previous).set(target.workspaceInstanceId, "Stopped · termination confirmed"));
    }
    await syncDrafts(); await session.quitWorkbench(); setFinished(true);
  });
  return <Modal title={finished ? "Workbench stopped" : "Quit Workbench?"} description={`${reviewed.length} local R sessions were open in this project when you opened this panel.`} onClose={onClose}><div className="runtime-form">
    {reviewed.map(({ name, target }) => { const value = owner.getInstance(target.workspaceInstanceId), protection = value?.protection; return <div className="runtime-notice" key={target.workspaceInstanceId}><strong>{name} · {value?.state === "stopped" ? "Stopped" : value?.state === "ready" ? "Open" : "Needs attention"}</strong><p>{protection?.saved_objects ?? 0} objects protected · {protection?.skipped_objects ?? 0} need attention · {copyTime(protection?.saved_at_ms)}</p>{progress.get(target.workspaceInstanceId) && <p role="status">{progress.get(target.workspaceInstanceId)}</p>}{(!!protection?.skipped_objects || !protection?.capture_available || value?.policy.value.mode === "off") && !finished && <label className="checkbox"><input type="checkbox" checked={discard.has(target.workspaceInstanceId)} onChange={event => setDiscard(previous => { const next = new Set(previous); event.target.checked ? next.add(target.workspaceInstanceId) : next.delete(target.workspaceInstanceId); return next; })} />Accept loss of unprotected objects; keep the saved copy</label>}<button className="runtime-link" disabled={action.busy} onClick={() => navigation.openSessions(target.workspaceInstanceId, "runs")}>View run →</button></div>; })}
    <p>Stopping sessions interrupts active work and cancels waiting runs. Rho saves supported objects before each process stops.</p><p className="muted">Closing a window only disconnects that view. You can leave R running in the background.</p>
    {action.error && <p role="alert" className="error">{action.error}</p>}{finished ? <p role="status">Local sessions ended and Workbench accepted shutdown. You can close this window.</p> : <div className="runtime-actions"><button onClick={onClose}>Keep running in background</button><button className="primary" disabled={action.busy || !session.connected} onClick={() => void quit()}>{action.busy ? "Stopping sessions…" : "Stop sessions and quit"}</button><button onClick={onClose}>Cancel</button></div>}
  </div></Modal>;
}
