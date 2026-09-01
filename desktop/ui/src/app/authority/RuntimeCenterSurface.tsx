import { useMemo, useState } from "react";

import type {
  RuntimeDescriptor,
  RuntimeProviderRegistration,
  RuntimeRegistrySnapshot,
} from "../../transport";
import { SurfaceTaskState } from "../SurfaceTaskState";

import "../../styles/runtime-center.css";

export interface RuntimeConsoleAttachment {
  readonly console_instance_id: string;
  readonly runtime_instance_id: string;
}

type Confirmation = {
  readonly kind: "restart" | "stop";
  readonly runtime: RuntimeDescriptor;
};

export interface RuntimeCenterSurfaceProps {
  readonly snapshot: RuntimeRegistrySnapshot | null;
  readonly consoleAttachments: readonly RuntimeConsoleAttachment[];
  readonly createRuntime: (
    provider: RuntimeProviderRegistration,
    label: string | null,
    openConsole: boolean,
  ) => Promise<void>;
  readonly openConsole: (runtime: RuntimeDescriptor, createAnother: boolean) => Promise<void>;
  readonly interruptRuntime: (runtime: RuntimeDescriptor) => Promise<void>;
  readonly restartRuntime: (runtime: RuntimeDescriptor) => Promise<void>;
  readonly stopRuntime: (runtime: RuntimeDescriptor) => Promise<void>;
  readonly reportError: (error: unknown) => void;
}

function runtimeRole(runtime: RuntimeDescriptor): string {
  return runtime.primary_scientific_runtime ? "Primary workspace" : "Auxiliary";
}

function providerFor(
  snapshot: RuntimeRegistrySnapshot,
  runtime: RuntimeDescriptor,
): RuntimeProviderRegistration | null {
  return snapshot.providers.find((provider) =>
    provider.definition.runtime_provider_id === runtime.runtime_provider_id
  ) ?? null;
}

function auxiliaryCount(snapshot: RuntimeRegistrySnapshot, providerId: string): number {
  return snapshot.instances.filter((runtime) =>
    !runtime.primary_scientific_runtime && runtime.runtime_provider_id === providerId
  ).length;
}

export function RuntimeCenterSurface({
  snapshot,
  consoleAttachments,
  createRuntime,
  openConsole,
  interruptRuntime,
  restartRuntime,
  stopRuntime,
  reportError,
}: RuntimeCenterSurfaceProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [label, setLabel] = useState("");
  const [openConsoleAfterCreate, setOpenConsoleAfterCreate] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const runtimes = useMemo(() => snapshot == null ? [] : [...snapshot.instances].sort((left, right) =>
    Number(right.primary_scientific_runtime) - Number(left.primary_scientific_runtime)
      || left.display_label.localeCompare(right.display_label)
      || left.runtime_instance_id.localeCompare(right.runtime_instance_id)
  ), [snapshot]);

  if (snapshot == null) {
    return <SurfaceTaskState
      tone="loading"
      title="Loading Runtime Registry…"
      detail="Reading exact Runtime process state for this project."
      role="status"
      busy
    />;
  }

  const creatableProviders = snapshot.providers.filter((provider) => provider.definition.create_supported);
  const providersWithCapacity = creatableProviders.filter((provider) =>
    auxiliaryCount(snapshot, provider.definition.runtime_provider_id) < provider.definition.max_instances
  );
  const selectedProvider = creatableProviders.find((provider) =>
    provider.definition.runtime_provider_id === providerId
  ) ?? providersWithCapacity[0] ?? creatableProviders[0] ?? null;
  const readyCount = runtimes.filter((runtime) => runtime.status === "ready").length;
  const busyCount = runtimes.filter((runtime) => ["busy", "interrupting", "restarting", "starting"].includes(runtime.status)).length;

  const perform = async (key: string, operation: () => Promise<void>) => {
    setBusyKey(key);
    try {
      await operation();
    } catch (error: unknown) {
      reportError(error);
    } finally {
      setBusyKey(null);
    }
  };

  const submitCreate = async () => {
    if (selectedProvider == null) return;
    await perform("create", async () => {
      await createRuntime(selectedProvider, label.trim() || null, openConsoleAfterCreate);
      setCreateOpen(false);
      setLabel("");
    });
  };

  const confirmLifecycle = async () => {
    if (confirmation == null) return;
    const { kind, runtime } = confirmation;
    await perform(`${kind}:${runtime.runtime_instance_id}`, async () => {
      if (kind === "restart") await restartRuntime(runtime);
      else await stopRuntime(runtime);
      setConfirmation(null);
    });
  };

  return <section className="rho-runtime-center" aria-label="Runtime Center">
    <header className="rho-runtime-center-toolbar">
      <div>
        <strong>{runtimes.length} {runtimes.length === 1 ? "Runtime" : "Runtimes"}</strong>
        <small>{readyCount} ready{busyCount > 0 ? ` · ${busyCount} active` : ""} · executions serialize per Runtime</small>
      </div>
      <button
        type="button"
        className="rho-primary-action"
        disabled={providersWithCapacity.length === 0 || busyKey === "create"}
        onClick={() => setCreateOpen((open) => !open)}
      >{createOpen ? "Cancel" : "New Runtime"}</button>
    </header>

    {createOpen && <section className="rho-runtime-create" aria-label="Create auxiliary Runtime">
      <header>
        <div><span className="rho-eyebrow">New auxiliary Runtime</span><strong>Start another R process</strong></div>
        {selectedProvider != null && <span>{auxiliaryCount(snapshot, selectedProvider.definition.runtime_provider_id)} / {selectedProvider.definition.max_instances}</span>}
      </header>
      <div className="rho-runtime-create-fields">
        <label>Provider<select value={selectedProvider?.definition.runtime_provider_id ?? ""} onChange={(event) => setProviderId(event.target.value)}>
          {creatableProviders.map((provider) => {
            const full = auxiliaryCount(snapshot, provider.definition.runtime_provider_id) >= provider.definition.max_instances;
            return <option value={provider.definition.runtime_provider_id} disabled={full} key={provider.definition.runtime_provider_id}>
              {provider.definition.display_label}{full ? " · capacity reached" : ""}
            </option>;
          })}
        </select></label>
        <label>Name<input value={label} maxLength={80} placeholder="Auxiliary R" onChange={(event) => setLabel(event.target.value)} /></label>
      </div>
      <dl className="rho-runtime-create-facts">
        <div><dt>Project</dt><dd>Current project</dd></div>
        <div><dt>R and libraries</dt><dd>Same active Environment as Workspace R</dd></div>
        <div><dt>Concurrency</dt><dd>Separate Runtime processes can execute concurrently</dd></div>
      </dl>
      <label className="rho-runtime-create-console"><input type="checkbox" checked={openConsoleAfterCreate} onChange={(event) => setOpenConsoleAfterCreate(event.target.checked)} />Open a dedicated Console when ready</label>
      <footer><button type="button" onClick={() => setCreateOpen(false)}>Cancel</button><button type="button" className="rho-primary-action" disabled={selectedProvider == null || busyKey === "create" || (selectedProvider != null && auxiliaryCount(snapshot, selectedProvider.definition.runtime_provider_id) >= selectedProvider.definition.max_instances)} onClick={() => void submitCreate()}>{busyKey === "create" ? "Starting…" : "Create Runtime"}</button></footer>
    </section>}

    {runtimes.length === 0
      ? <SurfaceTaskState tone="empty" title="No Runtime is registered" detail="Workspace R appears after the project Runtime starts." role="status" />
      : <div className="rho-runtime-list">{runtimes.map((runtime) => {
          const provider = providerFor(snapshot, runtime);
          const attachments = consoleAttachments.filter((binding) => binding.runtime_instance_id === runtime.runtime_instance_id);
          const actionBusy = busyKey?.endsWith(`:${runtime.runtime_instance_id}`) === true;
          const transitional = ["starting", "interrupting", "restarting"].includes(runtime.status);
          return <article className="rho-runtime-row" data-runtime-id={runtime.runtime_instance_id} data-status={runtime.status} key={runtime.runtime_instance_id}>
            <span className={`rho-runtime-dot rho-runtime-${runtime.status}`} aria-hidden="true" />
            <div className="rho-runtime-row-copy">
              <div><strong>{runtime.display_label}</strong><span>{runtimeRole(runtime)}</span></div>
              <small>{provider?.definition.display_label ?? runtime.runtime_provider_id} · {runtime.runtime_kind.toUpperCase()} · {attachments.length} {attachments.length === 1 ? "Console" : "Consoles"}</small>
            </div>
            <span className={`rho-runtime-state rho-runtime-${runtime.status}`}>{runtime.status}</span>
            <div className="rho-runtime-row-actions">
              <button type="button" disabled={actionBusy || transitional || runtime.status === "stopped"} onClick={() => void perform(`console:${runtime.runtime_instance_id}`, () => openConsole(runtime, false))}>{attachments.length > 0 ? "Open Console" : "New Console"}</button>
              {attachments.length > 0 && <button type="button" disabled={actionBusy || transitional || runtime.status === "stopped"} onClick={() => void perform(`new-console:${runtime.runtime_instance_id}`, () => openConsole(runtime, true))}>+ Console</button>}
              {(runtime.status === "busy" || runtime.status === "interrupting") && <button type="button" disabled={actionBusy || runtime.status === "interrupting"} onClick={() => void perform(`interrupt:${runtime.runtime_instance_id}`, () => interruptRuntime(runtime))}>{runtime.status === "interrupting" ? "Interrupting…" : "Interrupt"}</button>}
              <details className="rho-runtime-manage">
                <summary>Manage</summary>
                <div>
                  <button type="button" disabled={actionBusy || transitional} onClick={() => { setConfirmation({ kind: "restart", runtime }); }}>Restart…</button>
                  {!runtime.primary_scientific_runtime && <button type="button" disabled={actionBusy || transitional} onClick={() => { setConfirmation({ kind: "stop", runtime }); }}>Stop…</button>}
                </div>
              </details>
            </div>
            <details className="rho-runtime-identity">
              <summary>Runtime identity</summary>
              <dl>
                <div><dt>Instance</dt><dd><code>{runtime.runtime_instance_id}</code></dd></div>
                <div><dt>Generation</dt><dd>{runtime.activation_generation}</dd></div>
                <div><dt>State revision</dt><dd>{runtime.state_revision}</dd></div>
                <div><dt>Persistence</dt><dd>{runtime.persistence_class.replaceAll("_", " ")}</dd></div>
              </dl>
            </details>
          </article>;
        })}</div>}

    <footer className="rho-runtime-center-note">
      <strong>Current capability</strong>
      <span>Auxiliary Runtimes use the same selected R and active project Environment. Different R versions and remote profiles are not available in this create flow yet.</span>
    </footer>

    {confirmation != null && <div className="rho-runtime-confirm" role="alertdialog" aria-modal="false" aria-label={`${confirmation.kind} ${confirmation.runtime.display_label}`}>
      <div><strong>{confirmation.kind === "restart" ? `Restart ${confirmation.runtime.display_label}?` : `Stop ${confirmation.runtime.display_label}?`}</strong><p>{confirmation.kind === "restart"
        ? "In-memory objects in this Runtime will be discarded. Attached Consoles rebind to the new Runtime generation; durable transcripts remain."
        : "The auxiliary Runtime process and its in-memory objects will be removed. Durable Console transcripts remain available in History."}</p></div>
      <footer><button type="button" onClick={() => setConfirmation(null)}>Cancel</button><button type="button" className={confirmation.kind === "stop" ? "rho-runtime-danger-action" : "rho-primary-action"} disabled={busyKey != null} onClick={() => void confirmLifecycle()}>{confirmation.kind === "restart" ? "Restart Runtime" : "Stop Runtime"}</button></footer>
    </div>}
  </section>;
}
