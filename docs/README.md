# Rho documentation

Start with [Status](STATUS.md) for the current implementation, verification and the
stage of each part. [Development](DEVELOPMENT.md) describes how work advances: each
stage produces a real result, and the next step comes from reviewing it.
[Frontend](FRONTEND.md) describes the rebuilt application and its actual capabilities.
Frontend plans, designs and guidance written before there were results to learn from
were withdrawn on 2026-10-25; Git keeps their history.

| Document | Purpose |
| --- | --- |
| [From-scratch design requirements · v2](design/2026-10-26/index.html) / [PDF](../output/pdf/rho-design-handoff-2026-10-26.pdf) | Designer commission: separate application/project navigation, Studio, panoramic Graph, dynamic Agent experience, dedicated conversation component, plugin standards and cross-mode scenarios; current implementation is not the design target |
| [Frontend](FRONTEND.md) | Project navigation, workspaces, Agent conversations and handoff, browser checks |
| [Home and project screens](HOME-PROJECT-EPISODE.md) | The 2026-10-27 pass over home, projects and the empty project: setup, observations, changes, checks and open gaps |
| [Project sidebar and Agent canvas](AGENT-CANVAS-EPISODE.md) | The sidebar's places, Sources browsing by kind, the one Agent entry and its page of what the Agent did, and the canvas that opens what it reads and changes; runs, owner changes, checks and limits |
| [One workspace and the Graph](GRAPH-EPISODE.md) | The person and the Agent in one workspace, and the Graph of what the Agent read, changed, ran and what changed while it ran; runs, checks and limits |
| [Agents and conversations](AGENT-PAGE-EPISODE.md) | The Agents tab (version, models by provider, Claude Code's own names, settings, default) and the conversations list with usage, export and a trash; runs, checks and limits |
| [The Agent panel](AGENT-PANEL-EPISODE.md) | The 2026-10-28 pass over the conversation window: work folded under each answer, the answer's type, the message box and usage line; runs, checks and limits |
| [Agent panel live activity](AGENT-UI-EPISODE.md) | Streaming replies, per-action rows, permission and plan treatment, Markdown and reading position; observations, checks and limits |
| [An Agent's edit beside unsaved text](DOCUMENTS-EPISODE.md) | Claude Code's native edit while a person has unsaved text in Studio: the fork observed, the owner merge and Studio's follow, the Documents hook that sends the Agent to the shared buffer, real runs, checks and limits |
| [Result review and retained evidence](REVIEW-EVIDENCE-EPISODE.md) | Immutable capture, version-bound human decisions, historical Graph, offline packages and observed trials |
| [Code, Markdown and runs in a project](CODE-MARKDOWN-EPISODE.md) | Python, R and a Markdown report in the test project: what Rho showed, highlighting by language through the Documents editor, then Markdown rendering and legible Agent runs |
| [Live sessions on a server](REMOTE-EPISODE.md) | R and Python run in a folder on a server reached with ssh: places, checks, the Servers view, copies of server files and a dropped connection; the episode on a disposable server, fixes and limits |
| [Project skills](SKILLS-EPISODE.md) | How work is done in a project, kept as skills every Agent reads: recorded changes with author, reason and evidence, undo, edits outside Rho, the Skills page, and a case where the person's notes carried over to new Agents; runs, checks and limits |
| [Timeline events](TIMELINE-EVENTS-EPISODE.md) | Plugins hand the timeline who did what and when: the person's Notebook cells and Console commands in their own lane, an Agent's cells in its conversation's; the Notebook's name and what Agents take "the notebook" to mean |
| [Agent activity](AGENT-ACTIVITY.md) | Live Claude Code/dsh observations, errors, captured outputs, recovery and real-run evidence |
| [dsh-rho prototype](DSH-RHO-EPISODE.md) | Native dsh analysis, reused Rho table/figure views, a selected-row question in the original conversation, local package installation and recovery |
| [Conversation episode](CONVERSATION-EPISODE.md) | Conversations with Claude Code started in Rho, who holds a session's input, limits, real runs and their reviews |
| [Claude ACP episode](ACP-EPISODE.md) | Agent-owned ACP, real Westlake HPC multi-turn conversation, cancellation and recovery; legacy compatibility and limits |
| [Claude, Codex and external ACP](ACP-MULTI-AGENT-EPISODE.md) | Second Agent, external-client relay, shared workspace loops and installed Westlake HPC acceptance |
| [Base-R episode](BASE-R-EPISODE.md) | Real selected-row question, external Agent edit, result comparison and browser recovery; evidence, limits and the review that sets the next run |
| [What Rho-core earns](CORE-VALUE-EPISODE.md) | A real analysis run through plain tools, a 30-line convention and the Core CLI, plus two Agents on the same task: what Core costs, what only it can report, and which parts to keep, simplify or drop |
| [Plugin authoring](PLUGIN-AUTHORING.md) | Create, preview, check and select an independent UI extension |
| [magpie's frontend, studied](MAGPIE-FRONTEND-STUDY.md) | A reference project read in depth: a no-framework app shell, its click-and-scroll engine, plugin kernel, i18n and verification machinery, and candidate actions for Rho; it sets no design for Rho |
| [Architecture](ARCHITECTURE.md) | Source ownership, state and lifecycle boundaries |
| [Technology stack](TECHSTACK.md) | Libraries and runtimes used by the current implementation |
| [Roadmap](ROADMAP.md) | Product direction and the questions being worked on |
| [Headless backend](HEADLESS.md) | Installation, HTTP/SSE, Agent adapters, persistence and resource budgets |
| [Execution bridge](EXECUTION.md) | Core request identity, exit codes and Host lifetime |
| [Collaboration](COLLABORATION.md) | Conditional compositions, selections, feedback and recovery |
| [Development](DEVELOPMENT.md) | Stages, iterations, analyzing results, owner workflow and checks |
| [macOS 0.5.1 preview](PREVIEW-0.5.1.md) | Fixed unsigned artifact, selected components, installation, acceptance and limits |
| [0.5.2 on macOS and Linux](PLATFORMS-0.5.2-EPISODE.md) | One tarball with a Core per platform: Core's Unix repair, the Rosetta stall, the Linux Notebook and Open folder, installation on four systems, and what is unverified |
| [0.5.2 on Windows](WINDOWS-0.5.2-EPISODE.md) | Core with MSVC, a Host that outlives Rho and stops with its report, the Plugins on Windows, the Windows candidate installed and checked |
| [Packing 0.5.2](PACKAGE-0.5.2-EPISODE.md) | The 12 MB candidate without bundled Agent clients: what 0.5.1 carried, owner changes, a missing client named, offline installation, real Claude/Codex runs and open items |
| [Release](RELEASE.md) | Source publication and distribution |
| [Research positioning](https://github.com/YuLab-SMU/Rho-paper) | Purpose-driven scientific workspaces: plugin capabilities, material and view composition, human understanding and Agent context; the paper and its annotated positioning record live in the Rho-paper project (written in Chinese) |

The following records retain their historical backend or component scope. They do
not impose layouts, colors or frontend process requirements:

| Record | Scope |
| --- | --- |
| [Backend plan](BACKEND-FIRST.md) | The original headless implementation packages |
| [Backend acceptance](BACKEND-ACCEPTANCE.md) | Selected installed backend composition and limits |
| [Extraction plan](PLUGIN-EXTRACTION.md) | Reusable component extraction |
| [Extraction acceptance](EXTRACTION-ACCEPTANCE.md) | Versioned public APIs and two R consumers |
| [Plugin split acceptance](PLUGIN-SPLIT-ACCEPTANCE.md) | Independent component packages |
| [Plugin boundary acceptance](PLUGIN-BOUNDARY-ACCEPTANCE.md) | Owner contracts and selected dependencies |
| [Collaboration acceptance](COLLABORATION-ACCEPTANCE.md) | Shared state, Agent replies and recovery |
| [Contract acceptance](CONTRACT-ACCEPTANCE.md) | Generated public contract checks |

Repository policies cover [contributions](../CONTRIBUTING.md), [privacy](../PRIVACY.md),
[security](../SECURITY.md) and [artifact trust](../CODE_SIGNING_POLICY.md).
Execution belongs to [Rho-core](https://github.com/YuLab-SMU/Rho-core); functional
component APIs belong to [Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins).
