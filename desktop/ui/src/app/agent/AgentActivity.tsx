import type { AgentTurnDetail } from "../../transport";

type ActivityEvent = AgentTurnDetail["events"][number];
type ContextItem = AgentTurnDetail["context_items"][number];

export function AgentActivity({ events, contextItems }: {
  readonly events: readonly ActivityEvent[];
  readonly contextItems: readonly ContextItem[];
}) {
  if (events.length === 0 && contextItems.length === 0) return null;
  return <section className="rho-agent-activity" aria-label="Activity">
    <span className="rho-agent-section-label">Activity</span>
    {events.map((event) => event.code != null ? (
      <details className="rho-agent-code-review" key={event.id}>
        <summary>{event.title}</summary><pre>{event.code}</pre>
      </details>
    ) : (
      <div className="rho-agent-activity-row" key={event.id}>{event.title}</div>
    ))}
    {contextItems.length > 0 && <details className="rho-agent-context-used">
      <summary>Context used · {contextItems.length} {contextItems.length === 1 ? "source" : "sources"}</summary>
      <ol>{contextItems.map((item) => <li key={item.ordinal + ":" + item.source_kind + ":" + (item.source_id ?? "current")}>
        <div><strong>{item.source_kind.replaceAll("_", " ")}</strong><span>{item.disposition}</span></div>
        {item.source_id != null && <code>{item.source_id}</code>}
        <small>{item.included_bytes.toLocaleString()} of {item.original_bytes.toLocaleString()} bytes · {item.trust_class}</small>
      </li>)}</ol>
    </details>}
  </section>;
}
