import {componentInputDialog} from '../public/agent-input/dialog.js';
import type {AgentState} from '../public/agent-input/input.js';
import {captureDocument,captureViewer} from './capture.js';
import {viewerContext} from './agent-source.js';
import { connectPluginView, readResource } from "../public/plugin-ui/index.js";
import type { InstanceRef } from "../public/plugin-protocol/index.js";
import { key, matches, mergeHistory, readHistory, readOperation, type SavedOutput, type Selection } from "./outputs.js";

const client = await connectPluginView();
const source = (client.view.configuration as { source: InstanceRef }).source;
const initial = client.view.state as { selected?: Selection | null; history?: boolean; follow?: boolean; agent?:AgentState };
let state: {selected:Selection|null;history:boolean;follow:boolean;agent?:AgentState} = {...(initial.agent?{agent:initial.agent}:{}), selected: initial.selected ?? null, history: initial.history !== false, follow: initial.follow !== false };
const find = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const history = find("history"), message = find("message"), surface = find("surface"), sourceDetails = find("source-details");
const refresh = find<HTMLButtonElement>("refresh"), earlier = find<HTMLButtonElement>("earlier"), follow = find<HTMLButtonElement>("follow");
let outputs: SavedOutput[] = [], current: SavedOutput | null = null, cursor: number | null = null;
let initialized = false, fetching = false, stopped = false, generation = 0, controller: AbortController | null = null;
let closing = false, stateQueue:Promise<unknown>=Promise.resolve();
function persistState(){const next=stateQueue.then(async()=>{await client.setState(structuredClone(state) as never);});stateQueue=next.catch(()=>undefined);return next;}
const sender=componentInputDialog({client,saved:initial.agent,persist:async value=>{state.agent=structuredClone(value);await persistState();},
  guard:()=>{if(stopped||closing)throw Error('Viewer is closing. The original request is retained.');},
  captureView:async()=>{const frame=surface.querySelector('iframe');if(!frame||!current)throw Error('Select a displayed Viewer output first.');const identity=key(current);const pixels=await captureViewer(frame);if(!current||key(current)!==identity)throw Error('The Viewer changed during capture. Prepare the selected output again.');return pixels;},
  annotationMode:'metadata',modes:[{value:'metadata',label:'Output details'},{value:'text',label:'Saved HTML source'}],
  capture:kind=>{if(!current)throw Error('Select a saved output first.');return viewerContext(source,client.view.window,current,kind);}});
find('ask-agent').onclick=()=>sender.open();
const annotate=document.createElement('button');annotate.type='button';annotate.textContent='Annotate';annotate.disabled=true;annotate.onclick=()=>sender.annotate();find('ask-agent').before(annotate);sender.bindAnnotation(annotate);
function notice(text: string, error = false) { message.textContent = text; message.className = error ? "notice error" : "notice"; message.hidden = !text; }
function releaseSurface() {
  controller?.abort(); controller = null; surface.replaceChildren();
}
function renderHistory() {
  history.replaceChildren(); history.hidden = !state.history; earlier.hidden = !state.history || cursor === null;
  find("toggle-history").textContent = state.history ? "Hide" : "History";
  follow.setAttribute("aria-pressed", String(state.follow));
  for (const output of outputs) {
    const button = document.createElement("button"); button.className = "history-item";
    button.textContent = `Output ${output.sequence} · ${output.operation.slice(0, 8)}`;
    button.title = `Run ${output.operation} · ${output.status}`;
    button.setAttribute("aria-current", String(current !== null && key(current) === key(output)));
    button.onclick = () => { state.follow = false; void select(output, true); };
    history.append(button);
  }
}
async function saveState() {
  try { await persistState(); find("state-error").hidden = true; }
  catch (error) { if (!stopped) { const warning = find("state-error"); warning.textContent = `View choice was not saved: ${String(error instanceof Error ? error.message : error)}`; warning.hidden = false; } }
}
async function select(output: SavedOutput, save = false, force = false) {
  if (!force && current && key(current) === key(output)) { if (save) { renderHistory(); await saveState(); } return; }
  const selectedGeneration = ++generation; releaseSurface(); current = output;
  find<HTMLButtonElement>("ask-agent").disabled=false;annotate.disabled=false;
  state.selected = { operation_id: output.operation, resource_id: output.reference.resource };
  find("identity").textContent = `Output ${output.sequence} · Run ${output.operation.slice(0, 8)}`;
  find("status").textContent = `Saved HTML · ${output.status === "succeeded" ? "Completed run" : `${output.status} run`}`;
  const input = output.inputSource ? `Input: ${output.inputSource.label} (${output.inputSource.kind})\nView: ${output.inputSource.view_id}\n` : "";
  sourceDetails.textContent = `${input}Operation: ${output.operation}\nSession: ${output.session}\nPlugin: ${source.plugin}\nInstance: ${source.instance}\nRevision: ${source.revision}\nArtifact: ${source.artifact}\nResource: ${output.reference.resource}\nDigest: ${output.reference.digest}`;
  notice("Opening saved HTML…"); renderHistory();
  const abort = new AbortController(); controller = abort;
  if (save) void saveState();
  try {
    const bytes = await readResource(client, output.reference, { signal: abort.signal });
    // The owner contract is UTF-8. Fail explicitly instead of replacing glyphs.
    const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (stopped || selectedGeneration !== generation) return;
    const frame = document.createElement("iframe"); frame.title = "Saved HTML output";
    frame.setAttribute("sandbox", "allow-scripts"); frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("allow", "clipboard-read 'none'; clipboard-write 'none'; camera 'none'; microphone 'none'; geolocation 'none'");
    frame.onload = () => { if (!stopped && selectedGeneration === generation) notice(""); };
    frame.srcdoc = captureDocument(html); surface.replaceChildren(frame);
  } catch (error) {
    if (!stopped && selectedGeneration === generation && !abort.signal.aborted)
      notice(`Saved HTML could not be opened: ${String(error instanceof Error ? error.message : error)}`, true);
  }
}
async function update(older = false) {
  if (fetching || stopped || closing || (older && cursor === null)) return;
  fetching = true; refresh.disabled = true; earlier.disabled = true;
  try {
    const page = await readHistory(client, source, older ? cursor : null);
    if (stopped || closing) return;
    const all = new Map(outputs.map(output => [key(output), output]));
    for (const output of page.items) all.set(key(output), output);
    if (!initialized && state.selected && !Array.from(all.values()).some(output => matches(output, state.selected!))) {
      for (const output of await readOperation(client, source, state.selected.operation_id)) all.set(key(output), output);
    }
    if (stopped || closing) return;
    outputs = mergeHistory([], Array.from(all.values()), state.selected, older);
    if (!initialized || older) cursor = page.next;
    initialized = true;
    const selected = state.follow ? outputs[0] : outputs.find(output => state.selected && matches(output, state.selected));
    renderHistory();
    if (selected) await select(selected);
    else if (!current) notice(state.selected ? "The selected saved output is unavailable; its original identity was preserved." : "No HTML output selected. Run code that produces HTML output.");
  } catch (error) { if (!stopped) notice(String(error instanceof Error ? error.message : error), true); }
  finally { fetching = false; refresh.disabled = false; earlier.disabled = false; }
}
find("toggle-history").onclick = () => { state.history = !state.history; renderHistory(); void saveState(); };
earlier.onclick = () => { void update(true); };
follow.onclick = () => { state.follow = !state.follow; renderHistory(); if (state.follow && outputs[0]) void select(outputs[0], true); else void saveState(); };
refresh.onclick = () => { if (current) void select(current, false, true); void update(); };
renderHistory();
const close = await client.installCloseHandler({
  async flush() { closing = true;if(sender.busy)throw Error('Wait for the current Agent request before closing.');await persistState(); },
  resume() { closing = false; void update(); },
});
close.subscribe(() => { const error = close.getSnapshot().error; if (error) notice(error, true); });
const timer = setInterval(() => { if (!document.hidden) void update(); }, 3000);
window.addEventListener("pagehide", () => { stopped = true; sender.dispose();generation++; clearInterval(timer); releaseSurface(); client.dispose(); }, { once: true });

await update();
