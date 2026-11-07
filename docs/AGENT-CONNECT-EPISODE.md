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
