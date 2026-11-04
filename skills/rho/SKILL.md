---
name: rho
description: Install, start, connect to and work in Rho, the local workspace (npm package @rho-workspace/rho) where a person and an Agent share R/Python projects, a live Notebook, files, figures and notes in one browser window. Use when the user asks to install, start, open, restart, upgrade or stop Rho; to connect Claude Code or Codex to a Rho project; to run, reproduce or review an analysis in Rho so they can watch and follow it; when tools named rho_index, rho_resolve, rho_call or rho_read are available; or when Rho reports an error. 触发：安装/启动/打开/停止/升级 Rho，把 Agent 接到 Rho 项目，在 Rho 里做分析、复现文献、让人看着分析过程，Rho 报错。
---

# Rho

Rho is a local service with a browser interface. It runs on this machine, in folders the
person chooses, and drives the Agent client they already have (Claude Code or Codex). There
is no Rho server and no account. A project is an ordinary folder; Rho adds a place where the
person watches and steers the work: live R and Python sessions with every cell, plot and
variable, files with kept versions, shared notes, and a layout of views.

You keep your own tools and permissions. Rho adds four MCP tools (`rho_index`, `rho_resolve`,
`rho_call`, `rho_read`) scoped to one project. It grants nothing beyond that project and adds
no approval of its own.

## First find out where things stand

Do this before running any install or start command.

| Question | How to check | Next |
| --- | --- | --- |
| Is Node in range? | `node -v`: Rho needs `>=22.22.0 <27` | Out of range: say how to get Node 22, 24 or 26, and stop |
| Is Rho installed, which version? | `npm ls -g @rho-workspace/rho`, or `npm ls --prefix <folder> @rho-workspace/rho` for an install into a folder. There is no `rho --version` (it exits 2); `rho --help` lists what this install accepts | Not installed: [install](references/install.md) |
| Is a service already running? | `pgrep -fl "[-]-state-dir"` lists running services with their state folders. For one state folder, `node -p "require('<state>/connection.json').url"` reads only its address (the file also holds a token). Then `curl -s -o /dev/null -w '%{http_code}' <url>` answers `200` when it runs and `000` when nothing listens. The usual state folders are `~/Rho/state` (the setup page, and a start without flags) and `~/.rho-service` (earlier prompts on Rho's site) | Running: use that address. Not running: [start](references/install.md#start) |
| Are you connected to a project? | You can call `rho_index` (it may be listed as `mcp__rho-<folder>__rho_index`) | Not connected: [connect](references/connect.md) |
| Were you started from Rho's Agent panel? | Your instructions say "This session was started in Rho as session …" | Yes: you are connected; follow those instructions |

The installed version decides several commands. This skill marks what appeared after the
published 0.5.3. When it and `rho --help` disagree, `rho --help` wins.

## Routes

1. Install, start, stop or upgrade: [references/install.md](references/install.md)
2. Connect an Agent to a project: [references/connect.md](references/connect.md)
3. Call Rho's tools without guessing: [references/tools.md](references/tools.md)
4. Run an analysis the person can follow: [references/analysis.md](references/analysis.md)
5. Choose what Rho offers for a need: [references/needs.md](references/needs.md)
6. Something failed: [references/troubleshooting.md](references/troubleshooting.md)

Read only the reference the task needs.

## Rules that hold in every version

- **Ask before ending anything someone else is using.** Restarting or upgrading Rho ends every
  live R and Python session, and the values held in memory are gone (the cells and outputs
  stay). Do not restart a person's Rho, stop a session or delete a state folder without their
  word. Stop only a service you started yourself.
- **Connection files are credentials.** `connection.json`, the `agent-*.json` files a grant
  makes, and `--pair` links: name their paths, never print their contents, paste them into
  chat or commit them.
- **One service per state folder, and the state folder outside the projects folder.** A
  second start on the same state is refused. After 0.5.3 the refusal names the running address;
  on 0.5.3 and earlier, read `url` from `<state>/connection.json`. Use that address.
- **Spend calls on the work, not on rediscovery.** Index and resolve an operation once per
  session and reuse its `contractRef`. Read a large reply by the paths `rho_read` gives you.
  Never assemble a path from memory ([tools](references/tools.md)).
- **Identity makes retries safe.** A write carries a `changeId`. The same `changeId` returns
  the original result and never runs twice, so use it to recover a lost reply. New work gets a
  new `changeId`.
- **Nothing wakes you later.** No monitor, timer or event resumes your turn. A cell still
  running when you stop is running for nobody, and ending your reply does not finish the work.
- **A refusal names its rule.** Report it in those words. Do not route around it with another
  tool or a wider grant.
- **Report the state reached, not the state intended.** Say which files exist on disk, which
  cell is still running, which numbers you checked, and what you could not do.

## More

- Setting Rho up from nothing: <https://yulab-smu.top/Rho/doc/setup.md>
- This skill's published copy, to update it: <https://yulab-smu.top/Rho/skills/rho/SKILL.md>,
  with its references beside it
- Guide and reference: <https://yulab-smu.top/Rho/docs/>
- Live demo of the interface: <https://yulab-smu.top/Rho/>
- Source: <https://github.com/YuLab-SMU/Rho>
