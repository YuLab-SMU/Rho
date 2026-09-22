import { describe, expect, it, vi } from "vitest";
import type { HtmlViewToken } from "../src/generated/HtmlViewToken";
import type { MediaReference } from "../src/generated/MediaReference";
import { Viewer } from "../src/viewer";

const reference = (sequence: number, mime_type = "text/html"): MediaReference => ({
  operation_id: "operation-1",
  sequence,
  mime_type,
  byte_size: 100,
  sha256: `sha256:${String(sequence).padStart(64, "0")}`,
  display_id: null,
});
const token = (path: string): HtmlViewToken => ({
  path,
  expires_at_ms: Date.now() + 60_000,
  surface: { surface_id: "operation-1:1", surface_type: "html_widget", state: "saved", reference: reference(1), session_id: null },
});

function fixture(html: readonly MediaReference[] = []) {
  let context = { epoch: 1, project: "/tmp/project", session: "session", runtimeState: "ready", connected: true, capabilities: [] };
  const listeners = new Set<() => void>();
  const outputs = {
    getSnapshot: () => ({ html }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  } as never;
  const htmlViewToken = vi.fn<(project: string, ref: MediaReference) => Promise<HtmlViewToken>>();
  const viewer = new Viewer({ outputs, context: () => context, htmlViewToken, changed: vi.fn() });
  return { viewer, htmlViewToken, setContext: (next: typeof context) => { context = next; }, notify: () => listeners.forEach(listener => listener()) };
}

describe("Viewer", () => {
  it("mints one private view path per retained HTML reference and refreshes it explicitly", async () => {
    const first = reference(1), second = reference(2), state = fixture([first, second]);
    state.htmlViewToken.mockResolvedValueOnce(token("/view/html/first")).mockResolvedValueOnce(token("/view/html/second"));
    state.viewer.select(first);
    await state.viewer.ensurePath(first);
    expect(state.htmlViewToken).toHaveBeenCalledWith("/tmp/project", first);
    expect(state.viewer.getSnapshot().path).toBe("/view/html/first");
    await state.viewer.ensurePath(first);
    expect(state.htmlViewToken).toHaveBeenCalledTimes(1);
    state.viewer.refresh(first);
    await vi.waitFor(() => expect(state.viewer.getSnapshot().path).toBe("/view/html/second"));
    expect(state.htmlViewToken).toHaveBeenCalledTimes(2);
    expect(state.viewer.selectedReference()).toEqual(first);
    expect(state.viewer.getSnapshot().selected).not.toBe(state.viewer.getSnapshot().selected === null ? null : `${second.operation_id}:${second.sequence}:${second.sha256}`);
  });

  it("does not commit a token returned for an old project scope", async () => {
    const first = reference(1), state = fixture([first]);
    let resolve: (value: HtmlViewToken) => void = () => {};
    state.htmlViewToken.mockReturnValue(new Promise<HtmlViewToken>(accept => { resolve = accept; }));
    state.viewer.select(first);
    const request = state.viewer.ensurePath(first);
    state.setContext({ epoch: 2, project: "/tmp/other", session: "session", runtimeState: "ready", connected: true, capabilities: [] });
    resolve(token("/view/html/stale"));
    await request;
    expect(state.viewer.getSnapshot().path).toBeNull();
    expect(state.viewer.getSnapshot().error).toBeNull();
  });

  it("restores selected HTML identity without restoring a bearer or capability path", () => {
    const first = reference(1), state = fixture([first]);
    state.viewer.restore({ selected: `${first.operation_id}:${first.sequence}:${first.sha256}`, follow: false, history: false, path: "/view/html/should-not-persist" });
    expect(state.viewer.selectedReference()).toEqual(first);
    expect(state.viewer.getSnapshot()).toMatchObject({ selected: `${first.operation_id}:${first.sequence}:${first.sha256}`, history: false, path: null, loading: false });
    expect(state.viewer.serialize()).toEqual({ selected: `${first.operation_id}:${first.sequence}:${first.sha256}`, follow: false, history: false });
  });

  it("keeps image plots out of the HTML selection", () => {
    const first = reference(1, "image/png"), state = fixture([]);
    state.viewer.select(first);
    state.notify();
    expect(state.viewer.selectedReference()).toBeNull();
    expect(state.viewer.getSnapshot().selected).toBeNull();
  });
});
