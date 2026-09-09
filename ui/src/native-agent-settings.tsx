import { useEffect, useRef, useState } from "react";
import { useNativeAgents, useSession } from "./context";
import { Icon } from "./icons";
import type { AgentProvider } from "./generated/AgentProvider";
import type { AgentClientSession } from "./generated/AgentClientSession";

const providers: Record<AgentProvider, { name: string; source: string; mark: string }> = {
  codex: { name: "Codex", source: "OpenAI · Local CLI", mark: "" },
  kimi: { name: "Kimi CLI", source: "Moonshot · Local CLI", mark: "K" },
  deepseek: { name: "DeepSeek Harness", source: "DeepSeek · Local CLI", mark: "D" },
};
const busy = (s?: AgentClientSession) => !!s && ["running", "waiting_for_permission", "uncertain"].includes(s.state);
const sessionLabels: Record<string, string> = { running: "Agent working", waiting_for_permission: "Your Agent is waiting for permission", uncertain: "Outcome not confirmed", failed: "Agent reported an error", interrupted: "Agent stopped", disconnected: "Agent disconnected" };
function Conversation({ session }: { session: AgentClientSession }) {
  const native = useNativeAgents(), [text, setText] = useState(""), [sending, setSending] = useState(false);
  const transcript = useRef<HTMLDivElement>(null), follow = useRef(true);
  const pending = useRef<{text:string;id:string} | null>(null);
  const disconnected = session.state === "disconnected";
  useEffect(() => {
    if (pending.current?.id === session.last_request_id) {
      if (text === pending.current.text) setText("");
      pending.current = null;
    }
  }, [session.last_request_id, text]);
  useEffect(() => { if (follow.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; }, [session.messages]);
  async function send() {
    if (!text.trim() || sending) return; setSending(true);
    if (!pending.current || pending.current.text !== text) pending.current = {text,id:crypto.randomUUID()};
    try { if (await native.act(session.id, { kind: "prompt", text, request_id: pending.current.id })) { setText(""); pending.current=null; } }
    finally { setSending(false); }
  }
  return <section className="native-conversation" aria-label={`${session.provider} session`}>
    <div className="agent-list-heading"><span role="status">{sessionLabels[session.state] ?? "Session ready"}</span>{!disconnected && <button className="agent-link" disabled={busy(session) && session.state !== "uncertain"} onClick={() => void native.act(session.id, { kind: "disconnect" })}>Disconnect</button>}</div>
    {session.error && <p role="alert" className="native-error">{session.error}</p>}
    {session.state === "uncertain" && <p className="agent-caption">The Agent has not confirmed the outcome. Check its activity before sending the task again. Disconnecting does not cancel R work already submitted.</p>}
    {!!session.messages.length && <div ref={transcript} className="native-transcript" onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {session.messages.map((m, i) => <div className={`native-message ${m.role}`} key={i}><small>{m.role === "user" ? "You" : providers[session.provider].name}</small><pre>{m.text}</pre></div>)}
    </div>}
    {!!session.activity.length && <details className="native-activity"><summary>{session.activity.at(-1)}</summary>{session.activity.map((a, i) => <div key={i}>{a}</div>)}</details>}
    <details className="native-activity"><summary>Session details</summary><div>Native session: <code>{session.native_session_id}</code></div><div>Model: {session.model}</div></details>
    {session.decisions.map(decision => <div className="native-decision" key={decision.id}><strong>{decision.title}</strong>{decision.details && <pre>{decision.details}</pre>}<div className="agent-actions">{decision.options.map(o => <button className="agent-secondary" key={o.id} onClick={() => void native.act(session.id, { kind: "decision", id: decision.id, option: o.id })}>{o.label}</button>)}</div></div>)}
    {session.elapsed_ms !== null && <p className="agent-caption">{session.state === "uncertain" ? "Waited" : session.error ? "Ended" : session.state === "interrupted" ? "Stopped" : "Responded"} in {(session.elapsed_ms / 1000).toFixed(1)}s</p>}
    {session.truncated && <p className="agent-caption">Earlier content is omitted from this view. The native Agent owns the full conversation.</p>}
    <form onSubmit={event => { event.preventDefault(); void send(); }} className="native-composer"><label className="agent-label" htmlFor={`prompt-${session.id}`}>Ask about this workspace</label><textarea id={`prompt-${session.id}`} value={text} onChange={event => setText(event.target.value)} placeholder="Inspect the current data and explain the plot…" maxLength={32000} rows={3} disabled={disconnected || busy(session) || sending} /><div className="agent-actions"><button className="agent-primary" disabled={disconnected || !text.trim() || busy(session) || sending}>Send</button>{busy(session) && <button type="button" className="agent-secondary" onClick={() => void native.act(session.id, { kind: "interrupt" })}>Stop Agent</button>}<small className="agent-action-note">{disconnected ? "Reconnect above to start a new session" : "Connected to this project and Studio window"}</small></div></form>
  </section>;
}

function NativeCard({ provider }: { provider: AgentProvider }) {
  const native = useNativeAgents(), session = useSession(), state = native.getSnapshot(), catalog = state.catalog[provider];
  const [expanded, setExpanded] = useState(true), [effort, setEffort] = useState<string | null>(null);
  const [lastSessionId, setLastSessionId] = useState<string | null>(null);
  const model = catalog?.selected_model ?? "", selected = catalog?.models.find(m => m.id === model);
  useEffect(() => { setEffort(selected?.efforts.includes(catalog?.selected_effort ?? "") ? catalog!.selected_effort : selected?.default_effort ?? null); }, [catalog, selected]);
  const connected = [...state.sessions].reverse().find(s => s.provider === provider && s.state !== "disconnected");
  useEffect(() => { if (connected) setLastSessionId(connected.id); }, [connected?.id]);
  const displayed = connected ?? state.sessions.find(s => s.id === lastSessionId) ?? [...state.sessions].reverse().find(s => s.provider === provider);
  const { name, source, mark } = providers[provider];
  const waiting = !!state.loading[provider] || state.connecting === provider;
  const disabled = waiting || !!state.connecting || !!catalog?.setup_required || !model || !!catalog?.error || !session.ready || busy(connected);
  return <article className={`agent-card${expanded ? " selected" : ""}`} aria-label={`${name} connection`}>
    <div className="agent-row native-provider-row"><button className="native-provider-title" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><span className={`agent-mark ${provider}-mark`}>{provider === "codex" ? <Icon name="terminal" size={25} /> : mark}</span><span className="agent-name"><strong>{name}</strong><small>{source}{catalog?.version ? ` · ${catalog.version}` : ""}</small></span></button><button className="agent-secondary pill" disabled={disabled} onClick={() => void native.connect(provider, model, effort, true)}>Test</button></div>
    {expanded && <div className="agent-options">
      {waiting && <p role="status" className="agent-caption">{state.installing === provider ? "Installing the connection component…" : state.connecting === provider ? "Connecting the Agent to this workspace…" : "Reading models from the installed CLI…"}</p>}
      {catalog?.setup_required ? <div className="native-setup">
        <p className="agent-caption">Adds an isolated DeepSeek ACP runtime for Rho. Keeps your existing dsh installation and settings.</p>
        <div className="agent-actions"><button className="agent-primary" disabled={waiting || !!state.installing || !!state.connecting} onClick={() => void native.setup(provider)}>Install connection component</button></div>
      </div> : catalog?.error ? <p role="alert" className="native-error">{catalog.error}</p> : <>
        <label className="native-model-field"><span className="agent-label">Model <span className="native-source">From your CLI</span></span><select aria-label={`${name} model`} value={model} disabled={waiting || busy(connected)} onChange={event => void native.discover(provider, event.target.value)}>{!catalog && <option value="">{waiting ? "Loading…" : "Use Rescan to retry"}</option>}{catalog?.models.map(m => <option key={m.id} value={m.id}>{m.name}{provider !== "deepseek" && m.name.toLowerCase() !== m.id.toLowerCase() ? ` (${m.id})` : ""}</option>)}</select></label>
        {!!selected?.efforts.length && <label className="native-model-field"><span className="agent-label">Reasoning effort</span><select aria-label={`${name} reasoning effort`} value={effort ?? ""} disabled={waiting || busy(connected)} onChange={event => setEffort(event.target.value || null)}><option value="">CLI default</option>{selected.efforts.map(e => <option key={e} value={e}>{e}</option>)}</select></label>}
        <div className="agent-actions"><button className="agent-primary" disabled={disabled} onClick={() => void native.connect(provider, model, effort)}>{connected && connected.model === model && connected.effort === effort ? "Connected" : `Connect ${name}`}</button><small className="agent-action-note">Uses your existing login · No configuration copying</small></div>
      </>}
      {displayed && <Conversation key={displayed.id} session={displayed} />}
    </div>}
  </article>;
}

export function NativeAgentSettings() {
  const native = useNativeAgents(), session = useSession(), state = native.getSnapshot();
  useEffect(() => { native.show(); return () => native.hide(); }, [native]);
  return <div className="agent-list"><div className="agent-list-heading"><span>Installed agents</span><button className="agent-secondary pill" disabled={Object.values(state.loading).some(Boolean)} onClick={() => void native.rescan()}>Rescan</button></div>
    {state.error && <p className="native-error" role="alert">{state.error}</p>}
    {!session.project ? <p>Open a project to use a local Agent.</p> : (Object.keys(providers) as AgentProvider[]).map(provider => <NativeCard key={provider} provider={provider} />)}
  </div>;
}
