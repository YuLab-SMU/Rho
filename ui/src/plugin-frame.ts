import type { PluginViewConnection, PluginViewMessage } from "../../sdk/plugin-protocol/index.js";
import type { SessionReply } from "./generated/SessionReply";
import { HostClient } from "./host-client";
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
  iframe.title = connection.view.contribution;
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("allow", "clipboard-read 'none'; clipboard-write 'none'; camera 'none'; microphone 'none'; geolocation 'none'");
  iframe.style.cssText = "width:100%;height:100%;border:0;display:block;background:white";
  const nonce = crypto.randomUUID();
  const assetPath = connection.entrypoint.split("/").map(encodeURIComponent).join("/");
  iframe.src = `/view/plugin/${encodeURIComponent(connection.connection)}/${encodeURIComponent(connection.asset_token)}/${assetPath}#rho-view-nonce=${nonce}`;
  const channel = new MessageChannel();
  const clipboardAvailable = typeof ClipboardItem === "function" && typeof navigator.clipboard?.write === "function";
  const clipboard = new PluginClipboard(text => navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]));
  let disposed = false, loaded = false, sequence = 0, replies = 0, serverSequence = connection.next_sequence - 1, pending = 0;
  const dispose = () => { disposed = true; clipboard.dispose(); window.removeEventListener("message", ready); channel.port1.close(); channel.port2.close(); iframe.remove(); };
  const fence = (reason: string) => { if (!disposed) { dispose(); failed(reason); } };
  channel.port1.onmessageerror = () => fence("The view sent an invalid message.");
  channel.port1.onmessage = event => {
    const message = event.data as PluginViewMessage | null;
    if (!message || !bounded(message) || message.protocol_version !== 1 || message.connection !== connection.connection ||
      message.view !== connection.view.view || message.sequence !== sequence + 1 || typeof message.request !== "string" ||
      !message.body || typeof message.body.type !== "string" || pending >= 128) { fence("The view connection failed its identity, sequence or size check."); return; }
    sequence++; pending++;
    const copyGesture = message.body.type === "begin_text_copy" && clipboardAvailable &&
      document.hasFocus() && document.activeElement === iframe && navigator.userActivation?.isActive === true;
    // Allocate the wire sequence before starting concurrent requests. The Host
    // orders their acceptance, not completion: slow reads cannot block control.
    const next = ++serverSequence;
    void (async () => {
      if (disposed) return;
      let reply: SessionReply;
      try {
        reply = await client.request<SessionReply>("/api/plugin-view", { project_root: project, call_token: connection.call_token,
          message: { ...message, sequence: next } });
      } catch (error) { fence(error instanceof Error ? error.message : String(error)); return; }
      if (disposed) return;
      if (!reply.ok && (message.body.type === "finish_text_copy" || message.body.type === "cancel_text_copy"))
        clipboard.cancel(message.body.copy_id);
      if (reply.ok && ["begin_text_copy", "finish_text_copy", "cancel_text_copy"].includes(message.body.type)) {
        try {
          if ((reply.result as { authorized_view?: string })?.authorized_view !== connection.view.view)
            throw new Error("The Host did not validate this view's copy request.");
          const body = message.body;
          if (body.type === "begin_text_copy") {
            if (!copyGesture || !document.hasFocus() || document.activeElement !== iframe || !navigator.userActivation?.isActive)
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
      connection: connection.connection, view: connection.view, features: clipboardAvailable ? ["text_copy_v1"] : [] }, "*", [channel.port2]);
  };
  window.addEventListener("message", ready);
  container.append(iframe);
  return dispose;
}
