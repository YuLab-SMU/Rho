# Rho product direction

Rho is a research workspace in which people and external Agents work on the same
projects, documents and scientific results. Functional capabilities stay in
Rho-plugins; managed execution stays in Rho-core. The application connects them so
that a person can see what was done, understand it and decide what happens next.

[Status](STATUS.md) records current behavior, checks and the stage of each part;
[Frontend](FRONTEND.md) describes the browser application as it is.

## First integrated flow

A person opens a project, gives an external Agent a task, inspects or changes the
proposed work and opens its real outputs. They can edit code, inspect a table or
figure, ask about an exact selection and continue from an explicitly linked reply.
Workspaces arrange those objects without changing who owns their content.

When execution fails, the actual error can be handed to the Agent for a new repair
run. When a reply is lost, the original request remains the one to observe. Closing
views, returning to a project or reconnecting must preserve acknowledged work and
must not silently rerun it. Exports contain actual artifacts and provenance.

Current code and behavioral tests implement this flow, and the
[base-R episode](BASE-R-EPISODE.md) has run it with a real Agent. Whether people can
follow it from the screens is the open question below.

## How the roadmap advances

The roadmap is a sequence of questions, each answered by a real result. The next
question is chosen from the review of the last result, so the order below is
expected to change. [Development](DEVELOPMENT.md#stages) describes how results are
produced, analyzed and acted on. The roadmap does not specify screens, interaction
vocabularies or visual values ahead of those results.

### Now: can a person read the answer?

The [2026-10-25 base-R run](BASE-R-EPISODE.md#review-of-the-2026-10-25-run) showed
that a real Agent can answer an anchored question, change the analysis, run it and
link the new results, and that the person's place and work survive a disconnection.
It also showed that the screens do not present the answer. The change between the
results has to be found by comparing two tables, and implementation facts stand
where the question and its answer should be.

The next run presents the same episode around the question: what was asked, what
the Agent changed and what changed in the results, with tables, figure, code and
provenance one step away. It is judged on its retained screens first, then by a
person who did not build it.

### Then, provisionally in this order

1. **Can someone else do it?** A researcher who did not build Rho asks the question,
   follows the Agent's work and says what changed and why, without help. Test in
   [small, repeated rounds](https://www.nngroup.com/articles/why-you-only-need-to-test-with-5-users/):
   a few people, fixes, then another round.
2. **Do failures stay understandable?** Run the episode with failures it has not yet
   exercised: an outside edit to the script while the Agent edits it, a lost save
   acknowledgement, a reply that never arrives and a result that arrives in part.
3. **What carries over to real analysis?** Repeat with a DESeq2 project, several
   results and its own domain checks. Presentation moves into shared owners only
   where both episodes need it; the scientific method stays in the project and
   plugins.
4. **When should the Agent change the workspace?** Suggested and followed views,
   protected views and the person's place, explored once an episode needs the Agent
   to rearrange what the person sees.

## Remaining product work

Future changes should follow a concrete user need. Project Notebook would need a
real content/structure owner and stable page identities before its interface can
claim those capabilities; a frontend text field does not supply that owner. A
conversation started in Rho has one: Rho holds its input and connects the selected
Claude or Codex session ([episode](ACP-EPISODE.md)), while sessions started elsewhere
keep their own input.

The current delivery is an unsigned local npm package and WebUI. Registry publication
requires an explicit release selection. Native desktop windows, cross-window movement,
additional platforms and signed distribution remain later scope. The separate
[release process](RELEASE.md#official-distribution) defines promotion and signing;
scientific actions do not inherit release approval requirements.
