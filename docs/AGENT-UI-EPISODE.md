# Agent panel live activity

The user asked on 2026-10-27 to make the Agent UI show the Agent's work as it
happens: streaming replies, every action visible while it runs, and a distinct
treatment for the actions that need a person. This record keeps the setup, the
observations before and after, the owner changes and the checks. It is evidence
that these paths work, not evidence that another person can follow them.

## Setup

- One controlled ACP peer wrote text chunks every 80 ms and reported a read, a
  command, a write, a plan, usage and a native permission request. It ran through
  the real local service and Chrome 155.0.8059.84 on 2026-10-27, with no model
  credentials.
- One real Claude ACP turn ran through Westlake HPC
  (`westlakehpc/deepseek-v4.1-flash`, Claude Code 2.1.312) in a disposable
  project. The prompt asked for `ls`, `Read input.txt` and a short sum.
- The recorded conversations from the person's own 2026-10-27 runs were inspected,
  including the 24-step ggtree turn that the Overview and Agent panel showed as
  three collapsed "Worked in the project · 1 step" lines.

## What the panel did before

- Reply text arrived in the recorded 250 ms batches, but the panel had no caret,
  no elapsed time and no reading position: every update pulled the pane to the
  end. Markdown was printed literally (`**Files in …**`, fenced code and lists).
- Consecutive tool steps folded into one line. While a turn ran, the newest step
  was rendered as `Used <tool>…`; a real `Bash` step therefore said "Used Bash…"
  and never showed the command. File reads and writes did not name their file.
- A permission request was a plain bordered card; the person's choice left no
  trace in the turn. The Agent's plan sat in a closed section below the composer.
- The Agent plugin preferred a tool's programmatic name over its human title and
  discarded the ACP category and input, so the durable record could not support a
  better presentation later.

## Changes

**Agent 0.4.11** (`Rho-plugins/plugins/agent`) keeps three bounded additions on
each tool step: the Agent's human title, its ACP tool category (`read`, `edit`,
`execute`, `search`, …) and one identifying native input (command, file path,
pattern or query). They are cut to one 512-character line; raw tool output,
reasoning and history replay remain excluded. The README and fixture tests state
and check the new fields.

**Rho** now derives presentation from the retained record instead of rendering
protocol events as bubbles:

- `src/conversation-presentation.ts` turns steps into text, one line per action,
  or a folded run. Each action names its verb and target (`Read data.csv`,
  `Ran Rscript analysis.R`, `Wrote results/summary.csv`, `Called data.page`),
  keeps the Agent's title and reported location behind the row's disclosure, and
  distinguishes running, completed, refused and unknown outcomes. Short runs stay
  visible; more than three consecutive actions fold into what they accomplished.
- `src/agent-markdown.ts` and `web/markdown.tsx` render the Agent's Markdown as
  paragraphs, headings, lists, quotes, inline code, fenced code and http(s) links.
  No raw HTML is produced; unsafe link targets remain labels. An unclosed fence
  renders as code while it streams.
- The panel adds a caret on the live text and an elapsed time in the ending line.
  It follows new activity only while the person is at the end; scrolling up keeps
  the position and offers "New activity · Jump to latest". The composer's status
  line says new activity is below.
- A permission request is an amber "Needs your choice" card with the Agent's
  title, the reported command/path and only its offered choices. After the choice
  the turn keeps a line naming what the person chose.
- The plan's current entry (or `Plan · complete`) is visible above the composer;
  the full plan and usage remain one disclosure away. A failed turn offers
  "Ask again", which only returns the original words to the composer; it sends
  nothing.
- The conversation list names the Agent backend. Tool status is the Agent's own
  report and is labelled "Tool status"; the ACP path is labelled "Reported path",
  not Rho's independent file observation. Work progress keeps that separate
  observation and its hashes.

The public `conversation.read` schema now describes the bounded fields; all
existing records remain readable because the fields are optional. No new
operation, runtime, read path or automatic resend was added.

## Checks

- `npm run build` passed; `npm run check:contracts` passed (97 published
  operations; 96 typed).
- Rho `node --test test/*.test.mjs`: 202/202 passed, including the new
  presentation and Markdown checks. The first full run cancelled one test at its
  existing 30 s limit; two following full runs passed 202/202. Rho-plugins:
  89/89 passed.
- `npm run acceptance:agent-ui` passed seven checks in Chrome 155.0.8059.84:
  text grew in more than one visible piece before the turn ended; the read,
  command and write rows named their file/command; the plan followed the
  in-progress entry; the permission was shown, answered and retained; Markdown
  rendered; reading earlier lines was not interrupted and Jump to latest returned
  to the stream; no page errors. Evidence, peer log and screenshots are in
  `work/agent-ui-live-20261027/final-ui/`.
- `npm run acceptance:frontend` passed its 11 checks again, including the Agent
  panel draft and the link handoff. Evidence: `work/agent-ui-live-20261027/
  final-frontend/`.
- The real Claude turn completed. The retained record kept `Bash` with title and
  input `ls -la /private/tmp/…/project`, `Read input.txt`, and a Markdown answer
  with bold, a list, a fenced code block and inline code. The rendered panel at
  1440 and 390 CSS pixels is in `real-rendered-1440.png` and
  `real-rendered-390.png`; the record is `real-report.json`. No page errors.
- The controlled probe showed text appearing about 250–500 ms after a chunk was
  emitted, matching the service's 250 ms durable-write schedule. The follow check
  held a scrolled-up position while the newest activity continued and returned to
  the end only after the explicit choice.

## Limits and open questions

- Streaming is still a sequence of durable observations (up to about four per
  second), not a per-token channel. Reducing the write interval would multiply
  fsyncs of the conversation record; no separate live transport was added. Long
  replies can therefore look stepwise.
- Markdown support is a selected subset: no tables, images, nested lists or raw
  HTML. Links open external pages; the panel does not fetch them.
- Action titles, inputs and locations come from the Agent's ACP report. Rho's
  independent file observation, integrity and managed execution facts remain
  separate surfaces. The panel does not claim that an Agent action changed the
  bytes it names. A bounded command or path is now kept in the local conversation
  record as the Agent reported it, not only when a permission asked; it is not a
  diagnostics log and may contain whatever the Agent typed.
- The panel is still the 340 px inspector; the conversation header scrolls with
  its content, and there is no expanded conversation view. Long commands clamp to
  two lines and the full input is in the row's disclosure.
- These checks show the paths work. They do not establish that a person can scan
  a long trace, that the chosen action vocabulary is clear, or that four updates
  per second is enough for a long answer. Those need use with real work.
