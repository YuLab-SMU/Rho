import { Model } from "./shared/model";
import type { MediaReference } from "./generated/MediaReference";
import type { BuiltinPanel } from "./builtin-panels";
import { sameScope } from "./shared/ports";
import type { RequestContext } from "./shared/ports";

export type DocumentAction = "save" | "runFile" | "runSelection" | "undo";
export type Dialog = "project" | "settings" | "agents" | "commands" | "conflict" | "open-file" | null;
interface NavigationPorts {
  context(): RequestContext;
  show(component: BuiltinPanel, id?: string, name?: string, config?: unknown): void;
  bindView?(viewId: string, workspaceInstanceId: string): void;
  openDocument(path: string, bytes?: number): Promise<unknown>;
  createDocument(): unknown;
  locatePlot(reference: MediaReference): void;
  reportError(error: string): void;
}

/** Explicit view navigation and typed editor intents; no mutable UI callback slots. */
export class Navigation extends Model<{ dialog: Dialog }> {
  private dialog: Dialog = null;
  private documentListeners = new Map<string, Set<(action: DocumentAction) => void>>();
  private pending = new Map<string, DocumentAction>();
  private generation = 0;
  constructor(private ports: NavigationPorts) { super(); }
  protected readSnapshot() { return { dialog: this.dialog }; }
  setDialog(dialog: Dialog) { this.dialog = dialog; this.publish(); }
  openFile() { this.setDialog("open-file"); }
  openSettings() { this.setDialog("settings"); }
  openPanels() { this.setDialog("commands"); }
  createDocument() { return this.ports.createDocument(); }
  showPanel(component: BuiltinPanel, id?: string, name?: string, config?: unknown) { this.ports.show(component, id, name, config); }
  async openDocument(path: string, bytes?: number) {
    const scope = this.ports.context(), generation = this.generation;
    try { await this.ports.openDocument(path, bytes); }
    catch (error) { if (generation === this.generation && sameScope(scope, this.ports.context())) this.ports.reportError(error instanceof Error ? error.message : String(error)); }
  }
  openObject(name: string, path: import("./generated/ObjectPathElement").ObjectPathElement[] = [], workspaceInstanceId = this.ports.context().workspaceInstanceId) {
    const id = workspaceInstanceId ? `object:${JSON.stringify([workspaceInstanceId, name, path])}` : `object:${name}${path.length ? ":" + JSON.stringify(path) : ""}`;
    if (workspaceInstanceId) this.ports.bindView?.(id, workspaceInstanceId);
    this.ports.show("viewer", id, name + path.map(x => x.kind === "index" ? `[[${x.index}]]` : `$${x.name}`).join(""), { name, path, workspaceInstanceId });
  }
  locatePlot(reference: MediaReference) { this.ports.locatePlot(reference); }
  documentCommand(id: string, action: DocumentAction) {
    const listeners = this.documentListeners.get(id);
    if (!listeners?.size) { this.pending.set(id, action); return; }
    for (const listener of [...listeners]) listener(action);
  }
  onDocumentCommand(id: string, listener: (action: DocumentAction) => void) {
    let listeners = this.documentListeners.get(id);
    if (!listeners) this.documentListeners.set(id, listeners = new Set());
    listeners.add(listener);
    const pending = this.pending.get(id);
    if (pending) queueMicrotask(() => {
      if (listeners.has(listener) && this.pending.get(id) === pending) {
        this.pending.delete(id); listener(pending);
      }
    });
    return () => { listeners.delete(listener); };
  }
  reset() { this.generation++; this.pending.clear(); this.setDialog(null); }
  stop() { this.generation++; this.documentListeners.clear(); this.pending.clear(); this.dispose(); }
}
