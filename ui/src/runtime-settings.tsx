import { useEffect, useState, type ReactNode } from "react";
import { useNavigation, useRuntimeSessions, useSession } from "./context";
import { runtimePolicySource } from "./runtime-sessions";
import { requireSucceeded } from "./runtime-presentation";
import { message } from "./shared/ports";
import type { RuntimeSettings } from "./generated/RuntimeSettings";
import type { RuntimeSettingsScope } from "./generated/RuntimeSettingsScope";
import type { RuntimePolicy } from "./generated/RuntimePolicy";
import type { RuntimePolicyOverrides } from "./generated/RuntimePolicyOverrides";
import "./runtime.css";

import { policyAtScope, runtimeSettingsScopes as scopes } from "./runtime-policy";

export function RuntimeSettingsControls() {
  const owner = useRuntimeSessions(), navigation = useNavigation(), session = useSession();
  const [scope, setScope] = useState<RuntimeSettingsScope>(navigation.runtimePage.instanceId ? "instance" : "project"), [id, setId] = useState(navigation.runtimePage.instanceId ?? owner.selectedId);
  const key = scope === "instance" ? id : null, state = owner.getSnapshot(), settings = owner.settingsFor(key);
  useEffect(() => { if (owner.supported) void owner.refreshSettings(key).catch(() => {}); }, [owner, key]);
  const label = id ? owner.getInstance(id)?.name : null;
  if (!owner.supported) return <p>This Host does not provide runtime recovery settings. Open the current Rho build to use this feature.</p>;
  return <div className="runtime-settings"><div className="runtime-scope" aria-label="Settings scope"><button aria-pressed={scope === "app"} onClick={() => setScope("app")}>App defaults</button><span>›</span><button aria-pressed={scope === "project"} onClick={() => setScope("project")}>Project · {session.project?.split(/[\\/]/).at(-1)}</button><span>›</span><button disabled={!id} aria-pressed={scope === "instance"} onClick={() => setScope("instance")}>Session · {label ?? "None"}</button></div>
    {scope === "instance" && <label>Session<select value={id ?? ""} onChange={event => setId(event.target.value)}>{state.catalogIds.map(value => <option key={value} value={value}>{owner.getInstance(value)?.name}</option>)}</select></label>}
    <p className="muted">Editing {scope === "instance" ? label : scope === "project" ? "this project" : "app defaults"}. Each setting inherits unless you override it.</p>
    {state.errors.get(`settings:${key ?? "project"}`) && <p role="alert">{state.errors.get(`settings:${key ?? "project"}`)}</p>}
    {settings?.defaults ? <SettingsForm key={`${scope}:${key}`} settings={settings} scope={scope} id={key} changeScope={setScope} /> : <p role="status">Loading recovery settings…</p>}
  </div>;
}

function SettingsForm({ settings, scope, id, changeScope }: { settings: RuntimeSettings; scope: RuntimeSettingsScope; id: string | null; changeScope(scope: RuntimeSettingsScope): void }) {
  const owner = useRuntimeSessions(), navigation = useNavigation(), [baseline, setBaseline] = useState(settings), [draft, setDraft] = useState<Partial<RuntimePolicyOverrides>>({}), [busy, setBusy] = useState(false), [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const policy = policyAtScope(baseline, scope, draft), value = policy.value;
  const edit = (field: keyof RuntimePolicyOverrides, value: unknown) => { setFeedback(""); setDraft(previous => ({ ...previous, [field]: value })); };
  const source = (field: keyof RuntimePolicy) => runtimePolicySource(policy, field);
  const field = (name: keyof RuntimePolicy, label: string, input: ReactNode, at?: RuntimeSettingsScope) => {
    const locked = at && scopes.indexOf(scope) > scopes.indexOf(at), origin = source(name);
    return <div className="runtime-setting-row" key={name}><label htmlFor={`recovery-${name}`}>{label}</label><div>{input}</div><span className="runtime-setting-source">{origin === "default" ? "App default" : origin === "instance" ? "Session override" : origin === "project" ? "Project setting" : "App setting"}{!locked && origin === scope && <button type="button" className="runtime-link" onClick={() => edit(name, null)}>Reset</button>}{locked && <button type="button" className="runtime-link" onClick={() => changeScope(at)}>Edit {at}</button>}</span></div>;
  };
  const numeric = (name: keyof RuntimePolicy, label: string, divisor = 1, at?: RuntimeSettingsScope, min = 1, max?: number) => field(name, label,
    <input id={`recovery-${name}`} type="number" min={min} max={max} step={1} disabled={busy || !!(at && scopes.indexOf(scope) > scopes.indexOf(at))} value={Number(value[name] ?? 0) / divisor} onChange={event => edit(name, Number(event.target.value) * divisor)} />, at);
  const names = (name: "include_names" | "exclude_names" | "include_patterns" | "exclude_patterns", label: string) => field(name, label,
    <textarea id={`recovery-${name}`} rows={3} placeholder="One per line" value={value[name].join("\n")} disabled={busy} onChange={event => edit(name, event.target.value.split("\n"))} />);
  const save = async () => {
    setBusy(true); setError(""); setFeedback("");
    try {
      const overrides = { ...baseline.effective[scope], ...draft };
      for (const field of ["include_names", "exclude_names", "include_patterns", "exclude_patterns"] as const) {
        if (overrides[field]) overrides[field] = overrides[field]!.filter(Boolean);
      }
      requireSucceeded(await owner.updateSettings(scope, id, overrides, baseline[`${scope}_version`]));
      const latest = owner.settingsFor(id); if (latest) setBaseline(latest); setDraft({}); setFeedback("Recovery settings saved.");
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return <form className="runtime-form" onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy}><legend>Recovery behavior</legend>
    {field("mode", "Recovery mode", <div className="runtime-radio-list">{([
      ["auto_continue", "Save and continue automatically", "Reconnect to a live session, or restore a copy in its matching environment."],
      ["save_start_empty", "Save recovery copies; start empty", "Keep recovery copies available for manual restoration."],
      ["manual", "Manual copies only", "Create copies when you choose Save recovery copy. New processes start empty."],
      ["off", "Off", "Do not create or automatically restore copies for this session."],
    ] as const).map(([mode, title, description]) => <label key={mode}><input type="radio" name="recovery-mode" value={mode} checked={value.mode === mode} onChange={() => edit("mode", mode)} /><span><strong>{title}</strong><small>{description}</small></span></label>)}</div>)}
  </fieldset><fieldset disabled={busy}><legend>Object selection</legend><p className="muted">Only supported object graphs are eligible. Excluded names take priority.</p>{field("object_selection", "Include", <select id="recovery-object_selection" value={value.object_selection} onChange={event => edit("object_selection", event.target.value)}><option value="all_eligible">All supported objects</option><option value="selected">Selected object names</option></select>)}{value.object_selection === "selected" && names("include_names", "Include object names")}{names("exclude_names", "Exclude object names")}<details><summary>Object name patterns</summary>{names("include_patterns", "Include patterns")}{names("exclude_patterns", "Exclude patterns")}</details></fieldset>
    <fieldset disabled={busy}><legend>Performance &amp; storage</legend><p>Foreground work first</p>{numeric("idle_delay_seconds", "Idle before automatic save (seconds)")}{numeric("automatic_interval_seconds", "Minimum interval (seconds)")}{numeric("automatic_payload_limit_bytes", "Maximum automatic payload (MiB)", 1024 ** 2)}{numeric("project_storage_limit_bytes", "Project recovery storage (GiB)", 1024 ** 3, "project")}<p className="muted">Pinned copies and the last usable recovery copy are kept. When space is full, automatic saving pauses.</p></fieldset>
    <details><summary>Advanced limits</summary>{numeric("capture_budget_ms", "Capture target (milliseconds)", 1, undefined, 1, 60000)}{numeric("global_storage_limit_bytes", "Global recovery storage (GiB)", 1024 ** 3, "app")}{numeric("minimum_free_bytes", "Keep free (GiB)", 1024 ** 3, "app", 0)}{numeric("recent_checkpoints", "Recent copies to keep", 1, undefined, 1, 100)}{numeric("daily_retention_days", "Daily retention (days)", 1, undefined, 0, 365)}{numeric("max_running_instances", "Maximum R processes", 1, "project", 1, 32)}{numeric("idle_stop_without_windows_seconds", "Idle release without windows (seconds; 0 = Off)", 1, undefined, 0)}<p className="muted">The capture target is cooperative; it cannot interrupt every object instantly. Idle release requires complete object protection.</p></details>
    <section className="runtime-notice"><h3>Recovery data on this computer</h3><p>Copies may contain sensitive values. Turning recovery off keeps existing copies.</p><button type="button" className="runtime-link" onClick={() => navigation.openSessions(id ?? owner.selectedId, "copies")}>Manage stored copies…</button></section>
    {error && <p role="alert" className="error">{error}</p>}{feedback && <p role="status">{feedback}</p>}<div className="runtime-actions runtime-settings-footer"><span className="muted">Changes apply to future saves and openings.</span><button type="button" onClick={() => { setDraft({}); setError(""); }}>Cancel</button><button className="primary" disabled={busy}>{busy ? "Saving…" : "Save settings"}</button></div>
  </form>;
}
