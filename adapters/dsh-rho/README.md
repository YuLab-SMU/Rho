# dsh-rho prototype

Analyse in DeepSeek Harness, inspect tables and figures in its **Rho** tab, select
rows, and ask a question in the same conversation. **Add question to chat** puts
the question and captured result context into the native draft; **Send** remains
the normal dsh action. Existing draft text is preserved. A concurrent draft edit
refuses insertion and lets the person try again.

This local prototype targets dsh **0.2.1-rc.5**, Node **22.22.x**, Python 3 and
macOS/POSIX writer locking. It is not a published npm package or a signed Rho
release. The [episode](../../docs/DSH-RHO-EPISODE.md) records the real run and its
limits.

## Build and install

Start from a prepared Rho checkout with its selected sibling Rho-plugins packages
built and installed. From the Rho repository:

```sh
npm --prefix adapters/dsh-rho ci --ignore-scripts
npm --prefix adapters/dsh-rho run build
npm --prefix adapters/dsh-rho run check
npm --prefix adapters/dsh-rho test
mkdir -p work/dsh-rho/package
npm pack ./adapters/dsh-rho --ignore-scripts --pack-destination "$PWD/work/dsh-rho/package"
```

The tarball bundles the selected Files, Tables, Media and Contracts code, the
unchanged TableView and MediaView, and their required browser dependencies. React
comes from dsh's client runtime. `lib/composition.json` records source commits,
trees, local overrides, selected component versions, build input digests and
bundle digests. Third-party licenses accompany the bundle.

Use an isolated Harness home for the prototype. Select one existing project and
an archive outside it; both paths must be absolute, and the archive path canonical.
Replace the example project and tarball paths below:

```sh
export DSH_HOME="$HOME/.dsh-rho-prototype"
export RHO_DSH_PROJECT="/absolute/path/to/analysis-project"
mkdir -p "$DSH_HOME/rho-results"
export RHO_DSH_STATE="$(cd "$DSH_HOME/rho-results" && pwd -P)"
dsh plugin --profile web add /absolute/path/to/dsh-rho-0.0.1.tgz --ignore-scripts
dsh --profile web --no-open
```

Open the local address dsh prints, configure the provider through dsh, and select
the **same project folder** as a workspace. An existing dsh profile can retain a
different workspace even when launched from the project directory. Sessions in
other folders cannot access this archive. Keep the two `RHO_DSH_*` variables when
restarting. The ordinary Plugins page manages the installed bundle.

## Try the flow

Give dsh a small analysis task and ask it to call `rho_present` on its outputs.
For a CSV, the tool needs the columns in header order and their explicit types:

```json
{
  "path": "outputs/summary.csv",
  "title": "Group means",
  "columns": [
    { "name": "group", "type": "string" },
    { "name": "n", "type": "number" },
    { "name": "mean", "type": "number" }
  ],
  "key": "group"
}
```

For a figure, use its project-relative path and title. PNG, JPEG and SVG are
supported. Open **Rho**, choose a result, select rows in a keyed table, enter a
question and click **Add question to chat**. Review and send the native draft.

A table key must be a unique, nonempty string column. Without a key the table is
readable; a whole-table question includes at most ten preview rows and the total
row count. Figure questions include the captured reference and path, not image
pixels. Row questions include the exact selected values, identity, version and
capture time. They do not silently substitute a newer file on disk.

## Ownership and limits

dsh owns the Agent, model, tools, permissions, execution and conversation history.
`rho_present` only captures completed files. This Rho adapter owns the selected
composition, per-session result list and transient selection. Rho-plugins owns
file integrity, table parsing/key meaning and the actual table/figure views. Core,
the Rho service and a second Agent are not started. Closing a view or refreshing
does not run analysis. Repeating an original tool call returns its retained result;
reusing that call identity for different input is refused.

One archive has one writer. Its lock releases when that process exits, including
a crash. The archive must not overlap the analysis project. Ordinary project
files only are accepted; traversal, internal state and symbolic links are refused.

| Protected resource | Config key / default ceiling | When exceeded |
| --- | --- | --- |
| Archived sessions | `maxSessions`: 32 | Refuse a new session archive |
| Results per session | `maxResults`: 64 | Refuse a new result; retain earlier versions |
| One captured file | `maxFileBytes`: 8 MiB | Refuse capture |
| Captured bytes per session | `maxStoredBytes`: 64 MiB | Refuse capture; retain earlier bytes |
| Table rows | `maxRows`: 20,000 | Refuse table reading/presentation |
| Rows in a question | `maxSelectedRows`: 20 | Ask for fewer rows |
| Question plus context | `maxQuestionBytes`: 24 KiB | Refuse insertion; preserve draft and results |

The plugin entry's optional `limits` object can lower these ceilings. Table pages
are bounded to 1,000 rows, file reads to 64 KiB, HTTP JSON requests to 32 KiB,
columns to 50 and question text to 2,000 characters. Limits refuse work rather than
silently truncate a selected question. Parsing still reads a bounded file in
memory; these are application budgets, not OS memory or CPU quotas. Invalid table
content can leave a captured but unlisted file within the archive budget.

This prototype has no general Studio layout, notebook, live R/Python value
inspection, persisted/shared row selection, multi-project archive, or automatic
discovery of outputs. The dsh release candidate's interfaces and the React runtime
composition need rechecking before supporting another version. Browser inspection
and scripted runs are not independent usability evidence.
