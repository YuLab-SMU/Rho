import type { Studio } from './model.js';
const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export function agentPanel(studio: Studio, run: (work: () => Promise<unknown>) => void, changed: () => void, frozen: () => boolean) {
  const agent = studio.assistance;
  get('ask-agent').onclick = () => run(async () => {
    get<HTMLDialogElement>('agent-dialog').showModal();
    if (agent.data.pending || agent.data.opened) return;
    if (!studio.branch || !studio.document || studio.document.dirty) throw Error('Checkpoint current source edits before asking Agent.');
    await agent.prepare(studio.branch);
  });
  get('close-agent').onclick = () => get<HTMLDialogElement>('agent-dialog').close();
  get('prepare-agent').onclick = () => run(async () => {
    if (!studio.branch || !studio.document || studio.document.dirty) throw Error('Checkpoint current source edits before preparing a new request.');
    await agent.prepare(studio.branch);
  });
  get('refresh-agents').onclick = () => run(() => agent.list());
  get('more-agents').onclick = () => run(() => agent.list(true));
  get('open-agent').onclick = () => run(() => agent.open());
  get('inspect-agent').onclick = () => run(() => agent.recover());
  get('retry-agent').onclick = () => run(() => agent.dispatch());
  get<HTMLTextAreaElement>('agent-goal').oninput = event => { if (!frozen() && agent.data.input && !agent.data.pending && !agent.data.opened) { agent.data.input.goal = (event.target as HTMLTextAreaElement).value; changed(); } };
  get<HTMLSelectElement>('agent-instance').onchange = event => {
    if (frozen() || !agent.data.input || agent.data.pending || agent.data.opened) return;
    agent.data.input.instance = agent.candidates.find(i => i.instance.identity.instance === (event.target as HTMLSelectElement).value)?.instance.identity ?? null; changed();
  };
  return () => {
    const data = agent.data, input = data.input, disabled = frozen() || !!data.pending || !!data.opened;
    get<HTMLButtonElement>('ask-agent').disabled = frozen();
    get('agent-capture').textContent = input ? `${input.branch.plugin}\n${input.branch.name}\nCheckpoint ${input.branch.head}` : 'Select a development branch and checkpoint source edits first.';
    const goal = get<HTMLTextAreaElement>('agent-goal'); if (document.activeElement !== goal) goal.value = input?.goal ?? ''; goal.disabled = disabled || !input;
    const selector = get<HTMLSelectElement>('agent-instance');
    selector.replaceChildren(new Option('Choose an active Agent instance', ''));
    for (const item of agent.candidates) selector.add(new Option(`${item.instance.alias} · ${item.instance.identity.revision.slice(7, 15)}`, item.instance.identity.instance));
    if (input?.instance && !agent.candidates.some(i => i.instance.identity.instance === input.instance!.instance)) selector.add(new Option(`Captured Agent · ${input.instance.revision.slice(7, 15)}`, input.instance.instance));
    selector.value = input?.instance?.instance ?? ''; selector.disabled = disabled || !input;
    get('agent-availability').textContent = data.opened ? 'The original Agent view is retained. Task progress is available in Agent.' : data.pending ? 'The selected instance stays attached to the original request.' : agent.candidates.length ? 'Choose an installed Agent with Studio management tools enabled.' : 'No active Agent appears in this page. Open or restore Agent in Plugins, then refresh.';
    for (const id of ['refresh-agents', 'more-agents']) get<HTMLButtonElement>(id).disabled = disabled;
    get('more-agents').hidden = !agent.next;
    get<HTMLButtonElement>('prepare-agent').disabled = frozen() || !!data.pending || !studio.branch || !!studio.document?.dirty;
    get<HTMLButtonElement>('open-agent').disabled = disabled || !input?.instance || !input?.goal.trim();
    get('agent-pending').hidden = !data.pending;
    get('agent-request').textContent = data.pending ? data.pending.operation ?? data.pending.request : '';
    get<HTMLButtonElement>('inspect-agent').disabled = frozen() || !data.pending;
    get<HTMLButtonElement>('retry-agent').disabled = frozen() || !data.pending || data.pending.view !== studio.client.view.view;
    get('agent-opened').textContent = data.opened ? 'Agent view opened. Add this request to a task draft, then review and Send there. Return to Studio to open the resulting checkpoint before building.' : '';
  };
}
