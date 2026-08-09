# Rho 0.4.0-dev.24 Historical Candidate Record

Status: historical published development-candidate record; Issue #6 R5 and Issue #9
TASK-RAIL-SEMANTICS-1 source implementation, review-only rehearsal,
authoritative cross-platform candidate, signed/notarized DMG, owner-installed
acceptance, MAC5 GO, protected prerelease publication, and live development
update-site verification pass; superseded in source only by the separately
versioned Issue #5 `0.4.0-dev.25` development candidate

Date: 2026-08-08
Last updated: 2026-08-09

Change class: D1/R1 Task Rail presentation correction plus the required D4
single-use replacement development identity

Risk: R1 for the bounded frontend behavior; R4 for any hosted candidate,
artifact promotion, signing/notarization, release action, or publication

Owning documents: the active Problems-to-Agent specification retains parser-
token repair authority; the Task Rail semantics specification owns only mode,
status, selection, and accessibility presentation; the active macOS arm64
specification owns packaging and trust gates. This checklist alone owns the
exact `0.4.0-dev.24` identity, future candidate evidence, installed-acceptance
ledger, and GO/NO-GO decision.

Authorization: on 2026-08-08 the project owner explicitly requested continued
implementation of GitHub Issue #9. The active governance requires a new
user-visible candidate identity, synchronized NEWS/metadata, tests, review, and
commit. This does not authorize a local or hosted artifact, tag, GitHub
Release/draft, signing/notarization, update-site mutation, MAC5, or publication.

Authorization amendment: on 2026-08-09 the project owner accepted the exact
`dev.24` local development-app experience, requested that the reviewed branch
be merged to `Rho_for_mac/main`, and explicitly authorized dispatch of the
macOS build workflow. The repository exposes macOS signing/notarization only
through the combined `Build Rho Candidate / Rehearsal` workflow, so this
authorization admitted one exact-default-branch `rehearsal` dispatch and its
coupled Windows verification job. At that checkpoint it did not admit
`candidate` mode, a tag, Release/draft, update-site mutation, MAC5, or
publication. Development-app acceptance is not installed-DMG acceptance.

Candidate-entry authorization: after the review-only rehearsal and upstream
`main` integration passed, the project owner requested "开始发布" on 2026-08-09.
This activates the authoritative `candidate` build/draft stage for one exact
current `YuLab-SMU/Rho/main` commit. It permits the workflow to build both
platforms, sign/notarize the macOS DMG, create the immutable draft prerelease,
and attach its bounded candidate evidence. It does not authorize the later
`Publish Rho Candidate` workflow, update-site mutation, or a public Release.
Those remain blocked on exact owner-installed candidate acceptance, a bound
MAC5 `GO` record, and a separate final publication decision.

MAC5 and publication authorization: on 2026-08-09 the owner installed the exact
draft DMG, reported `MAC5 PASS`, and explicitly authorized public publication.
The bounded `rho-0.4.0-dev.24-acceptance.json` record is therefore permitted to
carry `status: passed` and `decision: GO` only for the immutable candidate
identified below. After the first protected publish attempt failed before any
Release mutation, the owner explicitly authorized the release-only workflow
repair. That repair may change orchestration and its regression contract on
`main`; it may not rebuild, replace, rename, delete, or relabel any accepted
candidate asset, change the draft target commit, or weaken MAC5 admission.

`0.4.0-dev.20` through `0.4.0-dev.22` are immutable rejected predecessors.
`0.4.0-dev.23` is an immutable superseded predecessor whose R5 source tests
passed but whose artifact and installed acceptance were not run. No predecessor
artifact, hash, receipt, or acceptance row can satisfy this checklist.

## Exact Identity

| Field | Required value | Current evidence |
| --- | --- | --- |
| Application version | `0.4.0-dev.24` | source metadata synchronized |
| `rho.bridge` version | `0.1.13` | unchanged |
| `rho.agent` version | `0.1.5` | unchanged |
| Store schema | `11` | unchanged |
| Release tag | `v0.4.0-dev.24` | public Git ref points to authoritative source commit |
| Release name | `Rho 0.4.0-dev.24` | public prerelease ID `367387340` |
| Release channel | development prerelease | fixed by SemVer |
| Source repository | `YuLab-SMU/Rho` | authoritative-candidate restriction unchanged |
| Local source commit | `c83ddfb4563778c1bf6190bd5ce833bb0a6a2e72` | reviewed rehearsal source checkpoint |
| Authoritative source commit | `7c18e08d7b34dc7d976fa3685242402ccd7da2e8` | draft target and aggregate evidence agree |
| macOS platform | `macos_aarch64` | authoritative signed/notarized candidate passed |
| Minimum macOS | 14.0 | configuration unchanged |
| Release decision | `GO` | owner reported `MAC5 PASS` and authorized public publication |

The version/tag is single-use. Rejection or a later user-visible source change
advances to another version; no artifact, tag, draft, hash, or evidence file may
be overwritten or relabelled.

## Combined Corrective Scope

The parser-token behavior carried forward from `dev.23` is unchanged:

- only `rho.bridge` may admit a bounded parser-owned `<text>:line:column:`
  coordinate during the exact parse phase;
- schema 11 durably distinguishes `r_parse_token` from `r_expression` without
  historical backfill;
- Console and Problems bind the same exact failed run and select a validated
  token automatically; EOF/ambiguous locations remain explicit-selection
  fallbacks;
- no automatic Provider request, R execution, proposal acceptance, save, fuzzy
  matching, approval, or file mutation is introduced.

Issue #9 adds only the following Task Rail projection:

- the row order is status dot, mode icon, then prompt preview;
- Ask uses MessageCircle, Plan uses ListChecks, and Act uses PencilLine through
  the existing local inline SVG sprite;
- mode icons have transparent backgrounds and neutral foregrounds; the current
  or keyboard-focused row may use Rho teal;
- status dots remain the only status-color slots and expose their own labels;
- rows expose independent mode/status names, tooltips, `aria-current`, visible
  keyboard focus, truthful empty text, and bounded long/Unicode ellipsis;
- unknown historical modes use a neutral Bot fallback;
- approval, execution, risk, persistence, credentials, and broker policy remain
  unchanged.

## Development Verification

Current exact-source Issue #9 evidence on 2026-08-08:

- `node --check desktop/dist/app.js`: PASS;
- all 46 fail-fast repository `scripts/test-*.mjs` contracts: PASS, including
  the focused Task Rail regression and existing release/notarization fixtures;
- `cargo check --workspace --all-targets`: PASS with only existing unused Git
  helper warnings; no Rust behavior changed;
- exact Chromium `1440 x 900`: PASS with Ask/Plan/Act, completed/running/failed,
  empty/long/Unicode preview states, one current item, transparent mode
  backgrounds, independent mode/status colors and names, no list/document
  overflow, and zero page exceptions;
- exact Chromium `900 x 700`: PASS with the existing responsive rail hide,
  usable remaining Agent surface, no document overflow, and zero exceptions;
- keyboard interaction: PASS with a visible 2 px focus outline, selection
  transfer, `aria-current`, and focus restoration;
- `git diff --check` and implementation-to-contract review: PASS.

The complete cross-platform matrix and exact app/installer/DMG smoke were not
rerun merely to record the initial R1 source slice. They were subsequently run
by the exact review-only rehearsal recorded below. Historical `dev.23` test
results remain historical and are not relabelled as `dev.24` evidence.

## Review-Only Rehearsal Evidence

Fork run [`31294667960`](https://github.com/YuLab-SMU/Rho_for_mac/actions/runs/31294667960)
completed successfully on 2026-08-09 against exact commit
`c83ddfb4563778c1bf6190bd5ce833bb0a6a2e72`. Identity admission, the complete
Windows and macOS candidate matrices, Developer ID signing, entitlement checks,
Apple notarization and binding, staple, Gatekeeper, mounted-DMG Workspace
smoke, and seven-file review-only aggregation all passed. Draft creation was
skipped as required for `rehearsal` mode.

GitHub artifact `9032765026`, named
`rho-0.4.0-dev.24-rehearsal-c83ddfb4563778c1bf6190bd5ce833bb0a6a2e72-31294667960-1`,
was downloaded independently. Both checksum files validated their artifacts,
and the checked-in validators admitted both platform records and the aggregate
rehearsal record against the exact repository, version, tag, commit, Run ID,
and attempt.

| Review-only file | Bytes | SHA-256 |
| --- | ---: | --- |
| `Rho_0.4.0-dev.24_aarch64.dmg` | 20,967,642 | `b28b70e285e770b17836ab9c3bd3524fff23c86e153ccfd8e3138419dd9db6ce` |
| `Rho_0.4.0-dev.24_aarch64.dmg.sha256` | 95 | `7c436aaa7fb6b855f1a042beb7877a092933da8e619b97dd57ad3721903f40e6` |
| `rho-0.4.0-dev.24-macos-aarch64-evidence.json` | 1,358 | `4b1c09d414850304cac708fdcf831e69774e4f24ee158ec1515cd692c25c706f` |
| `Rho_0.4.0-dev.24_x64-setup.exe` | 18,151,451 | `263c0e0bd1147e31405f36bcd8f4e9ec50e4499c76310d742d1639953cccb2e6` |
| `Rho_0.4.0-dev.24_x64-setup.exe.sha256` | 97 | `89e8190e8327f126fc001bcb3940a1a4b279d22bb07c4fee02b08892a3cebe97` |
| `rho-0.4.0-dev.24-windows-x86_64-evidence.json` | 904 | `938f535d903cf79081101f8ae2389e5e998666ff724400d73cc934c8dd8aeae4` |
| `rho-0.4.0-dev.24-rehearsal-evidence.json` | 1,582 | `3880db4b13619856c8d94a28cbc524958d0551005cac79dfa998c23dd6e5216d` |

This is immutable review-only fork evidence. The authorization record itself
creates a later documentation-only default-branch commit, so the authoritative
candidate workflow must rerun and bind all candidate assets to that exact new
commit; these rehearsal files cannot be copied or relabelled into the draft.

## Required Candidate Assets

Authoritative run
[`31295799312`](https://github.com/YuLab-SMU/Rho/actions/runs/31295799312)
completed on attempt 2 against exact commit
`7c18e08d7b34dc7d976fa3685242402ccd7da2e8`. Attempt 1 failed closed while
downloading the public pinned `aisdk` dependency for Windows; the failed jobs
were rerun after the endpoint recovered, and the complete Windows matrix plus
draft assembly passed. The successful macOS jobs were reused unchanged.

| Asset | Bytes | SHA-256 | State |
| --- | ---: | --- | --- |
| `Rho_0.4.0-dev.24_x64-setup.exe` | 18,148,181 | `114389aa675045beddb58c01dc7c4a0aec5936081b04018456694c770ae0b774` | PASS |
| `Rho_0.4.0-dev.24_x64-setup.exe.sha256` | 97 | `7769103bf954837a198ae619c369fa524a2ca8d691181f9c6983f6d8322a4c9e` | PASS |
| `rho-0.4.0-dev.24-windows-x86_64-evidence.json` | 904 | `447090dbefba67cc47fdfdd322929321a123404b5d70b1b2a6442b33f9dc5a39` | PASS |
| `Rho_0.4.0-dev.24_aarch64.dmg` | 20,967,631 | `f24982a616b1695621cdb7f9b9c8d001083926fb77a975c6f582b339da50c34f` | PASS |
| `Rho_0.4.0-dev.24_aarch64.dmg.sha256` | 95 | `713996c9207f04d87f221cdf5b0d36283f2e4e4a19717716abfec76a0a29e42b` | PASS |
| `rho-0.4.0-dev.24-macos-aarch64-evidence.json` | 1,358 | `1d3d61aa7c6492f8c72aee80e18cd9fd5f62d801e6df302afc5a034c90a19185` | PASS |
| `rho-0.4.0-dev.24-candidate-evidence.json` | 1,477 | `fe4a9fba56cd1b5f1d62d1ef7c6cc462f980c8c2fa4595e504d76f2d6743279d` | PASS |

Independent download validation re-hashed all seven candidate files, validated
both checksum payloads, admitted both platform evidence records and the
aggregate record through `scripts/candidate-release.mjs`, verified the DMG with
`hdiutil`, validated its stapled ticket, and verified the mounted app's strict
Developer ID signature. CI Gatekeeper admission passed; local `spctl` reported
`accepted` and `Notarized Developer ID`, with the local machine's security
override explicitly visible rather than treated as independent Gatekeeper
evidence.

## Installed Acceptance

An exact immutable `dev.24` installed build must cover both carried-forward and
new behavior:

- reproduce the full-width-comma file parse failure, expose `Fix with Agent` at
  the Console site, select the exact invalid token, and start one real
  tool-capable read-only Ask repair turn without opening Problems or asking for
  a redundant selection; keep the file unchanged before Accept;
- populate Agent-first history with healthy and failed Ask/Plan/Act turns and
  confirm that Act itself is neutral, only true failed status is red, shapes
  and tooltips/names are distinct, selection/focus is clear, and narrow layout
  remains usable;
- retain truthful EOF/no-range, route/setup, credential redaction, refresh,
  restart, duplicate, changed-source, stale, schema-upgrade, and project-switch
  behavior.

The owner installed the exact downloaded
`Rho_0.4.0-dev.24_aarch64.dmg`, completed this checklist, and reported `MAC5
PASS` on 2026-08-09. The accepted candidate evidence SHA-256 is
`fe4a9fba56cd1b5f1d62d1ef7c6cc462f980c8c2fa4595e504d76f2d6743279d`.
The bounded acceptance asset is 1,598 bytes with SHA-256
`642e0b7774ff60e4a6db35956dcb65883623c510995030ddbae9ccf71faf20a3`;
it matches the aggregate platform mapping exactly and is the eighth and final
draft asset.

## Publish Admission Defect And Repair Contract

Protected publish run
[`31297205980`](https://github.com/YuLab-SMU/Rho/actions/runs/31297205980)
was approved through environment `rho-release` and then failed at `Resolve
immutable draft identity`. GitHub returned 404 for
`GET /releases/tags/v0.4.0-dev.24`: a draft whose public Git tag does not yet
exist cannot be resolved through `getReleaseByTag`. Checkout, content
validation, `updateRelease`, tag creation, and update-site publication did not
run. At that checkpoint the draft remained private and its exact eight-asset
set was unchanged.

The authorized correction is release-only and must satisfy all of these gates:

- enumerate repository Releases with authenticated pagination and select
  exactly one item whose `tag_name` matches the explicit workflow input;
- require that item to remain a draft prerelease bound to a full 40-character
  commit, and carry its numeric Release ID as an explicit step output;
- retrieve the second snapshot by that exact Release ID, then recheck tag,
  draft/prerelease state, commit, byte bounds, names, sizes, and hashes;
- keep checkout and publish validation bound to the accepted candidate commit,
  not the later release-orchestration commit;
- retain exactly one `updateRelease` mutation and prohibit build, upload,
  delete, rename, replacement, or asset overwrite behavior;
- add a deterministic regression contract that rejects `getReleaseByTag`,
  requires paginated exact-tag draft discovery and ID-based retrieval, and
  preserves the existing immutable-asset assertions.

This is D1 behavior within an R4 release lane. Application and R package
versions and `NEWS.md` do not change because no application/package artifact or
user-visible product behavior changes. The mandatory checkpoint is a passing
local release-contract matrix and reviewed release-only diff before the fix is
pushed to `main` and the protected publish workflow is retried.

Pre-commit implementation evidence: the identity step now uses authenticated
paginated `listReleases`, rejects zero or multiple exact-tag matches, exports
the immutable numeric Release ID, and the download step retrieves by that ID
before rechecking tag and commit. The regression contract rejects
`getReleaseByTag` and asserts both discovery and ID-bound retrieval. All 46
`scripts/test-*.mjs` contracts, `candidate-release.mjs --test true`,
`generate-update-site.mjs --test true`, JavaScript syntax checks, Ruby YAML
parsing, and `git diff --check` pass. `actionlint` is not installed locally and
is recorded as unrun rather than passed; successful hosted run `31297462728`
subsequently satisfied GitHub workflow parsing and execution admission.

The separate post-verification review found no blocking authority, identity,
asset-mutation, race, rollback, credential, or sequencing issue. A deleted or
recreated draft fails by immutable ID; a changed tag, commit, state, asset set,
size, or hash fails before the sole `updateRelease` call; and the later
orchestration commit cannot replace the checked-out accepted-candidate
contract. The reviewed diff contains only the publish workflow, its regression
contract, and the owning release/governance records.

## Publication And Update-Site Evidence

Release-only correction commit
`f30b1ae240d056ef97f670d85c8e925d89b9415d` was fast-forwarded to both
authoritative and fork `main` branches. The upstream workflow bytes matched the
reviewed local file. Protected publish run
[`31297462728`](https://github.com/YuLab-SMU/Rho/actions/runs/31297462728)
then passed environment review, resolved draft ID `367387340`, checked out the
accepted candidate commit `7c18e08d7b34dc7d976fa3685242402ccd7da2e8`,
downloaded and re-hashed all eight assets, admitted the exact MAC5 GO record,
and performed the sole allowed `draft: false` transition. The public
prerelease was published at `2026-08-09T05:48:12Z`; tag
`v0.4.0-dev.24` points to the accepted candidate commit, and every asset ID,
name, size, and digest remains unchanged.

Automatic update-site run
[`31297482853`](https://github.com/YuLab-SMU/Rho/actions/runs/31297482853)
validated published Release evidence, generated the development channel,
published `gh-pages` commit `dcfbdbdb5a53e4fedc2c18880a18b4145804e014`,
and passed its deployed-manifest verification. A separate cache-busted fetch of
`https://yulab-smu.top/Rho/updates/development.json` confirmed schema 1,
channel `development`, version `0.4.0-dev.24`, Windows size/hash
18,148,181 / `114389aa675045beddb58c01dc7c4a0aec5936081b04018456694c770ae0b774`,
and macOS size/hash 20,967,631 /
`f24982a616b1695621cdb7f9b9c8d001083926fb77a975c6f582b339da50c34f`.

Both successful hosted runs emitted a non-blocking warning that
`actions/checkout@v4` and `actions/github-script@v7` are forced from their
declared Node 20 runtime to Node 24. No failure, asset change, or acceptance
deviation resulted; action-major modernization is a bounded follow-up rather
than a reason to alter this immutable candidate.

## Current Decision

`GO / RELEASED` for immutable development prerelease `0.4.0-dev.24`.
Automated candidate evidence, owner-installed acceptance, bounded MAC5 evidence,
protected publication, public tag/Release identity, and live development update
manifest all pass. No accepted asset was rebuilt or replaced. Broader macOS x64
and Linux x64 milestone work remains outside this Apple Silicon candidate.
