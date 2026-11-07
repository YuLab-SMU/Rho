# Adding Agents that Rho starts

Date: 2026-11-07. Source changes after Rho 0.5.6, with Agent 0.4.32. Core unchanged.

## Question

The person compared the two kinds of rows on the Agents tab. Claude Code, Codex and
DeepSeek Harness had a choice button and a model. Hermes Agent and WorkBuddy were
marked "Connected from its own window". The person asked three things:

- Why do the two kinds differ so much?
- Did the [session continuity](SESSION-CONTINUITY-EPISODE.md) work not already make
  outside Agents usable in Rho?
- How does a person make an Agent one that Rho starts?

## What was there

The two kinds come from opposite directions:

- **Agents Rho starts.** Rho is the ACP client. It starts the Agent's process, and
  the person talks to it in Rho's Agent panel.
- **Agents connected from their own window.** The Agent is the MCP client. It runs
  in its own window and calls Rho's tools from there.

Session continuity covered sessions that Claude Code, Codex and Harness started
outside Rho. Rho can continue those because it can start those three Agents over
ACP. It did not turn an Agent connected from its own window into one that Rho
starts.

Rho started:

- Claude Code and Codex, through their adapters;
- one more ACP command, fixed when the service started. This was `--acp-command`,
  or else `dsh acp` when Harness's `acp` profile was installed.

The person's service named OpenCode in that slot. Hermes and Kimi could therefore
only connect from their own windows. The page had no way to add an Agent. A
Harness session in the project folder was also offered to whichever ACP command
the service had, so it would have been sent to OpenCode.

## The Agents installed here

Each installed CLI with an ACP entry was started once through Rho's generic ACP
driver in a disposable folder. Each run opened a session, read what the Agent
offered and removed the session. No message was sent.

- **DeepSeek Harness**, `dsh acp`: `deepseek-harness-acp` 0.0.1, offering model
  (89 values) and effort, in 3.4 s.
- **Hermes Agent**, `hermes acp`: `hermes-agent` 0.21.5, offering no settings, in 5.8 s.
- **Kimi Code**, `kimi acp`: `Kimi Code CLI` 2.5.2, offering model (161 values),
  thinking and mode, in 1.2 s.
- **OpenCode**, `opencode acp`: `OpenCode` 1.19.5, offering model (101 values), effort
  and mode, in 2.1 s.
- **Gemini CLI**, `gemini --acp`: refused after 11.5 s by its account, which said this
  client is no longer supported for Gemini Code Assist for individuals.
- **Qwen Code**, `qwen --acp`: the installed 0.0.1-alpha.10 exited after 0.9 s with
  "Unknown argument: acp".

The commands come from the [ACP registry](https://github.com/agentclientprotocol/registry)
(read on 2026-11-07) or from these runs. Hermes is not in the registry; `hermes acp`
comes from its own help text and the run above.

## What changed

**Agent 0.4.32.** `knownAcpAgents` lists the ACP command of each Agent below:

- Harness, Hermes, Kimi Code, OpenCode, Gemini CLI and Qwen Code;
- goose, Cursor Agent, Auggie, CodeBuddy and Factory Droid.

`installedAcpAgents` finds which of these are installed. It reads `PATH`, plus
Harness's `acp` profile folder, and starts nothing.

When an Agent exits before it answers, the driver now reports the last line it
printed. That line passes through the same redaction as other Agent errors.

**Rho.** The service's Agent settings keep a list of Agents the person added. Each
one is stored as `acp:<name>` with its command:

- `conversation.agents.add` starts the command once in the project, as a check
  does. It keeps the Agent only when the Agent answered.
- `conversation.agents.remove` takes the Agent out of new conversations.

Every conversation with an ACP Agent other than Claude Code or Codex records the
command it started with. It therefore continues with that same Agent, whatever is
added, removed or named at a later start. This resolves the limit the
[OpenCode record](OPENCODE-EPISODE.md#not-fixed) listed as "one ACP command per
service".

A Harness session continues only through Harness's own ACP command, whether named
at start or added. When neither exists, the session continues in Harness.

**Agents tab.**

- An Agent connected from its own window gets **Use in Rho** when Rho knows its
  command and finds it installed.
- **Add an Agent** lists the other installed Agents, each with the command it
  starts as, and takes a typed command for any other ACP Agent.
- An added Agent's settings show the command it starts as, and **Remove from Rho**.
- The message box's Agent menu offers every Agent added.

## The run

Rho ran from source on a disposable root and state. The disposable project `demo`
held `ozone.csv`. `rho connect --as hermes-agent` made the grant that an Agent
connected from its own window would hold. No Hermes window ran.

1. The Agents tab listed Claude Code, Codex and Harness, which Rho starts. Below
   them was the Hermes window, with Use in Rho. Kimi, OpenCode, Gemini, Qwen and
   Cursor were listed under Add an Agent.
2. Use in Rho on Hermes: the row read "Starting Hermes Agent in this project to
   check it…". Hermes then had a choice button and the note "Chooses its own
   model", and its window stayed under the same row.
3. Add on Kimi: Kimi appeared with its default model, GLM-5.3-Flash.
4. Add on Qwen and on Gemini: each was refused in its own row, with the reason
   in its own words, and nothing was added.
5. Hermes was chosen in the message box. A message asking it to name itself was
   answered in 12 s with Hermes's own provider error: its configured model,
   `group/auto-deepseek-v4-1-flash`, is not served by the person's gateway. The
   message reached Hermes and its reply came back. The model is set in Hermes's
   own configuration.
6. Kimi was chosen. It answered "Hello! I'm Kimi Code CLI, …" in 3 s, with
   GLM-5.3-Flash and Thinking High in the message box. A second conversation asked
   which file is in the folder, and Kimi answered `ozone.csv` in 3 s.

Screenshots were read at 1440 and 390 px wide.

## Found and fixed during the run

- **Hermes was listed twice:** once in its window row and once under Add an Agent.
  The Add list now leaves out an Agent that has Use in Rho above.
- **The message box said Rho had not asked Hermes what it offers,** although it
  had: Hermes offers nothing. The message box now says Hermes offers no model or
  setting to choose, and its chip reads "Its own model".
- **Kimi titled its session with the whole start of its first prompt,** including
  the interface context Rho appends to the person's words. The sidebar showed all
  of it. A listed title now stops before Rho's context. A conversation listed
  before the fix keeps its old title until it changes.
- **Qwen's refusal read "ACP connection closed".** It now reads "The Agent exited
  before it answered (exit 1). It printed: Unknown argument: acp".

## Checks

- **Agent settings tests:**
  - Adding refuses a missing program and a command that does not answer ACP. It
    starts the Agent once and repeats nothing.
  - Choosing the added Agent starts a conversation with it.
  - After removal, the conversation still continues with its recorded command.
  - A Harness session continues through an added Harness, never through another
    ACP command.
- **Plugin tests:** finding installed Agents, including the Harness profile rule,
  and the last-printed-line report.
- **Related suites:** conversations, ACP conversations, session continuity,
  external sessions and contracts.
- **Full Rho suite:** 325 tests; 322 passed and 3 Windows-only tests were skipped.
- **Agent page acceptance in Chrome:** passed once its list selector named the
  Agent list. The new "Installed on this computer" list had matched the old
  selector too, and it appears on any machine with such an Agent installed.

## Not done

- **No Hermes window.** Hermes did not run in its own window. The grant that
  `rho connect` made stood in for it.
- **Unrun catalog entries.** goose, Auggie, CodeBuddy and Factory Droid come from
  the registry and were not run here. Cursor Agent was found installed but not
  added.
- **Agents' own settings.** Hermes's provider error and Gemini's account refusal
  belong to those Agents' own settings.
- **Outside sessions.** Sessions that Hermes, Kimi or OpenCode started outside Rho
  are not listed, so they cannot be continued from Rho.
- **Open elsewhere.** The refusal while a session is open in another window still
  covers only Claude Code and Codex.
- **The person's own Rho.** Their running Rho was not restarted, so it does not
  have this change yet.
- **Windows.** The test of Harness continuing through an added Harness uses a POSIX
  launcher. No Agent was added on Windows. An npm-installed Agent there is a
  `.cmd` launcher, which Node does not start without a shell; this was already
  true of `--acp-command`, and was not tried.
