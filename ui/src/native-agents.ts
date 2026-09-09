import { Model, immutable } from "./shared/model";
import { sameScope, message } from "./shared/ports";
import type { NativeAgentPorts } from "./native-agent-ports";
import type { AgentProvider } from "./generated/AgentProvider";
import type { LocalAgent } from "./generated/LocalAgent";
import type { AgentDiagnostic } from "./generated/AgentDiagnostic";
import type { TestAgent } from "./generated/TestAgent";
const providers = ["codex", "kimi", "deepseek"] as const;

/** Settings discovery and isolated diagnostics. Daily conversation belongs to AgentTasks. */
export class NativeAgents extends Model<{
  catalog: Readonly<Partial<Record<AgentProvider, LocalAgent>>>;
  loading: Readonly<Partial<Record<AgentProvider, boolean>>>;
  installing: AgentProvider | null; connecting: AgentProvider | null;
  diagnostics: Readonly<Partial<Record<AgentProvider, AgentDiagnostic>>>; error: string;
}> {
  private catalog: Partial<Record<AgentProvider, LocalAgent>> = {};
  private loading: Partial<Record<AgentProvider, boolean>> = {};
  private diagnostics: Partial<Record<AgentProvider, AgentDiagnostic>> = {};
  private pending = new Map<AgentProvider, TestAgent>();
  private connecting: AgentProvider | null = null;
  private installing: AgentProvider | null = null;
  private error = ""; private visible = false; private generation = 0;
  private revisions = { codex: 0, kimi: 0, deepseek: 0 };
  private discovered = { codex: false, kimi: false, deepseek: false };
  private discoveryQueue: Promise<void> = Promise.resolve();
  private reading = false;
  constructor(private ports: NativeAgentPorts) { super(); }
  protected readSnapshot() { return { catalog: Object.freeze({ ...this.catalog }), loading: Object.freeze({ ...this.loading }), installing: this.installing, connecting: this.connecting, diagnostics: Object.freeze({ ...this.diagnostics }), error: this.error }; }
  show() { this.visible = true; this.discoverInitial(); this.ports.schedule(); }
  hide() { this.visible = false; }
  reset() { this.generation++; this.catalog = {}; this.loading = {}; this.diagnostics = {}; this.pending.clear(); this.discovered = { codex: false, kimi: false, deepseek: false }; this.connecting = this.installing = null; this.reading = false; this.error = ""; this.publish(); }
  private discoverInitial() { for (const provider of providers) if (!this.discovered[provider]) void this.discover(provider); }
  async rescan() { const generation = this.generation; for (const provider of providers) { if (generation !== this.generation) return; await this.discover(provider); } }
  async discover(provider: AgentProvider, model: string | null = null) {
    const scope = this.ports.context(), generation = this.generation, revision = ++this.revisions[provider];
    if (!scope.project || !scope.connected) return;
    this.discovered[provider] = true;
    this.loading[provider] = true; this.error = ""; this.publish();
    const current = () => generation === this.generation && revision === this.revisions[provider] && sameScope(scope, this.ports.context());
    // Keep one discovery in flight, leaving Host capacity for an explicit connection.
    // Queued reads from a previous project must never launch another CLI.
    const request = this.discoveryQueue.then(async () => {
      try {
        if (!current()) return;
        const result = await this.ports.discover({ project_root: scope.project!, provider, model });
        if (current()) this.catalog[provider] = immutable(result);
      } catch (error) { if (current()) this.error = message(error); }
      finally { if (generation === this.generation && revision === this.revisions[provider]) { this.loading[provider] = false; this.publish(); } }
    });
    this.discoveryQueue = request;
    await request;
  }
  async setup(provider: AgentProvider) {
    const scope = this.ports.context(), generation = this.generation;
    if (!scope.project || !scope.connected || this.installing || this.connecting || this.loading[provider]) return;
    const revision = ++this.revisions[provider];
    this.installing = provider; this.loading[provider] = true; this.error = ""; this.publish();
    try {
      const result = await this.ports.setup({ project_root: scope.project, provider });
      if (generation === this.generation && revision === this.revisions[provider] && sameScope(scope, this.ports.context())) {
        this.catalog[provider] = immutable(result); this.discovered[provider] = true;
      }
    } catch (error) { if (generation === this.generation) this.error = message(error); }
    finally { if (generation === this.generation) { this.installing = null; this.loading[provider] = false; this.publish(); } }
  }
  async test(provider: AgentProvider, model: string, effort: string | null) {
    const scope = this.ports.context(), window = this.ports.window(), generation = this.generation;
    if (!scope.project || !scope.connected || !window || this.pending.has(provider)) return;
    const request: TestAgent = { project_root: scope.project, window, provider, model, effort, request_id: crypto.randomUUID(), observe_only: false };
    this.pending.set(provider, request); this.connecting = provider; this.error = ""; this.publish();
    try { const result = await this.ports.test(request); if (generation === this.generation && sameScope(scope, this.ports.context())) this.apply(result); }
    catch (error) { if (generation === this.generation) this.error = message(error); }
    finally { if (generation === this.generation) { if (this.pending.has(provider)) this.pending.set(provider, { ...request, observe_only: true }); this.publish(); this.ports.schedule(); } }
  }
  private apply(result: AgentDiagnostic) {
    this.diagnostics[result.provider] = immutable(result);
    if (result.state !== "running") { this.pending.delete(result.provider); if (this.connecting === result.provider) this.connecting = null; }
    this.publish();
  }
  async observe() {
    if (this.visible) this.discoverInitial();
    if (this.reading || !this.ports.context().connected || !this.pending.size) return;
    const scope = this.ports.context(), generation = this.generation; this.reading = true;
    try {
      for (const pending of this.pending.values()) {
        if (!pending.observe_only || !sameScope(scope, this.ports.context()) || generation !== this.generation) continue;
        const result = await this.ports.test({ ...pending, observe_only: true });
        if (generation === this.generation && sameScope(scope, this.ports.context())) this.apply(result);
      }
    } catch (error) { if (generation === this.generation) { this.error = message(error); this.publish(); } }
    finally { if (generation === this.generation) this.reading = false; }
  }
  stop() { this.hide(); this.reset(); this.dispose(); }
}
