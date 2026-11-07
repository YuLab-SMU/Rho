# Connect an Agent to a Rho project

An Agent works with Rho in one of two ways.

| Way | Who starts it | What you do |
| --- | --- | --- |
| **In Rho's Agent panel** | The person, in the browser | Nothing. Rho starts Claude Code or Codex in the project folder with Rho's tools, and adds instructions about the shared notes and the Notebook. Follow them |
| **Your own MCP client** | The person or you, in your own client | Grant one project to this Agent, add Rho's MCP server, then start a new session in that project |

A grant covers one project. Each project needs its own grant, which adds an MCP server named
`rho-<folder>`.

## Connect with one command

In versions after 0.5.6, the project's setup prompt (**Agent → Agents**) gives one command:

```sh
rho connect "/Users/me/Rho/projects/PA14 quorum sensing" --as my-agent
```

- **Project folder.** Give the project's folder, or run the command in it. Rho uses the project
  that holds that folder.
- **`--as`.** A short, stable name for yourself, from A–Z, a–z, 0–9, dot, underscore, colon,
  @ or hyphen. Use the same name when you retry; use another name for a second Agent.
- **`--state-dir`.** The prompt adds it when Rho runs with a state folder other than
  `~/Rho/state`.
- **Launcher.** When `rho` on the person's PATH is not the Rho that is running, the prompt
  starts the command with that Rho's Node and `cli.js` instead.

The reply tells you the rest:

- the MCP server to add: its name, command and arguments;
- ready entries for Claude Code, Codex, OpenCode and DeepSeek Harness;
- how to check the connection with `rho_index`.

`--json` prints the reply as JSON, in the same form as `--grant` below. If the folder is not a
project, the name is missing or Rho is not running, the command says so and exits non-zero.

## Grant one project (every version)

The service must be running. `--project` is the folder's name relative to `--root`. Quote
names that contain spaces. Older setup prompts give `--grant` with `--project-id` instead, which
selects an existing project, including folders chosen outside Rho's projects folder.

```sh
rho --grant ~/Rho/state/connection.json --project "PA14 quorum sensing" --session my-agent
```

The reply is one JSON line:

```json
{"projectId":"…","session":"my-agent","connectionFile":"<state>/agent-….json","methods":82,
 "mcp":{"name":"rho-pa14-quorum-sensing","command":"/…/node","args":["/…/rho/dist/cli.js","--mcp","<state>/agent-….json"]},
 "claude":"claude mcp add rho-pa14-quorum-sensing -- /…/node /…/cli.js --mcp <state>/agent-….json",
 "codex":"codex mcp add rho-pa14-quorum-sensing -- …",
 "opencode":{"file":"<project>/.opencode/opencode.json","merge":{"mcp":{"rho-pa14-quorum-sensing":{"type":"local","command":[…],"enabled":true}}}},
 "dsh":{"file":"~/.dsh/profiles/desktop/cordis.patch.yml","append":"- insert:\n    - id: \"mcp-rho-…\"\n      name: \"@deepseek-ai/dsh-mcp-client\"\n…"}}
```

Rho 0.5.6 and earlier return only `mcp` and `claude`. The same entries follow `rho connect`.
Whichever command you used, configure your client like this:

- **Any MCP client:** register the returned `mcp.name`, `mcp.command` and `mcp.args`
  with your own supported configuration mechanism. Keep connection-file contents private.
- **Claude Code:** run the printed `claude` command from inside the project folder. Its default
  scope is local and is keyed to that folder.
- **Codex:** run the printed `codex` command (`codex mcp add <mcp.name> -- <mcp.command>
  <mcp.args…>`). Codex keeps one configuration for every folder.
- **OpenCode:** merge `opencode.merge` into the project's `.opencode/opencode.json` (mode
  600; add it to `.gitignore` in a Git repository). OpenCode reads it when a session starts,
  so verify in a new session (`opencode run` in the project folder). Checked with OpenCode
  1.19.5 on 2026-11-07.
- **DeepSeek Harness:** there is no `dsh mcp` command. Append `dsh.append` to the profile patch
  named in `dsh.file` (the Desktop app's profile is `desktop`; back the file up first and keep
  every other entry). Harness reloads the patch within seconds, so `rho_index` works in the
  same session. `dsh --profile desktop --dump-config` is refused while the Desktop app manages
  that profile; check for the `--mcp` process instead. Checked on 2026-11-07, where finding
  this mechanism took the Agent most of nine minutes.

Use the same `--session` (or `--as`) name when retrying (the legacy default is `claude-code`).
Current source keeps a valid grant with unchanged scope; older versions may replace its
credential, so a running client may need to reconnect. Use another `--session` name to
give a second Agent its own identity.

## Grant and add in one step (versions after 0.5.3)

```sh
rho --grant ~/Rho/state/connection.json --project "PA14 quorum sensing" --agent claude-code   # or: codex
```

This runs the Agent's own `mcp remove` and `mcp add`, and the project page then shows the
connection under that Agent. The reply names what was added (`added.name`, `added.scope`).
This remains a CLI shortcut; the project page now supplies a client-independent prompt.

## Then start a new session

A session that was already open does not get the new tools. Tell the person to reload the client’s MCP tools if supported, or start a new
session in the project folder, or start one yourself if you are scripting
it. Do not report "connected" until `rho_index` answers in that new session. `claude mcp list`
or `codex mcp list` shows whether the entry exists, not whether it works.

## After a restart

On 0.5.3 and earlier, each start without `--port N` takes a new port, and a configured entry
then fails to connect. Grant again, add the MCP entry again if the printed `connectionFile`
differs from the configured one, and start a new session. To avoid this, start with a fixed
`--port`.

In versions after 0.5.3, a start keeps the port of the last start when it can. When the port
does change, Rho rewrites the Agent connection files in that state, so existing entries keep
working.

The MCP entry stores absolute paths to `node` and to Rho's `cli.js`. After a Node upgrade or a
reinstall to another place, grant and add the entry again.

## Watching an outside ACP client (optional)

An editor that speaks ACP can use `rho --acp /absolute/project --acp-agent claude|codex` as its
agent command. Rho then records that client's activity in the project. Most people do not need
this.
