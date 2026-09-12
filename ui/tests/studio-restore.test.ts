import { afterEach, expect, it, vi } from "vitest";
import { Studio } from "../src/studio";
import { PanelLayout } from "../src/layout-model";
import type { HostClient } from "../src/host-client";
import type { ApplicationBridgeRequest } from "../src/generated/ApplicationBridgeRequest";
import type { ApplicationBridgeReply } from "../src/generated/ApplicationBridgeReply";
import type { ApplicationContextState } from "../src/generated/ApplicationContextState";
import type { ApplicationState } from "../src/generated/ApplicationState";
import type { QuerySnapshot } from "../src/generated/QuerySnapshot";
import type { MediaReference } from "../src/generated/MediaReference";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
const stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.clearAllTimers(); vi.useRealTimers(); });
const ready = (data: unknown): QuerySnapshot => ({ target: { kind: "workspace", identity: "native" }, source: "fixture", observed_at_ms: 1,
  status: "ready", completeness: "complete", notices: [], next_reads: [], diagnostics: [], data: data as QuerySnapshot["data"] });
const plot: MediaReference = { operation_id: "original-plot", sequence: 2, mime_type: "image/png", byte_size: 10, sha256: "sha256:original", display_id: null };

function fixture(delay: "runtime" | "plot" | "persistence" | null = null) {
  vi.useFakeTimers();
  const seed = new PanelLayout(); seed.show("packages"); seed.close("packages"); seed.show("objects");
  const persisted = { version: 2, ...seed.serialize(), packages: { filter: "stats" } };
  const layout = seed.getSnapshot();
  let remoteContext: ApplicationContextState = { version: "remote-context", label: "project", active_document_id: null, active_view_id: "objects", native_session_id: "native",
    views: Object.entries(layout.knownViews).filter(([id]) => seed.has(id)).map(([view_id, view]) => ({ view_id, view_type: view.component, document_id: null, active: layout.activeViewIds.includes(view_id) })),
    selected_object: null, selected_package: null, selected_plot: delay === "plot" ? { operation_id: plot.operation_id, sequence: plot.sequence } : null };
  seed.stop();
  const entered = deferred<void>(), release = deferred<void>();
  const session = { window: { window_id: "window", incarnation: "incarnation" }, bridge_token: "fixture-bridge" };
  const host = {
    agentConnection: vi.fn(), agentConfiguration: vi.fn(),
    windowId: session.window.window_id, incarnation: session.window.incarnation,
    previousBridgeSession: () => undefined, rememberBridgeSession: vi.fn(), stopReads: vi.fn(),
    info: vi.fn(async () => ({ project_root: "/project", runtime: "R", capabilities: [{ capability: { id: "workspace.runtime_status", version: 1 } }] })),
    rConfiguration: vi.fn(async () => ({ source: "fixture", current: null, candidates: [], error: null })),
    selectProject: vi.fn(), probeR: vi.fn(), applyR: vi.fn(), invoke: vi.fn(), cancel: vi.fn(), respondInput: vi.fn(), quitWorkbench: vi.fn(),
    subscribe: vi.fn(async () => []), getOperation: vi.fn(async () => null), applicationExecute: vi.fn(), applicationStatus: vi.fn(), applicationReadDocument: vi.fn(),
    readState: vi.fn(async (_project: string | null, key: string): Promise<ApplicationState> => {
      if (delay === "persistence" && key.startsWith("studio.")) { entered.resolve(); await release.promise; }
      return { key, version: "persisted-version", value: key === "recent" ? ["/project"] : key === "preferences" ? { editorFontSize: 14, indentWidth: 4 } : persisted as ApplicationState["value"] };
    }),
    writeState: vi.fn(async (_project: string | null, state: ApplicationState) => ({ ...state, version: "written-version" })),
    query: vi.fn(async (_project: string, id: string): Promise<QuerySnapshot> => {
      if ((delay === "runtime" && id === "workspace.runtime_status") || (delay === "plot" && id === "workspace.list_outputs")) { entered.resolve(); await release.promise; }
      if (id === "workspace.runtime_status") return ready({ session_id: "native", state: "idle", observed_at_ms: Date.now(), processes: [], notices: [] });
      if (id === "workspace.list_outputs") return ready({ media: [{ reference: plot }] });
      if (id === "operation.events_checkpoint") return ready({ sequence: 0 });
      return ready({ operations: [], next_cursor: null });
    }),
    applicationBridge: vi.fn(async (_project: string, request: ApplicationBridgeRequest): Promise<ApplicationBridgeReply> => {
      if (request.kind === "register") return { kind: "registered", data: { session, context: structuredClone(remoteContext), documents: [], heartbeat_interval_ms: 5000, offline_after_ms: 15000 } };
      if (request.kind === "sync") {
        if (request.changes.context) { expect(request.changes.context.expected_version).toBe(remoteContext.version); remoteContext = structuredClone(request.changes.context.context); }
        return { kind: "synced", data: { sync_id: request.sync_id, synced_at_ms: Date.now(), context_version: remoteContext.version,
          document_versions: request.changes.documents.map(({ document }) => ({ document_id: document.document_id, document_version: document.version, selection_version: document.selection.version })) } };
      }
      if (request.kind === "claim") return { kind: "claimed", data: null };
      throw new Error("Unexpected fixture control");
    }),
  };
  const studio = new Studio(host as unknown as HostClient); stops.push(() => studio.stop());
  return { studio, host, entered, release, remote: () => remoteContext };
}

it.each(["runtime", "persistence"] as const)("keeps Show Packages during delayed %s restoration and restores its saved filter", async (delay) => {
  const f = fixture(delay), starting = f.studio.start(); await f.entered.promise;
  f.studio.layout.show("packages");
  expect(f.studio.layout.getSnapshot().activeViewIds).toContain("packages");
  f.release.resolve(); await starting;
  expect(f.studio.session.ready).toBe(true); expect(f.studio.application.ready).toBe(true);
  expect(f.studio.layout.has("packages")).toBe(true); expect(f.studio.layout.getSnapshot().activeViewIds).toContain("packages");
  expect(f.studio.packages.serialize().packages.filter).toBe("stats");
  expect(f.remote().views.some((view) => view.view_id === "packages")).toBe(true); expect(f.remote().active_view_id).toBe("packages");
  expect(f.host.invoke).not.toHaveBeenCalled();
});

it("keeps a closed plot and newer active view when original plot evidence arrives late", async () => {
  const f = fixture("plot"), starting = f.studio.start(); await f.entered.promise;
  f.studio.layout.close("plots"); f.studio.layout.show("packages");
  f.release.resolve(); await starting;
  expect(f.studio.application.ready).toBe(true); expect(f.studio.layout.has("plots")).toBe(false);
  expect(f.studio.layout.getSnapshot().activeViewIds).toContain("packages");
  expect(f.studio.plots.selectedEvidence()).toEqual(plot); expect(f.remote().active_view_id).toBe("packages");
});

it("does not replace a newer selected plot with old evidence that finishes later", async () => {
  const f = fixture("plot"), starting = f.studio.start(); await f.entered.promise;
  const chosen = { ...plot, operation_id: "user-selected-plot", sequence: 7 };
  f.studio.plots.locate(chosen); f.release.resolve(); await starting;
  expect(f.studio.plots.selectedEvidence()).toEqual(chosen); expect(f.remote().selected_plot).toEqual({ operation_id: chosen.operation_id, sequence: 7 });
});

it("restores the saved closed layout when no local interaction competes with startup", async () => {
  const f = fixture(); await f.studio.start();
  expect(f.studio.session.ready).toBe(true); expect(f.studio.layout.has("packages")).toBe(false);
  expect(f.studio.packages.serialize().packages.filter).toBe("stats"); expect(f.remote().active_view_id).toBe("objects");
});
