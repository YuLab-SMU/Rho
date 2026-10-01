import type { AgentNativeToolSelection } from '../sdk/index.js';
import type { NativeAgentModel } from './native-model.js';

export interface StudioRequest { request_id: string; branch: string; revision: string; title: string; text: string; }
export function studioRequest(configuration: unknown): StudioRequest | null {
  const request = (configuration as {studio_request?: StudioRequest} | null)?.studio_request;
  if (request == null) return null;
  if (!/^[a-f0-9-]{36}$/.test(request.request_id) || typeof request.branch !== 'string' || !request.branch ||
    !/^sha256:[a-f0-9]{64}$/.test(request.revision) || typeof request.title !== 'string' || !request.title || request.title.length > 160 ||
    typeof request.text !== 'string' || !request.text.trim() || new TextEncoder().encode(request.text).length > 8192)
    throw Error('The Studio request is invalid. Its original view configuration is retained.');
  return structuredClone(request);
}
/** One local state write retains both the insertion and its receipt. Draft
 * synchronization uses the existing task owner; no model or task is started. */
export async function addStudioRequest(model: NativeAgentModel, task: string, request: StudioRequest, tools: AgentNativeToolSelection[]) {
  if (model.state.studioRequestApplied?.request === request.request_id) throw Error('This Studio request was already added to a task draft.');
  if (model.busy || model.state.pending.some(p => p.task === task) || model.state.drafts[task]?.conflict)
    throw Error('Resolve the original task request or draft conflict before adding the Studio request.');
  const draft = model.draft(task), text = [draft.text, request.text].filter(Boolean).join('\n\n');
  if (new TextEncoder().encode(text).length > 32768) throw Error('The combined draft exceeds 32 KiB. Shorten it before adding this request.');
  model.edit(task, { ...draft, text });
  model.state.tools = structuredClone(tools);
  model.state.studioRequestApplied = {request: request.request_id, task};
  await model.save();
  await model.flush(task);
}
