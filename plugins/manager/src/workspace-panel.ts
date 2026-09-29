import type { PluginCatalogPage, PluginInspection } from '../public/plugin-protocol/index.js';
import { Manager, read, short } from './model.js';
import { scientificPlugins, workspacePlugins, scientificWorkspace, type ScientificPlugin, type WorkspaceChoices, type WorkspaceChoice } from './scientific-workspace.js';

/** Uses the existing reviewed scenario dialog and prepare/switch interaction. */
export function workspacePanel(manager: Manager, act: (work: () => Promise<unknown> | void) => void, saveSoon: () => void, refresh: () => Promise<void>) {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = get<HTMLDialogElement>('workspace-dialog');
  const choices = new Map<string, WorkspaceChoice>();
  let backendTarget = '';
  const draft = () => manager.state.workspaceDraft ??= { name: 'R workspace', ark: '', r_home: '', choices: {} };
  for (const key of ['name', 'ark', 'r_home'] as const) {
    get<HTMLInputElement>(`workspace-${key}`).oninput = event => { draft()[key] = (event.target as HTMLInputElement).value; saveSoon(); };
  }
  get<HTMLButtonElement>('cancel-workspace').onclick = () => act(async () => { await manager.save(); dialog.close(); });
  get<HTMLButtonElement>('prepare-workspace').onclick = () => act(async () => {
    const selected = {} as WorkspaceChoices;
    for (const key of workspacePlugins) {
      if (!draft().choices[key] && !scientificPlugins.includes(key as ScientificPlugin)) continue;
      const value = choices.get(draft().choices[key] ?? '');
      if (!value || value.inspection.manifest.id !== `org.rho.${key}`) throw Error(`Select an installed ${key} artifact.`);
      selected[key] = value;
    }
    const current = await read<{ layout: { version: number } }>(manager.client, 'windows.scenario', { window: manager.client.view.window });
    await manager.startWorkspace(scientificWorkspace(selected, backendTarget, { ark: draft().ark.trim(), r_home: draft().r_home.trim() }, current.layout.version, `r-workspace-${crypto.randomUUID()}`, draft().name));
    dialog.close();
    try { await manager.prepareWorkspace(); } finally { await refresh(); }
  });
  return {
    async open() {
      if (manager.state.workspace) {
        try { await manager.prepareWorkspace(); } finally { await refresh(); }
        return;
      }
      const repository = await read<{ backend_target: string }>(manager.client, 'plugins.repository', {});
      backendTarget = repository.backend_target; choices.clear();
      let after: string | null = null;
      for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
        const page: PluginCatalogPage = await read(manager.client, 'plugins.list', { after, limit: 100 });
        for (const item of page.items) {
          if (!workspacePlugins.some(key => item.plugin === `org.rho.${key}`)) continue;
          const inspection = await read<PluginInspection>(manager.client, 'plugins.inspect', { revision: item.revision });
          const target = inspection.manifest.backend ? backendTarget : 'ui-web';
          for (const artifact of inspection.artifacts.filter(a => a.target === target)) choices.set(artifact.id, { inspection, artifact: artifact.id });
        }
        after = page.next;
        if (!after) break;
      }
      if (after) throw Error('The installed catalog exceeds this bounded selection. Use an explicit scenario for the desired revisions.');
      const list = get<HTMLDivElement>('workspace-packages'); list.replaceChildren();
      for (const key of workspacePlugins) {
        const label = document.createElement('label'); label.htmlFor = `workspace-${key}-package`; label.textContent = key === 'r' ? 'R runtime' : key[0].toUpperCase() + key.slice(1);
        const select = document.createElement('select'); select.id = label.htmlFor;
        const entries = [...choices].filter(([, value]) => value.inspection.manifest.id === `org.rho.${key}`);
        select.add(new Option(scientificPlugins.includes(key as ScientificPlugin) ? (entries.length ? 'Select revision…' : 'No revision') : 'Not included', ''));
        for (const [id, value] of entries) select.add(new Option(`${value.inspection.manifest.version} · ${short(value.inspection.summary.revision)} · ${short(id)}`, id));
        const retained = draft().choices[key]; select.value = retained !== undefined ? (entries.some(([id]) => id === retained) ? retained : '') : entries.length === 1 ? entries[0][0] : '';
        draft().choices[key] = select.value;
        select.onchange = () => { draft().choices[key] = select.value; saveSoon(); };
        list.append(label, select);
      }
      for (const key of ['name', 'ark', 'r_home'] as const) get<HTMLInputElement>(`workspace-${key}`).value = draft()[key];
      await manager.save(); dialog.showModal();
    },
    render(error: string) {
      get('workspace-error').textContent = error;
      const button = document.querySelector<HTMLButtonElement>('[data-workspace]');
      if (button) button.textContent = manager.state.workspace ? 'Continue R workspace preparation' : 'New R workspace';
    },
  };
}
