import { useEffect, useState } from "react";
import { useComponentAgents } from "../context";
import type { ComponentModelSettings } from "../generated/ComponentModelSettings";
import type { ComponentModelProtocol } from "../generated/ComponentModelProtocol";
import "../component-agent.css";

export function ComponentModelSettingsPanel() {
  const owner = useComponentAgents(), state = owner.getSnapshot();
  const [form, setForm] = useState<ComponentModelSettings | null>(null), [key, setKey] = useState(""), [busy, setBusy] = useState(false);
  const [lifetime, setLifetime] = useState<"environment" | "session">("session"), [environment, setEnvironment] = useState("");
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    async function observe() { try { await owner.observeSettings(); } catch (error) { if (!disposed) owner.reportError(error); } if (!disposed) timer = setTimeout(observe, 2500); }
    void observe(); return () => { disposed = true; clearTimeout(timer); };
  }, [owner]);
  useEffect(() => {
    if (!state.settings) { setForm(null); setKey(""); return; }
    if (!form && state.settings) {
      setForm(structuredClone(state.settings));
      const credential = state.settings.connection?.credential;
      if (credential?.kind === "environment") { setLifetime("environment"); setEnvironment(credential.name); }
    }
  }, [form, state.settings]);
  const connection = form?.connection;
  function change(values: Partial<NonNullable<ComponentModelSettings["connection"]>>) {
    if (!form) return;
    setForm({ ...form, connection: { protocol: "anthropic", base_url: "", model: "", credential: { kind: "session", key_id: "" }, ...connection, ...values } });
  }
  async function save() {
    if (!form) return;
    setBusy(true); const secret = key; setKey("");
    try {
      const next = structuredClone(form);
      if (next.connection && lifetime === "environment") next.connection.credential = { kind: "environment", name: environment.trim() };
      if (next.enabled && lifetime === "session" && !secret && next.connection?.credential.kind !== "session") throw new Error("Enter a session key.");
      await owner.configure(next, lifetime === "session" ? secret : "");
      setForm(structuredClone(owner.getSnapshot().settings));
    } catch (error) { owner.reportError(error); }
    finally { setBusy(false); }
  }
  const dirty = JSON.stringify(form) !== JSON.stringify(state.settings) || !!key || lifetime !== connection?.credential.kind || (lifetime === "environment" && connection?.credential.kind === "environment" && environment !== connection.credential.name);
  return <section className="ca-settings" aria-label="Built-in assistant settings">
    <h2>Rho Assistant</h2><p>Use a remote or existing local model service for component questions.</p>
    {state.error && <div role="alert" className="at-error">{state.error}<button onClick={() => owner.clearError()}>Dismiss</button></div>}
    {!form ? <p>Reading model settings…</p> : <fieldset disabled={busy}>
      <label className="ca-check"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />Enable built-in assistant</label>
      <label>API format<select value={connection?.protocol ?? "anthropic"} onChange={e => change({ protocol: e.target.value as ComponentModelProtocol })}><option value="anthropic">Anthropic Messages</option><option value="openai_completions">OpenAI Chat Completions</option></select></label>
      <label>Base URL<input type="url" value={connection?.base_url ?? ""} placeholder="https://models.example.org" onChange={e => change({ base_url: e.target.value })} /></label>
      <small>Questions and selected context are sent to this service. Local HTTP services must use a loopback address.</small>
      <label>Model ID<input value={connection?.model ?? ""} onChange={e => change({ model: e.target.value })} /></label>
      <label>Credential lifetime<select value={lifetime} onChange={e => { setLifetime(e.target.value as typeof lifetime); setKey(""); }}><option value="session">Until this Rho Host quits</option><option value="environment">Host environment variable</option></select></label>
      {lifetime === "session" ? <label>API key<input type="password" autoComplete="off" value={key} placeholder={connection?.credential.kind === "session" && connection.credential.key_id ? "Enter a new key to replace" : "Enter API key"} onChange={e => setKey(e.target.value)} /></label> : <label>Environment variable name<input value={environment} placeholder="RHO_MODEL_API_KEY" onChange={e => setEnvironment(e.target.value)} /></label>}
      <small>{lifetime === "session" ? "The key is held in Host memory. Saved conversations contain only a reference." : "The variable must be set in the environment that launches the Host."}</small>
      <div className="ca-actions"><button className="primary" onClick={() => void save()}>Save</button><button disabled={dirty || !state.settings?.enabled} onClick={() => void owner.testModel("connection").catch(e => owner.reportError(e))}>Test connection</button><button disabled={dirty || !state.settings?.enabled} onClick={() => void owner.testModel("images").catch(e => owner.reportError(e))}>Test image input</button></div>
      <small>Tests use sample content. Save changes before testing.</small>
    </fieldset>}
    {state.diagnostics.slice(0, 6).map(test => <div className="ca-diagnostic" key={test.request_id}><strong>{test.kind === "images" ? "Image input" : "Connection"} · {test.state}</strong><small>{test.model.model} · settings {test.model_settings_version}</small>{test.detail && <details><summary>Details</summary><p>{test.detail}</p></details>}{["queued", "running"].includes(test.state) && <button onClick={() => void owner.stopTest(test.request_id).catch(e => owner.reportError(e))}>Stop test</button>}</div>)}
  </section>;
}
