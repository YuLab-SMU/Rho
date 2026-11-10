---
name: rho
description: Open and work in Rho, the local workspace in the person's web browser (npm package @rho-workspace/rho) where they and WorkBuddy share an R/Python project with a live Notebook, files, figures, tables and notes. Use when the person asks to start or open Rho or to open a folder or project in Rho; to run, reproduce or review an R or Python analysis in Rho so they can watch and steer it; to draw a figure in Rho whose points they can select; or when Rho reports an error. 触发：启动/打开 Rho，用 Rho 打开文件夹或项目，在 Rho 里做数据分析、画图、复现分析，让我看着分析过程，在图上选点，Rho 报错。
---

# Rho in WorkBuddy

Rho is a local service with a page in the person's web browser. A project is an ordinary folder
on this machine; Rho adds a page where the person watches and steers the work: live R and Python
sessions with every cell, plot and variable, files with kept versions, tables, figures whose
points they can select, shared notes, and an Agent panel. There is no Rho account and no Rho
server. This connector installed the `rho` command (`rho.cmd` on Windows) with WorkBuddy's Node.

## Open a folder in Rho

```sh
rho open "<folder>"           # the folder the person means; the current folder without it
```

It starts Rho in the background when it is not running, makes the folder a Rho project where it
is (nothing is copied or moved), opens the folder's page in the person's browser, and prints the
address and what to tell the person. Do not check Node, look for state folders or read Rho's
files first. `rho open "<folder>" --no-browser` prints the address without opening a tab.

Then tell the person, in their words: **Rho is a page in their web browser**, not this chat; the
address; what they find there (the folder's files, figures and tables, a live R and Python
Notebook, notes, and an Agent panel); and that Rho keeps running until `rho --stop`.

## Work in the project: Rho's tools from your shell

In WorkBuddy, call Rho's four tools with `rho tool`. They are the same tools as Rho's MCP server
(`rho_index`, `rho_resolve`, `rho_call`, `rho_read`), under one grant for the project, and they
work in this conversation:

```sh
rho tool index --as workbuddy --project "<folder>"          # what may be done, and a catalogRef
rho tool resolve '{"catalogRef":"…","selected":["kernel.run"]}' --as workbuddy --project "<folder>"
rho tool call - --as workbuddy --project "<folder>" < input.json
rho tool list --as workbuddy                                 # each tool's input schema
```

The input is the tool's JSON input; `-` reads it from standard input, which avoids shell quoting
(on Windows always use `-`). The reply is the tool's JSON reply; the exit code is 1 when it is an
error. `--project` can be left out when the shell is in the folder. Keep `--as workbuddy` the same
in every call so the work stays under one grant. [tools](references/tools.md) shows the round
with real replies.

- **Do not add Rho to WorkBuddy's `mcp.json`.** WorkBuddy starts a server added there only after
  the person approves it in its connectors, and its tools appear only in a new conversation;
  `rho tool` needs neither. Do not read Rho's source or its state files, and do not call its HTTP
  API yourself.
- **Run R and Python as cells in the project's Notebook** (`kernel.run`), not with a separate
  `Rscript` or `python`, so the person sees each step, value and figure on the page and can
  select points in a figure ([analysis](references/analysis.md)).
- **Say where to look** when you report: the project's page in their browser, with its address
  (`rho open "<folder>" --no-browser` prints it). "The notebook" alone can read as some other
  notebook.

## When something fails

| What happened | What to do |
| --- | --- |
| `rho` is not found, or `rho open` / `rho tool` is unknown | The connector's install did not finish or found an older Rho. Ask the person to connect Rho again under WorkBuddy's connectors, which installs it again; or run `npm install -g @rho-workspace/rho@latest` |
| R cells fail: no R | Rho runs R through `Rscript`. Tell the person R is needed for R cells; Python cells still run. If R is installed outside PATH, `rho --stop` and `rho open "<folder>" --rscript "<path to Rscript>"` |
| A Rho command refuses | Its message names the rule. Report it in those words; do not route around it |
| Anything else | [troubleshooting](references/troubleshooting.md); start, stop and upgrade in [install](references/install.md) |

What Rho offers for a need (tables, figures, notes, packages): [needs](references/needs.md).

## Rules

- **Ask before ending anything someone else is using.** Stopping or restarting Rho ends every
  live R and Python session; values held in memory are gone (cells and outputs stay). Do not
  stop the person's Rho or delete its folders without their word.
- **Connection files are credentials.** `connection.json` and `agent-*.json` in Rho's state
  folder: never print their contents, paste them into chat or copy them into the project.
- **Spend calls on the work, not on rediscovery.** Index and resolve an operation once and reuse
  its `contractRef`. Read a large reply by the paths `rho_read` gives you; never assemble a path
  from memory.
- **Identity makes retries safe.** A write carries a `changeId`; the same `changeId` returns the
  original result and never runs twice. New work gets a new `changeId`.
- **Report the state reached, not the state intended.** Say which files exist, which cell is
  still running, which numbers you checked, and what you could not do.

Guide and reference: <https://yulab-smu.top/Rho/docs/>. Source: <https://github.com/YuLab-SMU/Rho>.
