# Claude, Codex and external ACP sessions

The 2026-10-27 request extended the first shared-workspace loop with a second
Agent, external ACP sessions and fresh installation acceptance. Changes were
implemented together, then verified and committed as one batch per owner.
Westlake HPC remained the model provider. Core source and its selected binary
were not changed or rebuilt.

## Implemented ownership

Agent 0.4.10 shares the ACP v1 connection driver between Claude and Codex, with
provider-specific executable/configuration wrappers. Claude remains on adapter
0.97.0; Codex uses the official `@agentclientprotocol/codex-acp` 2.3.0 and its
native Codex 0.164.0. Rho's new-conversation selector records the chosen backend
under the original message identity. Retry, a changed default and restart cannot
migrate that conversation to another Agent.

Connection-level plans, usage, titles and tool references feed the same Project
work surface and Documents notes owner. Standard ACP diff paths are also file
references, without retaining old/new file contents. Current file hashes remain
independent observations; they do not establish authorship or domain correctness.
Normal shutdown uses advertised `session/close` before ending the owned transport.
Process-group escalation remains active even after the adapter wrapper exits.

An external client selects `rho --acp /absolute/project --acp-agent codex`
(`claude` is also supported) as its Agent command. It can load an existing native
session. The relay forwards unchanged stdio bytes, observing only the selected
project into `.rho/agent/acp/`. Input, permissions and runtime lifetime stay in the
original client. Project work reads the same projection without starting an Agent
or Host, with a separate `external-acp` source identity and sequence. Rho shutdown
does not stop that external session. The visible work surface polls its own read
every 1.5 seconds because external updates do not advance Rho's application cursor.

This accepts explicit ACP v1 relay attachment, not passive attachment to an
uninstrumented running client. ACP v1 does not define that generic capability.
Claude/dsh transcript collection remains the existing fallback; it is neither
removed nor relabelled as ACP. External-session real-model acceptance here uses
Codex; the Claude relay branch has component coverage.

## Verification setup and failures retained

Node 22.22.3 and Chrome 155.0.8059.84 run disposable projects and owned processes.
Credentials are read from existing local configuration into child environments;
reports and source contain no gateway address or credential. Codex uses an isolated
native home and a Responses provider named Westlake HPC with
`westlakehpc/deepseek-v4.1-flash`, workspace-write mode, native
`tools.update_plan.enabled=true` and `features.apply_patch_freeform=true`.
The provider does not supply Codex model metadata; reported context capacity is
native fallback metadata, not a verified Westlake context-window limit.

The batch exposed and retained these failures before final acceptance:

- Codex's native plan tool defaults off. The harness now explicitly enables it;
  prose is never converted into a fabricated ACP plan.
- A real Codex cancelled response can leave a native shell command alive, even
  when the model requested a long foreground yield. The UI says the turn was
  cancelled and unfinished tools may still run. Codex checks record native PID
  state separately; any harness cleanup of its own gate is labelled, not counted
  as product termination evidence. Claude's foreground-exit evidence is separate.
- Killing/closing only the adapter wrapper could leave native session ownership
  temporarily occupied. Advertised session close and complete owned-group shutdown
  address normal release; no competing writer is evicted or new session invented.
- Codex emitted file paths in standard diff content without `locations`. The owner
  now retains those references, and tests ensure file contents are excluded.
- A read immediately after Rho restart hit a stale HTTP socket. The external
  harness retries only that read, never a prompt or tool action.
- One MCP test timed out under concurrent load, then passed alone. A later run
  overlapped generated/build output and failed to import incomplete modules. Those
  runs are not accepted; the completed-build application run passed all 192 tests,
  and the final Agent owner run passed all 89. Contract/type checks also passed.
- Earlier live runs include a provider turn reaching the existing wall limit.
  Their partial/unknown/stopped results remain in the local reports.

Detailed failed attempts are retained under `work/acp-codex-source*`,
`work/acp-external-source*`, and `work/acp-multi-tests*.log`. Component evidence is
`work/acp-multi-tests-verified.log`, `work/acp-multi-contracts-complete.log` and
`work/acp-multi-final/owner-tests.log`. These checks do not establish
human usability, all ACP update displays, a cross-resource revision or remote ACP
transport support. The application still owns selection and linked observations;
the model loop and native tool execution remain outside Rho.

## Installed acceptance

The selected unsigned local package is
`work/acp-multi-final/rho-workspace-local-0.4.0.tgz`, SHA-256
`f9ce8435d134b7213bcd40e174abc985ab26e8af45a874ededcbcf8a5a811caf`.
Its composition records explicit dirty-source build-input overrides; the final
source association is recorded separately without altering the accepted tarball.
Core is the digest-verified existing binary
`434a92fced13595d281b1f9e2d6d49cf9fa7c8a451da08aa3c1ba86cec85eab3`.
No Core build, source edit or Host startup was needed by these Agent episodes.

The package was installed at `/tmp/rho-acp-installed-h7aADQ`, outside all three
source checkouts. Real-model harnesses resolved the service, clients, browser assets,
Agent, ACP adapters and their SDK/native dependencies from that installed package.
The same immutable artifact passed:

| Check | Observed result | Local evidence |
| --- | --- | --- |
| CLI installation and startup | Passed; bundled Core digest matched; four viewport widths, zero remaining Hosts | `work/acp-multi-install-smoke/report.json` |
| Claude Code 2.1.311 | Eight turns, nine checks; lost send ACK, shared context/MCP, browser loss, cancellation, transport loss, same-session load, Rho restart and saved human notes applied to result bytes | `work/acp-installed-claude/report.json` |
| Codex 0.164.0 | Same eight-turn loop and nine checks, including native plan/file references and original permission choices | `work/acp-installed-codex/report.json` |
| External Codex ACP | Three checks; pre-existing external session loaded through relay, live plan/result observation during Rho restart, reconnect with unchanged identity/context and one gate invocation | `work/acp-installed-external/report.json` |

Both conversation sequences ended `completed, completed, completed, stopped,
unknown, completed, completed, completed`. The interrupted fifth prompt was never
replayed. Claude's cancelled foreground command exited. Codex's cancelled turn left
its foreground gate alive (`Ss`); the harness explicitly sent SIGTERM to its own
test PID and labelled that cleanup. This is accepted turn cancellation with an
unconfirmed native job, not a claim that Codex stopped every native process.

Screenshots were inspected at desktop and phone sizes, including permission,
unknown-outcome, notes and external-input states. Immediate work snapshots can
still show the preceding state until the next bounded read. Read-only reload
screens were captured after waiting for `Last message answered`, preserving the
same session/version without starting an Agent. The documents editor's existing
Claude-specific edit-toggle wording and raw Markdown transcript display remain
UI limitations; this batch does not claim human usability.

To rerun against a separately installed package:

```sh
node scripts/acp-episode.mjs --agent claude --work --package-root /absolute/install/node_modules/@rho-workspace/local
node scripts/acp-episode.mjs --agent codex --work --package-root /absolute/install/node_modules/@rho-workspace/local
node scripts/acp-external-episode.mjs --package-root /absolute/install/node_modules/@rho-workspace/local
```

Use `RHO_ACP_EVIDENCE` to select each report directory. The existing local provider
configuration supplies credentials; no credential is required in these commands.
These checks accept a local macOS arm64 npm artifact. Registry publication,
signing, remote ACP transport and additional platforms remain separate.

## Observation limits

External records retain at most 64 sessions, 512 KiB per record and 8,192 characters
of the latest visible reply. Pending requests/permissions and pre-identity updates
are each capped at 128; pre-identity bytes are capped at 512 KiB and parsed transport
lines at 4 MiB. Projection failure keeps old evidence and allows the original
transport to continue. Unsafe setup directories refuse before writing outside the
project. A dead relay PID or expired ten-second heartbeat lease makes observations
disconnected and unfinished outcomes unknown. Reads scan at most 256 entries.
Project work shows at most eight external sessions (connected first, then recent),
counts omissions and retains each source's own version. Existing plan/tool/file
limits remain in the [Agent README](https://github.com/YuLab-SMU/Rho-plugins/blob/main/plugins/agent/README.md).
