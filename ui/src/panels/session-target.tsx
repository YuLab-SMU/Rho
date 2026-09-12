import * as Menu from "@radix-ui/react-dropdown-menu";
import { Icon } from "../icons";
import { useInstanceConsole, useNavigation, useRuntimeSessions, useSession } from "../context";
import { sessionState } from "../runtime-presentation";
import { message } from "../shared/ports";
import type { WorkspaceInstance } from "../generated/WorkspaceInstance";

export function SessionActivityLabel({ instance }: { instance: WorkspaceInstance }) {
  const console = useInstanceConsole(instance.workspace_instance_id), session = useSession();
  const queue = console.consoleState?.session_id === instance.native_session_id ? console.consoleState : null;
  return <>{sessionState(instance, queue, session.connected)}</>;
}
const stateTone = (state: WorkspaceInstance["state"]) =>
  state === "ready" ? " is-live" : state === "recovery_required" || state === "failed" ? " is-attention" : "";

/** A missing installation identity stays unknown; the picker never guesses a version. */
const subtitle = (instance: WorkspaceInstance) => {
  const version = instance.installation ? `R ${instance.installation.r_version}` : "R version unknown";
  return instance.binding.environment_realization_id ? `${version} · Managed environment` : version;
};

/**
 * The execution target beside Run. Choosing a session only affects work submitted
 * afterwards; accepted work keeps the target it was captured with.
 */
export function SessionTargetPicker() {
  const session = useSession(), runtimeSessions = useRuntimeSessions(), navigation = useNavigation();
  const rs = runtimeSessions.getSnapshot();
  const sessions = rs.catalogIds.map((id) => rs.instances.get(id)).filter((value): value is WorkspaceInstance => !!value);
  if (sessions.length < 2) return null;
  const selected = rs.selectedId ? rs.instances.get(rs.selectedId) ?? null : null;
  const choose = (instance: WorkspaceInstance) => {
    try { runtimeSessions.select(instance.workspace_instance_id); }
    catch (error) { session.reportError(message(error)); return; }
    // Choosing a stopped session continues it, so the next Run has a live target.
    if (instance.state === "stopped") {
      void runtimeSessions.continueInstance(instance.workspace_instance_id)
        .catch((error) => session.reportError(message(error)));
    }
  };
  return (
    <Menu.Root>
      <Menu.Trigger className="session-target" title={`Runs go to ${selected?.name ?? "the selected session"}`}>
        <i className={`dot${selected?.state === "ready" ? "" : " offline"}`} />
        <span className="session-target-label">{selected?.name ?? "Session"}</span>
        <Icon name="chevron" size={12} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu session-target-menu" side="bottom" align="end" sideOffset={6} collisionPadding={8}>
          <Menu.Label className="shell-menu-label">Run in session</Menu.Label>
          {sessions.map((instance) => (
            <Menu.Item
              key={instance.workspace_instance_id}
              className="session-target-row"
              data-selected={instance.workspace_instance_id === rs.selectedId ? "true" : undefined}
              disabled={rs.commands.has(instance.workspace_instance_id)}
              onSelect={() => choose(instance)}
            >
              <span className="session-target-check">{instance.workspace_instance_id === rs.selectedId ? "✓" : ""}</span>
              <span className="session-target-name">{instance.name}<small>{subtitle(instance)}</small></span>
              <span className={`session-target-state${stateTone(instance.state)}`}><SessionActivityLabel instance={instance} /></span>
            </Menu.Item>
          ))}
          {rs.stale && <div className="shell-observation-note">Refreshing the session catalog…</div>}
          <Menu.Separator className="shell-menu-separator" />
          <Menu.Item onSelect={() => navigation.setDialog("new-session")}>＋ New session…</Menu.Item>
          <Menu.Item onSelect={() => navigation.openSessions(rs.selectedId)}>R Sessions →</Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
