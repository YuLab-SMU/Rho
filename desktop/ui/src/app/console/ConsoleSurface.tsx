import type { Dispatch, RefObject, SetStateAction } from "react";

import type {
  RuntimeDescriptor,
  RuntimeOutputSearchResult,
  RuntimeRegistrySnapshot,
  SurfaceInstance,
} from "../../transport";
import type {
  ConsoleInstanceController,
  ConsoleOutputRecord,
  ConsoleViewState,
} from "../controllers/console-instance-controller";
import { consoleTranscriptOutputs } from "../controllers/console-instance-controller";

export interface ConsoleTranscriptRow {
  readonly output: ConsoleOutputRecord;
  readonly ordinal: number;
  readonly runtimeGroup: number;
}

export function ConsoleSurface({
  instance,
  consoleFilterOpen,
  setConsoleFilterOpen,
  consoleState,
  consoleController,
  consoleSearchBusy,
  consoleSearch,
  filteredOutputs,
  transcriptOutputs,
  closeConsoleFilter,
  consoleRunning,
  attached,
  runtimes,
  detachRuntime,
  attachRuntime,
  reportError,
  consoleOutputRef,
  consoleNeedle,
  durableSearchHits,
  openSurfaceById,
  openPlot,
  commitConsole,
  consoleBusy,
  submitConsole,
  interruptRuntime,
  runtimeRecovering,
}: {
  readonly instance: SurfaceInstance;
  readonly consoleFilterOpen: boolean;
  readonly setConsoleFilterOpen: Dispatch<SetStateAction<boolean>>;
  readonly consoleState: ConsoleViewState;
  readonly consoleController: ConsoleInstanceController;
  readonly consoleSearchBusy: boolean;
  readonly consoleSearch: RuntimeOutputSearchResult | null;
  readonly filteredOutputs: readonly ConsoleTranscriptRow[];
  readonly transcriptOutputs: readonly ConsoleOutputRecord[];
  readonly closeConsoleFilter: () => void;
  readonly consoleRunning: boolean;
  readonly attached: RuntimeDescriptor | null;
  readonly runtimes: RuntimeRegistrySnapshot | null;
  readonly detachRuntime: () => Promise<void>;
  readonly attachRuntime: (runtime: RuntimeDescriptor) => Promise<void>;
  readonly reportError: (error: unknown) => void;
  readonly consoleOutputRef: RefObject<HTMLDivElement | null>;
  readonly consoleNeedle: string;
  readonly durableSearchHits: RuntimeOutputSearchResult["hits"];
  readonly openSurfaceById: (surfaceId: string) => void;
  readonly openPlot: (plotId: string) => void;
  readonly commitConsole: (next: ConsoleViewState) => Promise<void>;
  readonly consoleBusy: boolean;
  readonly submitConsole: () => unknown;
  readonly interruptRuntime: (runtime: RuntimeDescriptor) => Promise<void>;
  readonly runtimeRecovering: boolean;
}) {
  return (
    <div className="rho-console-surface">
      <div className="rho-console-toolbar">
        {consoleFilterOpen ? (
          <div className="rho-console-filterbar" role="search">
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="m10 10 3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              autoFocus
              type="search"
              aria-label={`Filter output ${instance.instance_id}`}
              value={consoleState.filter}
              onChange={(event) => consoleController.replaceState({ ...consoleState, filter: event.target.value })}
              onBlur={() => void consoleController.persistCurrent()}
              onKeyDown={(event) => {
                if (event.key === "Escape") closeConsoleFilter();
              }}
              placeholder="Find in output…"
            />
            <span>{consoleSearchBusy
              ? "Searching History…"
              : consoleSearch == null
                ? `${filteredOutputs.length} / ${transcriptOutputs.length}`
                : `${consoleSearch.matched_execution_count} / ${consoleSearch.searched_execution_count}`}</span>
            <button type="button" className="rho-icon-btn" aria-label="Close output filter" onClick={closeConsoleFilter}>×</button>
          </div>
        ) : (
          <div className="rho-console-runtime-bar">
            <select
              aria-label={`Runtime for ${instance.instance_id}`}
              value={attached?.runtime_instance_id ?? ""}
              disabled={consoleRunning}
              onChange={(event) => {
                const selected = runtimes?.instances.find((candidate) =>
                  candidate.runtime_instance_id === event.target.value
                );
                const operation = selected == null ? detachRuntime() : attachRuntime(selected);
                void operation.catch(reportError);
              }}
            >
              <option value="">Attach runtime…</option>
              {runtimes?.instances.filter((candidate) =>
                candidate.attach_capabilities.includes("console.attach")
              ).map((candidate) => (
                <option value={candidate.runtime_instance_id} key={candidate.runtime_instance_id}>
                  {candidate.display_label}
                </option>
              ))}
            </select>
            <span className={`rho-runtime-state rho-runtime-${attached?.status ?? "unbound"}`}>
              {attached?.status ?? "unbound"}
            </span>
            {transcriptOutputs.length > 0 && (
              <button
                type="button"
                className="rho-icon-btn rho-console-search-toggle"
                aria-label="Filter Console output"
                aria-expanded="false"
                onClick={() => setConsoleFilterOpen(true)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="m10 10 3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>
      <div className="rho-console-output-region">
        <div
          className="rho-console-output"
          ref={(element) => {
            consoleOutputRef.current = element;
            if (element != null && Math.abs(element.scrollTop - consoleState.scroll_top) > 1) {
              element.scrollTop = consoleState.scroll_top;
            }
          }}
          onBlur={(event) => {
            const scrollTop = event.currentTarget.scrollTop;
            const current = consoleController.getSnapshot().state;
            if (scrollTop !== current.scroll_top) consoleController.replaceState({ ...current, scroll_top: scrollTop });
            void consoleController.persistCurrent();
          }}
          onScroll={(event) => {
            const element = event.currentTarget;
            const followTail = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
            const current = consoleController.getSnapshot().state;
            const tail = consoleTranscriptOutputs(current).at(-1) ?? null;
            const readCursor = followTail && tail != null
              ? { execution_id: tail.execution_id, sequence: tail.last_sequence ?? 0 }
              : current.read_cursor;
            if (current.scroll_top !== element.scrollTop
                || current.follow_tail !== followTail
                || JSON.stringify(current.read_cursor) !== JSON.stringify(readCursor)) {
              consoleController.replaceState({
                ...current,
                scroll_top: element.scrollTop,
                follow_tail: followTail,
                read_cursor: readCursor,
              });
            }
          }}
          onPointerUp={() => void consoleController.persistCurrent()}
          onKeyUp={() => void consoleController.persistCurrent()}
          aria-label="R Console transcript"
          aria-live={consoleState.follow_tail ? "polite" : "off"}
          aria-relevant="additions text"
          data-follow-tail={consoleState.follow_tail ? "true" : "false"}
          tabIndex={0}
        >
        {transcriptOutputs.length === 0 && (
          <div className="rho-console-empty" role="status">
            <span aria-hidden="true">&gt;_</span>
            <strong>{attached == null
              ? "Attach a runtime to begin"
              : "Ready for R code"}</strong>
          </div>
        )}
        {transcriptOutputs.length > 0 && filteredOutputs.length === 0 && durableSearchHits.length === 0 && (
          <div className="rho-console-empty rho-console-no-match" role="status">
            <strong>No output matches “{consoleState.filter.trim()}”</strong>
            <button type="button" onClick={() => commitConsole({ ...consoleState, filter: "" })}>Clear filter</button>
          </div>
        )}
        {consoleNeedle && consoleSearch != null && <div className="rho-console-search-scope" role="status">
          <span>Searched {consoleSearch.searched_execution_count} durable {consoleSearch.searched_execution_count === 1 ? "execution" : "executions"}{consoleState.transcript_start_after == null ? "" : " since this transcript started"}.</span>
          {consoleSearch.incomplete_execution_count > 0 && <span>{consoleSearch.incomplete_execution_count} had partial, unavailable, or pruned output.</span>}
          {consoleSearch.truncated && <span>Showing the first 100 matches.</span>}
        </div>}
        {durableSearchHits.length > 0 && <div className="rho-console-durable-search-results" aria-label="Matches in durable Console History">
          {durableSearchHits.map((hit) => <article key={`${hit.execution_id}:${hit.sequence}`}>
            <div><strong>{hit.presentation_kind === "code" ? "Submitted code" : hit.presentation_kind}</strong><code>#{hit.sequence}</code></div>
            <pre>{hit.preview}</pre>
            <footer>
              <button type="button" onClick={() => openSurfaceById("rho.runs")}>Open in History</button>
              {hit.reference_kind === "plot" && hit.reference_id != null && <button type="button" data-reference-id={hit.reference_id} onClick={() => openPlot(hit.reference_id!)}>Open Plot</button>}
            </footer>
          </article>)}
        </div>}
        {consoleState.released_output_count > 0 && (
          <div className="rho-console-retention-notice" role="status">
            <span>{consoleState.released_output_count} older {consoleState.released_output_count === 1 ? "entry was" : "entries were"} released from this live view.</span>
            <button type="button" onClick={() => openSurfaceById("rho.runs")}>Open History</button>
          </div>
        )}
        {filteredOutputs.map(({ output, ordinal, runtimeGroup: outputRuntimeGroup }, visibleIndex) => (
          <section
            className="rho-console-entry"
            aria-label={`R Console execution ${ordinal}`}
            data-runtime-group-start={visibleIndex === 0 || filteredOutputs[visibleIndex - 1]?.runtimeGroup !== outputRuntimeGroup
              ? "true"
              : "false"}
            key={output.execution_id}
          >
            {output.has_older && <button
              type="button"
              className="rho-console-load-older"
              onClick={() => {
                const element = consoleOutputRef.current;
                const beforeHeight = element?.scrollHeight ?? 0;
                const beforeTop = element?.scrollTop ?? 0;
                void consoleController.loadOlder(output.execution_id).then(() => {
                  window.requestAnimationFrame(() => {
                    if (element != null) element.scrollTop = beforeTop + element.scrollHeight - beforeHeight;
                  });
                }).catch(reportError);
              }}
            >Load earlier output</button>}
            {output.newer_output_omitted && <div className="rho-console-window-notice" role="status">
              <span>Newer chunks were released from this bounded reading window.</span>
              <button type="button" onClick={() => void consoleController.loadLatest(output.execution_id).catch(reportError)}>Return to latest output</button>
            </div>}
            <header>
              {(visibleIndex === 0 || filteredOutputs[visibleIndex - 1]?.runtimeGroup !== outputRuntimeGroup) && <span className="rho-console-workspace-label">{
                runtimes?.instances.find((candidate) =>
                  candidate.runtime_instance_id === output.runtime_instance_id
                )?.display_label ?? "R runtime"
              }</span>}
              {(() => {
                const stateLabel = `${output.status ?? "completed"}${output.output_state != null && !["collecting", "complete"].includes(output.output_state)
                  ? ` · ${output.output_state}`
                  : ""}`;
                /* A completed execution is the norm; only attention states earn a
                   label, but the slot keeps the header layout stable. */
                return (
                  <span className={`rho-console-entry-state rho-console-entry-state-${output.status ?? "completed"}`}>
                    {stateLabel === "completed" ? "" : stateLabel}
                  </span>
                );
              })()}
              <span>#{ordinal}</span>
              <button type="button" onClick={() => openSurfaceById("rho.runs")}>Open in History</button>
            </header>
            <code className="rho-console-command"><span aria-hidden="true">&gt;</span> {output.code}</code>
            <div className="rho-console-results">
              {output.blocks.map((result, index) => (
                <div className={`rho-console-result rho-console-result-${result.kind}`} key={`${result.kind}:${index}`}>
                  {result.label != null && <strong>{result.label}</strong>}
                  <pre>{result.text}</pre>
                  {result.reference?.kind === "plot" && <button
                    type="button"
                    className="rho-runtime-output-reference"
                    data-reference-id={result.reference.id}
                    onClick={() => openPlot(result.reference!.id)}
                  >Open Plot</button>}
                </div>
              ))}
            </div>
          </section>
        ))}
        </div>
        {!consoleState.follow_tail && transcriptOutputs.length > 0 && (
          <button
            type="button"
            className="rho-console-jump-latest"
            onClick={() => commitConsole({ ...consoleState, follow_tail: true })}
          >Jump to latest</button>
        )}
        {consoleRunning && <div className="rho-console-busybar" role="progressbar" aria-label="Console is running code" />}
      </div>
      <div className="rho-console-composer">
        <div className="rho-console-input-row">
          <span className="rho-console-prompt" aria-hidden="true">&gt;</span>
          <textarea
            rows={1}
            ref={(element) => {
              if (element == null) return;
              element.style.height = "auto";
              element.style.height = `${element.scrollHeight}px`;
            }}
            aria-label={`Code for ${instance.instance_id}`}
            aria-describedby={`rho-console-hint-${instance.instance_id}`}
            title="Return to run · Shift+Return for a new line · Up/Down for history"
            value={consoleState.draft}
            disabled={attached == null || consoleRunning}
            onChange={(event) => consoleController.replaceState({ ...consoleState, draft: event.target.value, history_cursor: null })}
            onBlur={() => void consoleController.persistCurrent()}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submitConsole();
                return;
              }
              if ((event.key === "ArrowUp" || event.key === "ArrowDown") && consoleState.history.length > 0) {
                const atBoundary = event.key === "ArrowUp"
                  ? event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0
                  : event.currentTarget.selectionStart === event.currentTarget.value.length &&
                    event.currentTarget.selectionEnd === event.currentTarget.value.length;
                if (!atBoundary) return;
                event.preventDefault();
                const current = consoleState.history_cursor ?? consoleState.history.length;
                const cursor = event.key === "ArrowUp"
                  ? Math.max(0, current - 1)
                  : Math.min(consoleState.history.length, current + 1);
                consoleController.replaceState({
                  ...consoleState,
                  history_cursor: cursor === consoleState.history.length ? null : cursor,
                  draft: cursor === consoleState.history.length ? "" : consoleState.history[cursor] ?? "",
                });
              }
            }}
            placeholder={attached == null ? "Attach this Console to a Runtime" : "R code…"}
          />
          <button
            type="button"
            className={consoleBusy ? "rho-console-stop" : "rho-primary-action"}
            disabled={attached == null || (!consoleBusy && !consoleState.draft.trim())}
            onClick={() => {
              if (consoleBusy && attached != null) void interruptRuntime(attached).catch(reportError);
              else void submitConsole();
            }}
          >{consoleBusy ? "Stop" : "Run"}</button>
        </div>
        <div className="rho-console-input-hint rho-visually-hidden" id={`rho-console-hint-${instance.instance_id}`}>
          <span>Return to run</span>
          <span>Shift+Return for a new line</span>
          {consoleState.history.length > 0 && <span>↑↓ history</span>}
        </div>
      </div>
      {runtimeRecovering && attached != null && (
        <div className="rho-console-recovering" role="alert">
          <div className="rho-console-recovering-card">
            <span className="rho-preparation-spinner" aria-hidden="true" />
            <strong>{attached.display_label} is restarting</strong>
            <p>The workbench preserves this Console and its drafts while the Runtime recovers.</p>
            <div className="rho-console-recovering-actions">
              <button type="button" onClick={() => void interruptRuntime(attached).catch(reportError)}>Cancel restart</button>
              <button type="button" onClick={() => openSurfaceById("rho.logs")}>Open diagnostics</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
