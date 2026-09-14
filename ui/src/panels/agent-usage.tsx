import type { AgentTaskEvent } from "../generated/AgentTaskEvent";

export function latestUsage(events: readonly AgentTaskEvent[]) {
  const latest = new Map<string, NonNullable<AgentTaskEvent["usage"]>>();
  for (const event of events) if (event.usage) latest.set(`${event.native_session_id}:${event.usage.source}:${event.usage.scope}`, event.usage);
  return [...latest.values()];
}
export function AgentUsage({ events }: { events: readonly AgentTaskEvent[] }) {
  const observations = latestUsage(events);
  return <div className="at-usage"><strong>Usage</strong>{!observations.length ? <p>Unknown · This Agent has not reported usage.</p> : observations.map((usage,i) => <section key={i}><small>{usage.source} · {usage.scope.replaceAll("_"," ")}</small>{usage.scope === "context_window" ? <dl><dt>Context used</dt><dd>{usage.context_used ?? "Unknown"}</dd><dt>Context capacity</dt><dd>{usage.context_capacity ?? "Unknown"}</dd></dl> : <dl>{([
    ["Input tokens",usage.input_tokens],["Output tokens",usage.output_tokens],["Cached input",usage.cached_input_tokens],["Cache writes",usage.cache_write_tokens],["Reasoning tokens",usage.reasoning_tokens],["Total tokens",usage.total_tokens],
  ] as const).map(([name,value]) => <div className="at-usage-row" key={name}><dt>{name}</dt><dd>{value ?? "Unknown"}</dd></div>)}</dl>}</section>)}</div>;
}
