/** A document's synchronized bytes and its original save intent. Presentation
 * state contains references, never an alternative body or file-save receipt. */
import type { DocumentDraft, DraftSource, JsonValue, SaveDocumentDraft } from '../public/plugin-protocol/index.js';
import { captureDraftContent, stageDraftContent, readDraft, isDocumentDraft, isDraftContent, MAX_DRAFT_BYTES } from '../public/plugin-ui/index.js';
import { type Client, type Intent, type RecordReply, inspectOriginal, verifyOriginal, json, same, canonical, terminal } from './operations.js';
export interface DraftState { schema: 1; draft: DocumentDraft | null; pending: Intent | null; }
const empty = (): DraftState => ({ schema: 1, draft: null, pending: null });
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
export class DraftSync {
  private state: DraftState;
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private transfers = new AbortController();
  private last: RecordReply | null = null;
  private acknowledged: string;
  readonly source: DraftSource;
  constructor(private readonly client: Client) {
    this.source = Object.freeze({ revision: client.view.instance.revision, contribution: client.view.contribution });
    const saved = client.view.state;
    this.acknowledged = canonical(saved);
    if (saved !== null && (typeof saved !== 'object' || Array.isArray(saved))) throw new Error('The saved Studio state is invalid.');
    this.state = saved && Object.keys(saved).length ? structuredClone(saved) as unknown as DraftState : empty();
    if (this.state.schema !== 1 || !Object.hasOwn(this.state, 'draft') || !Object.hasOwn(this.state, 'pending') ||
      Object.keys(this.state).some(key => !['schema', 'draft', 'pending'].includes(key))) throw new Error('The saved Studio state has an unsupported format.');
    if (this.state.draft !== null) this.checkDraft(this.state.draft);
    if (this.state.pending !== null) this.checkIntent(this.state.pending);
  }
  get snapshot(): DraftState { return structuredClone(this.state); }
  get unresolved() { return this.state.pending !== null; }
  private checkDraft(record: unknown): asserts record is DocumentDraft {
    const view = this.client.view;
    if (!isDocumentDraft(record) || record.discarded || record.project !== view.project || record.principal !== view.principal ||
      record.window !== view.window || !same(record.source, this.source)) throw new Error('The draft belongs to another source, window or scope.');
  }
  private checkIntent(intent: Intent) {
    if (!intent || !identity(intent.view) || !identity(intent.request) || !(intent.operation === null || typeof intent.operation === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(intent.operation)) ||
      !same(intent.capability, { id: 'documents.save', version: 1 })) throw new Error('The retained draft save has an invalid identity.');
    const args = intent.arguments as unknown as SaveDocumentDraft;
    if (!args || !identity(args.draft) || !identity(args.upload) || args.window !== this.client.view.window || !same(args.source, this.source) ||
      !isDraftContent(args.content) || args.expected_version !== (this.state.draft?.version ?? null) ||
      this.state.draft !== null && args.draft !== this.state.draft.draft) throw new Error('The retained draft save differs from its original source or version.');
  }
  private live() { if (this.stopped) throw new Error('The Studio draft connection is closed. Accepted work is unchanged.'); }
  private async persist() {
    this.live(); const encoded = canonical(this.state);
    if (encoded === this.acknowledged) return;
    await this.client.setState(json(this.state)); this.live(); this.acknowledged = encoded;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => { this.live(); return work(); }); this.queue = next.catch(() => undefined); return next;
  }
  /** Reads only an acknowledged exact version. Pending requests need explicit
   * inspection first; a newer stored version is never assumed to be their result. */
  read(): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.serial(async () => {
      const content = this.state.draft === null ? null : await readDraft(this.client, this.state.draft, { signal: this.transfers.signal }); this.live(); return content;
    });
  }
  save(input: Uint8Array, metadata: JsonValue = null): Promise<DocumentDraft> {
    // Freeze before entering the queue; edits made while another save settles
    // cannot modify this request. A pending original is never silently replaced.
    if (!(input instanceof Uint8Array) || input.byteLength > MAX_DRAFT_BYTES) return Promise.reject(new Error('Studio draft content exceeds its byte limit.'));
    const bytes = new Uint8Array(input), savedMetadata = structuredClone(metadata);
    return this.serial(async () => {
      if (this.state.pending) throw new Error('Inspect the original unconfirmed draft save before synchronizing another capture.');
      const capture = await captureDraftContent(bytes, { signal: this.transfers.signal }); this.live();
      const previous = this.state.draft;
      if (previous && same(previous.content, capture.content) && same(previous.metadata, savedMetadata)) {
        // A prior save may have succeeded while its reference acknowledgement
        // was lost. Persist that exact reference again without another save.
        const observed = await this.client.query<{ status: string; data?: unknown }>({ id: 'documents.inspect', version: 1 },
          { window: previous.window, draft: previous.draft }); this.live();
        if (observed.status !== 'ready' || !same(observed.data, previous)) throw new Error('The synchronized draft version changed. This view is retained.');
        await this.persist(); return structuredClone(previous);
      }
      const draft = previous?.draft ?? crypto.randomUUID(), upload = crypto.randomUUID();
      const content = await stageDraftContent(this.client, { draft, upload }, capture, { signal: this.transfers.signal }); this.live();
      const args: SaveDocumentDraft = { window: this.client.view.window, draft, upload, source: this.source,
        expected_version: previous?.version ?? null, content, metadata: savedMetadata };
      this.state.pending = { view: this.client.view.view, request: crypto.randomUUID(), capability: { id: 'documents.save', version: 1 },
        arguments: json(args), operation: null };
      await this.persist(); return this.submit();
    });
  }
  private async submit(): Promise<DocumentDraft> {
    const intent = this.state.pending!; this.checkIntent(intent);
    if (intent.view !== this.client.view.view) throw new Error('This draft save belongs to another view. Inspect its original Operation; it cannot be replayed here.');
    await this.persist();
    const record = await verifyOriginal(await this.client.invoke(intent.capability, structuredClone(intent.arguments), { requestId: intent.request }), intent);
    this.live(); intent.operation = record.operation.operation_id; await this.persist();
    return this.waitOriginal();
  }
  retryOriginal(): Promise<DocumentDraft> { return this.serial(async () => {
    if (!this.state.pending) throw new Error('No unconfirmed draft save is retained.');
    return this.submit();
  }); }
  private async waitOriginal(): Promise<DocumentDraft> {
    for (;;) {
      this.live(); const record = await inspectOriginal(this.client, this.state.pending!); this.live();
      if (terminal(record.status)) return this.settle(record);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  /** Bounded observation. Does not replay, reconcile or synthesize a success from
   * matching current bytes. It also works for copied state in another view. */
  inspect(): Promise<RecordReply> { return this.serial(async () => {
    if (!this.state.pending) throw new Error('No unconfirmed draft save is retained.');
    const record = await inspectOriginal(this.client, this.state.pending); this.live();
    this.last = record;
    if (record.status === 'succeeded') await this.settle(record);
    else { this.state.pending.operation = record.operation.operation_id; await this.persist(); }
    return structuredClone(record);
  }); }
  private async settle(record: RecordReply): Promise<DocumentDraft> {
    this.last = record;
    if (record.status !== 'succeeded') throw new Error(record.error || `The original draft save is ${record.status}. Its capture is still unconfirmed.`);
    const draft = record.output; this.checkDraft(draft);
    const args = this.state.pending!.arguments as unknown as SaveDocumentDraft;
    if (draft.draft !== args.draft || draft.version !== (args.expected_version ?? 0) + 1 ||
      !same(draft.content, args.content) || !same(draft.metadata, args.metadata)) throw new Error('The saved draft receipt differs from the original capture.');
    this.state = { schema: 1, draft: structuredClone(draft), pending: null };
    await this.persist(); return structuredClone(draft);
  }
  /** Explicit failure acknowledgement only. Uncertain/active requests retain their
   * original identity; clearing this marker never discards the retained body. */
  acknowledgeFailure(): Promise<void> { return this.serial(async () => {
    if (!this.state.pending) throw new Error('No failed draft save is retained.');
    const record = await inspectOriginal(this.client, this.state.pending); this.live();
    if (!['failed', 'cancelled'].includes(record.status)) throw new Error('The original draft save has no confirmed failure.');
    this.last = record; this.state.pending = null; await this.persist();
  }); }
  get original(): RecordReply | null { return this.last && structuredClone(this.last); }
  stop() { this.stopped = true; this.transfers.abort(); }
}
