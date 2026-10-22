# Browser collaboration implementation

The UI proceeds in four independently checked stages. Accepted headless 0.4
collaboration is the baseline, not browser acceptance. Core is unchanged; reuse
its previously accepted binary by digest.

## Stages and current scope

| Stage | Observable result | Remaining gate |
| --- | --- | --- |
| U1 | npm launcher, Agent-opened connected tab, project shell, capability discovery, retained unavailable views, observation and refresh | Installed candidate checks and user review are separate evidence |
| U2 | Documents CodeMirror and Tables AG Grid Community entries in Plugins | Entries, input recovery and browser composition/clipboard checks implemented; physical macOS IME candidate-window check pending |
| U3 | Conditional Dockview layout, protection, scoped selections and actual Claude Code collaboration | Not implemented; no second layout authority or close-on-drag-removal |
| U4 | Charts, feedback, frozen contexts, explicit replies and format-3 browser recovery | Not implemented; UI protocol v1 and collaboration acceptance remain unfrozen |

U1 is a vertical shell, not the final collaboration loop. No sample inquiries,
inferred Agent states, fake renderers or embedded chat are included. Documents and Tables now have owner renderers. Charts, Media and Objects remain unavailable as renderers. U1 observes stable view IDs
without changing bindings/layout. Views appear as tabs in one observation-only
Dockview group; structured group geometry is U3. No close/drag control pretends to
persist transactions.

The [U2 backend handoff](U2-BACKEND-HANDOFF.md) supplies identified document
mutations and live bindings. U2 integrates the frontend team’s confirmed Paper design and existing entries.
The browser ceiling now admits identified document edits, own undo, per-change
revert/history, bounded table pages and explicit shared selections. Saves remain
external Agent work; the page has no save state or write timer.

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

## Projects and source folders

On local macOS, Open folder uses the system folder window. There is no path-entry
sheet or fixed startup-directory prefix. Cancel returns to the triggering control
without opening a project. Only the exact chosen project is granted to this tab;
other tabs retain their scope. Legacy `project.open` / `project.create` APIs keep
their root-relative, single-directory behavior for existing consumers.

Create project takes a display name and one or more Source folders. Add folder
uses the same system window; draft folders can be removed before creation.
Project names do not create directories and may repeat. Source content stays in
place. A named workspace has its own ID and private owner-state/working directory
beneath service state; its source folders are explicit references, not symlinks.
Overview lists source names and paths and can add more folders. Adding the same
folder again is a no-op. Existing single-folder projects can add sources too.

`project.source.pick` returns a short-lived, caller-bound choice receipt, with no
arbitrary path in its input. `project.createWorkspace` consumes those receipts
with a retained creation identity. `project.source.add` selects and adds a folder
to an already authorized project. Revocation/expiry is rechecked after the system
window closes. Fresh operator-paired tabs at the same original scope can reopen
its saved named projects; a narrower pairing does not inherit them.

Files owns resolution of `@<sourceId>/<relative-path>` references; Documents uses
that injected port for reads, conditional saves and restore validation. Equal
filenames in different folders remain distinct; overlapping aliases normalize to
one buffer within the workspace. Unknown sources, traversal, symlinks and internal
state fail closed. Sources missing later do not erase retained drafts or output.
Names and locations are shown in the UI; IDs remain resource-reference details.
Opening/adding folders starts no Host, executes no project code and installs nothing.
The native folder dialog is currently implemented for macOS only.

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
five minutes. A redeemed browser token can only reach the reviewed U1/U2 method ceiling.

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

U1 permits protocol/Skills discovery, project selection/creation and source-folder additions, capabilities,
snapshot/events, composition reads, document reads and bounded resource reads.
U2 adds `document.edit`, `document.undoOwn`, `document.revert`,
`document.history`, `document.change.read`, `data.page` and selection read/set.
Browser mutations require stable change identities and version conditions.
`session.grant`, document open/save/abandon/global undo, composition writes, native
actions, installation and archive writes remain excluded. Existing U1 sessions
retain their original narrower grants; pair a new tab for U2 access.

Static routes serve only HTML and named build assets, not arbitrary project files.
Responses enforce no-store, no-referrer, same-origin resource/opener policies and
CSP: same-origin scripts/connections, no eval, remote scripts or inline scripts.
Inline styles support the layout library. Assets are symlink-checked and bounded
to 16 MiB each; missing builds have a readable 503.

| Protected resource | Configuration / default | Exceeded behavior |
| --- | --- | --- |
| Native folder window | One per service; `nativeFolders.timeoutMs` / 120,000 ms; `maxOutputBytes` / 16,384 | Reject another window; timeout/output overflow stops the owned chooser and opens nothing |
| Pending source choices | `nativeFolders.maxSelections` / 64 per tab; `selectionTtlMs` / 600,000 ms | Refuse another choice or require reselecting an expired one; retain existing projects |
| Named projects / sources | `nativeFolders.maxProjects` / 128 per original scope; `maxSources` / 32 per project | Refuse new additions; retain selected folders and obtained output |
| Pending pairing codes | `browser.maxPairings` / 8 | Reject another code; retain grants |
| Active browser grants | `browser.maxSessions` / 16 | Reject redemption; never evict active tabs |
| Pairing attempts | `browser.maxPairAttempts` / 32 per minute | Refuse attempts until the window clears |
| Pairing lifetime | `browser.pairingTtlMs` / 300000 | The link stops working; the Agent opens a new one |
| Session lifetime | `browser.sessionTtlMs` / 43200000 | Deny requests/end observation; retain owner state |
| SSE | Existing service/observation limits | Resnapshot; stop after bounded retries |

Set browser budgets under `browser` in the existing `--limits` JSON. U2 mounts
at most eight heavy views per layout (lower with build setting
`VITE_RHO_MAX_HEAVY_VIEWS`); extra references show a limit state, preserving
existing views and input. Unconfirmed document text uses the smaller of the
owner’s `documents.maxBufferBytes` and 1 MiB. Over-budget editor transactions are
refused before replacing earlier input. Tables request 200 rows per block and
cache at most five blocks.

## SDK and contribution draft

`@rho-workspace/local/browser` exports `BrowserClient`, `BrowserApiError` and typed
U1 methods/snapshots, with no Node, DOM or React imports. Fetch/abort primitives
come from the runtime; importing the SDK reads no browser storage. The shell owns
sessionStorage; the separate Node client retains filesystem intent functions.
Its U2 methods share the service’s authenticated caller and owner conditions;
SDK type availability does not grant an operation.

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

`web/registry.tsx` uses the finite `ui-entries.json` build selection, with
Documents and Tables selected in the full build. `RHO_UI_PLUGINS` selects a
reduced frontend; `pack:local` derives it from the selected backend owners.
Unselected owner entry modules and their UI libraries are omitted from assets.
`dist/web/composition.json` records the selected package/component identities,
compiled entry digests, dependency versions/licenses and asset digest inventory. Descriptions cannot
provide executable code/module URLs. A missing entry or required operation produces
an inspectable unavailable view. Actual functionality belongs in Plugins optional
`./ui` exports; Rho owns mounting, theme, layout, focus and routing only.

Inside a project the sidebar lists Overview, saved layouts with their view counts,
and the project's documents and files; retained operations appear only when there
are some. The overview lists the same content as tables without JSON. An
unavailable view says what it shows, what it needs and what this build lacks,
offers About for its plugin with a way back to the project, and keeps identifiers
in the View reference disclosure.

When Rho can't be reached, a notice above the layout keeps what was already read
and says when it was read. Reconnect only reads again; it is disabled while a
reconnect is in progress, and the last failure is shown under Context & access.
The command palette filters commands by name in four groups (Go to, View,
Connection, This tab). Show and Hide follow the current state, and text that
matches no command runs nothing; questions about the work go to Claude Code.

Below 768 there is no rail or sidebar. The toolbar is 48 high with 36-pixel
targets and shows the layout name above the project and Read-only. Its left
button opens a navigation drawer with Home, Projects and Plugins, the project's
sections and Commands. Context & access opens as a bottom sheet with Done. Both
keep focus inside and return it to the button that opened them. Views are tabs
instead of a select.

Plugins lists this installation's plugins by category with copy from each
plugin's descriptor. A usable plugin shows no state. One that can't be used
gives the first reason and who can change it: not part of this installation,
needs another plugin, off in this project, or waiting for another plugin, with
About for that plugin. Plugins that are not part of this installation are
listed last. The page shows no Capabilities wording, state flags or method
names.

Category and entry ordering, icons, descriptions, Skills and dependency purposes
come from owner descriptors. External tool observations name their limited
scope: Rscript is checked as an executable file without running it. Missing or
unknown Rscript availability has owner-authored copy and leaves exported object
reads available. Actual native conditions are checked when an action is invoked.

Plugins has its own sidebar with All plugins and each plugin. A plugin's page
shows its example prompts to copy, body description, Skills, what Claude Code can do with it, its views
and Information: whether the open project uses it, the plugins it works with,
category, version, package, developer, license and public links. Opened with About from a project, it offers the
way back to that project. The toolbar's Plugins returns to the catalog.

The build freezes a descriptive `dist/plugin-inventory.json` from the nine
reviewed owners. Reduced installations retain those introductions without
importing missing owners or adding operations, callable Skills or grants.
Assembly records the inventory digest and its owner source commit. Selected
owners replace the build copy with their real descriptor when loaded.

## Checks and evidence

```sh
npm run build:web
RHO_CORE_BINARY=/absolute/accepted/rho-core npm test
RHO_CORE_BINARY=/absolute/accepted/rho-core npm run test:ui
npm run test:ui:plugins
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
- the offline notice, reconnect making only reads, and same-port restart
- stable-ID updates and command focus
- the command palette: filter, groups, state-following verbs, arrow keys and
  typed text that matches no command running nothing
- below 768: no rail or sidebar, the navigation drawer and context sheet
  keeping and returning focus, and view tabs
- Plugins without Capabilities wording, state flags or method names, the off
  and waiting states with their reasons, the plugin sidebar and the project's
  state under Information
- disconnect confirmation and Escape focus return
- the project overview, unavailable views without JSON, and About with Back
- 1600/1280/1024/768/390 widths

`test:ui:plugins` renders every plugin's descriptor copy, copies each example
prompt, returns focus to the card and checks a catalog without optional display
fields. Instrumented Host-start/native-submit attempts must both be zero.
The same script accepts `RHO_PACKAGE_ROOT` for fixed installed packages and
checks physically absent owners, their introduction and the lack of callable
entries. Missing selected Rscript is checked separately in a full installation.
Reports contain asset IDs and results, never pairing/session credentials.
Inspect screenshots in addition to overflow assertions.

The driver is not a production dependency. Select explicit paths with
`RHO_UI_PLAYWRIGHT_MODULE`, `RHO_UI_CHROME`, `RHO_UI_EVIDENCE` and optionally
`RHO_UI_PLUGINS`. This host has Chrome 155, not the planned 154. Physical macOS IME input and actual browser/human/Agent closure remain separate gates;
U2’s Chrome composition and clipboard checks are recorded below. A U1 pass
is not UI collaboration, overall product or signed-release acceptance.

## U2 editor and table consumer

`npm run test:ui:u2` builds and runs the Documents/Tables browser scenario;
`npm run acceptance:ui:u2` runs the same check against existing assets. It accepts
the same driver/package/evidence environment settings as U1.

Live editor views share one browser adapter per document and client. Only the
paired session’s principal ID labels edits “You”; a document or receipt author
never changes that identity. Inputs are serialized with their original
`changeId`, conditions and group. Lost replies retry that exact input. IME
composition neither submits intermediate text nor applies remote edits. A stale
input keeps a copy, pauses automatic submission and offers Copy/Dismiss; the copy
is local to this tab, not persisted through browser closure. Documents owns undo;
keyboard redo is disabled. The tab-bar switch controls Agent line marks; Changes
provides exact Show before and individual Agent-change Revert.

Exact version bindings use retained owner snapshots separately from the live
adapter. Already read exact text stays pinned. A fresh read outside retained
history shows unavailable and keeps the original reference; it never substitutes
current text. Pinned views have no Changes panel.

Tables use the Infinite Row Model with one sort and one typed filter. Removing a
filter resets the exact row count. Key/namespace plus the original resource
version establish identity; selection uses an explicit shared channel named by
view ID. Unkeyed tables remain readable with selection unavailable. “empty” is
italic and distinct from literal strings such as “NA”.

See [U2 acceptance](U2-UI-ACCEPTANCE.md) for executed source/installed checks and
remaining boundaries. U3/U4, actual-model UI collaboration and physical macOS IME
input remain separate from these browser composition tests.
