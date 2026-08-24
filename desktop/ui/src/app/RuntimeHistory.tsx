import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  DomainSurfaceItem,
  RuntimeExecution,
  RuntimeOutputChunk,
  RuntimeOutputPage,
  RuntimeOutputPolicyView,
  RuntimeOutputReference,
  RuntimeOutputTransport,
  UiKernelTransport,
} from "../transport";
import { workbenchFailureMessage } from "./workbench-failure";
import { domainItemPresentation } from "./domain-presentation";
import { runtimeExecutionStateLabel, runtimeOutputChunkBlock } from "./runtime-output-presentation";
import { formatHistoryTime, shortenId } from "./time-format";

interface RuntimeHistoryProps {
  readonly transport: RuntimeOutputTransport & Pick<
    UiKernelTransport,
    "loadDomainSurface" | "subscribeInvalidated"
  >;
  readonly initialFilter: string;
  readonly persistFilter: (filter: string) => Promise<void>;
  readonly reportError: (cause: unknown) => void;
  readonly useInAgent: (reference: RuntimeOutputReference) => void;
  readonly openOutputReference: (kind: "plot" | "artifact", id: string) => void;
}

function oneLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() || "R expression";
}

function executionKey(executionId: string): string {
  return `runtime:${executionId}`;
}

function legacyKey(itemId: string): string {
  return `legacy:${itemId}`;
}

function matchesExecution(execution: RuntimeExecution, query: string): boolean {
  if (!query) return true;
  return [
    execution.submitted_code,
    execution.status,
    execution.output_state,
    execution.source_path ?? "",
    execution.run_id ?? "",
    execution.runtime_instance_id,
  ].join("\n").toLowerCase().includes(query);
}

function matchesLegacy(item: DomainSurfaceItem, query: string): boolean {
  if (!query) return true;
  return [item.title, item.subtitle ?? "", item.status ?? "", item.detail ?? ""]
    .join("\n").toLowerCase().includes(query);
}

export function RuntimeHistory({
  transport,
  initialFilter,
  persistFilter,
  reportError,
  useInAgent,
  openOutputReference,
}: RuntimeHistoryProps) {
  const [filter, setFilter] = useState(initialFilter);
  const [executions, setExecutions] = useState<readonly RuntimeExecution[]>([]);
  const [legacyItems, setLegacyItems] = useState<readonly DomainSurfaceItem[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detailPage, setDetailPage] = useState<RuntimeOutputPage | null>(null);
  const [detailChunks, setDetailChunks] = useState<readonly RuntimeOutputChunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlderExecutions, setHasOlderExecutions] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"prune" | "delete" | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [contextBusy, setContextBusy] = useState(false);
  const [contextRange, setContextRange] = useState({ start: 1, end: 1 });
  const [error, setError] = useState<string | null>(null);
  const [policyView, setPolicyView] = useState<RuntimeOutputPolicyView | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyDraft, setPolicyDraft] = useState({ captureMiB: "", warningMiB: "", rows: "" });

  const installPolicy = (next: RuntimeOutputPolicyView) => {
    setPolicyView(next);
    setPolicyDraft({
      captureMiB: next.policy.max_runtime_output_bytes_per_execution == null
        ? ""
        : String(next.policy.max_runtime_output_bytes_per_execution / (1024 * 1024)),
      warningMiB: next.policy.runtime_output_project_warning_bytes == null
        ? ""
        : String(next.policy.runtime_output_project_warning_bytes / (1024 * 1024)),
      rows: next.policy.max_runtime_execution_rows == null ? "" : String(next.policy.max_runtime_execution_rows),
    });
  };

  const loadPolicy = useCallback(async () => {
    setPolicyBusy(true);
    try {
      installPolicy(await transport.getRuntimeOutputPolicy());
    } catch (cause: unknown) {
      reportError(cause);
    } finally {
      setPolicyBusy(false);
    }
  }, [reportError, transport]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [runtimeRows, legacy] = await Promise.all([
        transport.listRuntimeExecutions(50),
        transport.loadDomainSurface("rho.runs"),
      ]);
      const linkedIds = new Set(runtimeRows.flatMap((execution) => [
        execution.execution_id,
        ...(execution.run_id == null ? [] : [execution.run_id]),
      ]));
      const unlinkedLegacy = legacy.items.filter((item) => !linkedIds.has(item.id));
      setExecutions(runtimeRows);
      setHasOlderExecutions(runtimeRows.length === 50);
      setLegacyItems(unlinkedLegacy);
      setSelectedKey((current) => {
        if (current?.startsWith("runtime:")
            && runtimeRows.some((execution) => executionKey(execution.execution_id) === current)) return current;
        if (current?.startsWith("legacy:")
            && unlinkedLegacy.some((item) => legacyKey(item.id) === current)) return current;
        const newest = runtimeRows[0];
        return newest == null
          ? unlinkedLegacy[0] == null ? null : legacyKey(unlinkedLegacy[0].id)
          : executionKey(newest.execution_id);
      });
      setError(null);
    } catch (cause: unknown) {
      setError(workbenchFailureMessage(cause, "History could not load."));
    } finally {
      setLoading(false);
    }
  }, [transport]);

  const loadOlderExecutions = async () => {
    const cursor = executions.at(-1);
    if (cursor == null || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const older = await transport.listRuntimeExecutions(50, {
        started_at: cursor.started_at,
        execution_id: cursor.execution_id,
      });
      setExecutions((current) => [
        ...current,
        ...older.filter((candidate) => !current.some((existing) => existing.execution_id === candidate.execution_id)),
      ]);
      setHasOlderExecutions(older.length === 50);
    } catch (cause: unknown) {
      reportError(cause);
    } finally {
      setLoadingOlder(false);
    }
  };

  useEffect(() => {
    void load();
    return transport.subscribeInvalidated(() => void load());
  }, [load, transport]);

  useEffect(() => { void loadPolicy(); }, [loadPolicy]);

  const savePolicy = async () => {
    if (policyView == null || policyBusy) return;
    const parseMiB = (value: string) => value.trim() === "" ? null : Number(value) * 1024 * 1024;
    const capture = parseMiB(policyDraft.captureMiB);
    const warning = parseMiB(policyDraft.warningMiB);
    const rows = policyDraft.rows.trim() === "" ? null : Number(policyDraft.rows);
    if ((capture != null && (!Number.isSafeInteger(capture) || capture < 0))
        || (warning != null && (!Number.isSafeInteger(warning) || warning < 0))
        || (rows != null && (!Number.isSafeInteger(rows) || rows < 1))) {
      reportError(new Error("Storage policy values must be non-negative whole MiB values and a positive whole row count."));
      return;
    }
    setPolicyBusy(true);
    try {
      installPolicy(await transport.updateRuntimeOutputPolicy({
        expected_revision: policyView.policy.revision,
        max_runtime_output_bytes_per_execution: capture,
        runtime_output_project_warning_bytes: warning,
        max_runtime_execution_rows: rows,
        auto_prune_enabled: false,
      }));
    } catch (cause: unknown) {
      reportError(cause);
    } finally {
      setPolicyBusy(false);
    }
  };

  const selectedExecution = selectedKey?.startsWith("runtime:")
    ? executions.find((execution) => executionKey(execution.execution_id) === selectedKey) ?? null
    : null;
  const selectedLegacy = selectedKey?.startsWith("legacy:")
    ? legacyItems.find((item) => legacyKey(item.id) === selectedKey) ?? null
    : null;

  useEffect(() => {
    let cancelled = false;
    setDetailPage(null);
    setDetailChunks([]);
    if (selectedExecution == null) return () => { cancelled = true; };
    setDetailLoading(true);
    void transport.loadRuntimeOutputPage({
      execution_id: selectedExecution.execution_id,
      after_sequence: 0,
    }).then((page) => {
      if (cancelled) return;
      setDetailPage(page);
      setDetailChunks(page.chunks);
    }).catch(reportError).finally(() => {
      if (!cancelled) setDetailLoading(false);
    });
    return () => { cancelled = true; };
  }, [reportError, selectedExecution, transport]);

  useEffect(() => {
    setContextRange({
      start: 1,
      end: Math.max(1, selectedExecution?.last_sequence ?? 1),
    });
  }, [selectedExecution?.execution_id, selectedExecution?.last_sequence]);

  const query = filter.trim().toLowerCase();
  const visibleExecutions = useMemo(
    () => executions.filter((execution) => matchesExecution(execution, query)),
    [executions, query],
  );
  const visibleLegacy = useMemo(
    () => legacyItems.filter((item) => matchesLegacy(item, query)),
    [legacyItems, query],
  );
  const total = executions.length + legacyItems.length;
  const visibleTotal = visibleExecutions.length + visibleLegacy.length;
  const attentionCount = executions.filter((execution) => ["failed", "interrupted"].includes(execution.status)).length
    + legacyItems.filter((item) => ["failed", "cancelled", "interrupted"].includes(item.status ?? "")).length;

  const loadMore = async () => {
    if (selectedExecution == null || detailPage == null || !detailPage.has_more) return;
    setDetailLoading(true);
    try {
      const page = await transport.loadRuntimeOutputPage({
        execution_id: selectedExecution.execution_id,
        after_sequence: detailPage.next_sequence,
      });
      setDetailChunks((current) => [...current, ...page.chunks.filter((chunk) => (
        !current.some((existing) => existing.sequence === chunk.sequence)
      ))]);
      setDetailPage(page);
    } catch (cause: unknown) {
      reportError(cause);
    } finally {
      setDetailLoading(false);
    }
  };

  const confirmMutation = async () => {
    if (selectedExecution == null || confirmAction == null) return;
    setMutationBusy(true);
    try {
      const result = confirmAction === "prune"
        ? await transport.pruneRuntimeOutput(selectedExecution.execution_id)
        : await transport.deleteRuntimeExecution(selectedExecution.execution_id);
      if (result.outcome === "not_active") throw new Error("An active execution cannot be changed.");
      if (result.outcome === "not_found") throw new Error("This execution no longer exists.");
      setConfirmAction(null);
      await load();
    } catch (cause: unknown) {
      reportError(cause);
    } finally {
      setMutationBusy(false);
    }
  };

  const useSelectedInAgent = async () => {
    if (selectedExecution == null || selectedExecution.last_sequence < 1
        || contextRange.start < 1 || contextRange.end < contextRange.start
        || contextRange.end > selectedExecution.last_sequence) return;
    setContextBusy(true);
    try {
      const reference = await transport.createRuntimeOutputReference(
        selectedExecution.execution_id,
        contextRange.start,
        contextRange.end,
      );
      useInAgent(reference);
    } catch (cause: unknown) {
      reportError(cause);
    } finally {
      setContextBusy(false);
    }
  };

  return <section className="rho-runtime-history" data-domain-kind="timeline">
    <div className="rho-runtime-history-top">
    <header className="rho-runtime-history-toolbar">
      <div>
        <strong>{loading && total === 0
          ? "Loading…"
          : attentionCount > 0
            ? `${attentionCount} ${attentionCount === 1 ? "execution needs" : "executions need"} attention`
            : `${total} ${total === 1 ? "execution" : "executions"}`}</strong>
        <small>Durable Runtime history</small>
      </div>
      <label>
          <span className="rho-visually-hidden">Filter History</span>
        <input
          type="search"
          value={filter}
          aria-label="Filter History"
          placeholder="Search code, source, or state…"
          onChange={(event) => setFilter(event.target.value)}
          onBlur={() => void persistFilter(filter).catch(reportError)}
        />
      </label>
      <button type="button" aria-expanded={policyOpen} disabled={policyBusy} onClick={() => setPolicyOpen((current) => !current)}>Storage</button>
      <button type="button" className="rho-icon-btn" aria-label="Refresh History" disabled={loading} onClick={() => void load()}>↻</button>
    </header>
    {policyView?.warning_active && <div className="rho-runtime-history-storage-warning" role="status">
      <strong>Runtime History storage needs attention</strong>
      <span>{policyView.project_output_bytes.toLocaleString()} bytes across {policyView.project_execution_count.toLocaleString()} executions. Automatic pruning is off.</span>
    </div>}
    {policyOpen && <form className="rho-runtime-history-policy" aria-label="Runtime output storage policy" onSubmit={(event) => {
      event.preventDefault();
      void savePolicy();
    }}>
      <label>Capture per execution (MiB)<input aria-label="Capture per execution MiB" type="number" min="0" step="1" placeholder="Unlimited" disabled={policyBusy} value={policyDraft.captureMiB} onChange={(event) => setPolicyDraft({ ...policyDraft, captureMiB: event.target.value })} /></label>
      <label>Project warning (MiB)<input aria-label="Project warning MiB" type="number" min="0" step="1" placeholder="Off" disabled={policyBusy} value={policyDraft.warningMiB} onChange={(event) => setPolicyDraft({ ...policyDraft, warningMiB: event.target.value })} /></label>
      <label>Execution warning count<input aria-label="Execution warning count" type="number" min="1" step="1" placeholder="Off" disabled={policyBusy} value={policyDraft.rows} onChange={(event) => setPolicyDraft({ ...policyDraft, rows: event.target.value })} /></label>
      <div><small>Blank means unlimited/off · automatic pruning stays off · policy r{policyView?.policy.revision ?? 0}</small><button type="button" disabled={policyBusy} onClick={() => void loadPolicy()}>Reload</button><button type="submit" className="rho-primary-action" disabled={policyBusy || policyView == null}>{policyBusy ? "Saving…" : "Save"}</button></div>
    </form>}
    </div>
    {error != null && <div className="rho-runtime-history-error rho-task-state-error" role="alert">
      <strong>History is unavailable</strong><span>{error}</span><button type="button" onClick={() => void load()}>Try again</button>
    </div>}
    {error == null && <div className="rho-runtime-history-body" aria-busy={loading}>
      <div className="rho-runtime-history-list" role="list" aria-label="Runtime execution history">
        {!loading && visibleTotal === 0 && <div className="rho-runtime-history-empty rho-domain-empty rho-task-state-empty" role="status">
          <strong>{query ? "No executions match this search" : "No Runtime executions yet"}</strong>
          <span>{query ? "Try code, source, Runtime, or state." : "Run code from Source or Console to create durable History."}</span>
        </div>}
        {visibleExecutions.map((execution) => {
          const stateLabel = runtimeExecutionStateLabel(execution);
          return <button
          type="button"
          role="listitem"
          aria-current={selectedKey === executionKey(execution.execution_id) ? "true" : undefined}
          className="rho-runtime-history-row"
          data-domain-id={execution.execution_id}
          key={execution.execution_id}
          onClick={() => setSelectedKey(executionKey(execution.execution_id))}
        >
          <span className={`rho-domain-indicator rho-domain-indicator-${execution.status}`} aria-hidden="true" />
          <span className="rho-runtime-history-row-copy">
            <strong>{oneLine(execution.submitted_code)}</strong>
            <small title={execution.started_at}>{execution.source_path ?? execution.runtime_instance_id} · {formatHistoryTime(execution.started_at)}</small>
          </span>
          {/* A completed execution is the norm; only attention states earn a badge. */}
          {stateLabel !== "completed" && <span className={`rho-domain-state rho-domain-${execution.status}`}>{stateLabel}</span>}
        </button>;})}
        {visibleLegacy.map((item) => {
          const projected = domainItemPresentation("rho.runs", item);
          return <button
          type="button"
          role="listitem"
          aria-current={selectedKey === legacyKey(item.id) ? "true" : undefined}
          className="rho-runtime-history-row rho-runtime-history-row-legacy"
          data-domain-id={item.id}
          key={item.id}
          onClick={() => setSelectedKey(legacyKey(item.id))}
        >
          <span className="rho-domain-indicator rho-domain-indicator-neutral" aria-hidden="true" />
          <span className="rho-runtime-history-row-copy"><strong>{projected.code ?? projected.title}</strong><small>{projected.title} · {item.subtitle ?? "Earlier Run"}</small></span>
          <span className={`rho-domain-state rho-domain-${item.status ?? "neutral"}`}>{item.status ?? "legacy"}</span>
        </button>;})}
        {hasOlderExecutions && !query && <button
          type="button"
          className="rho-runtime-history-load-older"
          disabled={loadingOlder}
          onClick={() => void loadOlderExecutions()}
        >{loadingOlder ? "Loading…" : "Load older executions"}</button>}
      </div>
      <div className="rho-runtime-history-detail" aria-live="polite">
        {selectedExecution == null && selectedLegacy == null && <div className="rho-runtime-history-empty" role="status">
          <strong>Select an execution</strong><span>Review submitted code, human output, provenance, and completeness.</span>
        </div>}
        {selectedLegacy != null && (() => {
          const projected = domainItemPresentation("rho.runs", selectedLegacy);
          return <article>
            <header><strong>{projected.title}</strong><span className="rho-domain-state">Legacy Run</span></header>
            <p>This record predates the Runtime output journal. Only fields proven by the original Run are shown.</p>
            {projected.code != null && <pre className="rho-runtime-history-code"><code>{projected.code}</code></pre>}
            {projected.description != null && <p>{projected.description}</p>}
            {projected.meta.length > 0 && <ul>{projected.meta.map((fact) => <li key={fact}>{fact}</li>)}</ul>}
          </article>;
        })()}
        {selectedExecution != null && <article>
          <header>
            <div><strong>{oneLine(selectedExecution.submitted_code)}</strong><small>{selectedExecution.source_path ?? selectedExecution.runtime_instance_id}</small></div>
            <span className={`rho-domain-state rho-domain-${selectedExecution.status}`}>{runtimeExecutionStateLabel(selectedExecution)}</span>
          </header>
          <pre className="rho-runtime-history-code"><code>{selectedExecution.submitted_code}</code></pre>
          <dl>
            <div><dt>Started</dt><dd title={selectedExecution.started_at}>{formatHistoryTime(selectedExecution.started_at)}</dd></div>
            <div><dt>Run</dt><dd title={selectedExecution.run_id ?? undefined}>{selectedExecution.run_id == null ? "No Workspace Run" : shortenId(selectedExecution.run_id)}</dd></div>
          </dl>
          <div className="rho-runtime-history-context-action">
            <label>From chunk<input aria-label="Agent context start chunk" type="number" min="1" max={selectedExecution.last_sequence} value={contextRange.start} onChange={(event) => setContextRange({ ...contextRange, start: Number(event.target.value) })} /></label>
            <label>To chunk<input aria-label="Agent context end chunk" type="number" min="1" max={selectedExecution.last_sequence} value={contextRange.end} onChange={(event) => setContextRange({ ...contextRange, end: Number(event.target.value) })} /></label>
            <button
              type="button"
              disabled={contextBusy || selectedExecution.last_sequence < 1 || selectedExecution.output_state === "pruned"
                || contextRange.start < 1 || contextRange.end < contextRange.start || contextRange.end > selectedExecution.last_sequence}
              onClick={() => void useSelectedInAgent()}
            >{contextBusy ? "Preparing context…" : "Use output in Agent"}</button>
            <small>{selectedExecution.last_sequence < 1
              ? "This execution has no committed output."
              : selectedExecution.output_state === "pruned"
                ? "Pruned payload cannot be added to Agent context."
                : `Uses an immutable reference to output chunks ${contextRange.start}–${contextRange.end}.`}</small>
          </div>
          <div className="rho-console-results">
            {detailChunks.map((chunk) => {
              const block = runtimeOutputChunkBlock(chunk);
              return <div className={`rho-console-result rho-console-result-${block.kind}`} key={chunk.sequence}>
                {block.label != null && <strong>{block.label}</strong>}<pre title={block.reference != null ? block.text : undefined}>{block.reference != null ? shortenId(block.text) : block.text}</pre>
                {block.reference != null && <button
                  type="button"
                  className="rho-runtime-output-reference"
                  data-reference-id={block.reference.id}
                  onClick={() => openOutputReference(block.reference!.kind, block.reference!.id)}
                >Open {block.reference.kind === "plot" ? "Plot" : "Artifact"}</button>}
              </div>;
            })}
            {detailLoading && <span role="status">Loading output…</span>}
            {!detailLoading && detailChunks.length === 0 && <span role="status">No captured output.</span>}
          </div>
          {detailPage?.has_more && <button type="button" disabled={detailLoading} onClick={() => void loadMore()}>Load more output</button>}
          {!(["admitted", "running"] as const).includes(selectedExecution.status as "admitted" | "running") && <div className="rho-runtime-history-retention-actions">
            <button type="button" disabled={selectedExecution.output_state === "pruned"} onClick={() => setConfirmAction("prune")}>Prune output payload…</button>
            <button type="button" onClick={() => setConfirmAction("delete")}>Delete execution record…</button>
          </div>}
          {confirmAction != null && <div className="rho-runtime-history-confirm" role="alertdialog" aria-modal="false" aria-label={confirmAction === "prune" ? "Confirm output prune" : "Confirm execution deletion"}>
            <strong>{confirmAction === "prune" ? "Prune captured output?" : "Delete this execution record?"}</strong>
            <p>{confirmAction === "prune"
              ? "Captured inline payload becomes durable tombstones. Submitted code, execution provenance, Runs, Artifacts, and Agent receipts are kept."
              : "The execution row and its output journal are removed. Linked Workspace Runs and Artifacts are kept; Agent-referenced executions cannot be deleted."}</p>
            <div>
              <button type="button" disabled={mutationBusy} onClick={() => setConfirmAction(null)}>Cancel</button>
              <button type="button" disabled={mutationBusy} onClick={() => void confirmMutation()}>{mutationBusy ? "Working…" : confirmAction === "prune" ? "Prune payload" : "Delete record"}</button>
            </div>
          </div>}
        </article>}
      </div>
    </div>}
  </section>;
}
