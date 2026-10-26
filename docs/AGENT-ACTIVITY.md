# Agent activity in Rho

The project **Activity** page shows selected Claude Code and dsh observations
retained by Core. The **Agent** panel's **View live activity** button opens the
same page. It shows tool requests, corresponding returns, refusals, native exit
codes and output files. External sessions keep their input in their original
window; opening this view sends no message and starts no Agent or Host.

## Connect an existing session

Select an activity-capable Core build and the Agent collector described in
[the owner guide](https://github.com/YuLab-SMU/Rho-plugins/blob/main/examples/agent-observation/README.md).
The application selects Agent 0.4.7 and Tables 0.4.3. Core state format 4 is
required for this stream; old state is refused intact. Do not replace an existing
project's Host or remove its state to make the view connect.

The selected owner source is [Plugins 0a755161](https://github.com/YuLab-SMU/Rho-plugins/commit/0a7551617299f6c7464c79a5e1904ac7d2d32df2),
with unchanged [Core 4f5bed86](https://github.com/YuLab-SMU/Rho-core/commit/4f5bed8631e15acad44cc86b63ea4779ab8af342).

Rho reads the project's existing `.rho/host.sock`, in the fixed Core caller
namespace `rho-agent-observe`. The operator attaches a collector to that same
Host and selects one exact native session:

```sh
rho-agent-observe collect \
  --core /absolute/rho-core \
  --socket /absolute/project/.rho/host.sock \
  --caller rho-agent-observe --stream analysis-session \
  --producer claude --project /absolute/project \
  --session NATIVE_SESSION_ID --source /absolute/session.jsonl \
  --watch-seconds 3600
```

For dsh, choose `--producer dsh`, its session storage root for `--source`, and the
installed dsh `package.json` with `--dsh-package`. The collector uses dsh's native
read-only persistence API. Native dependencies remain optional. The directory
and session are explicit selections; this feature does not scan every session
on the machine. Reusing a stream requires its original source and normalization.

The default captures bounded command/path metadata, call identities and error
facts. `--content` additionally captures bounded tool details after best-effort
redaction. It is an operator choice, not a browser switch. Reasoning is excluded.
The browser shows captured result details when present and says when they were
not captured. Redaction is not a universal secret detector.

Rho's existing [execution bridge](EXECUTION.md#host-lifetime) governs Host
ownership. A fresh disposable project's Host can be started explicitly with
`rho-core serve --project /absolute/project --state-dir /absolute/project/.rho`.
An observation-only Host has no R executor; managed R actions need the selected
R executor under the existing lifecycle contract.

## Reading and opening results

Choose a session in Activity. The view polls retained activity every 1.5 seconds
while open. Its connection label describes the observation store, not whether
the external Agent or collector is alive. The last receipt time remains visible.
A request with no observed return says **Awaiting result**. A successful tool
envelope and a nonzero process exit remain separate facts; dsh can report both.

On a connection failure the view stops polling and keeps its received actions.
**Reconnect activity** reads the same stream after its existing cursor. It does
not start a Host, restart a collector, submit work or resume a model. Reload can
rebuild the view from Core when that Host is available. Closing the page releases
its timers and requests only.

The **Outputs** section observes a chosen project subfolder, initially `outputs`,
every five seconds. It shows current paths, byte counts and SHA-256 prefixes.
These files are not automatically attributed to a tool call or declared complete.
**Open** checks the exact observed digest and imports a snapshot through Files.
Tables opens CSV with every value preserved as text and no invented entity key;
Media opens the selected image. Other text files use the live Documents editor,
without a captured-version claim. PDF preview is not available here. An updated output
requires refreshing its observation. Previously captured versions remain readable.
The snapshot source line says **producer unconfirmed**.

Opening a snapshot inserts an exact resource/version into `observed-outputs`
through the existing conditional composition API. A stale layout is refused;
existing protected views are not replaced. Reload retains both output views,
using the workspace's existing initial-tab behavior. Selecting the figure tab
reopens the saved version without running the analysis.

## Boundaries and limits

- Rho supplies authentication, project scope, the selected Core transport and
  layout. Agent owns normalization, projection and the activity view. Tables owns
  lexical CSV declarations. Files owns captured bytes; Media owns image display.
- Three owner operations, `agent.activity.read`, `agent.activity.outputs` and
  `agent.activity.capture`, use the normal scoped HTTP contract. Browser scope
  includes them. They are excluded from default Agent grants, which still fit
  the existing 64-method profile. No browser can select another Core caller.
- A read page is at most 128 events / 256 KiB; the view retains a suffix of at
  most 256 events / 1 MiB serialized JSON. Core gaps and view eviction are visible.
  Missing request/return evidence stays incomplete. These are serialized budgets,
  not an OS heap guarantee.
- Output scans retain the owner's limits: 64 files, 256 directory entries,
  depth 4 and 8 MiB per file. Symlinks are skipped or refused. Internal `.rho`
  and `.git` paths and parent traversal are refused. Scan failures preserve the
  previous displayed observation; changing folders clears the previous folder.
- Core history, collector progress, artifact integrity, execution and scientific
  interpretation remain separate. Workspace archives do not archive the native
  Agent session or this Core activity stream. No native execution deduplication,
  universal monitoring, model understanding or scientific validity is claimed.

## Real episode and review

Run from the source checkout with the selected clients and gateway configuration:

```sh
RHO_CORE_BINARY=/absolute/rho-core npm run acceptance:agent-activity
```

The harness creates disposable projects and private client configurations. Both
clients explicitly select `westlakehpc/deepseek-v4.1-flash`. Each reads a six-row
CSV, fixes integer division in a Python group mean, then executes the analysis
once. An explicit fixture gate lets the browser observe the pending request.
The harness stops its collector and kills only its owned Host; the original
Agent continues, writes CSV/SVG and exits the tool with diagnostic code 7.
Reattachment backfills that same session. Browser checks open the actual table
and figure, inspect 1440/390-pixel widths and reopen retained views after reload.
An independent calculation checks the two means, 11/3 and 8/3. These arithmetic
checks do not establish a scientific method or human usability.

Iteration evidence is retained under `work/agent-activity/`:

| Run | Observed result and decision |
| --- | --- |
| 1, Claude | Live pending, Host loss, error and recovery worked. A test treated an overflow boolean as an array and stopped. The screen buried outputs beneath the action list; the view now places outputs alongside a bounded scrolling list on a wide screen. |
| 2, Claude | The model added a shell suffix, received a native permission refusal and did not execute the analysis. The fixture timed out. The test prompt now explicitly requires the exact command. |
| 3, Claude | Live/recovery/error checks passed. Opening exposed an invalid workspace ID containing a space. Rho now uses `observed-outputs`. |
| 4, dsh | Live/recovery/error checks and actual table opening worked; an obsolete `.ag-body` selector stopped the harness. It now reads the actual grid root. |
| 5, dsh | The table and decoded SVG opened. Reload restored both tabs but selected the first, the existing workspace behavior. The check now explicitly reopens the retained figure tab rather than asserting an unimplemented active-tab restore. |
| 6, both | Both full flows passed: pending calls, retained actions during disconnection, same-session recovery, diagnostic exit 7, table/image opening and reload. Each analysis ran once; repeat collection appended zero events. |

Visual review of run 6 covered pending/empty outputs, disconnected actions,
recovered errors, the table and decoded SVG at 1440 pixels, plus actions and
outputs at 390 pixels. Commands and errors remain readable, the narrow view
stacks outputs below the bounded action list, and the two output controls are
reachable without horizontal overflow. This is a visual inspection, separate
from browser assertions and human usability evidence. A final review corrected
the text-file snapshot wording and refuses unsupported PDF preview explicitly.
After rebuilding those changes, both retained real sessions passed a browser
continuation: errors remained visible, CSV/SVG reopened, repeated Open kept two
views, PDF was refused, and each original analysis still had one invocation.
`work/agent-activity/final-browser-review.json` records this later build separately
from run 6. The rebuilt owner suite passed 76/76; scoped HTTP and ledger checks
passed 3/3. One attempted owner check had used stale compiled files before the
owner rebuild; its failure remains in the local evidence.

Owner checks also exposed that ordinary registration still checks the mutable
source file. Activity opening now uses Files' existing snapshot import so that
later outside edits cannot invalidate an already opened version. The regression
checks old and new snapshots independently. A separate HTTP check verifies the
project and caller boundary, missing-Host reads, unchanged default grants and
the exact lexical table through the served response schema.

The final executed results and composition are recorded in [Status](STATUS.md).
The local episode report records Core binary/source identities, browser asset
hashes, source input hashes and explicit local overrides. This is application
integration evidence; source publication, installation and signed distribution
have separate scopes in [Release](RELEASE.md).
