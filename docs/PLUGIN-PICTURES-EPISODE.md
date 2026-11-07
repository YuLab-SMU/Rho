# Seeing what a plugin looks like

Observed on 2026-11-07, macOS arm64, Node 22.22.3 and Chrome 156.0.8078.81.
Source after Rho 0.5.6 and the [plugin disclosure](PLUGIN-DISCLOSURE-EPISODE.md)
episode, selecting Agent 0.4.33. No npm release or change to the person's running
Rho is part of this episode.

## Question and first observation

After the disclosure pass the person reviewed the Plugins page and reported three
problems in their own words:

1. The page did not show what a plugin's UI looks like.
2. It did not say whether a plugin is reached as a UI, a CLI or something else.
3. The one third-party example looked very poor.

The retained screenshots from the disclosure episode confirm each point:

- A view was a row of text: display name, description, component identity, package
  and "In this browser build". Nothing showed the view itself. The catalog cards
  showed an icon and the line "N views · N Skills · N operations".
- Views, Skills and operations were counted, but no entry said how a plugin is
  reached. Documents' native Claude Code Skill and hook sat in a collapsed section.
  The Agent package links three command-line programs, and no page mentioned them.
- The independent package sat above the built-in plugins, unstyled. Its view was a
  bare serif `<h1>` in a fixed 570 px white frame. Its buttons used generic borders,
  and the generated `view.html` template was an unlabelled form in system serif.

## Causes

- No picture of any view existed, and the page had no way to mount a view. The
  views already render in Studio and the file preview from real project files.
- The kind of an entry was implicit. The owner declarations already separate
  components, operations, Skills, native `claudeCode` entries and the shared MCP
  descriptor. A package's command-line programs live only in its `package.json`
  `bin`, which the listing did not read.
- The third-party section kept its first-draft CSS with fallback colours, and its
  frame had a fixed height. The template the CLI generates had no design at all.

## Changes

**Kinds.** `pluginKinds` derives chips from declared or installed entries only:
UI with its view count, or the owner's note (Rho page, In other views, No view);
MCP tools; Skills; Claude Code; MCP server; CLI. The catalog listing now records
`cli`, the commands an installed package links, read from its own manifest. The
plugin's package version comes from the same read. Cards, the detail heading and
Information's "Reached by" row show the chips. A third-party card shows UI, MCP
tools and Skills from its manifest.

**Pictures.** `scripts/plugin-previews.mjs` starts this checkout's service on the
shipped PA14 project, opens each view through the page's own "Show it here", and
keeps what Chrome drew. `web/previews/index.json` records each picture's component
and version, its package, the file it shows and the capture time. A picture is only
matched to the same component version. A card leads with the first pictured view.
A view row shows its picture and the file it was pictured with.

**Live views.** "Show it here" mounts the actual owner view, as Studio does, on a
real file of the open project chosen by the view's declared binding. Code opens in
the editor, Markdown in the reader, a CSV in the table. A plot uses a table the
Agent registered with a key, and its column pickers choose the two numeric columns.
The Value view shows the first value a live session holds. A view whose content
the Agent supplies, or that opens from a review, says so instead of mounting. The
bar says that what a person does there is real.

**Third-party plugins.** The section follows the built-in plugins. Each package has
a mark, its state, kind chips, its source and labelled rows that name each view's
and Skill's file. An opened view sits in a captioned panel. The frame follows its
page's height from 200 to 900 px. Remove is marked as destructive. The page that
`rho plugin create` generates has a heading, a labelled field, a result area, a
visible failure state and a note on where the reply comes from. The disclosure
fixture's two views are now small styled pages.

The service also serves `.png` build assets, which the pictures need.

## What the browser showed and what changed because of it

| Observation | Cause and change |
| --- | --- |
| The first scatter capture was an owner error: "Entity interaction requires an explicit unique key and namespace" | The plot needs a keyed table. It now looks only for a registered table with a key. The capture registers the swarming dishes with `dish` as a string key, as an Agent would |
| With a key, the plot drew strain against replicate, a grid of dots | The first two numeric columns are not a choice. Column pickers were added; the capture picks colony area against circularity |
| Variables, Plots and Data flow pictured only their empty states | No live session existed. With `RHO_CORE_BINARY`, the capture runs two R cells: read the dishes, draw a box plot |
| Value said "Value is not in the session" | It was mounted without a name. It now shows the session's first value, `sw` |
| Agent note was an empty frame | Its required text comes from the Agent. Such views now explain instead of mounting |
| Table and media pictures named `.rho/plugins/restored/…` paths | Registered results were preferred. Project files now come first |
| A card picture's code was unreadable at card size | The picture is shown at 130 % from the top left |

The final capture pictured 11 of 15 declared views:

| View | Pictured with |
| --- | --- |
| Editor | `analysis/rnaseq_differential_expression.R` |
| Markdown | `project-notes.md` |
| Table | `results/rnaseq_de_summary.csv` |
| Media | `results/rnaseq_differential_expression.png` |
| Scatter | `data/swarming/single_cultures.csv`, circularity against area |
| Notebook, Variables, Plots, Data flow, Servers | The project's sessions and cells |
| Value | `sw` in R |

Four have no picture. The example has no HTML page for the HTML reader. R's
`rho.object` 0.2.0 is not in this browser build. Feedback opens from a review, and
Agent note carries the Agent's own text.

## Verification

```sh
npm run build
RHO_CORE_BINARY=/absolute/selected/rho-core node scripts/plugin-previews.mjs
npm run build:web
RHO_CORE_BINARY=/absolute/selected/rho-core node --test \
  test/plugin-presentation.test.mjs test/mcp.test.mjs \
  test/layered-mcp.test.mjs test/extensions.test.mjs \
  test/entry-contracts.test.mjs test/contract-coverage.test.mjs \
  test/protocol.test.mjs test/validate.test.mjs
npm run check:contracts
node scripts/plugin-ui-acceptance.mjs
node scripts/plugin-disclosure-acceptance.mjs
```

- The focused suite passed 27/27, including a new test of kinds and view subjects.
  It covers the Agent's three linked commands and a package with no manifest.
- The served contract and generated types are current.
- The owner catalog check passed for all 12 owners at five widths, with zero Host
  starts and native dispatches.
- The disclosure check passed its seven flows on the restyled third-party section.
- The capture passed. A live table opened at 1440 and 390 px with no sideways
  scrolling. Its R session used the Core debug build at `8bed8ef` and R 4.5.2.
- A generated package was installed and opened in Chrome. Its page greeted
  "Hello, World!", and its frame measured 384 px.

Screenshots and reports are under `work/plugin-previews/`, `work/plugin-ui/after-4/`,
`work/plugin-disclosure/after-4/` and `work/template-check/`. The pictures in
`web/previews/` total 552 KB and are part of the browser build.

## Limits

The pictures show the example project at capture time, not the person's data. They
must be recaptured when a view changes; an unmatched version shows no picture.
Third-party packages have no pictures; their pages open live. The
[semantic figures](SEMANTIC-FIGURES-EPISODE.md) episode drives the same frame. Its
selectors were read against this change, but its R episode was not rerun. These
checks show the paths work and the screens were read; they do not show that another
researcher understands the page without help.
