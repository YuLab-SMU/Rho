# Literature reproduction as an application test

2026-11-02. Five real analyses from the 97 fully-open papers of the
`clusterprofiler-articles` corpus, reproduced through Rho 0.5.2 in one local service:
the Agent wrote and ran R in Rho's Notebook sessions, Rho captured the files, notes,
commands and figures, and I reviewed what each screen showed. This record keeps what
was asked, what actually ran, what Rho did well, what broke, and what is still open.
No Rho source changed in this pass (the request was to test and record, not to fix).

## Setup

| Part | Value |
| --- | --- |
| Rho | source checkout `main` at `64d73550`, version 0.5.2, `dist/` built |
| Service | `node dist/cli.js --root work/literature-repro/projects --state-dir work/literature-repro/state --example off --port 0` |
| Core | not installed in this checkout (`core_unavailable`); every run here used native jobs and the Notebook's own R sessions |
| Machine | macOS arm64, Node 22.22.3, R 4.5.2 with clusterProfiler 4.19.6, DESeq2 1.48.2, limma, edgeR, Seurat, org.Hs.eg.db, org.Mm.eg.db, fgsea; `msigdbr` absent |
| Agent | Claude Code 2.1.316 through `claude-agent-acp` 0.97.0, model reported as "Claude Haiku 5.5 · fusecode-lab", effort **Medium** per conversation, mode Manual |
| Projects | five disposable folders, each with the paper's GEO data and a `README.md` stating the analysis and the required outputs |
| Person's role | answering each native permission request, then reviewing Overview, Studio, Graph, Notebook and the exported transcript |

Data were downloaded before the runs (GEO supplementary files, 1.4–241 MB) so that a
flaky network would not be confused with Rho behaviour. Sample metadata came from the
GEO series matrices; where GEO had none (the DSP series) the analysis was adapted and
the record says so.

## The five runs

| Project | Paper (group) | Data | Rho outcome | Turns | Wall | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | PMC12092710, *Nat Commun* (A1 bulk) | GSE274459 counts, 17 samples | complete in one turn, all outputs | 1 | 29 min | $0.296 |
| P2 | PMC10154214, *Nat Aging* (A2 single-cell) | GSE221215, 11 × 10x H5, 241 MB | stopped on a wait for an event, then 3 continuations; tables, UMAP, findings done, no KEGG dotplot (no pathway) | 4 | ~8+2+8+2 min | $0.057 + $0.037 |
| P3 | PMC10923916, *Nat Commun* (spatial, GeoMx DSP) | GSE232853, 578 AOIs, 44 MB | 64-turn stop, then two continuations; complete | 3 | 14+3+6 min | ~$0.03 |
| P4 | PMC11763620, *iScience* (B3 bulk + metabolome) | GSE270697, 7 kallisto runs | 64-turn stop, then complete | 2 | 14+6 min | $0.491 + |
| P5 | PMC11866441, *Cell Rep Med* (C multi-omics) | GSE252990, 120 samples | complete in one turn, all outputs | 1 | 11 min | $0.046 |

Two of five finished in a single turn. The other three needed 2–4 turns, and every
extra turn was caused by the Agent stopping for a reason of its own (a client turn cap,
a wait for an event) rather than by the analysis being hard.

Every project's script ran inside Rho's shared R session (`kernel.run`), not in a shell,
and the recorded activity shows how the calls were spent:

| Project | Recorded calls | `kernel.run` | `kernel.read` | `capability.index` | `kernel.interrupt` |
| --- | --- | --- | --- | --- | --- |
| P1 | 35 | 13 | 17 | 1 | 1 |
| P2 | 77 | 21 | 17 | **36** | 0 |
| P3 | 50 | 14 | 18 | 11 | 2 |
| P4 | 56 | 24 | 10 | 19 | 1 |
| P5 | 10 | 7 | 0 | 2 | 0 |

All of these returned; nothing was refused at Rho's boundary. P2's 36 `capability.index`
calls are the largest single cost after its runs, and P3/P4's 11 and 19 are the same
pattern: an Agent looking for what it may do instead of doing it.

### What the reproductions found

- **P1** Four DEG and reversal counts, none matching the paper: 1096 up / 1549 down
  against 1193 / 869, and 334 / 551 reversed against 417 / 293. The Agent recorded
  three alternative definitions in `reversal_alternatives.csv` (joint model, sign-only,
  adjusted p) rather than tuning one to fit. GO BP for the reversed-up set gave
  potassium ion transport (adj. p 0.0059) and CAMKK-AMPK signalling; the reversed-down
  set gave neuropeptide signalling (4.5e-7) and muscle system process.
- **P4** 604 DEGs at the paper's threshold (370 up / 234 down) against the paper's 500
  (406 / 94), with a three-way sensitivity table over annotation and filtering. GSEA
  put oxidative phosphorylation, mitochondrial translation and ribosome highest **lower**
  in old endothelial cells.
- **P5** The matrix holds 40 patients (23 responders / 17 non-responders), not the
  trial's 54 (31 / 23). The responder contrast gave **0 DEGs** at FDR 0.05 and therefore
  no ORA terms and no dotplot; the paired on-treatment contrast gave 2596 DEGs and 290
  enriched GO BP sets by fgsea.
- **P3** CD68-vs-CD20 DE reproduced (1111 DEGs in the paired analysis, 1112 paired-only,
  1116 unpaired), with the marker check; the Hallmark ORA and its dotplot were the part
  that kept being deferred.
- **P2** The reproduction came closest to the paper's scale: 92,597 nuclei after QC
  against 95,156, and 25,999 genes against 25,890. Louvain gave 31 clusters, annotated
  into excitatory 40,671, inhibitory 18,849, oligodendrocyte 17,457, unresolved 8,364,
  astrocyte 2,699, microglia 2,503, OPC 2,054. The excitatory PS19-fE4 vs PS19-fE3
  contrast gave 4,113 genes at adjusted p < 0.05 and |avg_log2FC| ≥ 0.1. Its own findings
  call that set large for the cut-off and note the uneven groups (8,533 PS19-fE3 against
  20,832 PS19-fE4 excitatory nuclei); the top hits are unnamed or non-coding features
  (AY036118, Gm47283, AC149090.1) and `enrichKEGG` returned **no pathway**. On this
  evidence the arm shows a technical signal rather than a biological one.

## What Rho did well, with the evidence

| Behaviour | What I saw |
| --- | --- |
| Project isolation | Five projects in one service; each conversation reached only its own project, its own R session and its own files |
| Shared live session | The Agent's cells appeared in the Notebook attributed **Claude Code**, each with its own stated purpose and duration ("Rerun the full scripts/analysis.R end to end with the png device and check outputs · Running 16 s") |
| Live values | The Variables view listed 31 values after P1, including data frames, a `ggplot`, functions and two `enrichResult` objects with their formal class |
| Output rendering | R output, messages and a clusterProfiler warning ("7.78% of input gene IDs are fail to map") rendered as distinct blocks in the cell |
| File capture | P1 registered 23 resources; the Graph counted "Changed on disk 7" and "Versions kept 33" |
| Answer board | P1's answer leads with the question, numbered findings and file links; the figure is rendered inline with a one-sentence model description attributed `claude-haiku-5-5` |
| Studio | Notes on the left, the conversation's own views (`analysis.R`, Commands, Notebook, `go_dotplot.png`) in the middle, the answer on the right, and a replay timeline from 22:36 to Now |
| Graph | The meaning layer read the notes into **4 findings and 5 choices** and linked them to the files and runs, with a legend that separates "the Agent reported it", "named in a command", "seen changing on disk" and "written in the notes" |
| Notes structure | All five Agents wrote the requested section (Question / Data & method / Key results / Choices / Files / To do) with the `rho:session` marker; P1 and P4 filled every part |
| Spend | Per conversation, e.g. P1 "17% · $0.296" plus "descriptions $0.021" |
| Transcript export | "Export … as Markdown" produced a complete transcript for all five conversations |

## What broke or cost the person

These are recorded, not fixed: the request was to test and record.

1. **The 64-turn cap.** P3 and P4 both ended with
   "Not answered. Internal error: Reached maximum number of turns (64)", and the
   conversation row then reads **Failed**. The cap belongs to the Agent client, but Rho
   presents it as an internal error and offers no in-place way to resume with a fresh
   budget: the person presses **Continue** and restates what is left. P4's first attempt
   cost $0.491 and produced no result file.
2. **One approval per action.** With the agent in Manual mode, every shell command and
   every file write or edit waits for a choice. Counting the distinct prompts in my own
   run logs: **P1 8, P2 16, P3 24, P4 12, P5 10** (some prompts were logged without
   their text, so these are lower bounds). Only the narrow option
   "Yes, and don't ask again for `rtk read *` and `rtk ls *` commands" reduces repeats;
   writes and edits always ask. A broader "Yes, allow all edits during this session"
   did appear, but only late in P2's fourth turn — after several dozen separate write
   approvals — and not in the other conversations. A person cannot leave the screen
   during an analysis.
3. **The Agent guesses Rho's resource paths.** Before finding `/value/cells/0/state`
   it tried `/cells`, `/cells/0`, `/value/cell/state`, `/value/cells/0/outputs` and was
   refused each time; counting `_(refused)_` in the exported transcripts: P1 6, P2 4,
   P3 6, P4 11, P5 0. In the
   same runs `capability.index` was called 36 times (P2), 11 (P3) and 19 (P4). The index
   does not make the resource grammar evident, and this guessing is a large part of what
   the 64-turn cap then cuts off.
4. **A wait that nothing wakes.** P2's Agent armed a "Monitor" for the SCTransform job
   and ended its turn: "The Monitor is armed and will fire when SCTransform finishes.
   I'll wait for that event rather than polling." The conversation reported "Done in
   8 min" while the analysis was unfinished, and no event ever arrived. After being told
   this, it continued in the same session and found the finished cells.
5. **`ggsave` hung in the Notebook session.** P1 reported: "`ggsave` hung in the Notebook
   session, so the figure is drawn with `png()` instead. Several cells also stalled and
   needed interrupting." `kernel.interrupt` was called once in P1, twice in P3 and once
   in P4.
6. **The approval text is not the command that ran.** The Agent's own text says
   `cat README.md && ls -la …`, the executed step is shown as
   `cat README.md && …`, and the choice asked for `rtk read README.md && rtk ls -la …`.
   Three spellings of one command in one conversation; a person approving it cannot tell
   what will run.
7. **A closed tab loses the conversation.** No page has an address, and a new tab opens
   the Agent panel at "New conversation"; clicking the conversation in the list does not
   open it. The only way back that worked was **Continue** on the list row, which is also
   the resume path for a failed run.
8. **Refusals are counted, not explained.** The conversation summary says "5 refused",
   but nothing in the screen says what was refused or why; the reason is only in the
   transcript export. Rho's own activity record showed every recorded call as `returned`
   (35 in P1, 50 in P3, 77 in P2), because these refusals happen inside the Agent client.
9. **Notebook editor residue.** The person's own cell left `ls()` in the R input; edits
   and reruns of Agent cells are not distinguished from the person's in the input line.

## Who owns each problem, and what it costs

The list above mixes layers. Sorting them matters, because only some are Rho's to fix.

| Problem | Evidence here | Owner | Cost to the work |
| --- | --- | --- | --- |
| **A stopped run cannot be resumed in place** | P3 and P4 ended `Not answered. Internal error: Reached maximum number of turns (64)`; the row reads Failed; recovery is Continue plus restating what is left | Rho presents and recovers; the cap is the Agent client's | 0 of 5 runs finished unattended; P4's first attempt spent $0.491 and wrote no result file |
| **An approval for every action, with no durable grant** | Distinct prompts: P1 8, P2 16, P3 24, P4 12, P5 10; writes and edits always ask; "allow all edits during this session" appeared only in P2's fourth turn | Rho | The person cannot leave the screen for the length of an analysis |
| **The approval does not show the command that runs** | One step appears as `cat README.md && ls -la …` in the Agent's words, `cat README.md && …` as executed, and `rtk read README.md && rtk ls -la …` in the choice | **Unattributed** — which layer rewrites to `rtk` was not established | The person approves text they cannot check against what executes |
| **The Agent guesses the resource grammar** | `/cells`, `/cells/0`, `/value/cell/state` refused before `/value/cells/0/state` worked; `_(refused)_` P1 6, P2 4, P3 6, P4 11; `capability.index` 36 (P2), 19 (P4), 11 (P3) | Rho's capability surface, amplified by the Agent | Turns spent guessing are exactly the turns the 64 cap then takes away |
| **An Agent-invented wait leaves "Done" on unfinished work** | P2: "The Monitor is armed… I'll wait for that event"; the conversation said "Done in 8 min" with the analysis unfinished | The Agent assumed an event channel; Rho reported its stop as done | A person reading the Overview would believe the analysis had finished |
| **Plotting can hang the shared session** | P1: "`ggsave` hung in the Notebook session… several cells also stalled and needed interrupting"; `kernel.interrupt` 1 (P1), 2 (P3), 1 (P4) | **Unattributed** — R device or kernel session | Stalls need a person to notice and interrupt |
| **A conversation cannot be reopened once the tab closes** | No page addresses (already in [Status](STATUS.md)); a new tab opens "New conversation"; clicking the list row did not open it; Continue did | Rho, and already known | Leaving the screen loses the way back to a running conversation |
| **Refusals are counted, not explained** | "5 refused" in the summary; every recorded call in Rho's own activity read `returned` | Rho's presentation | The person cannot see what was blocked without exporting the transcript |
| **Commands view and its own count disagree after restart** | Header "3 commands · 5 min 8 s", pane empty after restart | **Unattributed** — not investigated | Mild; the commands are not visible from the reopened Studio |
| **Packages the paper needs are absent from the session** | `msigdbr` missing: P3 installed into `/tmp/rlib-p3`; P5 substituted GO BP for MSigDB | Environment / project requirements | A reproduction silently changes gene-set source unless the notes say so, as P5's did |
| **None of the five matched the paper's numbers** | P1 thresholds and "reversed" undefined; P4's OmicsPlayground combination rule; P5's 40 patients against the trial's 54; P3's region labels not public | The papers and their deposits, not Rho | "Reproduction" here means a documented re-analysis, not an equality check |

Two things this sorting changes about the flat list above: the largest cost is not the
64-turn cap on its own but its interaction with guessed resource paths, and the
questions a person most needs answered — what will run, did it finish, how do I get
back — are all presentation and recovery problems on Rho's side of the line.

## Limits of this pass

- One model, one Agent, one effort setting, one machine, five papers. Nothing here is a
  usability claim; no independent researcher watched these screens.
- The reproductions cover the expression → DE → enrichment → figure chain of each paper,
  not whole papers: the single-cell arm of P5, the metabolome of P4 and the spatial
  regions of P3 are out of scope. P3's region labels (GC/IF/LZ/DZ) are not in the public
  matrix, so that comparison cannot be reproduced from GSE232853 at all.
- The 64-turn cap and the permission prompts come from the Agent client; only their
  presentation and recovery are Rho's.
- P2 needed four turns. It finished its tables, UMAP, findings and notes; its KEGG
  dotplot was deliberately not drawn because `enrichKEGG` returned no pathway, and its
  `scripts/analysis.R` was never run end to end as a script (the cells were).
- Continuation is not free: each continued turn re-reads the project, and Rho told me in
  P2 that "the Agent session this conversation had been using had ended, so this message
  ran in a new one, told what was said here before". The conversation kept its context;
  the underlying Agent session did not.

## What this suggests for the next pass

1. When an Agent stops on its own limit, say so in those words and offer "continue with
   what is left" in place, keeping the original message identity.
2. Make the resource grammar reachable from `capability.index` (or accept a wrong path
   with a hint), so an Agent stops guessing and spends its turns on the analysis.
3. Show what will run in the approval, once, in the same spelling as the executed step.
4. A person must be able to close the tab and come back to the running conversation.
