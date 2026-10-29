# Rho execution bridge

This bridge covers explicitly selected managed operations and Host activity.
Agents normally use their native tools under existing permissions. Their native
work does not need a Core Host or a managed operation record. Activity observation
can retain selected external evidence without taking over execution. Existing
managed records keep the identity, continuity and honest facts described below.

Rho reaches [Rho-core](https://github.com/YuLab-SMU/Rho-core) only through its
documented public CLI. Core owns the managed execution contract and the resident
Host. The first-release local Rho service invokes that CLI; the browser WebUI uses
the service's scoped application operations. This document owns the application
side of that boundary: request identity, the exit-code state machine, Host lifetime
and bounded observation. The [backend plan](BACKEND-FIRST.md) selects versioned
HTTP JSON and SSE for the application service; concrete authentication and library
versions remain to be implemented under the
[technology boundary](TECHSTACK.md#local-service-and-workspace).

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
  timeout, browser refresh, view crash, service crash or reconnect never mints one.
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
| 3 | Not delivered: no Host, Host busy, refused or protocol mismatch; no effect | Retry later with the same identity; starting a Host is a separate authorized lifecycle action |
| 4 | Sent but no reply; the request may have executed | `lookup` the same identity, or resend the same identity; never a new one |

Code 4 is the reconnection case the product must show honestly: the task may
exist. Rho queries the original identity and displays the actual facts, including
an unknown outcome, instead of starting fresh work.

## Host lifetime

The local Rho service owns the lifecycle of Hosts it starts. An existing Host
retains its original owner. No browser tab, view, window or Agent session owns a
Host, and none of their lifetimes is a reason to stop or restart it.

- At service startup Rho uses the public CLI's `capability` command to
  observe a Host at `state_dir/host.sock` and check its project. An existing Host
  is reused without transferring lifecycle ownership. A second Host on the same
  `state_dir` would fail at the storage lock, so Rho does not start one.
- If no Host exists, an authorized service/project start can start
  `rho-core serve --project ... --state-dir ...`, read the single `ready` JSON line
  and hold the child process. A browser observation or reconnect alone does not
  start a Host or recover a native session.
- The state directory is `.rho/` inside the project, already listed in `.gitignore`.
  One Host serves one project. An existing Host on a project is adopted, never
  replaced.
- On explicit service exit Rho sends SIGTERM only to a Host it started and reads
  that child's `shutdown` report. It releases observation of an existing
  Host without stopping it; stopping that Host requires existing authorization
  covering its shutdown. Host shutdown, task cancellation and confirmed native
  stop stay separate operations with separate effects in the interface.
- Browser close, refresh, connection loss and view failure release observation
  and rendering only. They do not stop the local service or Host, cancel a task or
  restart an R session. A later desktop client's view closure has the same boundary.
- A service crash is not a confirmed Host shutdown or native stop. Preserve the
  original request identity and any partial/unknown outcome. After a service
  restart, inspect the existing Host and original request through the public CLI;
  do not automatically repeat execution or claim native-session recovery.

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
