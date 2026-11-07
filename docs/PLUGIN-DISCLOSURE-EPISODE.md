# Discovering plugin entries

Observed on 2026-11-07, macOS arm64, Node 22.22.3 and Chrome 156.0.8078.81.
Source after Rho 0.5.6, selecting Agent 0.4.33. No npm release or change to the
person's running Rho is part of this episode.

## Question and first observation

The person could not tell which special UI, Skills and MCP capabilities their
plugins provided, or whether those entries were recorded systematically.
The first run opened Documents, Notebook and Agent in a disposable project.

The owners already supplied `plugin.operations`, `plugin.components` and
digest-bound `plugin.skills`. The application did not expose that record fully:

- A Skill had a one-line summary and no way to read its instructions.
- The view list followed the example prompts and the entire operation list.
  UI extension views did not identify their own package and version.
- Entries without optional presentation copy were silently hidden. Several real
  operations had no such copy; grouping also concealed exact method identities.
- The descriptive build inventory listed ten owners while the application
  selected twelve. Notebook and project Skills lost their descriptions when
  unselected.
- Documents' native Skill and edit hook were declared but absent from its page.
  The shared MCP tools had no descriptor; their actual list lived in the server.
- An independent package's Guide button read only its first Skill. Its other
  views were accessible only through a selector after opening the first view.
- Rho's own cross-plugin Skills, including `rho.analysis-run`, were not listed
  in a human-readable catalog. The project's Skills page has a different owner.

## Owner changes and current record

Agent 0.4.33 supplies `plugin.agent.mcp`: the export, transport, tool names and
descriptions of its shared MCP entry. The server and this metadata use the same
`mcp-entry.ts` declaration. No transport, tool schema or execution behavior changed.

Rho's `src/plugin-inventory.ts` projects each owner's declarations into a
content-free listing. The same function supplies the live catalog and
`dist/plugin-inventory.json`; its build iterates the actual `pluginIds` selection.
The record includes operation identities/effects, action identities, component
identities/versions/bindings, Skill metadata and native Claude Code integrations.
The package version is recorded separately from the capability descriptor's
version. Registered browser views also name their selected UI package/version.

`capability.list` and `observation.snapshot.catalog` carry this information.
Descriptions of absent owners do not import them, add grants, expose their Skill
content or make their operations callable. `skill.read` still checks the calling
tab and expected digest. Workspace Skills now carry explicit `rho` ownership;
plugin Skills keep their plugin owner. Project Skills remain project files.

Independent packages retain their existing `rho-plugin.json` declaration.
`extension.list` is a small summary, so the page reads each installed descriptor
through `extension.describe` before showing its entries. Opening an entry uses
that selected package digest. The page never invokes an operation to describe it.

## Browser result and review

The catalog now searches owner copy, UI and package identities, Skill names and
intents, operation names and native integration metadata. Cards show entry counts.
Details lead with views and their sources, then readable Skills, examples and
operations. The page preserves raw identities when display copy is absent.
The operation section explains the shared MCP bridge and shows exact contracts;
its access labels describe this browser tab, not another Agent's grant.

The reviewed results were:

| Episode | Observation |
| --- | --- |
| Search `data flow` | Finds Notebook and exposes all six views, including Servers and Value |
| Documents | Shows Editor, Markdown and HTML page with their own packages; native Skill and `PreToolUse` hook are visible |
| Skill read failure | The injected error remains visible; Try again reads exactly the owner content for the listed digest |
| Search `rho.analysis-run` | Finds the application Skill and reads it without assigning it to Notebook or project Skills |
| Independent package | Both Skills, both real HTML views and its operation schemas are reachable; Chinese text and emoji survive |
| Notebook disabled or unselected | All six view descriptions and its Skill identity remain; reading the unavailable Skill is disabled; the unselected owner is not imported |
| Widths | Documents was inspected at 1440, 1024, 768 and 390 CSS px; independent Skill content was also inspected at 390 px |

The first independent-package trial exposed a wrong assumption: `extension.list`
contains summaries, not manifests. Reading the actual descriptors fixed the blank
catalog. A second review found a package digest clipped at 390 px; it now wraps.
The final screenshots show separate view and Skill rows, readable package names
and intact controls. Long instruction/contract bodies scroll within their boxes.

This observes discoverability and behavior for the tested flows. It does not
establish that another researcher understands the capabilities without help.
Owners without display copy retain raw names rather than invented descriptions.
Standalone view counts do not count shell pages or asset packages: Console and
project Skills are presented by Rho, while Agent icons supplies assets. Entry
descriptions do not establish domain correctness or a successful verification run.

## Verification and retained evidence

```sh
npm run build
RHO_CORE_BINARY=/absolute/selected/rho-core node --test \
  test/plugin-presentation.test.mjs test/mcp.test.mjs \
  test/layered-mcp.test.mjs test/extensions.test.mjs \
  test/entry-contracts.test.mjs test/contract-coverage.test.mjs \
  test/protocol.test.mjs test/validate.test.mjs
node scripts/plugin-ui-acceptance.mjs
node scripts/plugin-disclosure-acceptance.mjs
```

The focused suite passed 26/26. The owner catalog browser check passed for all
twelve owners and its five widths, copy/fallback and missing-tool cases, with
zero Host starts or native dispatches. The disclosure check passed its seven
flows above: no live language session, managed run, Host or independent host
operation was started. Agent's three existing intent/unreachable-MCP regressions
also passed. The first MCP test invocation lacked an explicit Core selection and
failed before managed delivery; selecting the existing public binary passed.
No Cargo build or Core source change was needed.

Local screenshots and reports are retained under `work/plugin-disclosure/`
(`before-*.png`, `after/report.json`, `after/*.png`) and the directory printed by
the owner UI check. Early runs failed at fixture packaging, response validation
and test setup; those attempts are not counted as passes. Builds retain their existing bundle-size
and browser-externalized-Node warnings. Independent usability, installed npm
delivery and other operating systems were not retested by this episode.
