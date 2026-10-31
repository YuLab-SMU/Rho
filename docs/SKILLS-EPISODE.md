# Project skills

The request (2026-10-31): from a team discussion, a skills module. Skills record how analysis
is done; a skill changes as it is used, and each person's case differs; skills are the Agent's
notebook; errors and improvements should adapt them to the person and their environment; a
seed skill is any skill not yet aligned with the person and the environment. The first stage
built here is the project's own skills and the management of their changes. Seed skills and
learning from failures come later, from what this stage shows. Rho-plugins owns the skills
(Skills 0.1.0); Rho owns the page and the Overview's section.

## What a person and an Agent can do now

- **Skills are files Agents already read.** A project skill is a `SKILL.md` in the project's
  `.claude/skills/<name>/`, with a name, a description of when it applies and its text. Claude
  Code loads that folder by itself; other Agents read it through Rho (`skills.list`,
  `skills.read`). A skill written by hand or by an Agent's own file tools is listed like any
  other, with a problem when Agents could not load it (a frontmatter that does not name it or
  has no description).
- **Every change is recorded with who, why and from what.** `skills.change` writes a new skill,
  a new text or a removal on the version the writer read (`expectedVersion`; a stale one is
  refused) and keeps the author, a one-sentence reason, the evidence (a Notebook cell, a
  file, the person's words as a note, a Rho conversation, an annotation or a place) and both
  versions. The same `changeId` from the same caller returns the same change and never
  writes twice.
- **Undo is a change too.** `skills.undo` puts a skill back as it was before its newest
  change while the file is still as that change left it, and the undo can be undone.
- **Edits outside Rho are seen, kept and not overwritten unrecorded.** A file that differs
  from the last recorded version reads as changed outside Rho, with what changed. Before Rho
  writes over it, it is recorded as it was found, as a change by `outside`.
- **Limits name what they protect.** The Agent's context and the project's state folder: at
  most 24 skills, 32 KiB each, 1000 changes kept (the oldest go first, counted), 20 changes
  per read (50 at most) and 400 lines of difference (the rest counted as cut). A change past a
  limit is refused with the limit's name and the skill stays as it was. Links are refused.
- **The Agent's guidance** (`skills.project`) says to list and read the skills before
  analysing and follow them; to record when the person corrects a method or says how they
  work, when a failure's cause and fix are found, or when an accepted choice changes results;
  never to record results; to record a rule in the person's terms and scope; and that a skill
  grants nothing.

The Skills page and the Overview's section are described in [Frontend](FRONTEND.md).

## The page, with made-up skills

A disposable service and project held four skills: one an Agent changed twice with a real
Notebook cell as evidence, one changed afterwards by appending to its file, one removed as a
seed that did not fit, and one written by hand with a folded description. The page was read at
1440, 768 and 390 px.

| Seen | Changed |
| --- | --- |
| A removal's reason was replaced by "Removed the skill" | The reason is always the headline; the kind of change goes with who made it ("An Agent removed the skill") |
| The hand-written skill said "Changed outside Rho" and showed its whole file as added, above the same text | "Written outside Rho" in the list, a one-line note in the detail, no difference |
| A change that writes or removes the whole file repeated the text below it | Its lines fold under "The text it wrote" or "The text it removed" |
| The body's first heading repeated the skill's name | Left out when it only repeats the name; the text sits under "What Agents read" |
| A long note wrapped inside a round chip | Notes are quoted in a square-cornered well |
| The empty page put its message in the 280 px list column with nothing beside it, 32 px in from the page's edge | A 620 px message with the page's subtitle; the offset came from the shell's global `.empty` rule, so the class is `none-yet` |
| Disclosures had no marker (a flex summary loses it) | A chevron that turns when open |

The Overview's side column then got the three newest changes, each opening its skill. On a
narrow page the skill opens directly with All skills to go back.

## The episode

The pa14-qs case (in Rho-cases, a local repository beside Rho; see [A study on a lab server](REMOTE-EPISODE.md#a-study-on-a-lab-server)) asks one paper's study of Agents that
have Rho's tools only (Claude Code, no shell, no user settings or skills), its data on a
disposable lab server. `run.mjs --teach --again` adds the person's side: after a step's
answers, the person states how this project works, in the same conversation (a method
statement from `steps.json`, never an answer); then the same steps are asked again, each of a
new Agent, without notes. The notes for steps 1 and 2 were written knowing where earlier runs
differed from the benchmark's conventions (a proportion as a fraction, the strains grown alone
in the frequency fits, a mix as a ratio), so the grades measure what carried over, not
analysis skill.

### First run (16:07)

Rho e669dc7a and Rho-plugins f5088c9d, each with this work uncommitted; Claude Code 2.1.316
with Opus 5.5.

| Agent | Graded | Skills |
| --- | --- | --- |
| Step 1, then the person's note | 4/5 | listed (none) before its first cell; after the note, recorded `reporting-conventions` |
| Step 2, then the note | 5/11 | listed and read `reporting-conventions` first; after the note, recorded `coculture-frequency-analysis` and added a line to `reporting-conventions` |
| Step 1 again, new Agent | 5/5 | listed and read `reporting-conventions` first; gave the proportion as a percentage |
| Step 2 again, new Agent | 5/11 | listed and read both first; one answer gained and two lost |

- Every Agent listed the project's skills in its first turn, before its first cell. The first
  index's owner summary ("Skills are how work is done in this project…") was enough; nothing
  told them to in the prompt.
- After each note the Agent recorded it and told the person where to see or undo it ("You can
  see or undo the change in Rho's Skills panel"). The reasons are the person's statement in
  one sentence.
- The step 2 Agent widened a rule. The person said to give a mix "by the frequency of one
  strain, not as a ratio"; the line it recorded reads "write '83% ΔrhlI', not '5:1'", folding
  in step 1's percentage rule. The new Agent then gave a frequency as a percentage where the
  benchmark counts a fraction, and a mix as a frequency where one question counts a ratio. The
  rules carried over, including where they did not apply.
- With no Rho conversation of their own, the Agents filled conversation evidence with
  descriptions ("pa14-qs co-culture bix-41/bix-54 follow-up"). The page made those chips
  buttons that would open a conversation Rho does not have.

On the page the widened line sits directly under the chip with the person's words, so the gap
between what was said and what was recorded is visible beside Undo.

Changes, each in its owner: the guidance (Rho-plugins) says to record a rule in the person's
terms and scope without folding another rule into its examples, to give the person's words as
a note and to use a conversation reference only with a Rho conversation id. The page (Rho)
shows conversation evidence Rho does not hold as the Agent described it, not as a link.

### Second run (16:17)

With the guidance and the page changed (Rho-plugins committed as `1173789`, Rho uncommitted).

| Agent | Graded | Skills |
| --- | --- | --- |
| Step 1, then the person's note | 4/5 | listed (none) first; recorded `reporting-results` |
| Step 2, then the note | 5/11 | listed and read `reporting-results` first; recorded `coculture-frequency-series` and added a line to `reporting-results` |
| Step 1 again, new Agent | 5/5 | listed and read `reporting-results` first |
| Step 2 again, new Agent | 4/11 | listed and read both first |

- The rules were recorded as the person stated them ("Give a mix by the frequency of one
  strain, not as a ratio."), with no example folding one rule into another, and every
  change's evidence was the person's words as a note.
- Every Agent again listed the skills before its first cell, and the new Agents' answers said
  which skills they followed (and the server's own skill).
- The new step 2 Agent applied both rules together when answering, a mix's frequency written
  as a percentage, and where a question asked for a ratio it gave the frequency, saying so and
  giving the ratios beside it. The benchmark counts both against it. A rule the person stated
  before now outranks how a later question is worded; whether it should is the person's choice
  and is not settled here.
- The page showed a note the Agent had already put in quotation marks with a second pair; the
  page now drops the note's own.

On the page, each change's headline is the person's request in one sentence, the note beside
it is their words, and the line added below matches them.

## Checks

- Rho-plugins: the skills test (create, idempotency and conflict; an outside edit seen and kept;
  undo, removal and its undo; limits and links; hand-written skills) 5/5, and the whole suite.
- Rho: the contract check (131 operations); the pages acceptance with a Skills step (an
  Agent's two changes, the Overview's row opening the skill, Undo putting the file back, no
  overflow or unnamed buttons at four widths); ui:u2, person-files, agent-canvas, graph,
  agent-page, agent-ui and sources acceptances. The full suites' counts are in
  [Status](STATUS.md#verification).
- The page was read at 1440, 1024, 768 and 390 px with made-up skills and with both runs' skills.

## Limits and open questions

- Seed skills, and records made from failures without a person's note, were not exercised:
  every recorded change in the episode followed what the person said.
- When a standing rule and the wording of a later request disagree, the Agent followed the rule
  and said so. Whether the request should win instead is open.
- Claude Code's own loading of `.claude/skills` was not exercised: the case's Agents have no
  tools besides Rho's. Codex and other Agents read skills only through Rho.
- An Agent outside Rho's conversations is shown as "An Agent"; its granted session's name is
  not shown.
- The server's skills (from serverctl) are listed read only; they are the person's, not the
  project's.
- One person, one project and scripted notes. Whether people read the changes, and undo the
  ones that went too far, is not observed.
