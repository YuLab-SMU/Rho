import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { useInstanceConsole, useInstanceObjects, useInstanceOperations, useInstanceSession, useLayout, useNavigation, usePreferences, useRuntimeSessions, useSession } from "./context";
import { copyTime, coverageReason, environmentLabel, rLabel, requireSucceeded, sessionState } from "./runtime-presentation";
import { message } from "./shared/ports";
import { formatBytes } from "./panels/shell-panels";
import { LifecycleDialog, NewSessionDialog, RenameSessionDialog, RestoreSessionDialog, SelectedCopyDialog } from "./runtime-dialogs";
import type { WorkspaceInstance } from "./generated/WorkspaceInstance";
import type { CheckpointEntry } from "./generated/CheckpointEntry";
import type { RuntimeTab } from "./navigation";
import "./runtime.css";
import { AskComponent } from "./panels/component-agent-panel";

export function RuntimeBadge({ instance }: { instance: WorkspaceInstance }) {
  const session = useInstanceSession(instance.workspace_instance_id), console = useInstanceConsole(instance.workspace_instance_id);
  const fresh = session.connected && !session.getSnapshot().runtimeError && !console.getSnapshot().error;
  return <span className={`runtime-badge ${!fresh || ["recovery_required", "failed"].includes(instance.state) ? "attention" : instance.state === "ready" ? "live" : ""}`}>{sessionState(instance, fresh ? console.consoleState : null, session.connected)}</span>;
}
export function RuntimeFact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="runtime-fact"><dt>{label}</dt><dd>{children}</dd></div>;
}

function SessionRow({ instance, selected, choose }: { instance: WorkspaceInstance; selected: boolean; choose(): void }) {
  return <button className="runtime-session-row" aria-current={selected ? "page" : undefined} onClick={choose}>
    <i className={`dot${instance.state === "ready" ? "" : " offline"}`} /><span><strong>{instance.name}</strong><small>{instance.installation ? `R ${instance.installation.r_version}` : "Version not observed"}</small></span><RuntimeBadge instance={instance} />
  </button>;
}

export function RuntimeSessionsPage({ open, onClose }: { open: boolean; onClose(): void }) {
  const owner = useRuntimeSessions(), session = useSession(), navigation = useNavigation(), state = owner.getSnapshot();
  const [selected, setSelected] = useState<string | null>(null), [tab, setTab] = useState<RuntimeTab>("overview"), [detail, setDetail] = useState(false), [creating, setCreating] = useState(false);
  const opener = useRef<HTMLElement | null>(null), scroll = useRef(new Map<string, number>());
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement as HTMLElement | null;
    setSelected(navigation.runtimePage.instanceId ?? owner.selectedId); setTab(navigation.runtimePage.tab);
    setDetail(!!navigation.runtimePage.instanceId);
    void owner.refreshInstances().catch(() => {});
  }, [open, owner, navigation]);
  const currentId = selected ?? state.defaultId, instance = currentId ? state.instances.get(currentId) : null;
  const choose = (id: string) => { setSelected(id); setDetail(true); navigation.runtimePage = { instanceId: id, tab }; };
  const chooseTab = (value: RuntimeTab) => { setTab(value); navigation.runtimePage = { instanceId: currentId, tab: value }; };
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) onClose(); }}><Dialog.Portal><Dialog.Content className={`runtime-page${detail ? " shows-detail" : ""}`} onCloseAutoFocus={event => { event.preventDefault(); if (opener.current?.isConnected) opener.current.focus(); }}>
    <header className="runtime-page-header"><AskComponent profile="environment" viewId={selected ?? undefined} /><Dialog.Title>R Sessions</Dialog.Title><Dialog.Description>{session.project?.split(/[\\/]/).at(-1) ?? "This project"}</Dialog.Description><div className="runtime-actions"><button disabled={!session.connected} onClick={() => setCreating(true)}>＋ New session…</button><Dialog.Close>Back to workspace</Dialog.Close></div></header>
    <div className="runtime-page-body"><nav className="runtime-session-list" aria-label="R sessions in this project"><div className="runtime-eyebrow">This project</div>
      {state.catalogIds.map(id => state.instances.get(id)).filter((value): value is WorkspaceInstance => !!value).map(value => <SessionRow key={value.workspace_instance_id} instance={value} selected={value.workspace_instance_id === currentId} choose={() => choose(value.workspace_instance_id)} />)}
      {state.next && <button disabled={state.loading.has("instances")} onClick={() => void owner.refreshInstances(true).catch(() => {})}>More sessions</button>}
      {state.stale && <p className="muted">Session observations are refreshing.</p>}{state.errors.get("instances") && <p role="alert">{state.errors.get("instances")}</p>}
    </nav>
    <main className="runtime-main"><button className="runtime-narrow-back" onClick={() => setDetail(false)}>‹ R Sessions</button>
      {instance ? <><div className="runtime-heading"><h2>{instance.name}</h2><RuntimeBadge instance={instance} /></div>
        <div role="tablist" aria-label="Session details" className="runtime-tabs" onKeyDown={event => {
          const tabs: RuntimeTab[] = ["overview", "runs", "copies", "details"];
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); const index = event.key === "Home" ? 0 : event.key === "End" ? 3 : (tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : 3)) % 4;
          chooseTab(tabs[index]!); event.currentTarget.querySelector<HTMLButtonElement>(`#runtime-tab-${tabs[index]}`)?.focus();
        }}>{([ ["overview", "Overview"], ["runs", "Runs"], ["copies", "Recovery copies"], ["details", "Details"] ] as const).map(([value, label]) => <button key={value} id={`runtime-tab-${value}`} role="tab" aria-selected={tab === value} aria-controls="runtime-tab-content" tabIndex={tab === value ? 0 : -1} onClick={() => chooseTab(value)}>{label}</button>)}</div>
        <SessionDetail key={`${instance.workspace_instance_id}:${tab}`} instance={instance} tab={tab} chooseTab={chooseTab} scroll={scroll.current} />
      </> : <div className="runtime-empty"><h2>No R session yet</h2><p>Create a session with an installed R to run code. Your files and drafts remain available.</p><button className="primary" onClick={() => setCreating(true)}>New R session</button></div>}
    </main></div>
    {creating && <NewSessionDialog onClose={() => setCreating(false)} onCreated={id => { setCreating(false); choose(id); }} />}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

function SessionDetail({ instance, tab, chooseTab, scroll }: { instance: WorkspaceInstance; tab: RuntimeTab; chooseTab(tab: RuntimeTab): void; scroll: Map<string, number> }) {
  const id = instance.workspace_instance_id, owner = useRuntimeSessions(), session = useInstanceSession(id), navigation = useNavigation(), objects = useInstanceObjects(id), layout = useLayout();
  const [error, setError] = useState(""), [action, setAction] = useState<"restart" | "stop" | "rename" | null>(null);
  const body = useRef<HTMLDivElement>(null), key = `${id}:${tab}`;
  useEffect(() => { if (body.current) body.current.scrollTop = scroll.get(key) ?? 0; }, [key, scroll]);
  const state = owner.getSnapshot(), busy = state.commands.has(id);
  const execute = async (run: () => Promise<unknown>) => { setError(""); try { await run(); } catch (e) { setError(message(e)); } };
  const save = () => execute(async () => { requireSucceeded(await owner.captureCheckpoint(owner.captureTarget(id))); await owner.refreshCheckpoints(id); await owner.refreshSettings(id); });
  const show = (component: "console" | "objects") => {
    const view = `${component}:runtime:${id}`;
    owner.pinView(view, id); navigation.showPanel(component, view, `${component === "console" ? "Console" : "Objects"} · ${instance.name}`, { workspaceInstanceId: id }); navigation.setDialog(null);
  };
  return <div ref={body} className="runtime-detail-scroll" role="tabpanel" id="runtime-tab-content" aria-labelledby={`runtime-tab-${tab}`} onScroll={event => scroll.set(key, event.currentTarget.scrollTop)}>
    <RecoveryState instance={instance} review={() => chooseTab("copies")} openConsole={() => show("console")} />
    {error && <p role="alert" className="error">{error}</p>}
    {tab === "overview" && <>
      <dl className="runtime-facts"><RuntimeFact label="R installation">{rLabel(instance)}</RuntimeFact><RuntimeFact label="Dependency environment">{environmentLabel(instance)}</RuntimeFact><RuntimeFact label="Objects">{objects.data ? `${objects.data.total_bindings} objects · ` : ""}<button className="runtime-link" onClick={() => show("objects")}>Open Objects →</button></RuntimeFact></dl>
      <div className="runtime-copy-summary"><div><strong>Recovery copy · {instance.protection.latest_checkpoint_id ? copyTime(instance.protection.saved_at_ms) : "No copy yet"}</strong><p>{instance.protection.saved_objects != null ? `${instance.protection.saved_objects} object${instance.protection.saved_objects === 1 ? "" : "s"} saved · ${instance.protection.skipped_objects ?? 0} ${instance.protection.skipped_objects === 1 ? "needs" : "need"} attention` : "No saved object coverage available."}</p>{instance.protection.activity_since_copy && <p>R has been active since the latest copy.</p>}</div><button className="runtime-link" onClick={() => chooseTab("copies")}>Review coverage →</button></div>
      {!instance.protection.capture_available && <p className="runtime-notice">Recovery capture is unavailable for this R installation. Existing copies remain available.</p>}
      {instance.protection.last_error && <p className="runtime-notice">{instance.protection.last_error}</p>}
      <div className="runtime-actions"><button className="primary" onClick={() => show("console")}>Open Console</button><button disabled={busy || !session.connected || instance.state !== "ready" || !instance.protection.capture_available} onClick={() => void save()}>Save recovery copy</button><button disabled={busy || instance.state !== "ready" || !session.connected} onClick={() => setAction("restart")}>Restart R…</button>
        <Menu.Root><Menu.Trigger>More ▾</Menu.Trigger><Menu.Portal><Menu.Content className="menu" sideOffset={6}><Menu.Item onSelect={() => setAction("rename")}>Rename</Menu.Item><Menu.Item disabled={instance.state !== "ready"} onSelect={() => setAction("stop")}>Stop session…</Menu.Item><Menu.Item onSelect={() => { navigation.runtimePage = { instanceId: id, tab }; navigation.setDialog("runtime-settings"); }}>Session settings</Menu.Item></Menu.Content></Menu.Portal></Menu.Root>
      </div><p className="muted">Changing R or the dependency environment creates a new session.</p>
      {state.selectedId !== id && <button disabled={busy || instance.state !== "ready"} onClick={() => owner.select(id)}>Use as execution target</button>}
      <section className="runtime-view-bindings"><h3>Views follow {owner.selected?.name ?? "the execution target"}</h3>{Object.entries(layout.getSnapshot().knownViews).filter(([, view]) => ["console", "objects", "packages"].includes(view.component)).map(([viewId, view]) => { const pinned = state.viewTargets.get(viewId); return <div className="runtime-storage-row" key={viewId}><span>{view.name} · {pinned ? `Pinned to ${owner.getInstance(pinned)?.name ?? "unavailable session"}` : "Follows execution target"}</span><button onClick={() => owner.pinView(viewId, pinned ? null : id)}>{pinned ? "Unpin" : `Pin to ${instance.name}`}</button></div>; })}</section>
    </>}
    {tab === "runs" && <SessionRuns instance={instance} openConsole={() => show("console")} />}
    {tab === "copies" && <RecoveryCopies instance={instance} save={save} />}
    {tab === "details" && <><dl className="runtime-facts"><RuntimeFact label="R executable"><code>{instance.binding.r_executable}</code></RuntimeFact><RuntimeFact label="Ark executable"><code>{instance.binding.ark_executable}</code></RuntimeFact><RuntimeFact label="Library path"><code>{instance.binding.library_path ?? "R installation default"}</code></RuntimeFact><RuntimeFact label="Environment receipt"><code>{instance.binding.environment_realization_id ?? "No managed environment"}</code></RuntimeFact><RuntimeFact label="Session identity"><code>{id}</code></RuntimeFact><RuntimeFact label="Native process session"><code>{instance.native_session_id ?? "None observed"}</code></RuntimeFact><RuntimeFact label="Continuation lineage"><code>{instance.continuation_lineage_id}</code></RuntimeFact></dl>{instance.blockers.map(blocker => <p key={`${blocker.kind}:${blocker.reference}`}>{blocker.label}</p>)}{instance.last_error && <p role="alert">{instance.last_error}</p>}</>}
    {action === "rename" && <RenameSessionDialog instance={instance} onClose={() => setAction(null)} />}
    {(action === "restart" || action === "stop") && <LifecycleDialog instance={instance} action={action} onClose={() => setAction(null)} review={() => { setAction(null); chooseTab("copies"); }} />}
  </div>;
}

function SessionRuns({ instance, openConsole }: { instance: WorkspaceInstance; openConsole(): void }) {
  const id = instance.workspace_instance_id, console = useInstanceConsole(id), operations = useInstanceOperations(id), session = useInstanceSession(id);
  const state = console.getSnapshot(), queue = state.state, [error, setError] = useState(""), [selected, setSelected] = useState<string | null>(null);
  const currentId = selected ?? queue?.current?.operation_id ?? null, record = currentId ? operations.records.get(currentId) : null;
  useEffect(() => { if (currentId) void operations.ensureOperation(currentId).catch(e => setError(message(e))); }, [currentId, operations]);
  const run = async (work: () => Promise<unknown>) => { try { await work(); } catch (e) { setError(message(e)); } };
  const args = record?.operation.normalized_arguments, code = args && typeof args === "object" && !Array.isArray(args) && typeof args.code === "string" ? args.code : null;
  const fresh = session.connected && !state.error && queue?.session_id === instance.native_session_id;
  const rows = [queue?.current, ...queue?.pending ?? []].filter((value): value is NonNullable<typeof value> => !!value);
  return <><div className="runtime-section-heading"><h3>{instance.name} · Runs</h3><span>{fresh ? "" : "Last observed · "}{queue?.pending.length ?? 0} waiting{queue?.pause ? " · Queue paused" : ""}</span>{queue?.pause && <button disabled={!fresh} onClick={() => void run(() => console.queueControl(false))}>Resume queue</button>}</div>
    {(error || state.error) && <p role="alert" className="error">{error || state.error}</p>}
    <div className="runtime-runs"><div className="runtime-run-list">{rows.map(row => <button key={row.operation_id} aria-current={currentId === row.operation_id ? "true" : undefined} onClick={() => setSelected(row.operation_id)}><strong>{row.source?.label ?? row.summary}</strong><small>{row.operation_id === queue?.current?.operation_id ? queue.input ? "Input needed" : "Running" : queue?.pause ? "Waiting · Queue paused" : "Waiting"}</small></button>)}{!rows.length && <p>{fresh ? "No current or waiting runs." : "No live queue observation."}</p>}</div><div className="runtime-run-detail"><h3>{currentId === queue?.current?.operation_id ? "Current run" : "Run details"}</h3>{record ? <><p>{record.status} · {instance.name} · {copyTime(record.operation.accepted_at_ms)}</p>{code && <pre>{code}</pre>}<details><summary>Captured code &amp; details</summary><pre>{JSON.stringify(record.operation, null, 2)}</pre></details></> : <p>Select a recorded run to inspect its captured input.</p>}<div className="runtime-actions"><button className="primary" onClick={openConsole}>Open Console</button>{queue?.current && <button disabled={!fresh} onClick={() => void run(() => operations.cancel(queue.current!.operation_id))}>Interrupt this run</button>}</div></div></div>
    <details><summary>Recorded runs in this session</summary>{[...operations.records.values()].filter(record => record.operation.capability.id === "workspace.run_r").slice(-50).reverse().map(record => <button className="runtime-history-row" key={record.operation.operation_id} onClick={() => setSelected(record.operation.operation_id)}>{copyTime(record.operation.accepted_at_ms)} · {record.status}</button>)}</details>
  </>;
}

function RecoveryCopies({ instance, save }: { instance: WorkspaceInstance; save(): Promise<void> }) {
  const owner = useRuntimeSessions(), navigation = useNavigation(), id = instance.workspace_instance_id, operations = useInstanceOperations(id), state = owner.getSnapshot(), catalog = owner.recoveryFor(id);
  const [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState(false), [restore, setRestore] = useState<CheckpointEntry | null>(null), [selection, setSelection] = useState(false), [storage, setStorage] = useState(false), [error, setError] = useState("");
  useEffect(() => { void owner.refreshCheckpoints(id).catch(() => {}); void owner.refreshSettings(id).catch(() => {}); }, [owner, id]);
  const copy = catalog?.entries.find(entry => entry.manifest.checkpoint_id === selected) ?? catalog?.entries[0];
  const fullCopyId = copy && !copy.details_complete ? copy.manifest.checkpoint_id : null;
  useEffect(() => { if (fullCopyId) void operations.ensureOperation(fullCopyId).catch(e => setError(message(e))); }, [operations, fullCopyId]);
  const full = fullCopyId ? operations.getRecord(fullCopyId)?.output as unknown as CheckpointEntry["manifest"] | null : null;
  const manifest = full?.checkpoint_id === copy?.manifest.checkpoint_id && full?.workspace_instance_id === id ? full : copy?.manifest, report = manifest?.report;
  const completeDetails = copy?.details_complete || (!!full && manifest === full);
  const run = async (work: () => Promise<unknown>) => { setError(""); try { await work(); await owner.refreshCheckpoints(id); await owner.refreshSettings(id); } catch (e) { setError(message(e)); } };
  const busy = state.commands.has(id), totalBytes = catalog?.entries.reduce((sum, entry) => sum + (entry.available ? entry.manifest.byte_size : 0), 0) ?? 0;
  return <><div className="runtime-section-heading"><h3>{instance.name} · Recovery copies</h3><div className="runtime-actions"><button className="primary" disabled={busy || instance.state !== "ready" || !instance.protection.capture_available} onClick={() => void save()}>Save recovery copy</button><button onClick={() => { navigation.runtimePage = { instanceId: id, tab: "copies" }; navigation.setDialog("runtime-settings"); }}>Settings</button></div></div>
    {(error || state.errors.get(`checkpoints:${id}`)) && <p className="error" role="alert">{error || state.errors.get(`checkpoints:${id}`)}</p>}
    {catalog?.stale && <p className="muted">Showing the last observed recovery copies.</p>}{catalog?.notice && <p className="runtime-notice">{catalog.notice}</p>}
    <div className={`runtime-copies${detail ? " shows-copy" : ""}`}><div className="runtime-copy-list"><div className="runtime-eyebrow">Recent copies</div>{catalog?.entries.map(entry => <button key={entry.manifest.checkpoint_id} aria-current={entry === copy ? "true" : undefined} onClick={() => { setSelected(entry.manifest.checkpoint_id); setDetail(true); }}><strong>{copyTime(entry.manifest.created_at_ms)}</strong><span>{entry.saved_count} of {entry.saved_count + entry.skipped_count} objects · {formatBytes(entry.manifest.byte_size)}</span><small>{entry.manifest.automatic ? "Automatic" : "Manual"}{entry.pinned ? " · Pinned" : ""}{entry.available && entry.manifest.checkpoint_id === instance.protection.latest_checkpoint_id ? " · Latest" : ""}{!entry.available ? " · Unavailable" : ""}</small></button>)}{catalog?.next && <button disabled={state.loading.has(`checkpoints:${id}`)} onClick={() => void owner.refreshCheckpoints(id, true).catch(() => {})}>Older copies</button>}{catalog && !catalog.entries.length && <p>No recovery copies yet.</p>}</div>
    <div className="runtime-copy-detail"><button className="runtime-narrow-back" onClick={() => setDetail(false)}>‹ All copies</button>{copy && manifest && report ? <><div className="runtime-heading"><h3>{copyTime(manifest.created_at_ms)}</h3>{copy.available && manifest.checkpoint_id === instance.protection.latest_checkpoint_id && <span className="runtime-badge live">Latest</span>}</div><div className="runtime-copy-figures"><div><strong>{copy.saved_count} {copy.saved_count === 1 ? "object" : "objects"} saved</strong><span>{formatBytes(manifest.byte_size)} · {manifest.automatic ? "Automatic" : "Manual"}</span></div><div className={report.skipped.length ? "attention" : ""}><strong>{copy.skipped_count} not protected</strong><span>See object coverage below</span></div></div><dl><RuntimeFact label="Saved with">R {report.r_version} · {report.platform}</RuntimeFact><RuntimeFact label="Dependency environment">{manifest.runtime_binding?.environment_realization_id ? "Managed dependency environment" : "R installation libraries"}</RuntimeFact></dl>
      <h4>Object coverage</h4>{!completeDetails && <p role="status">Loading complete object coverage… The catalog shows a bounded preview.</p>}{report.skipped.length ? <div className="runtime-coverage">{report.skipped.map((item, index) => { const [reason, next] = coverageReason(item.reason); return <div key={`${item.name}:${index}`}><code>{item.name}</code><span>{reason}</span>{next === "Save selected objects…" ? <button className="runtime-link" disabled={instance.state !== "ready"} onClick={() => setSelection(true)}>{next}</button> : <small>{next}</small>}</div>; })}</div> : <p>All objects included in this capture were saved.</p>}
      <details><summary>Saved object names</summary><p className="runtime-object-names">{report.saved_names.join(", ") || "None"}</p></details><div className="runtime-copy-actions"><button className="primary" disabled={!copy.available || busy} onClick={() => setRestore({ ...copy, manifest })}>Restore in new session…</button><button disabled={!copy.available || busy} onClick={() => void run(async () => requireSucceeded(await owner.pinCheckpoint(id, manifest.checkpoint_id, !copy.pinned)))}>{copy.pinned ? "Unpin copy" : "Pin copy"}</button></div><p className="muted">Restoring creates a separate session. {instance.name} stays available.</p><details><summary>Technical details</summary><pre>{JSON.stringify(manifest, null, 2)}</pre></details>
    </> : <p className="runtime-empty">Select a recovery copy to review its coverage.</p>}</div></div>
    <div className="runtime-storage"><span>Project recovery storage: {formatBytes(owner.settingsFor(id)?.project_storage_bytes)} of {formatBytes(instance.policy.value.project_storage_limit_bytes)}. {instance.name}: {formatBytes(totalBytes)} · {catalog?.entries.length ?? 0} {catalog?.entries.length === 1 ? "copy" : "copies"}{catalog?.next ? " shown" : ""} · {catalog?.entries.filter(entry => entry.pinned).length ?? 0} pinned.</span><button onClick={() => setStorage(!storage)}>Manage storage…</button></div>
    {storage && <div className="runtime-notice"><p>Pinned copies and the last usable recovery source are protected. Deleting a copy removes that recovery point.</p>{catalog?.entries.map(entry => <div className="runtime-storage-row" key={entry.manifest.checkpoint_id}><span>{copyTime(entry.manifest.created_at_ms)}</span><button disabled={busy || entry.pinned || !entry.available || entry.manifest.checkpoint_id === instance.protection.latest_checkpoint_id} onClick={() => void run(async () => requireSucceeded(await owner.deleteCheckpoint(id, entry.manifest.checkpoint_id)))}>Delete copy</button></div>)}</div>}
    {restore && <RestoreSessionDialog instance={instance} copy={restore} onClose={() => setRestore(null)} />}{selection && <SelectedCopyDialog instance={instance} onClose={() => setSelection(false)} />}
  </>;
}

export function RecoveryState({ instance, review, openConsole }: { instance: WorkspaceInstance; review(): void; openConsole(): void }) {
  const id = instance.workspace_instance_id, owner = useRuntimeSessions(), session = useInstanceSession(id), console = useInstanceConsole(id), operations = useInstanceOperations(id), navigation = useNavigation();
  const [error, setError] = useState(""), [matchingCopy, setMatchingCopy] = useState<CheckpointEntry | null>(null);
  const act = async (work: () => Promise<unknown>) => { try { await work(); } catch (e) { setError(message(e)); } };
  const lifecycleId = instance.last_lifecycle_operation_id;
  useEffect(() => { if (lifecycleId) void operations.ensureOperation(lifecycleId).catch(() => {}); }, [operations, lifecycleId]);
  const lifecycle = lifecycleId ? operations.getRecord(lifecycleId) : null;
  const original = lifecycle?.output as unknown as WorkspaceInstance | null, args = lifecycle?.operation.normalized_arguments;
  const restoredNew = lifecycle?.operation.capability.id === "runtime.restore_instance";
  const sourceCopyId = restoredNew && args && typeof args === "object" && !Array.isArray(args) && typeof args.checkpoint_id === "string" ? args.checkpoint_id : original?.last_error?.startsWith("Restored ") ? original.protection?.latest_checkpoint_id : null;
  useEffect(() => { if (sourceCopyId) void operations.ensureOperation(sourceCopyId).catch(() => {}); }, [operations, sourceCopyId]);
  const sourceCopy = sourceCopyId ? operations.getRecord(sourceCopyId)?.output as unknown as CheckpointEntry["manifest"] | null : null;
  const partial = instance.state === "ready" && lifecycle?.status === "succeeded" && original?.native_session_id === instance.native_session_id && !!sourceCopy && (!!sourceCopy.report.skipped.length || !!original.last_error?.includes("Changes made after this recovery point"));
  return <>{!session.connected || (instance.state === "ready" && session.getSnapshot().runtimeError) ? <section className="runtime-notice" role="status"><h3>Connection lost · {instance.name}</h3><p>Last seen: {session.runtime?.state ?? "Unknown"} · {copyTime(session.runtime?.observed_at_ms)}</p><p>{console.consoleState?.current?.source?.label ?? ""}</p><p>R may still be running. New submissions are paused.</p><div className="runtime-actions"><button onClick={() => void act(async () => { await session.health(); await session.refreshRuntime(id); await owner.refreshInstance(id); })}>Check connection</button><button onClick={openConsole}>View last known run</button></div><p>Check the original request before submitting again.</p></section> : null}
    {instance.state === "starting" && <section className="runtime-notice" role="status"><h3>Opening {instance.name}</h3><p>Starting R and checking its recovery copy in the matching environment…</p><p>Files and drafts are ready to use. Other sessions remain available.</p>{instance.last_lifecycle_operation_id && <button onClick={() => void act(() => operations.cancel(instance.last_lifecycle_operation_id!))}>Cancel restore</button>}</section>}
    {["recovery_required", "failed"].includes(instance.state) && <section className="runtime-notice attention" role="status"><h3>Validation needs attention</h3><p>{instance.last_error ?? "R could not be continued."}</p><p>{rLabel(instance)} · {environmentLabel(instance)}</p><div className="runtime-actions"><button onClick={() => void act(async () => { await owner.refreshCheckpoints(id); const copy = owner.recoveryFor(id)?.entries.find(entry => entry.available); if (!copy) throw new Error("No available recovery copy was found for this session."); setMatchingCopy(copy); })}>Choose matching environment…</button><button disabled={owner.getSnapshot().commands.has(id)} onClick={() => void act(async () => requireSucceeded(await owner.continueInstance(id, true)))}>Start empty</button><button onClick={review}>Review recovery copies</button></div><p>Your recovery copy stays available. Nothing has been installed.</p></section>}
    {instance.state === "stopped" && <div className="runtime-notice"><p>{instance.name} is stopped. Opening it continues from its latest usable copy according to its recovery settings.</p><button disabled={owner.getSnapshot().commands.has(id)} onClick={() => void act(async () => requireSucceeded(await owner.continueInstance(id)))}>Open {instance.name}</button></div>}
    {partial && !owner.getSnapshot().dismissedRecoveryNotices.has(instance.native_session_id!) && <div className="runtime-notice" role="status"><p>{sourceCopy!.report.saved_names.length} {sourceCopy!.report.saved_names.length === 1 ? "object" : "objects"} restored from {copyTime(sourceCopy!.created_at_ms)}. {sourceCopy!.report.skipped.length > 0 && <>{sourceCopy!.report.skipped.length} {sourceCopy!.report.skipped.length === 1 ? "object wasn’t" : "objects weren’t"} restored.</>}</p>{original?.last_error?.includes("Changes made after this recovery point") && <p>Changes made after this recovery copy are not present in this session.</p>}<button onClick={() => sourceCopy!.workspace_instance_id === id ? review() : navigation.openSessions(sourceCopy!.workspace_instance_id, "copies")}>Review</button><button aria-label="Dismiss recovery notice" onClick={() => owner.dismissRecoveryNotice(instance.native_session_id!)}>×</button></div>}
    {matchingCopy && <RestoreSessionDialog instance={instance} copy={matchingCopy} onClose={() => setMatchingCopy(null)} />}
    {error && <p className="error" role="alert">{error}</p>}
  </>;
}

export function WorkspaceRecoveryNotices() {
  const owner = useRuntimeSessions(), navigation = useNavigation(), preferences = usePreferences(), session = useSession();
  const instance = owner.selected;
  const [firstCopy, setFirstCopy] = useState(false), shown = useRef(false), hasCopy = !!instance?.protection.latest_checkpoint_id;
  useEffect(() => {
    if (hasCopy && !preferences.getSnapshot().recoveryNoticeSeen && !shown.current) {
      shown.current = true; setFirstCopy(true);
      void preferences.setPreferences({ recoveryNoticeSeen: true }).catch(error => session.reportError(message(error)));
    }
  }, [hasCopy, preferences, session]);
  return instance ? <div className="workspace-recovery-notices">{firstCopy && <div className="runtime-notice"><strong>Rho keeps recovery copies on this computer.</strong><p>Continue where you left off.</p><button onClick={() => navigation.setDialog("runtime-settings")}>Settings</button><button aria-label="Dismiss first recovery copy notice" onClick={() => setFirstCopy(false)}>×</button></div>}<RecoveryState instance={instance} review={() => navigation.openSessions(instance.workspace_instance_id, "copies")} openConsole={() => navigation.showPanel("console")} /></div> : null;
}
