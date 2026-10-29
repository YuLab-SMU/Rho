# An Agent's edit beside unsaved text

Updated 2026-10-29.

## Question

The user asked which plugin should be the first to declare its own Agent pieces (a
skill, a hook) and agreed to start with Documents by observing what the Agent does
today. The question of this first run: when a person has unsaved text in a file and
asks Claude Code to change the same file, what happens to both?

## Setup

`work/documents-hook-episode/episode.mjs` (ignored folder, rerunnable with a label):
a disposable project under `/tmp` with `analysis.R` (three lines) and a small CSV,
Rho started from source with its own state, real Chrome at 1440×900. The person
opens `analysis.R` in Studio, types `# Person: drop rows with missing Ozone before
fitting.` at the end and does not save. In the Agent panel they ask: "In analysis.R,
add a line at the end that prints summary(fit)." The script allows each permission
once, waits for the turn, reads disk and buffer, then presses Save. Claude Code
2.1.312 over claude-agent-acp 0.97.0, `settingSources: []`, only `Read` allowed
without asking. Gateway credentials are read into memory and never reported.

## Observed before

Rho 3b5d14cb with Documents 0.4.3, westlakehpc/deepseek-v4.1-flash:

1. The Agent used its native Read and Edit, not `document.edit`. The permission asked
   "Edit analysis.R" with no sign that the file had unsaved text in Rho.
2. After the turn the file on disk had the Agent's line and not the person's; the
   buffer had the person's line and not the Agent's. The editor showed nothing.
3. Save was refused: "The file changed on disk. Your buffer is kept; review the disk
   change before saving." Nothing offered a way to review. Two diverging versions,
   reconciled only by hand.

The cause was in Documents: `open` followed the file only into a buffer without
unsaved text, and nothing reopened the document after the Agent's edit anyway.

## Changed

- Documents 0.4.4 (Rho-plugins): `open` merges the disk change into unsaved text by
  line, against the disk text the buffer last matched (kept as `<id>.base` beside
  the record). Changes to different lines are both kept, insertions at one place
  with the disk's first; the buffer stays unsaved and the person's own undo removes
  only their edit. Where both changed the same lines nothing is merged and the save
  conflicts as before. A refused editor save reopens the document and saves once
  more if the owner merged. Conflict notice: "The file changed on disk where you
  also edited. Your text is kept and was not saved." Annotations 0.4.5 widens its
  Documents peer.
- Rho: when the project walk sees a different modification time for the file of an
  open document, the shell calls `document.open` for it, so the buffer follows
  without waiting for a save. Rho selects Documents 0.4.4 and Annotations 0.4.5.

## Observed after

`after-2026-10-29T04-42-13-978Z`, group/auto-deepseek-v4-1-flash (the same model on
another route; while this was run the Westlake route answered with 502 "EOF", so two
earlier runs ended at the 180 s wall limit with no steps):

1. The Agent again used native Read and Edit, asked "Edit analysis.R", and wrote
   `summary(fit)` as line 4.
2. Within 2.5 s of the turn ending, the buffer held both lines, the Agent's first,
   still unsaved; undo authors `browser:local` and `disk`. The editor highlighted the
   Agent's line and kept the person's below it.
3. Save wrote both lines to disk with no notice.

## Checks

Rho-plugins 94/94 (new: owner merge, undo after merge, overlapping change; editor
save that merges, and one that conflicts). Rho 218/218 and `acceptance:person` 9/9
at 1440, 768 and 390, including an external rewrite that still refuses the save. One
serial Rho run failed one of the three tests that run real Hosts within 30 s; the next
two runs passed, as the ledger records.

## Step 2: the Agent hears about the unsaved text before it writes

The merge keeps both lines, but the Agent still worked from the disk and never saw the
person's line. The user chose to have Documents declare a native skill and a hook.

### Changed

- Documents 0.4.5 declares `claudeCode`: its existing skill as the native skill
  `documents`, and `claude-hook`, a `PreToolUse` command for Edit, Write and
  MultiEdit. Only when the edited file's buffer has unsaved text does it deny the
  native write; the reason names the buffer and how to reach `document.edit` through
  the rho tools. It reads Documents' own records in the project, needs no connection
  and never creates `.rho`.
- Agent 0.4.16 writes a Claude Code plugin directory (manifest, `SKILL.md`,
  `hooks/hooks.json`) named by its content, and `ClaudeAcpOptions.plugins` loads it
  through `_meta.claudeCode.options.plugins`. Rho collects the declarations of its
  selected plugins, writes the directory under its state folder and passes it to
  every Claude conversation.

### Observed

`hook-2026-10-29T05-58-37-473Z`, same scenario and model route:

1. The Agent read the file and tried its native Edit; the hook denied it. No
   permission was asked for the Edit.
2. It loaded the rho tools, resolved and read the buffer, then ran a `python3`
   one-liner to count characters for `document.edit`'s offsets. That command asked
   the person for permission. Its first `document.edit` came back from the rho layer
   as the contract to read first; the same call then succeeded.
3. `print(summary(fit))` landed in the buffer after the person's line as an Agent
   edit (history `browser:local`, then `agent:…`); the disk was untouched. The reply
   said the change was unsaved and that saving would also write the person's note.
   The person's Save wrote both lines.

Cause of the counting: `document.edit` takes offsets, and the Agent had only the text.
The hook has both the buffer and the native change, so it now applies the change the
native tool would have made to the disk text, merges it by line with the unsaved text
(the owner's merge) and puts the ready `document.edit` input in the reason when that
is determined.

`hook-2026-10-29T06-04-02-062Z`, the same run again: native Edit denied, then
`rho_index`, `rho_resolve` and one `document.edit` that succeeded with the given input.
No permission prompt reached the person and no counting command ran (7 steps instead
of 12). The Agent's line sits right after `print(coef(fit))`, where its Edit put it,
before the person's line; the editor highlights it and the person's Save wrote both.

The native skill was listed as `rho:documents` with no description, and the Agent did
not use it. A direct check showed descriptions appear once the skill listing's
character budget is raised (`SLASH_COMMAND_TOOL_CHAR_BUDGET`): with this gateway model
the default budget drops the newest plugin skill's description. Rho does not change
that budget.

### Checks

Rho-plugins 97/97 (new: the hook through its command line for clean, unsaved, new,
outside and unreadable cases, its ready input accepted by `document.edit` unchanged,
the already-present case and the fallbacks; the plugin directory writer; the session
options). Rho 218/218 serially, including that a Claude session receives one plugin
directory with the hook and the skill and no credential. Parallel Rho runs failed a
different timing-bound test each time (3 s and 30 s waits) and passed alone.

## Limits and next

- The walk runs on project events (at most every 5 s). A file changed by a program
  that sends Rho no event is merged only when the person saves or the document is
  opened again.
- A merge is silent: the highlight shows the Agent's line, but no notice says the
  file changed. A true conflict still has no review or compare in the editor.
- The hook covers Claude Code sessions Rho starts, not Codex or a person's own
  Claude Code outside Rho, and not files under selected source folders.
- When the native change cannot be carried into the buffer (a whole-file Write over
  the person's lines, a disk that moved on), the Agent gets only the buffer's
  identity and has to read and place its edit itself.
- The native skill's description depends on Claude Code's listing budget.
