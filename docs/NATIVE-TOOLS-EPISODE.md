# Native tools, with Core selected when needed

Updated: 2026-10-29. The user selected this change after the
[corrected Iris comparison](CORE-VALUE-EPISODE.md).

## What changed

The comparison retained its measurements and original protocol. Its assertions
that a Python executor cannot launch compiled programs, that Rho cannot execute
arbitrary R, and that the small shell helper supplies equivalent guarantees were
corrected. The measured language choices and timings do not isolate Core's causal
effect. Output spooling remains a plausible cost, not an isolated benchmark.

Agents normally use native tools under their existing permissions. Core managed
execution is chosen when a concrete operation needs continuity or a retained
application record. Activity observation and honest partial/unknown facts remain.

- The compatibility Claude CLI driver no longer passes `--tools ''`,
  `--strict-mcp-config` or `--permission-mode dontAsk`. It keeps native tools,
  configured MCP servers and native permission settings. The existing project
  grant still covers only the four Rho MCP tools. No permission bypass was added.
  Its noninteractive entry cannot answer a new native permission request; ACP
  continues to offer those choices in the application.
- ACP already exposed native tools; its execution and permission paths are
  unchanged by this work. MCP discovery and the managed R skill now explain that
  these workspace capabilities supplement native tools.
- The default launcher can start without a discovered Core binary. A bad explicit
  selection or invalid bundled artifact is still an error. A missing Core is
  reported when managed execution or Host activity is selected; no alternate run
  is substituted. General project diagnosis treats missing R as an optional-entry
  warning; the managed `run-r` intent still requires its prerequisites.
- Existing managed requests, output, cancellation facts and unknown outcomes keep
  their behavior. Native actions do not gain managed acceptance, deduplication or
  scientific validity merely by being observed.
- The three owners' development guidance now makes this execution choice explicit.
  Dependency direction and identity-generation location are reviewable mechanisms;
  existing accepted identities and honest facts remain protected.

## Checks and actual result

Evidence is retained in `work/native-tools-20261029/` in the Rho checkout.

- Agent and R plugin TypeScript builds passed; application service and web builds
  passed. The focused runtime, diagnosis and compatibility-conversation checks
  passed 11/11. The complete serial application suite passed 223/223; the plugin
  suite passed 104/104, including retained activity and execution consumers.
- New checks cover missing optional Core, rejection of a missing explicitly
  selected binary, native output visible in Documents without a managed record,
  absence of a Host, and unchanged missing-prerequisite handling for managed work.
  The compatibility process fixture checks that Rho neither disables native tools
  nor supplies a permission override; original conversation recovery remains covered.
- A real Claude CLI conversation, using the existing test model
  `westlakehpc/deepseek-v4.1-flash`, ran `node native-probe.cjs` with native Bash in
  a disposable project. The script compiled a small C program and ran it. The
  retained reply and the actual file contained `NATIVE_C_OK`; no Core binary was
  configured, no Host socket appeared, and no application operation was created.
  A temporary native settings file allowed only that exact test command; no user
  settings or credentials were changed. The owned service and project were removed.
- Chrome opened the project and Agent panel without Core. Initial screenshots
  caught loading/new-conversation state; the follow-up waited for the loaded project
  and selected the retained answer. The desktop (1440 × 900) and narrow (390 × 844)
  screenshots were inspected: the native command, answer and input are visible;
  no browser errors were reported. This is a functional check, not a usability study.
- Documentation checks found no broken local links or anchors in 290 references.
  All 64 rendered browser pages were inspected, including the two status snapshots
  prepared for commit without unrelated edits. Later wording fixes were rerendered
  and affected pages checked; unchanged observations were reused.

Initial test failures were retained: one new fixture embedded a literal newline in
JavaScript, one read `text` instead of Documents' `content`, and an older diagnosis
assertion still treated optional R as a global failure. These were corrected and
the affected checks passed before the complete suite ran.

## Scope

This is a source-working-tree check alongside unrelated ongoing changes; it is not
an accepted clean package composition, installation or release. No user Host or
R session was restarted. Core execution code and its compiled contract documents
were not changed, so Cargo checks were not rerun. Existing managed-only acceptance
cases still test their explicitly selected path; they do not prescribe an Agent
default. Output coalescing, revised log completeness and snapshot path semantics
remain separate work. The original Iris experiment was not rerun or regraded.
