# 0.5.2 on macOS and Linux

Updated 2026-11-01. The 0.5.2 candidate was JavaScript plus one darwin-arm64 Core, and it
refused every other platform. The user asked for this Mac and Linux first; Windows follows in
another clone. This episode packs one tarball that installs on macOS arm64, Linux x64 and
Linux arm64, and records what building, testing and installing it on each found.

## Core: one commit for every platform

A package should carry each platform's Core from one Core commit. Core `7e424b3` includes the
Windows port (`1e95dd7`), which the Windows work will build on, so it was selected. It did
not compile on Unix. Once it did, its Host exited as soon as it started (the signal pipe's
read end had two owners, so the first read saw EOF), Linux had lost its `SO_PEERCRED` peer
check to a macOS-only call, and the Host no longer removed its own socket. Core `c3dbeca`
restores `4f5bed8`'s Unix behavior; the Windows code is unchanged and still type-checks.
See [CORE-20261101-01](https://github.com/YuLab-SMU/Rho-core/blob/main/docs/work/CORE-20261101-01.md).

Linux Cores are static musl builds (`x86_64`/`aarch64-unknown-linux-musl`), so they need no
particular glibc. All three Cores are the dev profile, as tested and as 0.5.1 shipped, built
with `CARGO_PROFILE_DEV_DEBUG=0`: with debug info a Linux Core was 26 MB, without it 7 MB.
Core's own checks ran in that same configuration on each platform, and the packed binaries
are the ones those runs built.

| Platform | Built and tested on | Core checks | Binary |
| --- | --- | --- | --- |
| darwin-arm64 | macOS 26.7.2 | fmt, clippy, 81/81, example | 6,792,672 bytes, Mach-O |
| linux-arm64 | Debian 12 arm64 (OrbStack, native) | fmt, clippy, 81/81, example | 7,032,904 bytes, static |
| linux-x64 | Ubuntu 25.04 amd64 (OrbStack, Rosetta) | fmt, clippy, 81/81, example | 7,017,040 bytes, static |

The first full x64 run did not finish: `managed_run` stalled for 25 minutes with most test
threads waiting on a lock. Repeated under load (eight loops of 25 runs), it stalled 5/200
times as musl and 3/200 as glibc; `4f5bed8`, before the port, stalled 5/200. Native arm64
never stalled (0/200 Linux, 0/200 macOS). The stall predates this work, does not depend on
the C library and has only been seen under Rosetta. It has not been tried on real x86_64
hardware, so it is not known to be only an emulation effect.

## What Linux exposed in Rho and the Plugins

**The local R Notebook died at start.** Node gives a child's extra descriptors as sockets.
The R runner opened its answer channel as `/dev/fd/3`; macOS allows that, Linux refuses with
ENXIO. On Debian 12 arm64 the local Notebook tests had 5 R failures (7 passed). Notebook 0.5.1
relays the answers through a `cat` that ignores the interrupts sent to the session's group.

**Output landed out of order.** With the relay an answer arrives after the text printed
behind its mark, and the reader only handled the opposite case. Printed text after a mark now
waits up to a second for that mark's answer. Checking this on macOS showed a second, older
race: an answer held for its mark was queued while the text after the mark was placed at
once, so `message(); warning(); value` once gave the warning after the value. Printed text
now joins the answers' queue. The same cell kept its order 6/6 on macOS and 8/8 on Linux, and
the local Notebook tests on Linux pass 12/12 (one skipped: Matrix absent).

**Open folder said "currently supported on macOS".** The home page has no other way to open a
folder. On a Linux desktop Rho now shows zenity's or kdialog's folder window. With a real
zenity 4.1.90 on a virtual display, selecting returned `/tmp/rho picker 中文 …/project a`
intact and Escape returned a cancel. Without a desktop session (`DISPLAY`/`WAYLAND_DISPLAY`)
it says "Rho is not running in a desktop session, so it cannot show a folder window. Open the
project from your Agent."; without either program it names them. kdialog was not run.

**A missing Core printed a stack trace.** Startup now prints only the reason, such as "This
installation has no Core for darwin-arm64; it carries linux-arm64, linux-x64. Select a Core
with --core ABSOLUTE_PATH or RHO_CORE_BINARY.", and exits 1.

## Packing

`pack:local` takes `--core PLATFORM=BINARY` once per platform. Each binary's own header must
name its platform (Mach-O/ELF/PE and the machine), so a mislabelled build cannot be packed;
a Linux Core's linkage is recorded. A `.node` addon anywhere fails packing, which keeps the
rest platform-neutral. The composition (schema 2) lists `platforms`, `packedOn` and, per
platform, `core.artifacts[PLATFORM]` with its path under `vendor/core/PLATFORM/`, digest,
size and format. Startup selects this machine's entry and checks its digest.

## Candidate

| Field | Value |
| --- | --- |
| Artifact | `rho-workspace-local-0.5.2.tgz`, 16,854,000 bytes, 5,097 files |
| SHA-256 | `e4129e7c42a39d3d7b4e718dbe25581dd1dbec7fcdfe46f383f2f9815758cdb5` |
| Platforms | darwin-arm64, linux-arm64, linux-x64; packed on darwin-arm64 |
| Application | `f95906a3`, clean |
| Plugins | `6de32b8`, clean; Notebook 0.5.1, the other packages as in 0.5.2 |
| Core | `c3dbeca`, three local builds of that commit |

Candidates 1 (`ade77bef…`, Notebook output order) and 2 (`38f4e99f…`, stack trace on a
missing Core) are superseded and kept under `work/platforms-0.5.2/`.

## Checks

Each installation ran outside every checkout, offline with an empty npm cache, with Node
22.22.3, and with a PATH that held neither Claude Code nor Codex. The browser was Chrome on
this Mac. A Linux machine's service is reached on the same loopback port through OrbStack,
as `ssh -L PORT:127.0.0.1:PORT` would reach a server.

| Check | macOS 26.7.2 arm64 | Debian 12 arm64 | Ubuntu 25.04 x64 (Rosetta) | Rocky 8.10 x64, glibc 2.28 |
| --- | --- | --- | --- | --- |
| Offline install, 80.4 MiB installed | 3.3 s | 5.5 s | 8.9 s | 8.7 s |
| Own platform's Core selected and digest-checked | Yes | Yes, static | Yes, static | Yes, static |
| Packaged recovery acceptance (base R through Core, paused, restarted) | 7 checks | 7 checks | 7 checks | Not run: no R |
| Packaged acceptance, ordinary R project | 7 checks | 7 checks | 7 checks | Not run: no R |
| Launcher ready | 0.84 s | 0.34 s | 1.03 s | 0.99 s |
| Notebook: R cells in order, Python | Yes | Yes | Yes | Python 3.6.8 only |
| Home at 1440/1024/768/390, no page errors | Yes | Yes | Yes | Yes |
| Open folder without a desktop | Not clicked (real window) | Named the reason | Named the reason | Named the reason |
| `project.doctor` | `agents: ok` | `agents: warn` | `agents: warn` | `agents`, `rscript: warn` |
| Stopped, no Core of the installation left | Yes | Yes | Yes | Yes |

On macOS the first attempt failed: the default temporary folder made the project path longer
than Core's 103-byte socket limit, a documented limit; it passed under `/tmp`, as the older
installed acceptance runs. Removing this platform from the installed composition, and changing
its digest, were each refused on macOS and Debian, and the original bytes were restored.
Screenshots taken right after a resize (768 and 390 px) showed a second header near the bottom
on every platform; the page opened directly at 390 px has one header, so it is a stale paint in
the screenshot, not the layout.

Rho passes 269/270 with the new macOS Core; the MCP v2 stdio test was again cancelled at its
30 s limit and passes alone in 25 s. Plugins pass 165/165. Contract checks pass.

## Not done

- Real Claude Code and Codex conversations on Linux: the machines have no Agent credentials.
  Only the doctor's warning for both missing clients was observed there.
- x86_64 hardware: every x64 result above ran under Rosetta.
- kdialog, Wayland, and remote sessions over ssh with the new reader.
- The rest of 0.5.1's acceptance, as for 0.5.2. 0.5.1 remains the accepted preview.
- Windows: Core `c3dbeca` keeps the Windows port; Rho needs a `win32-x64` Core for
  `--core win32-x64=…` (packed as `rho-core.exe`), and the folder chooser and other
  platform paths still say macOS and Linux.
- No push, registry publication, GitHub release or signing.

## Open items

- The Rosetta stall above.
- From 0.5.2: `rho.agent-note` is not renderable (descriptor 0.4.19, package 0.4.24); the
  Overview gives a failed answer no reason, offers "Use this answer" and counts it Answered;
  `dist/plugin-inventory.json` describes ten owners.
- Python 3 is required for the service's writer lock; minimal images without it do not start.
