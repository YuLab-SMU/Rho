# Connect an Agent to a Rho project

An Agent works with Rho in one of two ways.

| Way | Who starts it | What you do |
| --- | --- | --- |
| **In Rho's Agent panel** | The person, in the browser | Nothing. Rho starts Claude Code or Codex in the project folder with Rho's tools, and adds instructions about the shared notes and the Notebook. Follow them |
| **Your own Claude Code or Codex** | The person or you, in a terminal | Grant one project to this Agent, add Rho's MCP server, then start a new session in that project |

A grant covers one project. Each project needs its own grant, which adds an MCP server named
`rho-<folder>`.

## Grant one project (every version)

The service must be running. `--project` is the folder's name relative to `--root`. Quote
names that contain spaces.

```sh
rho --grant ~/Rho/state/connection.json --project "PA14 quorum sensing"
```

The reply is one JSON line:

```json
{"projectId":"…","session":"claude-code","connectionFile":"<state>/agent-….json","methods":82,
 "mcp":{"name":"rho-pa14-quorum-sensing","command":"/…/node","args":["/…/rho/dist/cli.js","--mcp","<state>/agent-….json"]},
 "claude":"claude mcp add rho-pa14-quorum-sensing -- /…/node /…/cli.js --mcp <state>/agent-….json"}
```

- **Claude Code:** run the printed `claude` command from inside the project folder. Its default
  scope is local and is keyed to that folder.
- **Codex:** `codex mcp add <mcp.name> -- <mcp.command> <mcp.args…>`. Codex keeps one
  configuration for every folder.

Granting the same project again under the same `--session` name (default `claude-code`) reuses
that session's grant. Use another `--session` name to give a second Agent its own identity.

## Grant and add in one step (versions after 0.5.3)

```sh
rho --grant ~/Rho/state/connection.json --project "PA14 quorum sensing" --agent claude-code   # or: codex
```

This runs the Agent's own `mcp remove` and `mcp add`, and the project page then shows the
connection under that Agent. The reply names what was added (`added.name`, `added.scope`).
This is what the project page's "Add to …" button does.

## Then start a new session

A session that was already open does not get the new tools. Tell the person to start a new
Claude Code or Codex session in the project folder, or start one yourself if you are scripting
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
