# Install and open a project

Rho is a local service with a WebUI. It runs on your machine, in a folder you choose,
and it talks to an Agent client you already have. Nothing is sent to a Rho server,
because there is no Rho server.

## Requirements

| Requirement | What Rho needs |
| --- | --- |
| Node | `>=22.22.0 <23`. The checked baseline is Node 22.22.3 with npm 10.9.8. |
| R | Only for R work. The service, documents, readers and saved results work without R; a missing `Rscript` reports an unknown dependency probe instead of pretending. |
| R packages | Yours to install. Rho does not install project packages implicitly. |
| Agent client | Claude Code or Codex, installed and signed in by you. Conversations drive your client under your own permissions. |
| Python | Only for the file writer lock on platforms that need it. Windows does not. |

macOS arm64 is the checked baseline. Windows x64 was checked with Node 22.23.4 and Rscript 4.5.1;
Linux x64 and arm64 carry platform installs. On macOS x64 the application starts only under
Rosetta.

## Install from npm

```sh
npm install -g @rho-workspace/rho
```

If the global prefix belongs to root, this fails with `EACCES`; installing it with `sudo` was
performed and worked. The package declares its Node range, so a different Node prints one
`EBADENGINE` warning rather than failing silently.

## Start the service

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

## What to read next

- [Headless backend](/reference/headless) — HTTP, SSE, Agent adapters, persistence and budgets.
- [Architecture](/concepts/architecture) — which repository owns what.
- [Status](/reference/status) — what has been checked, what is limited, and what remains open.
- [Troubleshooting by evidence](/records/ci-episode) — the CI episode records the install failures
  that were actually hit, with the fix that worked.
