# Connecting your own Agent with one prompt

Date: 2026-11-06. Source changes after Rho 0.5.5; package publication and installation
are separate. This episode changes Rho only. Core and Plugins are unchanged.

> Superseded in part on 2026-11-07: the Agent page now has Conversations and
> Agents; the setup prompt sits under Agents, and New conversation settings became
> the Agents list ([session continuity](SESSION-CONTINUITY-EPISODE.md)).

## Question and observed problem

The person could not tell whether Agents or Connections was where to connect their
own Agent. Agents configured conversations started inside Rho; Connections offered
brand-specific Claude Code and Codex buttons beside an ACP relay option. Those
choices made a generic MCP capability look like a two-client restriction.

The question was whether the person's own Agent could configure itself from one
copied prompt, without another brand-specific form in Rho.

## What changed

The Agent page has Conversations and Connect your agent. The default Agent and
model choices now sit under New conversation settings in Conversations and explain
that they apply inside Rho. Connect your agent leads with a copyable request and a
selectable full prompt. Existing grants appear under their actual session names,
with waiting, verified last call, refusal or ended access states.

The local-browser/operator-only `session.instructions` reads the running launcher's
program and argument array and exact project identity. It includes no credential
contents, starts nothing and grants no access. The Agent runs the existing grant
CLI, chooses its own stable session name and registers the returned stdio MCP entry
using its own client. The added `--project-id` selects a registered project without
reopening a guessed path, including a folder selected outside the service root.
The old named CLI shortcuts remain compatible.

Repeated setup with the same scope keeps its valid credential. Changed methods,
expired access or a stale address require a fresh one. Granting now emits a browser
invalidation: the first browser run exposed a grant that existed but was invisible
until another event or reload. Refused calls remain visible and a successful retry
uses the same connection.

## Real runs and corrections

`node scripts/agent-connect-episode.mjs` creates a disposable Unicode/spaced project,
an isolated Claude configuration directory and a real service without Core. Chrome
copies the prompt through the real clipboard. The Agent receives that exact prompt,
plus the boundary that its configuration belongs in the disposable environment.
Existing model credentials travel only through the process environment.

Two initial harness failures were corrected: reload returned to the project's
Overview rather than its Agent page, and a variadic CLI option consumed the prompt.
Neither was evidence of an Agent configuring itself.

The next run configured a shared project MCP entry. Claude's own approval and the
harness's disabled settings sources kept the fresh client from loading it. The
Agent had separately made a direct stdio probe, and the original assertion wrongly
counted that earlier receipt as the new client's success. Reading both replies
invalidated that run (`work/agent-connect/1793992731271/report.json`, review field).
A direct server probe proves the server answers, not that the client's tools work.

The prompt now requests private local configuration outside version-controlled
files and checks `scopeHint.projectId`, which `rho_index` actually returns. The
harness uses the isolated client's normal settings sources. Verification requires
both a fresh native `mcp__…__rho_index` tool-use event and a new successful server
receipt after the second session starts; an earlier probe cannot satisfy it.
A further run loaded the tools but the harness’s wildcard permission did not
authorize them in Claude’s `dontAsk` mode. The harness now names the exact
`rho_index` tool it is testing and requires zero permission denials; it changes
no user configuration or native permission policy.

The final run (`work/agent-connect/1793993054868`) passed: Claude Code 2.1.319
configured its own private local entry in 27.1 seconds, then a fresh client called
`mcp__rho-study__rho_index` in 8.5 seconds. The returned project ID matched, both
sessions had zero permission denials, and the first session honestly reported that
its own tools needed a new session. No project configuration file was written.
The harness asks only for the ID that `rho_index` supplies; an earlier request for
a folder path led to additional, ungranted diagnostic calls and was narrowed.

## Checks and screen review

- `npm run build`: service and WebUI compiled. The existing large-bundle and mixed
  static/dynamic import warnings remain.
- `npm run check:contracts` and `npm run test:contracts`: generated schemas/types
  match the implementation; 11 contract checks pass.
- The Agent connection, CLI refusals, browser, MCP and progressive-disclosure tests:
  30 pass with the existing Core debug binary explicitly selected. The first run
  lacked that binary for its managed MCP case and omitted Origin in a new pairing
  test; both failures are retained in the local logs.
- `npm run acceptance:agent-page`: settings, conversations, export, trash, generic
  grants, refused calls and recovery pass in Chrome. Its conversation peers are
  controlled fixtures, not model trials.
- The connection episode checks a real clipboard, a failed instructions request
  and retry, denied clipboard access with selectable text, Unicode/spaced paths,
  and the setup screens at 1440, 1024, 768 and 390 px. The screenshots show the
  prompt before connection details, no brand picker and no horizontal overflow;
  the narrow layout wraps the copy action and keeps the full prompt accessible.
- `npm run docs:assemble`, `npm run docs:check` and `npm run docs:build`: 58 pages
  and 324 rewritten links; changed pages rendered and read, with their new anchors
  resolving. The initial check correctly required regenerating navigation after
  the new episode was added.

The private run directories and raw model outputs stay in ignored `work/`. No
credentials or private service addresses are source evidence. Setup with another
client, remote/HTTP-only MCP clients, Windows and independent usability remain
unverified by this episode. This work adds no new Agent execution adapter and does
not move an external conversation's input into Rho.

## One list and ready entries

2026-11-07, after Rho 0.5.6. The person gave the setup prompt to DeepSeek
Harness, in its Desktop app on the PA14 project. Harness connected itself, and
`rho_index` answered in the same session, but the whole connection took 8 min
52 s. The Agent then broke its own run down: Rho's part was about 0.3 s (grant
0.18 s, MCP start 0.19 s, `rho_index` 0.08 s). It spent 194.5 s looking for
how Harness adds an MCP server and 87.8 s reading four package READMEs to find
it. Harness has no `dsh mcp` command; the entry belongs in the profile patch
`~/.dsh/profiles/desktop/cordis.patch.yml`, which reloads within seconds. Its
own suggestion was a ready `dsh` entry in Rho's reply.

On the Agents tab, the connected window appeared only in a separate "Agent
windows connected" list below the setup prompt, with no mark. OpenCode was
listed as `opencode` with an initial.

What changed:

- **Ready entries.** The grant reply now also gives `codex`, `opencode` (the
  file and the entry to merge) and `dsh` (the profile patch and the entry to
  append), beside `mcp` and `claude`. The setup prompt tells an Agent to use
  the entry for its client, and the Rho skill's connection guide describes the
  OpenCode and Harness mechanisms.
- **One list.** The Agents tab lists every Agent of the project in one row
  design: those Rho starts, and those connected from their own windows. A window
  sits under the Agent it belongs to, with its state, its grant and its last
  call. The setup prompt follows the list.
- **Whose window.** The MCP bridge (Agent 0.4.31) sends its client's own
  `clientInfo` name and version. Rho keeps it with the grant and uses it to place
  the window and name it. When a bridge does not send it yet, the session name
  the Agent chose decides.
- **Marks.** OpenCode has its own mark, drawn from its brand files in the
  theme's ink. Names containing `dsh` take the DeepSeek mark and the name
  DeepSeek Harness. An Agent with no known maker keeps its initial.

Runs after the change:

- **OpenCode setup again.** The setup prompt was given to OpenCode 1.19.5 in a
  disposable project, with the same model and no auto-approval. It used the
  `opencode` entry and finished in 90 s instead of 213 s, with 9 tool calls.
  The new session called `rho_index` in 16 s, and Rho recorded its client as
  `opencode 1.19.5`.
- **Agents list.** With an OpenCode window and a Harness-named window, the list
  showed OpenCode's row with its window beneath it, and a DeepSeek Harness row
  with its window. There was no overflow or page error at 1440 or 390 px.
- **The person's own 47101 page.** It serves the rebuilt pages from disk. With
  its earlier service still running, it showed `dsh-deepseek-agent` as DeepSeek Harness and a
  WorkBuddy window under its initial.
- **Hermes Agent.** It connected itself to PA14 as `hermes-agent-yonghe` and
  is listed under its initial. Its code leaves the Python MCP SDK's default
  `clientInfo`, `mcp` 0.1.0, which would have named its window `mcp`. A
  library's default name is now ignored, and the session name the Agent chose
  names the window. The Agent page acceptance sends `mcp/0.1.0` and checks this.
- **Marks from a plugin.** Rho drew four marks of its own, so Hermes and
  WorkBuddy showed initials. The person supplied a collection of 54 Agent and
  maker icons, each compared with its product's site. It is now the Agent icons
  plugin in Rho-plugins, which has 62 entries: Claude Code, Codex, OpenCode and
  Nous Research (for Hermes) were added from the same lobehub version. A
  disposable service had windows named as on the PA14 page. It showed Hermes
  Agent, WorkBuddy, DeepSeek Harness and OpenCode with their marks, and
  My-research-agent with its initial, at 1440 and 390 px.

Checks: the full Rho suite passed (315, none failed, 2 skipped). The
connection test now also covers the ready entries, the absence of credentials in
the reply, a stored client name, and an unprintable name being ignored. 33
Agent plugin tests, 4 Agent icons tests and the Agent page acceptance in Chrome
passed.

Limits:

- Harness was not run again with the `dsh` entry. Only the person's own Desktop
  run is measured, and the entry assumes the `desktop` profile.
- What name Harness's MCP client sends was not observed.
- An Agent is still known only by words in its name. One whose name has no
  word in the catalog shows its initial, and an Agent cannot give its own icon.
- The person's 47101 service runs the earlier server until it is restarted. It
  does not yet keep client names or give ready entries.
