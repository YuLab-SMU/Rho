import { Model, immutable } from "./shared/model";
import { sameScope, message } from "./shared/ports";
import type { AgentPorts, AgentConfigurationFormat } from "./agent-ports";
import type { WorkbenchAgentConnection } from "./generated/WorkbenchAgentConnection";

/** Settings-only observations; no Agent execution or persisted credentials. */
export class Agents extends Model<{
  data: WorkbenchAgentConnection | null; loading: boolean; stale: boolean;
  error: string; copying: boolean; feedback: string;
}> {
  private data: WorkbenchAgentConnection | null = null;
  private loading = false;
  private stale = true;
  private error = "";
  private copying = false;
  private feedback = "";
  private visible = false;
  private generation = 0;
  private flight: Promise<WorkbenchAgentConnection | null> | null = null;
  constructor(private ports: AgentPorts) { super(); }
  protected readSnapshot() { return { data: this.data, loading: this.loading, stale: this.stale,
    error: this.error, copying: this.copying, feedback: this.feedback }; }
  get window() { return this.ports.window(); }
  get canCopy() {
    const scope = this.ports.context();
    return this.visible && !!scope.project && scope.connected && scope.ready !== false &&
      !this.stale && this.data?.project_root === scope.project && !this.copying;
  }
  show() { this.visible = true; this.stale = true; this.feedback = ""; this.publish(); this.ports.schedule(); }
  hide() { this.visible = false; this.reset(); }
  reset() {
    this.generation++; this.flight = null; this.data = null; this.loading = false;
    this.stale = true; this.copying = false; this.feedback = ""; this.error = ""; this.publish();
  }
  observe = async () => { if (this.visible) await this.refresh(); };
  refresh(): Promise<WorkbenchAgentConnection | null> {
    if (!this.visible) return Promise.resolve(null);
    if (this.flight) return this.flight;
    const generation = this.generation, scope = this.ports.context();
    const current = () => this.visible && generation === this.generation && sameScope(scope, this.ports.context(), true);
    this.loading = true; this.publish();
    const task = (async () => {
      try {
        const result = await this.ports.read();
        if (!current()) return null;
        if (result.project_root !== scope.project) throw new Error("The Host is using a different project. Reopen the intended workspace.");
        this.ports.configuration(result, "codex", true);
        this.data = immutable(result); this.stale = false; this.error = "";
        return this.data;
      } catch (error) {
        if (current()) { this.stale = true; this.error = message(error); }
        return null;
      } finally {
        if (generation === this.generation) { this.loading = false; this.flight = null; this.publish(); }
      }
    })();
    this.flight = task;
    return task;
  }
  preview(format: AgentConfigurationFormat) {
    if (!this.data || this.stale) return "";
    return this.ports.configuration(this.data, format, true);
  }
  copyConfiguration(format: AgentConfigurationFormat) {
    return this.copyAction((data) => this.ports.configuration(data, format, false), "Configuration copied. Add it in your agent and reload its MCP connection.");
  }
  copyContext() {
    return this.copyAction((data) => {
      const window = this.ports.window();
      if (!window) throw new Error("This Studio window has not synchronized yet. Try again shortly.");
      return `Use the Rho MCP server ${JSON.stringify(data.suggested_server_name)} to inspect this workspace without changing it.\n` +
        `Expected project: ${JSON.stringify(data.project_root)}\nStudio window reference: ${JSON.stringify(window)}\n` +
        "Start with host.overview and confirm the project matches. Discover and read application.context for this exact window; distinguish unsaved drafts from disk files. Report the native R session, active document, and available Rho Skills. Read the appropriate Skill when needed. Do not execute R, edit files, save drafts, install packages, or start another Host. If the project or window does not match, report the mismatch.";
    }, "Workspace check copied. Send it in your agent to verify this window.");
  }
  private async copyAction(content: (data: WorkbenchAgentConnection) => string, success: string) {
    if (!this.canCopy) return;
    const generation = this.generation, scope = this.ports.context();
    const current = () => this.visible && generation === this.generation && sameScope(scope, this.ports.context(), true);
    this.copying = true; this.feedback = ""; this.publish();
    try {
      const data = await this.refresh();
      if (!current() || !data) return;
      const text = content(data);
      // The private configuration exists only in this explicit copy operation.
      // It never enters the model snapshot, a DOM preview or persistent state.
      try { await this.ports.copy(text); }
      catch { throw new Error("Copy failed. Allow clipboard access and try again."); }
      if (current()) this.feedback = success;
    } catch (error) { if (current()) this.error = message(error); }
    finally { if (current()) { this.copying = false; this.publish(); } }
  }
  stop() { this.hide(); this.dispose(); }
}
