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
