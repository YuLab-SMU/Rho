import type { ComponentModelProtocol } from '../sdk/index.js';
import type { NativeAgentModel } from './native-model.js';
import type { Client } from './operations.js';
import { ModelSettings } from './model-settings.js';

export function mountSettings(client: Client, owner: NativeAgentModel, track: <T>(work: Promise<T>) => Promise<T>) {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = get<HTMLDialogElement>('settings-dialog'), key = get<HTMLInputElement>('settings-key');
  const model = new ModelSettings(client, owner.state, () => owner.save(), render);
  const input = (id: string) => get<HTMLInputElement>(`settings-${id}`);
  let stopped = false;
  function report(error: unknown) { if (!stopped) { get('settings-error').textContent = error instanceof Error ? error.message : String(error); get('settings-error').hidden = false; } }
  function act(work: () => Promise<unknown>) {
    get('settings-error').hidden = true;
    void track(Promise.resolve().then(work)).then(() => model.refresh()).catch(report).finally(render);
  }
  function render() {
    if (stopped || !dialog.open) return;
    const draft = model.state.draft, connection = draft?.connection, credential = connection?.credential;
    const source = credential?.kind === 'environment' ? 'environment' : 'local_file';
    get('settings-form').hidden = !draft;
    get('settings-loading').hidden = !!draft;
    for (const [id, value] of Object.entries({ protocol: connection?.protocol ?? 'anthropic', url: connection?.base_url ?? '', model: connection?.model ?? '', source,
      environment: credential?.kind === 'environment' ? credential.name : '' })) {
      const element = input(id); if (document.activeElement !== element) element.value = value;
      element.disabled = model.locked;
    }
    input('enabled').checked = !!draft?.enabled; input('enabled').disabled = model.locked;
    get('settings-key-row').hidden = source !== 'local_file'; get('settings-environment-row').hidden = source !== 'environment';
    key.disabled = model.busy || model.state.key?.kind === 'remove';
    const available = !!model.credential?.available;
    get('settings-key-status').textContent = available && credential?.kind === 'local_file' && credential.key_id === (model.credential?.credential as {key_id?: string})?.key_id
      ? '•••••••• · Saved on this computer' : 'Saved in this Agent instance when you select Save.';
    const configured = model.credential?.credential;
    get('settings-environment-status').textContent = available && credential?.kind === 'environment' && configured?.kind === 'environment' && credential.name === configured.name
      ? 'The configured environment variable is available.' : 'Set this variable in the environment that launches Rho.';
    get<HTMLButtonElement>('settings-save').disabled = model.locked;
    get<HTMLButtonElement>('settings-reload').disabled = model.locked || !model.dirty;
    get<HTMLButtonElement>('settings-remove-key').hidden = source !== 'local_file' || !available;
    get<HTMLButtonElement>('settings-remove-key').disabled = model.locked || model.dirty || !!key.value;
    const canTest = !model.locked && !model.dirty && !key.value && !!model.current?.enabled && available && !model.state.pending.some(p => p.intent.capability.id === 'agent.model.test');
    get<HTMLButtonElement>('settings-test-connection').disabled = !canTest; get<HTMLButtonElement>('settings-test-images').disabled = !canTest;
    get('settings-version').textContent = model.current && draft?.version !== model.current.version ? 'Settings changed in another view. Your edits are retained; reload saved settings before continuing.' : model.dirty || key.value ? 'Unsaved changes' : 'Settings saved';
    const recovery = get('settings-recovery'); recovery.replaceChildren(); recovery.hidden = !model.state.key && !model.state.pending.length;
    function requestRow(label: string, inspect: () => Promise<unknown>, retry?: () => Promise<unknown>) {
      const row = document.createElement('div'), text = document.createElement('p'); text.textContent = label; row.append(text);
      const check = document.createElement('button'); check.type = 'button'; check.textContent = 'Check original request'; check.disabled = model.busy; check.onclick = () => act(inspect); row.append(check);
      if (retry) { const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Retry original request'; button.disabled = model.busy; button.onclick = () => act(retry); row.append(button); }
      recovery.append(row);
    }
    if (model.state.key) requestRow(model.state.key.kind === 'store' ? 'The saved key request needs inspection. Retrying requires the original key.' : 'The key removal needs inspection.',
      () => model.inspectKey(), async () => { const secret = key.value; key.value = ''; await model.retryKey(secret); });
    for (const pending of model.state.pending) requestRow(`${pending.intent.capability.id === 'agent.model.configure' ? 'Save settings' : pending.intent.capability.id === 'agent.model.test' ? 'Model test' : 'Stop test'} · ${pending.status ?? 'Unconfirmed'}`,
      () => model.inspect(pending.intent.request), pending.intent.operation ? undefined : () => model.retry(pending.intent.request));
    const tests = get('settings-tests'), signature = JSON.stringify([...model.diagnostics.values(), model.busy]);
    if (tests.dataset.content !== signature) {
      tests.dataset.content = signature; tests.replaceChildren();
      for (const request of model.state.tests) {
        const test = model.diagnostics.get(request); if (!test) continue;
        const row = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('p'); row.className = 'settings-test';
        title.textContent = `${test.kind === 'images' ? 'Image input' : 'Connection'} · ${test.state}`;
        detail.textContent = `${test.model.model} · settings ${test.model_settings_version}`; row.append(title, detail);
        if (test.detail) { const details = document.createElement('details'), summary = document.createElement('summary'), text = document.createElement('p'); summary.textContent = 'Details'; text.textContent = test.detail; details.append(summary, text); row.append(details); }
        if (['queued', 'running'].includes(test.state)) { const stop = document.createElement('button'); stop.type = 'button'; stop.textContent = 'Stop test'; stop.disabled = model.busy; stop.onclick = () => act(() => model.stopTest(request)); row.append(stop); }
        tests.append(row);
      }
    }
  }
  function edit() {
    const draft = structuredClone(model.state.draft); if (!draft) return;
    draft.enabled = input('enabled').checked;
    const source = input('source').value;
    draft.connection = { protocol: input('protocol').value as ComponentModelProtocol, base_url: input('url').value, model: input('model').value,
      credential: source === 'environment' ? { kind: 'environment', name: input('environment').value }
        : draft.connection?.credential.kind === 'local_file' ? draft.connection.credential : { kind: 'local_file', key_id: '' } };
    if (source === 'environment') key.value = '';
    void track(model.edit(draft)).catch(report);
  }
  for (const id of ['enabled', 'protocol', 'url', 'model', 'source', 'environment']) input(id).addEventListener('input', edit);
  key.oninput = render;
  // Ordinary views intentionally have no allow-forms sandbox privilege. Invoke
  // the public port from the explicit button instead of HTML form submission.
  get('settings-save').onclick = () => {
    if (!get<HTMLFormElement>('settings-form').reportValidity()) return;
    const secret = key.value; key.value = ''; act(() => model.configure(secret));
  };
  get('settings-form').onkeydown = event => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || !(event.target instanceof HTMLInputElement)) return;
    event.preventDefault(); get<HTMLButtonElement>('settings-save').click();
  };
  get('settings-reload').onclick = () => { key.value = ''; act(() => model.useCurrent()); };
  get('settings-remove-key').onclick = () => act(() => model.removeKey());
  get('settings-test-connection').onclick = () => act(() => model.test('connection'));
  get('settings-test-images').onclick = () => act(() => model.test('images'));
  get('settings-close').onclick = () => dialog.close();
  get('open-settings').onclick = () => { get('actions-menu').hidePopover(); dialog.showModal(); render(); act(() => model.refresh()); };
  return {
    async refresh() { if (dialog.open) { try { await model.refresh(); } catch (error) { report(error); } } },
    prepareClose() { if (key.value) throw Error('Save or clear the API key field before closing this Agent view.'); },
    dispose() { stopped = true; key.value = ''; model.dispose(); },
  };
}
