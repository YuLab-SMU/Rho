# OpenCode through the standard boundaries

Date: 2026-11-07. Source changes after Rho 0.5.6; Core and Plugins unchanged.

## Question

The test from the [session continuity](SESSION-CONTINUITY-EPISODE.md) review: can
an Agent that Rho has never been checked with join through standard boundaries
alone? Three paths were run separately: the Agent uses Rho from its own window
(MCP), the person talks to it in Rho (ACP), and one session moves between the
two. OpenCode 1.19.5 was installed and configured on this Mac with its own model
(GLM-5.3-Flash through the person's gateway). Nothing in Rho named OpenCode.

Rho ran from source on a disposable root and state with
`--agent-backend acp --acp-command '["opencode","acp"]'`. The project was
disposable. OpenCode used its own configuration with no auto-approval. The
person's global OpenCode configuration was checked by checksum before and after,
and was unchanged. Scripts and raw streams are under `work/opencode/`.

## What OpenCode declares over ACP

The handshake, with no prompt, returned `agentInfo` `OpenCode 1.19.5` and these
capabilities:

- `loadSession`, plus session `list`, `resume`, `fork` and `close`.
- MCP over HTTP and SSE, in addition to ACP's baseline stdio.
- Three settings: model (104 choices), effort and mode.
- `session/list` filtered by folder, returning each session's title and update
  time.

Rho's generic ACP driver needs nothing beyond these.

## Using Rho from OpenCode's own window

Rho's setup prompt was given to `opencode run` unchanged. OpenCode loaded its own
configuration skill and ran the grant command without printing the reply. It
wrote the MCP server into a project-scoped `.opencode/opencode.json` (mode 600)
and left the global file alone. It then checked `rho_index` directly and said
that a new session was needed to load the tools. That session called
`rho_index` (the project ID matched) and wrote `notes/plan.md`. Rho listed the
connection as `opencode-glm` with a verified call.

Rho's Conversations listed none of OpenCode's sessions. Rho has no reader for
them.

## Talking to OpenCode in Rho

A conversation started in Rho ran under OpenCode's own session ID. In the same
conversation it:

- read a file;
- called `rho_index` through the MCP server Rho passes at session start;
- edited a file, and Rho recorded the change;
- reported its usage and cost.

The message box offered OpenCode's models and effort.

## One session in both places

- **Rho to terminal.** `opencode run --session` quoted, word for word, the line
  Rho had asked OpenCode to add.
- **Terminal back to Rho.** Rho's connection to OpenCode was still open. Its next
  message got the code word given in the terminal. OpenCode reads history from
  its database each turn, so the open connection was not stale.
- **Terminal session continued over ACP.** `session/list` returned the three
  terminal sessions in this folder in 440 ms. The generic driver continued
  `Rho first task` and answered with its code word. Rho's UI cannot do this yet,
  because it does not list these sessions.
- **Open in OpenCode's interactive window.** While the window held the session
  open, Rho sent into it and was not refused. The window's next prompt then
  quoted Rho's message. OpenCode tolerates alternating writers. Rho's refusal
  while a session is open elsewhere was written for Claude Code and is that
  Agent's behaviour, not a general rule.

## Observation through OpenCode's own plugin

As an experiment, the project got a 20-line plugin in `.opencode/plugins/`. It
appends OpenCode's plugin events to `.rho/agent/inbox/opencode.jsonl`: a local
file, with no network and no Rho code.

It recorded, as they happened:

- session creation, title and busy/idle status;
- each message and its cost;
- each tool call, with its command, output and exit code.

Records came from the interactive window, from `opencode run` and from Rho's own
`opencode acp` process, each with its process ID.

It also carried the model's reasoning text, which Rho must not keep, and
OpenCode's startup noise. With the filter used, the person's prompt text did not
come through. On the first run after the plugin was added, OpenCode stopped
after `init` for over five minutes and was stopped by hand. Three later runs
started normally, and the cause was not found.

## Found and fixed

Rho named OpenCode "ACP Agent" and drew the DeepSeek mark on its conversations.
The application assumed that any ACP Agent was Harness. Rho already recorded the
name the Agent reports in its ACP handshake. Now:

- A configured ACP Agent is named as it named itself, or by its command until it
  has answered. The existing Harness name is kept, because Harness reports
  `deepseek-harness-acp`.
- The Agents tab, conversation rows, the panel title, the message box and the
  settings menu draw each Agent's mark by its name. An Agent without a mark shows
  its initial.

After the change, OpenCode appears as "OpenCode", with an "O", in each of these
places. 54 related tests and the Agent page acceptance in Chrome pass. The
Harness case was not run again after this change.

## Not fixed

- **Listing.** OpenCode sessions started outside Rho are not listed, so they
  cannot be continued from Rho. Listing over `session/list` starts the Agent's
  process for a read. The inbox plugin needs no process, but only covers
  sessions after the plugin was installed.
- **Turns from other windows.** Turns sent to Rho's own OpenCode session from the
  terminal or the interactive window do not appear in Rho's panel.
- **"Open elsewhere" is fixed per Agent.** It is coded for Claude Code and Codex.
  It should come from what each Agent does.
- **One ACP command per service.** A conversation follows whichever ACP command
  the service has now, not the one that started it. (Fixed later the same day:
  [Adding Agents that Rho starts](AGENTS-IN-RHO-EPISODE.md).)
- **Brand code remains in the application.** Continuation routing and the
  Harness checks still branch on Claude Code, Codex and Harness.

## Limits

One model, one machine (macOS) and one person's configuration. The plugin was an
experiment in a disposable project and is not shipped. The interactive window
was driven through a pseudo-terminal, and its screen was not read. No npm release
was made.
