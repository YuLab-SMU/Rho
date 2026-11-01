# The project Rho ships with

2026-11-01 local. Rho now starts with one finished research project, so a person who
opens it sees what a project looks like when the work is done instead of an empty
list. The study is the one in [Rho-cases](https://github.com/YuLab-SMU/Rho)'s
`pa14-qs` case: *Pseudomonas aeruginosa* PA14 quorum sensing and swarming, on that
study's own data. Everything in the project was produced by an Agent in Rho on this
machine; nothing was written to look finished.

The person who opens the copy decides what it is worth. What follows is what was
built, what the real runs did, and what they exposed.

## What ships

`example/pa14-qs/` is a project folder with its own state, and `example/example.json`
names the folder and the version it belongs to. A new service state copies it into
the projects folder (`PA14 quorum sensing`) and registers it as an ordinary project
whose record says it came from the example. A second start copies nothing; a folder
the person already has is never overwritten; a person who deletes the copy does not
get it back. `--example off` starts without it, and a service composed in code
(`new RhoService({...})`) does not seed unless it asks to, so existing checks and
acceptance scripts see the project lists they did before.

| In the project | What it holds |
| --- | --- |
| `README.md` | The study, where the data come from, and what each file means |
| `data/` | The swarming assay, the co-culture assay, raw counts, sample sheet, annotation (1.2 MB) |
| `analysis/` | Four R scripts the Agent wrote: single mutants, co-culture, differential expression, summary figure |
| `results/` | Two figures, the summary figure, seven tables and `summary.md` |
| `project-notes.md` | Three sections, one per session: question, data & method, key results, choices with alternatives, files, to do |
| `.rho/` | The conversations, the versions each message kept, the commands, the Notebook cells and the timeline |

## The runs

Claude Code (`westlakehpc/deepseek-v4.1-flash[1m]`, shown as DeepSeek V4.1 Flash)
answered in Rho's own conversations, with Rho's grant and its native tools. Each
question was asked in a person's words; the Agent was told nothing about how to
answer it. The person's permission buttons were answered by the build harness: a
command that stays inside the project is allowed, and anything reaching outside it,
the network, credentials or a destructive command is refused. Nine requests were
refused over the three sessions (a `find` outside the project, `sips`, a package
check); the Studio shows them as failed commands.

| Session | Question | Result |
| --- | --- | --- |
| 1 | Do the las and rhl single mutants swarm worse than wild type, and does shape change? | Completed, 51 steps. Welch tests on log area with ratios of geometric means and Holm adjustment; all four mutants 0.13–0.29× wild type, circularity up 5.2–8.2×, roundness unchanged. Figure and two tables. |
| 2 | Do ΔrhlI + ΔlasI grown together swarm like wild type again, and does the ratio matter? | Completed, 64 steps. Fitted peak at 12.3:1 (95% CI 10.4–14.7), 1.34× wild type, ratio explained 93% of the variance in log area; the 500:1 mixes collapsed. Figure and two tables. |
| 3 | What do the mutants change in gene expression? | Completed, 67 steps. DESeq2 over all 36 samples, nine mutant-vs-wild-type contrasts: 384–1,362 genes changed at FDR < 0.05 and |log2FC| ≥ 1, hypergeometric overlap between the single mutants, additive double mutant. Four-panel figure and five tables. |
| 3 | Hand on a table that is not 10 MB | Completed, 7 steps. The Agent wrote a compact table (7,143 rows, 15 columns) instead of 52,452 rows, and updated its notes. |
| 3 | Put the conclusion where it is easy to find | Completed, 19 steps. `results/summary.md`. |
| 3 | Draw the project's one-page summary figure | Completed, 24 steps. `results/summary.png`, which is what the Overview now leads with. |

The scientific content is the case's study, so its reference answers can be read
against it elsewhere; the case's questions and gold were not copied into the project,
and the demo's questions are phrased in the person's own words.

## What the first run exposed

**A conversation could not be continued after Rho restarted.** The first attempt to
ask the second question in the session that answered the first failed with
`Resource not found: <session>`: the Agent's session belongs to the process that ran
it, and Rho retained only its identity. A probe of two services on one state
directory reproduced it on an ordinary project with one short message — every
conversation in a project became unreplyable after a quit-and-reopen, and a project
copied to another machine could never reply at all.

Rho now reads that answer as what it is. When the Agent reports that the session it
was asked to load is gone, the message runs in a new session, which is told what was
said in the conversation so far — the person's words and the Agent's own replies,
bounded to 12 KB and dropping the earliest exchanges first with a note that it did
so. The turn records which session it replaced (`continued`), and the conversation
says so in the person's own view: "The Agent session this conversation had been using
had ended, so this message ran in a new one, told what was said here before." Nothing
is resent as a new request, and the messages Rho kept stay the record.

Observed on the shipped copy: a reply in the first session ran in a new session,
answered "which single mutant swarmed worst" from the project's own files, and added
the caveat that the two plates have their own wild-type control (geometric mean
108,686 here against 81,732 in the single-mutant plates).

**An Agent that iterates on a figure can outlast one message.** The co-culture answer
was stopped at the 30-minute wall limit of one message after 57 steps, with its
figure already written. That attempt was removed and asked again with a raised
`conversations.turnWallMs`; the demo must not ship a stopped message. The limit is
right for a product and wrong for a build that asks for polished figures.

## What the copy is not

One recorded result names a file that is no longer there: the full differential-expression
table was replaced by the compact one at the person's request, so a view that asks for the
first table's bytes is answered "This file is not in the project any more." That is the
state a real project reaches when a derived file is superseded, and Rho says so.

The recorded folder in the commands and the Notebook is the folder this build ran in;
on another machine that text is history, not a location. The shipped copy states the folder
the build ran in and the host that ran it as the copy's own name, through the assembly step
that also replaces the model catalogue with the one model the conversations used; the build
folder keeps all three. The sessions the Notebook
lists ended with the service that ran them, and Rho says so where it lists them. The
copy is a project, not a tour: it does not explain Rho, and its notes are the Agent's
scientific notes, not product documentation.

## Checks

`node --test test/example-project.test.mjs` covers the copy (once, silently on a
second start, never over a folder the person has) and the history a new session is
given (what was said, newest kept, the budget, a first message carrying nothing).
`npm run build` and `tsc -p tsconfig.web.json --noEmit` pass with the contract field
and the view change.

The browser side was read at 1440 × 900 on the seeded copy: the projects list, the
Overview leading with the summary figure, Studio with the notes and the run's
commands, the Graph (six questions, 32 files, 50 runs, 111 versions kept, three
conversations), and the Notebook with 42 recorded cells and an ended session. A
reply in the seeded copy was answered as described above.
