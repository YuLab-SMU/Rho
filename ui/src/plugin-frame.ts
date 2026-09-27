import type { PluginViewConnection, PluginViewMessage, PluginViewRequest, ReleasePluginViewRenderer } from "../../sdk/plugin-protocol/index.js";
import type { SessionReply } from "./generated/SessionReply";
import { HostClient, json } from "./host-client";
import { requestExternalNavigation } from "./plugin-external";
import { PluginDownloads } from "./plugin-download";
import { PluginClipboard } from "./plugin-clipboard";

const maxMessage = 1024 * 1024;
function bounded(value: unknown) {
  try { return new TextEncoder().encode(JSON.stringify(value)).length <= maxMessage; } catch { return false; }
}
/** Generic composition primitive: opaque iframe, private MessagePort, immutable
 * assets and the same scoped Host ports. No scientific component is imported. */
export function mountPluginFrame(container: HTMLElement, client: HostClient, project: string, connection: PluginViewConnection,
  failed: (error: string) => void): () => void {
  const iframe = document.createElement("iframe");
  const surface = document.createElement("div");
  surface.style.cssText = "display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0";
  if (connection.view.purpose === "fixture_preview") {
    const notice = document.createElement("div");
    notice.setAttribute("role", "note");
    notice.dataset.pluginPreview = "fixture";
    notice.textContent = "Fixture preview · Scientific writes disabled";
    notice.style.cssText = "flex:none;padding:6px 12px;font:14px/20px var(--font-ui,system-ui);color:var(--color-success,#25775b);background:var(--color-subtle,#f8fafc);border-bottom:1px solid var(--color-border,#dde3ec);overflow-wrap:anywhere";
    surface.append(notice);
  }
  iframe.title = connection.view.contribution;
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("allow", "clipboard-read 'none'; clipboard-write 'none'; camera 'none'; microphone 'none'; geolocation 'none'");
  iframe.style.cssText = "flex:1;min-height:0;width:100%;height:0;border:0;display:block;background:white";
  const nonce = crypto.randomUUID();
  iframe.src = `${client.pluginAssetUrl(connection.connection, connection.asset_token, connection.entrypoint)}#rho-view-nonce=${nonce}`;
  const channel = new MessageChannel();
  const clipboardAvailable = typeof ClipboardItem === "function" && typeof navigator.clipboard?.write === "function";
  const clipboard = new PluginClipboard(text => navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]));
  let disposed = false, loaded = false, sequence = 0, replies = 0, serverSequence = connection.next_sequence - 1, pending = 0;
  const renderers = new Set<string>();
  const rendererIds = new Map<string, string>();
  const scopedBody = (body: PluginViewRequest): PluginViewRequest => {
    if (!["register_close_handler", "observe_lifecycle", "prepare_close", "refuse_close"].includes(body.type)) return body;
    if (!("renderer" in body) || typeof body.renderer !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(body.renderer))
      throw new Error("The document sent an invalid close-handler identity.");
    let renderer = rendererIds.get(body.renderer);
    if (!renderer && body.type === "register_close_handler" && rendererIds.size < 32) {
      renderer = crypto.randomUUID(); rendererIds.set(body.renderer, renderer);
    }
    if (!renderer) throw new Error("This document has not registered that close handler.");
    // Document-local SDK names cannot select another iframe's native handler,
    // even when two documents intentionally choose the same public name.
    return { ...body, renderer };
  };
  const releaseRenderer = (renderer: string) => {
    // Separate Control does not consume the shared view sequence: an ending
    // document must not race the next document's bootstrap sequence.
    void client.port(project, { method: "control", params: {
      capability: { id: "views.release_renderer", version: 1 },
      arguments: json({ view: connection.view.view, connection: connection.connection,
        window: connection.view.window, renderer, call_token: connection.call_token } satisfies ReleasePluginViewRenderer),
    } }, client.testProject ?? null, true).catch(() => { /* Unconfirmed release retains native recovery. */ });
  };
  const send = (body: PluginViewRequest, request: string = crypto.randomUUID(), testProject?: string) => {
    if (disposed) return Promise.reject(new Error("The view connection is closed."));
    if (serverSequence >= 0xffffffff) return Promise.reject(new Error("The view sequence is exhausted."));
    const message: PluginViewMessage = { protocol_version: 1, connection: connection.connection,
      view: connection.view.view, sequence: ++serverSequence, request, ...(testProject !== undefined ? { test_project: testProject } : {}), body };
    return client.request<SessionReply>("/api/plugin-view", { project_root: project, call_token: connection.call_token, message });
  };
  const internal = async (body: PluginViewRequest) => {
    const reply = await send(body);
    if (disposed) throw new Error("The view connection is closed.");
    if (!reply.ok) throw new Error(reply.error || "The original resource request is unconfirmed.");
    return reply.result;
  };
  const downloads = new PluginDownloads((reference, offset, limit) => internal({ type: "query",
    capability: { id: "resources.read", version: 1 }, arguments: { reference, offset, limit } }), undefined,
    async (reference, filename) => {
      const final = await internal({ type: "download_resource", reference, filename });
      if ((final as { authorized_view?: string })?.authorized_view !== connection.view.view)
        throw new Error("The Host did not validate the original download request.");
    });
  const dispose = () => {
    if (disposed) return;
    disposed = true; downloads.dispose(); clipboard.dispose(); window.removeEventListener("message", ready);
    window.removeEventListener("pagehide", pagehide);
    channel.port1.close(); channel.port2.close(); surface.remove();
    for (const renderer of renderers) releaseRenderer(renderer);
    renderers.clear();
  };
  const pagehide = (event: PageTransitionEvent) => { if (!event.persisted) dispose(); };
  window.addEventListener("pagehide", pagehide);
  const fence = (reason: string) => { if (!disposed) { dispose(); failed(reason); } };
  channel.port1.onmessageerror = () => fence("The view sent an invalid message.");
  channel.port1.onmessage = event => {
    const message = event.data as PluginViewMessage | null;
    if (!message || !bounded(message) || message.protocol_version !== 1 || message.connection !== connection.connection ||
      message.view !== connection.view.view || message.sequence !== sequence + 1 || typeof message.request !== "string" ||
      !message.body || typeof message.body.type !== "string" || pending >= 128) { fence("The view connection failed its identity, sequence or size check."); return; }
    sequence++; pending++;
    const currentGesture = (message.body.type === "open_external_url" || message.body.type === "open_test_workspace" || message.body.type === "download_resource" || message.body.type === "begin_text_copy" && clipboardAvailable) &&
      document.hasFocus() && document.activeElement === iframe && navigator.userActivation?.isActive === true;
    // Allocate the wire sequence before starting concurrent requests. The Host
    // orders their acceptance, not completion: slow reads cannot block control.
    void (async () => {
      if (disposed) return;
      let reply: SessionReply;
      let body: PluginViewRequest;
      try {
        body = scopedBody(message.body);
        reply = await send(body, message.request, message.test_project);
      } catch (error) { fence(error instanceof Error ? error.message : String(error)); return; }
      if (reply.ok && body.type === "register_close_handler") {
        // A late acknowledgement still identifies this destroyed document;
        // failed or lost acknowledgements never justify clearing another one.
        if (disposed) releaseRenderer(body.renderer);
        else renderers.add(body.renderer);
      }
      if (disposed) return;
      if (!reply.ok && (message.body.type === "finish_text_copy" || message.body.type === "cancel_text_copy"))
        clipboard.cancel(message.body.copy_id);
      if (reply.ok && ["begin_text_copy", "finish_text_copy", "cancel_text_copy"].includes(message.body.type)) {
        try {
          if ((reply.result as { authorized_view?: string })?.authorized_view !== connection.view.view)
            throw new Error("The Host did not validate this view's copy request.");
          const body = message.body;
          if (body.type === "begin_text_copy") {
            if (!currentGesture || !document.hasFocus() || document.activeElement !== iframe || !navigator.userActivation?.isActive)
              throw new Error("Use an explicit Copy action in this view.");
            reply = { ...reply, result: clipboard.begin() };
          } else if (body.type === "finish_text_copy") {
            reply = { ...reply, result: await clipboard.finish(body.copy_id, body.text) };
          } else if (body.type === "cancel_text_copy") {
            reply = { ...reply, result: clipboard.cancel(body.copy_id) };
          }
        } catch (error) {
          reply = { ...reply, ok: false, result: undefined, error: error instanceof Error ? error.message : String(error) };
        }
      }
      if (reply.ok && message.body.type === "open_external_url") {
        try {
          if ((reply.result as { authorized_view?: string })?.authorized_view !== connection.view.view)
            throw new Error("The Host did not validate this view's link request.");
          if (!currentGesture || !document.hasFocus() || document.activeElement !== iframe || !navigator.userActivation?.isActive)
            throw new Error("Use an explicit link action in this view.");
          reply = { ...reply, result: requestExternalNavigation(message.body.url) };
        } catch (error) {
          reply = { ...reply, ok: false, result: undefined, error: error instanceof Error ? error.message : String(error) };
        }
      }
      if (reply.ok && message.body.type === "download_resource") {
        try {
          if ((reply.result as { authorized_view?: string })?.authorized_view !== connection.view.view)
            throw new Error("The Host did not validate this view's download request.");
          if (!currentGesture || !document.hasFocus() || document.activeElement !== iframe || !navigator.userActivation?.isActive)
            throw new Error("Use an explicit Export action in this view.");
          reply = { ...reply, result: await downloads.start(message.body.reference, message.body.filename) };
        } catch (error) {
          reply = { ...reply, ok: false, result: undefined, error: error instanceof Error ? error.message : String(error) };
        }
      }
      if (reply.ok && message.body.type === "open_test_workspace") {
        try {
          const authorized = reply.result as { authorized_view?: string; test_project?: string; window?: string };
          if (authorized?.authorized_view !== connection.view.view || authorized.test_project !== message.body.test_project || authorized.window !== connection.view.window)
            throw new Error("The Host did not validate this test workspace request.");
          if (!currentGesture || !document.hasFocus() || document.activeElement !== iframe || !navigator.userActivation?.isActive)
            throw new Error("Use an explicit Open test workspace action in this view.");
          reply = { ...reply, result: client.openTestWorkspace(authorized.test_project, authorized.window) };
        } catch (error) {
          reply = { ...reply, ok: false, result: undefined, error: error instanceof Error ? error.message : String(error) };
        }
      }
      if (disposed) return;
      const response = { protocol_version: 1, connection: connection.connection, view: connection.view.view,
        sequence: ++replies, request: message.request, ok: reply.ok, result: reply.result, error: reply.error, diagnostic: reply.diagnostic };
      if (!bounded(response)) { fence("The view reply exceeds its message quota; use bounded reads."); return; }
      channel.port1.postMessage(response); pending--;
    })().catch(error => fence(String(error)));
  };
  channel.port1.start();
  iframe.addEventListener("load", () => {
    if (disposed) return;
    if (loaded) { fence("The view navigated away; reopen it to establish a new connection."); return; }
    loaded = true;
  });
  const ready = (event: MessageEvent) => {
    if (disposed || event.source !== iframe.contentWindow || !event.data || !bounded(event.data) ||
      event.data.type !== "rho:view:ready" || event.data.protocol_version !== 1 || event.data.nonce !== nonce) return;
    window.removeEventListener("message", ready);
    // Opaque origins require '*'; the transferred port is addressed to this
    // exact WindowProxy and bootstrap is tied to this document's random nonce.
    iframe.contentWindow?.postMessage({ type: "rho:view:connect", protocol_version: 1, nonce,
      connection: connection.connection, view: connection.view, features: ["view_close_v1", "external_links_v1", "resource_download_v1", "test_projects_v1", ...(clipboardAvailable ? ["text_copy_v1"] : [])] }, "*", [channel.port2]);
  };
  window.addEventListener("message", ready);
  surface.append(iframe);
  container.append(surface);
  return dispose;
}
