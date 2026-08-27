import type { AgentConversationSummary } from "../../transport";

import type { AgentSurfaceVm } from "./useAgentSurface";

export function AgentDegradedBanner({ vm }: { readonly vm: AgentSurfaceVm }) {
  const { health, busy, retryRuntime, copyDiagnostics, diagnosticsText } = vm;
  if (health?.state === "ready") return null;
  return (
    <div className="rho-agent-degraded" role="status">
      <div className="rho-agent-degraded-row">
        <div>
          <strong>{health?.label ?? "Agent runtime unavailable"}</strong>
          {health?.detail != null && <p>{health.detail}</p>}
        </div>
        <button type="button" disabled={busy} onClick={retryRuntime}>Retry Agent runtime</button>
      </div>
      <details className="rho-agent-runtime-diagnostics">
        <summary>Dependency details</summary>
        <pre>{diagnosticsText}</pre>
        <button type="button" onClick={copyDiagnostics}>Copy diagnostics</button>
      </details>
    </div>
  );
}

function ContextCapacityForm({ vm }: { readonly vm: AgentSurfaceVm }) {
  const {
    llmSettings, capacityBusy, capacityModelId, capacityDraft, setCapacityDraft,
    selectCapacityModel, loadContextCapacity, saveContextCapacity,
  } = vm;
  return (
    <form className="rho-agent-capacity" aria-label="Agent model context capacity" onSubmit={(event) => {
      event.preventDefault();
      void saveContextCapacity();
    }}>
      {llmSettings == null ? <span>{capacityBusy ? "Loading model capacity…" : "Model capacity is unavailable."}</span> : <>
        <label>Model
          <select value={capacityModelId} disabled={capacityBusy} onChange={(event) => selectCapacityModel(event.target.value)}>
            {llmSettings.models.map((model) => <option value={model.id} key={model.id}>{model.display_name}</option>)}
          </select>
        </label>
        <label>Context window
          <input aria-label="Context window tokens" type="number" min="4096" step="1" disabled={capacityBusy} value={capacityDraft.context} onChange={(event) => setCapacityDraft({ ...capacityDraft, context: event.target.value })} />
        </label>
        <label>Reserve for reply
          <input aria-label="Reserved output tokens" type="number" min="256" step="1" disabled={capacityBusy} value={capacityDraft.reserve} onChange={(event) => setCapacityDraft({ ...capacityDraft, reserve: event.target.value })} />
        </label>
        <div>
          <small>{llmSettings.models.find((model) => model.id === capacityModelId)?.context_capacity_source.replaceAll("_", " ")}</small>
          <small>{(() => {
            const model = llmSettings.models.find((item) => item.id === capacityModelId);
            const provider = model == null ? null : llmSettings.providers.find((item) => item.id === model.provider_id);
            if (provider == null) return null;
            const source = provider.credential_source.replaceAll("_", " ");
            const status = provider.credential_status.replaceAll("_", " ");
            return `credential: ${status} · source: ${source}`;
          })()}</small>
          <button type="button" disabled={capacityBusy} onClick={() => void loadContextCapacity()}>Reload</button>
          <button type="submit" className="rho-primary-action" disabled={capacityBusy || !capacityModelId}>{capacityBusy ? "Saving…" : "Save"}</button>
        </div>
      </>}
    </form>
  );
}

export function AgentToolbar({ vm, conversations }: {
  readonly vm: AgentSurfaceVm;
  readonly conversations: readonly AgentConversationSummary[];
}) {
  const { instance, view, busy, selectConversation, newConversation, capacityOpen, toggleCapacity, reportError } = vm;
  return (
    <>
      <header className="rho-agent-toolbar">
        <select
          aria-label={`Conversation for ${instance.instance_id}`}
          value={view.conversation_id ?? ""}
          disabled={busy}
          onChange={(event) => void selectConversation(event.target.value).catch(reportError)}
        >
          <option value="">No conversation</option>
          {conversations.map((conversation) => (
            <option value={conversation.conversation_id} key={conversation.conversation_id}>
              {conversation.title} · {conversation.turn_count}
            </option>
          ))}
        </select>
        <button type="button" className="rho-agent-toolbar-action" disabled={busy} onClick={() => void newConversation()}>New</button>
        <button type="button" className="rho-agent-toolbar-action" aria-expanded={capacityOpen} disabled={busy} onClick={toggleCapacity}>Context</button>
      </header>
      {capacityOpen && <ContextCapacityForm vm={vm} />}
    </>
  );
}
