import { useEffect, useRef, useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Icon } from "./icons";
import { Actions } from "flexlayout-react";
import { Commands, documentCommand } from "./commands";
import { message } from "./host-client";
import { Modal } from "./primitives";
import { DocumentPanel, EditorHub } from "./panels/editor-panel";
import {
  FilesPanel,
  ObjectsPanel,
  ObjectViewer,
} from "./panels/resource-panels";
import { useStudio } from "./context";
import { PackagesPanel } from "./panels/packages-panel";
import { ConsolePanel, PlotPanel } from "./panels/output-panels";
import { LayoutHost, PanelLayout, panelNames } from "./layout-host";
import type { RProbe } from "./generated/RProbe";

function ProjectDialog({ onClose }: { onClose: () => void }) {
  const s = useStudio(),
    [path, setPath] = useState(s.project ?? ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function open(value: string) {
    setBusy(true);
    try {
      await s.selectProject(value);
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
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
      {!!s.recent.length && (
        <>
          <h3>Recent Projects</h3>
          <div className="recent">
            {s.recent.map((p) => (
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
function SettingsDialog({ onClose }: { onClose: () => void }) {
  const s = useStudio(),
    [selection, setSelection] = useState(
      s.r?.current?.selection ??
        s.r?.candidates[0] ?? { executable: "", ark: "" },
    );
  const [probe, setProbe] = useState<RProbe | null>(s.r?.current ?? null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function check() {
    setBusy(true);
    setError("");
    try {
      setProbe(await s.client.probeR(selection));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    setBusy(true);
    setError("");
    try {
      s.r = await s.client.applyR(selection, confirmed);
      await s.refreshInfo();
      setError(s.r?.error ?? "");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Local R Settings"
      description="Use an installed R and Ark runtime."
      onClose={onClose}
    >
      <div className="preferences">
        <label>
          Code Font Size
          <select
            aria-label="Code Font Size"
            value={s.preferences.editorFontSize}
            onChange={(e) =>
              void s
                .setPreferences({
                  editorFontSize: Number(e.target.value),
                })
                .catch((e) => setError(message(e)))
            }
          >
            {[12, 14, 16, 18].map((size) => (
              <option key={size} value={size}>
                {size} px
              </option>
            ))}
          </select>
        </label>
        <label>
          Indent Width
          <select
            aria-label="Indent Width"
            value={s.preferences.indentWidth}
            onChange={(e) =>
              void s
                .setPreferences({
                  indentWidth: Number(e.target.value),
                })
                .catch((e) => setError(message(e)))
            }
          >
            {[2, 4, 8].map((size) => (
              <option key={size} value={size}>
                {size} spaces
              </option>
            ))}
          </select>
        </label>
      </div>
      {!!s.r?.candidates.length && (
        <label>
          Discovered R Installations
          <select
            value={selection.executable}
            onChange={(e) => {
              const next = s.r!.candidates.find(
                (c) => c.executable === e.target.value,
              );
              if (next) {
                setSelection(next);
                setProbe(null);
              }
            }}
          >
            {s.r.candidates.map((c) => (
              <option key={c.executable}>{c.executable}</option>
            ))}
          </select>
        </label>
      )}
      <label>
        R Executable
        <input
          value={selection.executable}
          onChange={(e) => {
            setSelection({ ...selection, executable: e.target.value });
            setProbe(null);
          }}
        />
      </label>
      <label>
        Ark Executable
        <input
          value={selection.ark}
          onChange={(e) => {
            setSelection({ ...selection, ark: e.target.value });
            setProbe(null);
          }}
        />
      </label>
      <button disabled={busy} onClick={() => void check()}>
        Check Configuration
      </button>
      {probe && (
        <div className="probe">
          <p>
            R {probe.version ?? "Unknown"} · {probe.architecture ?? "Unknown"}
          </p>
          <p>{probe.r_home}</p>
          <p>
            jsonlite {probe.jsonlite ? "Available" : "Missing"} · rlang{" "}
            {probe.rlang ? "Available" : "Missing"} · Ark{" "}
            {probe.ark_available ? "Available" : "Missing"}
          </p>
          {probe.diagnostics.map((d, i) => (
            <p key={i}>{d}</p>
          ))}
        </div>
      )}
      {s.project && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          End the current R session and restart
        </label>
      )}
      <button
        className="primary"
        disabled={busy || !probe?.usable || (!!s.project && !confirmed)}
        onClick={() => void apply()}
      >
        Apply and Start R
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
export function AppShell() {
  const s = useStudio(),
    [dialog, setDialog] = useState<
      "project" | "settings" | "commands" | "conflict" | "open-file" | null
    >(null),
    layout = useRef<PanelLayout | null>(null);
  const [filePath, setFilePath] = useState(""),
    [fileError, setFileError] = useState(""),
    [commandFilter, setCommandFilter] = useState("");
  const commands = useRef(new Commands()).current;
  s.openFile = () => setDialog("open-file");
  s.openSettings = () => setDialog("settings");
  s.openPanels = () => setDialog("commands");
  const active = () => s.documents.current;
  const dispatchDocument = (action: string) => {
    const d = active();
    if (d) {
      s.documents.focus(d);
      requestAnimationFrame(() => documentCommand(d.id, action));
    }
  };
  commands.entries = [
    {
      id: "file.new",
      label: "New R File",
      group: "File",
      enabled: () => !!s.project,
      run: () => {
        s.documents.create();
      },
    },
    {
      id: "file.open",
      label: "Open File…",
      group: "File",
      enabled: () => !!s.project,
      run: () => setDialog("open-file"),
    },
    {
      id: "file.save",
      label: "Save",
      group: "File",
      shortcut: "⌘ S",
      enabled: () => !!active() && s.documents.canSave(active()!),
      run: () => dispatchDocument("save"),
    },
    {
      id: "file.project",
      label: "Open Project…",
      group: "File",
      enabled: () => !s.busy,
      run: () => setDialog("project"),
    },
    {
      id: "edit.undo",
      label: "Undo Code Edit",
      group: "Edit",
      enabled: () => !!active(),
      run: () => dispatchDocument("undo"),
    },
    {
      id: "view.undo",
      label: "Undo Layout Change",
      group: "View",
      enabled: () => !!layout.current?.history.length,
      run: () => layout.current?.undo(),
    },
    {
      id: "view.reset",
      label: "Reset Layout",
      group: "View",
      enabled: () => !!s.project,
      run: () => layout.current?.reset(),
    },
    {
      id: "view.close",
      label: "Close View",
      group: "View",
      enabled: () => !!layout.current?.activeTab,
      run: () => layout.current?.close(layout.current.activeTab!.getId()),
    },
    {
      id: "view.console",
      label: "New Console View",
      group: "View",
      enabled: () => !!s.project,
      run: () => s.newConsole(),
    },
    {
      id: "session.selection",
      label: "Run Line / Selection",
      group: "Session",
      shortcut: "⌘ Enter",
      enabled: () => !!active() && s.documents.canRunSelection(active()!),
      run: () => dispatchDocument("runSelection"),
    },
    {
      id: "session.file",
      label: "Run File",
      group: "Session",
      shortcut: "⌘ ⇧ Enter",
      enabled: () => !!active() && s.documents.canRunFile(active()!),
      run: () => dispatchDocument("runFile"),
    },
    {
      id: "session.interrupt",
      label: "Interrupt",
      group: "Session",
      enabled: () => s.busy,
      run: () => {
        void s.cancel();
      },
    },
    {
      id: "session.settings",
      label: "R and Editor Settings…",
      group: "Session",
      enabled: () => true,
      run: () => setDialog("settings"),
    },
  ];
  useEffect(() => {
    void s.start();
    const leave = (e: BeforeUnloadEvent) => {
      if (s.unsynced) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => {
      s.stop();
      window.removeEventListener("beforeunload", leave);
    };
  }, [s]);
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
      if (dialog || !s.documents.current || !["s", "Enter"].includes(e.key))
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
  }, [dialog, s]);
  return (
    <div className="app-shell">
      <header className="topbar">
        <strong className="wordmark">rho</strong>
        <span className="divider" />
        <button className="project-button" onClick={() => setDialog("project")}>
          <Icon name="folder" />{" "}
          <span>{s.project?.split("/").at(-1) ?? "Open Project"}</span>
          <small>⌄</small>
        </button>
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
            <Icon name="studio" /> Panels
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content className="menu" sideOffset={6}>
              {Object.entries(panelNames).map(([id, name]) => (
                <Menu.Item key={id} onSelect={() => layout.current?.show(id)}>
                  {name}
                </Menu.Item>
              ))}
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
        {s.project ? (
          <LayoutHost
            key={s.project}
            studio={s}
            onLayout={(l) => {
              layout.current = l;
              s.renameView = (id, name) => {
                if (l.model.getNodeById(id))
                  l.model.doAction(Actions.renameTab(id, name));
                if (s.knownViews[id]) s.knownViews[id].name = name;
              };
              s.showPanel = (component, id, name, config) => {
                l.show(component, id, name, config);
                requestAnimationFrame(() =>
                  document
                    .querySelector<HTMLElement>(
                      `[data-rho-view="${CSS.escape(id ?? component)}"]`,
                    )
                    ?.closest(".flexlayout__tabset")
                    ?.scrollIntoView({ block: "nearest", inline: "nearest" }),
                );
              };
            }}
            registry={(node) => {
              switch (node.getComponent()) {
                case "console":
                  return <ConsolePanel viewId={node.getId()} />;
                case "plots":
                  return <PlotPanel viewId={node.getId()} />;
                case "editor":
                  return <EditorHub />;
                case "document":
                  return <DocumentPanel documentId={node.getId()} />;
                case "files":
                  return <FilesPanel />;
                case "packages":
                  return <PackagesPanel />;
                case "objects":
                  return <ObjectsPanel />;
                case "viewer":
                  return <ObjectViewer name={node.getConfig()?.name ?? ""} />;
                default:
                  return <div className="empty">View unavailable</div>;
              }
            }}
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
            {s.recent.map((p) => (
              <button
                key={p}
                onClick={() =>
                  void s.selectProject(p).catch((e) => {
                    s.error = message(e);
                    s.emit();
                  })
                }
              >
                {p}
              </button>
            ))}
          </main>
        )}
      </div>
      {(s.error || s.syncError) && (
        <div className="notice" role="alert">
          <span>{s.syncError || s.error}</span>
          {s.syncError && (
            <button onClick={() => void s.flush()}>Retry Draft Sync</button>
          )}
          {s.stateConflict && (
            <button onClick={() => setDialog("conflict")}>
              Resolve Window Conflict
            </button>
          )}
          <button
            aria-label="Dismiss Notice"
            onClick={() => {
              s.error = "";
              s.emit();
            }}
          >
            ×
          </button>
        </div>
      )}
      <footer className="statusbar">
        <button onClick={() => setDialog("settings")}>
          <i className={s.connected ? "dot" : "dot offline"} />
          Local R {s.r?.current?.version ?? "Not configured"}
        </button>
        <span>
          {s.connected
            ? s.consoleState?.input
              ? "Waiting for input"
              : s.consoleState?.pause
                ? "Queue paused"
                : s.consoleState?.current
                  ? s.records.get(s.consoleState.current.operation_id)
                      ?.status === "running"
                    ? "Running"
                    : "Queued"
                  : s.runtime?.state === "idle"
                    ? "Idle"
                    : s.runtime?.state === "busy"
                      ? "Running"
                      : "Unavailable"
            : "Disconnected"}
        </span>
        <button
          onClick={() => {
            const source = s.consoleState?.current?.source;
            s.showPanel?.(
              "console",
              source?.kind === "console" ? source.view_id : "console",
              source?.kind === "console" ? source.label : "Console",
            );
          }}
        >
          {s.consoleState?.input
            ? "Answer R Input"
            : `${s.consoleState?.pending.length ?? 0} queued`}
          {s.consoleState?.pause ? " · Paused" : ""}
        </button>
        <span className="secondary" title={s.runtime?.notices.join("\n")}>
          Memory{" "}
          {s.runtime?.processes[0]?.memory_bytes == null
            ? "Unknown"
            : `${(s.runtime.processes[0].memory_bytes / 1048576).toFixed(0)} MiB`}
          　CPU{" "}
          {s.runtime?.processes[0]?.cpu_percent == null
            ? "Unknown"
            : `${s.runtime.processes[0].cpu_percent.toFixed(1)}%`}
        </span>
        <div className="spacer" />
        <span className="project-path">{s.project}</span>
        <span>{s.unsynced ? "Draft sync pending" : "Draft synced"}</span>
        <button onClick={() => setDialog("settings")}>Environment</button>
      </footer>
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
              void s.documents
                .open(filePath)
                .then(() => setDialog(null))
                .catch((e) => setFileError(message(e)));
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
      {dialog === "settings" && (
        <SettingsDialog onClose={() => setDialog(null)} />
      )}
      {dialog === "conflict" && s.stateConflict && (
        <Modal
          title="Shared drafts changed in another window"
          description="Your edits are retained. Compare both states before replacing shared drafts. Project files are unaffected."
          onClose={() => setDialog(null)}
        >
          <div className="comparison">
            <div>
              This Window
              <pre>
                {JSON.stringify(s.documents.serialize(), null, 2).slice(
                  0,
                  12000,
                )}
              </pre>
            </div>
            <div>
              Synced State
              <pre>
                {JSON.stringify(s.stateConflict.value, null, 2).slice(0, 12000)}
              </pre>
            </div>
          </div>
          <button
            className="primary"
            onClick={() => {
              void s
                .replaceSharedDrafts(s.stateConflict!)
                .then(() => setDialog(null));
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
                    layout.current?.show(id);
                    setDialog(null);
                  }}
                >
                  Show {name}
                </button>
              ))}
            {[...s.documents.items.values()].map((d) => (
              <button
                key={d.id}
                onClick={() => {
                  s.documents.focus(d);
                  setDialog(null);
                }}
              >
                {d.name}
                {d.dirty ? " · Unsaved" : ""}
              </button>
            ))}
            {Object.entries(s.knownViews)
              .filter(
                ([id, v]) =>
                  ["console", "plots", "viewer"].includes(v.component) &&
                  id !== v.component,
              )
              .map(([id, v]) => (
                <button
                  key={id}
                  onClick={() => {
                    layout.current?.show(v.component, id, v.name, v.config);
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
