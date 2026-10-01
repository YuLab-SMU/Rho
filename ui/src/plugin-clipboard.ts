/** Native presentation effect owned by one opaque view container. Text is never
 * retained as view state or an Operation. Browser completion is the only success. */
interface Reservation {
  id: string;
  submit(value: Blob): void;
  reject(error: Error): void;
  completion: Promise<void>;
  timeout: ReturnType<typeof setTimeout>;
  submitted: boolean;
}
export class PluginClipboard {
  private current: Reservation | null = null;
  constructor(private readonly write: (text: Promise<Blob>) => Promise<void>) {}
  begin() {
    if (this.current) throw new Error("A text copy is already in progress in this view.");
    let submit!: Reservation["submit"], reject!: Reservation["reject"];
    const text = new Promise<Blob>((yes, no) => { submit = yes; reject = no; });
    void text.catch(() => undefined);
    let completion: Promise<void>;
    try { completion = this.write(text); }
    catch { reject(new Error("Clipboard access is unavailable.")); throw new Error("Clipboard access is unavailable."); }
    const id = crypto.randomUUID();
    const reservation: Reservation = { id, submit, reject, completion,
      timeout: setTimeout(() => this.cancel(id), 60000), submitted: false };
    this.current = reservation;
    // Native rejection may precede delivery of the completed text. Retain the
    // original result for finish(), without an unhandled promise rejection.
    void completion.catch(() => undefined);
    return { copy_id: id };
  }
  async finish(id: string, text: string) {
    const reservation = this.current;
    if (!reservation || reservation.id !== id) throw new Error("Text copy reservation is no longer available.");
    if (reservation.submitted) throw new Error("Text copy was already submitted.");
    if (new TextEncoder().encode(text).length > 1024 * 1024) throw new Error("Text copy exceeds 1 MiB.");
    reservation.submitted = true; clearTimeout(reservation.timeout);
    reservation.submit(new Blob([text], { type: "text/plain" }));
    try { await reservation.completion; return { copied: true }; }
    catch { throw new Error("Clipboard write was not confirmed by the browser."); }
    finally { if (this.current === reservation) this.current = null; }
  }
  cancel(id: string) {
    const reservation = this.current;
    if (!reservation || reservation.id !== id) return { released: false };
    if (reservation.submitted) return { released: false };
    clearTimeout(reservation.timeout); this.current = null;
    reservation.reject(new Error("Text copy reservation ended before submission."));
    return { released: true };
  }
  dispose() {
    const reservation = this.current;
    if (!reservation) return;
    clearTimeout(reservation.timeout); this.current = null;
    if (!reservation.submitted) reservation.reject(new Error("The view closed before text copy submission."));
  }
}
