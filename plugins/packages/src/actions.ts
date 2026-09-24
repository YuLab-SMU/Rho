import type { InstanceRef, JsonValue, OpenPluginWindowView, PluginWindowLayout, PluginWindowNode } from "../public/plugin-protocol/index.js";
import type { PackageEntry } from "../public/r-protocol/index.js";
import type { PluginViewClient } from "../public/plugin-ui/index.js";
import { operationRequestId } from "../public/plugin-ui/index.js";
import type { PackagesConnection } from "./connection.js";
import { packageCopyKey } from "./packages.js";
import { Model } from "./shared/model.js";

interface PendingAction {
  view: string; request: string; capability: "windows.open_view";
  version: number; arguments: JsonValue;
}
interface Receipt { view: string; id: string; request: string; capability: string; version: number; status: string; error: string; }
interface SavedActions { pending: PendingAction | null; receipt: Receipt | null; }
interface Snapshot extends SavedActions { working: boolean; error: string; }
type Client = Pick<PluginViewClient, "view" | "query" | "invoke">;
type Owner = Pick<PackagesConnection, "source" | "nativeSession" | "packages" | "actionState" | "saveActions">;
interface RecordReply {
  operation: { caller: { kind: string; id: string }; operation_id: string; client_request_id: string; capability: { id: string; version: number }; normalized_arguments: JsonValue };
  status: string; outcome?: string | null; output?: unknown; error?: string | null;
}
const json = (value: unknown) => value as JsonValue;
const canonical = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const message = (value: unknown) => value instanceof Error ? value.message : String(value);
const statuses = ["accepted", "running", "reconciling", "succeeded", "failed", "cancelled", "uncertain"];

/** Explicit view actions retain their original request before submission. A lost
 * acknowledgement never changes request identity, provider or observed installed copy. */
export class PackagesActions extends Model<Snapshot> {
  private state: SavedActions;
  private task: Promise<void> | null = null;
  private error = "";
  private stopped = false;
  constructor(private client: Client, private owner: Owner, readonly group: string | null, private readonly helpInstance: InstanceRef | null) {
    super();
    this.helpInstance = helpInstance ? Object.freeze(structuredClone(helpInstance)) : null;
    const saved = owner.actionState as Partial<SavedActions> | null;
    this.state = { pending: structuredClone(saved?.pending ?? null), receipt: structuredClone(saved?.receipt ?? null) };
  }
  protected readSnapshot(): Snapshot { return { ...structuredClone(this.state), working: this.task !== null, error: this.error }; }
  private async save() { await this.owner.saveActions(json(this.state)); }
  private active(action: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Packages actions are closed."));
    if (this.task) return Promise.reject(new Error("Wait for the current Packages action."));
    this.error = "";
    this.task = Promise.resolve().then(() => { if (this.stopped) throw new Error("Packages actions are closed."); return action(); }).catch(error => { if (!this.stopped) this.error = message(error); throw error; })
      .finally(() => { this.task = null; if (!this.stopped) this.publish(); });
    this.publish(); return this.task;
  }
  private requireNew() {
    if (this.state.pending) throw new Error("Inspect or retry the original unconfirmed action before starting another.");
  }
  openDocumentation(selected: PackageEntry): Promise<void> {
    return this.active(async () => {
      this.requireNew();
      if (!this.helpInstance) throw new Error("Select a Help provider in this view's configuration.");
      const packages = this.owner.packages, session = packages.session, observation = packages.data?.observation_id;
      const copy = packages.details.get(selected.name)?.copies.find(copy => packageCopyKey(copy) === packageCopyKey(selected));
      if (!copy?.library_path || !observation || !session || session !== this.owner.nativeSession || packages.expired)
        throw new Error("Select an installed copy from the current Packages observation.");
      // Capture the selected evidence before observing layout. A concurrent
      // refresh cannot silently replace the selected copy or its observation.
      const configuredCopy = { nativeSession: session, observation, package: copy.name, libraryPath: copy.library_path, version: copy.version };
      const result = await this.client.query<{ status: string; data?: PluginWindowLayout }>({ id: "windows.layout", version: 1 }, { window: this.client.view.window });
      if (this.stopped) throw new Error("Packages actions are closed.");
      const layout = result.data, view = this.client.view;
      if (result.status !== "ready" || !layout || layout.window !== view.window || layout.project !== view.project || layout.principal !== view.principal)
        throw new Error("The containing window layout is unavailable.");
      const findGroup = (node: PluginWindowNode): string | null => node.kind === "tabs"
        ? (this.group === null ? node.views.includes(view.view) : node.id === this.group) ? node.id : null
        : node.kind === "split" ? node.children.map(findGroup).find(id => id !== null) ?? null : null;
      const group = findGroup(layout.layout);
      if (group === null && (this.group !== null || layout.layout.kind !== "empty"))
        throw new Error("The configured destination tab group is unavailable in this window.");
      const args: OpenPluginWindowView = {
        view: { instance: this.helpInstance, contribution: "help", window: view.window,
          configuration: json({ source: this.owner.source, copy: configuredCopy, topic: null }), state: {} },
        expected_layout_version: layout.version, group,
      };
      this.state.pending = { view: view.view, request: crypto.randomUUID(), capability: "windows.open_view", version: 1, arguments: json(args) };
      this.publish(); await this.submit();
    });
  }
  retry(): Promise<void> { return this.active(() => this.submit()); }
  private async submit() {
    const pending = this.state.pending;
    if (!pending || pending.view !== this.client.view.view) throw new Error("This action belongs to another view. Inspect its original Operation; copied state cannot replay it.");
    this.validatePending(pending);
    await this.save();
    if (this.stopped) throw new Error("Packages actions are closed.");
    const record = await this.client.invoke<RecordReply>({ id: pending.capability, version: pending.version }, structuredClone(pending.arguments), { requestId: pending.request });
    if (this.stopped) return;
    if (!await this.matchesPending(record, pending))
      throw new Error("The reply does not match the original Packages action.");
    if (this.stopped) return;
    if (["succeeded", "failed", "cancelled", "uncertain"].includes(record.status) && record.outcome !== record.status)
      throw new Error("The original action has no matching terminal outcome.");
    this.state.receipt = { view: pending.view, id: record.operation.operation_id, request: pending.request, capability: pending.capability,
      version: pending.version, status: record.status, error: record.error ?? "" };
    // An accepted Operation is now the recovery identity. No automatic re-invoke.
    this.state.pending = null; await this.save(); this.publish();
    if (["failed", "cancelled", "uncertain"].includes(record.status)) throw new Error(record.error || `The original action is ${record.status}.`);
  }
  private validatePending(pending: PendingAction) {
    if (!pending.request || typeof pending.request !== "string") throw new Error("The saved action has no request identity.");
    const args = pending.arguments as Record<string, any>, view = this.client.view;
    const exact = (source: InstanceRef) => same(source, this.owner.source);
    if (pending.capability !== "windows.open_view" || pending.version !== 1 || !this.helpInstance ||
      !args?.view || !same(args.view.instance, this.helpInstance) || args.view.window !== view.window ||
      args.view.contribution !== "help" || !exact(args.view.configuration?.source) || !args.view.configuration?.copy?.observation ||
      args.view.configuration.copy.nativeSession !== this.owner.nativeSession)
      throw new Error("The saved navigation no longer matches its original view or provider.");
  }

  private async matchesPending(record: RecordReply | null | undefined, pending: PendingAction): Promise<boolean> {
    return !!record?.operation && record.operation.caller?.kind === "plugin" && record.operation.caller.id === pending.view &&
      record.operation.client_request_id === await operationRequestId(pending.view, pending.request) && record.operation.capability.id === pending.capability &&
      record.operation.capability.version === pending.version && same(record.operation.normalized_arguments, pending.arguments) &&
      statuses.includes(record.status) && typeof record.operation.operation_id === "string";
  }
  private async readOperation(id: string): Promise<RecordReply> {
    const response = await this.client.query<{ status: string; data?: { record?: RecordReply } }>({ id: "operation.get", version: 1 }, { operation_id: id });
    if (response.status !== "ready" || !response.data?.record) throw new Error("The original Operation is unavailable.");
    return response.data.record;
  }
  /** Lookup is read-only and works after a copied view reopens. It never sends
   * the saved request from the new caller or treats absence as non-acceptance. */
  inspectPending(): Promise<void> {
    return this.active(async () => {
      const pending = this.state.pending;
      if (!pending) throw new Error("No unconfirmed action is retained.");
      const response = await this.client.query<{ status: string; data?: { operations: { operation_id: string }[] } }>(
        { id: "operation.list_recent", version: 1 }, { client_request_id: await operationRequestId(pending.view, pending.request), limit: 10 });
      if (response.status !== "ready" || !Array.isArray(response.data?.operations) || response.data.operations.length > 10)
        throw new Error("The original request observation is unavailable.");
      const matches: RecordReply[] = [];
      for (const item of response.data.operations) {
        const record = await this.readOperation(item.operation_id);
        if (await this.matchesPending(record, pending)) matches.push(record);
      }
      if (matches.length !== 1) throw new Error("No unique original Operation was found in this bounded observation. The request remains unconfirmed.");
      if (this.stopped) return;
      const record = matches[0];
      this.state.receipt = { view: pending.view, id: record.operation.operation_id, request: pending.request,
        capability: pending.capability, version: pending.version, status: record.status, error: record.error ?? "" };
      this.state.pending = null; await this.save();
    });
  }
  inspect(): Promise<void> {
    return this.active(async () => {
      const receipt = this.state.receipt;
      if (!receipt) throw new Error("No acknowledged Operation is available to inspect.");
      const record = await this.readOperation(receipt.id);
      if (!record?.operation || record.operation.operation_id !== receipt.id || record.operation.client_request_id !== await operationRequestId(receipt.view, receipt.request) ||
        record.operation.caller?.kind !== "plugin" || record.operation.caller.id !== receipt.view ||
        record.operation.capability.id !== receipt.capability || record.operation.capability.version !== receipt.version || !statuses.includes(record.status))
        throw new Error("The observation belongs to another Operation.");
      if (this.stopped) return;
      this.state.receipt = { ...receipt, status: record.status, error: record.error ?? "" }; await this.save();
    });
  }
  async settled() { await this.task?.catch(() => undefined); }
  stop() { this.stopped = true; this.dispose(); }
}
