# CI on three systems and npm

Updated 2026-11-02. Upstream finished Windows ([Windows episode](WINDOWS-0.5.2-EPISODE.md)), and
the user asked to start CI on the three systems and publication to npm. They chose the package
name `@rho-workspace/rho`, an `NPM_TOKEN` secret for publishing, pushes to `main`, and CI in Rho
only: Core and the Plugins add their own later. Work ran in GitHub Actions on YuLab-SMU/Rho,
whose runners are free for a public repository on all four machines used here.

## What CI does

`components.json` selects the Core commit (`6f83226`, then `8bed8ef` after the sixth run) and the
Plugins commit (`491c440`, then `0b17877` and `90e68cf` after the third and fourth runs) the
application is built from. On each push to `main` and pull request that changes more than
documentation, [`ci.yml`](../.github/workflows/ci.yml):

| Job | Runner | What it does |
| --- | --- | --- |
| Core | macos-15, ubuntu-24.04, ubuntu-24.04-arm, windows-2022 | Builds the selected Core with Rust 1.97.0, dev profile without debug info: Mach-O arm64, static musl Linux x64 and arm64, MSVC Windows x64; reuses a Core commit already built |
| Test | macos-15, ubuntu-24.04, windows-2022 | Builds the selected Plugins and Rho, runs Rho's suite with that platform's Core |
| Pack | ubuntu-24.04 | `pack:local` with all four Cores; checks the platforms, Linux linkage, clean inputs and commit |
| Install | all four | [`ci-install-check.mjs`](../scripts/ci-install-check.mjs): digest, offline install with an empty npm cache, the launcher, the packaged recovery and ordinary-project acceptances |

A `v*` tag runs [`release.yml`](../.github/workflows/release.yml) instead:

| Job | What it does |
| --- | --- |
| Find | The successful CI run on `main` for the tagged commit that still keeps its candidate |
| CI | Only when Find found none: `ci.yml` as above, in this run |
| Verify | [`release-check.mjs`](../scripts/release-check.mjs): digest, the commit and run that packed it, the four installation reports, name and the tag's version |
| Publish | Environment `npm`: `npm publish --provenance` of that candidate |

The installed check verifies the tarball against `SHA256SUMS` and its composition, installs it
outside every checkout with `--offline` and an empty cache, and runs the `rho` shim's usage. The
launcher must report ready with its own platform's Core and copy in the shipped project, then stop:
on SIGTERM with its shutdown report, or on Windows, where a CI step cannot send Ctrl+Break, by ending
its process tree with no project open. It then runs the packaged recovery acceptance and the packaged
acceptance of Plugins' `examples/ordinary-r-project` from the installation.

The release builds nothing when CI already tested the commit. Verify checks that the candidate's
composition names the tagged commit and the run it came from (`build.run`), that each platform's
installation report passed with this tarball, and that the package is `@rho-workspace/rho`, not
private, with the tag's version. Publish runs `npm publish --provenance --access public` with
`NPM_TOKEN`, a repository secret that no other job names; its environment `npm` has no reviewer. A
version with a prerelease suffix goes to the `next` dist-tag, any other to `latest`. Run by hand on
`main`, the release rehearses everything but Publish.

## Before the first run

The local `main` held one commit not yet pushed, the shipped example project (`58d7b5fc`). It was
replayed over upstream's three Windows commits (`55ebc49b`); only Status conflicted, in wrapping.

- **The example appeared in every test service.** The seed treated an unset `example` as on, so
  a service composed in code also got the project, and six browser grant checks saw two projects.
  The CLI passes on or off explicitly; the service now seeds only when asked (`dfbc15a3`).
- **The example could not be packed.** The packer refuses every R file outside the kernel runner,
  to keep project recipes out, and the study's scripts are R. Files under `example/` are allowed,
  nothing else (`281be780`).
- **What a registry needs.** The staged package drops `private`, asks for public access and names
  its repository, which provenance needs; the source checkout stays private.
- **A registry install.** A Mac-only candidate published to a local Verdaccio 6.10.5 and installed
  with `npm install -g @rho-workspace/rho` fetched two things, the package document and its tarball.
  The 13 plugins arrived as folders, `rho` and `rho-ui` were linked, and the launcher ran with its
  own Core and the shipped project and stopped in order, leaving no Core. Publishing that first
  version with `--tag next` also made it `latest`.
- **A socket path under the temporary folder.** A Unix Host's socket lies under its project, and
  macOS's temporary folder nearly fills the 104-byte limit, so recovery refused to run there. The
  installed check works under `/tmp`, as a person's `~/rho-projects` would.

## First run

Run [41368453930](https://github.com/YuLab-SMU/Rho/actions/runs/41368453930) on `ef39961d`. The
four Cores built and the candidate packed: `rho-workspace-rho-0.5.2.tgz`, 25,032,105 bytes, 5,250
files, SHA-256 `39bd3349…`, with Cores of 6,765,888 (darwin-arm64), 7,092,880 (linux-arm64, static),
7,009,512 (linux-x64, static) and 4,616,192 bytes (win32-x64). It was the first single tarball for
all four platforms. The installation passed on macOS, Linux x64 and Linux arm64; the suite did not:

| Test | Result | Cause |
| --- | --- | --- |
| macOS | 274/277, one failure | The several-faults doctor check took Claude Code and Codex from PATH; the runner has neither, so it also saw the agents warning |
| Linux x64 | Cancelled after 21 minutes, 33 tests reported | The browser tests chose folders under `/private/tmp`, which only macOS has. Four failed with a service still open, so the file never ended |
| Windows | 233/277, 30 failures, 13 skipped, MCP v2 cancelled | 16 tests made folders under the literal `/tmp`, which Node reads as `\tmp` on the current drive; the runner had none. Every R run was refused as having unknown dependencies. The runner's account writes in a folder denied to it |

The Linux hang was reproduced on Debian 12 arm64 with `/private` hidden under an empty tmpfs:
four ENOENT failures, then the file ran to its timeout. A full run there found one more failure:
Debian's R 4.2.2, like Ubuntu 24.04's R 4.3.3, has no `tools::sha256sum`, which the export test's
script uses. The fixes (`0bb2fec3`): Unix keeps `/tmp` for short socket paths and Windows takes its
temporary folder; the browser tests use `/tmp` as the system resolves it; the doctor fixture has
stand-in clients; the write-denial checks confirm the denial or skip with that reason; the test job
installs the current R everywhere.

## Second run

Run [41371381748](https://github.com/YuLab-SMU/Rho/actions/runs/41371381748) on `0bb2fec3`:

| Platform | Suite | Installed check |
| --- | --- | --- |
| macOS arm64 | 275/277, 2 skipped | Install 10.4 s, ready 0.9 s, orderly stop, recovery 7, ordinary project 7 |
| Linux x64 | 275/277, 2 skipped | Install 10.8 s, ready 1.0 s, orderly stop, recovery 7, ordinary project 7 |
| Linux arm64 | Not run | Install 7.5 s, ready 0.8 s, orderly stop, recovery 7, ordinary project 7 |
| Windows x64 | 250/277, 11 failures, 15 skipped, MCP v2 cancelled | Install 98 s, ready 1.8 s, ended; recovery refused |

Candidate `7b9daba5…`, 25,032,136 bytes. Linux x64 is a real x86_64 machine here, where the
[platforms episode](PLATFORMS-0.5.2-EPISODE.md) had only Rosetta. The Windows failures are every
test that runs R through Core, refused before it starts, and MCP v2 at its 30 s limit.

`setup-r` put Rtools first on PATH, which also made its MSYS bash the shell of every later step
(`C:\rtools45\usr\bin\bash.EXE`). Rho compiles no R packages, so Rtools stays installed but off PATH
(`1694fec1`), and CI prints the R dependency probe on Windows, once as is and once with Rtools first
on PATH.

## Third run

Run [41372069322](https://github.com/YuLab-SMU/Rho/actions/runs/41372069322) on `1694fec1`. macOS and
Linux x64 again passed 275/277 and the installation passed on the three Unix machines; Windows
failed as before, with Git's bash as the shell. The probe showed the cause, the same with Rtools
first on PATH or not:

| Expression given to `Rscript.exe --vanilla -e` (R 4.6.2 ucrt) | Exit | Printed |
| --- | --- | --- |
| `cat("R\t", R.version.string, "\n", sep="")` | 0 | `R\tR version 4.6.2 (2026-10-29 ucrt)\r\n` |
| `.libPaths(…)` then the same `cat` on the next line | 0 | Nothing |

Rscript ran only the first line and reported success. Requirements, which owns the probe, read
the empty answer as unknown, and Rho refused every managed R run on unknown dependencies. Upstream's
Windows machine had R 4.5.1, where the multi-line probe worked. With the user's agreement, Plugins
`0b17877` (Requirements 0.4.1) sends the probe as one line of statements and splits its output on
CRLF; the R version Windows reported had kept a carriage return. Rho selects that commit (`6aa5c8e6`).
Whether 4.6.0 and 4.6.1 behave like 4.6.2 was not checked.

## Fourth run

Run [41373192099](https://github.com/YuLab-SMU/Rho/actions/runs/41373192099) on `6aa5c8e6`. On
Windows the probe checked R 4.6.2, and the suite went from 11 failures to 2 (259/277, 15 skipped,
MCP v2 cancelled). macOS and Linux x64 passed 275/277 again. Pack refused its inputs as changed:
the build regenerates `src/contracts/owners.generated.ts` with each plugin's package version, and
the pin had been committed before a rebuild. The two Windows failures:

- **A Host started through cmd.exe runs R in a path cmd treats specially.** The project is named
  `a & b ^ %OS% !OS! (1) 中文 🧬`, and the one-line probe named that path; Rscript again printed
  nothing and exited 0. Plugins `90e68cf` (Requirements 0.4.2) makes the expression fixed text and
  checked package names, and hands R the library path as `RHO_R_LIBRARY`. On macOS a package in a
  project library under such a path is found.
- **A run whose Host stopped answering reads as unknown.** The test passed; removing its folder
  right after its processes ended failed with EBUSY. Removal now retries.

The test job now runs `check:contracts` before the suite, so a stale generated file fails there by
name (`5d8b936c`). In one local macOS run after these changes, an ACP conversation test failed once
under load (`changed` of undefined) and passed alone and in every other run.

## Fifth run

Run [41374734720](https://github.com/YuLab-SMU/Rho/actions/runs/41374734720) on `5d8b936c`, with Plugins
`90e68cf`. The candidate is `ec6bee9c…`, 25,033,065 bytes, 5,250 files. Every platform installed it
and passed its packaged acceptances:

| Platform | Suite | Offline install | Ready | Stop | Recovery | Ordinary project |
| --- | --- | --- | --- | --- | --- | --- |
| macOS arm64 | 275/277, 2 skipped | 12.1 s | 1.3 s | In order | 7 | 7 |
| Linux x64 | 274/277, 2 skipped, MCP v2 cancelled | 9.3 s | 0.9 s | In order | 7 | 7 |
| Linux arm64 | Not run | 8.5 s | 0.8 s | In order | 7 | 7 |
| Windows x64 | 260/277, 15 skipped, MCP v2 cancelled, 1 failure | 179 s | 1.2 s | Ended | 7 | 7 |

The probe now accepts the cmd-special path, and the run starts. R then ends abnormally: Core reports
it finished with a negative exit code, a Windows status such as a crash would give, and Rho's
contract, which requires a code of 0 or more, rejects the reply. Upstream's R 4.5.1 ran this test.
What R 4.6.2 does in that folder, and whether Rho's contract should carry Windows status codes,
were not examined. MCP v2 passed on Linux in runs 2 to 4 and was cancelled in this one.

## Sixth run and a Windows diagnosis

Run [41375803891](https://github.com/YuLab-SMU/Rho/actions/runs/41375803891) on `64d73550` passed
275/277 on macOS and Linux x64 and installed on all four platforms. Windows had three failures: the
cmd-special path, MCP v2 at 30 s, and "a repair is a new identity", which took 47 to 48 s there
against about 2 s on macOS and passed its 60 s limit this time. A diagnosis workflow on a temporary
branch (runs [41377127229](https://github.com/YuLab-SMU/Rho/actions/runs/41377127229) and
[41378118954](https://github.com/YuLab-SMU/Rho/actions/runs/41378118954), windows-2022) separated
the causes:

- **R and `%OS%`.** Node alone ran `Rscript --vanilla` on a script in folders named with each
  character cmd treats specially. R 4.5.1 and 4.6.2 both ended with `0xC0000005`, an access
  violation, when the script's absolute path held `%OS%`. They ran normally with `&`, `^`, `!OS!`,
  `(1)`, Chinese and an emoji, and with a relative path in the `%OS%` folder. Core gives R the
  script's absolute path, so R ends the same way in such a project under Rho; Core reports
  `Code(-1073741819)`. Where R misreads the path was not found. Upstream's R 4.5.1 ran the test on
  their own machine.
- **Rho's contract.** Rho's schema of Core's exit required a code of 0 or more. Core reports an
  i32, and a Windows process ended by an NTSTATUS reads negative, so the service's reply failed the
  contract it publishes. The code now keeps Core's whole range. The test runs R in a project
  without `%` and checks its working folder; in a project whose path holds `%OS%` it checks that
  the Host found the folder as named and that the run's state follows R's code.
- **Core's Windows output.** Through Rho's service, R writing 200 `message()` lines took 3.1 to
  3.4 s on Windows and 2000 lines 20 to 35 s, against 0.2 s on macOS. Once a lookup waited 20 s and
  Rho read the running run as unknown. Core's Windows reader gets each write as its own read, and
  each was committed alone: a blob, its sync and the record. Core `5333181` commits the bytes
  queued since the last drain together, at most one blob chunk at a time
  ([Core record](https://github.com/YuLab-SMU/Rho-core/blob/main/docs/work/CORE-20261102-01.md)).
  Its new regression failed on the old pump at the 512-chunk limit after 25.9 s and passed in
  0.5 s. With that Core on the runner, 2000 lines took 0.32 s, the repair test 2.1 s alone and MCP
  v2 22.4 s alone. Core's full regression suite was not run on Windows.
- **MCP v2.** Alone with the old Core it took 28.7 and 30.0 s on the runner. Its limit is now 90 s.

`components.json` selects Core `8bed8ef`, the fix and its record.

## Seventh run

Run [41379100841](https://github.com/YuLab-SMU/Rho/actions/runs/41379100841) on `d880a5f6`, with Core
`8bed8ef` and Plugins `90e68cf`, passed every job. The candidate is `83a071dc…`, 25,032,848 bytes,
5,250 files:

| Platform | Suite | Offline install | Ready | Stop | Recovery | Ordinary project |
| --- | --- | --- | --- | --- | --- | --- |
| macOS arm64 | 275/277, 2 skipped | 14.7 s | 1.5 s | In order | 7 | 7 |
| Linux x64 | 275/277, 2 skipped | 6.4 s | 0.6 s | In order | 7 | 7 |
| Linux arm64 | Not run | 7.6 s | 0.8 s | In order | 7 | 7 |
| Windows x64 | 262/277, 15 skipped | 97 s | 1.6 s | Ended | 7 | 7 |

On Windows the repair test took 4.2 s in the suite (47 to 48 s before), the cmd.exe test 2.3 s,
and MCP v2 40.2 s: past its old limit under the suite's load, within the new one.

## Shorter runs and releases without rebuilding

After the seventh run the user asked why a small project's runs took so long, and asked that
documentation and releases not rerun everything. A run took 5.5 to 6.6 minutes and about 22 runner
minutes; the first run took 24 because a test hung. On the longest path the Core build took 40 to
65 s, Windows tests 4 min 44 s (setup about a minute, the Plugins build 51 s, Rho's checks and build
about a minute, the suite 110 s against 51 s on Linux) and the Windows installation 2 to 2.8 min,
91 s of it the offline install. Every push to `main` ran it, documentation included, and a tag ran it
again before publishing.

`b2d5f401` changed that. CI skips documentation alone, apart from the shipped pages and the Status and
ledger a test reads; a Core commit is built once and then taken from the cache; the R probe prints
only on failure. A tag runs `release.yml`, which reuses the tested
candidate of its commit. Turning off Windows Defender's real-time scanning on the runners was also
proposed, to shorten the offline install; the permission check stopped it, and it is left to the user.

Run [41383999412](https://github.com/YuLab-SMU/Rho/actions/runs/41383999412) on `b2d5f401` built the
Cores once more to fill the cache and passed every job in 6 min 30 s. A rehearsal by hand,
[41384593699](https://github.com/YuLab-SMU/Rho/actions/runs/41384593699), found that run, verified its
candidate `36914452…` against the commit, the run and the four installation reports, and ended after
19 s without publishing.

The documentation-only commit `e1905b8c` started no CI run. A rehearsal on it,
[41384736475](https://github.com/YuLab-SMU/Rho/actions/runs/41384736475), found no tested candidate,
ran CI inside the release with every Core from the cache (8 to 17 s) and verified the new candidate
after 5 min 30 s. In that run npm's download cache saved nothing: the Plugins built in 40, 34 and 51 s
against 27, 38 and 51 s before, and restoring the cache took 7 to 9 s, so `0de1c6e4` removed it and
checks the generated contracts only on Linux, where they are the same as elsewhere.

Run [41385314640](https://github.com/YuLab-SMU/Rho/actions/runs/41385314640) on `0de1c6e4` passed every
job in 5 min 46 s. The Cores took 6 to 17 s and the tests began 20 s into the run instead of 64 s. The
longest path is now Pack (109 s) and then the Windows installation (210 s), whose offline install of
the 5,250-file package took 134 s, against 91 to 97 s in runs 7 and 8 and 6 to 15 s elsewhere. The
same runner's Linux job ranged from 144 to 240 s between runs with no change to it, so single-run
differences of that size are noise.

## Publication

`@rho-workspace/rho@0.5.2` is published (below). A `v*` tag needs:

1. The npm organization `rho-workspace`, owned by the account that will own the package.
2. A granular access token that can publish to that organization's packages without a one-time
   password, stored as the repository secret `NPM_TOKEN` of YuLab-SMU/Rho. The user added the secret
   on 2026-11-02 and chose no reviewer: the `npm` environment, which GitHub creates for the first
   publish job, holds nothing back. Whether the organization exists and the token can publish there
   is not visible from GitHub; the first publication shows it.
3. The version in `package.json`, pushed, and that commit tagged `v<version>`.

The tag's release publishes the candidate CI tested for that commit, or runs CI first when no run
kept one. The 0.5.2 candidates recorded earlier were never published, and a version cannot be
published twice.

The user asked to publish on 2026-11-02, and `v0.5.2` was pushed on `0de1c6e4`. Release
[41386982061](https://github.com/YuLab-SMU/Rho/actions/runs/41386982061) found CI run 41385314640,
verified its candidate `cf6f492d…` and then skipped Publish: the CI job it did not need was skipped,
and a job's implicit `success()` skips everything after a skipped job. The rehearsals had not shown
this, because a rehearsal skips Publish anyway. `212d1289` makes Publish check Verify's result, and
the tag, which had published nothing, was moved there after CI passed on it.

Release [41387607313](https://github.com/YuLab-SMU/Rho/actions/runs/41387607313) found CI run
41387094779 and verified candidate `2eb34912…` (commit `212d1289`, installed on all four platforms).
`npm publish` signed the provenance statement and entered it in the public transparency log
([sigstore 3637630891](https://search.sigstore.dev/?logIndex=3637630891)), then the registry refused
with `EOTP`: the token authenticated, but publishing needs a one-time password. Nothing was published.
A token that bypasses two-factor authentication for publishing is needed; then the failed job can
be rerun on the same tag.

The user replaced `NPM_TOKEN` at 04:48 UTC and the failed job was rerun (attempt 2). `npm publish`
logged a second provenance entry ([sigstore 3637698138](https://search.sigstore.dev/?logIndex=3637698138)),
said the package was being processed and returned at 04:50:16. The registry first showed only a
placeholder, `0.0.0-stage` ("Temporary package placeholder for staged publishing"), as `latest`;
`npm stage list` showed nothing staged. Version 0.5.2 appeared at 04:54:29 as `latest`. Its tarball's
SHA-256 is `2eb34912…`, the candidate CI run 41387094779 packed from `212d1289` and installed on all
four platforms; its SLSA provenance names `release.yml` at `refs/tags/v0.5.2`, commit `212d1289`
and run 41387607313 attempt 2. On this Mac `npm install @rho-workspace/rho@0.5.2` took 8 s (with
`--prefer-online`, since npm had cached the placeholder-only document) and carried all four Cores,
and `rho --help` printed its usage. `npm audit signatures` stopped at the bundled plugins, which are
not separate registry packages (404 for `@rho-workspace/plugin-documents@0.4.10`). The placeholder
version stays in the registry.

Version 0.5.3 followed the same day, at the user's request to publish the fixed version: Claude
sessions prefer Auto without Rho's step or wall cap, the Agent's bridge waits for a Notebook cell
as long as it asked (Agent 0.4.27), the bundled dependencies are pruned, and the package carries
its README. The new documentation-site job had failed on `eb8fc82a` by checking the site before
assembling it; `ca873922` builds first. CI run
[41415554593](https://github.com/YuLab-SMU/Rho/actions/runs/41415554593) on `40bb22af` passed every job
in 5 min (281/283 on macOS and Linux, 268/283 on Windows with 15 skipped, four installations).
The tag `v0.5.3` ran release [41416313702](https://github.com/YuLab-SMU/Rho/actions/runs/41416313702),
which found that run's candidate, verified it and published it in 39 s without CI or a person.
The registry recorded 0.5.3 at 08:58:01 and showed it as `latest` from 08:58:12, with 3,031 files,
SLSA v1 provenance and the README. Its tarball's SHA-256, `75f25f83…`, equals the candidate's;
installed, it carries Agent 0.4.27 and `rho --help` prints its usage.

Version 0.5.4 followed on 2026-11-05, at the user's request, so that the package npm serves
declares the Node range `>=22.22.0 <27` that main has declared since 2026-11-03; on 0.5.3, Node 24
and 26 print one `EBADENGINE` warning. CI had failed on every push to main since the one ending at
`e92efb12`. That push carried `c552a471`, whose Data flow imports `scriptGraph`, `graphNodeAt`,
`graphMarks` and `Making` from the Notebook plugin. Only Plugins `2e53dc2` exports them, while
`components.json` still selected `adb5fc6`, so the three test jobs stopped compiling
`web/entries/documents.tsx` and the pack job stopped at the same build. In the next three runs the
macOS Core job ran no step and was cancelled after 15 minutes, during GitHub's incident with Actions
and Pages, so nothing after it ran either. `826d73c1` composes Plugins `2e53dc2`. With those
Plugins built from `git archive` and the macOS Core of run 41822932525, the build,
`check:contracts` and the full suite passed on this Mac (308 of 310, 2 skipped). `fd0f9de5` sets
the version and has the README and `HEADLESS.md` install from the registry rather than a packed
tarball.

CI run [41975339969](https://github.com/YuLab-SMU/Rho/actions/runs/41975339969) on `fd0f9de5`
passed every job in 5 min: 308/310 on macOS and Linux, 293/310 on Windows with 17 skipped, and the
candidate installed and ran on the four platforms and on Linux x64 with Node 24.22.1 and 26.13.0.
The check shows npm's output only when an install fails, so these logs do not show whether npm
warned; the candidate's range includes both versions. The tag `v0.5.4` ran release
[41975983772](https://github.com/YuLab-SMU/Rho/actions/runs/41975983772), which found that run,
verified its candidate and published it in 21 s without CI or a person
([sigstore 3692659118](https://search.sigstore.dev/?logIndex=3692659118)). The tarball holds 3,134
files in 25.6 MB; its SHA-256, `a8466849…`, is the candidate's, and npm's SHA-1 `e8b10ffa…` matches
the downloaded candidate. At 05:45:57 npm answered that the package was being processed: since July
2026 the registry scans a version before serving it, typically for about five minutes and sometimes
fifteen or more, and may hold it for review or block it.
Forty-five minutes later, at 06:30, the registry still answered 404 for 0.5.4 and named 0.5.3
`latest`, while 0.5.3 answered 200 and an unpublished 9.9.9 404. Whether npm was holding 0.5.4
for review could not be seen from here: the registry said nothing, and npm's website refuses
automated requests. Nothing was retagged or published again; a version can be published only
once. The registry recorded 0.5.4 at 06:41:18, 55 minutes after accepting it, and named it
`latest`. The tarball it serves has the candidate's SHA-256 and SLSA v1 provenance. Installed
from the registry into a throwaway prefix on this Mac, it printed no `EBADENGINE`, and
`rho --help` printed 0.5.4's usage.

The same candidate, installed in a throwaway home on this Mac with Node 22.22.3 and npm 10.9.8,
printed no `EBADENGINE`. `rho` with no arguments started on `~/Rho/projects` and `~/Rho/state`,
copied the example and named Claude Code and R. A second start was refused in one line naming the
running address, and after an orderly stop a start without `--port` took the same port.

## A new user on Ubuntu

On 2026-11-02 the user asked to install as a new user on a Linux host. A fresh OrbStack machine,
Ubuntu 24.04.5 arm64 with only Python 3.12.3, followed what the npm page offers: its README, which
still says to install a packed tarball and that registry publication has not been performed, and names
no Node, R or Agent requirement.

| Step | What happened |
| --- | --- |
| `sudo apt install nodejs npm` | Node 18.19.1, npm 9.2.0 (116 s with the index update) |
| `npm install -g @rho-workspace/rho` | EACCES: the global prefix is root's |
| `sudo npm install -g @rho-workspace/rho` | Installed in 7 s with one `EBADENGINE` warning (needs Node `>=22.22.0 <23`); `rho` on PATH, four Cores |
| `rho` | Usage, exit 2 |
| `rho --root ~/rho-projects --state-dir ~/.rho-state` | One JSON ready line; `rscript` named `Rscript` though none was installed; the example project copied in |
| Projects page and the example project | Rendered from the Mac's browser through OrbStack's port forwarding; Overview, Agent and Notebook showed the example's recorded work |
| R cell, no R | "Rscript was not found. Install R, or name the program where the application is started." The cell is also headed "R session started" |
| Agent message, no Claude Code | "Not answered. Claude Code was not found on PATH (claude). Install it, or select its executable." The unanswered question became a Studio entry |
| `sudo apt install r-base` | R 4.3.3 in 27 s; Rho picked it up without a restart |
| R cell | "The live R session needs the R package jsonlite. Install it with install.packages("jsonlite")." Non-interactive `install.packages` cannot write the system library; interactive R created a personal library and built jsonlite 2.0.0 from source in 7 s |
| R cells | `summary`, the example's swarming data and a box plot ran in 0.1 s each; the plot drew "Δ" correctly but the cell printed eight `mbcsToSbcs` conversion warnings |
| Python cell | Python 3.12.3 ran at once |

Opening the project always requested `PA14 quorum sensing/analysis/summary_figure.R` and got
`not_found`: the example's recorded conversations name files from the folder above the project
(`PA14 quorum sensing/analysis/…`), as the Agent saw them when they were recorded. The same records
show the author's model (`westlakehpc/deepseek-v4.1-flash`), costs ($12.93) and command wrapper
(`rtk ls …`). Everything above ran on Node 18, which the package does not support; nothing observed
failed for a reason tied to it, and Node 22 was not tried here. Claude Code and Codex were not
installed or signed in.

## Windows installation time

The user then asked to shorten the slow Windows installation, with another agent's analysis and
[issue 112](https://github.com/YuLab-SMU/Rho/issues/112) attached. That analysis put the cost on the
package's file count, about 18 to 26 ms per file on Windows against 0.79 ms on macOS, and proposed
removing what Node never reads, then the duplicate CommonJS builds, and installing CI's copy in an
ASCII folder on the workspace volume. The issue measured 40 s for the package on a Windows 11 machine,
against 91 to 134 s on the runner.

The published 0.5.2 tarball holds 5,250 files, 4,688 of them bundled dependencies: 1,722 JavaScript
files, 1,261 type declarations, 645 source maps, 454 TypeScript sources (332 of them zod's), 186
Markdown files and 59 tool configurations; the MCP SDK also ships 208 example files.
[`prune-bundled.mjs`](../scripts/prune-bundled.mjs) now runs in the packer after the production install. In
third-party packages it removes declarations, source maps, TypeScript sources, tests, examples,
documentation and dotfiles. Licenses and first-party packages stay, as do the declarations reached from
Rho's own (`@agentclientprotocol/sdk`, `ajv`, `fast-deep-equal`, `fast-uri` and zod, 533 files). A file
that a package names under a condition Node selects (`main`, `bin`, `exports` `import`/`require`/`node`/
`default`) stops the packer instead; zod and eventsource name TypeScript sources only under `source`
conditions. Pruned the same way, the published package has 3,030 files and 22.7 MB instead of 25.0 MB.

Installed side by side on this Mac, the full and pruned packages loaded the same 327 of 343 export entries
of their bundled packages; the other 16 fail in both (JSON without an import attribute, type-only paths,
Deno and Bun entries, three Agent entries that need a connection). A pruned candidate packed here passed
`ci-install-check.mjs`: launcher, its own Core, recovery 7 and the ordinary project 7. The offline install
took 2.6 s against 4.2 s.

A temporary workflow on `codex/windows-install-timing` (run
[41395940042](https://github.com/YuLab-SMU/Rho/actions/runs/41395940042)) installed both offline on one
windows-2022 runner (4 CPUs, Node 22.23.4), each time with an empty cache, in two rounds of opposite
order. Defender's real-time protection was off there and `C:\` and `D:\` excluded, so it was not the cause.

| Folder | Full, 5,286 installed files | Pruned, 3,066 |
| --- | --- | --- |
| System temporary folder on C:, Unicode name | 159, 164 s | 105, 105 s |
| The same, ASCII name | 161, 159 s | 96, 99 s |
| `RUNNER_TEMP` on D:, Unicode name | 22.2, 21.7 s | 13.5, 13.5 s |

The runner's C: costs npm about 30 ms per file and D: about 4 ms; pruning saves 35 to 39% on both, in
proportion to the files. The name changed nothing measurable. Extracting the same tarball with `tar`
took 7 to 9 s on C: and 1.3 s on D:, so most of npm's time there is its own work per file. On the runner,
`ci-install-check.mjs` now installs in `RUNNER_TEMP` on Windows and keeps the name with spaces, Chinese and
the `rho ci` prefix; its report adds the package's file count.

Run [41398273893](https://github.com/YuLab-SMU/Rho/actions/runs/41398273893) on `1ae9d07f` passed every job
in 5 min 7 s, against 5 min 46 s before. Its candidate `131bd5f9…` has 3,030 files and 22,698,817 bytes.
The offline install took 19.1 s on Windows (91 to 134 s in earlier runs), 8.8 s on macOS, 6.0 s on Linux
arm64 and 3.6 s on Linux x64, and each installation passed recovery 7 and the ordinary project 7. The
Windows installation job took 90 s instead of 152 to 210 s. The suite passed 277/279 on macOS and Linux
and 264/279 on Windows (15 skipped), the two new pruning tests included. The longest path is now
Linux x64's tests, 4 min 41 s.

Not done: removing the CommonJS builds no Rho consumer requires (about 440 more files: zod's `.cjs`,
hono, the MCP SDK, zod-to-json-schema, diff) needs a reachability check first, since some bundled CommonJS
code does require these packages. KaTeX's WOFF and TTF fonts beside WOFF2 are 40 files. A person's
Windows machine was not measured again; the issue's machine recorded no Defender state.

## Not done

- A GitHub Release and signing.
- Rho's suite on Linux arm64; only the installation runs there.
- Real Agent conversations in CI. The suite uses stand-ins; on Windows the 11 stand-ins written as
  Unix scripts are skipped.
- An orderly stop of the installed launcher on Windows in CI.
- Core's and the Plugins' own CI on three systems.

## Open items

- In a project whose path holds `%OS%`, R run by Core on Windows ends with `0xC0000005`, as R does
  there when started directly. Whether Core should hand R a path it reads safely is not decided.
- npm still spends about 4 ms per installed file on the Windows runner's D: and 30 ms on its C:. A
  person's Windows machine, with Defender scanning, has not been measured since the pruning
  ([Windows installation time](#windows-installation-time)).
- `engines` named Node 22 only until 2026-11-03; it is now `>=22.22.0 <27`, with Linux x64
  installed on Node 24 and 26 in CI ([Docs site episode](DOCS-SITE-EPISODE.md#the-install-prompt-on-a-real-machine)).
  0.5.4, published on 2026-11-05, is the first release to declare it ([Publication](#publication)).
  Node 18 and 20 are below the range and unchecked.
- The candidate digest changes with every commit, since the composition names the commit; whether
  the same commit packs to the same bytes has not been checked.
