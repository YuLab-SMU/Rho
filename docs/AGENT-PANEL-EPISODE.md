# The Agent panel

Updated 2026-10-28.

## Question

The user found the Agent panel's conversation window too primitive, "as if an intern
made it", and gave ten screens of other Agent applications as references
(`work/chat-windows-ref/`, ignored by Git). What they share: the person's message as
a rounded bubble; the work before the answer folded into one line ("Worked for 31s")
with each step a muted line under it; the answer set as readable prose with headings,
lists, code blocks and tables; one rounded message box holding the model and a round
send button; and a small line under it with context and usage.

The references set the kind of window, not values to copy. The question: can a person
read what the Agent answered, see what it did and what it cost, and write the next
message, without the window getting in the way?

## Observed before

Looked at with the real records of the local service's test project, on a copy
(`work/chat-panel-20261028/before/`, panel 640 px):

- Every tool step was a 50 px row with a rule under it. A style meant for the Project
  page's run buttons (`.activity-row`) also matched the panel's rows. A message with
  20 steps filled several screens before its answer.
- The answer's headings, lists, paragraphs and tables ran into each other; the table
  was cut at the panel's edge and scrolled sideways.
- Six permission choices, each with its whole command, followed the answer as grey
  lines ("You chose “Yes” · Rscript -e …").
- A grey band, "Session plan & usage", sat between the messages and the box.
- The box was three rows: a text area with a resize grip; a select reading
  `group/auto-claude-opus-5-5 · magpie-server Xhigh effort`; then "Resumes this
  conversation." beside a pale Send.
- The header read "All conversations · hi · Claude Code": the first message, not the
  title Claude Code gave the session.

## Changed

Rho only (`web/conversation.tsx`, `web/markdown.tsx`, `web/theme.css`,
`web/agent-settings.tsx`, `web/settings-menu.tsx`, `web/settings-menu.css`,
`web/icons.tsx`, `src/conversation-presentation.ts`):

- **Each message folds its work.** The Agent's last words stay in the open. What it did
  before them, with what it said along the way and the choices made for it, is one
  line: "Worked · Ran 8 commands · Wrote 1 file · Edited 1 file · Read 4 files · 2
  refused · 6 choices". It is open while the Agent works and folds when the message
  ends; the person's own opening or closing is kept. Inside, each step is one line with
  an icon for its kind (read, edit, command, search, fetch, plan); refused steps are
  red. A pending permission stays outside the fold as the amber card.
- **Files are counted once.** Nine edits of one script are "Edited 1 file"; commands
  still count each run.
- **The answer reads as text.** 14 px with room between paragraphs, headings set apart,
  first-level list markers, code blocks with their language and Copy, inline code as
  quiet chips, and tables that wrap inside the panel before they scroll.
- **Each message ends with one line**: how it ended, the model that answered, the time,
  and Copy for the answer.
- **The header** has a back arrow, the Agent's mark, the session's title and New
  conversation, and stays at the top while the messages scroll.
- **The message box** is one rounded surface: the text grows to about ten lines; under
  it the settings chip and a round Send, which becomes Stop while the Agent answers. ⌘/Ctrl Enter still sends. "Jump to latest" is a round
  button above the box, with a dot when something new arrived.
- **Under the box**, the plan entry in progress and the context ring, tokens and cost
  the Agent reported. It opens a small card above the box: context used as a bar with
  its tokens, the cost, the plan as a list of entries, and one line saying the Agent
  reported these and Rho does not measure them. Escape closes it and leaves the panel
  open.
- **The settings are one chip and a short menu.** The chip names the model, the
  provider it comes through, the effort and what is switched on; the provider yields
  first when the panel is narrow. It opens a menu with a row per setting the Agent
  offers, each with its value: the Agent (new conversation only), the model, effort,
  mode. A setting whose only values are On and Off is a switch that changes at once
  and keeps the menu open. A row opens its list in place under a back arrow; the model
  list keeps its search and providers. A value closes the menu; Escape and ← step back,
  then close it, never the panel. In a new conversation's lists the first entry is
  "Not chosen · Claude Code uses Xhigh", apart from a value the Agent itself calls
  Default.
- **The start screen** names the Agent with its mark, and lists conversations by
  their titles.

## Runs

Evidence: `work/chat-panel-20261028/`, `work/agent-ui-acceptance/` and
`work/agent-page-acceptance/` (ignored by Git).

| Run | What was looked at | Observed | Change |
| --- | --- | --- | --- |
| `look.mjs` before | The real ggplot2 conversation at 640 px | As above | The fold, the answer's type, the box |
| `look.mjs` after1 | The same | "Edited 9 files" for one script edited nine times; the model name cut with room to spare; a bare "Session" label | Files counted once; the label went |
| `look.mjs` after1, opened | The fold, the record, the model list | Escape on the record also closed the panel | Escape stops at the record |
| `look.mjs` 390 | A phone | Escape on the record also closed the sheet | Its default stopped too |
| `look.mjs` 340 | The default width | The effort clipped to "Xhigh effo" | The model's width follows the panel's |
| `acceptance:agent-ui` | A controlled peer: streaming, permission, plan | "Mod" cut in the chip: its −8 px margin made it 8 px narrower than its holder; list markers were hollow circles inside the list of messages | The margin moved to the holder; first-level markers |
| `chipdebug.mjs` | The chip's widths | The deficit was always 8 px, the margin | — |
| The user, after the first pass | The record above the box | "Still a lump": the plugin's session view as prose, a title, a context sentence and four paragraphs of observation notes; the trigger a grey band when open | Rho draws the card from the same report; the notes went; no band |
| The user, after the record | The model chooser, beside two references: a menu of rows with their values, effort as a list, Fast as a switch | Too crude: a native effort select above a large model popover | One chip and a menu of rows |
| `menu.mjs` | The menu on the copy at 640, 340 and 390 px | The model's value cut at its start ("laude-opus-5-5 · magpie-server"); Fast mode and Ultracode, offered as On/Off lists, drawn as rows; two "Default" entries in a new conversation's Effort list | The value ends in an ellipsis; On/Off lists are switches; Rho's entry is "Not chosen" |
| `menu.mjs` again | The same, a switch and a value | A switch keeps the menu open and adds "Fast mode" to the chip; a value closes it; Escape from a list returns to its row, then closes the menu with the panel open; no overflow or page errors | — |

## Checks

Run serially on 2026-10-28 (`work/chat-panel-20261028/final/`):

- `build:service`, `build:web`, the web type check and `check:contracts` passed.
- Rho 215/215 and Plugins 92/92 ([ledger](VERIFICATION.json)), including "a file the
  Agent touched several times is counted once; commands count each time".
- `acceptance:agent-ui` 7/7 with a controlled peer: text streams into the open
  message; each action names its file, command or operation while it runs; the plan
  line follows the entry in progress and its record lists the plan and closes on
  Escape without closing the panel; a native permission is answered and the choice
  kept in the work that folds when the message ends; Markdown renders; reading earlier
  lines is not interrupted and the round "Jump to latest" names new activity.
- `agent-page` 5/5, `graph` 8/8, `agent-canvas` 10/10, `frontend` 13/13, `continuity`
  7/7, `sources` 7/7, `objects` 5/5, `actions` 6/6, and shell, pages, person and plugin
  UI passed. After the record changed, `agent-ui` 7/7, `frontend` 13/13, `agent-canvas`
  10/10, `agent-page` 5/5 and the stylesheet token test passed again.
- After the settings menu, the same serial batch passed again: Rho 215/215, Plugins
  92/92, `agent-page` 6/6 with "the message box names the saved model and effort in one
  chip, and its menu changes them in place", `graph` 8/8, `frontend` 13/13,
  `agent-canvas` 10/10, `agent-ui` 7/7, `continuity` 7/7, `sources` 7/7, `objects` 5/5,
  `actions` 6/6, and shell, pages, person and plugin UI. The Agents tab's model list,
  which the menu now shares, passed in `agent-page` after its unused options were
  removed. `acceptance:acp` chooses the Agent through the new menu; it needs a real
  Agent and was not run.

## Limits

- The fold hides what the Agent said along the way once a message ends; it is one
  click away, and the last words never fold.
- The menu offers what the Agent reported when it was last asked, under the Agent's
  own names ("Xhigh", "Ultracode").
- The usage line shows what the Agent reported for its session; an Agent that reports
  none shows no ring. The observation counts the Agent plugin keeps (updates seen, not
  displayed) are no longer shown in the panel; Work progress still shows them.
- A message whose stream joins two sentences without a break shows them joined: Rho
  shows what the Agent sent.
- Tables wrap; on a phone a four-column table grows tall rather than scrolling.
- No person other than the builder has used the window.
