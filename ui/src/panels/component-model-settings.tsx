import { useEffect, useState } from "react";
import { useComponentAgents } from "../context";
import type { ComponentModelSettings } from "../generated/ComponentModelSettings";
import type { ComponentModelProtocol } from "../generated/ComponentModelProtocol";
import "../component-agent.css";

export function ComponentModelSettingsPanel() {
  const owner = useComponentAgents(), state = owner.getSnapshot();
  const [form, setForm] = useState<ComponentModelSettings | null>(null), [key, setKey] = useState(""), [busy, setBusy] = useState(false);
  const [source, setSource] = useState<"local_file" | "environment">("local_file"), [environment, setEnvironment] = useState("");
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    async function observe() { try { await owner.observeSettings(); } catch (error) { if (!disposed) owner.reportError(error); } if (!disposed) timer = setTimeout(observe, 2500); }
    void observe(); return () => { disposed = true; clearTimeout(timer); };
  }, [owner]);
  useEffect(() => {
    if (!state.settings) { setForm(null); setKey(""); setSource("local_file"); setEnvironment(""); return; }
    if (!form) {
      setForm(structuredClone(state.settings));
      const credential = state.settings.connection?.credential;
      setSource(credential?.kind === "environment" ? "environment" : "local_file");
      if (credential?.kind === "environment") setEnvironment(credential.name);
    }
  }, [form, state.settings]);
  const connection = form?.connection;
  function change(values: Partial<NonNullable<ComponentModelSettings["connection"]>>) {
    if (!form) return;
    setForm({ ...form, connection: { protocol: "anthropic", base_url: "", model: "", credential: { kind: "local_file", key_id: "" }, ...connection, ...values } });
  }
  async function save() {
    if (!form) return;
    setBusy(true); const secret = key;
    try {
      const next = structuredClone(form);
      if (next.connection && source === "environment") next.connection.credential = { kind: "environment", name: environment.trim() };
      if (next.enabled && source === "local_file" && !secret && next.connection?.credential.kind !== "local_file") throw new Error("Enter an API key to save on this computer.");
      await owner.configure(next, source === "local_file" ? secret : "");
      setKey("");
      setForm(structuredClone(owner.getSnapshot().settings));
    } catch (error) { owner.reportError(error); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setKey("");
    try { await owner.removeCredential(); }
    catch (error) { owner.reportError(error); }
    finally { setBusy(false); }
  }
  const savedSource = connection?.credential.kind === "environment" ? "environment" : "local_file";
  const dirty = JSON.stringify(form) !== JSON.stringify(state.settings) || !!key || source !== savedSource || (source === "environment" && connection?.credential.kind === "environment" && environment !== connection.credential.name);
  const available = state.credentialStatus?.available === true;
  const savedKey = source === "local_file" && connection?.credential.kind === "local_file" && available;
  return <section className="ca-settings" aria-label="Rho settings">
    <h2>Rho</h2><p>Choose the model service for Rho.</p>
    {state.error && <div role="alert" className="at-error">{state.error}<button onClick={() => owner.clearError()}>Dismiss</button></div>}
    {!form ? <p>Reading model settings…</p> : <fieldset disabled={busy}>
      <label className="ca-check"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />Enable Rho</label>
      <label>API format<select value={connection?.protocol ?? "anthropic"} onChange={e => change({ protocol: e.target.value as ComponentModelProtocol })}><option value="anthropic">Anthropic Messages</option><option value="openai_completions">OpenAI Chat Completions</option></select></label>
      <label>Base URL<input type="url" value={connection?.base_url ?? ""} placeholder="https://models.example.org" onChange={e => change({ base_url: e.target.value })} /></label>
      <small>Questions and selected context are sent to this service. Local HTTP services must use a loopback address.</small>
      <label>Model ID<input value={connection?.model ?? ""} onChange={e => change({ model: e.target.value })} /></label>
      {source === "local_file" ? <>
        <label>API key<input type="password" autoComplete="off" value={key} placeholder={savedKey ? "Enter a new key to replace" : "Enter API key"} onChange={e => setKey(e.target.value)} /></label>
        <small>{savedKey ? "•••••••• · Saved on this computer" : "Saved in your local Rho configuration when you select Save."}</small>
        {available && <button disabled={dirty} onClick={() => void remove()}>Remove API key</button>}
      </> : <><label>Environment variable name<input value={environment} placeholder="RHO_MODEL_API_KEY" onChange={e => setEnvironment(e.target.value)} /></label><small>{available ? "The environment variable is available." : "Set the variable in the environment that launches Rho."}</small></>}
      <details><summary>Credential source</summary><label>Source<select aria-label="Credential source" value={source} onChange={e => { setSource(e.target.value as typeof source); setKey(""); }}><option value="local_file">Saved API key</option><option value="environment">Environment variable</option></select></label></details>
      <div className="ca-actions"><button className="primary" onClick={() => void save()}>Save</button><button disabled={dirty || !state.settings?.enabled || !available} onClick={() => void owner.testModel("connection").catch(e => owner.reportError(e))}>Test connection</button><button disabled={dirty || !state.settings?.enabled || !available} onClick={() => void owner.testModel("images").catch(e => owner.reportError(e))}>Test image input</button></div>
      <small>Tests use sample content. Save changes before testing.</small>
    </fieldset>}
    {state.diagnostics.slice(0, 6).map(test => <div className="ca-diagnostic" key={test.request_id}><strong>{test.kind === "images" ? "Image input" : "Connection"} · {test.state}</strong><small>{test.model.model} · settings {test.model_settings_version}</small>{test.detail && <details><summary>Details</summary><p>{test.detail}</p></details>}{["queued", "running"].includes(test.state) && <button onClick={() => void owner.stopTest(test.request_id).catch(e => owner.reportError(e))}>Stop test</button>}</div>)}
  </section>;
}
