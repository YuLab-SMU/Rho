import type { AgentContextSelection, ProjectAgentTaskRef } from '../sdk/index.js';
import type { NativeAgentModel } from './native-model.js';
import type { RhoModel } from './rho-model.js';
import { ContextPicker, contextInputIssue } from './context-model.js';
import { same } from './operations.js';

export interface ComponentRequest { request_id: string; title: string; sources: AgentContextSelection[]; }
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export function componentRequest(configuration: unknown, window: string): ComponentRequest | null {
  const value = (configuration as { component_request?: ComponentRequest } | null)?.component_request;
  if (value == null) return null;
  if (!/^[a-f0-9-]{36}$/.test(value.request_id) || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 160 ||
    !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 16 || bytes(value) > 16384 ||
    value.sources.some(source => source?.source !== 'plugin' || typeof source.label !== 'string' || !source.label.trim() || source.label.length > 160 ||
      typeof source.inclusion !== 'string' || !source.inclusion || !(source.reference as { provider?: unknown })?.provider ||
      (source.reference as { window?: unknown })?.window !== window))
    throw Error('The component request is invalid or belongs to another window. Its original configuration is retained.');
  return structuredClone(value);
}
const identicalSource = (a: AgentContextSelection, b: AgentContextSelection) =>
  a.source === b.source && same(a.reference, b.reference) && same(JSON.parse(a.inclusion), JSON.parse(b.inclusion));

/** Components offer references, never task/tool authority. Validate the current
 * source, then append to the latest controlled draft without sending a message. */
export async function addComponentRequest(owner: NativeAgentModel, rho: RhoModel, picker: ContextPicker,
  request: ComponentRequest, target: ProjectAgentTaskRef) {
  const model = target.kind === 'native' ? owner : rho, id = target.kind === 'native' ? target.task_id : target.conversation_id;
  const selected = () => target.kind === 'native' ? owner.state.selected === id && !rho.state.selected : rho.state.selected === id;
  const check = () => {
    if (owner.state.componentRequestApplied?.request === request.request_id) throw Error('This component request was already added to a task draft.');
    if (!selected() || !model.canControl(id) || model.busy || model.state.pending.some(p => p.task === id) || model.state.drafts[id]?.conflict)
      throw Error('Choose an editable task and resolve its original request before adding this context.');
  };
  check();
  for (const source of request.sources) {
    const retained = await picker.retained(source); check();
    const issue = contextInputIssue(retained.preview);
    if (issue) throw Error('This source is partial or includes unsupported files. ' + issue + ' The draft is retained.');
  }
  check();
  // Read after previews so text typed during those observations is preserved.
  const draft = model.draft(id), context = structuredClone(draft.context);
  for (const source of request.sources) if (!context.some(previous => identicalSource(previous, source))) context.push(structuredClone(source));
  if (context.length + draft.assets.length > (target.kind === 'native' ? 20 : 16))
    throw Error('The combined draft has too many context references and attachments. Remove some before adding this request.');
  model.edit(id, { ...draft, context });
  owner.state.componentRequestApplied = {request: request.request_id, target: structuredClone(target)};
  // One view-state acknowledgement saves both the local insertion and its receipt.
  // A lost owner draft reply uses the existing original-request recovery surface.
  await owner.save(); await model.flush(id);
}
