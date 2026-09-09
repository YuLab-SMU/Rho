import { useEffect, useState } from "react";
import { useNativeAgents, useSession } from "./context";
import { Icon } from "./icons";
import type { AgentProvider } from "./generated/AgentProvider";
const providers: Record<AgentProvider, { name: string; source: string; mark: string }> = {
  codex: { name: "Codex", source: "OpenAI · app-server", mark: "" },
  kimi: { name: "Kimi Code", source: "Kimi · ACP", mark: "K" },
  deepseek: { name: "DeepSeek Harness", source: "DeepSeek · ACP", mark: "D" },
};
function NativeCard({ provider }: { provider: AgentProvider }) {
  const native = useNativeAgents(), session = useSession(), state = native.getSnapshot(), catalog = state.catalog[provider];
  const [expanded, setExpanded] = useState(true), [effort, setEffort] = useState<string | null>(null);
  const model = catalog?.selected_model ?? "", selected = catalog?.models.find(m => m.id === model);
  const diagnostic = state.diagnostics[provider], waiting = !!state.loading[provider] || state.connecting === provider;
  const { name, source, mark } = providers[provider];
  useEffect(() => { setEffort(selected?.efforts.includes(catalog?.selected_effort ?? "") ? catalog!.selected_effort : selected?.default_effort ?? null); }, [catalog, selected]);
  const disabled = waiting || !!catalog?.setup_required || !!catalog?.error || !model || !session.ready;
  return <article className={`agent-card${expanded ? " selected" : ""}`} aria-label={`${name} connection`}>
    <div className="agent-row native-provider-row"><button className="native-provider-title" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><span className={`agent-mark ${provider}-mark`}>{provider === "codex" ? <Icon name="terminal" size={25} /> : mark}</span><span className="agent-name"><strong>{name}</strong><small>{source}{catalog?.version ? ` · ${catalog.version}` : ""}</small></span></button><button className="agent-secondary pill" disabled={disabled} onClick={() => void native.test(provider, model, effort)}>Test</button></div>
    {expanded && <div className="agent-options">
      {waiting && <p role="status" className="agent-caption">{state.installing === provider ? "Installing the connection component…" : state.connecting === provider ? "Testing an isolated session…" : "Reading native models…"}</p>}
      {catalog?.setup_required ? <div className="native-setup"><p className="agent-caption">An isolated ACP connection component is required.</p><button className="agent-primary" disabled={waiting || !!state.installing} onClick={() => void native.setup(provider)}>Install connection component</button></div> : catalog?.error ? <p role="alert" className="native-error">{catalog.error}</p> : <>
        <label className="native-model-field"><span className="agent-label">Model <span className="native-source">From your CLI</span></span><select aria-label={`${name} model`} value={model} disabled={waiting} onChange={event => void native.discover(provider, event.target.value)}>{!catalog && <option value="">{waiting ? "Loading…" : "Rescan to discover"}</option>}{catalog?.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        {!!selected?.efforts.length && <label className="native-model-field"><span className="agent-label">Reasoning effort</span><select aria-label={`${name} reasoning effort`} value={effort ?? ""} disabled={waiting} onChange={event => setEffort(event.target.value || null)}><option value="">CLI default</option>{selected.efforts.map(e => <option key={e} value={e}>{e}</option>)}</select></label>}
      </>}
      {diagnostic && <div className={`native-diagnostic ${diagnostic.state}`} role="status"><strong>{diagnostic.state === "succeeded" ? "Model responded" : diagnostic.state === "running" ? "Testing…" : "Test not completed"}</strong>{diagnostic.elapsed_ms !== null && <span> · {(diagnostic.elapsed_ms / 1000).toFixed(1)} s</span>}{diagnostic.response && <code> · {diagnostic.response}</code>}{diagnostic.error && <p className="native-error">{diagnostic.error}</p>}</div>}
    </div>}
  </article>;
}
export function NativeAgentSettings() {
  const native = useNativeAgents(), session = useSession(), state = native.getSnapshot();
  useEffect(() => { native.show(); return () => native.hide(); }, [native]);
  return <div className="agent-list"><div className="agent-list-heading"><span>Installed agents</span><button className="agent-secondary pill" disabled={Object.values(state.loading).some(Boolean)} onClick={() => void native.rescan()}>Rescan</button></div>
    {state.error && <p className="native-error" role="alert">{state.error}</p>}{!session.project ? <p>Open a project to use a local Agent.</p> : (Object.keys(providers) as AgentProvider[]).map(provider => <NativeCard key={provider} provider={provider} />)}
  </div>;
}
