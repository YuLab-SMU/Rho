import type { AgentTurnDetail } from "../../transport";

type ActivityEvent = AgentTurnDetail["events"][number];
type ContextItem = AgentTurnDetail["context_items"][number];

// Only these dispositions put source bytes in front of the model. The rest
// contributed nothing, so they are named but never priced.
const CONTRIBUTING_DISPOSITIONS: ReadonlySet<string> = new Set(["complete", "projected", "truncated"]);

export function AgentActivity({ events, contextItems }: {
  readonly events: readonly ActivityEvent[];
  readonly contextItems: readonly ContextItem[];
}) {
  const contributing = contextItems.filter((item) => CONTRIBUTING_DISPOSITIONS.has(item.disposition));
  const withheld = contextItems.filter((item) => !CONTRIBUTING_DISPOSITIONS.has(item.disposition));
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
      <summary>Context used · {contributing.length} of {contextItems.length} {contextItems.length === 1 ? "source" : "sources"}</summary>
      <ol>
        {contributing.map((item) => <li key={item.ordinal + ":" + item.source_kind + ":" + (item.source_id ?? "current")}>
          <div><strong>{item.source_kind.replaceAll("_", " ")}</strong><span>{item.disposition}</span></div>
          {item.source_id != null && <code>{item.source_id}</code>}
          <small>{item.included_bytes.toLocaleString()} of {item.original_bytes.toLocaleString()} bytes · {item.trust_class}</small>
        </li>)}
        {withheld.map((item) => <li
          className="rho-agent-context-withheld"
          key={item.ordinal + ":" + item.source_kind + ":" + (item.source_id ?? "current")}
        >
          <div><strong>{item.source_kind.replaceAll("_", " ")}</strong><span>{item.disposition}</span></div>
        </li>)}
      </ol>
    </details>}
  </section>;
}
