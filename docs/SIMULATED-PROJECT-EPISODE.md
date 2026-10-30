# Simulated analysis projects

On 2026-10-29, Rho was started from source and two disposable projects built from
rho-bio-eval capsules, bix-18 and bix-41, were run through it, giving the screens real
content to review. Each project held only its capsule's data and a questions file.
Notebooks and gold answers were left out. Question text stayed outside every
repository, so this record names capsules and question ids only. The bix-41 q3 basis
stated its ratio rule, and the strain identifier was to be read as text.

## The run

The service ran from `dist/cli.js` with a disposable root and state under `/tmp`, the
debug Core binary and the system Rscript. A headless Chrome on the same loopback page
took the screenshots. Projects were registered with `project.open`. Clicking Open
folder from the headless browser once opened the native folder dialog on the
person's screen, and the folder the person chose there was left alone. Conversations
were started from the Agent panel with Claude Code. The person answered every native
permission request; the scripts only watched.

- **bix-18:** the first conversation failed because the default model was not
  available from the configured provider. The person chose another model, and a new
  conversation finished in 53 s.
- **bix-41:** the conversation finished in 12 min with 110 steps and no permission
  requests.

Both answered every question in agreement with the capsule's gold answers (compared
outside the repository). The screenshots also stay outside the repository, because
they show question text.

## What the screens showed

1. Studio opened every file the Agent named. At nine views, the newest one, the
   answers file, showed "This layout has reached its view limit".
2. The answer, and the method it used, appeared only in the Agent panel. Overview
   showed counts, the timeline and figures.
3. With 110 steps, the Graph became a tall column of near-identical "`analysis.py` ·
   Captured 3×" cards, and the question and results were off screen. In bix-18,
   repeated "captured observation" labels covered the cards.
4. Review refused row questions on the result CSV ("Rows have no key") even though one
   column was a unique identifier. Its page used native selects and different margins.
5. In the panel:
   - Wide tables were cut off.
   - An empty "no recorded action" block always showed.
   - A failure was shown twice, with the provider name masked in only one copy.
6. Labels and naming:
   - Legend labels were truncated.
   - Files titled kept results by their SHA-256.
   - Two projects shared the same rail initials.
   - The model chip read "Model".
   - `inventory.json` was listed under Data.
   - Each conversation was titled from its first words.
   - The address bar always read `/`.
7. After a service restart, a folder the person had chosen in the system dialog was
   gone from their project list.

## Changes

- **Studio** (`web/shell/workspace.tsx`): the views on screen always render, then the
  most recently shown, then the rest in layout order, up to the eight-view budget. A
  hidden view past the budget unmounts and mounts again from its owner, which keeps
  its buffer and undo but not its scroll or selection. The U2 browser acceptance now
  opens nine views, expects no limit page and at most eight editors.
- **Overview:**
  - It leads with the latest answer: the newest finished conversation's question and
    last answer, its time, duration and model, and Open conversation.
  - The results list names a kept version by the project file it was taken from.
- **Graph** (`foldVersions` in `src/work-graph.ts`):
  - One message draws one card per file, holding every captured version.
  - When a message runs three or more commands that touched no project file, they fold
    into one "N other commands" card listing each command with its ending, duration
    and output.
  - Lane names that repeat carry their start time.
  - The legend wraps at narrow widths and reads "Versions kept".
- **Agent panel:**
  - A failure the Agent's last words already state is shown once (masked URLs
    included).
  - The empty Agent column is hidden.
  - Tables scroll sideways with edge shadows and keep numbers whole.
- **Agent page:** conversation details stack below 820 px.
- **Review** (Annotations 0.5.2):
  - The person's questions and the kept results are choices, newest version of each
    result first with a count of earlier ones.
  - Any other exact version stays selectable.
  - The page uses the project pages' width and margins.
- **Rail:** where initials collide, a project is marked by the part of its name that
  differs ("18", "41").
- **Settings chip:** it reads "Default model" until a model is chosen.
- **Server:** the local person's chosen folders survive a restart. Each carried grant
  still names one registered, natively selected project, and a paired tab does not
  see it. The new browser test fails on the earlier code.
- **Local tab identity** (`web/main.tsx`): rerunning the U2 browser acceptance for the
  Studio change stopped before its budget check, as a run from 2026-10-28 already had.
  The person's own edit was labeled "Another tab". Since local access replaced links
  on 2026-10-25, a tab on this machine had not named its principal. It now names
  `browser:local`, so the person's own changes read "You" and keep the own-undo hint.

## Verification

The same projects were reopened after the changes:

- Studio showed the answers file.
- Overview showed the latest answer with its numbers and method, and the legend read
  whole.
- The bix-41 Graph read 1 question · 9 files · 18 runs, with one "13 other commands"
  card.
- The panel showed the failure once, and tables kept their numbers intact.
- Review showed its choices.
- Files showed original names, and the rail read 18 and 41.
- At 390 px no page scrolled horizontally.

Owner and application suites passed as recorded in the [ledger](VERIFICATION.json).
The U2 browser acceptance passed, including nine views with at most eight editors
(`work/u2-ui-closeout/browser-1793285040156/`), and so did the review-evidence
acceptance after its chooser step moved to the new choices.

## Left open

- Row questions on an ordinary CSV need an identity choice: the person declares a key
  column (a capture with an explicit key), or a row is anchored by position within
  one exact version.
- Pages have no addresses of their own.
- `inventory.json` stays under Data, which is its kind by file name.
- The provider name is masked in errors but not in the Agent's own text.
- Conversation titles are still taken from their first words.
- A grant lost before the server change has to be reopened once.
- No independent researcher has used these screens.

## Second pass

On 2026-10-30 the person looked at the changed screens and named what was still wrong.
A separate Review page was not where a researcher or an Agent would go to question an
answer. The Overview set things side by side without saying how they related. Commands
the Agent ran had no place of their own, and a person had nowhere to run a step
themselves. They suggested a Console plugin and asked whether the screens needed a
layout grammar. The design agreed on was:

- The answer is the page. A board derived from the Graph shows one message's answer
  with its results, the method, the run, its inputs and its report, each in a role.
- Questions and decisions happen on the answer. A person asks about a result or a
  passage in place, which sends a message to the same conversation. The person's
  word is bound to the versions the message kept.
- A Console records every command, the Agent's and the person's. The person can run
  a step, stop it and run it again.
- Studio is the person's own arrangement. Following the Agent happens on the board.

A grammar for arbitrary layouts was not built. The board's roles are the one
arrangement the runs so far called for.

### Changes

- **Console 0.1.0** (Rho-plugins `plugins/console`): `console.run/list/output/stop`
  keep each command's change identity, who ran it, folder, pid, ending and
  head-and-tail output under `.rho/plugins/console/`. Stop reaches the command's whole
  process group. After a restart, a live command is `continuing` and a vanished one
  `unknown`. Rho admits `console.run` and `console.stop` from the local browser only;
  Agent grants may read the record
  ([Headless](HEADLESS.md#decisions-on-an-answer-and-the-console)).
- **Console page** (`web/console.tsx`): newest first, each message's commands sit under
  it, with the person's own between them and managed runs last. A command shows its
  ending, duration, output and the files that changed while it ran. Run again puts an
  Agent's command into the prompt to check.
- **Agent 0.4.19:** a command's whole text is kept, up to 8 KiB. Before, an inline
  Python here-document was recorded as its first line and could not be read or run
  again. Older records still have only that line, and say so instead of offering Run
  again.
- **Answer board** (`src/answer-board.ts`, `web/answer-board.tsx`), which leads the
  Overview: the figure or table the answer names leads, and the other results sit
  beside or below it. The method, the run, a count of other commands (opening the
  Console), inputs and report follow. Ask on a result, or Ask about this on a selected
  passage, sends a question that names what it is about, including the exact kept
  version. Later questions that made no results stay with the answer under Asked
  since.
- **Decisions** (`conversation.decide`): Use this answer, or Needs changes with a note
  that is also sent to the Agent. Each decision is bound to the versions the message
  kept, names results it does not cover and files changed since, and supersedes
  without deleting. Review is listed only while a project has review records.
- **Capture** (`src/conversations.ts`): a file seen again with the same bytes, a key
  already tried, or a file with a capture still pending no longer spends the message's
  budget. The final collection at turn end does not count against the attempt limit.
- **Graph:** a question asked in place is titled by its question. A `captured
  observation` line is dropped where another line of the message already reaches the
  file; the redundant lines had made ← jump to the question.
- **Studio:** nothing opens there by itself. A message sent from Studio leaves the
  person there, and Follow goes to the board.

### What the runs showed

**Asking in place.** On the earlier bix-41 project, Ask on `figure.png` sent a
question about the kept version. Claude Code answered from `analysis.py`, citing its
lines. The board then showed that answer in place of the original one, since the
newest message had led it. Later questions that make no results now follow the answer
they ask about.

**Results with no kept version.** The first bix-41 message had filled its 64-record
capture budget and counted 2,024 omitted captures. Repeated reads of the same
unchanged script and data had each spent an attempt, so several results kept no
version. A decision on it therefore read "Not covered" for those results. The capture
change and its test (`test/answer-decisions.test.mjs`) address the cause.

**Commands.** The Console listed the old run's commands under their message. An inline
script showed only its first line, which led to the Agent 0.4.19 change. The person's
own commands streamed output, ended with their exit code, stopped, and ran again. At
390 px nothing scrolled sideways.

**Interface faults**, both fixed: a board card turned green on hover, because its role
class collided with the global `.primary` button style, and a hook placed after an
early return caused React error #310.

**A fresh run.** A new disposable copy of bix-41 (data and questions file only) was
given the same message from the Overview. Claude Code answered in 11 min with 39 steps
and 19 commands, and asked for no permissions. Its capture record held 23 versions
with no omissions. All six results were kept (the figure in four versions,
`answers.md` in two, the others once), as was `figure.pdf`. The board led with the
figure, then the three tables and `answers.json`. Below them came the script's
outline, `python3 -I analysis.py` with the seven files it changed, 18 other commands,
the data and questions it read, and `answers.md`.

**Faults seen in the fresh run:**

- The model's provider broke off once mid-response. The Agent's text then read as an
  API error, and the board showed it as the answer while the message ran.
- The model's next call had truncated input, and Claude Code refused it
  (`tool_use_error`). The Console and Graph had counted that refusal as a failed
  command titled "Terminal". A refusal Claude Code answers this way, with no exit
  code, is now a refused step: it is marked on the timeline and drawn as no run.
- While the message ran, the board's header read "Working · … · Working", and Work
  progress repeated the board above it. The header now names the step ("Running
  python3 analysis.py"). Work progress lists only sessions the board does not show,
  and choices waiting in it.
- The answer's four numbered items each rendered as "1.", because blank lines
  separated them. A list now continues across blank lines and keeps its first number.
- `answers.json` was an empty card; a text result now shows its first lines.
- The Graph still drew a captured-observation line beside each read line, since a
  read runs from the file to the question. A capture line now goes whenever another
  line of the message touches the file.

**Deciding and asking on the fresh answer.** Use this answer recorded "for the 10 file
versions this message kept", with nothing reported as not covered. The answer ended
by naming its own two judgment calls: what counted as "equivalent", and the distance
used for "most similar". That sentence was selected and asked about in place. The
header named the question being answered, but cut it off mid-phrase with no ellipsis,
which was corrected. Claude Code answered in 2 min without running anything: with a
prespecified margin, the count in the first answer would drop from six to none. The
reply stayed under Asked since, below the answer it asks about, with the passage it
quoted on its own line. The decision recorded before stayed as it was.

### Verification

On the fresh project after these changes:

- The board showed the results with `answers.json`'s first lines, and the follow-up
  under the answer.
- The Console listed the 18 commands that ran; the refused call was no longer among
  them.
- The Graph drew no captured-observation lines and read 2 questions · 10 files · 18
  runs.
- At 390 px neither the Overview nor the Graph scrolled sideways, and no page errors
  were logged.

Suites and acceptances are recorded in Status and the [ledger](VERIFICATION.json).

### Left open

- **Agent-declared choices** were agreed (the Agent declares its choices, and the
  person answers Agree or No on the board) but not built. In the fresh run the Agent
  stated its two judgment calls in one sentence of its answer and in `answers.md`. It
  did not declare them through Rho: a Rho-started session can reach Rho, but nothing
  asked it to. Asking about that sentence in place showed that one of the calls
  decides an answer. Building it needs a public declaration (or a kind of task-map
  item), wording that asks the Agent to use it, and a per-choice record that holds,
  like `conversation.decide`, for the versions the message kept. That choice is the
  person's.
- **A layout grammar:** the board is one arrangement derived from roles. Whether other
  answers need the Agent to compose their own arrangement is not yet observed.
- Row questions on an ordinary CSV still need an identity choice, and pages still have
  no addresses.
- An Agent's interim text (such as a provider error mid-response) shows as the answer
  while the message runs.
- No independent researcher has used these screens.

## Process Studio

After the second pass the person said Studio should not be cut back to the person's
own arrangement. Studio is where a person sees, in one space, how the Agent got the
work done; the Overview and the Console stay as focused views. The actions, outputs
and commands need their own components and a layout that holds that much. The steps
of the work belong in a small aid generated as the Agent works. Time belongs down the
side, beside the conversation, so that a replay plays the two together. They framed
it as a layout grammar and content question as much as a visual one, and chose one
Studio per conversation started in Rho.

### Changes

- **One Studio per conversation** (`web/studio-process.tsx`): a tab for each of the
  newest conversations, ahead of the person's own workspaces. The layout is derived
  from the conversation's record until the person arranges it. It is then saved as
  `conversation-<id>`: later files join their role's place and files the person closed
  stay closed (`studioMerge`, by the time the layout was last saved).
- **Layout by role** (`src/studio-layout.ts`): each file takes the role the answer
  board gives it, from the whole record. Inputs, the code and a Commands view stack on
  one side; figures sit above the tables and reports on the other. Each role has one
  place and a limit (`studioLimits`); further files stay in Files. A role first
  appears when the work first had such a file.
- **Versions in place** (`web/shell/process-views.tsx`): a file's view names the kept
  version it shows, with earlier and later. A view's properties hold only its
  declared title, so the file is found again from the view's id.
- **Commands** (`CommandPane` in `web/console.tsx`): the conversation's commands
  oldest first, as a terminal reads, with the files each changed and the person's own
  commands and prompt below.
- **Parts of the work** (`src/studio-chapters.ts`): a chip in the Studio bar names the
  part in progress, in the Agent's own words between steps or by what the steps did,
  with rounds of editing and running. Provider error notices open no part.
- **Time beside the conversation:** a timeline down the stage's right edge, long
  pauses folded. Choosing a moment there, a part or another version cuts the record
  at that second (`src/replay.ts`). The views, commands, part and the conversation in
  the Agent panel all show it; a text file shows the version kept then, read only.
  At phone width the timeline is a row with play, the moment and steps.
- **Following:** Follow and the topbar chip open the running conversation's Studio,
  which brings forward the file the Agent is on, or Commands while it runs one.
  Sending from the person's own workspace leaves them there.

### What the runs showed

**The recorded bix-41 run, replayed.** The second pass's fresh project (two messages,
10 kept versions of the script, 4 of the figure) was opened in its Studio. The first
screen had no script and no question file: text views arrive after the editor's
document opens, and the live layout took a new arrangement only when its saved
version changed. A derived layout is now taken as given each time. Stepping to the
moment the script was written showed "no version kept" beside "Wrote analysis.py":
the write and its kept version fell 76 ms apart in the same displayed second, so a
moment now holds its whole second. In that second the Agent also announced its next
command, which won the step and kept the script behind Commands; a file written in
the same second now comes forward. In the canvas acceptance's controlled run, the
steps chip named a part by what it went on to do ("Edited analysis.R") while the
conversation beside it had only read the data; it now names the part from the steps
taken by then.

**Saying only what the record holds.** During replay every command read "changed no
project file". The record keeps each file's last change, so a run whose output was
rewritten later has no change of its own. The fold now says "with no recorded file
change", in the Console too. A command with no reported exit code had shown as a red
"Finished"; only a failure or a non-zero exit is marked now.

**Arranging.** Closing a view failed: the catalog accepts only a `title` property, and
the views carried their path and role. The file is now found from the view's id;
closing a view saved `conversation-<id>`, and after a reload the closed view stayed
closed and the rest kept their places.

**A live run, watched from its Studio.** A fresh copy of the bix-41 inputs was
answered by Claude Code (DeepSeek V4.1 Flash) in 13 min, with no permission
requests. The message was started from Studio and Follow opened its Studio. The data
and question file appeared as inputs, then the script, then the results beside them,
and the Agent's marker moved between Read, Wrote, Edited and Running. The script was
kept 26 times and the figure twice. The chip named 16 parts in the Agent's own words,
and a failed run showed as a red mark on the timeline. No page errors were logged.
Between two updates the results tabs swapped places while nothing about those files
had changed: a role's files had followed the board's order of the moment. They now
keep the order the work first had them, after the result an answer led with. The
long command in the topbar chip clipped the breadcrumb on both sides; crumbs now
shorten at their end before the page name. Replayed afterwards at 04:43:42, the
conversation showed the Agent 1:50 in, running a SciPy check, and Commands showed
that command still running. The Agent named one analysis choice in its answer rather
than declaring it, as in the second pass.

### Verification

- `test/studio-process.test.mjs`: the cut at a moment, the parts, roles and order from
  the whole record, the layout, and a saved arrangement merged with later files.
- `acceptance:agent-canvas` now checks that Follow opens the conversation's Studio with
  its data, script, commands, output, parts and timeline. It also checks that a moment
  chosen on the timeline shows the views and the conversation as they were then. The
  sources, graph, agent-page, agent-ui, review and ui:u2 acceptances passed unchanged.
- At 390 px the conversation's Studio shows one view at a time, with play, the moment
  and its steps in a row; nothing scrolled sideways.

### Left open

- No independent person has watched a run or a replay in Studio.
- A command is credited only with files whose last change fell while it ran.
- Studio reads a conversation's newest 8 messages (`processLimits.turns`); earlier
  ones are not in its layout or timeline.
- A replayed text file is shown as plain read-only text, without the editor's
  highlighting. At 900 px the inputs' place leaves a table few rows.
- A saved conversation Studio counts toward the project's 32 layouts and cannot yet be
  removed.
- Agent-declared choices, row identity on an ordinary CSV and page addresses remain
  as recorded in the second pass.

## Project notes

After the process Studio the person asked for the notes to be organized: a project
has several sessions and several Studio layouts, so Studio should list the sessions
under it with fitting titles, and the whole project should share one set of notes, a
special component. Their sketch put a notes column with Question, Data & method, Key
results (with a figure) and To do beside the code, commands, figure, table, timeline and
Agent panel. They chose one section per session in a shared file, titled by the
Agent's heading there, read formatted with tickable to-dos and a toolbar that writes
the Markdown.

### Changes

- **Sessions under Studio** (`web/project.tsx`): the sidebar lists each session
  started in Rho under Studio, newest first (eight, then All sessions), then the
  person's workspaces. The Studio bar names the one shown, with its steps, Follow,
  Notes and Arrange views; the tabs across the bar are gone.
- **One set of notes** (`src/project-notes.ts`, `web/project-notes.tsx`):
  `project-notes.md` at the project root, an ordinary file every session reads and
  edits with its own tools. Rho appends to a session's Agent instructions that it keep
  one section there: a level-2 heading naming its task, `<!-- rho:session <id> -->` on
  the next line, then Question, Data & method, Key results with a figure and To do as
  a task list, changing only its own section (Agent 0.4.20 passes them as ACP
  `systemPrompt`, append, on session/new and session/load). A session's title is its
  heading there, else the Agent's title, else its first message.
- **The notes panel**: one view of the file's shared buffer beside any Studio layout,
  opened at the shown session's section and hidden or shown from the bar (remembered
  in this browser; hidden at first below 768 px, where it replaces the stage).
  Markdown 0.2.0 ticks a to-do by editing its line through the buffer, hides
  comment-only lines and gives its editor bold, italic, two heading levels, lists and
  to-dos (Documents 0.4.8 hands it the editor). The person's edits are saved after a
  1.5 s pause with the buffer's write conditions; the editor's own Save and highlight
  controls stay out of the column.

### What the runs showed

**The recorded bix-41 run with notes.** A notes file was written by hand into the
third copy, with a section for its conversation and one of the person's own with no
marker. The session's row under Studio, the Studio bar and the breadcrumb took the
section's heading in place of the conversation's first-message title, and the panel
opened with that heading marked. Three defects showed and were fixed. The to-do boxes sat centred
on lines of their own: Rho's form styles make a `label` a column. After a blank line
the list turned loose (`<li><p><label>`), so the reader's fix now matches any label in
a to-do. The steps chip overlapped the Notes button, because its slot had no width of
its own; the date left the bar and the buttons drop their names when the Studio is
narrow. In Edit the editor's Save and highlight controls covered the panel's title, and
the Read button disappeared: the reader had stopped rendering its own modes in Edit,
so a workspace pane could not return to Read either. A ticked box and a typed line
each reached the file about 1.5 s later and the panel said Saved; hiding, showing and
760 px behaved. A project with no notes showed the hint and wrote no file.

**A live session keeping its section.** A fourth copy of the bix-41 inputs (the question
file and the data only) was answered from Studio by Claude Code (DeepSeek V4.1 Flash)
in 5.6 min, with no permission requests and no page errors. Near the end the Agent
created `project-notes.md` with its own tools, in the asked shape: a level-2 heading
naming the task, its session marker on the next line, then Question, Data & method (the
data file, the tests and the script), Key results with the figure embedded, and To do
with every item ticked. About 6 s later, while the turn was still running, the sidebar
row, the Studio bar and the breadcrumb took that heading, and the panel showed the
section with its figure. The Agent's answer pointed to the notes. The same screen had
the notes twice: as an output the Agent wrote, the file took a place among the results.
The project notes now take no place in a conversation's Studio. A long title squeezed
the steps chip to two letters; the chip now keeps its width and the title shortens. A
wrapped to-do continued under its box; to-dos now hang under their text.

**Opening a project.** The U2 acceptance then failed on its 200-row table blocks. Two
3-row reads of the same table came from the Overview's result cards before the
workspace opened. With this pass's views but the notes hook disabled it passed, as it
did with the previous views. Opening `project-notes.md` as every project opened had
added a round trip that kept the Overview on screen a little longer. The notes are now
opened only when the project has sessions started in Rho or the panel is shown, and
the unchanged acceptance passes. The same run showed that notes open on a wide window
took the whole page when it narrowed, so the views disappeared without the person
doing anything. A window that narrows now closes the notes without changing the wide
window's choice; at phone width they open only when asked.

### Verification

- `test/project-notes.test.mjs`: sections and markers outside code, a duplicate, late
  or fenced marker, the title and byte limits, and instructions that name the file and
  marker and carry nothing of the person's question.
- `test/studio-process.test.mjs`: a session's project notes take no place in its Studio
  (the test fails without the change).
- Plugins: Agent instructions appended on session/new and session/load; Markdown to-do
  source lines, comment-only lines, ticking and the formatting edits.
- `acceptance:agent-canvas` checks the conversation's row under Studio and the Studio
  title; `acceptance:sources` uses Edit and returns with Read.
- Browser checks on disposable copies: ticking and typing reached the file and said
  Saved; the toolbar wrote to-dos; hide, show, 760 px and a project with no notes.

### Left open

- No independent person has used the notes or the session list.
- In a project without sessions, leaving Studio within the pause keeps the person's
  edit in the buffer, unsaved, until the notes are next shown.
- An Agent writing its section while the person has unsaved notes edits was not
  observed. Documents merges a file change into unsaved text when the lines differ;
  otherwise the save fails on its disk condition and the panel says Not saved.
- Sessions cannot be renamed from Rho; the title follows the heading in the file.
- The sketch's dark terminal, labelled figure versions, compare button and file cards
  in the Agent panel were not built.
