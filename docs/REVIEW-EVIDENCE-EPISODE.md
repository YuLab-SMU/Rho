# Result review and retained evidence

The 2026-10-29 implementation follows the selected sequence: baseline, immutable
capture, result review, historical Graph, macOS preview delivery and a separately
checked offline reader. The two episodes are airquality selected-row feedback and
Python/R agreement with a Markdown report. A human decision records a judgment
about named reply/result versions; it neither authorizes execution nor changes files.

## Baseline

The starting source included Python/R highlighting, a Documents-based Markdown
reader, and native command exit, duration and bounded output. These were retained.
Baseline owner tests passed 104/104. Application tests passed 223/223 with an
explicit unchanged Core binary; a run without Core failed the checks requiring it.
The real base-R episode passed after its workspace selector was corrected for the
existing English label. Initial dirty diffs and test logs remain in
`work/review-evidence-implementation/`; other local work and the user's service
were preserved.

## Capture and review

Files 0.5.0 captures independent bytes with immutable references, source path,
observation kind/time and SHA-256. Registration keeps its original semantics.
Documents 0.4.7 snapshots dirty buffers separately with their confirmed version.
Agent 0.4.18 keeps the old capture entry and delegates to Files when supplied.
Captures assert only which bytes were observed, not what a native process consumed
or produced. An old session has no retrospective captures.

Rho starts bounded server-side capture for new Claude/Codex turns from explicit
file locations and a final check of identified/changed files. Reload and Graph
reads do not capture. Repeated events retain their original identity; interrupted
records remain interrupted. Defaults are 8 MiB per snapshot, 64 snapshots/32 MiB
per turn, at most two capture workers per project (the initial implementation
serializes them), and Files' existing 512 MiB/1024-resource project store. Exhaustion
keeps earlier captures and Agent output and records omissions. Selected limits
are visible in observation diagnostics and configurable downward.

Annotations 0.5.0 adds whole-resource anchors and append-only human decisions.
Needs changes requires a reason. Repeated submission reuses its receipt;
withdrawal/correction names the preceding decision. The server supplies the
browser author and refuses Agent/operator attempts to make a human decision.
A later reply or result version has no inherited acceptance. Format-3 workspace
archives retain decisions and captured resource metadata/bytes; older formats
refuse collaboration state rather than dropping it. Conversation logs remain
outside the workspace archive's existing scope.

Tables 0.5.0 compares explicitly selected numeric field pairs by declared stable
keys and namespace, using a full join in the browser. Before/after/delta, row
presence, null and zero remain distinct. The old single-field request retains its
old result schema. Unkeyed CSV remains previewable without invented row identity.
Documents shows the first/last captured code, separately for disk and dirty buffer.

Review is shared by Studio question controls and Graph result links. It retains
the question, explicit Agent replies, readable result links, differences and human
decisions. A first explicit conversation choice is retained for later sends.
Frozen contexts are included in the original conversation message identity.
Recording a decision sends nothing; a separate action sends the selected context.
A busy/unavailable conversation leaves the draft/intent available for explicit retry.
External handoff copies a request and reports that it was not sent automatically.

## Observed episodes

The real airquality calculation changes May from n=24 to n=26, mean 24.125 to
23.6153846, and August from n=23 to n=26. The controlled ACP/browser episode checks
both runtime output and the table comparison, reason entry with Unicode, a lost
decision response, exact retry, refresh and retained code versions. It uncovered
full-resource objects passed where a ref was required, editing before a draft
loaded, lost Review navigation on refresh, and offline overflow; each was fixed
and the same episode rerun. It passed at 1440, 1024, 768 and 390 CSS px
(`work/review-evidence-acceptance/2026-10-29T09-52-37-665Z/`). Later checks extend
these observations; they do not erase the earlier failures.

Real Claude on the selected Westlake HPC model completed two turns: it fetched the
frozen question, changed and ran R, captured a keyed table/figure and explicitly
replied; then fetched a human needs-changes context and replied with an explanation.
The browser recorded acceptance of those exact references. Native captures
survived an overwrite and no Core Host started
(`work/review-agent/claude-1793266762448/report.json`). Codex's first trial was
cancelled by an overly narrow acceptance permission selector before context fetch;
its failed report is retained. The ACP owner now names an otherwise unnamed
permission from the original tool update and recognizes Codex's MCP operation
spelling. The corrected real Codex trial completed both turns, fetched both frozen contexts
and linked its exact results (`work/review-agent/codex-1793267595201/report.json`).

A second controlled ACP episode actually runs Python and base R once each,
compares their mean of 3 with a Markdown table, retains both scripts/results/report,
then overwrites the originals. Captured bytes and Graph references remain readable
(`work/report-evidence/1793267857010/report.json`). This is runtime/capture evidence,
not a second model evaluation or a scientific method benchmark.

## Historical Graph

Graph and offline export use the same `buildWorkGraph` derivation for selected
reported/named/observed relationships. Export omits command text and tool output.
Graph file nodes distinguish paths from captured references. A later capture cannot
supply preview bytes at an earlier replay time. Legacy/unavailable/limited captures
state the gap, with a separate action to open the current file. Edges still name
Agent report, command mention or observed concurrent change; none infers production.
Selected result focus links back to its review. The browser reads at most six
conversations, eight turns each, and draws at most 160 nodes; omitted work is named.

## Offline reader

`evidence.preview/export` selects one review and its explicit result/input/capture
references, never adjacent files or the whole project by default. The preview shows
question/replies, decisions, file names/versions and gaps. The new export directory
contains a static `index.html`, original files and `evidence.json` written last.
It uses no project scripts, plugins, network assets, Agent or original service.
Typed previews are bounded to 200 rows/20 columns, text to 64 KiB. Full file bytes
remain linked. A missing reader keeps raw bytes and an explicit preview gap.

The export budget is 512 MiB, with bounded file/metadata counts. The original
export identity pins the selection; a lost reply does not select today's versions
or overwrite a directory. Interrupted output is not marked complete. The read-only
`rho --verify-evidence PATH` checks sizes/digests and inventory coverage without
starting a service. Integrity does not establish scientific correctness or authorship.
The browser trial closes Rho, moves the project, opens the recipient copy offline,
and detects deliberately changed bytes. This milestone is independent of the
0.5.1 installation acceptance.

## Remaining observation

No independent researcher has used this flow. Arrange a trial in which a researcher
finds May/August changes, asks for an explanation, corrects a decision, reopens the
same review and reads an offline package. Record completion, misconceptions and
requests for help. Browser assertions and developer screenshot review do not prove
usability, physical IME behavior, scientific validity or Windows/Linux support.


## Final source checks

The serial source suite passed Rho 229/229 and Plugins 110/110 before assembly.
The later contract-path portability regression raised the frozen run to 230/230. Generated contract
checks passed. Final capture/export/Graph/native-path regressions passed 15/15
following the last Graph correction. Frontend's 13 browser checks passed. Sources
exposed duplicate historical captures in the current result list: the application
now excludes captured observations there, keeping historical versions in Review
and Graph. The same original Sources episode was rerun. Review also checks
whole-resource question response loss, decision response loss, modal keyboard
focus, selection after reload, exact Graph focus and offline reading with browser
networking disabled. Earlier failed runs remain in the local evidence directory.
The changed documentation batch rendered 43 browser pages without overflow or
broken local links, and every page was visually inspected.


## Fixed preview and installed checks

The [0.5.1 preview](PREVIEW-0.5.1.md) pins the clean application/Plugins selections,
reuses the digest-verified Core and records the unchanged tarball's identities.
The frozen source passed 230/230. The same installed artifact passed the full
review episode, Graph backlink/focus, normal restart and offline reading with
networking disabled. Both real installed clients completed their feedback loops.
An initial Codex attempt exhausted the default 32 native permission records;
the explicit 64-choice repeat passed. This changes retention budget, not authority.
The actual native chooser returned a directory, while its cancellation branch
was not observed. The selected directory's contents were not edited. Owned-project
unsaved Unicode text survived a separate normal installed restart. Platform/digest
refusals and the existing no-Core path were checked. The standalone package,
checksum, composition, machine-readable acceptance and valid example evidence
remain in the delivery directory; no accepted artifact was rebuilt or replaced.


## Candidate 2 and conversation reuse

The last requirement audit found that choosing New conversation in Review kept
that option for the next send. Annotations 0.5.1 now records the returned conversation
ID as the next target, including after original-identity retry, and holds the
selector while submission is pending. The browser episode sends twice from Review
and confirms two turns in the same new conversation with no additional Agent.
The first tarball remains with a superseded-candidate record. Candidate 2 has new
source/component/artifact identities and repeats installation and relevant checks;
it does not replace the first tarball's bytes. Export metadata/HTML also explicitly
separates package generation from analysis evidence completeness. Both suites again
passed Rho 230/230 and Plugins 110/110 before candidate assembly.

Candidate 2’s installed Claude and Codex trials completed with exact result refs and
human follow-up (`work/review-agent/claude-1793272446374/report.json` and
`work/review-agent/codex-1793272446375/report.json`). Claude used three retained
permission records with a 32-choice limit; Codex used 41 with a selected 64-choice
limit. The installed browser trial also repeated normal restart, Python/R report
capture, platform/digest refusals, the no-Core path and Unicode buffer recovery.
The picker’s candidate-1 observation is reused only for byte-identical picker code;
its cancellation remains unobserved. The new delivery zip was extracted and all
nine inventory entries verified with the same installed CLI. The final review,
Graph, export and offline screenshots were read at all recorded widths.
