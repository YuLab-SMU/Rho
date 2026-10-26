# Browser application

Updated 2026-10-25. The frontend was reset at the user's request. Previous frontend
plans, visual specifications, Paper references and appearance rulers have been
removed from the working repository. Git retains their history; they do not govern
this implementation. This document describes the current application, not another
prescriptive design system. How it changes next is decided by reviewing real runs
([Development](DEVELOPMENT.md#stages)); the current
[base-R review](BASE-R-EPISODE.md#review-of-the-2026-10-25-run) records what the
screens do not yet show.

## Starting from the work

A person needs to find a project, work on its contents, ask an Agent for help and
inspect what happened. The application gives those actions direct places:

- **Projects** lists and searches available projects, opens folders and creates a
  named project from selected source folders.
- **Overview** opens existing workspaces and recorded results, with recent runs.
- **Files** opens documents, browses source folders and filters the current folder.
- **Activity** opens actual execution records, output, repair context and exports.
- **Project settings** manages source folders and explicitly checks available tools.
- **Workspaces** hold real owner views in tabs and splits. Arrange views exposes
  split, move, close and undo operations; the command palette offers the same actions.
- **Agent** opens on request. It contains a request draft, sessions and, in an open
  workspace, the Agent's recorded work and linked questions. The current integration
  uses an external Agent: copying a request is not sending it or receiving a reply.

The sidebar and optional inspector adapt to available space. Narrow screens show
one workspace view at a time. Closing a panel does not cancel work.

## State and code

`web/main.tsx` owns navigation and session observation. `web/home.tsx` handles project
entry, `web/overview.tsx` the project sections, and `web/plugins.tsx` the installed
capability catalog. `web/shell/` renders the persisted composition tree and embeds
registered owner views. `web/agents.tsx` handles the explicit external-Agent handoff.

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

The palette and responsive dialogs use native dialog focus containment and Escape.
Typography, color and layout are implemented in the three CSS files under `web/`.
These are current implementation values, not an accepted design system; they change
when a reviewed result calls for it. The shared CSS variable interface lets owner
views use the application's colors.

## Verification

`npm run acceptance:frontend` exercises the application using disposable projects,
real R output and the installed Chrome executable. It records screenshots of the
project entry, overview, files, table, figure, activity, settings, plugins and Agent
panel. Its assertions cover navigation, editing and undo, clipboard handoff,
conditional layout changes, reload, keyboard input, responsive overflow and accessible
control names. The report and images go to `work/frontend-reset/browser/` by default.

`npm run acceptance:base-r` runs the complete selected-row question, external Agent
edit, real R execution, two-version comparison and browser-disconnection episode.
It requires the configured Claude Code client and never substitutes a simulated
model. Its [record](BASE-R-EPISODE.md) separates fresh execution from browser-only
continuation and independent aggregate checks from scientific review.

Action, object, shell, document and continuity suites exercise the existing owner
behavior through the rebuilt UI. Only executed checks in [Status](STATUS.md) are
current evidence. Historical component and installed-package results do not accept
this new frontend automatically. Native physical IME behavior and human usability
require their own evidence. This change does not implement a Project Notebook owner,
a built-in model conversation, native desktop windows or a registry release.
Functional browser evidence shows that paths work, not that the screens can be read;
the [base-R review](BASE-R-EPISODE.md#review-of-the-2026-10-25-run) records where
they cannot.
