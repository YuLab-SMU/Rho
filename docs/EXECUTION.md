# Rho execution bridge

Rho reaches [Rho-core](https://github.com/YuLab-SMU/Rho-core) only through its
documented public CLI. Core owns the managed execution contract and the resident
Host. This document owns the application side of that boundary: request identity,
the exit-code state machine, Host lifetime and bounded observation.

[Architecture](ARCHITECTURE.md) defines ownership; [Status](STATUS.md) records
implementation; [Roadmap](ROADMAP.md) selects the flow that exercises it. The
authoritative Core documents are
[Managed run](https://github.com/YuLab-SMU/Rho-core/blob/main/docs/MANAGED-RUN.md)
and [Host CLI](https://github.com/YuLab-SMU/Rho-core/blob/main/docs/HOST-CLI.md).
Where this document and Core differ, Core's contract governs.

## Request identity

An identity is a caller name plus a request id. Each is 1–128 characters from
`[A-Za-z0-9._:@-]`.

- Rho mints the request id once, before the first submit of a logical action, and
  persists it with that action's record.
- The identity names one request for one caller. Submitting the same content again
  returns the original run and dispatches nothing; different content under the
  same identity is a conflict.
- A new identity is created only for deliberately new work. A lost reply, a wait
  timeout, a view crash or a reconnect never mints one.
- The caller name is an application namespace, not a user or a security principal.
  Core caller namespaces are not authenticated.

## Exit codes

Each CLI call maps to an explicit application state. This mapping is the single
place where "do not replay" becomes mechanical rather than a policy sentence.

| Code | Meaning | Rho action |
| --- | --- | --- |
| 0 | The Host executed the request | Read `value`; after `wait` the run may still be active |
| 1 | The Host answered an error, or an over-limit request was not sent | Act on `error.kind` and `message`; do not resend unchanged |
| 2 | Usage error, nothing sent | Application defect; surface it |
| 3 | Not delivered: no Host, Host busy, refused or protocol mismatch; no effect | Retry later or start a Host; the identity is unchanged |
| 4 | Sent but no reply; the request may have executed | `lookup` the same identity, or resend the same identity; never a new one |

Code 4 is the reconnection case the product must show honestly: the task may
exist. Rho queries the original identity and displays the actual facts, including
an unknown outcome, instead of starting fresh work.

## Host lifetime

The application owns the resident Host. No view, window, Agent session or renderer
owns it, and none of their lifetimes is a reason to stop or restart it.

- At startup the main process probes `state_dir/host.sock`. A Host that answers is
  adopted. A second Host on the same `state_dir` would fail at the storage lock, so
  Rho does not start one.
- Otherwise Rho starts `rho-core serve --project ... --state-dir ...`, reads the
  single `ready` JSON line and holds the child process.
- The state directory is `.rho/` inside the project, already listed in `.gitignore`.
  One Host serves one project. An existing Host on a project is adopted, never
  replaced.
- On application exit the main process sends SIGTERM and reads the `shutdown`
  report. Host shutdown, task cancellation and confirmed native stop stay separate
  operations with separate effects in the interface.
- Renderer failure, view close and popout do not stop the Host, cancel a task or
  restart an R session. They release observation and rendering only.

Reads are bounded observations. A read never starts or recovers a Host or a native
session.

## Bounded observation

Rho renders only what Core retained. `read` returns `offset`, `next_offset`,
`more_retained` and `lossy`; the application keeps them so a truncated or lossy
stream is visible rather than silently completed. Retained process output is an
execution observation, not a scientific artifact. Scientific artifacts are
ordinary files that the component owns, with its own manifest and checks.

Execution completion, artifact integrity, domain checking and model explanation
are separate facts and remain separately visible.
