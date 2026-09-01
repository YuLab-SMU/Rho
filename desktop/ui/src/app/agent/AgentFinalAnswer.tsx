import { AgentMarkdown } from "./AgentMarkdown";

export function AgentFinalAnswer({ answer }: { readonly answer: string }) {
  return <section className="rho-agent-final-answer">
    <span className="rho-agent-section-label">Final Answer</span>
    <AgentMarkdown className="rho-agent-answer" source={answer} />
  </section>;
}
