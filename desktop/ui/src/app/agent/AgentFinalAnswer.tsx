export function AgentFinalAnswer({ answer }: { readonly answer: string }) {
  return <section className="rho-agent-final-answer">
    <span className="rho-agent-section-label">Final Answer</span>
    <p className="rho-agent-answer">{answer}</p>
  </section>;
}
