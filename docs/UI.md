# Browser collaboration implementation

The UI proceeds in four independently checked stages. Accepted headless 0.4
collaboration is the baseline, not browser acceptance. Core is unchanged; reuse
its previously accepted binary by digest.

## Stages and current scope

| Stage | Observable result | Remaining gate |
| --- | --- | --- |
| U1 | npm launcher, Agent-opened connected tab, project shell, capability discovery, retained unavailable views, observation and refresh | Installed candidate checks and user review are separate evidence |
| U2 | Documents CodeMirror and Tables AG Grid Community entries in Plugins | Not implemented; owner change receipts, live-document bindings, input recovery and real IME checks required |
| U3 | Conditional Dockview layout, protection, scoped selections and actual Claude Code collaboration | Not implemented; no second layout authority or close-on-drag-removal |
| U4 | Charts, feedback, frozen contexts, explicit replies and format-3 browser recovery | Not implemented; UI protocol v1 and collaboration acceptance remain unfrozen |

U1 is a vertical shell, not the final collaboration loop. No sample inquiries,
inferred Agent states, fake renderers or embedded chat are included. The five
existing descriptors remain unavailable as renderers. U1 observes stable view IDs
without changing bindings/layout. Views appear as tabs in one observation-only
Dockview group; structured group geometry is U3. No close/drag control pretends to
persist transactions.

The visual reference is Paper's
[Rho experience V0.1](https://app.paper.design/file/01M4X13H2YQGGR8NQXE8W0QDQY/p-9-0):
home, main workspace, composition and Shell v2. The user rejected Main app /
Composable shell as the source. U1 reuses the 44px toolbar, 64px rail, 232px project
navigation, restrained blue selection, white workspace and collapsible context.
It does not copy illustrative scientific counts/tasks, macOS window controls or
annotation-sheet framing. The added U1 board is for review, not user acceptance.

## Install, launch and open

Use an assembled tarball, not the source-linked development package; see
[Headless assembly](HEADLESS.md#budgets-verification-and-assembly). `dist/web` contains
actual built assets, licenses and a digest inventory. Vite is not a production
server or runtime prerequisite.

The Agent starts Rho and opens the browser; a person does not type a code. The
page has no pairing form. Without a link it only says to ask the Agent.

```sh
npm install --omit=dev --ignore-scripts /absolute/rho-workspace-local-0.4.0.tgz
npx rho --root /absolute/projects --state-dir /absolute/private-rho-state --port 0 --open
```

The ready line contains the loopback `url`, a one-time `pairingCode` valid for
five minutes, and `openUrl`, which is `url` plus `#pair=` and that code.
`--open` opens `openUrl` in the default browser (`open`, `xdg-open` or
`start`; only macOS is verified). Without it, the Agent can open `openUrl`
itself. For another connected tab on a running service:

```sh
npx rho --pair /absolute/private-rho-state/connection.json --open
# Optionally narrow to a subdirectory of the original projects root:
npx rho --pair /absolute/private-rho-state/connection.json --root selected-subdirectory --open
```

The page redeems the fragment code once through `POST /api/browser/pair`, then
removes it from the address bar before rendering. A used, expired or unknown code
shows "This link has already been used" and asks for a new link; other failures
show the service message. Do not paste the private operator connection file into
the page.

The private connection file retains operator credentials. The operator can call
`session.browser.pair` with optional root-relative `path`, and revoke a browser
session with `session.browser.revoke` and its ID from local principal metadata.
Revocation also releases its event readers. Neither operation is granted to
browsers or external Agents.

Open paths are relative to the tab's folder. The pair result also carries a
display label such as `~/projects`; the page shows it as a fixed prefix and
reduces a pasted full path inside the folder to its relative part. Creation takes
a single Unicode directory name. An existing folder is reported as `conflict`
and is never adopted as a new project; a missing folder is `not_found`. The home
lists actual registered projects filtered by scope, newest first, with the time
each was added; the service does not record a last-opened time.
Internal state, parent traversal and links cannot expand the root. Opening and
observing never start a Host, run code or install packages.

## Security and budgets

`POST /api/browser/pair` requires exact Host/Origin and a JSON `{code}` body of at
most 1024 bytes. The random 192-bit code is consumed once before asynchronous
persistence; concurrent redemption cannot succeed twice. Only its digest is held
in service memory. The random bearer token names a persistent, expiring principal,
root and finite method list. Grant persistence/redemption is serialized.

The one-time code may appear in a URL fragment, never in a path, query, request,
Referer or log. Browsers do not send fragments. The page strips the fragment
before rendering, so later requests and the address bar no longer carry it.
Browser history may still record the original link, which is useless once the
code is redeemed. Bearer tokens never appear in URLs.

The fragment code is visible for a moment in the opener's process arguments.
Another local process that reads it first can redeem it. The intended tab then
shows "already used", so the loss is visible. The code works once and expires in
five minutes. A redeemed browser token can only reach the U1 methods.

Credentials are stored only in this origin's tab `sessionStorage`: no credential
cookies, localStorage, static secrets or request-body diagnostics.

- Refresh resumes the same session.
- Restarting the service on the same port keeps its origin and session until
  expiry. On another port, the tab needs a new link.
- "Disconnect this tab" asks for confirmation. It forgets only this tab's
  credential and stops its observation. Server authorization and tasks are
  unchanged.
- The operator revokes authorization separately when needed.
- A rejected credential ends the tab's access. The tab returns to the
  not-connected page. Scope and network failures keep the session.

U1 permits protocol/Skills discovery, project list/open/create, capabilities,
snapshot/events, composition reads, document reads and bounded resource reads.
It excludes `session.grant`, capability reconfiguration, document mutations,
native actions, installation and archive writes. Later stages must explicitly
extend this reviewed ceiling after implementing their conditions.

Static routes serve only HTML and named build assets, not arbitrary project files.
Responses enforce no-store, no-referrer, same-origin resource/opener policies and
CSP: same-origin scripts/connections, no eval, remote scripts or inline scripts.
Inline styles support the layout library. Assets are symlink-checked and bounded
to 16 MiB each; missing builds have a readable 503.

| Protected resource | Configuration / default | Exceeded behavior |
| --- | --- | --- |
| Pending pairing codes | `browser.maxPairings` / 8 | Reject another code; retain grants |
| Active browser grants | `browser.maxSessions` / 16 | Reject redemption; never evict active tabs |
| Pairing attempts | `browser.maxPairAttempts` / 32 per minute | Refuse attempts until the window clears |
| Pairing lifetime | `browser.pairingTtlMs` / 300000 | The link stops working; the Agent opens a new one |
| Session lifetime | `browser.sessionTtlMs` / 43200000 | Deny requests/end observation; retain owner state |
| SSE | Existing service/observation limits | Resnapshot; stop after bounded retries |

Set browser budgets under `browser` in the existing `--limits` JSON. U1 mounts no
heavy functional views. U2-U4 still need the eight-heavy-view limit, document-byte
budget for unconfirmed input, and 200-row blocks/five-block cache without input loss.

## SDK and contribution draft

`@rho-workspace/local/browser` exports `BrowserClient`, `BrowserApiError` and typed
U1 methods/snapshots, with no Node, DOM or React imports. Fetch/abort primitives
come from the runtime; importing the SDK reads no browser storage. The shell owns
sessionStorage; the separate Node client retains filesystem intent functions.

`BrowserClient.observe(projectId)` reuses `ObservationClient` and its bounded Fetch
SSE parser. Snapshot on connection, reconnect, invalidation or gap; events are
hints, not another state owner. Cancellation releases the reader. Resource versions
stay exact; opening a view does not choose a newer version automatically. Stable-ID
reconciliation does not reconstruct retained views or steal focus. A layout saved
elsewhere appears in the overview and sidebar without moving the reader.

`@rho-workspace/local/ui-contract` defines `UiContribution` at `0.1-draft`: package
and component identities/versions, props schema, binding roles, required operations,
commands, selection capabilities and React View. A view receives `viewId`, snapshot,
client and active state. React is a type-only dependency of this optional entry;
the headless root imports none. This is not protocol v1. U2 consumers must refine
it before Charts, Annotations and Agent extend it in U4.

`web/registry.ts` is a trusted build-time registry, empty in U1. Descriptions cannot
provide executable code/module URLs. A missing entry or required operation produces
an inspectable unavailable view. Actual functionality belongs in Plugins optional
`./ui` exports; Rho owns mounting, theme, layout, focus and routing only.

Inside a project the sidebar lists Overview, saved layouts with their view counts,
and the project's documents and files; retained operations appear only when there
are some. The overview lists the same content as tables without JSON. An
unavailable view says what it shows, what it needs and what this build lacks,
offers About for its plugin with a way back to the project, and keeps identifiers
in the View reference disclosure.

## Checks and evidence

```sh
npm run build:web
RHO_CORE_BINARY=/absolute/accepted/rho-core npm test
RHO_CORE_BINARY=/absolute/accepted/rho-core npm run test:ui
# Installed product; driver is a separate development dependency:
RHO_PACKAGE_ROOT=/absolute/installation/node_modules/@rho-workspace/local \
RHO_UI_PLAYWRIGHT_MODULE=/absolute/test-driver/node_modules/@playwright/test/index.mjs \
RHO_UI_INSTALLED=1 npm run acceptance:ui
```

`test/browser.test.mjs` covers pairing/root scope, forbidden methods, static
security, credentials, budgets, session restart and revocation. The UI runner
launches the actual CLI and drives real Chrome with real owner state. It covers:

- `openUrl` redemption, fragment removal and one-use links across tabs
- Unicode project creation and refresh
- the Up to date / Offline / Connecting status
- offline/reconnect and same-port restart
- stable-ID updates and command focus
- disconnect confirmation and Escape focus return
- the project overview, unavailable views without JSON, and About with Back
- 1600/1280/1024/768/390 widths

Instrumented
Host-start/native-submit attempts must both be zero. Reports contain asset IDs
and results, never pairing/session credentials. Inspect screenshots in addition to
overflow assertions.

The driver is not a production dependency. Select explicit paths with
`RHO_UI_PLAYWRIGHT_MODULE`, `RHO_UI_CHROME`, `RHO_UI_EVIDENCE` and optionally
`RHO_UI_PLUGINS`. This host has Chrome 155, not the planned 154. Native editor
IME/clipboard and actual browser/human/Agent closure remain U2-U4 gates. A U1 pass
is not UI collaboration, overall product or signed-release acceptance.
