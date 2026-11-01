# Timeline events and the Notebook's name

Updated 2026-11-01. The user asked for two things. Plugins should hand the timeline "who did what,
when" as events, so the person's Notebook cells and Console commands appear on it. And they asked
whether the Notebook should be renamed. In a Rho conversation they had asked
"可以在notebook 中演示一下ggplot2吗？", and the Agent made a Quarto document instead of using
Rho's Notebook.

## The Notebook's name

**Observed.** That conversation began on 2026-10-27, before Rho told its Agents about the Notebook
(2026-10-30). In the turn, Claude Code with DeepSeek V4.1 Flash checked R, ggplot2, IRkernel and
Quarto with Bash. It found Jupyter with only a Python kernel, wrote `ggplot2-demo.qmd` and rendered
it. It never looked up `kernel.run`. The conversation's grant held `kernel.run`. The ACP adapter
(`claude-agent-acp` 0.97.0) passes Rho's appended instructions when it loads a session as well as
when it creates one, so the Notebook part was present.

**Reproduced.** The question was asked with the person's exact words, the same model, Rho's appended
instructions, Claude Code's native tools and Rho's MCP tools under the conversation profile
(`work/notebook-name/headless.mjs`). Nothing asked for permission: Rho's tools, reads and listings
ran, and other calls were refused and recorded.

| Run | First Rho step | Cells run in the R session |
| --- | --- | --- |
| New session | `rho_index` for `kernel` | 8 |
| First message answered without the Notebook part, then resumed | `rho_index` for `kernel` | 4 |
| As above, with the person's own Claude Code settings | `rho_index` for `kernel` | 3 |
| New session with the sentence below | `rho_index` for `kernel` | 10 |

Every run used the shared R session; none looked for Jupyter or Quarto. Replaying the failed
conversation's own history meant writing a copy of its transcript into `~/.claude/projects`. Claude
Code's permission check refused that as transcript tampering, so the failure itself was not
reproduced. A session whose earlier messages worked in other ways is the remaining difference.

**Decided.** The Notebook keeps its name. The person says "notebook" because the page is called
that, and Agents in new sessions took the word as Rho's sessions in every run. A rename would
change the words on every screen without touching the case that failed. Agents started in Rho now
read one more sentence: something asked for "in the notebook", or in the R or Python session,
means these sessions on Rho's Notebook page, not a Jupyter, Quarto or R Markdown notebook, unless
a file is named. Whether it changes the outcome for a long, older conversation is not
established.

## Who did what, when

**Before.** The timelines drew only what conversations record. The person's cells and commands were
absent. An Agent's own cells were absent too, because a `rho_call` to `kernel.run` is recorded as
a project call, not a run.

**Changed.**

- Plugin contracts carry one event shape: who (`by`), what (`label`), where, when it began and
  ended, and how it ended (`running`, `done`, `failed`, `stopped`, `unknown`). A plugin names its
  events read in `timeline`. Notebook 0.5.0 reads `kernel.events` and Console 0.3.0 reads
  `console.events`, newest first, without code or output.
- Rho lists each plugin's `timeline` in the catalog, reads every one the tab may call, and places
  each event by principal. The person at this machine has a lane named You, above the
  conversations. An Agent started in Rho is known by its conversation's principal, so its cells
  join that conversation's lane. Anyone else shares a lane named Outside Rho. Pointing at a block
  says "You ran summary(fit) · R", with Failed, Stopped or Outcome unknown when it applies.
- The Overview's strip appears when only the person has worked, as What you did, and otherwise as
  What you and the Agent did.
- A conversation's Studio draws its own Agent's events and the person's since it began, the same
  share its Notebook view shows. A replayed moment at one of them brings the Notebook or Commands
  view forward when the Studio has one.

## Runs

`work/timeline/episode.mjs` copied the person's Rho-Playground to `/tmp`, with its conversation and
its Notebook cell. In the browser the person ran a failing cell, a working one and two commands. A
caller holding an outside grant ran a cell, as an Agent outside Rho would. The Overview, the Graph
and the conversation's Studio were then shown at 1440 px.

| Pass | Observed | Change |
| --- | --- | --- |
| 1 | Lanes You, the conversation and Outside Rho with the right events, and a tooltip naming the command. The 20 seconds of new work had about 10 px after a 4.7 h pause, beside a stretch of days | Each stretch first gets room for its steps (`stretchSizes`), then shares the rest by duration |
| 1 | The conversation's brand mark stood above its name: the global `.conversation` style matched the lane's class | The lane marks who it is with `data-who` |
| 2 | Four separate blocks in You with the failed cell outlined, the outside cell below, and the person's cells after the pause in Studio's side timeline. The outside cell was left out there | — |
| Person only | A new project with two cells and a command shows What you did with one lane, with no page errors and no sideways scroll at 390 px | — |

## Checks

Rho 267/269 in the ledger. A rerun showed its two misses: the MCP v2 test at its 30 s limit and the
`.rho` cleanup race after a Console test. Each passes alone, MCP v2 in 23.9 s twice. Plugins
163/163, with new tests for both events reads. The pinned contracts export list gained the
timeline names.

The graph, frontend and pages acceptances passed. agent-canvas failed where it clicked 10 px into
Studio's side timeline. The click had depended on a cramped first stretch to land after the first
read; with the new sizing it landed on the question, and an earlier step's check had been passing
on an empty Studio. The acceptance now clicks the first read mark, passes 10/10, and its replay
shows the data and script read then.

## Left open

- No Agent started in Rho ran cells in these browser runs, because its permission prompts are the
  person's to answer. Its cells in its conversation's lane are covered by unit tests only.
- A replayed moment at the person's cell bringing the Notebook forward was not exercised.
- Lane names are hidden at phone width, for conversations as before.
- The Graph page still shows "Nothing to draw yet" without conversations, even when the person has
  worked.
