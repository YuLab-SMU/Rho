# What Rho-core earns on a real research task

Updated: 2026-10-29. Full evidence:
`work/core-comparison-20261029/` (protocol, harness, raw records, two agent arms).

## Why this was run

Rho's managed action path uses Core's public CLI and registers one executor (R)
and one action (`r.execute`, which runs a user-supplied script). Agent native tools
are a separate path; the experiment explicitly required its managed arm to use Core. That
made it worth asking whether Core's execution abstraction helps real research work
or merely constrains it. The question was put as a controlled comparison, with
"Core is not needed here" allowed as an outcome.

The task reused the existing scientific pilot (Iris sepal length, exact label
permutation, *k* = 10/15/16 observations per species), whose answers are
independently derivable by subset-sum DP. Every arm was graded against that
independent answer, never against its own output.

## What was measured

Three execution channels, same worker code and data:

- plain foreground tools; a 30-line shell convention (`mkdir` guard, detached
  child, stdout log, exit file); the resident Core Host through its public CLI.

All nine scripted runs matched the independent answer on every field; no
scientific difference was observed in these runs. What differed:

| at k=15 (~37 s of work) | wall time | protocol bytes | caller commands |
| --- | --- | --- | --- |
| plain tools | 36.9 s | 0 | 1 |
| 30-line convention | 38.8 s | 68,617 | 41 |
| Core | 42.6 s | 77,394 | 4 |

- **The measured Core run was slower.** 42.4 s against 36.9 s was not explained
  by `python -u` alone (a plain `-u` run took 37.6 s). The k=16 run wrote exactly
  4,096 blobs, 4,079 under 100 bytes, matching the 44-byte progress lines. This
  identifies output spooling as a candidate cost; no coalesced-output comparison
  or release-build benchmark isolated its share.
- **That also hit the retention limit**: `observed 263454`, `retained 181141`,
  `truncated true`, with `retention_error` naming the chunk cap. The loss was
  reported — but a client reading `more_retained` alone (mine did) reads a
  truncated log as complete.
- **Faults.** Two concurrent identical intents: plain tools ran it twice (the
  second died on its own guard), the convention and Core dispatched once. Waiting
  caller killed 8 s in: plain tools lost the work; convention and Core kept it,
  one recovery command each. Owner killed with -9: plain tools had nothing, the
  convention reported `status=running pid=… alive=no` (contradictory), Core
  reported `Gone{evidence: MainPidAbsent, group_released: true}`, kept the record
  and did not re-dispatch.

The convention reproduced survival and single dispatch in these fault cases.
That does not establish equivalent durability, conflicting-request handling or
crash-window guarantees. It did not produce the evidence-carrying outcome fact
on which Rho's status mapping depends.

## Two agents, same task

Same model, same directory, same question and output contract. The plain arm used
ordinary tools; the managed arm had to compute through a `python`-only Host.

| | plain | managed |
| --- | --- | --- |
| commands | 10 | 29 |
| wall time | ~35 min | ~60 min |
| computation for the answer | 1.7 s (C, two independent traversals) | 46.6 s (Python) |
| answer | exact | exact |

The plain arm compiled a C enumerator; the managed arm chose Python. The original
report incorrectly attributed this difference to an inability to run compiled
programs. A Python executor can invoke a compiler and its output through
`subprocess`; a check with the same debug binary, a disposable Host and only a
Python executor did exactly that, with exit 0 and retained child output. The R
plugin likewise runs arbitrary user R scripts, prefixed with `.libPaths`; its
action catalog is not a catalog of permitted scientific methods.

The observed ratios describe these runs, not a forced language restriction or
a causal estimate of Core's cost. Neither fault landed: the native computation
finished before 8 s, while no managed client waited long enough to trigger it.
The agent arms therefore supply no comparison of recovery behavior.

One managed run of seven was also lost because Core executes a content-addressed
*copy*: inside the run `__file__` points at `.rho/blobs/sha256/…` and
`Path(__file__).parent / "data.csv"` fails, while `cwd` is the project. Verified
directly. Snapshotting is defensible; making the snapshot the code's working
identity is a small redesign of the agent's program.

## Decision

- **Keep**: activity observation (it has a consumer — `agent.activity.read`,
  `capture`, `outputs`); the honest-fact model for operations the application
  records; identity-keyed dispatch where an operation record already exists.
- **Simplify**: coalesce output spooling into larger blobs; make truncation
  impossible to misread; stop making the managed path the only path for agent
  computation; either make the script's path identity ordinary or say plainly in
  the contract that `__file__` is a blob.
- **Drop**: the requirement that agent computation routes through Core by default.
  The managed arm used 2.9× the commands, 1.7× the wall time and a 28× slower
  implementation in this comparison. Those observations warrant examining the
  interface and guidance; they do not prove Core required that implementation.
  Native tools are the normal path; select managed execution for a concrete need.

## Correction and follow-up

On 2026-10-29 the report's claims about compiled programs, arbitrary R, equivalent
guarantees and performance causality were corrected. Original measurements and
the prewritten protocol are retained; they were not rerun or regraded. The user
selected removal of mandatory managed execution from code, documentation and
development constraints, retaining activity observation and honest facts.

## Limits

One scenario, one model, one run per agent arm; it shows mechanisms and costs,
not rates. The Core binary was the local debug build of 2026-10-26, later only by
the Windows port. The managed arm used a `python` executor I registered, whereas
Rho's managed entry selects R. Both interpreters can launch other programs; the
product was not measured, and no ordering of their costs follows from that choice. Nothing here speaks to irreducibly long analyses (MCMC,
alignment, large model fits) — Core's survival guarantees are most plausible
exactly there, and should be kept cheap enough to be worth having when they are
needed.
