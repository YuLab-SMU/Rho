# Agents and conversations

Updated 2026-10-28.

## Question

The user asked to improve the Agent settings and the conversation management, and gave
four screens from another application as references: one row per Agent with its mark,
version, connection, model and a switch, opening to model tiers, a model list grouped
by provider and settings; and a list of sessions with each one's model, effort,
message count, tokens and cost, continue and delete, opening to its time, folder,
session identity, routing and an export. They also gave the marks of Claude Code, Codex
and DeepSeek.

The references set the kind of page, not values to copy. The questions:

1. Can a person see which Agents Rho can start, what each offers and what new
   conversations will use, and change it, without reading a row of chips?
2. Can a person find a conversation, see what it used and cost, continue it, keep a
   copy, and clear it away?

## Observed before

Looked at with the real Claude Code's settings (101 models) and records of real
conversations (`work/agent-settings-20261028/before/`):

- The Agent page opened on a card: "New conversations use" with a Claude Code / Codex
  switch and five chips in one line (model, effort, mode, fast mode, ultracode). No
  Agent had a mark, a version or a state; Codex showed nothing until chosen.
- The model chip opened one list of 101 models. Claude Code's own names came first,
  read as "Opus 5.5 (sonnet)", with no word on what they are.
- Each conversation was a large card with every recent message's work. Finding one,
  or seeing what it used, meant reading the cards. Nothing showed context use or cost,
  though each record kept them, and nothing searched.
- A project keeps at most 64 conversations started in Rho; past that, starting one is
  refused, and nothing removed one.
- An answer's Markdown table showed as raw `| Month | … |` lines.

## Changed

Rho only:

- **The record lists itself** (`src/conversations.ts`, `src/protocol.ts`). Each
  conversation's summary carries the Agent's own title for the session, the Agent and
  its adapter, the last model, the person's choices, the context use and cost the
  session reported, its session identity and whether it is in the trash. Summaries
  written before are rebuilt from their records once.
- **A trash** (`conversation.list`, `conversation.trash`, `conversation.restore`,
  `conversation.delete`, person only). Moving a conversation to the trash keeps it
  whole and frees its place among the 64; it cannot be continued until restored, and
  an idle connection to its Agent ends. It is refused while the Agent answers. The
  trash holds as many again. Deleting works only from the trash and removes Rho's
  record; the Agent's own session files stay. The request that started a deleted
  conversation is remembered (the last 256), so repeating it is refused rather than
  starting it again.
- **The Agent page has two tabs** (`web/agent-manage.tsx`, `web/agent-manage.css`,
  `web/brand-marks.tsx`):
  - Conversations: a search, an Agent filter when both Agents have conversations, and
    the Trash; rows by day, each with its Agent's mark, title, when, model, effort,
    message count and state, context use with a meter and cost; Continue (Follow while
    it answers), export as Markdown and Move to the trash. A row opens to its facts
    (the first message when the title differs, time, Agent and adapter, model and its
    value, other settings, context, cost, session identity and record path, each
    copyable) beside what its latest messages did. Moving to the trash offers Undo;
    the Trash restores, or deletes after a confirmation. Runs and sessions started
    outside Rho stay below.
  - Agents: one row per Agent with its mark, adapter version, Default or Make
    default, whether and when it was asked and how many models from how many
    providers, and its model. Details holds its settings; Claude Code's own names
    (`default`, `opus`, `sonnet`…) with what each runs and Choose; the providers with
    their counts, each opening its models; and who offered these, when, with Check
    again. Asking is still only the person's click.
- **Marks**: Claude Code, Codex and DeepSeek in their own marks; any other provider
  as its initial on one of the theme's hues. The message box's chip and its model
  list use them too.
- **Markdown tables** (`src/agent-markdown.ts`, `web/markdown.tsx`): a table after
  prose, alignment, pipes in code spans and short rows; it scrolls on its own.
- A conversation's names are read again while its Agent has none here, so a Codex
  row named its model once Codex's first session told Rho what it offers.

## Runs

Evidence: `work/agent-settings-20261028/` and `work/agent-page-acceptance/` (ignored by
Git).

| Run | What was looked at | Observed | Change |
| --- | --- | --- | --- |
| `look.mjs` | The page before, real settings and records | As above | The two tabs |
| `look2.mjs` 1 | Both tabs, real data | The marks sat on green squares: `.brand-mark` was already Rho's logo; search icon at the top; Settings repeated the model | Own class; centred icon; model only on its line |
| `trash.mjs` | A copy of the local service's project: three real records written before | Summaries rebuilt; DeepSeek V4.1 Flash with Max effort, a failed message and a Chinese title shown; trash, Undo, restore and delete worked; no page errors | — |
| `look2.mjs` 390 | Phone width | The cost ran under Continue | The row wraps; the meter hides |
| acceptance | A Codex conversation | Its row showed `gpt-5.6`: the page read the names before Codex's first session gave them | Names read again while missing |
| `composer.mjs` | The message box's chip | Marks on the Agents and providers; a search for DeepSeek lists it under four providers | — |
| `ask.mjs` | The real Claude Code and Codex asked from the tab | Claude Code 3.2 s, claude-agent-acp 0.97.0, 101 models from 10 providers, its five own names with what each runs; Codex 0.8 s, codex-acp 2.3.0, 103 models from 11 providers, effort, mode and collaboration mode. "Check again" fell to its own line | Kept in its sentence |

## Checks

Run serially on 2026-10-28 (`work/agent-settings-20261028/final/`):

- `build:service`, `build:web`, the web type check and `check:contracts` (104
  operations) passed.
- Rho 214/214 and Plugins 92/92 ([ledger](VERIFICATION.json)), including "a
  conversation in the trash is kept whole, frees its place, cannot be continued, and is
  deleted only from there" and the Markdown table test.
- `acceptance:agent-page` 5/5 with controlled Claude Code and Codex peers: the Agents
  tab asks only when asked and saves the model, effort and default Agent; rows are
  found by search and by Agent; a row opens to its facts with its table rendered and
  exports as Markdown; the trash keeps a conversation until restored or deleted, with
  Undo, and never takes one the Agent is answering; no horizontal overflow at 1024 and
  390 and no page errors.
- `graph` 8/8, `agent-canvas` 10/10, `frontend` 13/13, `agent-ui` 7/7, `continuity`
  7/7, `sources` 7/7, `objects` 5/5, `actions` 6/6, and shell, pages, person and plugin
  UI passed.

## Limits

- Context use and cost are what the Agent reported for its session; a conversation
  whose Agent reports neither shows neither. They are not Rho's measurement.
- Provider groups are the Agent's own names: Codex offers both "fusecode-lab" and
  "fusecode Lab", and they are shown as two.
- Search reads titles, models and Agents, not the messages.
- Claude Code's own names follow Claude Code's settings; Rho shows what they run and
  does not change them.
- Deleting does not remove the Agent's own copy of the session.
- No person other than the builder has used the page.
