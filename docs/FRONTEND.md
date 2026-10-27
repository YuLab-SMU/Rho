# Browser application

Updated 2026-10-27. The frontend was reset at the user's request. Previous frontend
plans, visual specifications, Paper references and appearance rulers have been
removed from the working repository. Git retains their history; they do not govern
this implementation. This document describes the current application, not another
prescriptive design system. How it changes next is decided by reviewing real runs
([Development](DEVELOPMENT.md#stages)); the current
[base-R review](BASE-R-EPISODE.md#review-of-the-2026-10-25-run) records what the
screens do not yet show. Avoid unnecessary secondary labels and descriptions: let the
layout do the explaining.

## Starting from the work

A person needs to find a project, work on its contents, ask an Agent for help and
inspect what happened. The application gives those actions direct places:

- **Projects** lists and searches available projects, names the folder each one works
  in, opens folders and creates a named project from selected source folders. It
  opens as one list with one primary action, and with no projects it shows what can
  be started instead of an empty page.
- **Overview** opens existing workspaces and recorded results, with recent runs when
  there are any. A project with nothing recorded yet shows its two next steps —
  work with the Agent or browse its files — rather than empty sections, leading with
  whichever one the project's listing says has something behind it.
- **Files** opens documents, browses the project's folder and the source folders it
  works in, and filters the current folder. A source folder is named as the person
  named it and opens one level at a time, the same way any other folder does.
- **Activity** opens actual execution records, output, repair context and exports.
  It also shows the selected Core-backed Claude Code/dsh activity streams, native
  errors and observed output files. The [activity episode](AGENT-ACTIVITY.md)
  describes attachment, bounded polling, reconnect and exact output snapshots.
- **Project settings** manages source folders and explicitly checks available tools.
- **Workspaces** hold real owner views in tabs and splits. Arrange views exposes
  split, move, close and undo operations; the command palette offers the same actions.
- **Agent** opens on request. In a tab on this machine it holds conversations with
  Claude Code or Codex started in Rho: select one for a new conversation, follow its streaming
  reply and its actions, reply, stop its turn and return to it after a reload
  ([conversation episode](CONVERSATION-EPISODE.md)). The panel renders the retained
  record rather than protocol events: the Agent's Markdown is prose, lists and code;
  each tool step names what it did (`Read data.csv`, `Ran Rscript analysis.R`,
  `Wrote results/summary.csv`, `Called data.page`) with the Agent's title and reported
  path behind a disclosure; short runs stay visible and longer ones fold into what
  they accomplished. The current plan entry sits above the composer, a native
  permission request is an amber choice card, and an answered choice stays in the
  turn. New activity is followed only while the person is at the end; scrolling up
  keeps the position and offers "Jump to latest". The Agent's tool status and
  reported path are distinct from Work progress's independently observed files.
  Sessions started elsewhere are listed with where to continue them. In an open
  workspace it also shows the Agent's recorded work and linked questions. A tab
  opened from a narrower link keeps a request draft for an external Agent: copying a
  request is not sending it or receiving a reply. The [live activity
  episode](AGENT-UI-EPISODE.md) records the observations, checks and limits.

The topbar names the way back — the projects list, then the project, then the open
workspace — and keeps only the current place below 768 CSS px. Project settings and
Plugins sit together at the foot of the project sidebar. The sidebar and optional
inspector adapt to available space. Narrow screens show one workspace view at a time.
Closing a panel does not cancel work.

The [home and project episode](HOME-PROJECT-EPISODE.md) records the 2026-10-27 pass
over these screens, its checks and the listing gap it left open.

## State and code

`web/main.tsx` owns navigation and session observation. `web/home.tsx` handles project
entry, `web/overview.tsx` the project sections, and `web/plugins.tsx` the installed
capability catalog. `web/shell/` renders the persisted composition tree and embeds
registered owner views. `web/agents.tsx` handles the explicit external-Agent handoff and the session list;
`web/conversation.tsx` shows a conversation started in Rho. Its presentation comes
from `src/conversation-presentation.ts` (text, action lines, folded runs, plan entry),
and Agent prose is rendered by `src/agent-markdown.ts` with `web/markdown.tsx`.
`web/work-progress.tsx` reads `project.work.read` for the local person's project
Overview: Agent-reported plans/usage, retained native source identities and current
referenced files. It links back to the original conversation or Activity view.
Shared notes opens `project-notes.md` in the existing Documents owner; saving is
explicit before asking Agent to read it. A failed work read keeps the previous
view and offers Refresh. The cursor invalidates the read model; individual sources
and resources retain their own versions. See the [observed loop](ACP-EPISODE.md#shared-workspace-loop).
External ACP sessions use the same work surface with their own source identity,
plans, usage and read-only latest reply. Their input and permission choices stay
in the original client. The visible Overview rereads external projections every
1.5 seconds; it does not start a collector, Agent or Host. Turn cancellation keeps
unfinished tool outcomes unknown and does not claim all native processes exited.

The browser calls the existing `BrowserClient` contract. Document content, undo,
conditional save, execution identity, output and versions remain with their existing
owners. Views of the same document do not acquire independent document buffers.
Opening exact results uses both resource identity and version. Reconnect only reads.

A linked result initially opens as a local view. When the person arranges it, Rho
includes that exact descriptor in the same conditional composition write as the
split or move. The original view and its selection retain their own version;
reload restores the saved arrangement. No unrelated preview is saved with it.
The [base-R episode](BASE-R-EPISODE.md) exercises this path with a real Agent reply.

Opening the service URL on this machine is the access: the tab starts as the local
person, so there is no link to redeem, no session credential in tab storage and no
first screen asking for one. A deliberately narrower link (`rho --pair`, one folder
or an expiring tab) still arrives as a one-time code in the fragment; the page
redeems it, keeps that credential only in this tab's session storage, and says when
the link could not be used. A tab that falls back to this machine keeps its open
projects, unsaved edits and running work: leaving a link forgets a credential, it
does not close a view or submit anything.

A request draft is scoped to the project and to the principal using the tab in
session storage. It is local preparation, not a saved project document or Agent
message. Using this machine's access instead of a link forgets only that link's
credential. The existing Documents editor owns acknowledged document recovery; a
view change makes no new save claim.

A conversation's messages, steps and endings belong to the service's record, not to
the tab. The tab keeps only an unsent message per conversation and the identity of
a message being sent. When the reply to a send is lost, Retry sends that same message
once; when the service refuses it, the words go back into the box. A session started
elsewhere has no message box in Rho: its input stays in its own window.

The palette and responsive dialogs use native dialog focus containment and Escape.
Typography, color and layout are implemented in the three CSS files under `web/`.
These are current implementation values, not an accepted design system; they change
when a reviewed result calls for it. The shared CSS variable interface lets owner
views use the application's colors.

## Verification

`npm run acceptance:frontend` exercises the application using disposable projects,
real R output and the installed Chrome executable. It records screenshots of the
project entry, overview, files, table, figure, activity, settings, plugins and Agent
panel. Its assertions cover navigation, editing and undo, an unsent conversation message,
the clipboard handoff in a link tab,
conditional layout changes, reload, keyboard input, responsive overflow and accessible
control names. The report and images go to `work/frontend-reset/browser/` by default.

`npm run acceptance:agent-ui` drives a controlled ACP peer through the real service
and Chrome; it uses no model credentials. It checks that reply text arrives in more
than one visible piece, that read/command/write actions name their target while they
run, that the plan line follows the entry in progress, that a native permission is
shown, answered and retained, that the Agent's Markdown renders, and that reading
earlier lines is not interrupted by new activity. Evidence and screenshots go to
`work/agent-ui-acceptance/` by default.

`npm run acceptance:base-r` runs the complete selected-row question, external Agent
edit, real R execution, two-version comparison and browser-disconnection episode.
It requires the configured Claude Code client and never substitutes a simulated
model. Its [record](BASE-R-EPISODE.md) separates fresh execution from browser-only
continuation and independent aggregate checks from scientific review.

Action, object, shell, document and continuity suites exercise the existing owner
behavior through the rebuilt UI. Only executed checks in [Status](STATUS.md) are
current evidence. Historical component and installed-package results do not accept
this new frontend automatically. Native physical IME behavior and human usability
require their own evidence. The frontend reset did not implement a Project Notebook
owner, native desktop windows or a registry release.
Functional browser evidence shows that paths work, not that the screens can be read;
the [base-R review](BASE-R-EPISODE.md#review-of-the-2026-10-25-run) records where
they cannot.

`node scripts/conversation-episode.mjs` drives the conversation episode with the
configured Claude Code. It stops only when a step cannot be performed; the reviews
in its [record](CONVERSATION-EPISODE.md) judge what its screenshots show.
