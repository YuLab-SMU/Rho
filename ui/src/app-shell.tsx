import { useEffect, useRef, useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Icon } from "./icons";
import { Commands } from "./commands";
import { message, sameScope } from "./shared/ports";
import { Modal } from "./primitives";
import {
  useSession, useOperations, useConsole, useDocuments,
  usePersistence, useLayout, useNavigation, startStudio, stopStudio,
} from "./context";
import { LayoutHost } from "./layout-host";
import { panelNames } from "./builtin-panels";
import type { DocumentAction, Dialog } from "./navigation";
import { SettingsDialog } from "./settings-controls";
import { SettingsPage } from "./settings-page";
import { WorkspaceSidebar, WorkspaceStatusBar, ProjectMenu } from "./panels/shell-panels";

function ProjectDialog({ onClose }: { onClose: () => void }) {
  const session = useSession(),
    [path, setPath] = useState(session.project ?? ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const mounted = useRef(true), request = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current++; };
  }, []);
  async function open(value: string) {
    const generation = ++request.current, epoch = session.epoch;
    const current = () => mounted.current && generation === request.current && session.epoch >= epoch && session.epoch <= epoch + 1;
    setBusy(true); setError("");
    try {
      await session.selectProject(value);
      if (current()) onClose();
    } catch (error) {
      if (current()) setError(message(error));
    } finally {
      if (current()) setBusy(false);
    }
  }
  return (
    <Modal
      title="Open Project"
      description="Choose a local project directory. Switching projects ends the current R session."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void open(path);
        }}
      >
        <label>
          Absolute Project Path
          <input
            autoFocus
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/…/project"
          />
        </label>
        <button className="primary" disabled={busy || !path.trim()}>
          Open Project
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!!session.recent.length && (
        <>
          <h3>Recent Projects</h3>
          <div className="recent">
            {session.recent.map((p) => (
              <button key={p} disabled={busy} onClick={() => void open(p)}>
                {p}
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
export function AppShell() {
  const session = useSession(), operations = useOperations(), consoleModel = useConsole(),
    documents = useDocuments(), persistence = usePersistence(), layout = useLayout(), navigation = useNavigation();
  const dialog = navigation.getSnapshot().dialog;
  const setDialog = (value: Dialog) => navigation.setDialog(value);
  const layoutState = layout.getSnapshot();
  const [filePath, setFilePath] = useState(""),
    [fileError, setFileError] = useState(""),
    [commandFilter, setCommandFilter] = useState("");
  const commands = useRef(new Commands()).current;
  const mounted = useRef(true), request = useRef(0);
  useEffect(() => {
    request.current++; setFileError("");
    return () => { request.current++; };
  }, [dialog, session.epoch]);
  const guard = () => {
    const generation = ++request.current, scope = session.context();
    return () => mounted.current && generation === request.current && sameScope(scope, session.context());
  };
  const active = () => documents.current;
  const dispatchDocument = (action: DocumentAction) => {
    const d = active();
    if (d) {
      documents.focus(d);
      navigation.documentCommand(d.id, action);
    }
  };
  commands.entries = [
    {
      id: "file.new",
      label: "New R File",
      group: "File",
      enabled: () => session.ready && !!session.project,
      run: () => {
        documents.create();
      },
    },
    {
      id: "file.open",
      label: "Open File…",
      group: "File",
      enabled: () => session.ready && !!session.project,
      run: () => setDialog("open-file"),
    },
    {
      id: "file.save",
      label: "Save",
      group: "File",
      shortcut: "⌘ S",
      enabled: () => session.ready && !!active() && documents.canSave(active()!),
      run: () => dispatchDocument("save"),
    },
    {
      id: "file.project",
      label: "Open Project…",
      group: "File",
      enabled: () => !operations.busy,
      run: () => setDialog("project"),
    },
    {
      id: "edit.undo",
      label: "Undo Code Edit",
      group: "Edit",
      enabled: () => session.ready && !!active(),
      run: () => dispatchDocument("undo"),
    },
    {
      id: "view.undo",
      label: "Undo Layout Change",
      group: "View",
      enabled: () => layoutState.canUndo,
      run: () => layout.undo(),
    },
    {
      id: "view.reset",
      label: "Reset Layout",
      group: "View",
      enabled: () => session.ready && !!session.project,
      run: () => layout.reset(),
    },
    {
      id: "view.close",
      label: "Close View",
      group: "View",
      enabled: () => !!layoutState.activeTabId,
      run: () => layout.closeActive(),
    },
    {
      id: "view.console",
      label: "New Console View",
      group: "View",
      enabled: () => session.ready && !!session.project,
      run: () => consoleModel.newConsole(),
    },
    {
      id: "session.selection",
      label: "Run Line / Selection",
      group: "Session",
      shortcut: "⌘ Enter",
      enabled: () => session.ready && !!active() && documents.canRunSelection(active()!),
      run: () => dispatchDocument("runSelection"),
    },
    {
      id: "session.file",
      label: "Run File",
      group: "Session",
      shortcut: "⌘ ⇧ Enter",
      enabled: () => session.ready && !!active() && documents.canRunFile(active()!),
      run: () => dispatchDocument("runFile"),
    },
    {
      id: "session.interrupt",
      label: "Interrupt",
      group: "Session",
      enabled: () => operations.busy,
      run: () => {
        void operations.cancel();
      },
    },
    {
      id: "session.agents",
      label: "Open Agent",
      group: "Session",
      enabled: () => true,
      run: () => layout.show("agent"),
    },
    { id: "session.agent-settings", label: "Agent Settings…", group: "Session", enabled: () => true, run: () => setDialog("agents") },
    {
      id: "session.settings",
      label: "R and Editor Settings…",
      group: "Session",
      enabled: () => true,
      run: () => setDialog("settings"),
    },
  ];
  useEffect(() => {
    mounted.current = true;
    void startStudio();
    const leave = (e: BeforeUnloadEvent) => {
      if (persistence.unsynced) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => {
      mounted.current = false; request.current++; stopStudio();
      window.removeEventListener("beforeunload", leave);
    };
  }, [persistence]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        e.isComposing ||
        document.activeElement?.closest("[role=dialog]") ||
        !(e.metaKey || e.ctrlKey)
      )
        return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDialog("commands");
        return;
      }
      if (
        e.key === "Enter" &&
        !document.activeElement?.closest(".document-panel")
      )
        return;
      if (dialog || !documents.current || !["s", "Enter"].includes(e.key))
        return;
      e.preventDefault();
      commands.execute(
        e.key === "s"
          ? "file.save"
          : e.shiftKey
            ? "session.file"
            : "session.selection",
      );
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [dialog, documents, commands]);
  return (
    <div className="app-shell">
      <header className="topbar">
        <strong className="wordmark">rho</strong>
        <span className="divider" />
        <ProjectMenu />
        {(["File", "Edit", "View", "Session"] as const).map((group) => (
          <Menu.Root key={group}>
            <Menu.Trigger className="app-menu">{group}</Menu.Trigger>
            <Menu.Portal>
              <Menu.Content className="menu" sideOffset={6}>
                {commands.entries
                  .filter((c) => c.group === group)
                  .map((c) => (
                    <Menu.Item
                      key={c.id}
                      disabled={!c.enabled()}
                      onSelect={() => commands.execute(c.id)}
                    >
                      {c.label} {c.shortcut && <kbd>{c.shortcut}</kbd>}
                    </Menu.Item>
                  ))}
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        ))}
        <div className="spacer" />
        <Menu.Root>
          <Menu.Trigger className="bordered">
            <Icon name="studio" /> Layout
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content className="menu" sideOffset={6}>
              {Object.entries(panelNames).map(([id, name]) => (
                <Menu.Item key={id} onSelect={() => layout.show(id)}>
                  {name}
                </Menu.Item>
              ))}
              <Menu.Separator className="shell-menu-separator" />
              {commands.entries.filter(c => ["view.undo", "view.reset"].includes(c.id)).map(c => <Menu.Item key={c.id} disabled={!c.enabled()} onSelect={() => commands.execute(c.id)}>{c.label}</Menu.Item>)}
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
        <button
          className="bordered"
          aria-label="Commands"
          onClick={() => setDialog("commands")}
        >
          <Icon name="search" /> <kbd>⌘ K</kbd>
        </button>
      </header>
      <div className="work-area">
        <WorkspaceSidebar />
        {session.project && !session.ready ? (
          <main className="welcome"><p className="muted" role="status">Opening project…</p></main>
        ) : session.project ? (
          <LayoutHost
            key={session.project}
            layout={layout}
            documentTabs={new Map([...documents.items].map(([id, d]) => [id, { name: d.name, dirty: d.dirty, readonly: !!d.draft.readonly }]))}
            navigation={navigation}
          />
        ) : (
          <main className="welcome">
            <div className="welcome-mark">rho</div>
            <h1>Your scientific workspace</h1>
            <p>Open a project to write R, explore objects and inspect plots.</p>
            <button className="primary" onClick={() => setDialog("project")}>
              Open Project
            </button>
            <button onClick={() => setDialog("settings")}>Configure R</button>
            {session.recent.map((p) => (
              <button
                key={p}
                onClick={() =>
                  void session.selectProject(p).catch(() => {})
                }
              >
                {p}
              </button>
            ))}
          </main>
        )}
      </div>
      {(session.error || persistence.syncError || layoutState.error) && (
        <div className="notice" role="alert">
          <span>{persistence.syncError || session.error || layoutState.error}</span>
          {persistence.syncError && (
            <button onClick={() => void persistence.flush()}>Retry Draft Sync</button>
          )}
          {persistence.stateConflict && (
            <button onClick={() => setDialog("conflict")}>
              Resolve Window Conflict
            </button>
          )}
          <button
            aria-label="Dismiss Notice"
            onClick={() => {
              session.dismissError();
              layout.dismissError();
            }}
          >
            ×
          </button>
        </div>
      )}
      <WorkspaceStatusBar />
      {dialog === "open-file" && (
        <Modal
          title="Open File"
          description="Enter a project-relative file path."
          onClose={() => setDialog(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setFileError("");
              const current = guard();
              void documents.open(filePath)
                .then(() => { if (current()) setDialog(null); })
                .catch((error) => { if (current()) setFileError(message(error)); });
            }}
          >
            <label>
              File Path
              <input
                autoFocus
                aria-label="File Path"
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
              />
            </label>
            {fileError && (
              <p role="alert" className="error">
                {fileError}
              </p>
            )}
            <button className="primary" disabled={!filePath.trim()}>
              Open
            </button>
          </form>
        </Modal>
      )}
      {dialog === "project" && (
        <ProjectDialog onClose={() => setDialog(null)} />
      )}
      {dialog === "agents" && <SettingsPage onClose={() => setDialog(null)} />}
      {dialog === "settings" && (
        <SettingsDialog onClose={() => setDialog(null)} />
      )}
      {dialog === "conflict" && persistence.stateConflict && (
        <Modal
          title="Shared drafts changed in another window"
          description="Your edits are retained. Compare both states before replacing shared drafts. Project files are unaffected."
          onClose={() => setDialog(null)}
        >
          <div className="comparison">
            <div>
              This Window
              <pre>
                {JSON.stringify(documents.serialize(), null, 2).slice(
                  0,
                  12000,
                )}
              </pre>
            </div>
            <div>
              Synced State
              <pre>
                {JSON.stringify(persistence.stateConflict.value, null, 2).slice(0, 12000)}
              </pre>
            </div>
          </div>
          <button
            className="primary"
            onClick={() => {
              const current = guard();
              void persistence.replaceSharedDrafts(persistence.stateConflict!)
                .then(() => { if (current()) setDialog(null); });
            }}
          >
            Use this window’s drafts and layout
          </button>
        </Modal>
      )}
      {dialog === "commands" && (
        <Modal
          title="Commands and Panels"
          description="Find a view or workspace command."
          onClose={() => setDialog(null)}
        >
          <input
            autoFocus
            aria-label="Search Commands and Panels"
            placeholder="Search commands and views…"
            value={commandFilter}
            onChange={(e) => setCommandFilter(e.target.value)}
          />
          <div className="command-list">
            {commands.entries
              .filter((c) =>
                c.label.toLowerCase().includes(commandFilter.toLowerCase()),
              )
              .map((c) => (
                <button
                  key={c.id}
                  disabled={!c.enabled()}
                  onClick={() => {
                    setDialog(null);
                    commands.execute(c.id);
                  }}
                >
                  {c.label}
                  <span className="spacer" />
                  <kbd>{c.shortcut}</kbd>
                </button>
              ))}
            {Object.entries(panelNames)
              .filter(([, name]) =>
                name.toLowerCase().includes(commandFilter.toLowerCase()),
              )
              .map(([id, name]) => (
                <button
                  key={id}
                  onClick={() => {
                    layout.show(id);
                    setDialog(null);
                  }}
                >
                  Show {name}
                </button>
              ))}
            {[...documents.items.values()].map((d) => (
              <button
                key={d.id}
                onClick={() => {
                  documents.focus(d);
                  setDialog(null);
                }}
              >
                {d.name}
                {d.dirty ? " · Unsaved" : ""}
              </button>
            ))}
            {Object.entries(layoutState.knownViews)
              .filter(
                ([id, v]) =>
                  ["console", "plots", "viewer"].includes(v.component) &&
                  id !== v.component,
              )
              .map(([id, v]) => (
                <button
                  key={id}
                  onClick={() => {
                    layout.show(v.component, id, v.name, v.config);
                    setDialog(null);
                  }}
                >
                  {v.name}
                </button>
              ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
