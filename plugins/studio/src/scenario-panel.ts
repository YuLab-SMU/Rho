import type { PluginInspection, ScenarioRevision, ScenarioSummary } from '../public/plugin-protocol/index.js';
import type { Studio } from './model.js';
import { read } from './model.js';
import { scenarioViews, type PreviewEvidence } from './scenario.js';
import { same } from './operations.js';
import { own } from './visual.js';
const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const short = (id: string) => id.startsWith('sha256:') ? id.slice(7, 15) : id;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const item = document.createElement(tag); item.textContent = text; return item; };
export function scenarioPanel(studio: Studio, run: (work: () => Promise<unknown>) => void, changed: () => void, frozen: () => boolean) {
  const app = studio.application;
  let scenarios: ScenarioSummary[] = [], next: string | null = null, inspection: PluginInspection | null = null, historyNext: string | null = null, history: string[] = [], selected: ScenarioRevision | null = null;
  const evidence = (): PreviewEvidence | null => {
    const dev = studio.development.data, input = dev.inputs;
    if (input && dev.previewed?.revision === input.revision && dev.previewed.artifact === input.artifact) return dev.previewed;
    const test = dev.testing?.project?.project;
    const subject = test?.instances.subject;
    if (input && subject && ['ready', 'stopped'].includes(test!.state) && subject.revision === input.revision && subject.artifact === input.artifact) return subject;
    return null;
  };
  async function list(more = false) {
    const page = await app.list(more ? next : null);
    if (more && page.scenarios.some(item => scenarios.some(prior => prior.scenario === item.scenario))) throw Error('Scenario pagination repeated a named scenario.');
    if (page.next !== null && (!page.scenarios.some(item => item.scenario === page.next) || more && next !== null && page.next <= next)) throw Error('Scenario pagination did not advance.');
    scenarios = more ? [...scenarios, ...page.scenarios] : page.scenarios; next = page.next;
    const select = get<HTMLSelectElement>('scenario-target'); select.replaceChildren(new Option('Choose a named scenario', ''));
    for (const item of scenarios) select.append(new Option(item.name, item.revision));
    if (app.data.target && !scenarios.some(item => item.revision === app.data.target!.id)) select.append(new Option(`${app.data.target.name} · captured checkpoint`, app.data.target.id));
  }
  async function inspectHistory(revision: string) {
    selected = await app.get(revision);
    const parent = selected.parent ? await app.get(selected.parent) : null;
    if (parent && parent.scenario !== selected.scenario) throw Error('Scenario history changed its identity.');
    get('scenario-comparison-title').textContent = parent ? `${short(parent.id)} → ${short(selected.id)}` : `${short(selected.id)} · first checkpoint`;
    const host = get('scenario-changes'); host.replaceChildren();
    const before = parent?.instances ?? {}, after = selected.instances;
    for (const alias of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const prior = own(before, alias), next = own(after, alias);
      if (same(prior, next)) continue;
      host.append(el('p', `${alias}: ${prior ? short(prior.revision) : 'absent'} → ${next ? short(next.revision) : 'absent'}`));
    }
    for (const key of ['name', 'providers', 'layout'] as const) if (!same(parent?.[key], selected[key])) host.append(el('p', `${key === 'layout' ? 'Layout and saved view state' : key === 'providers' ? 'Provider selections' : 'Scenario name'} changed`));
    if (!host.childElementCount) host.append(el('p', 'Contents match the parent checkpoint.'));
    get('scenario-before').textContent = parent ? JSON.stringify(parent, null, 2) : 'No parent checkpoint';
    get('scenario-after').textContent = JSON.stringify(selected, null, 2);
    get('scenario-dialog').dataset.detail = 'true';
    document.querySelectorAll<HTMLElement>('#scenario-history [data-revision]').forEach(button => button.setAttribute('aria-current', String(button.dataset.revision === revision)));
  }
  async function listHistory(more = false) {
    if (!app.data.target) return;
    if (!more) { history = []; historyNext = app.data.target.id; get('scenario-history').replaceChildren(); }
    for (let count = 0; count < 20 && historyNext; count++) {
      const value = await app.get(historyNext);
      if (history.includes(value.id) || value.scenario !== app.data.target.scenario) throw Error('Scenario history repeated or changed its identity.');
      history.push(value.id); historyNext = value.parent;
      const button = el('button', `${short(value.id)}${value.id === app.data.target.id ? ' · captured head' : ''}`); button.className = 'item'; button.dataset.revision = value.id;
      button.onclick = () => run(() => inspectHistory(value.id)); get('scenario-history').append(button);
    }
    if (!more) await inspectHistory(app.data.target.id);
  }
  get('scenario-application').onclick = () => run(async () => {
    get<HTMLDialogElement>('scenario-dialog').showModal(); get('scenario-dialog').dataset.detail = app.data.target ? 'true' : 'false';
    await list();
    const revision = studio.document?.data.revision;
    if (revision) {
      if (!app.data.pending && !studio.pending && !studio.development.data.pending && !studio.development.data.testing?.pending && !studio.drafts.unresolved) await studio.development.configure(revision);
      inspection = await read(studio.client, 'plugins.inspect', {revision});
    }
    if (app.data.target) await listHistory();
  });
  get('close-scenario').onclick = () => get<HTMLDialogElement>('scenario-dialog').close();
  get('back-scenario').onclick = () => { get('scenario-dialog').dataset.detail = 'false'; get('scenario-target').focus(); };
  get('more-scenarios').onclick = () => run(() => list(true));
  get('more-scenario-history').onclick = () => run(() => listHistory(true));
  get<HTMLSelectElement>('scenario-target').onchange = () => { const revision = get<HTMLSelectElement>('scenario-target').value; if (revision) run(async () => { await app.select(revision, studio.plugin); await listHistory(); }); };
  get<HTMLSelectElement>('scenario-alias').onchange = () => { const alias = get<HTMLSelectElement>('scenario-alias').value; run(() => app.chooseAlias(alias)); };
  get<HTMLSelectElement>('scenario-artifact').onchange = () => { if (frozen() || app.data.pending || !studio.development.data.inputs) return; studio.development.data.inputs.artifact = get<HTMLSelectElement>('scenario-artifact').value; changed(); render(); };
  get<HTMLTextAreaElement>('scenario-states').oninput = () => { if (frozen() || app.data.pending) return; app.data.states = get<HTMLTextAreaElement>('scenario-states').value; changed(); };
  get('scenario-preview').onclick = () => { get<HTMLDialogElement>('scenario-dialog').close(); get('development').click(); };
  get('stage-scenario').onclick = () => run(async () => {
    const input = studio.development.data.inputs;
    if (!input || studio.document?.dirty || input.revision !== studio.document?.data.revision) throw Error('Choose a saved source checkpoint and its exact built artifact.');
    await app.stage(input.revision, input.artifact, evidence());
  });
  get('save-scenario').onclick = () => run(async () => { await app.saveCheckpoint(); await list(); await listHistory(); });
  get('restore-scenario').onclick = () => run(async () => { if (!selected) return; await app.restoreCheckpoint(selected.id); await list(); await listHistory(); });
  get('prepare-scenario').onclick = () => run(() => app.prepare());
  get('restart-scenario').onclick = () => run(() => app.restartPreparation());
  get('apply-scenario').onclick = () => run(() => app.apply());
  get('inspect-scenario').onclick = () => run(async () => { await app.recover(); if (!app.data.pending && app.data.target) { await list(); await listHistory(); } });
  get('retry-scenario').onclick = () => run(() => app.dispatch());
  function render() {
    const data = app.data, disabled = frozen() || !!data.pending, input = studio.development.data.inputs;
    get<HTMLButtonElement>('scenario-application').disabled = frozen();
    get('scenario-summary').hidden = !data.pending;
    get('scenario-summary').textContent = data.pending ? 'Scenario request awaiting confirmation. Open Apply to scenario to inspect the original result.' : '';
    get('scenario-pending').hidden = !data.pending;
    get('scenario-request').textContent = data.pending ? `${data.pending.intent.capability.id} · ${data.pending.intent.operation ?? data.pending.intent.request}` : '';
    get<HTMLButtonElement>('inspect-scenario').disabled = frozen() || !data.pending;
    get<HTMLButtonElement>('retry-scenario').disabled = frozen() || !data.pending || data.pending.intent.view !== studio.client.view.view;
    const target = get<HTMLSelectElement>('scenario-target'); target.value = data.target?.id ?? ''; target.disabled = disabled;
    get('more-scenarios').hidden = next === null; get('more-scenario-history').hidden = historyNext === null;
    get('scenario-name').textContent = data.target ? `${data.target.name} · ${short(data.target.id)}` : 'Choose a named scenario to inspect its history.';
    const aliases = get<HTMLSelectElement>('scenario-alias'), entries = Object.entries(data.target?.instances ?? {}).filter(([, value]) => value.plugin === studio.plugin), key = JSON.stringify(entries);
    if (aliases.dataset.key !== key) { aliases.dataset.key = key; aliases.replaceChildren(new Option('Choose instance alias', '')); for (const [alias] of entries) aliases.append(new Option(alias, alias)); }
    aliases.value = data.alias; aliases.disabled = disabled;
    const artifacts = get<HTMLSelectElement>('scenario-artifact'), artifactKey = JSON.stringify(inspection?.artifacts);
    if (artifacts.dataset.key !== artifactKey) { artifacts.dataset.key = artifactKey; artifacts.replaceChildren(); for (const value of inspection?.artifacts ?? []) artifacts.append(new Option(`${short(value.id)} · ${value.target}`, value.id)); }
    artifacts.value = input?.artifact ?? ''; artifacts.disabled = disabled || !inspection || input?.revision !== inspection.summary.revision;
    get('scenario-source').textContent = studio.document ? `Source checkpoint ${short(studio.document.data.revision)}${studio.document.dirty ? ' · unsaved edits excluded' : ''}` : 'Choose a source checkpoint.';
    get('scenario-preview-status').textContent = evidence() ? 'Preview or backend test recorded for this exact build.' : 'Preview this exact build before staging a scenario change.';
    const states = get<HTMLTextAreaElement>('scenario-states'); if (document.activeElement !== states) states.value = data.states; states.disabled = disabled;
    get<HTMLButtonElement>('stage-scenario').disabled = disabled || !data.alias || !evidence() || !input?.artifact || !!studio.document?.dirty;
    get<HTMLButtonElement>('scenario-preview').disabled = disabled || !studio.document;
    get<HTMLButtonElement>('save-scenario').disabled = disabled || !data.draft || !!data.saved;
    get('scenario-proposal').textContent = data.draft ? JSON.stringify(data.draft, null, 2) : 'No staged scenario change.';
    get('scenario-proposal-section').hidden = !data.draft;
    get<HTMLButtonElement>('restore-scenario').disabled = disabled || !selected || selected.id === data.target?.id;
    get<HTMLButtonElement>('prepare-scenario').disabled = disabled || !data.saved;
    get<HTMLButtonElement>('restart-scenario').disabled = disabled || !data.preparation;
    get<HTMLButtonElement>('apply-scenario').disabled = disabled || !data.preparation?.ready;
    const prep = data.preparation;
    get('scenario-lifecycle').textContent = data.saved ? `Saved checkpoint ${short(data.saved.id)}. ${prep ? `${Object.keys(prep.request.instances).length}/${Object.keys(data.saved.instances).length} instances · ${Object.keys(prep.request.views).length}/${scenarioViews(data.saved.layout).length} views prepared${prep.ready ? ' · ready to apply' : ''}.` : 'Prepare instances to validate the current window.'}` : 'Save a checkpoint before preparing instances.';
    get('scenario-applied').textContent = data.applied ? `Applied ${short(data.applied.scenario!.revision)} to this window at layout version ${data.applied.layout.version}. Other windows retain their selections.` : '';
    get('scenario-retained').textContent = data.retained.instances.length ? `${data.retained.instances.length} instance identities and ${data.retained.views.length} view identities retained for inspection and reuse. Manage their lifetime in Plugins.` : '';
  }
  return render;
}
