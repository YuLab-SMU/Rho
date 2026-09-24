import type { PluginViewLifecycle, PluginViewRequest } from "../plugin-protocol/index.js";

export interface ViewCloseHandler {
  /** Pause presentation updates, capture the latest local draft and await its
   * acknowledged save. Do not wait for or cancel accepted scientific work. */
  flush(): Promise<void>;
  resume?(): void;
}
export interface ViewCloseSnapshot { preparing: boolean; operation: string | null; error: string; }
export interface ViewClosePort {
  view: string;
  version(): number;
  stateSettled(): Promise<unknown>;
  request<T>(body: PluginViewRequest): Promise<T>;
}

/** One document can acknowledge only its own flush. An ended channel retains
 * uncertain preparation; disposal is never evidence that a draft was saved. */
export class ViewCloseCooperation {
  private readonly renderer = crypto.randomUUID();
  private snapshot: ViewCloseSnapshot = { preparing: false, operation: null, error: "" };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private observing: Promise<void> | null = null;
  private stopped = false;
  private composing = false;
  private wasInert = false;
  private frozen = false;
  private focused: HTMLElement | null = null;
  private compositionStart = () => { this.composing = true; };
  private compositionEnd = () => { this.composing = false; };
  constructor(private port: ViewClosePort, private handler: ViewCloseHandler) {}
  getSnapshot = (): ViewCloseSnapshot => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: ViewCloseSnapshot) { this.snapshot = next; for (const listener of this.listeners) listener(); }
  async start(): Promise<void> {
    if (typeof document !== "undefined") {
      document.addEventListener("compositionstart", this.compositionStart, true);
      document.addEventListener("compositionend", this.compositionEnd, true);
    }
    // Listen before awaiting registration: an editor can begin composition while
    // that first Host acknowledgement is still in flight.
    await this.port.request({ type: "register_close_handler", renderer: this.renderer });
    if (this.stopped) return;
    this.schedule();
  }
  private schedule() {
    if (!this.stopped) this.timer = setTimeout(() => { void this.observe().catch(() => undefined); }, 250);
  }
  /** Also useful when a container becomes visible; concurrent observations join
   * the same attempt and cannot flush or acknowledge a close twice. */
  observe(): Promise<void> {
    if (this.observing) return this.observing;
    if (this.stopped) return Promise.resolve();
    clearTimeout(this.timer);
    const task = this.poll().catch(error => {
      if (!this.stopped) {
        this.publish({ ...this.snapshot, error: `Close confirmation unavailable: ${error instanceof Error ? error.message : String(error)}` });
        // A broken channel cannot establish whether native closure committed.
        this.stopped = true;
      }
      throw error;
    }).finally(() => { this.observing = null; this.schedule(); });
    this.observing = task;
    return task;
  }
  private freeze() {
    if (typeof document === "undefined") return;
    this.wasInert = document.body.inert;
    this.frozen = true;
    this.focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.inert = true;
  }
  private restore() {
    if (typeof document === "undefined" || !this.frozen) return;
    document.body.inert = this.wasInert;
    this.frozen = false;
    if (this.focused?.isConnected && !this.wasInert) this.focused.focus({ preventScroll: true });
    this.focused = null;
  }
  private async poll() {
    const lifecycle = await this.port.request<PluginViewLifecycle>({ type: "observe_lifecycle", renderer: this.renderer });
    if (this.stopped) return;
    if (lifecycle.view !== this.port.view || !lifecycle.close) throw new Error("View lifecycle identity changed.");
    const close = lifecycle.close;
    if (close.phase === "open") {
      if (this.snapshot.preparing) {
        this.restore();
        this.handler.resume?.();
        this.publish({ ...this.snapshot, preparing: false, operation: null });
      }
      return;
    }
    if (close.phase === "refused") {
      this.publish({ ...this.snapshot, error: close.reason });
      return;
    }
    if (close.phase !== "requested" || this.snapshot.operation === close.operation) return;
    if (this.snapshot.preparing) { this.restore(); this.handler.resume?.(); }
    const composing = this.composing;
    // Making a composing editor inert can itself end composition. Refuse first
    // and preserve the user's native input surface and focus.
    if (!composing) this.freeze();
    this.publish({ preparing: true, operation: close.operation, error: "" });
    try {
      if (composing) throw new Error("Finish composing text before closing this view.");
      await this.handler.flush();
      await this.port.stateSettled();
      if (this.stopped) return;
    } catch (error) {
      if (this.stopped) return;
      const reason = error instanceof Error ? error.message : String(error);
      this.publish({ ...this.snapshot, error: `Close preparation failed: ${reason}` });
      // Limit by UTF-8 bytes, without cutting a multibyte character.
      let bounded = "";
      for (const char of reason || "View state could not be saved.") {
        if (new TextEncoder().encode(bounded + char).length > 4096) break;
        bounded += char;
      }
      await this.port.request({ type: "refuse_close", renderer: this.renderer, operation: close.operation, reason: bounded }).catch(() => undefined);
      return;
    }
    // A lost acknowledgement can follow a committed close. Keep uncertainty
    // distinct from a flush refusal; the container owns the original Operation.
    try { await this.port.request({ type: "prepare_close", renderer: this.renderer, operation: close.operation, state_version: this.port.version() }); }
    catch (error) {
      if (!this.stopped) this.publish({ ...this.snapshot, error: `Close acknowledgement is unconfirmed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  dispose() {
    this.stopped = true; clearTimeout(this.timer);
    if (typeof document !== "undefined") {
      document.removeEventListener("compositionstart", this.compositionStart, true);
      document.removeEventListener("compositionend", this.compositionEnd, true);
    }
    if (this.snapshot.preparing) this.restore();
    this.listeners.clear();
  }
}
