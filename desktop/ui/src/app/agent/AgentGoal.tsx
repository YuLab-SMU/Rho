export function AgentGoal({ prompt }: { readonly prompt: string }) {
  return <div className="rho-agent-goal">
    <span className="rho-agent-section-label">Goal</span>
    <p className="rho-agent-prompt">{prompt}</p>
  </div>;
}
