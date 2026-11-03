# Python environments in the Notebook

Updated 2026-11-03. The user's plan: an environment is work the Agent does. It finds one, installs
into it, chooses it and uses it, and Rho shows those steps. A configured environment is then used
like any other program, with no environment plugin. Three small changes were planned. `kernel.run`
takes an interpreter path inside the project. Each cell records the program and version that ran
it. The activity record reads an install command as what it installed, "Installed pandas 2.2
(uv)". The Requirements plugin (R only, declare then install) stays for checking managed runs. It
is not the Agent's way to an environment. As AGENTS.md asks, a real task came first, to see where
an Agent gets stuck.

## The task

[`scripts/python-env-episode.mjs`](../scripts/python-env-episode.mjs) builds a project named
"plant growth": `data/growth.csv` (40 plants: light, water, growth) and a README. The machine's
Python is a standalone CPython 3.13.5 installed by uv. It is marked externally managed, so pip
refuses it, and it has no pandas or statsmodels. The service and the Agent get that Python's bin
folder, uv and the system folders on PATH, and a HOME of their own with no shell profile. Whatever
gets installed lands in that folder or in the project. An earlier manual check installed
statsmodels into another Python on this machine by mistake, through `uv python find`. It was
uninstalled, and the harness now names its Python.

The Agent is the person's Claude Code (Opus 5.5 through their provider) in `dontAsk` mode.
It is allowed Rho's four MCP tools, Read, Glob, Grep, and shell commands starting with `uv`,
`python3`, `python`, `pip`, `pip3`, `.venv/bin/python`, `.venv/bin/pip`, `ls`, `cat`, `head`,
`wc`, `echo`, `pwd`, `cd`, `mkdir`, `which` or `source`. Anything else is refused and recorded,
and nothing asks for permission. The person writes:

> In this Rho project, data/growth.csv has plant growth measurements. Fit an ordinary least
> squares model of growth on light and water with statsmodels in Rho's live Python session, so I
> can see it there, and tell me the coefficients.

When the Agent stops to ask, the person replies "Set up what the project needs for this inside
the project, without changing any Python outside it, and fit the model in Rho's live session."
Without `--from-rho`, Claude Code runs outside Rho with Rho's tools granted (`session.grant`).
With it, the same message is written in Rho's Agent panel in a real browser, and Rho starts Claude
Code with a settings file that allows the same commands.

## Runs

**Run 1** (Notebook 0.5.2). The Agent ran the fit, which failed because pandas was missing. It
printed `sys.executable` in a cell, tried the shell (refused) and read the README. This version of
the harness sent no reply, so the run ended after one turn.

**Run 2** (Notebook 0.5.2). In turn 2 the Agent made `.venv` from a cell with
`venv.EnvBuilder`. The first one could not find its standard library, because the harness's
`python3` was a link to the standalone Python; the harness was fixed. The Agent then added
`.venv`'s site-packages to the running session with `site.addsitedir` and fitted the model. The
fit ran in the machine's Python with another environment's packages on its path.

**Run 3** (`interpreter` added). In turn 2 a shell command naming the Python's absolute path was
refused. The Agent made `.venv` and installed pandas and statsmodels from a cell
(`subprocess`), then ran the fit with `interpreter: ".venv/bin/python"`. Rho refused it: the
session runs another program, stop it first. Agents cannot stop a session (only the person does),
so it asked the person to.

**Run 4** (an Agent's own session starts again). In turn 1 the fit failed. The Agent's compound
shell command was refused, so it asked, and said it would not install from inside the session to
get around the refusal. In turn 2 it ran `python3 -m venv .venv` and
`.venv/bin/pip install -q pandas statsmodels` in the shell, then the fit with `interpreter`. The
model was fitted in a new session run by `.venv/bin/python`: intercept 1.3905, light 0.7846,
water 0.0215, R² 0.958.

**Run 5** (as run 4, the message written in Rho's Agent panel). One turn of 2 minutes, with no
reply needed. After the failed fit, one shell command used uv when present and venv with pip
otherwise: `uv venv .venv`, then `uv pip install --python .venv/bin/python pandas statsmodels`.
Then came the fit with `interpreter`, HC3 standard errors in a second cell, a script that writes
`results/`, and a note in `project-notes.md`. The panel showed the install as "Installed pandas
3.1.0, statsmodels 0.15.0 and 11 more (uv)".

Run 2 shows the stuck point. Rho could only start a session with the machine's Python, so an
Agent with a working environment grafted it onto that session. Run 3 shows the next one. An Agent
that names a program for a session only it has used could not replace that session.

In runs 4 and 5 Rho's record holds two sessions. The first ran with the machine's Python (kept as its
absolute path), ended "stopped by An Agent", and holds the one failed cell. The second ran
`.venv/bin/python` (kept relative to the project) and holds the fit. The project keeps
`python: .venv/bin/python` for its next Python sessions.

## What changed

**Notebook 0.5.3** (Rho-plugins):

- `kernel.run` takes `interpreter`, a program in a folder of the project such as
  `.venv/bin/python`. Its real path must be inside the project's real path (`scope`) and it must
  be an executable file (`not_found`). A session on a server runs that server's program
  (`invalid`).
- The project keeps the named program for that language. Later sessions start with it, the
  person's included. If the program is gone, the next session uses the machine's again.
- If the live session runs another program, it starts again only when it is idle and every cell
  in it was the caller's. The old session ends as stopped by the caller. Otherwise the call is a
  `conflict` that names the running program and asks the person to stop the session.
- The runners report the program they run. Each session and cell records `program` (relative to
  the project when inside it) and `version`.
- The Notebook's marks and the Overview name the environment: "Python 3.13.5 · .venv". At one
  instant, an ended session's mark now comes before the next session's start. Run 4's first
  screenshot showed them the other way round, which read as if the `.venv` session had ended.
- The skill Agents read: the project's Python is the machine's `python3` until another is named.
  For packages it lacks, make an environment in the project and pass `interpreter`. A session in
  which the person ran a cell needs the person to stop it first. Do not add another environment's
  packages to a running session's path.

**Rho:** [`src/installs.ts`](../src/installs.ts) reads install commands, in subshells and
after `then`, `do` or `{` too:

- `uv pip install`, `uv add`, `pip`/`pip3 install` and `python -m pip install`;
- `conda`/`mamba`/`micromamba install`;
- R's `install.packages`, `BiocManager`, `pak`, `remotes` and `renv` installs.

It takes the installed versions from what pip and uv printed. The Agent panel shows such a step
as "Installed pandas 3.1.0, statsmodels 0.15.0 and 11 more (uv)", "Installing …" or "Tried to
install …", over two lines at most, and keeps the command in the step's details. The folded work
names installs by their packages, "Installed pandas, statsmodels", and counts only the other
commands. The files a command names are still captured however its row reads. Commands that
install nothing stay commands. `kernel.run`'s description names `interpreter`.

## Checks

- Notebook: a new test covers the refusals, an Agent's own session starting again with another
  program, the person's cell turning that into a conflict, the program kept for the person's next
  session, and the fallback when `.venv` is removed. R's session records `Rscript`. 29 of 29
  Notebook tests pass.
- Rho: three tests of the install reader, the Agent panel's wording and the folded summary,
  including run 5's own command. The full suite on the composed build:
  287 of 289 passed, 2 skipped.
- The Plugins suite with every plugin built: 169 of 170 passed, 1 skipped.
- Run 4's project in a browser at 1440 and 390 px: the Notebook's marks after the ordering fix,
  and the Overview's two sessions told apart by `.venv`.
- Run 5's conversation reopened at 1440 and 390 px. At first the row showed "Installed pandas
  3.1.0, statsmod…" cut at one line, and the folded work counted it among "Ran 5 commands". After
  the change it wraps (the whole row at 390 px) and the fold reads "Ran 4 commands" beside the
  install. Opening the row shows the command.

## Not established

- Run 4's install was a shell command in a Claude Code session outside Rho. Rho does not see that
  session's commands (`project.work.read` lists no sessions, and native activity needs a Core
  Host), so it showed no "Installed" step. The wording appears in conversations Rho shows, as in
  run 5.
- At the panel's width beside a 1440 px page the row ends at "statsmodels 0.15.0 and…"; the tool
  and the count are in its tooltip and details.
- Runs 2 and 3 installed from inside cells. A cell's code is not read as an install. Its output
  shows what pip printed.
- With `pip install -q`, nothing names the installed versions, so the step names the packages
  without versions.
- On a 390 px Overview, "ended · 1 cell" and "Failed, refused or unknown" are cut at the right
  edge. This was already so before these changes.
- Runs 3 to 5 read the skill's new paragraph, with one model through Claude Code. Whether Agents
  pass `interpreter` in other projects, with other models or with Codex is not observed.
