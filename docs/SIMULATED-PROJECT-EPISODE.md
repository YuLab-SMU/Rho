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
