import { Model, immutable } from "./shared/model";
import { sameScope, message } from "./shared/ports";
import type { NativeAgentPorts } from "./native-agent-ports";
import type { AgentProvider } from "./generated/AgentProvider";
import type { LocalAgent } from "./generated/LocalAgent";
import type { AgentClientSession } from "./generated/AgentClientSession";
import type { AgentAction } from "./generated/AgentAction";
import type { ConnectAgent } from "./generated/ConnectAgent";

/** Explicit native Agent actions and bounded projections; never chooses a task. */
export class NativeAgents extends Model<{
  catalog: Readonly<Partial<Record<AgentProvider, LocalAgent>>>;
  loading: Readonly<Partial<Record<AgentProvider, boolean>>>;
  connecting: AgentProvider | null;
  sessions: readonly AgentClientSession[];
  error: string;
}> {
  private catalog: Partial<Record<AgentProvider, LocalAgent>> = {};
  private loading: Partial<Record<AgentProvider, boolean>> = {};
  private sessions: AgentClientSession[] = [];
  private connecting: AgentProvider | null = null;
  private error = "";
  private visible = false;
  private generation = 0;
  private revisions = { codex: 0, kimi: 0 };
  private discovered = { codex: false, kimi: false };
  private reading = false;
  private actionRevision = 0;
  private pendingConnect: ConnectAgent | null = null;
  private pendingTests = new Map<string, string>();
  constructor(private ports: NativeAgentPorts) { super(); }
  protected readSnapshot() { return { catalog: Object.freeze({ ...this.catalog }), loading: Object.freeze({ ...this.loading }), connecting: this.connecting, sessions: Object.freeze([...this.sessions]), error: this.error }; }
  show() { this.visible = true; this.ports.schedule(); this.discoverInitial(); }
  hide() { this.visible = false; }
  reset() { this.generation++; this.catalog = {}; this.loading = {}; this.discovered = { codex: false, kimi: false }; this.sessions = []; this.connecting = null; this.reading = false; this.pendingConnect = null; this.pendingTests.clear(); this.error = ""; this.publish(); }
  private discoverInitial() {
    for (const provider of ["codex", "kimi"] as const) if (!this.discovered[provider]) void this.discover(provider);
  }
  async rescan() { await Promise.all([this.discover("codex"), this.discover("kimi")]); }
  async discover(provider: AgentProvider, model: string | null = null) {
    const scope = this.ports.context(), generation = this.generation, revision = ++this.revisions[provider];
    if (!scope.project || !scope.connected) return;
    this.discovered[provider] = true;
    this.loading[provider] = true; this.error = ""; this.publish();
    try {
      const result = await this.ports.discover({ project_root: scope.project, provider, model });
      if (generation === this.generation && revision === this.revisions[provider] && sameScope(scope, this.ports.context())) this.catalog[provider] = immutable(result);
    } catch (error) { if (generation === this.generation && revision === this.revisions[provider]) this.error = message(error); }
    finally { if (generation === this.generation && revision === this.revisions[provider]) { this.loading[provider] = false; this.publish(); } }
  }
  async observe() {
    if (this.visible) this.discoverInitial();
    if (this.reading || (!this.visible && !this.sessions.some(s => ["running", "waiting_for_permission", "uncertain"].includes(s.state)))) return;
    const scope = this.ports.context(), generation = this.generation, actionRevision = this.actionRevision;
    if (!scope.project || !scope.connected) return;
    this.reading = true;
    try {
      const sessions = await this.ports.sessions();
      if (generation === this.generation && actionRevision === this.actionRevision && sameScope(scope, this.ports.context())) {
        this.sessions = immutable(sessions.filter(s => s.project_root === scope.project));
        for (const client of this.sessions) this.acknowledgeTest(client);
        this.publish();
      }
    } catch (error) { if (generation === this.generation) { this.error = message(error); this.publish(); } }
    finally { if (generation === this.generation) this.reading = false; }
  }
  async connect(provider: AgentProvider, model: string, effort: string | null, test = false) {
    if (this.connecting) return;
    const scope = this.ports.context(), window = this.ports.window(), generation = this.generation;
    if (!scope.project || !window || !scope.connected || !scope.ready) {
      this.error = "Wait for this workspace and Studio window to reconnect, then try again.";
      this.publish(); return;
    }
    this.connecting = provider; this.error = ""; this.publish();
    this.actionRevision++;
    try {
      let client = this.sessions.find(s => s.provider === provider && s.model === model && s.effort === effort && s.state !== "disconnected");
      if (!client) {
        const previous = this.sessions.find(s => s.provider === provider && s.state !== "disconnected");
        if (previous) {
          if (["running", "waiting_for_permission", "uncertain"].includes(previous.state)) throw new Error("Wait for the current Agent task or stop it before changing models.");
          await this.ports.action({ project_root: scope.project, window, session_id: previous.id, action: { kind: "disconnect" } });
        }
        const signature = JSON.stringify([scope.project, window, provider, model, effort]);
        const old = this.pendingConnect;
        if (!old || JSON.stringify([old.project_root, old.window, old.provider, old.model, old.effort]) !== signature)
          this.pendingConnect = { project_root: scope.project, window, provider, model, effort, request_id: crypto.randomUUID() };
        const request = this.pendingConnect!;
        client = await this.ports.connect(request);
        if (generation === this.generation && this.pendingConnect?.request_id === request.request_id) this.pendingConnect = null;
      }
      if (generation !== this.generation || !sameScope(scope, this.ports.context())) return;
      this.replace(client);
      if (test) {
        const request_id = this.pendingTests.get(client.id) ?? crypto.randomUUID();
        this.pendingTests.set(client.id, request_id);
        if (await this.act(client.id, { kind: "test", request_id })) this.pendingTests.delete(client.id);
      }
    } catch (error) { if (generation === this.generation) {
      this.error = message(error);
      if (error && typeof error === "object" && "status" in error) this.pendingConnect = null;
    } }
    finally { if (generation === this.generation) { this.actionRevision++; this.connecting = null; this.publish(); this.ports.schedule(); } }
  }
  private acknowledgeTest(client: AgentClientSession) {
    if (client.last_request_id === this.pendingTests.get(client.id) || client.state === "disconnected") this.pendingTests.delete(client.id);
  }
  private replace(client: AgentClientSession) { this.acknowledgeTest(client); this.sessions = [...this.sessions.filter(s => s.id !== client.id), immutable(client)]; this.publish(); }
  async act(id: string, action: AgentAction) {
    const scope = this.ports.context(), window = this.ports.window(), generation = this.generation;
    if (!scope.project || !window) return;
    this.actionRevision++;
    this.error = "";
    try {
      const client = await this.ports.action({ project_root: scope.project, window, session_id: id, action });
      if (generation === this.generation && sameScope(scope, this.ports.context())) { this.replace(client); return true; }
    } catch (error) { if (generation === this.generation) { this.error = message(error); this.publish(); } }
    finally { if (generation === this.generation) { this.actionRevision++; this.ports.schedule(); } }
    return false;
  }
  stop() { this.hide(); this.reset(); this.dispose(); }
}
