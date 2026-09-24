# Rho UI SDK

A framework-independent browser client for an ordinary plugin's isolated view.
Compile `index.ts` with the public `@rho/plugin-protocol` declarations beside it
(the sibling `plugin-protocol` package). Ship every emitted JavaScript module,
including `resources.js`, with the plugin's source and immutable `dist/` artifact.
There are no third-party runtime imports. No private Studio, scientific module, framework or Host bearer is needed.

```ts
import { connectPluginView } from "@rho/plugin-ui";
const client = await connectPluginView();
const savedState = client.view.state;
const snapshot = await client.query({ id: "example.read", version: 1 }, {});
await client.setState({ selected: "sample-1" });
const accepted = await client.invoke({ id: "example.run", version: 1 }, {}, {
  requestId: "stable-user-action-id",
});
// Keep the returned original Operation identity and inspect it with operation().
// A cancellation request or a disconnected iframe does not confirm native stop.
```

Declare every external capability and its scopes in `manifest.requires`; the
original caller must already possess that authority. Query and invocation results
retain their shared Host envelopes. Capability payloads and native preconditions
come from their public owner contracts. Invocation returns after admission; its
accepted record may still be running. `operation(id)` and `cancel(id)` address only
operations started by this view, under the original principal and granted scopes.
Self-state saving is an intrinsic view operation with a version comparison. It
cannot name another view, change configuration or acquire another capability.

Use `control(capability, arguments)` for transient answers to an existing native
request, with the exact provider and request identities required by its owner.
This uses the same declared grants as queries and Operations, but creates no
Operation or saved answer. Do not put passwords or other transient answers in view
state. A missing acknowledgement requires inspection of the pending native request;
it does not authorize automatic retry. Control errors redact native payloads.

`ViewRequestError.diagnostic` retains the original structured Host diagnostic,
including recovery material; an error string does not replace that evidence.

The container creates one opaque-origin iframe and transfers one private
MessagePort to that exact document. The SDK checks the parent, document nonce,
connection/view identity, request correlation, ordering and a 1 MiB message quota.
A readiness handshake permits ES modules to await connection at top level without
waiting for the document load event.
At most 128 calls may be pending. The Host orders message acceptance but permits
concurrent completion, so a slow query does not hold up a later control or state
save. Await dependent operations explicitly; state saves are serialized by the
SDK. A missing preceding transport message has a bounded 10-second wait. An unacknowledged response times out after 30
seconds without claiming that an accepted Operation stopped. Oversized scientific
results should use bounded resource reads. Dispose the client on document teardown;
disposal closes the channel and rejects local waiters without cancelling Operations.

The containing shell keeps the call credential. Asset URLs contain only a separate,
view-scoped credential for the exact immutable artifact. Source files, parent DOM,
parent storage, generic Host credentials and unrestricted API access are absent
from the iframe channel. The iframe allows scripts but not same-origin privilege,
forms, popups, downloads or top-level navigation. Asset responses also sandbox
direct navigation and restrict subresource loads; this is not an OS sandbox or a
claim that browser self-navigation cannot issue a network request. A subsequent
frame navigation fences the container. Direct clipboard APIs remain denied;
ordinary editable text and browser keyboard copy/paste remain browser behavior.

For a Copy button, use `await client.copyText(text)` or
`await client.copyText(async () => collectBoundedText())` from its explicit action
handler. The `text_copy_v1` container feature reserves a native write while the
focused view has a current user gesture, then calls the producer. This permits
asynchronous object/text reads before any clipboard content is published. The
producer must preserve its original observations and copy budget. If collection
fails, the reservation is released without supplying clipboard data. The SDK
reports success only after the browser confirms the write. Missing features,
permission refusal, expired reservations and uncertain completion are errors.

One copy reservation per view expires after 60 seconds without submission. The
existing 1 MiB serialized-message quota still applies, including JSON escaping and
envelope bytes. Closure releases unsubmitted data; a submitted or timed-out native
write is never described as rolled back. Host validation checks the live view,
window, principal, sequence and parent's existing `plugins.run` authority, and
creates no Operation or retained text. It acknowledges identity only; a standalone
Host request cannot claim to have changed the browser clipboard. Clipboard reading
is not exposed by this API.

The container uses a promised `text/plain` Blob through
[ClipboardItem](https://developer.mozilla.org/en-US/docs/Web/API/ClipboardItem/ClipboardItem),
with the browser's [user activation](https://html.spec.whatwg.org/multipage/interaction.html#tracking-user-activation)
and clipboard permissions. This is browser presentation cooperation, not an
operating-system sandbox guarantee.

`views.open`, `views.update` and `views.close` use the common Operation port.
For navigation into a window, declare `windows.layout` and `windows.open_view`
with `plugins.run`, observe the containing window, then invoke `windows.open_view`
with its expected layout version and an explicit target group. That operation
creates the view and selects it atomically. It returns public records only;
connection credentials remain in the containing shell. Keep the original request
ID and arguments after a lost acknowledgement. A view cannot open another window.
The opening capability grant must also declare the scopes needed by the target
view: new views cannot inherit authority excluded from the opening call. This
is explicit delegation within the caller's existing scopes.
`views.inspect` reads durable state; `views.connection` observes an already-open
connection without recreating it. Open views protect their revision. Closing one
revokes both credentials and releases only its view reference. It leaves the
backend instance and already-accepted scientific work intact. Host restart does
not reconnect a stored view. Open a fresh view with the retained state and exact
revision, and explicitly close obsolete records. There is no state migration.

Run `node scripts/test-plugin-ui.mjs` from a checkout to verify external strict
NodeNext compilation and the public channel. The browser conformance fixture is
built entirely outside the checkout from the public SDK, then snapshotted and
activated through the ordinary package and Host lifecycle paths.

`readResource(client, reference, {maxBytes, signal})` reads through the declared
`resources.read@1` capability. It validates each returned reference, offset and
length, then verifies the complete SHA-256 before returning bytes. Reads are
256 KiB or smaller; presentation defaults to 16 MiB. Aborting stops further reads
without cancelling the producing Operation. Empty resources still require an
authorized query. A mismatch preserves the original reference and throws an error.

A plugin may present saved HTML in another iframe using `srcdoc`,
`sandbox="allow-scripts"` and `referrerpolicy="no-referrer"`. Inherited CSP and
sandbox flags preserve opaque origins. The existing `frame-src 'none'` blocks
URL-backed frames; it does not prevent a local inline source document. No core
security-policy change is needed. Network connections, workers, forms, top
navigation and parent DOM access remain unavailable. Do not insert resource HTML
into the plugin's own DOM. Remove the nested document when replacing or closing
it. This is saved content presentation, not a live-service or scientific execution
capability. Rendering and JavaScript behavior still require real-browser
verification; a load event does not establish content correctness.

Host journal request IDs are scoped to the originating view. Use
`operationRequestId(originalView, originalRequest)` for a receipt comparison or
`operation.list_recent` request filter. Pass the unchanged original request to
`invoke`; a reopened view may inspect the old request but must not replay it under
a new caller identity.
