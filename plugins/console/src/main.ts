import {componentInputDialog} from '../public/agent-input/dialog.js';
import {consoleContext} from './agent-source.js';
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, Decoration } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, insertNewline } from "@codemirror/commands";
import { acceptCompletion, closeCompletion, completionKeymap, completionStatus } from "@codemirror/autocomplete";
import { searchKeymap } from "@codemirror/search";
import { connectPluginView } from "../public/plugin-ui/index.js";
import type { InstanceRef } from "../public/plugin-protocol/index.js";
import type { CodeCompleteness } from "../public/r-protocol/index.js";
import { ConsoleModel, terminal, visibleRun, type Run } from "./model.js";
import { observedText } from "./terminal.js";
import { rSupport, locallyIncomplete } from "./r-language.js";

const client = await connectPluginView();
const model = new ConsoleModel(client, (client.view.configuration as { source: InstanceRef }).source);
const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const state = model.state, message = get("message"), status = get("status"), transcriptMarks = new Compartment();
let initialScroll: { top: number; follow: boolean } | null = { top: state.scrollTop, follow: state.follow };
let stopped = false, saving: ReturnType<typeof setTimeout> | undefined, submitting = false, refreshing = false, lastHistory = 0;
let closing = false;
let selectedAgentRun: Run | null = null;
const sender = componentInputDialog({client,saved:state.agent,persist:async value=>{state.agent=structuredClone(value);await model.save();},
  guard:()=>{if(closing||stopped)throw Error('Console is closing. The original request is retained.');},
  modes:[{value:'transcript',label:'Code and recorded output'},{value:'code',label:'Original code only'}],
  capture:kind=>consoleContext(model.source,client.view.window,selectedAgentRun,kind)});
get('agent-request').hidden=!state.agent?.pending;
get('agent-request').onclick=()=>sender.open();
const localWork = new Set<Promise<unknown>>();
function tracked<T>(work: Promise<T>): Promise<T> {
  localWork.add(work);
  void work.then(() => localWork.delete(work), () => localWork.delete(work));
  return work;
}
let composition = false, composingKey = false, compositionEndedAt = -Infinity;
let historyIndex = -1, historyDraft = "", inputRequest = "", answerClaimed = false;
let answerComposition = false, answerEndedAt = -Infinity, answering = false;
const labels: Record<string, string> = { accepted: "Queued", running: "Running", succeeded: "Completed", failed: "Failed", cancelled: "Cancelled", uncertain: "Unconfirmed", reconciling: "Reconciling" };
function notice(text = "") { message.textContent = text; message.hidden = !text; }
function report(error: unknown) { if (!stopped) notice(error instanceof Error ? error.message : String(error)); }
function save() {
  clearTimeout(saving);
  if (closing || stopped) return;
  saving = setTimeout(() => {
    void model.save().then(() => { get("save-error").textContent = ""; })
      .catch(error => { get("save-error").textContent = `Draft not saved: ${String(error instanceof Error ? error.message : error)}`; });
  }, 500);
}
function action(work: () => Promise<unknown>) {
  if (closing || stopped) return Promise.resolve();
  return tracked((async () => { try { notice(); await work(); } catch (error) { report(error); } finally { render(); void refresh(); } })());
}
const transcript = new EditorView({ parent: get("transcript"), state: EditorState.create({ extensions: [
  EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping,
  EditorView.contentAttributes.of({ "aria-label": "Console Transcript", tabindex: "0" }),
  transcriptMarks.of([]), keymap.of(searchKeymap),
  EditorView.domEventHandlers({ scroll: () => {
    if (closing || stopped) return;
    const dom = transcript.scrollDOM;
    state.scrollTop = dom.scrollTop;
    state.follow = dom.scrollHeight - dom.scrollTop - dom.clientHeight < 36;
    if (state.follow) get("new-output").hidden = true;
    save();
  } }),
] }) });
function browse(direction: number, view: EditorView) {
  const selection = view.state.selection.main;
  if (!selection.empty || !state.history.length) return false;
  const here = view.coordsAtPos(selection.head), edge = view.coordsAtPos(direction < 0 ? 0 : view.state.doc.length);
  if (!here || !edge || Math.abs(here.top - edge.top) > 2) return false;
  if (historyIndex < 0) { historyDraft = view.state.doc.toString(); historyIndex = state.history.length; }
  historyIndex = Math.max(0, Math.min(state.history.length, historyIndex + direction));
  const text = state.history[historyIndex] ?? historyDraft;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: direction < 0 ? 0 : text.length } });
  return true;
}
function restoreDraft() {
  if (historyIndex < 0) return false;
  historyIndex = -1;
  input.dispatch({ changes: { from: 0, to: input.state.doc.length, insert: historyDraft }, selection: { anchor: historyDraft.length } });
  return true;
}
function submit(explicit = false, retry = false) {
  if (closing || stopped) return Promise.resolve();
  return tracked(performSubmit(explicit, retry));
}
async function performSubmit(explicit: boolean, retry: boolean) {
  if (submitting || composition || input.compositionStarted || composingKey) return;
  submitting = true; render();
  const text = input.state.doc.toString();
  try {
    notice();
    if (!retry && !text.trim()) return;
    if (!explicit && !retry) {
      let incomplete = false, indent = "";
      if (model.session?.state === "idle" && !model.queue?.console.current && !model.queue?.console.pending.length && !model.queue?.awaiting_commit.length) {
        const checked = await model.query<CodeCompleteness>("r.check_code", { expected_session: model.session.session_id, code: text }, model.session.session_id);
        incomplete = checked.status === "incomplete"; indent = checked.indent;
      } else incomplete = locallyIncomplete(text);
      if (input.state.doc.toString() !== text || composition || input.compositionStarted) return;
      if (incomplete) { input.dispatch(input.state.replaceSelection(`\n${indent}`)); return; }
    }
    await model.submit(retry);
    historyIndex = -1;
    if (input.state.doc.toString() === text) input.dispatch({ changes: { from: 0, to: input.state.doc.length, insert: state.input }, selection: { anchor: state.anchor, head: state.head } });
  } catch (error) { report(error); }
  finally { submitting = false; render(); void refresh(); }
}
const input = new EditorView({ parent: get("command"), state: EditorState.create({ doc: state.input, selection: { anchor: state.anchor, head: state.head }, extensions: [
  history(), ...rSupport(), EditorView.lineWrapping,
  EditorView.contentAttributes.of({ "aria-label": "Console Input", spellcheck: "false" }),
  keymap.of([
    { key: "Enter", run: view => { if (composition || view.compositionStarted || composingKey) return false; if (completionStatus(view.state) === "active" && acceptCompletion(view)) return true; void submit(); return true; } },
    { key: "Shift-Enter", run: insertNewline },
    { key: "Mod-Enter", run: () => { void submit(true); return true; } },
    { key: "ArrowUp", run: view => browse(-1, view) }, { key: "ArrowDown", run: view => browse(1, view) },
    { key: "Escape", run: view => closeCompletion(view) || restoreDraft() },
    ...completionKeymap, ...defaultKeymap, ...historyKeymap,
  ]),
  EditorView.updateListener.of(update => {
    if (update.docChanged || update.selectionSet) { state.input = update.state.doc.toString(); state.anchor = update.state.selection.main.anchor; state.head = update.state.selection.main.head; save(); }
  }),
] }) });
input.contentDOM.addEventListener("compositionstart", () => { composition = true; compositionEndedAt = -Infinity; }, true);
input.contentDOM.addEventListener("compositionend", () => { composition = false; compositionEndedAt = performance.now(); }, true);
input.contentDOM.addEventListener("keydown", event => {
  const native = event.isComposing || event.keyCode === 229 || composition;
  const endingEnter = !native && event.key === "Enter" && performance.now() - compositionEndedAt < 100;
  composingKey = native || endingEnter;
  if (!native) compositionEndedAt = -Infinity;
  if (endingEnter) event.preventDefault();
}, true);

function runLabel(run: Run) {
  const queued = model.queue?.console.pending.some(item => item.operation_id === run.id);
  return `${queued ? "Queued" : labels[run.status] ?? run.status}${run.cancellationRequested && !terminal(run.status) ? " · cancellation requested" : ""}`;
}
function renderTranscript() {
  let text = "";
  const marks: { from: number; to: number; class: string }[] = [];
  for (const run of [...model.runs.values()].sort((a, b) => a.accepted - b.accepted || a.id.localeCompare(b.id))) {
    const visible = visibleRun(run, state); if (!visible) continue;
    const header = `${run.source?.label ?? "R"} · ${runLabel(run)} · ${run.id.slice(0, 8)}\n`;
    marks.push({ from: text.length, to: text.length + header.length, class: "run-heading" }); text += header;
    if (visible.showCode) text += run.code.split("\n").map((line, index) => `${index ? "+" : ">"} ${line}`).join("\n") + "\n";
    const output = observedText(run.id, visible.events);
    marks.push(...output.colors.map(mark => ({ ...mark, from: mark.from + text.length, to: mark.to + text.length })));
    text += output.text;
    if (text && !text.endsWith("\n")) text += "\n";
    for (const notice of run.notices) text += `[${notice}]\n`;
    if (run.record.error) text += `${typeof run.record.error === "string" ? run.record.error : JSON.stringify(run.record.error)}\n`;
    text += "\n";
  }
  const old = transcript.state.doc.toString();
  if (old === text) return;
  let from = 0; while (from < old.length && from < text.length && old[from] === text[from]) from++;
  let oldEnd = old.length, newEnd = text.length;
  while (oldEnd > from && newEnd > from && old[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd--; }
  transcript.dispatch({ changes: { from, to: oldEnd, insert: text.slice(from, newEnd) }, effects: [
    transcriptMarks.reconfigure(EditorView.decorations.of(Decoration.set(marks.filter(mark => mark.to > mark.from).map(mark => Decoration.mark({ class: mark.class }).range(mark.from, mark.to)), true))),
    ...(state.follow ? [EditorView.scrollIntoView(text.length, { y: "end" })] : []),
  ] });
  if (initialScroll && text) {
    const saved = initialScroll; initialScroll = null;
    // The initially empty editor cannot restore a scroll offset. Wait until
    // the retained transcript has been laid out before restoring its viewport.
    requestAnimationFrame(() => {
      if (!stopped && !closing && !saved.follow) { state.follow = false; transcript.scrollDOM.scrollTop = saved.top; }
    });
  }
  if (!state.follow) get("new-output").hidden = false;
}
function render() {
  if (closing || stopped) return;
  get("agent-request").hidden=!state.agent?.pending;
  const queue = model.queue, session = model.session;
  get<HTMLButtonElement>("earlier").disabled = model.historyLoaded && (model.cursor === null || model.historyLimited);
  get("history-limit").hidden = !model.historyLimited;
  get("history-limit").textContent = "Showing up to 100 completed runs plus active work. Earlier runs remain in the original Operation history.";
  status.textContent = !session ? "Connecting to R…" : !model.liveAvailable ? "R observation unavailable" : session.state === "unstarted" ? "R has not started" :
    `${session.state === "idle" ? "Ready" : session.state} · ${queue?.console.pending.length ?? 0} queued${queue?.awaiting_commit.length ? " · awaiting result commit" : ""}`;
  get("pause-reason").textContent = queue?.console.pause?.reason ?? "";
  get("pause-reason").hidden = !queue?.console.pause;
  get<HTMLButtonElement>("start").hidden = session?.state !== "unstarted";
  get<HTMLButtonElement>("start").disabled = !model.liveAvailable || !!queue?.console.current || !!queue?.console.pending.length;
  get<HTMLButtonElement>("run").disabled = submitting || !model.liveAvailable || !session?.session_id || state.submission !== null;
  get("retry").hidden = state.submission === null;
  get<HTMLButtonElement>("retry").disabled = submitting || state.submission?.view !== client.view.view;
  get("inspect-submission").hidden = state.submission === null;
  get<HTMLButtonElement>("inspect-submission").disabled = submitting;
  get<HTMLButtonElement>("pause").textContent = queue?.console.pause ? "Resume Queue" : "Pause Queue";
  get<HTMLButtonElement>("pause").disabled = !model.liveAvailable || !queue;
  get<HTMLButtonElement>("interrupt").disabled = !model.liveAvailable || !queue?.console.current || queue.awaiting_commit.includes(queue.console.current.operation_id);
  const request = queue?.console.input;
  get("stdin").hidden = !request;
  if (request?.request_id !== inputRequest) {
    inputRequest = request?.request_id ?? ""; answerClaimed = false; get<HTMLInputElement>("answer").value = "";
  }
  if (request) {
    get("input-prompt").textContent = request.prompt || "R is waiting for input";
    get("input-status").textContent = answering ? "Sending answer…" : request.submitted ? "Answer submitted; waiting for R to continue." : "Answer this native R request separately from the next command.";
    get<HTMLInputElement>("answer").type = request.password ? "password" : "text";
    get("answer-form").hidden = !answerClaimed || request.submitted;
    get("answer-here").hidden = answerClaimed || request.submitted;
    get<HTMLButtonElement>("answer-here").disabled = answering || !model.liveAvailable;
    get<HTMLButtonElement>("send-answer").disabled = answering || !model.liveAvailable;
  }
  renderTranscript();
}
function refresh() {
  if (refreshing || stopped || closing) return Promise.resolve();
  return tracked(performRefresh());
}
async function performRefresh() {
  refreshing = true;
  try {
    if (Date.now() - lastHistory > 3000) { await model.history(); lastHistory = Date.now(); }
    await model.refresh(); get("observation-error").textContent = ""; render();
  } catch (error) { get("observation-error").textContent = `Live observation unavailable: ${String(error instanceof Error ? error.message : error)}`; render(); }
  finally { refreshing = false; }
}
const dialog = get<HTMLDialogElement>("details"), content = get("details-content");
function show(title: string) { get("details-title").textContent = title; content.replaceChildren(); dialog.showModal(); }
function button(label: string, work: () => void) { const result = document.createElement("button"); result.textContent = label; result.onclick = work; return result; }
function code(text: string) { const element = document.createElement("pre"); element.textContent = text; return element; }
function copyToInput(text: string) { input.dispatch({ changes: { from: 0, to: input.state.doc.length, insert: text }, selection: { anchor: text.length } }); dialog.close(); input.focus(); }
function showQueue() {
  show("R queue");
  for (const run of model.queue?.console.pending ?? []) {
    const row = document.createElement("section"); row.append(code(`${run.source?.label ?? "R"} · ${run.operation_id}\n${run.summary}`));
    const fenced = model.queue?.pending_cancellations?.includes(run.operation_id);
    row.append(button(fenced ? "Retry Pending Cancellation" : "Cancel Pending", () => { dialog.close(); void action(() => model.cancel(run.operation_id, true)); }));
    const original = model.runs.get(run.operation_id);
    if (original) row.append(button("Copy to Console", () => copyToInput(original.code)));
    content.append(row);
  }
  if (!content.children.length) content.append(code("No pending runs."));
}
get("history").onclick = () => { show("Command history"); for (const text of [...state.history].reverse()) content.append(button(text, () => copyToInput(text))); };
get("records").onclick = () => {
  show("Run details");
  for (const run of [...model.runs.values()].reverse()) {
    const details = document.createElement("details"), summary = document.createElement("summary");
    summary.textContent = `${run.source?.label ?? "R"} · ${runLabel(run)} · ${run.id}`;
    details.append(summary, code(run.code), code(JSON.stringify({ operation: run.id, session: run.session, provider: model.source,
      input_label: run.source, status: run.status, cancellation_requested: run.cancellationRequested, diagnostics: run.record.diagnostics,
      error: run.record.error, recovery: run.record.recovery, output: run.record.output }, null, 2)), button("Copy to Console", () => copyToInput(run.code)));
    const ask=button("Ask about…",()=>{selectedAgentRun=structuredClone(run);dialog.close();sender.open();});
    ask.disabled=!state.agent?.pending&&(!terminal(run.status)||!run.retained);const annotate=button("Annotate",()=>{selectedAgentRun=structuredClone(run);dialog.close();sender.annotate();});annotate.disabled=!terminal(run.status)||!run.retained;details.append(annotate,ask);sender.bindAnnotation(annotate);
    content.append(details);
  }
};
get("queue").onclick = showQueue;
get("close-details").onclick = () => dialog.close();
get("clear").onclick = () => { model.clearView(); save(); renderTranscript(); };
get("show-all").onclick = () => { model.showHistory(); save(); renderTranscript(); };
get("new-output").onclick = () => { state.follow = true; transcript.dispatch({ effects: EditorView.scrollIntoView(transcript.state.doc.length, { y: "end" }) }); get("new-output").hidden = true; save(); };
get("run").onclick = () => { composingKey = false; void submit(true); };
get("retry").onclick = () => { composingKey = false; void submit(true, true); };
get("inspect-submission").onclick = () => {
  if (closing || stopped || submitting) return;
  submitting = true; render();
  void action(async () => {
    try {
      const run = await model.recoverSubmission();
      if (input.state.doc.toString() !== state.input) input.dispatch({ changes: { from: 0, to: input.state.doc.length, insert: state.input }, selection: { anchor: state.anchor, head: state.head } });
      notice(`Original submission found: ${labels[run.status] ?? run.status}. No command was resubmitted.`);
    } finally { submitting = false; }
  });
};
get("start").onclick = () => { void action(() => model.startSession()); };
get("pause").onclick = () => { void action(() => model.queueControl(!model.queue?.console.pause)); };
get("interrupt").onclick = () => { const id = model.queue?.console.current?.operation_id; if (id) void action(() => model.cancel(id, false)); };
get("earlier").onclick = () => { void action(() => model.history(true)); };
get("refresh").onclick = () => { lastHistory = 0; void refresh(); };
get("answer-here").onclick = () => { answerClaimed = true; render(); get<HTMLInputElement>("answer").focus(); };
get("answer").addEventListener("compositionstart", () => { answerComposition = true; answerEndedAt = -Infinity; }, true);
get("answer").addEventListener("compositionend", () => { answerComposition = false; answerEndedAt = performance.now(); }, true);
get("answer").addEventListener("keydown", event => {
  const native = answerComposition || event.isComposing || event.keyCode === 229;
  const endingEnter = !native && event.key === "Enter" && performance.now() - answerEndedAt < 100;
  if (!native) answerEndedAt = -Infinity;
  if (event.key === "Enter") {
    event.preventDefault();
    if (!native && !endingEnter) sendAnswer();
  }
}, true);
// Opaque plugin frames disable native form submission, including its submit
// event. Both explicit actions use the public transient Control instead.
function sendAnswer() {
  const request = model.queue?.console.input;
  if (!request || request.submitted || answerComposition || answering || !answerClaimed || !model.liveAvailable) return;
  const answer = get<HTMLInputElement>("answer"), value = answer.value;
  answer.value = ""; answerClaimed = false; answering = true; render();
  void action(async () => { try { await model.respond(request, value); } finally { answering = false; } });
}
get("send-answer").onclick = sendAnswer;
get("identity").textContent = `${model.source.instance} · ${model.source.revision.slice(0, 19)}`;
get("identity").title = JSON.stringify(model.source, null, 2);
render();
const close = await client.installCloseHandler({
  async flush() {
    closing = true; clearTimeout(saving);
    if(sender.busy)throw Error("Wait for the current Agent request before closing.");
    // Wait only for local capture/acceptance and bounded reads. An accepted R
    // execution keeps running after its Console view has closed.
    await Promise.allSettled([...localWork]);
    if (get<HTMLInputElement>("answer").value) throw new Error("Send or clear the pending R input answer before closing this view. Answers are not saved in view state.");
    state.input = input.state.doc.toString();
    state.anchor = input.state.selection.main.anchor; state.head = input.state.selection.main.head;
    clearTimeout(saving); await model.save(); get("save-error").textContent = "";
  },
  resume() { closing = false; render(); void refresh(); },
});
close.subscribe(() => { const error = close.getSnapshot().error; if (error) notice(error); });
const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 1000);
window.addEventListener("pagehide", () => { stopped = true; clearInterval(timer); clearTimeout(saving); sender.dispose(); model.dispose(); input.destroy(); transcript.destroy(); get<HTMLInputElement>("answer").value = ""; }, { once: true });
await refresh();
