# Rho backend acceptance 0.1

Updated: 2026-10-15. Scope: BP-01–BP-06, `/api/v1` 1.0.

BP-01–BP-06 passed for the selected macOS arm64 composition. The local service,
functional headless package, calling client and inert state fixtures are delivered.
This record separates actual source checks and integration runs from the accepted
immutable installation candidate. Browser
views, native input, accessibility, layout and overall product release remain
pending under [WEBUI-FIRST](WEBUI-FIRST.md).

## Selected consumer and environment

| Item | Actual selection |
| --- | --- |
| Target | macOS 26.5.2 (25F84), arm64; no other OS/architecture accepted |
| Runtime | Node 22.22.3, npm 10.9.8; package engines >=22.22.0 <23; Python 3 with `fcntl` for advisory leases/checkers |
| Application | `@rho-workspace/local` 0.1.0; built-in Node HTTP, TypeScript 5.9.3, Ajv 8.20.0; authenticated loopback JSON/SSE |
| Functional owner | `@rho-workspace/headless` 0.1.0 at [13af3ab7ee47a47fc406df38146118207f2ed2c7](https://github.com/YuLab-SMU/Rho-plugins/commit/13af3ab7ee47a47fc406df38146118207f2ed2c7), published on `main`; MCP SDK 1.29.0, csv-parse 7.0.3; no DOM/React dependency |
| Actual external Agent | Claude Code 2.1.300, stdio MCP, existing client-owned authentication/provider; project/method-scoped private descriptor |
| Core | Public CLI at `d0159da6feb01d1be9e3b4b34b67953241fedfcb`; one successful `cargo build --locked --bin rho-core`; source unchanged |
| Scientific runtime | R 4.5.2; DESeq2 1.48.2; airway 1.28.0; jsonlite 2.0.0; missing apeglm explicitly prepared in each selected project library |
| Dataset and method | airway/GSE52778, paired donor DESeq2, four donor-omission fits, one conditional simulation for bounded integration; actual apeglm shrinkage of `dex_trt_vs_untrt` |

The older Plugins 200-simulation scientific record remains separately scoped.
One simulation exercises the supported input and pipeline, not a new scientific
power or biological validity claim. Exact loaded versions, code digests, manifests
and saved native objects remain in each actual run's artifacts.

## Work-package evidence

| Package | Implemented boundary and actual evidence |
| --- | --- |
| BP-01 | [Published v1 schemas](../protocol/v1.json), per-operation responses, typed errors, finite events/catalog, calling client, read-only fixtures; actual Claude MCP context fetch and shared Unicode edit |
| BP-02 | npm launcher, private credentials, exact Host/Origin, project containment/symlinks, kernel writer leases, durable service intents and public Core CLI bridge; three actual SIGKILL boundaries retain one native identity/dispatch |
| BP-03 | Selected-action dependency checks/preparation, saved-script snapshot, actual five DESeq2 fits and 33 script/table/model/PDF artifacts; byte declarations, 12 arithmetic checks and 121 saved-model observations separately reported |
| BP-04 | Shared acknowledged buffer/version, UTF-16 edits, grouped undo, disk conflict and restart recovery; frozen unsaved-script execution; actual Claude handoff and bounded method receipts |
| BP-05 | 16,139 real genes, typed NA-preserving pages, KLF15/ENSG00000163884 after sorting, marked plot sampling; real apeglm action/checker and two-input gene join; table/scatter bind the same comparison; unavailable UI intent retained |
| BP-06 | Lost first reply, crash/restart, observation/binding/view release, partial plus unknown after owned Host loss, cancellation versus confirmed process release; real export/restore and bounded budgets; installed candidate recorded below |

The actual failure-to-Agent-repair experiment supplied `failure.json` and the
same unsaved script through explicit context. Claude conditionally edited that
buffer and deliberately submitted a new immutable operation. The new analysis
completed and passed independent checks in source and installed trials; the
original request remained failed. Each new operation had one native dispatch.

## Executed checks and retained evidence

- Plugins `npm test`: 8/8 focused tests passed, including actual R singleton plots,
  spaced Chinese script paths, MCP caller retention/concurrency, shared documents,
  typed data and resource budgets.
- Rho `RHO_CORE_BINARY=... npm test`: 9/9 tests passed. The HTTP test client validates
  actual replies and typed errors against the same published response schemas.
  Crash tests kill a service before Host startup, before CLI delivery and after
  CLI acceptance before the first HTTP acknowledgement; native entry count is one.
  Service/document startup also works with an unavailable selected Rscript;
  dependency status is unknown and scientific execution is rejected before Host startup.
- Source `npm run acceptance`: passed with a saved-script digest, explicit
  project-library preparation, real baseline/shrinkage, independent checkers,
  stable selection, registered composition and actual export/restore without replay.
- Source `npm run recovery`: passed with a real recipe paused after writing its
  first full fit. The retained partial table has 16,139 observed rows and no
  completion declaration. After owned Host loss the outcome remains unknown;
  cancellation is unconfirmed. A separate actual cancellation confirms process
  group release. Cleanup does not retroactively rewrite the unknown fact.
- Source `npm run agent`: actual Claude fetched explicit context and edited the
  human's unsaved Chinese/emoji buffer; no scientific Host started in that trial.
- Source `npm run repair`: actual Claude repaired the failed singleton histogram
  in the acknowledged shared buffer and submitted deliberately new work. The
  original failed operation, new caller intent, tool receipts, single native
  dispatch and independent repaired-result checks agree. The Agent took 540.247 s
  within the 600 s experiment budget; this is an observed run, not a latency promise.

Local evidence is retained in ignored `work/` experiment directories. It includes
reports, operation records, code snapshots, native artifacts, failure records and
private MCP transcripts. Credentials/transcripts are not source artifacts or a
permanent remote archive. [Fixtures](../fixtures/README.md) project captured owner
facts into read-only consumer states; they contain no replayable request or code.

## Accepted installation candidate

The selected candidate passed actual outside-checkout installation on 2026-10-15.
The [composition and report projection](backend-acceptance/v0.1.0.json) records
immutable source/tree and build-input identities, package/binary digests, check
results and hashes of retained local reports. Credentials, machine paths and raw
Agent transcripts are excluded. Earlier dirty development tarballs are not accepted.

| Item | Accepted identity |
| --- | --- |
| Application source | [81e1d4582ff7cf75ab160c918ce332121dcb7721](https://github.com/YuLab-SMU/Rho/commit/81e1d4582ff7cf75ab160c918ce332121dcb7721), tree `19065a364d8a4c362157baea9a55adefb7b1ce87` |
| Functional source | Plugins `13af3ab7ee47a47fc406df38146118207f2ed2c7`, published before the application reference |
| Core binary | Selected unchanged source above; SHA-256 `eee223026f7e0b4dd1ee14a409c023919626c4175be5728048a02af739af4ce1`, 7,399,128 bytes |
| npm artifact | `rho-workspace-local-0.1.0.tgz`, 6,074,792 bytes, 3,751 entries |
| Artifact SHA-256 | `548f9af370cff75f872ec64877fe397e4c257d77071cd30d22dec814800a2f00` |
| Distribution scope | Unsigned local npm tarball, macOS arm64; no registry publication |

The packer accepted clean selected build inputs and recorded no local source
override. Later documentation commits record this candidate's acceptance; they
do not replace its fixed source or artifact identity. Unrelated local design
document changes are outside the selected build inputs.

Installed checks passed actual `npm install --omit=dev --ignore-scripts`, `bin/rho`
startup without Rscript, private credentials and bundled Core selection with source
overrides removed. The same installed package then passed real science, recovery,
external Agent and failure-repair scripts. The installed repair Agent took
227.782 s within its 600 s budget; independent checks verified the new result and
the original request remained failed. Versioned protocol and read-only fixtures
were present. The exact tarball was retained and not rebuilt after acceptance.

Scientific prerequisites are
external; this is a fresh package installation on the existing scientific host,
not a clean OS image or a proof that npm installs R itself.

## Failures retained and repaired

1. The initial bootstrap=1 recipe wrote real models/tables, then failed in
   `hist(..., breaks="FD")` on a singleton. The component now uses one bin for
   that supported input. A focused native R regression and later execution cover it.
2. The first shrinkage checker did not load DESeq2 before native S4 dispatch.
   Explicit namespace loading repaired the checker; the original scientific output
   was not silently changed to manufacture a pass.
3. An isolated Claude authentication attempt reported an expired OAuth token.
   The later successful experiment used the client's existing selected provider
   configuration, without changing user settings or exposing secrets.
4. The first installed trial used the macOS default temporary directory and
   exceeded the native Unix socket path limit. The service now reports that
   condition before Host startup. Installation uses a shorter canonical `/tmp`
   location, retaining Chinese characters and spaces. The macOS socket path is
   limited to 103 UTF-8 bytes including `/.rho/host.sock`; no automatic Host move.
5. The next installed analysis completed, but its independent arithmetic checker
   rejected a missing script digest. Rscript encodes spaces in `--file` as `~+~`;
   the recipe now decodes a nonexistent raw path and verifies the real file bytes.
6. Longer Agent repair trials exhausted first 180-second and then 600-second
   experiment budgets after context/document reads. Both remain failed. Later
   source and installed trials supplied the actual error with a focused versioned
   code range and the client's low-effort setting; both passed within the same
   600-second bound. This is not a product latency guarantee.
7. A developer test invocation without the required Core selection failed early
   as unavailable; rerunning with the explicitly selected binary passed all 9 tests.
8. Final review exposed a launcher requirement for Rscript at service startup.
   The launcher now retains an unavailable selection for the action probe, allowing
   project/document APIs to work; the service regression exercises this condition.

## Limits and UI handoff

[Headless backend](HEADLESS.md) records operations, confirmation points, defaults
and exceeded-limit behavior. Native output, execution, artifact integrity,
scientific checking and model interpretation remain separate facts. Document
saving checks the external disk digest immediately before atomic replacement;
uncooperative writers do not participate in the advisory lease, so this is not a
filesystem CAS guarantee.

MCP context is pulled through an actual tool. `tool-fetched` proves that fetch;
proactive insertion into an existing external conversation is unsupported.
Reads and reconnects never start/recover Hosts. The service stops only Hosts it
started; adopted Hosts retain ownership. Partial/unknown and lost acknowledgements
never authorize a replacement identity. Each resource has its own version.

UI developers receive `protocol/v1.json`, the exported client, the finite catalog,
fixtures and the installed service. All four registered UI entries are currently
unavailable. CodeMirror/AG Grid/ECharts/json-render/Dockview mapping, browser
refresh behavior, native Unicode IME, focus, keyboard/clipboard/accessibility,
responsive widths and full product performance/install acceptance remain actual
UI work. No npm registry publication, signing, reproducible binary build, remote
service, native execution sandbox or R-memory recovery is claimed.
