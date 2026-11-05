# dsh analysis, Rho results and a selected-row question

The current **0.1.4** local bundle matches tools and the launcher to each
conversation's project; see [project matching](#conversation-project-matching).
Version 0.1.2 added the visible entries; see [Desktop installation](#desktop-installation-and-visible-entry-points).
The [earlier November 5 episode](#reuse-the-whole-rho-application) records 0.1.0. The first episode below
records the retired 0.0.1 embedded-view prototype, whose source remains in Git.

2026-10-31 local / 2026-11-01 UTC. This episode implements the requested
`dsh-rho` prototype: analyse in dsh, show the outputs with existing Rho components,
select a result and continue the original conversation. It follows the native
plugin example in [dsh-context](https://github.com/bowenliang123/dsh-context) and
the installed dsh 0.2.1-rc.5 public APIs. The result is a local package, not a
published npm or signed distribution.

## What was built

The application adapter lives in [the 0.0.1 adapter](https://github.com/YuLab-SMU/Rho/blob/dfd305fbff03cbdae6a4d2296fd70028ff0ad1be/adapters/dsh-rho/README.md).
Its Cordis host registers `rho_present` and an authenticated result-reading route;
its browser entry contributes **Rho** to dsh's `conversation.view` slot. Native
session identity supplies both the tool's caller and the view's result scope.
dsh owns analysis, permissions, tools, model and history. It is not started as a
second Agent inside Rho.

The selected owners are Files 0.5.0, Tables 0.5.0, Media 0.4.0 and Contracts 0.4.0
from Rho-plugins commit `1173789010e4679180804aa309e661b218198f70`. Their public APIs,
TableView and MediaView are consumed unchanged. The adapter supplies composition,
session archives and a transient selection port; it reuses Rho's existing POSIX
writer lease. No Core or Rho-plugins source changed, and neither the Core Host nor
the Rho backend is started.

`rho_present` captures completed project files. CSV columns and types are explicit;
row selection needs a unique string key. Questions resolve those keys against the
captured version, then use dsh's native revision-checked draft insertion and normal
Send action. A question can be read or revised before sending. Closing the view,
reading a result and reconnecting do not execute analysis.

## Real episode and observations

The owned fixture used a disposable project and isolated `DSH_HOME`, dsh
0.2.1-rc.5, Node 22.22.3, Python 3 and headless Google Chrome on macOS. It used the
existing configured gateway with `westlakehpc/deepseek-v4.1-flash`; credentials were
read in memory and not put in source, patches or evidence. The person's running
Desktop Harness and projects were not restarted.

The six input values were alpha: 1, 2, 8 and beta: -3, 4, 7. A single native prompt
asked dsh to write and run a standard-library Python analysis once, append one run
marker, emit a CSV and SVG, and present both with `rho_present`. The model wrote
`analysis.py`, ran it and presented both outputs. The run took 3 minutes 32 seconds.

| Group | Observations | Mean in retained CSV |
| --- | --- | --- |
| alpha | 3 | 3.6666666666666665 |
| beta | 3 | 2.6666666666666665 |

The browser showed both rows and the labelled two-bar figure. Selecting alpha
changed the question label to **Ask about 1 selected row**. A Chinese question
asked for its group, count and mean and whether this was the overall mean. The
pre-existing draft `请用中文回答。` survived insertion. The added context contained
only alpha, its exact numeric values, original path, snapshot digest, capture time
and the same session ID. Sent once through the native composer, the model answered
in 13 seconds: alpha, n = 3, mean approximately 3.67; this was alpha's mean and did
not establish the combined mean. It ran no analysis for the question.

Retained identities:

- Session: `session-38a2a4c4-1e62-46f3-8ff6-234d7d098ca7`.
- CSV tool call: `chatcmpl-tool-a6473a9aeace26b0`; SHA-256
  `e2bba75703875eb8484e302157f29d28a42705fa3b21332897bf86f87ba31017`.
- SVG tool call: `chatcmpl-tool-a9ee726ca0c532ff`; SHA-256
  `1cb9430aed9b827880f63b866e539215b2daeab70926119ff4dfb22f9a027cb0`.

## Failures that changed the implementation

1. Loading an absolute package directory as a host module failed with an ESM
   directory import error. The source fixture now resolves the package by name;
   delivery uses an ordinary tarball installed by `dsh plugin`.
2. The first model session used dsh's retained default workspace instead of the
   disposable folder. It found no input and did no analysis. The fixture now
   explicitly creates/selects its workspace with dsh's public controller. The
   installation instructions require choosing the matching folder in dsh.
3. Comparing the browser Origin with the handler's internal request URL rejected
   valid result reads. dsh uses a carrier-neutral internal URL. The adapter now
   relies on the connection service's authenticated `/api` boundary and retains
   the cross-site refusal; it still validates original session and project scope.
4. Files' captured resources name archive paths. Routing those paths back into
   the analysis project made four initial store checks fail. The adapter's path
   provider now resolves captured internal paths in its archive and ordinary
   paths through Files' project containment. All five store checks then passed.
5. An exclusive lock file survived the first owned-host shutdown. Reusing Rho's
   kernel-held writer lease removed stale-unlink/PID-reuse recovery. A second
   writer is refused, and the installed plugin reopened the same archive after
   both normal shutdown and an abrupt kill of its owned dsh process.

A browser assertion initially read an empty draft before asynchronous insertion
completed. Waiting for the native Chat view switch resolved the observation; the
same captured values were then verified. No analysis prompt was resent. Package
assembly also caught nested AG Grid package metadata without adjacent licenses;
notices now come from each actual bundled dependency root, including `ag-stack`.
An installation-guide dry run also showed that `npm --prefix ... pack` selected
the root application. The verified command now names `npm pack ./adapters/dsh-rho`.

## Verification and installation

`npm run build`, five store tests and a TypeScript check over the adapter's three
source files passed. The tests cover snapshot overwrite/reopen, original-call
retries, scope/path/key rejection, budgets and competing writers. They do not
claim full Rho application acceptance; its unrelated suite was not run.

In the real browser:

- Table and SVG views, row selection, the existing Chinese draft and same-session
  model continuation all worked. Screens were inspected at 1440, 768 and 390 px;
  narrow results use scrolling. No browser page errors were recorded.
- Offline result reads showed an error and **Try again** while keeping displayed
  results. Restoring the connection recovered those same results.
- Editing the chat draft while a delayed question request was pending refused
  insertion and kept `Newer draft ✓` intact.
- Refresh and a normal owned-host restart restored the original conversation and
  both results. The test then installed the tarball through
  `dsh plugin --profile web add <tarball> --ignore-scripts --offline`, which added
  and enabled its bundle. Its archive and draft insertion worked after launch.
- Overwriting the original CSV with alpha mean 999 did not alter the displayed
  snapshot or the selected-row question, which still carried 3.6666666666666665.
  The test restored the original CSV afterward.
- After an abrupt owned-host process kill, the installed package reopened the
  archive and original session without removing the lock file. At the end,
  `run-count.txt` still had exactly one line and the archive still had two results.

Local evidence is under `work/dsh-rho/prototype-03/`: `evidence.json`, `chat.txt`,
the native question drafts, original CSV, screenshots of empty/results/selection/
answer/failure/recovery/narrow states, and `dsh-rho-0.0.1.tgz`. The private launch
address stays outside the repository. The fixture and native session history are
retained in the disposable `/tmp/rho-dsh-prototype-03` directory. The package's
composition manifest records exact bundle inputs and selected local overrides;
it is not an official release attestation.

The delivered package is `work/dsh-rho/package/dsh-rho-0.0.1.tgz`, SHA-256
`4ffe8b2798d2d0ead6e558f9d26599bd63b1d5d0b7eecd54efa85684e5396266`.
Final review keyed result choices and questions by original tool call as well as
snapshot, so two presentations of identical bytes retain their own titles. The
five tests and strict type check passed; the final tarball was installed again,
and its table, figure, native draft insertion and original call ID were checked in
the same session without resending analysis. The run count remained one.

## What this establishes and what remains

This observed episode establishes the requested local loop with reused components
and one native dsh conversation. The adapter is deliberately one-project and one
selected dsh release candidate. It has no general Studio, notebook, live variable
inspection or automatic output discovery. Row selections are transient, image
questions carry references rather than pixels, and a question's structured context
is visible in the native draft. React comes from Harness; broader compatibility
with the components' declared React peer version is not established by this run.

The [0.0.1 package README](https://github.com/YuLab-SMU/Rho/blob/dfd305fbff03cbdae6a4d2296fd70028ff0ad1be/adapters/dsh-rho/README.md#ownership-and-limits) names the
budgets, configuration and refusal behavior. Invalid table content can leave a
bounded captured file unlisted. There is no silent deletion of earlier results or
automatic replay of unknown work. Independent researcher use, Desktop/TUI entry
points, Windows locking and public package distribution remain untested.

## Reuse the whole Rho application

2026-11-05. The user asked to reuse the existing Rho at the lowest integration
cost. Inspection of Harness 0.2.1-rc.5's installed MCP client and bundle reference,
and its [public bundle documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-preset/skills/cordis-plugin-development/references/mcp-bundle.md),
showed that a bundle can contain configuration without Host or Client entry code.
Rho already supplies the project grant, stdio MCP bridge, full WebUI and frozen
review-context handoff. These existing boundaries were sufficient for the flow.

The 0.1.0 adapter now contains two configuration files, README and license. Its
patch mounts Harness's existing MCP client and runs `rho --mcp` with an existing
agent connection file. It adds no tool implementation, browser entry, service,
result archive, Skill copy or model configuration. The previous 297 lines of
runtime TypeScript, build script, lockfile and obsolete store tests were removed.
No Core or component source changed. Rho's WebUI stays in its own window; its
iframe policy was not relaxed. Unlike 0.0.1, returning a question requires one
explicit copy/paste into the original Harness conversation.

### Installed application episode

The disposable project was `/private/tmp/rho-dsh-reuse-20261105/projects/analysis`,
with separate service state and `DSH_HOME`. The service used an already installed
`@rho-workspace/rho@0.5.3` from `/tmp/rho-npm-053`, with its packaged components;
no application build was needed. Source main was 0.5.4, but the registry returned
404 for that version at the time of this check. The person's other Rho service,
Harness Desktop and projects were left running unchanged.

An owned Rho service granted this project to session `dsh`. The 0.1.0 tarball was
installed through `dsh plugin --profile web add … --ignore-scripts --offline`.
The unchanged `skills/rho` directory was linked into this trial's Harness skill
folder. The model actually read it, resolved Rho operations, wrote a Python
standard-library script, ran it through `kernel.run` and registered a keyed CSV
and SVG through `resource.register`. Model credentials stayed in memory, outside
the bundle and evidence.

The first configured model route, `westlakehpc/deepseek-v4.1-flash`, failed with
an upstream duplicate-item-ID error after its initial tool calls. Both Chat
Completions and Messages attempts failed, including a clean Messages session.
The project still contained only the input file, and no Notebook cell had run.
The trial then selected the already configured default route
`fusecode-lab/claude-opus-5-5[1m]` through Messages. This succeeded. These are the
configured route names, not independent verification of the model providers.
The bundle makes no model selection and did not work around the failed gateway.

The successful analysis took 59 seconds in Harness. The six input values were
again alpha: 1, 2, 8 and beta: -3, 4, 7. The script wrote:

| Group | n | CSV mean |
| --- | --- | --- |
| alpha | 3 | 3.666667 |
| beta | 3 | 2.666667 |

Notebook cell `k-441c12dcff1d7d0b`, change ID `analysis-run-20261105-1`, completed
in the shared Python 3.13.1 session. Its output included both means, the CSV and
`run-count lines: 1`. In the real browser, the Notebook showed the code, output
and live `ns` value; existing table and media views displayed the two rows and the
400 × 300 SVG. Existing project notes were readable alongside the Studio table.

Selecting alpha and asking in Studio created question
`q-99d55f47-8bcb-4f1b-bc57-b9bd9bcb7cc7`, with frozen context
`1f4d589da930eaf21214d9024bfabedc7c5b76e1c7f655c674c1fd613269636d`.
The retained CSV digest was
`014d7d55f837f35a400dededec75999c5becd392a5355461be2795862509a4ca`.
Through Review's **External Agent · copy request**, that context request was
pasted and sent in the same Harness session. In 46 seconds the model read the
context and wrote `annotation.reply`, retaining its original message identity and
exact result versions. Rho displayed the Chinese answer: alpha, n = 3, mean
3.666667, the mean of that group rather than all six observations. The answer
created a reply document; it did not run the analysis again.

The actual route needed **Open in Studio**: the ordinary file preview selected
rows but did not show the question control. On this installed version, **Review
this question** left the Studio visible, so the trial used the **Review** sidebar.
Reading the clipboard before the asynchronous copied confirmation initially
returned empty text; the disabled Harness Send button prevented an empty turn.
Waiting for Rho's copied confirmation supplied the exact context request. The
guide now follows these observed controls. No claim of one-click delivery is made.

### Packaging and recovery checks

The final package contains exactly `package.json`, `cordis.patch.yml`, `README.md`
and `LICENSE`: 15,053 bytes compressed, 41,643 bytes unpacked. No dependencies or
install/build scripts run. It was installed again with the ordinary offline bundle
installer. A missing connection file then produced `ENOENT` and Harness's
`rho-mcp … initial connection or tool synchronization failed` warning; Harness
opened with the entry unavailable. The Plugins page showed installation, which
by itself did not establish MCP readiness. Rho was not started or restarted by
this failure.

While the owned Harness was stopped, the Rho Notebook remained idle with its
original live value and one cell. Restoring the correct connection and restarting
only Harness reopened the same conversation and allowed a passive read of the
original cell. The run counter stayed one. The bundle's five-minute MCP reply
wait is configurable; this episode did not exercise long-running cells, all four
tools' large-result paths, other operating systems, Desktop or TUI.

Local evidence is in `work/dsh-rho/reuse-01/`: chat and handoff text, the missing-file
log, package inventory, screenshots of Notebook, table, figure, question and reply,
and the observation summary. The private launch addresses and credentials remain
in the disposable trial directory. The final tarball is
`work/dsh-rho/package/dsh-rho-0.1.0.tgz`, SHA-256
`8b3b56f9d1c3370e8256ce167cece8753acd5a569e822e3036f4baadca64fd1e`.

The minimum entry route is an ordinary Harness bundle. Its
[market reader](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-market/README.md)
uses user-configured indexes and has no default index in the tested release. Git
subdirectory packages are supported by that installer, so a listing can point to
an available source commit without packaging Rho again. Public Git installation,
npm publication and market inclusion were not performed. The local package stays
private. The old 0.0.1 source history and archive bytes remain; no migration or
archive deletion was attempted. This is one observed integration episode, not
full application acceptance or independent usability evidence.

## Desktop installation and visible entry points

2026-11-05. The user installed the connection-only bundle and found no Rho tab or
button in Harness. The missing entry was visible in their screenshot. Version
0.1.2 adds **Rho** to `conversation.view` and `sidebar.panellist`, both opening a
small launcher. **Open Rho workspace** uses the existing `sidebarRight.openTab`
Browser to display the complete application beside the conversation. **Open in
system browser** remains available. The Rho application and its iframe policy
are unchanged; Desktop uses Harness's native webview.

A small Host route reads at most 64 KiB from the chosen agent connection file,
extracts its local service address and project ID, and returns only the project
URL. Credential fields never leave the Host. It refuses remote or
credential-bearing addresses, missing project scope and oversized files. The
launcher neither starts a service nor submits analysis. The existing MCP entry
and four tool names are unchanged. React comes from Harness; only the launcher
is built, with esbuild 0.25.12. No Rho component code is bundled or modified.

The real installation used the person's already running Harness Desktop
0.2.1-rc.5 on macOS and the existing Rho 0.5.3 trial project `analysis`. Its original
service, Notebook, one cell and retained results remained in place. Desktop
refused `dsh plugin --profile desktop` because the Electron application exclusively
owns that profile. Its **Plugins → Add plugin → Enable now** path installed the
local tarball successfully. The prior profile files were backed up outside the
repository. The unchanged Rho Skill was linked into Harness's skills directory.

An initial partial MCP config override failed schema validation: a profile
`config` replaces the complete object, so command and arguments alone dropped
`serverName` and `transport`. A complete override and a bundle off/on recovered
it. Desktop's Finder launch did not use the shell exports, so its profile now
explicitly names the same agent connection for the MCP and launcher entries.
Neither the other configured MCP servers nor their grants were changed.

In the actual Desktop window, both Rho entries appeared and the final bundle
reported **2 running** components. The conversation tab's open button and the
sidebar's open button both displayed the full Rho project inside Harness's Browser.
Switching back to Chat kept Rho beside it. The existing `summary.csv` displayed
alpha (3, 3.667) and beta (3, 2.667), with alpha's prior selection retained. The
final screen was visually inspected and left open for the person. This check
opened existing work; it did not run a new model analysis or establish another
selected-row model continuation beyond the earlier episode.

An isolated Web Harness exercised a missing launcher connection: the entry stayed
visible, **Open Rho workspace** was disabled, and **Try again** was available.
Restoring the file and retrying recovered the same launcher without restarting
Rho. Another run found that a missing Browser provider switched away from the
launcher before displaying its error. The final client checks the tab registry
before navigation and restores the prior panel on a failed open. Repeating the
same Web action then kept the launcher, its explanation and its system-browser
link visible. Reusing the same local tarball version initially retained an older
pnpm asset; checking actual installed bytes caught this, and the final 0.1.2
package uses a distinct version and tarball identity.

The adapter build and both credential-projection/error-route tests passed. The
final installed Desktop files were compared to the source package. The tarball
has six files and is 19,011 bytes compressed (51,727 unpacked), at
`work/dsh-rho/package/dsh-rho-0.1.2.tgz`, SHA-256
`60dbeb0a5417d92682fa169f1fcb6d33e9efd6418bb4704b71bfe7a68c0d11cd`.
Local evidence is under `work/dsh-rho/launcher-01/`, including the Desktop window,
missing-connection and recovery screenshots and the installed-package summary.
The owned Web check is disposable; the person's Desktop and existing Rho services
stay available for their trial. Public distribution, TUI, other operating systems
and independent usability evidence remain outside this check.

## Public Git distribution

2026-11-05. The user asked to complete the publisher's work for market discovery,
leaving user configuration alone. The npm account check returned HTTP 401, so this
release uses Harness's documented commit-pinned Git package source. No npm
publication is claimed. The existing source package omitted `lib/`, which makes a
source-only Git install incomplete without running a build. Version 0.1.3 tracks
the prebuilt client with its source and adds an exported English display locale,
the existing Rho SVG icon, author, homepage and search keywords. It has no install
or prepare lifecycle script, and keeps the checked `engines.dsh: 0.2.1-rc.5` range.

The Host, built client and MCP patch match the installed 0.1.2 package byte for
byte. No Rho component or runtime behavior changed. The launcher build and both
adapter tests passed. The packed candidate has eight files, is 19,642 bytes
compressed (53,288 unpacked), and has SHA-256
`34f0ac6e29b562a331ea2536c55d2f85d50b31f439d410499174311fbf2f9c2f`.
The inventory is under `work/dsh-rho/publish-01/package/`.

`adapters/dsh-rho/market.mjs` reads one explicit, full source commit, including
its built client, locale and icon, and generates the index from that version's
manifest and commit timestamp. Public Git installation, official index validation,
search and public index delivery are the next observations; the person's existing
Harness configuration and Rho sessions are not part of those checks.

### Public installation

Source [`f3248a8a`](https://github.com/YuLab-SMU/Rho/commit/f3248a8ad5e1b3a5744dd04f899d0f4373995851)
was published before the index reference. Harness 0.2.1-rc.5 installed its exact
Git subdirectory target in two new profiles, using separate empty pnpm stores and
no Git credential helper. The first disabled install scripts; the second used
the normal defaults. Both completed successfully, downloading one package, in
about seven seconds. The scripts-disabled run printed pnpm's generic Git build
warning, but its eight distribution files were present and matched the source.
The normal installation needed no build approval or additional dependencies.

Harness's own `dsh-plugin-market-index` 0.2.1-rc.5 accepted the generated index
and produced the same commit-pinned install target. Its Rho title, icon, author,
homepage, keywords, version, source and compatibility are read from that fixed
package. The index's timestamp is the source commit's committer time. The
publisher's checks use disposable Harness homes; the person's installed Desktop
bundle and existing Rho/Notebook sessions are unchanged.

In an isolated Web Harness, the optional Discover bundle read a local preview of
that same index. Searching `Rho` displayed one card with the original rho icon,
Prototype label, version 0.1.3 and YuLab-SMU author. An unmatched query showed
`No plugins match`; restoring `Rho` recovered the card. Its detail page displayed
the exact commit and package directory and marked 0.1.3 **Recommended Installed**.
The public package's sidebar launcher loaded too: with no Rho connection supplied,
it kept the disabled open button, explanation and **Try again**. The fixture
disabled `rho-mcp`, so this was a package, metadata and discovery check, without
a Rho service or model analysis. Screenshots are in `work/dsh-rho/publish-01/`.

The page assembler now carries `site/market/` into the Pages output alongside
the existing documentation. The documentation build and coverage check pass with
54 documents; the rendered site's local links and anchors resolve, and the 123
existing files outside the front page and documentation remain byte-identical.
The generated index and public guide are the publisher's deliverables. Enabling
a market source in a person's Harness is outside this change.

## Conversation project matching

2026-11-05. A person's Harness conversation had opened their real project in a
second Rho service, while the plugin's global grant and launcher still selected
an earlier disposable `analysis` project. The conversation and **Open Rho
workspace** therefore referred to different folders and services. The launcher
did not show either identity. Changing only the URL would leave the tools on
the wrong project.

Version 0.1.4 selects an existing grant by the conversation's canonical working
folder. It verifies that folder against the project's read-only Rho observation,
then gives the same selected descriptor to the conversation's own official
Harness MCP client and launcher. The global `rho-mcp` component is removed.
Both launcher entries show the project name, full folder and service address.
No match or multiple matches refuse both the link and tool access; the panel
names the conversation folder and reachable configured projects. Subfolders do
not broaden a grant, and a symlink to the same canonical folder does match.

The first real Harness check exposed a lifecycle mistake: `agent/created`
delivers `{ agent }`, not the Agent itself. After correcting that owner code,
two same-named Unicode projects on separate disposable Rho 0.5.4 services each
returned their own project ID from a real `mcp__rho__rho_index` call. Each ID
matched its launcher's project URL. A third, unconnected conversation had no
Rho tools, returned a launcher refusal and refused a forced tool call. Switching
projects in Web Harness visibly changed the full folder and service address.
The unconnected card kept **Open Rho workspace** disabled. The Web fallback
opened the selected project's actual Rho page in a separate browser tab.

Six adapter regression tests pass, including two-service matching, Unicode,
symlinks, ambiguous grants, missing connections, restored-file recovery,
per-Agent attachment and replacement of a live descriptor. A read never resumes
a dormant Agent or starts a bridge. **Try again** can retry an initially failed
connection for a live Agent; changing an already bound descriptor refuses new
calls until plugin reload, without replaying work. The plugin checks the current
folder again before each Rho call. It permits eight active conversation bridges
by default (`maxBridges`); exceeding the limit refuses the new bridge and keeps
existing ones. Probe and response bounds are recorded in the package README.

The person's Desktop 0.2.1-rc.5 profile was backed up before upgrading the local
bundle to 0.1.4 and replacing the two old overrides with one configuration of
already-existing project grants. Their original conversation's Rho tab showed
the correct full folder, and its button opened that same real project in the
Harness Browser. The running Rho services, scientific sessions, conversation
history and background task were retained. No new model turn or scientific
execution was requested for this check. Local evidence and disposable fixtures
are under `work/dsh-rho/workspace-01/`; the tarball is under
`work/dsh-rho/package/`. All nine installed files match the source; the 23,231-byte
final tarball has SHA-256
`f27327bfacc067049f4ef541a6eb7891ffc3c879e3669d43e09a45f7be4ebe8a`.
The 0.1.3 public market selection is unchanged. TUI,
other operating systems and independent usability remain unobserved.
