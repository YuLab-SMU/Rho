import type { PluginBuildResult, PluginInspection } from '../public/plugin-protocol/index.js';
import type { Studio } from './model.js';
import { read } from './model.js';
import { buildDiagnostic } from './development.js';
const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const short = (value: string) => value.startsWith('sha256:') ? value.slice(7, 15) : value;
export function developmentPanel(studio: Studio, run: (work: () => Promise<unknown>) => void, changed: () => void, frozen: () => boolean) {
  const dev = studio.development;
  let inspection: PluginInspection | null = null;
  const fields = { 'preview-configuration': 'configuration', 'preview-view-configuration': 'viewConfiguration', 'preview-state': 'viewState', 'preview-queries': 'queries' } as const;
  async function inspect() {
    const revision = studio.document?.data.revision;
    if (!revision) throw Error('Choose a source checkpoint first.');
    if (!dev.data.pending) await dev.configure(revision);
    const captured = dev.data.inputs?.revision ?? revision;
    inspection = await read(studio.client, 'plugins.inspect', { revision: captured });
    if (inspection!.summary.revision !== captured) throw Error('Inspection returned another source revision.');
  }
  get('development').onclick = () => run(async () => { get<HTMLDialogElement>('development-dialog').showModal(); await inspect(); });
  get('close-development').onclick = () => get<HTMLDialogElement>('development-dialog').close();
  get('build-plugin').onclick = () => run(async () => {
    if (!studio.document || studio.document.dirty) throw Error('Checkpoint source edits before building.');
    const minutes = Number(dev.data.inputs?.timeoutMinutes ?? '10');
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw Error('Choose a build timeout from 1 to 60 minutes.');
    await dev.build(studio.document.data.revision, minutes * 60000);
    if (!dev.data.pending) await inspect();
  });
  const showPreview = () => { if (dev.data.preview?.view && !dev.data.pending) { get<HTMLDetailsElement>('preview-settings').open = false; get('development-dialog').scrollTop = 0; } };
  get('start-preview').onclick = () => run(async () => { await dev.startPreview(); if (!dev.data.pending) { await dev.openPreview(); showPreview(); } });
  get('open-preview').onclick = () => run(async () => { await dev.openPreview(); showPreview(); });
  get('inspect-development').onclick = () => run(async () => { await dev.recover(); if (!dev.data.pending) await inspect(); });
  get('retry-development').onclick = () => run(() => dev.dispatch());
  get('stop-build').onclick = () => run(() => dev.stopBuild());
  get<HTMLInputElement>('build-timeout').oninput = () => { if (!dev.data.inputs || frozen() || dev.data.pending) return; dev.data.inputs.timeoutMinutes = get<HTMLInputElement>('build-timeout').value; changed(); };
  get('inspect-preview').onclick = () => run(() => dev.inspectPreview());
  get('close-preview').onclick = () => run(() => dev.closePreview());
  get('retain-preview').onclick = () => run(() => dev.closePreview(true));
  get('release-preview').onclick = () => run(() => dev.releasePreview());
  for (const [id, field] of Object.entries(fields)) get<HTMLTextAreaElement>(id).addEventListener('input', () => {
    if (!dev.data.inputs || frozen() || dev.data.pending) return;
    dev.data.inputs[field] = get<HTMLTextAreaElement>(id).value; changed();
  });
  for (const [id, field] of [['preview-artifact', 'artifact'], ['preview-contribution', 'contribution']] as const) get<HTMLSelectElement>(id).onchange = () => {
    if (!dev.data.inputs || frozen() || dev.data.pending) return;
    dev.data.inputs[field] = get<HTMLSelectElement>(id).value; changed();
  };
  return () => {
    const data = dev.data, input = data.inputs, preview = data.preview, disabled = frozen() || !!data.pending;
    get<HTMLButtonElement>('development').disabled = !studio.document || frozen();
    get('development-source').textContent = input ? `${short(input.revision)} · artifact ${input.artifact ? short(input.artifact) : 'not built'}` : 'Choose a source checkpoint.';
    get('development-edits').textContent = studio.document?.dirty ? 'Checkpoint current edits before building or starting a preview.' : 'Builds use the saved source checkpoint. Current analysis keeps its own versions.';
    get<HTMLButtonElement>('build-plugin').disabled = disabled || !studio.document || studio.document.dirty || !inspection?.manifest.source.build;
    get<HTMLButtonElement>('start-preview').disabled = disabled || !!preview || !input?.artifact || !input.contribution || !!studio.document?.dirty;
    get<HTMLButtonElement>('open-preview').disabled = disabled || !preview || !!preview.view || input?.revision !== preview.instance.instance.identity.revision;
    for (const [id, field] of Object.entries(fields)) {
      const element = get<HTMLTextAreaElement>(id);
      if (element.value !== (input?.[field] ?? '') && document.activeElement !== element) element.value = input?.[field] ?? '';
      element.disabled = disabled || !input;
    }
    for (const [id, field, choices] of [
      ['preview-artifact', 'artifact', inspection?.artifacts.map(a => [a.id, `${short(a.id)} · ${a.target}`]) ?? []],
      ['preview-contribution', 'contribution', inspection?.manifest.views.map(v => [v.id, v.title]) ?? []],
    ] as const) {
      const select = get<HTMLSelectElement>(id), key = JSON.stringify(choices);
      if (select.dataset.key !== key) { select.dataset.key = key; select.replaceChildren(); for (const [value, label] of choices) { const option = document.createElement('option'); option.value = value!; option.textContent = label!; select.append(option); } }
      select.value = input?.[field] ?? ''; select.disabled = disabled || !input;
    }
    get('development-summary').hidden = !data.pending;
    get('development-summary').textContent = data.pending ? 'Build or preview request awaiting confirmation. Open Build & preview to inspect the original result.' : '';
    const timeout = get<HTMLInputElement>('build-timeout');
    if (document.activeElement !== timeout) timeout.value = input?.timeoutMinutes ?? '10'; timeout.disabled = disabled || !input;
    get<HTMLButtonElement>('stop-build').disabled = frozen() || data.pending?.capability.id !== 'plugins.build' || !data.pending.operation || data.pending.view !== studio.client.view.view;
    get('stop-status').textContent = data.pending?.operation && data.stopRequested === data.pending.operation ? 'Stop requested · not confirmed. Inspect the original result.' : '';
    get('development-pending').hidden = !data.pending;
    get('development-request').textContent = data.pending ? `${data.pending.capability.id} · ${data.pending.operation ?? data.pending.request}` : '';
    get<HTMLButtonElement>('inspect-development').disabled = frozen() || !data.pending;
    get<HTMLButtonElement>('retry-development').disabled = frozen() || !data.pending || data.pending.view !== studio.client.view.view;
    get('preview-lifecycle').hidden = !preview;
    get('preview-instance').textContent = preview ? `${short(preview.instance.instance.identity.revision)} · artifact ${short(preview.instance.instance.identity.artifact)} · ${preview.instance.instance.alias} · ${preview.instance.observed_in_this_host ? preview.instance.instance.state : 'recorded, unavailable in this Host'}${preview.view ? ` · view ${preview.view.closed ? 'closed' : 'open'}` : ' · view not opened'}` : '';
    for (const id of ['inspect-preview', 'release-preview']) get<HTMLButtonElement>(id).disabled = disabled || !preview;
    for (const id of ['close-preview', 'retain-preview']) get<HTMLButtonElement>(id).disabled = disabled || !preview?.view || preview.view.closed;
    get<HTMLButtonElement>('release-preview').disabled ||= !!preview?.view && !preview.view.closed;
    const build = data.build, report = build?.output as PluginBuildResult | null;
    get('build-status').textContent = build ? `Build ${build.status} · ${short((build.operation.normalized_arguments as any).revision)}` : inspection && !inspection.manifest.source.build ? 'This source revision has no build recipe.' : 'No build observed in this draft.';
    get('build-diagnostic').textContent = build ? buildDiagnostic(build) : '';
    get('build-log').textContent = report ? ['stdout', 'stderr'].map(stream => {
      const output = report.process[stream as 'stdout' | 'stderr'];
      return `${stream} · ${output.total_bytes} bytes${output.truncated ? ' · truncated' : ''}${output.eof ? '' : ' · incomplete'}\n${new TextDecoder().decode(Uint8Array.from(output.bytes))}`;
    }).concat(report.diagnostic ? [`Native diagnostic\n${report.diagnostic}`] : []).join('\n\n') : '';
  };
}
