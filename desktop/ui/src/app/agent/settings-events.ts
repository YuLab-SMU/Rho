export const AGENT_SETTINGS_CHANGED_EVENT = "rho:agent-settings-changed";

export type AgentSettingsChangeSource = "agent" | "settings";

export function announceAgentSettingsChanged(source: AgentSettingsChangeSource): void {
  window.dispatchEvent(new CustomEvent<AgentSettingsChangeSource>(
    AGENT_SETTINGS_CHANGED_EVENT,
    { detail: source },
  ));
}

export function subscribeAgentSettingsChanged(
  listener: (source: AgentSettingsChangeSource) => void,
): () => void {
  const receive = (event: Event) => listener(
    (event as CustomEvent<AgentSettingsChangeSource>).detail,
  );
  window.addEventListener(AGENT_SETTINGS_CHANGED_EVENT, receive);
  return () => window.removeEventListener(AGENT_SETTINGS_CHANGED_EVENT, receive);
}
