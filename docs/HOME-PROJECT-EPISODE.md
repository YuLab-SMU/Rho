# Home, projects and empty project

Updated 2026-10-27.

## Question

The user supplied three reference screens (home with recent projects, the
new-project sheet over a blurred page, an empty project page) and asked to
optimize Rho's home, projects and empty-project screens against what the
application actually does. The reference supplied layout weight and hierarchy, not
values to copy: Rho has projects, workspaces, results, runs and Agents, and no
project kinds, descriptions or import action.

The questions this pass answered:

1. Does the projects list say something true and useful about each project instead
   of printing its absolute path?
2. Can a person with no projects, or a project with no work, see what to do next
   without reading a paragraph?
3. Does the page show where it is without repeating itself three times?

## Setup

Disposable services with a debug Core binary and real Chrome
(`/Applications/Google Chrome.app`, headless) at 1440, 1024, 768 and 390 CSS px.
The native folder window was replaced at its own boundary
(`NativeFolderPicker.prototype.choose`), the same way `ui-acceptance` does, so the
create-project flow ran through the real UI. Scripts and screenshots live under
`work/ui-review-20261027/` (ignored by Git):

- `capture.mjs` — three projects, the sheet and an empty project page.
- `capture-created.mjs` — a project created through the sheet from a source folder
  holding CSV/R files.
- `capture-populated.mjs` — question, workspace with three views, a registered
  table and the Files page.
- `check-interactions.mjs` — the six checks listed under Verification.

## Observed before

- Every project row printed the absolute path (`/private/tmp/rho-ui-fXpCCu/…`),
  including the service folder nobody needs to see.
- Home named the same list three times over (a sidebar switcher saying "Your
  projects", a topbar saying "Projects" and the page heading "Your projects") and
  carried a subtitle that added nothing.
- A created project's header said "1 source folder" without saying which folder.
- An empty project showed a large "Results" card with three lines of explanation, a
  "Recent activity" column reading "No runs yet.", and a shortcuts list that
  repeated the sidebar.
- The create-project sheet had no close control, no reason next to the disabled
  primary button, and a heavy unblurred backdrop.

## Changed

`web/home.tsx`, `web/overview.tsx`, `web/project.tsx`, `web/main.tsx`,
`web/theme.css`:

- **Home** — one heading, one primary action, a search field and one list card. Each
  row carries a project-coloured symbol, the name, the folder the work lives in
  (source folders counted when there are several, home as `~`, only the last
  segments shown, `…/` when shortened, the exact path in the tooltip) and when it
  was last opened. With no projects, a centred empty state with the two real
  starting actions.
- **Create project** — a close control, the chosen folders as rows with their own
  paths, "No folder chosen" while empty, and one line naming what is missing before
  the primary button can be used. The page behind is dimmed and blurred.
- **Project page** — a header that names the project and the folder its work comes
  from. A project with nothing recorded opens a centred empty state with "Work with
  Agent" and "Browse files" instead of empty sections. The activity column appears
  only when there are runs to report; the shortcuts that repeated the sidebar are
  gone.
- **Shell** — the topbar names the way back (`Projects / project / workspace`,
  collapsing to the current place below 768 px) and the sidebar keeps Project
  settings and Plugins together at its foot.

## Verification

- `npm run build` passed and Rho's 182 unit checks passed.
- `npm run acceptance:frontend` passed all 11 checks; screenshots in
  `work/ui-review-20261027/frontend/`.
- `npm run acceptance:pages` passed at four widths, with no overflow and no unnamed
  buttons on the new home, overview, settings and plugin screens.
- `npm run acceptance:shell` and `npm run acceptance:person` passed.
- `check-interactions.mjs` passed six checks: abbreviated locations with exact paths
  in tooltips, an emptied search that can be cleared, "Open a project…" landing
  focus on the first row, the sheet starting on its name field and returning focus
  to New project on Escape, a new project leading with its two next steps and no
  empty activity column, and the breadcrumb naming the project beside its section
  before returning to the list.
- `place-check.mjs` exercised the location line over nine path shapes — home
  directories, `/private/tmp` siblings, deep roots, a root directly under `/`, and
  1 and 2 source folders — after a first version printed a bare `~` for a folder one
  level below the home directory and the project's own name for a root folder.
- No browser page errors in any run.

These checks show that the paths work and that the screens read as intended to me.
They are not evidence that another person can follow them, and the visual judgments
are mine.

## Limits and next questions

- **A created project's Files page is empty.** `project.entries` lists the project
  root only, which for a project made from "New project" is an internal workspace
  folder; its source folders (`@<sourceId>/…`) are readable by the documents and
  files owners but are not listed by this call. A person who created a project from
  a folder of CSV files sees "This folder is empty." The cause is in the listing
  capability, not in these screens, so this pass only made the empty state lead with
  the Agent rather than with Files. Next: show source folders in the listing, then
  revisit what the empty state should offer first.
- Project colour is derived from the project identity and carries no meaning; it
  only helps the eye follow a project between the list and the sidebar.
- Nothing here establishes dark mode, print, or a second person's reading of the
  three screens.
