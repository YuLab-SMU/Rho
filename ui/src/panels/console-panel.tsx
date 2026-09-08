import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Compartment, EditorState, StateEffect } from "@codemirror/state";
import { EditorView, keymap, Decoration, WidgetType } from "@codemirror/view";
import {
  history,
  historyKeymap,
  defaultKeymap,
  insertNewline,
} from "@codemirror/commands";
import {
  completionKeymap,
  acceptCompletion,
  closeCompletion,
  completionStatus,
} from "@codemirror/autocomplete";
import { searchKeymap } from "@codemirror/search";
import { useConsole, useOperations, useSession, useOutputs, useMediaCache, useObjects, usePreferences, useNavigation } from "../context";
import { mediaKey } from "../output-ports";
import { Modal } from "../primitives";
import { message, sameScope } from "../shared/ports";
import { locallyIncomplete, rSupport } from "../r-language";
import { observedText } from "../console-text";
import type { RunROutput } from "../generated/RunROutput";
const statuses: Record<string, string> = {
  accepted: "Queued",
  running: "Running",
  succeeded: "Completed",
  failed: "Failed",
  cancelled: "Interrupted",
  uncertain: "Unconfirmed",
  reconciling: "Reconciling",
};
class PlotThumbnail extends WidgetType {
  private mounts = new Map<HTMLElement, () => void>();
  constructor(
    readonly cache: ReturnType<typeof useMediaCache>,
    readonly navigation: ReturnType<typeof useNavigation>,
    readonly reference: import("../generated/MediaReference").MediaReference,
  ) { super(); }
  eq(other: PlotThumbnail) { return mediaKey(this.reference) === mediaKey(other.reference); }
  toDOM() {
    const button = document.createElement("button");
    button.className = "console-thumbnail";
    button.type = "button";
    button.title = "Show in Plots";
    button.setAttribute("aria-label", `Show Plot ${this.reference.sequence} in Plots`);
    button.onclick = () => this.navigation.locatePlot(this.reference);
    const img = document.createElement("img");
    img.alt = `R Plot ${this.reference.sequence}`;
    button.append(img);
    const label = document.createElement("span");
    label.textContent = "Show in Plots";
    button.append(label);
    const update = () => {
      const snapshot = this.cache.getSnapshot(), key = mediaKey(this.reference), url = snapshot.urls.get(key);
      if (url && img.getAttribute("src") !== url) img.src = url;
      label.textContent = snapshot.errors.get(key) ?? (url ? "Show in Plots" : "Loading original plot…");
    };
    this.mounts.set(button, this.cache.subscribe(update));
    this.cache.load(this.reference);
    update();
    return button;
  }
  destroy(dom: HTMLElement) { this.mounts.get(dom)?.(); this.mounts.delete(dom); }
  ignoreEvent() { return true; }
}
const inputStates = new WeakMap<object, EditorState>();
export function ConsolePanel({ viewId = "console" }: { viewId?: string }) {
  const consoleModel = useConsole(viewId), operations = useOperations(), session = useSession(),
    outputs = useOutputs(), cache = useMediaCache(), objects = useObjects(), preferences = usePreferences(), navigation = useNavigation(),
    output = outputs.getSnapshot(), draft = consoleModel.view(viewId), identity = consoleModel.viewIdentity(viewId),
    inputParent = useRef<HTMLDivElement>(null),
    transcriptParent = useRef<HTMLDivElement>(null),
    input = useRef<EditorView | null>(null),
    transcript = useRef<EditorView | null>(null),
    submit = useRef<(force: boolean) => void>(() => {});
  const [error, setError] = useState(""),
    [submitting, setSubmitting] = useState(false),
    [dialog, setDialog] = useState<"history" | "details" | "queue" | null>(
      null,
    ),
    [search, setSearch] = useState(""),
    [newOutput, setNewOutput] = useState(false);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const renderScope = session.context();
  const reportError = (error: unknown) => {
    if (input.current && consoleModel.viewIdentity(viewId) === identity && sameScope(renderScope, session.context(), true)) setError(message(error));
  };
  useEffect(() => { setSubmitting(false); setError(""); setAnswer(""); }, [session.epoch, identity]);
  const displayStatus = (
    r: import("../generated/OperationRecord").OperationRecord,
  ) =>
    !r.outcome &&
    consoleModel.consoleState?.pause?.operation_id === r.operation.operation_id
      ? "Unconfirmed"
      : (statuses[r.status] ?? r.status);
  const [answer, setAnswer] = useState(""),
    [answerHere, setAnswerHere] = useState(false),
    responseField = useRef<HTMLInputElement>(null);
  const composition = useRef(false),
    composingKey = useRef(false);
  const historyIndex = useRef(-1),
    historyDraft = useRef(""),
    lastScroll = useRef(draft.scrollTop);
  const records = [...operations.records.values()]
    .filter((r) => r.operation.capability.id === "workspace.run_r" && operations.getSummary(r.operation.operation_id))
    .sort((a, b) => operations.getSummary(a.operation.operation_id)!.cursor - operations.getSummary(b.operation.operation_id)!.cursor);
  let text = "";
  const marks: { from: number; to: number; class: string }[] = [],
    plots: {
      from: number;
      to: number;
      reference: import("../generated/MediaReference").MediaReference;
    }[] = [];
  for (const record of records) {
    const cleared = record.operation.accepted_at_ms < draft.hiddenBefore;
    const allEvents = output.events.get(record.operation.operation_id) ?? [],
      events = cleared
        ? allEvents.filter((e) => e.observed_at_ms >= draft.hiddenBefore)
        : allEvents;
    if (cleared && !events.length) continue;
    const id = record.operation.operation_id,
      args = record.operation.normalized_arguments as {
        code?: string;
        source?: { label: string; kind: string };
        output_mode?: string;
      },
      out = record.output as RunROutput | null;
    if (!cleared)
      text +=
        args.source?.kind === "file"
          ? `> Run File · ${args.source.label}\n`
          : (args.code ?? "")
              .split("\n")
              .map((l, i) => `${i ? "+" : ">"} ${l}`)
              .join("\n") + "\n";
    const rendered = observedText(`${id}:${draft.hiddenBefore}`, events),
      offset = text.length;
    text += rendered.text;
    marks.push(
      ...rendered.colors.map((m) => ({
        ...m,
        from: m.from + offset,
        to: m.to + offset,
      })),
    );
    if (!cleared && !events.length && out?.stdout) text += out.stdout;
    if (!cleared && !events.length && out?.stderr) text += out.stderr;
    if (out?.value != null) text += JSON.stringify(out.value) + "\n";
    if (args.output_mode !== "console" && out?.conditions?.length) {
      text += "[Recorded conditions]\n";
      for (const condition of out.conditions)
        text +=
          (typeof condition === "object" && condition && "message" in condition
            ? String(condition.message)
            : JSON.stringify(condition)) + "\n";
    }
    if (text && !text.endsWith("\n")) text += "\n";
    for (const event of events)
      if (event.media) {
        const from = text.length;
        text += `[Plot ${event.sequence} · Show in Plots]\n`;
        plots.push({ from, to: text.length, reference: event.media });
      }
    if (record.status === "cancelled")
      text += out?.session_id ? "[Interrupted]\n" : "[Not run · Cancelled]\n";
    if (record.status === "uncertain") text += "[Result unconfirmed]\n";
    if (record.status === "failed" && !out?.session_id) text += "[Not run]\n";
    if (record.error) {
      const from = text.length;
      text += `Error: ${record.error}\n`;
      marks.push({ from, to: text.length, class: "console-error" });
    }
    if (output.notices.has(id)) text += output.notices.get(id) + "\n";
    if (output.errors.has(id)) text += output.errors.get(id) + "\n";
    if (
      !["succeeded", "failed", "cancelled", "uncertain"].includes(record.status)
    )
      text += `[${displayStatus(record)}]\n`;
  }
  const decorations = useRef(new Compartment()),
    plotPositions = useRef(plots);
  plotPositions.current = plots;
  useEffect(() => {
    const nonce =
      document.querySelector<HTMLMetaElement>('meta[name="rho-csp-nonce"]')
        ?.content ?? "";
    const v = new EditorView({
      parent: transcriptParent.current!,
      state: EditorState.create({
        doc: "",
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.cspNonce.of(nonce),
          EditorView.contentAttributes.of({
            "aria-label": `Console Transcript ${viewId}`,
            tabindex: "0",
          }),
          decorations.current.of([]),
          keymap.of(searchKeymap),
          EditorView.domEventHandlers({
            scroll: () => {
              const scrollTop = v.scrollDOM.scrollTop;
              const bottom =
                v.scrollDOM.scrollHeight -
                  v.scrollDOM.scrollTop -
                  v.scrollDOM.clientHeight <
                36;
              const follow = bottom || (scrollTop >= lastScroll.current - 2 && consoleModel.view(viewId).follow);
              lastScroll.current = scrollTop;
              consoleModel.updateView(viewId, { scrollTop, follow });
              if (follow) setNewOutput(false);
            },
            click: (e) => {
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
              const plot = plotPositions.current.find(
                (p) => pos !== null && pos >= p.from && pos < p.to,
              );
              if (plot) {
                navigation.locatePlot(plot.reference);
                return true;
              }
              return false;
            },
          }),
        ],
      }),
    });
    transcript.current = v;
    v.scrollDOM.scrollTop = draft.scrollTop;
    return () => {
      consoleModel.updateView(viewId, { scrollTop: v.scrollDOM.scrollTop });
      v.destroy();
      transcript.current = null;
    };
  }, [identity, consoleModel, navigation, viewId]);
  useEffect(() => {
    const v = transcript.current;
    if (!v) return;
    const old = v.state.doc.toString();
    if (old === text) return;
    // Append only the changed suffix; retain transcript selection and scroll anchors.
    let from = 0;
    while (from < old.length && from < text.length && old[from] === text[from])
      from++;
    const follow = draft.follow;
    const colors = Decoration.set(
      [
        ...marks,
        ...plots.map((p) => ({
          from: p.from,
          to: p.to - 1,
          class: "console-plot-link",
        })),
      ]
        .filter((m) => m.to > m.from)
        .map((m) => Decoration.mark({ class: m.class }).range(m.from, m.to))
        .concat(
          plots.map((p) =>
            Decoration.widget({
              widget: new PlotThumbnail(cache, navigation, p.reference),
              side: 1,
            }).range(p.to - 1),
          ),
        ),
      true,
    );
    v.dispatch({
      changes: { from, to: old.length, insert: text.slice(from) },
      effects: [
        decorations.current.reconfigure(EditorView.decorations.of(colors)),
        ...(follow
          ? [EditorView.scrollIntoView(text.length, { y: "end" })]
          : []),
      ],
    });
    if (follow) {
      consoleModel.updateView(viewId, { follow: true });
      v.requestMeasure({
        read: () => v.scrollDOM.scrollHeight,
        write: (height) => {
          if (consoleModel.view(viewId).follow) {
            v.scrollDOM.scrollTop = height;
            lastScroll.current = v.scrollDOM.scrollTop;
          }
        },
      });
    } else setNewOutput(true);
  }, [text, identity]);
  useEffect(() => {
    const nonce =
      document.querySelector<HTMLMetaElement>('meta[name="rho-csp-nonce"]')
        ?.content ?? "";
    const browse = (direction: number, v: EditorView) => {
      const range = v.state.selection.main;
      if (!range.empty) return false;
      const at = v.coordsAtPos(range.head),
        boundary = v.coordsAtPos(direction < 0 ? 0 : v.state.doc.length);
      if (at && boundary && Math.abs(at.top - boundary.top) > 2) return false;
      if (!consoleModel.commandHistory.length) return false;
      if (historyIndex.current === -1) {
        historyDraft.current = v.state.doc.toString();
        historyIndex.current = consoleModel.commandHistory.length;
      }
      historyIndex.current = Math.max(
        0,
        Math.min(consoleModel.commandHistory.length, historyIndex.current + direction),
      );
      const code =
        historyIndex.current === consoleModel.commandHistory.length
          ? historyDraft.current
          : consoleModel.commandHistory[historyIndex.current];
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: code },
        selection: { anchor: direction < 0 ? 0 : code.length },
      });
      return true;
    };
    const extensions = [
      history(),
      ...rSupport(() => objects.data?.objects.map((o) => o.name) ?? []),
      EditorView.lineWrapping,
      EditorView.cspNonce.of(nonce),
      EditorView.contentAttributes.of({
        "aria-label":
          viewId === "console" ? "Console Input" : `Console Input ${viewId}`,
      }),
      keymap.of([
        {
          key: "Enter",
          run: (v) => {
            if (v.compositionStarted || composition.current || composingKey.current) return false;
            if (completionStatus(v.state) === "active" && acceptCompletion(v))
              return true;
            submit.current(false);
            return true;
          },
        },
        { key: "Shift-Enter", run: insertNewline },
        {
          key: "Mod-Enter",
          run: (v) => {
            if (!v.compositionStarted && !composition.current && !composingKey.current) submit.current(true);
            return true;
          },
        },
        { key: "ArrowUp", run: (v) => browse(-1, v) },
        { key: "ArrowDown", run: (v) => browse(1, v) },
        {
          key: "Escape",
          run: (v) => {
            if (closeCompletion(v)) return true;
            if (historyIndex.current !== -1) {
              const code = historyDraft.current;
              historyIndex.current = -1;
              v.dispatch({
                changes: { from: 0, to: v.state.doc.length, insert: code },
                selection: { anchor: code.length },
              });
              return true;
            }
            if (consoleModel.consoleState?.current) {
              void operations.cancel();
              return true;
            }
            return false;
          },
        },
        ...completionKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
    ];
    const configured = EditorState.create({
      doc: draft.input,
      extensions,
      selection: { anchor: draft.anchor ?? 0, head: draft.head ?? 0 },
    });
    const prior = inputStates.get(identity);
    const state = prior
      ? prior.update({ effects: StateEffect.reconfigure.of(extensions) }).state
      : configured;
    const v = new EditorView({
      parent: inputParent.current!,
      state,
      dispatchTransactions(transactions, view) {
        view.update(transactions);
        inputStates.set(identity, view.state);
        consoleModel.updateView(viewId, { input: view.state.doc.toString(),
          anchor: view.state.selection.main.anchor, head: view.state.selection.main.head });
      },
    });
    input.current = v;
    const beginComposition = () => {
      composition.current = true;
    };
    const endComposition = () => {
      composition.current = false;
    };
    const captureKey = (event: KeyboardEvent) => {
      composingKey.current =
        event.isComposing || event.keyCode === 229 || composition.current;
    };
    v.contentDOM.addEventListener("compositionstart", beginComposition, true);
    v.contentDOM.addEventListener("compositionend", endComposition, true);
    v.contentDOM.addEventListener("keydown", captureKey, true);
    return () => {
      v.contentDOM.removeEventListener(
        "compositionstart",
        beginComposition,
        true,
      );
      v.contentDOM.removeEventListener("compositionend", endComposition, true);
      v.contentDOM.removeEventListener("keydown", captureKey, true);
      inputStates.set(identity, v.state);
      v.destroy();
      input.current = null;
    };
  }, [consoleModel, identity, viewId]);
  const replaceInput = (code: string, focus = true) => {
    const v = input.current;
    if (v) {
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: code },
        selection: { anchor: code.length },
      });
      if (focus) v.focus();
    }
  };
  useEffect(() => {
    if (input.current && input.current.state.doc.toString() !== draft.input)
      replaceInput(draft.input);
  });
  async function run(force: boolean) {
    const v = input.current,
      code = v?.state.doc.toString() ?? "";
    if (!v || v.compositionStarted || composition.current || submitting || !code.trim()) return;
    const scope = session.context();
    setError("");
    if (!force) {
      let incomplete = locallyIncomplete(code),
        indent = "";
      if (session.runtime?.state === "idle" && session.project) {
        try {
          const result = await consoleModel.checkCode(code);
          if (result) {
            incomplete = result.status === "incomplete";
            indent = result.indent;
          }
        } catch {
          /* Native execution remains the parser authority. */
        }
      }
      if (input.current !== v || v.compositionStarted || composition.current || !sameScope(scope, session.context(), true) || v.state.doc.toString() !== code) return;
      if (incomplete) {
        v.dispatch(v.state.replaceSelection("\n" + indent));
        return;
      }
    }
    setSubmitting(true);
    try {
      await consoleModel.run(code, viewId);
      if (input.current !== v || !sameScope(scope, session.context(), true)) return;
      if (v.state.doc.toString() === code) replaceInput("", v.hasFocus);
      if (v.hasFocus && consoleModel.consoleState?.input && !draft.input) {
        setAnswerHere(true);
        requestAnimationFrame(() => responseField.current?.focus());
      }
      historyIndex.current = -1;
    } catch (e) {
      if (input.current === v && sameScope(scope, session.context(), true)) setError(message(e));
    } finally {
      if (input.current === v && sameScope(scope, session.context(), true)) setSubmitting(false);
    }
  }
  submit.current = (force) => {
    void run(force);
  };
  const pendingInput = consoleModel.consoleState?.input;
  useEffect(() => {
    setAnswer("");
    setAnswerHere(false);
    if (
      pendingInput &&
      !pendingInput.submitted &&
      consoleModel.consoleState?.current?.source?.view_id === viewId &&
      input.current?.hasFocus &&
      !draft.input
    ) {
      setAnswerHere(true);
      requestAnimationFrame(() => responseField.current?.focus());
    }
  }, [pendingInput?.request_id]);
  async function respond() {
    if (!pendingInput || !session.project) return;
    const scope = session.context(), requestId = pendingInput.request_id;
    const current = () => input.current && sameScope(scope, session.context(), true) && consoleModel.consoleState?.input?.request_id === requestId;
    try {
      await consoleModel.respond(answer);
      if (current()) setAnswer("");
    } catch (e) {
      if (current()) { setAnswer(""); setError(message(e)); }
    }
  }
  return (
    <section
      className="panel console-panel"
      data-console-view={viewId}
      style={
        {
          "--console-font-size": `${preferences.editorFontSize}px`,
        } as CSSProperties
      }
    >
      <div className="console-status">
        <span>
          {submitting
            ? "Submitting…"
            : pendingInput
              ? pendingInput.submitted
                ? "Answer submitted · Waiting for R"
                : "R needs input"
              : consoleModel.consoleState?.current
                ? "Running"
                : consoleModel.consoleState?.pause
                  ? "Queue paused"
                  : session.runtime?.state === "idle"
                    ? "Ready"
                    : session.runtime?.state === "busy"
                      ? "R busy"
                      : "R unavailable"}
        </span>
        <div className="spacer" />
        <button onClick={() => setDialog("queue")}>
          Queue {consoleModel.consoleState?.pending.length ?? 0}
        </button>
        <button
          aria-label="Command History"
          onClick={() => setDialog("history")}
        >
          History
        </button>
        <button aria-label="Run Details" onClick={() => setDialog("details")}>
          Details
        </button>
        <button
          disabled={!consoleModel.consoleState?.current}
          onClick={() => void operations.cancel()}
        >
          Interrupt
        </button>
      </div>
      <div className="console-transcript" ref={transcriptParent} />
      {newOutput && (
        <button
          className="new-output"
          onClick={() => {
            consoleModel.updateView(viewId, { follow: true });
            setNewOutput(false);
            const v = transcript.current;
            if (v) v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight;
          }}
        >
          New Output ↓
        </button>
      )}
      {consoleModel.consoleState?.pause && (
        <div className="queue-notice">
          {consoleModel.consoleState.pause.reason}
          {consoleModel.consoleState.pause.operation_id && (
            <button
              onClick={() => {
                const id = consoleModel.consoleState!.pause!.operation_id!;
                setDetailsFor(id);
                setDialog("details");
                void operations.reviewOperation(id);
              }}
            >
              Inspect Stopped Run
            </button>
          )}
          <button
            onClick={() =>
              void consoleModel.queueControl(false).catch(reportError)
            }
          >
            Resume Queue
          </button>
        </div>
      )}
      {pendingInput && !pendingInput.submitted && (
        <div className="stdin-request">
          <span>{pendingInput.prompt || "R requests input"}</span>
          {answerHere ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void respond();
              }}
            >
              <input
                ref={responseField}
                aria-label={
                  pendingInput.password
                    ? "Password Response"
                    : "R Input Response"
                }
                type={pendingInput.password ? "password" : "text"}
                autoComplete="off"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
              />
              <button className="primary">Answer</button>
            </form>
          ) : (
            <button
              onClick={() => {
                setAnswerHere(true);
                requestAnimationFrame(() => responseField.current?.focus());
              }}
            >
              Answer Here
            </button>
          )}
        </div>
      )}
      {(error || consoleModel.getSnapshot().error || operations.getSnapshot().error) && (
        <div className="document-error" role="alert">
          {error || consoleModel.getSnapshot().error || operations.getSnapshot().error}
        </div>
      )}
      {operations.pending.some((p) => p.error) && (
        <div className="queue-notice">
          Some requests are unconfirmed.
          <button onClick={() => setDialog("details")}>Review Requests</button>
        </div>
      )}
      <div className="console-prompt">
        <span>&gt;</span>
        <div className="console-input" ref={inputParent} />
        <button
          className="primary"
          disabled={submitting || !operations.canRun || !draft.input.trim()}
          onClick={() => void run(true)}
        >
          {operations.queueing ? "Queue" : "Run"}
        </button>
      </div>
      <div className="panel-footer">
        <span>Shared R session</span>
        <button
          onClick={() => {
            consoleModel.clearView(viewId);
          }}
        >
          Clear View
        </button>
      </div>
      {dialog && (
        <Modal
          title={
            dialog === "history"
              ? "Command History"
              : dialog === "queue"
                ? "Execution Queue"
                : "Run Details"
          }
          description={
            dialog === "history"
              ? "Retrieve a command to edit before running it."
              : dialog === "queue"
                ? "Runs execute serially in the shared R session."
                : "Recorded requests, original code and observed outcomes."
          }
          onClose={() => setDialog(null)}
        >
          {dialog === "history" ? (
            <>
              <input
                aria-label="Search Command History"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="command-list">
                {[...consoleModel.commandHistory]
                  .reverse()
                  .filter((code) =>
                    code.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((code, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        historyDraft.current = draft.input;
                        historyIndex.current =
                          consoleModel.commandHistory.lastIndexOf(code);
                        replaceInput(code);
                        setDialog(null);
                      }}
                    >
                      <code>{code}</code>
                    </button>
                  ))}
              </div>
            </>
          ) : dialog === "queue" ? (
            <>
              <button
                onClick={() =>
                  void consoleModel
                    .queueControl(!consoleModel.consoleState?.pause)
                    .catch(reportError)
                }
              >
                {consoleModel.consoleState?.pause ? "Resume Queue" : "Pause Queue"}
              </button>
              <button
                onClick={() =>
                  void consoleModel.cancelPending().catch(reportError)
                }
              >
                Cancel Pending Runs
              </button>
              {consoleModel.consoleState?.pending.map((run, i) => (
                <div className="queue-row" key={run.operation_id}>
                  <span>
                    {i + 1}. {run.source?.label ?? "R request"}
                  </span>
                  <pre>{run.summary}</pre>
                  <button
                    onClick={() =>
                      void consoleModel
                        .cancelPending(run.operation_id)
                        .catch(reportError)
                    }
                  >
                    Cancel Pending
                  </button>
                  <button
                    onClick={() => {
                      void operations
                        .reviewOperation(run.operation_id)
                        .then(() => {
                          const args = operations.records.get(run.operation_id)
                            ?.operation.normalized_arguments as
                            | { code?: string }
                            | undefined;
                          if (typeof args?.code !== "string")
                            throw new Error(
                              "The full queued code is unavailable. Your input is retained.",
                            );
                          replaceInput(args.code);
                          setDialog(null);
                        })
                        .catch(reportError);
                    }}
                  >
                    Copy to Console
                  </button>
                </div>
              ))}
            </>
          ) : (
            <>
              <button onClick={() => void operations.loadRecent(true).catch(reportError)}>
                Load Earlier Runs
              </button>
              <button
                onClick={() => {
                  consoleModel.showHistory(viewId);
                }}
              >
                Show Cleared History
              </button>
              {operations.pending
                .filter((p) => p.error)
                .map((p) => (
                  <div key={p.invocation.client_request_id}>
                    <p>{p.error}</p>
                    <button onClick={() => void operations.reconcilePending().catch(reportError)}>
                      Check Original Request
                    </button>
                    <button onClick={() => void operations.retryPending(p).catch(reportError)}>
                      Retry Original Request (Same ID)
                    </button>
                  </div>
                ))}
              {records.map((r) => (
                <details
                  key={r.operation.operation_id}
                  open={r.operation.operation_id === detailsFor}
                >
                  <summary>
                    {displayStatus(r)} · {r.operation.operation_id} ·{" "}
                    {new Date(r.operation.accepted_at_ms).toLocaleString()}
                  </summary>
                  <pre>{JSON.stringify(r, null, 2)}</pre>
                  {(output.notices.has(r.operation.operation_id) || output.errors.has(r.operation.operation_id)) && (
                    <div className="queue-notice">
                      {output.errors.get(r.operation.operation_id) || output.notices.get(r.operation.operation_id)}
                      <button onClick={() => outputs.retry(r.operation.operation_id)}>Retry Output</button>
                    </div>
                  )}
                  <button
                    onClick={() => {
                      replaceInput(
                        String(
                          (
                            r.operation.normalized_arguments as {
                              code?: string;
                            }
                          ).code ?? "",
                        ),
                      );
                      setDialog(null);
                    }}
                  >
                    Copy to Console
                  </button>
                </details>
              ))}
            </>
          )}
        </Modal>
      )}
    </section>
  );
}
