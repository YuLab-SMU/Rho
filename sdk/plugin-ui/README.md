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

For opaque document content larger than view state, use `captureDraftContent(bytes)`
to freeze and hash the current bytes, then
`stageDraftContent(client, { draft, upload }, capture)` with an explicit
`documents.stage@1` / `documents.write` grant. Every capture needs its own upload
identity. Staging verifies the entire capture before sending bounded 64 KiB chunks,
and verifies each acknowledgement. It returns the content manifest; it does not
publish the draft or invoke an Operation. Content is limited to 8 MiB. The plugin
owns its encoding and any smaller editing limit.

Publish explicitly through `documents.save@1` under `documents.write`, supplying
the draft/window, upload identity, source revision/contribution, expected document
version (or null for a new identity), returned content manifest and at most 32 KiB
of metadata. Retain the original invocation identity and arguments in synchronized
view state before invoking. Admission is not a saved-draft acknowledgement: inspect
the original Operation until its outcome is established. Keep pending captures
separate from later edits, and never replace an uncertain request with a new ID.
Staging and read helpers accept an AbortSignal; interruption stops further transfer
without cancelling accepted work or claiming rollback.

A close handler may stage and invoke `documents.save@1`, wait for the original
save to succeed, and persist its draft ID/version through `setState` before
returning. These exact two mutation ports are allowed during close preparation;
discard, other capability versions and unrelated actions remain fenced. The Host
still requires declared grants and parent authority, and restricts closing or
inactive views to their own exact encoding revision/contribution and window.
All renderers must finish before closure; once their state is sealed, new staging
or saves are refused. An existing view may finish its own draft synchronization
while its instance is draining. Completing instance release still requires closing
its views, and does not cancel their accepted work.

`readDraft(client, record, { maxBytes, signal })` requires explicit
`documents.inspect@1` and `documents.read@1` grants under `documents.read`. It checks
the record against the view's project, principal and window, observes its exact
current version, and verifies bounded read ranges, every chunk and the complete
digest. It refuses a changed version, discarded content or corrupt/incomplete bytes
instead of returning newer content. Even empty content crosses authorized reads.
This is synchronized current content, not historical execution evidence or a
filesystem-save receipt. Ship the emitted `drafts.js` with the other SDK modules.

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

For an explicit documentation or project link, call
`await client.openExternal(url)` from the user's action handler. The
`external_links_v1` feature accepts bounded absolute HTTP(S) URLs without embedded
credentials, whitespace or backslashes. The containing browser independently
validates the destination, current focused-frame gesture and Host acknowledgement
before requesting a fresh tab. It severs the opener and suppresses the referrer;
neither the private Workbench address nor Host credentials are forwarded.
The acknowledgement means navigation was requested, not that the remote page
loaded. A blocked popup, missing gesture/feature or uncertain reply is an error.
The Host validates only view authority and does not open a browser, persist the
URL or create an Operation. Closure fences this action with other new work.

The container uses a fresh blank [Window.open](https://developer.mozilla.org/en-US/docs/Web/API/Window/open)
handle and a [no-referrer link](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy)
so a blocked tab can be distinguished from a requested navigation. It never
targets an existing named browsing context.

For an explicit original-file export, call
`await client.downloadResource(reference, filename)` from the user's action
handler. Declare `resources.read@1` with the `resources.read` scope. The
`resource_download_v1` feature captures that exact retained reference and a plain
filename (up to 240 UTF-8 bytes, without paths or control characters). Resources
are limited to 16 MiB. The containing browser checks the focused-frame gesture,
reads bounded chunks through the same view grant, verifies every identity/range
and the complete SHA-256, then rechecks live Host authority before requesting
the download. One download may be collected per view at a time.

The acknowledgement means the browser download was requested; it does not claim
that a file was saved. Browser settings, cancellation and disk failures remain
outside this acknowledgement. Missing features, invalid references, failed reads,
revoked authority and closure before submission are errors. The Host only
authorizes the original read: it writes no file, starts no runtime and creates no
Operation. Disposal stops unsubmitted collection, but cannot roll back a browser
download already requested. The opaque iframe itself gains no download permission.

`views.open`, `views.update` and `views.close` use the common Operation port.
Install the document's close handler after constructing its presentation model:

```ts
const closing = await client.installCloseHandler({
  async flush() {
    pausePresentationUpdates();
    await finishLocalCapture();
    await client.setState(captureCurrentDraft());
  },
  resume() { resumePresentationUpdates(); },
});
closing.subscribe(() => showCloseStatus(closing.getSnapshot()));
```

The container advertises `view_close_v1`. The SDK registers a document identity
and makes bounded lifecycle observations. `views.close` defaults to `flush`: the
owner fences new actions, requests every registered document's final state, and
waits up to 15 seconds for acknowledgements of one exact version. The SDK makes
its own document inert during preparation, awaits the handler and queued state
writes, and acknowledges the original close Operation. It refuses preparation
while composing text without making that editor inert. A refusal or deadline
leaves the view open; the handler's `resume` restores presentation updates.
Handlers must drain local capture/acceptance tasks and pause background changes,
but must not wait for scientific execution or cancel accepted work. A failed
save must reject. Keep transient/password answers out of retained view state.
Objects flushes presentation choices, Console flushes its draft and refuses an
unsent transient answer, and Viewer saves selection/history/follow choices. This
does not serialize arbitrary nested HTML widgets.

Successful closure removes the exact tab and releases its view reference in one
transaction with closure of the acknowledged record. A lost reply is unconfirmed;
the container must inspect the original Operation before removing the iframe.
Disposal, navigation and browser reload do not prove that the destroyed document
saved its local buffer. Its registration is retained rather than silently
acknowledged. For an unavailable document, explicitly inspect `views.inspect` and
invoke `views.close` with `mode: { kind: "retain_acknowledged", expected_version }`.
This recovery mode retains that exact acknowledged state and does not claim to
have saved disconnected edits. Never automatically fall back to it after failure.
Host shutdown similarly retains acknowledged state and layout placeholders; it
does not claim a close-time flush.

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
