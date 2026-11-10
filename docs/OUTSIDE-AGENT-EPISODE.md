# An outside Agent opens a folder with Rho and works in it

Updated 2026-11-10. The user asked an Agent in WorkBuddy (5.9.3) to "使用rho 启动该项目" in their
own airway project, `~/Projects/气道平滑肌-地塞米松`, then to make a new workspace with an illustrated
analysis, then "Draw the volcano plot in the notebook; I will select the genes I care about." The
user found it slow, and asked for more guidance for people (that Rho is a page in the browser)
and for Agents (to start Rho quickly), with the user's scenario simulated to find what hurts.
This episode reads that session, runs the same requests with parallel trials, changes Rho, and
runs them again.

## The WorkBuddy session

From WorkBuddy's own session file for that conversation. The Rho Skill in
`~/.workbuddy/skills/rho` was imported seven minutes after the conversation began, so the
conversation did not list it ([WorkBuddy connector](WORKBUDDY-CONNECTOR-EPISODE.md)).

| Request | Wall time | What the time went to |
| --- | --- | --- |
| Start the project | 203 s | 16 shell and file calls before starting: `rho --help`, `rho connect --help`, `ls -laR .rho`, the project's `.workbuddy` memory, old state folders, and a grep of the installed `cli.js`. It found an earlier state, `~/.rho-state`, with `~/Projects` as root, and started Rho in the foreground as a WorkBuddy background task with that root, so every folder in `~/Projects` became a candidate project. It opened the page with `rho --pair --root`, a five-minute one-time link |
| New workspace, illustrated analysis | about 21 min | A sub-agent read Rho's source for 5 min 19 s to learn what a workspace is. The Agent then called Rho's HTTP API with the state's operator credential from scripts in `/tmp`, guessed a resource kind and retried. It concluded that "Rho 的文档视图是源码编辑器，没有渲染预览" and made a separate HTML report: it had placed the report in `rho.editor`, the source editor it found in the code, while Rho has a Markdown reader (`markdown.reader`) |
| Volcano plot to select genes | about 19 min | A sub-agent read Rho's source for 12 min 29 s to find how a figure becomes selectable. The cells then ran through the HTTP API as the operator, not as an Agent session |

The Agent called no Rho tool in that session. WorkBuddy's MCP configuration held three Rho
servers its own Agent had added, `rho-project` for this project among them, but WorkBuddy runs such
a server only after the person approves it, and none was approved
([WorkBuddy connector](WORKBUDDY-CONNECTOR-EPISODE.md)). Nothing told the Agent another way in than
the operator's HTTP API.

## Trials

`scripts/outside-agent-trials.mjs` gives a fresh Claude Code (`claude -p`, model
`westlakehpc/glm-5.3-flash`, Claude Code 2.1.319 to 2.1.321) a copy of the airway project in a
throwaway home, `rho` on PATH from this checkout's build, and its shell and file tools with
nothing to approve; `open` is replaced by a recorder. Variant `bare` has only `rho`; `skill` also
has the Rho Skill this checkout ships in `~/.claude/skills/rho`. Runs go in parallel. The volcano
case first runs `rho open --no-browser`, as if the person had asked earlier, so it starts with
Rho running and the project open, and without Rho's tools in the session, as in WorkBuddy.

**Baseline** (main after the setup-report batch: `--background` and `--status`, no `rho open`).
The runs sat inside this checkout, whose instructions and source one Agent read, and the first
Node on PATH was 22.17.0, which sent two `skill` runs looking for another Node; later runs fixed
both. Still, the open question showed:

| Run | Seconds | Result |
| --- | --- | --- |
| bare-3, skill-2 | 33, 43 | Rho started with `--background` on the folder's parent; the folder not opened as a project |
| bare-1 | 241 | Three minutes of `rho connect`, `--pair` and `--grant` until a grant registered the folder |
| bare-2 | 261 | Copied the project to a shorter path after a managed run hit the 103-byte socket limit |
| skill-1, skill-3 | 179, 185 | Stopped on the Node check (one asked the person to install Node), Rho not started |

Three of six opened a browser (the Skill's start example had no `--open`); two of six made the
folder a project.

## What was changed

- **`rho open [FOLDER]`.** Uses the running Rho that has the folder, else the one for
  `--state-dir` (`~/Rho/state`), starting it in the background with `~/Rho/projects` as its
  projects folder when nothing runs there. It opens the folder as a project where it is, opens
  `<url>/#project=<id>` in the default browser and prints what to tell the person: that Rho is a
  workspace in their web browser, what is on the page, that no account or code is needed, and how
  to stop it, then how an Agent works there. A folder outside the projects folder is opened by
  `project.open` with its full path, which only the state's operator credential may name; it
  becomes a project of the person's own tab, as a folder chosen in the system dialog, and stays
  theirs after a restart. Earlier Rho versions refuse the full path, and `rho open` says what to
  do then.
- **`rho tool index|resolve|call|read|list --as NAME`.** Rho's four Agent tools from a shell. It
  grants the project to session NAME as `rho connect` does, starts `rho --mcp` on that grant for
  one call and prints the tool's reply, so the work is the Agent's session's, as over MCP.
- **`rho --help`** opens with what Rho is and `rho open`, `--status` and `--stop`, then the
  Agent commands; plugin development moved under "Less common". Every Agent observed, WorkBuddy's
  included, read the help first.
- **`.rho/README.md`.** Rho writes it when it holds a project. It says the files there are
  internal and names `rho open`, `rho tool` and `rho connect`.
- **The Skill** starts with `rho open` when the person asks to start or open Rho, without the
  install checks, then what to tell the person, then `rho tool` when the tools are not loaded,
  Notebook cells rather than separate scripts, and the page's address in each report. The setup
  page's closing report leads with the browser page and names `rho open`. A `--background`
  start prints a line saying Rho is a workspace in the browser.

## After the change

**Open the folder** ("使用rho 启动该项目"), 3 `bare` and 3 `skill` runs:

| | Seconds | Calls | Folder a project | Browser opened | Person told it is a browser page |
| --- | --- | --- | --- | --- | --- |
| bare | 33, 16, 25 | 10, 2, 5 | 3 of 3 | 3 of 3 | 3 of 3 |
| skill | 16, 17, 18 | 3 each: the Skill, `rho --version`, `rho open` | 3 of 3 | 3 of 3 | 3 of 3 |

By hand on this Mac, `rho open` with nothing running returned in 0.87 s, and the address showed
the project, with its earlier work, in Chrome. After `rho --stop` and a plain start, the person's
tab still listed the folder.

**Draw the volcano plot** with Rho open and no Rho tools loaded. Every run drew it as a cell in
the Notebook through `rho tool`; each figure record has a point layer of 17,157 to 17,165 marks,
one per gene with an adjusted p-value, bound mark by mark:

| Round | Seconds | First Rho command at | Reads of Rho's state files |
| --- | --- | --- | --- |
| `rho tool` and help, before `.rho/README.md` | 121, 238, 229, 408 | 40–183 s | 1–36 |
| with `.rho/README.md` | 203, 192, 124, 258 | 18–78 s | 0–1 |
| with the report line in the note and the Skill | 264, 88, 99, 177 | 13–47 s | 0–4 |

Every run in the first round began by listing `.rho/` and reading its state files, as WorkBuddy
did (`ls -laR .rho`); one read them for two minutes, and one walked its own figure record through
`rho tool read` for two more. In the second round each read the note and went to `rho tool`.
None of its four answers gave the page's address: they said to select points "in the Notebook",
which a person who does not know Rho is a browser page cannot place. No `skill` run of this case
loaded the Skill, as the request does not name Rho: the note in `.rho/` is the guidance an
Agent meets there. With a line asking for the page's address in each report, two of the third
round's four answers gave it (`http://127.0.0.1:…/#project=…`), one pointed to "本页右侧的
Notebook 面板" without it, and one did not say where.

## CI

[CI 42736131288](https://github.com/YuLab-SMU/Rho/actions/runs/42736131288) on `553b7f78`: the
first attempt failed only in Test win32-x64, where `agent-observation.test.mjs` ("browser observes
only its project…") got `host_unavailable` with `os error 2` on the project Host's named pipe. The
rerun passed every job, and the installed check ran `rho open` on a folder outside the projects
folder and `rho tool index` through `rho`/`rho.cmd` on the four platforms, in about 1.8 to 2.7 s.
The failure is Core's: on Windows `IpcListener::bind` creates no pipe, the accept thread that
`serve` starts after printing its ready line makes the first instance, and each next one only on
its next loop, so a client right after ready, or between two connections, can find none (read in
Rho-core `8bed8ef`). It is open work for Rho-core.

## Not done

- WorkBuddy's desktop app and model (Hy4) were not run again. The trials here use Claude Code;
  the [WorkBuddy connector](WORKBUDDY-CONNECTOR-EPISODE.md) episode runs WorkBuddy's own agent
  core with another model.
- The workspace request (workspace, rendered report, figures in views) was not repeated.
  Whether `rho tool` leads an Agent to `markdown.reader` is unobserved.
- `rho open` and `rho tool` were run on macOS only; Windows (`rho.cmd`) runs in CI.
- No person has used the opened page from these trials; the trials count what the Agent said.
- Half the volcano answers still do not give the page's address. The note and the Skill only ask
  for it; nothing in a Notebook cell's reply names the page.
