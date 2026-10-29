# Developing Rho

Rho is developed by trying things on real work and learning from what happens.
Each stage produces a concrete result, such as a run, a screen or a person using
it, and the next step comes from analyzing that result. Documents record what
results have shown. They do not prescribe screens, plugins, interaction
vocabularies or visual values that have not been built and observed. Written
ahead of results, such rules turn guesses into requirements, and later work is
judged against the guesses instead of against what people need.

Start with [Status](STATUS.md) for where each part stands,
[Architecture](ARCHITECTURE.md) for the boundaries that are not open to experiment
and [Roadmap](ROADMAP.md) for the questions being worked on. [Frontend](FRONTEND.md)
describes the browser application as it is. The backend's
[build, check and assembly commands](HEADLESS.md#budgets-verification-and-assembly)
exercise the headless composition.

## What is fixed and what is open

The behavioral boundaries in AGENTS.md and Architecture are **fixed**: source
ownership, project scope and authorization, original request identity, no silent
re-execution, unsaved buffers and undo, partial and unknown outcomes, and the
separation of execution, artifact, domain and model facts. Breaking them loses work
or misreports what happened. Tests protect them, and an iteration does not reopen
them. A boundary constrains what the system does and claims; it does not need its
own label on every screen.

Everything a result can still teach is **open**: what a screen leads with, how
results are compared, how the Agent's work is shown, layout, wording, color,
spacing and which capabilities a plugin needs to offer. These are settled by trying
them on a real episode and reviewing the result. Current values live in the code
and change when a reviewed result calls for it. Behavior that has tests changes
deliberately, together with its tests.

## Stages

A capability, plugin, screen or episode moves through these stages. Different parts
of Rho are at different stages at the same time; [Status](STATUS.md#current-focus)
records each one.

| Stage | Question | Result to produce | Not yet |
| --- | --- | --- | --- |
| 1 · Runs | Does it work end to end on real resources? | One real run and its record: commands, screenshots, logs and anything faked or skipped. | Polishing, generalizing, writing rules. |
| 2 · Usable | Can the task be done and understood from the screens, including a realistic failure? | Repeated runs of the whole episode, each reviewed screen by screen against the task. | Abstractions for other consumers. |
| 3 · Usable by others | Can a person who did not build it complete the task without help? | Notes from watching them: what they did, misread and asked, and how they recovered. | Counting the builder's fluency as evidence. |
| 4 · Reused | Does a second, different consumer need the same thing? | A second episode, with another plugin, dataset or domain, that uses it. | Extracting a shared contract from one example. |
| 5 · Hardened | Will it keep working as other parts change? | Regression checks for confirmed behavior, accessibility and performance checks where they apply, and lessons written as guidance. | Reopening settled behavior without new evidence. |

Stages 3 and 4 can come in either order. A plugin starts from an episode that needs
it: its view or operation is built for that episode, observed first in its own
preview and then inside the application, and a second episode decides what becomes
its general contract. The application's screens follow the same path: an episode
decides what a screen shows, and shared shell structure comes from what several
episodes need. Record the scope in which each stage was observed; a view that is
usable in its preview may still only run inside the application.

Stages 1 and 2 favor speed. Rough screens, temporary scripts and stubs are fine when
they are labeled. Rigor and written rules belong to stage 5. Applied to a stage-1
question, they slow learning and fix guesses in place; stage-1 work presented as
finished hides its gaps. Move a part forward when its stage question is answered
and what remains is polish, not when a checklist is complete. Move it back when a
result shows that an earlier question was answered wrongly.

## One iteration

Each iteration answers one question with one real run.

1. **Choose the question**: the top problem from the last review, or the current
   stage question. Write a short brief.
2. **Make the smallest change** that could answer it, in its actual owner. Removing
   noise often comes before adding structure.
3. **Run the real episode**: a disposable project, real data, the real Agent when the
   episode has one, and the failures and window sizes that matter. Keep the setup of
   the previous run so that the two can be compared.
4. **Look at the result yourself**: screenshots, data, logs and the transitions
   between states. A passing assertion shows that a path works, not that a person
   can follow it.
5. **Analyze, improve and record**, as described below.

The brief is a few lines of working material, not another document:

```text
Question:       what this run should tell us
Setup:          project, data, Agent or fixture, window sizes, failure to inject
Change:         what changes, in which owner
Look at:        the screens, outputs or behavior that will answer the question
Change course:  the result that would show the approach is wrong
```

## Analyze the result

**Start from the task, not the screen.** Write the person's question in their own
words, then check whether the result answers it: where the answer is, and how much
scanning, memory or knowledge of the implementation it takes to reach it. In the
base-R episode the question is why May has only 24 observations and what changes
when only missing ozone is excluded.

**Observe before judging.** An observation names the state, what is there and why
it matters for the task. "The change in May (n 24→26) can only be found by comparing
two tables whose first rows are 48 px apart" can be acted on; "the comparison looks
rough" cannot. Measure where it helps: height spent before the first data row,
controls competing in one area, steps a recovery takes. Note what works, so that the
next change keeps it, and what is missing as well as what is wrong.

**Classify each observation.** The classes set the order of work:

- *Blocking*: the task cannot be completed, work is lost or recovery fails.
- *Misleading*: the screen supports a wrong belief, such as a copied request shown
  as sent, a finished run read as a correct result or an unknown outcome shown as a
  failure.
- *Friction*: the task completes but costs extra reading, memory or guessing.
- *Polish*: alignment, spacing and consistency that do not change the outcome.

**Find the cause and its owner.** Many surface problems share one cause, so check
the deepest level first:

| Level | Typical sign | Where the fix goes |
| --- | --- | --- |
| Concept | The screen is organized around the wrong thing, such as files and tabs instead of the question and its answer. | Rethink what the episode presents before adjusting details. |
| Capability | Something cannot be shown because no owner provides it, such as the differences between two keyed tables. | The owner, whether Rho, Core or a plugin, with its own check. |
| Composition | The right parts exist, but in the wrong place, order or prominence. | Rho's shell and workspace. |
| Component | A view presents its own content poorly. | That view's owner. |
| Wording | Labels name the implementation, or claim more than was observed. | Wherever the text is produced. |

Fix at the deepest level that explains most observations. Restyling does not repair
a concept problem.

**Keep kinds of evidence apart.** A path that works, a screen that can be read, a
person who completes the task and a scientifically valid result are different
claims, each with its own evidence. Say which ones a run supports and which remain
unverified.

**Look across runs.** A problem seen once gets a local fix. A problem that recurs in a
second episode or consumer is a candidate for a shared change and a written lesson.

The [base-R review](BASE-R-EPISODE.md#review-of-the-2026-10-25-run) is a worked
example of this analysis.

## Improve

- Fix blocking and misleading problems first; they decide whether the result can be
  trusted at all.
- Then take the cause behind most of the friction, usually at the concept or
  composition level, before any polish.
- When the direction is unclear, try two or three materially different options on
  the same real content, choose by what the results show and discard the rest.
- Make one significant change per iteration where possible, so that its effect can
  be attributed. Rerun the whole episode, not only the changed screen: fixes move
  problems into neighbouring states.
- Advance when the stage question is answered. Polishing a stage-2 result
  indefinitely delays the evidence that stage 3 would bring.
- Change course when repeated fixes do not move the observations, or when results
  contradict the premise of the approach. Record why.
- Do not generalize from one case. A framework, shared contract or rule waits for a
  second consumer that needs it.

## Design references

Three references inform design judgment in Rho. Each helps find and weigh problems
in a real result; none supplies Rho's screens, values or a checklist.

- **Jakob Nielsen.** His [ten heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)
  are, in his words, "broad rules of thumb and not specific usability guidelines",
  developed for inspecting an existing design. Use them as review questions: is the
  state visible, does the screen use the person's language rather than the
  system's, does it rely on recognition rather than recall, can an error be
  understood and recovered from? For testing with people he recommends
  [small, repeated rounds](https://www.nngroup.com/articles/why-you-only-need-to-test-with-5-users/):
  about five participants, fix what they reveal, then test again.
- **Karri Saarinen.** He describes quality as the whole experience, reached by teams
  that stay engaged "from concept to completion" rather than through assembly-line
  process and metrics ([Why is quality so rare?](https://linear.app/now/why-is-quality-so-rare)).
  For AI products he argues for a structured workbench in which people set up and
  supervise Agents and check their results, and suggests that design may need to
  start from probing what the AI can actually do
  ([Design for the AI age](https://linear.app/now/design-for-the-ai-age)).
- **Apple.** Its [design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles)
  (purpose, agency, responsibility, familiarity, flexibility, simplicity, craft and
  delight) are presented as "tools to help you weigh competing priorities", with no
  one right way to apply them. Craft includes experimenting and iterating; simplicity
  means every element earns its place in a clear hierarchy.

A lens that finds a problem produces an observation. It is not a pass/fail
criterion, and it does not prescribe a style.

## Record what was learned

- An **episode record**, such as the [Base-R episode](BASE-R-EPISODE.md), keeps the
  setup, how to rerun it, the evidence of each run and each run's review:
  observations, analysis, decision and what the next run should show. Add a review
  for every run and keep the earlier ones, so that the trajectory stays visible.
- **[Status](STATUS.md)** keeps where each part stands, its open problems and the next
  step, in under 300 lines.
- A **lesson** is an observed problem with its understood cause and the change that
  addressed it. It stays in the episode record. When it holds in a second episode or
  consumer, write it as guidance in the document it concerns (this one for method,
  [Frontend](FRONTEND.md) for presentation, [Architecture](ARCHITECTURE.md) for
  boundaries), linking both pieces of evidence and naming its scope. Revise or remove
  guidance that a later result contradicts, and say why.

Do not write ahead of results: specifications for screens or plugins that have not
been built, design values outside the code, exhaustive state lists for flows that
have not run, acceptance criteria for capabilities no owner provides, or vocabularies
of verbs, levels and fact types before two consumers need them. A short brief for the
next run is enough.

## Work in the source owner

The adjacent `Rho`, `Rho-core` and `Rho-plugins` checkouts have independent source,
dependencies, commits and checks. Read the applicable AGENTS.md before editing.
Rho owns the application container; components own their actual functionality;
Core owns its declared execution contract.

Inspect Git status and preserve unrelated work. Start with a concrete user action,
try the available public capability and identify the smallest gap in its owner.
Native Agent tools are the normal execution path. Core is selected for a concrete
operation need; an acceptance case that explicitly exercises managed execution
does not set a general Agent policy. Keep activity observation and honest outcome
facts independent of the choice of execution path.
Reuse mature tools and valid evidence. Additional state, transport or compatibility
mechanisms need a consumer requirement and explicit acceptance conditions.

Routine Rho changes proceed on `main` through reviewed diffs, checked commits and
ordinary fast-forward pushes. A review branch is used when the user selects it.
Component repositories retain their own workflows.

## Checks

Checks follow the stage and the claim: a stage-1 run needs its record, and hardening
needs regression tests. Only executed checks count, each for its recorded scope.

- **Documents**: check local links and anchors, render the changed batch and inspect
  every changed page for missing content or glyphs, clipping and broken tables.
  Recheck affected pages after fixes.
- **Browser**: real Chrome with actual resources at the window sizes the episode
  needs; the base-R runs use 1440, 1024, 768 and 390 CSS px. Verify the native IME,
  focus, keyboard, clipboard, undo and external-write behavior that an episode
  touches; synthetic key events alone do not show native input behavior.
- **Suites**: `acceptance:frontend`, `acceptance:base-r`, `acceptance:interaction`,
  `acceptance:continuity`, `acceptance:shell`, `acceptance:plugin-dx` and the owner
  suites supply bounded evidence; read their assertions before claiming coverage.
  Deterministic consumers and real Agent runs are different evidence. Record the
  command, the selected source/composition, the result, failures and limits.
- **People**: usability claims need target users doing the episode without
  coaching. Record completion, wrong beliefs about state, where they stopped, help
  needed and recovery effort, with the participants and task in scope.
- **Execution**: use disposable projects and owned Hosts. Inspect existing work
  before starting another Host on the same project. Preserve user sessions, original
  request identity, partial output and unknown outcomes. Resource budgets name the
  protected resource, its configuration and the exceeded-limit behavior.

Generic Core contract regressions stay in Core. Component/domain checks and reusable
Agent evaluations stay in Rho-plugins. Application interaction and composition checks
belong here. Never run Cargo builds/tests concurrently. Documentation-only changes do
not need runtime builds or new execution runs.

## Composition and delivery

Record immutable source/artifact identities, dependency versions, public boundaries,
explicit local overrides and acceptance of the chosen application composition.
Component checks alone do not prove application integration; the
[first integrated flow](ROADMAP.md#first-integrated-flow) is accepted on the actual
composition. Publish required components before application references and verify
remote heads and trees.

Follow [Release](RELEASE.md) for source publication and distribution. Keep the
[Status](STATUS.md) summary focused on current implementation, evidence and next
work, under 300 lines. Credentials and private diagnostics stay out of source.
