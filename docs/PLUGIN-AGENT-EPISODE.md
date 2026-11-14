# Real-time task panel Agent episode

Observed on 2026-11-13 in the Rho checkout on macOS with Node 22.22.3. The
experiment used a temporary HOME, temporary project, temporary Rho service and
Claude Code through the local Magpie gateway. It did not read or restart the
user's Rho service.

## Prompt

The Agent was given exactly this sentence:

> 请在当前 Rho 项目里创建一个实时任务面板插件，让我能随时打开它查看任务、Agent 工作状态和最近的进展，并把它接入工作区；请自行完成开发、验证和接入。

## Setup and attempts

The temporary Rho service started successfully on a loopback port and created a
project with the generated `.rho/README.md`. The first driver attempt stopped
before the model turn because it passed the removed `dontAsk` permission mode.
The driver was corrected for Claude Code 2.1.323 and restricted to the temporary
project, plugin commands and file tools.

The first Claude route returned:

```text
403 fusecode-lab: 组织余额不足，请联系管理员充值
```

The local Magpie configuration then showed the actual model-picker route
`auto/deepseek-v4.1-flash[1m]` and the local listeners `127.0.0.1:3425` and
`127.0.0.1:3430`. The `magpie-server/deepseek-v4.1-flash` spelling was rejected
as an unrecognized model. No provider or remote service configuration was
changed.

With the exact local route, DeepSeek first interpreted “plugin” as a Claude Code
plugin. It spent 40 turns reading Claude plugin types, created an incomplete
`.claude-plugin` package and a marketplace file, and never produced a Rho
package. This exposed two Rho gaps. The project note did not distinguish the two
plugin systems, and the experiment driver had removed Bash entirely through
restricted mode.

Rho's generated `.rho/README.md` now names `rho plugin create`, `rho plugin
check` and `rho plugin dev`, and explicitly distinguishes `rho-plugin.json` from
Claude Code's `.claude-plugin` format. The next run allowed only the exact Rho
plugin commands. DeepSeek then created `task-panel`, edited its host, view and
Skill, and ran the Rho checker.

## Observed successful loop

The generated package contains a read-only `read-status` operation that delegates
to `task.map.read`, `agent.sessions.list` and `agent.sessions.read`. Its view
renders loading, empty, error and refreshed states. The generated package passed
the Rho checker with `runtime.host: passed` and its operation state `passed`.

The disposable service installed the package at digest
`7be90b0022ad04519011508a4e2571880808e95fb874c62148ef2af1629fad25`. Through the
local browser principal, Plugins showed the package, its view, Skill and operation.
Opening the view showed the empty-state task and Agent sections. Chrome checks at
1440 px and 390 px captured the page and found no horizontal overflow. A direct
`extension.call` returned `completed` with task map, agents, counts, progress and
errors fields.

The retained screenshots are [Plugins at 1440 px](plugin-agent-acceptance/2026-11-13/plugins-1440.png),
[Plugins at 390 px](plugin-agent-acceptance/2026-11-13/plugins-390.png),
[the panel at 1440 px](plugin-agent-acceptance/2026-11-13/task-panel-1440.png) and
[the panel at 390 px](plugin-agent-acceptance/2026-11-13/task-panel-390.png).

The dev watcher also passed its update episode. An invalid host edit retained the
old digest. A valid edit selected digest
`3142c474ee82ccb2938092fa6e4e4942a921f5385539fd16be22947e85d33ece`, and restoring
the source returned the original digest.

`rho plugin check` now imports the host in a child process and runs every declared
operation with bounded sample input. The result reports the host and operation
states as JSON. `rho plugin dev` performs the same check before installing a new
snapshot and keeps the previous selection after a failed check. The Plugins page
now has an explicit **Refresh plugins** action for loading a new package digest.

The runtime check proves host import and operation control flow. It does not prove
the actual project data, authorization or browser layout. Those require the next
real Agent run and a Chrome episode against the installed view.

## Remaining gap

The runtime HTML plugin appears on Plugins and works through its iframe bridge.
It is not yet a Studio composition entry. The episode therefore proves the
independent package path, data call, browser rendering and update retention. It
does not prove that an Agent can place this runtime view inside Studio. That is
the next owner-level capability to design from a real request.
