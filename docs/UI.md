# Browser collaboration implementation

The UI proceeds in four independently checked stages. Accepted headless 0.4
collaboration is the baseline, not browser acceptance. Core is unchanged; reuse
its previously accepted binary by digest.

## Stages and current scope

| Stage | Observable result | Remaining gate |
| --- | --- | --- |
| U1 | npm launcher, pairing, project shell, capability discovery, retained unavailable views, observation and refresh | Installed candidate checks and user review are separate evidence |
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

## Install, launch and pair

Use an assembled tarball, not the source-linked development package; see
[Headless assembly](HEADLESS.md#development-and-assembly). `dist/web` contains
actual built assets, licenses and a digest inventory. Vite is not a production
server or runtime prerequisite.

```sh
npm install --omit=dev --ignore-scripts /absolute/rho-workspace-local-0.4.0.tgz
npx rho --root /absolute/projects --state-dir /absolute/private-rho-state --port 0
```

The launcher prints the loopback URL and a one-time `pairingCode`, valid for five
minutes. Open the URL and enter the code. Do not put credentials in URLs or paste
the private operator connection file into the page. For another tab/code:

```sh
npx rho --pair /absolute/private-rho-state/connection.json
# Optionally narrow to a subdirectory of the original projects root:
npx rho --pair /absolute/private-rho-state/connection.json --root selected-subdirectory
```

The private connection file retains operator credentials. The operator can call
`session.browser.pair` with optional root-relative `path`, and revoke a browser
session with `session.browser.revoke` and its ID from local principal metadata.
Revocation also releases its event readers. Neither operation is granted to
browsers or external Agents.

Open paths are relative to the paired root; creation takes a single Unicode
directory name. Recent projects are actual registered projects filtered by scope.
Internal state, parent traversal and links cannot expand the root. Opening and
observing never start a Host, run code or install packages.

## Security and budgets

`POST /api/browser/pair` requires exact Host/Origin and a JSON `{code}` body of at
most 1024 bytes. The random 192-bit code is consumed once before asynchronous
persistence; concurrent redemption cannot succeed twice. Only its digest is held
in service memory. The random bearer token names a persistent, expiring principal,
root and finite method list. Grant persistence/redemption is serialized.

Credentials are stored only in this origin's tab `sessionStorage`: no credential
cookies, localStorage, static secrets, URL tokens or request-body diagnostics.
Refresh resumes the same session. Service restart at the same port preserves its
origin and session until expiry; another port requires pairing again. Unpair this
tab forgets local credentials/observation only, not server authorization or tasks.
The operator separately revokes authorization when needed.

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
| Pairing lifetime | `browser.pairingTtlMs` / 300000 | Require another locally issued code |
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
reconciliation does not reconstruct retained views or steal command focus.

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
launches the actual CLI and drives real Chrome with real owner state: Unicode
project creation, refresh, offline/reconnect, same-port restart, stable-ID updates,
command focus, unavailable entries and 1600/1280/1024/390 widths. Instrumented
Host-start/native-submit attempts must both be zero. Reports contain asset IDs
and results, never pairing/session credentials. Inspect screenshots in addition to
overflow assertions.

The driver is not a production dependency. Select explicit paths with
`RHO_UI_PLAYWRIGHT_MODULE`, `RHO_UI_CHROME`, `RHO_UI_EVIDENCE` and optionally
`RHO_UI_PLUGINS`. This host has Chrome 155, not the planned 154. Native editor
IME/clipboard and actual browser/human/Agent closure remain U2-U4 gates. A U1 pass
is not UI collaboration, overall product or signed-release acceptance.
