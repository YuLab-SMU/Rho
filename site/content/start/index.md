# Install and open a project

Rho is a local service with a WebUI. It runs on your machine, in a folder you choose,
and it talks to an Agent client you already have. Nothing is sent to a Rho server,
because there is no Rho server.

## Requirements

| Requirement | What Rho needs |
| --- | --- |
| Node | `>=22.22.0 <27`: the 22, 24 and 26 LTS lines. The checked baseline is Node 22.22.3 with npm 10.9.8; the test suite and the installed check also passed on 24.22.2 and 26.13.0. |
| R | Only for R work. The service, documents, readers and saved results work without R; a missing `Rscript` reports an unknown dependency probe instead of pretending. |
| R packages | Yours to install. Rho does not install project packages implicitly. |
| Agent client | Rho's Agent panel drives your own Claude Code or Codex. DeepSeek Harness can connect as an external Agent through the [dsh-rho plugin](/reference/deepseek-harness). |
| Python | Only for the file writer lock on platforms that need it. Windows does not. |

macOS arm64 is the checked baseline. Windows x64 was checked with Node 22.23.4 and Rscript 4.5.1;
Linux x64 and arm64 carry platform installs. On macOS x64 the application starts only under
Rosetta.

## Or ask your Agent

Paste this into Claude Code or Codex:

> Read https://yulab-smu.top/Rho/doc/setup.md and follow its steps to install and configure Rho for me.

The [setup page](https://yulab-smu.top/Rho/doc/setup.md) holds every command, so you can read it
first. Your Agent checks the requirements above and looks for a Rho that is already there, then
installs the package, starts Rho on `~/Rho/projects` and `~/Rho/state`, adds the Rho Skill to its
own skills folder, connects itself to the example project and tells you what is missing.

## Install from npm

```sh
npm install -g @rho-workspace/rho
```

If the global prefix belongs to root, this fails with `EACCES`; installing it with `sudo` was
performed and worked. The package declares its Node range, so a Node outside it prints one
`EBADENGINE` warning rather than failing silently.

## Start the service

```sh
rho
```

From 0.5.4, `rho` with no arguments uses `~/Rho/projects` and `~/Rho/state`. It creates both,
copies the example project into a new state, and prints the address to open, the two folders and
whether your Agent client and R were found. 0.5.3 prints its usage instead. To choose the folders
yourself, on any version:

```sh
rho --root /absolute/projects --state-dir /absolute/service-state
```

Create the projects directory first. Keep service state outside it, so a project stays an
ordinary folder. Startup prints the loopback URL and the location of the connection file — never
the credential. Opening that URL in a browser on the same machine is the access: a same-origin
request from loopback is answered as the local person, with no link, no code and no expiry.

A one-time link is available when a tab must be narrower or must expire:

```sh
rho --pair
```

That link is a credential with a five-minute window and a single use.

## Open the example project

A new state copies the bundled `example/pa14-qs` project into your projects folder once, as an
ordinary editable project. Open it, then ask the Agent a question about one of its figures or a
selected row of a result table.

## Use DeepSeek Harness

The [dsh-rho plugin](/reference/deepseek-harness) connects Harness to an existing
Rho project. Its **Rho** tab and sidebar entry open the complete Rho in Harness
Desktop's Browser pane; Web Harness uses a separate browser window. Analyse in the
shared Notebook, inspect a result in Rho, then copy a selected-row question back
to the same Harness conversation. The guide covers the public prebuilt 0.1.3 Git
package and market index, project grant, installation and connection recovery.

## What to read next

- [Headless backend](/reference/headless) — HTTP, SSE, Agent adapters, persistence and budgets.
- [Architecture](/concepts/architecture) — which repository owns what.
- [Status](/reference/status) — what has been checked, what is limited, and what remains open.
- [Troubleshooting by evidence](/records/ci-episode) — the CI episode records the install failures
  that were actually hit, with the fix that worked.
