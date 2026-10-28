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
- **The start screen** names the Agent with its mark and what it can do here.

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

## Where the Agent is reached

The user, on the project's Agent page with the panel open: the button that opens the
chat should be easier to find and see; conversations were listed everywhere; and the
topbar's panel button, opening Connection & access, is rarely used and can go.

Observed (`work/layout-20261028/`, the same copy, 1440 and 390 px):

- The panel opened from a small `>_` beside the sidebar's Agent row, from New
  conversation on the Agent page, from Work with Agent on the Overview, and from the
  topbar only while the sidebar was hidden.
- The same conversations were listed three times: the Agent page's rows, the panel's
  start screen, and the Overview's Work progress, where each finished conversation was
  a large card ("hi", Continue conversation, tokens and cost).
- The panel had two headers: "Agent ×", then the conversation's back arrow, title and
  New conversation.
- The sidebar's Connection & access row also hid the sidebar on a wide window, so
  focus had nowhere to return when its drawer closed.

Changed (`web/main.tsx`, `web/project.tsx`, `web/overview.tsx`,
`web/conversation.tsx`, `web/work-progress.tsx`, `web/popover.ts`, `web/icons.tsx`,
`web/theme.css`):

- **One Agent button**, filled, at the right end of the topbar on every page and
  width, pressed while the panel is open. The sidebar's `>_`, the Agent page's New
  conversation and the Overview's Work with Agent went; empty states keep theirs.
- **One header in the panel**: the conversation's title (or "New conversation"), New
  conversation and Close. The title opens the recent conversations, newest first,
  with a search past six and "All conversations" leading to the Agent page. Escape
  closes the list, then the panel.
- **One list**: the panel's start screen lists nothing; Work progress shows a
  conversation while it answers or waits for a choice and counts the finished ones,
  linking to the Agent page.
- **Connection & access** opens from the sidebar's foot only, and keeps the sidebar.

| Run | What was looked at | Observed | Change |
| --- | --- | --- | --- |
| `look.mjs` | The Agent page, the panel, its recent list, Connection & access at 1440 px | The list focused its first entry, not the open conversation; the sidebar row hid the sidebar and focus fell to the page; the list's dates read "Oct 27" where the Agent page says "Yesterday" | Focus goes to the open one; the row keeps the sidebar; the Agent page's wording |
| `look.mjs` again, and at 390 px | The same, and the phone sheet | One Agent button; no list on the start screen; Escape closes the list and keeps the panel; All conversations shows the Agent page (and closes the sheet on a phone); no overflow or page errors | — |
| The Overview at 1440 and 390 px | Work progress | Two finished conversations as cards headed "hi" | Finished ones are counted and linked |

## Agents outside Rho

The user asked what Connection & access is for, and said the Agent page's sessions
started outside Rho were plain text with no design, where other products' "connect
your agent" pages are designed. They chose that the Agent connects itself, with steps
a person can see and buttons a person can press, and kept Connection & access at the
sidebar's foot.

Observed before (the same copy, 1440 px):

- Connection & access held the connection's state (also in the topbar), this tab's
  access (which matters only for a tab opened from a link), the Agents with access
  (also on the Agent page) and a document's Changes.
- Sessions started outside Rho was a closed section of sentences: each grant's label,
  abilities and last call, then the project Host's activity. Work progress had its own
  "Connect an external ACP client" with a placeholder folder. Nothing on the page added
  Rho to an Agent: `rho --grant` printed a `claude mcp add` line to paste.

Decided: an Agent that connects itself through a Skill would need the operator's
connection, which opens every project. Instead the person at this machine presses one
button; the service gives that Agent access to this project only and runs the Agent's
own `mcp add` with that narrower connection. Nothing is sent to the Agent.

Changed (`src/agent-connect.ts`, `src/server.ts`, `src/protocol.ts`, `src/state.ts`,
`src/cli.ts`, `web/outside-agents.tsx`, `web/outside-agents.css`,
`web/agent-manage.tsx`, `web/main.tsx`, `web/overview.tsx`, `web/work-progress.tsx`):

- **`session.connect`**, for the person at this machine only, grants Claude Code or
  Codex access to the project and runs `claude mcp add -s local rho-<folder>` in the
  project folder or `codex mcp add rho-<folder>`, after removing an earlier entry of
  that name, then records what was added. A grant whose connection still reaches this
  service with its token is kept; one written for another address is replaced; a new
  grant the Agent then refuses is removed. Each CLI call may take 20 s and keep 8 KiB of
  output; past either it is stopped and the step fails with what it printed. `rho
  --grant` uses the same name and command.
- **Outside Rho**, the Agent page's third tab: Claude Code, Codex and Other ACP clients
  on the left with their state (Added, Connected, Access ended); on the right three
  steps in the state Rho observes, access to this project, Rho in that Agent (the
  button, what it ran and when) and its first call (when, which operation), then
  prompts to copy. Other ACP clients has the `rho --acp` commands with this project's
  folder and the sessions such a client started. The project Host's activity is a
  closed section below, read only while open. Work progress's ACP help went.
- **Connection & access** holds the connection, this tab's access and a document's
  Changes; its Agents list went.

| Run | What was looked at | Observed | Change |
| --- | --- | --- | --- |
| `work/outside-20261028/look.mjs` at 1440 px, stand-in `claude` and `codex` | Before and after Add, the first call, a refused Codex, ACP, Host activity | Steps 1 and 2 both marked as next before anything was added; a refusal left step 2 unmarked; the ACP panel kept an empty height | Step 1 waits on the button; a refusal marks step 2; a lower minimum height |
| The same at 390 px | The tab and its Agents | "Outside Rho" broke over two lines; the third Agent was cut off in a scrolling row | Tab names do not wrap; the Agents share the row in three columns |
| Again, after the copy's service started on a new port | Add again, Codex refused | The kept connection named the previous port, so Add again repaired nothing; the refused Codex was left as "Access only" | Kept only while it reaches this service; a refused new grant is removed |
| Both widths again, and `work/layout-20261028/look.mjs` | The tab; Connection & access | The steps follow the state; the drawer shows the connection and this tab; no overflow or page errors | — |

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
- After the Agent button moved to the topbar, the same batch passed again, with
  `agent-canvas` checking that the panel opens from the topbar and from nothing in the
  sidebar. The older `acceptance:ui` and `acceptance:interaction` stop before the
  changed step (a "link already used" page and a sidebar entry named "workspace", both
  gone); `acceptance:ui:u2` opens Changes from the sidebar, then fails on whether the
  Documents plugin names the person "You". `acceptance:acp` and the conversation
  episode reach a finished conversation through the recent list; they need a real
  Agent and were not run.
- After Outside Rho, the batch passed again: Rho 218/218, with `agent-connect.test.mjs`
  (both Agents' `mcp add`, a kept and a replaced connection, a `rho --grant` grant as
  the same session, an Agent refused, and a refusing, missing or stalled CLI), Plugins
  92/92, `agent-page` 7/7 with "Outside Rho adds Rho to Claude Code with its own mcp add
  and shows its first call; a refused Codex leaves no access", `graph` 8/8, `frontend`
  13/13, `agent-canvas` 10/10, `agent-ui` 7/7, `continuity` 7/7, `sources` 7/7,
  `objects` 5/5, `actions` 6/6, and shell, person and plugin UI. `pages` looked for the
  Agents list in Connection & access; it now finds the session under Outside Rho and
  passed, with no overflow at four widths.

## Limits

- The fold hides what the Agent said along the way once a message ends; it is one
  click away, and the last words never fold.
- The menu offers what the Agent reported when it was last asked, under the Agent's
  own names ("Xhigh", "Ultracode").
- The usage line shows what the Agent reported for its session; an Agent that reports
  none shows no ring. The observation counts the Agent plugin keeps (updates seen, not
  displayed) are no longer shown in the panel; Work progress shows them while a
  conversation is in progress.
- A message whose stream joins two sentences without a break shows them joined: Rho
  shows what the Agent sent.
- Tables wrap; on a phone a four-column table grows tall rather than scrolling.
- A document's Changes open in the Connection & access drawer, now reached only from
  the sidebar's foot; the document has no button of its own for them.
- The recent list holds conversations started in Rho; sessions started elsewhere are
  on the Agent page.
- The recent list's search appears past six conversations; the copy has two, so it
  was not seen with real records.
- Only stand-in CLIs ran `mcp add`; the real ones were read through `--help`, so the
  user's Claude Code and Codex configurations were not changed. A session already
  open does not load the new server; a new one does, as the page says.
- Codex keeps one entry per folder name for every folder: two projects in folders of
  the same name share `rho-<folder>`, and the later replaces the earlier.
- With no project Host running, Host activity reads "Observation disconnected" (the
  Agent plugin's wording). `acceptance:agent-activity`, which now opens it from Outside
  Rho, drives real Claude Code and dsh and was not rerun.
- No person other than the builder has used the window.
