import { useContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FlowPane, FormSwitch, ObjectView, PlotsPane, ServersPane, SessionPane, SessionsPane, VariablesPane, kernelEntries, type Linked, type NotebookForm } from '@rho-workspace/plugin-kernel/ui';
import type { UiContribution, UiViewProps } from '../../src/ui-contract.js';
import { WorkspaceViewsContext } from '../shell/workspace-views.js';

// The live sessions' views, from the Kernel plugin, on a page of views: the page hands each the
// way to open a value, a server's file or the Notebook's line as its own views, and in a
// conversation's Studio the share of the sessions that conversation shows.
const props = { type: 'object', properties: { title: { type: 'string' } } };
const contribution = (component: keyof typeof kernelEntries, View: UiContribution['View'], propsSchema: Record<string, unknown> = props): UiContribution =>
  ({ ...kernelEntries[component], entryVersion: '0.1-draft', packageVersion: '0.5.10', propsSchema, commands: [], View });

// The Notebook's form is the person's choice, saved with the page; this tab shows it at once.
function Notebook({ viewId, view, client, snapshot, headerTarget, shell }: UiViewProps) {
  const page = useContext(WorkspaceViewsContext);
  const saved: NotebookForm = view.props.form === 'console' ? 'console' : 'notebook';
  const [form, setForm] = useState<NotebookForm>(saved);
  useEffect(() => setForm(saved), [saved]);
  const choose = (next: NotebookForm) => { setForm(next); page?.setProps?.(viewId, { form: next }); };
  // On the person's own page the Notebook leaves plots and the sessions to their views.
  const linked: Linked | undefined = page?.showPlot && page.showSessions ? { plot: page.showPlot, sessions: page.showSessions } : undefined;
  // The session the next cell runs in is said once, in the view's own bar beside the form.
  const toolbar = headerTarget && linked ? (controls: ReactNode) => createPortal(controls, headerTarget, 'kernel-' + viewId) : undefined;
  return <>
    {headerTarget && createPortal(<FormSwitch form={form} onForm={choose} />, headerTarget, 'form-' + viewId)}
    <SessionPane client={client} snapshot={snapshot} form={form} shell={shell} scope={page?.scope} toolbar={toolbar}
      notebook={typeof view.props.notebook === 'string' && view.props.notebook ? view.props.notebook : undefined} notebooks={page?.notebookNames}
      beside={{ variables: !!page?.has('rho.variables'), plots: !!page?.has('rho.plots') }} linked={linked}
      prepared={!page || page.notebookTarget == null || page.notebookTarget === viewId ? page?.prepared : null} onTaken={page?.taken} onConversation={page?.openConversation} onObject={page?.openValue} />
  </>;
}
function Variables({ client, snapshot }: UiViewProps) {
  const page = useContext(WorkspaceViewsContext);
  return <VariablesPane client={client} snapshot={snapshot} notebooks={page?.notebookNames} onObject={page?.openValue} onCell={page?.showCell && ((cellId, notebook) => page.showCell!(cellId, notebook ?? null))} onSessions={page?.showSessions} />;
}
function Plots({ client, snapshot, shell }: UiViewProps) {
  const page = useContext(WorkspaceViewsContext);
  return <PlotsPane client={client} snapshot={snapshot} shell={shell} notebooks={page?.notebookNames} onCell={page?.showCell && ((cellId, notebook) => page.showCell!(cellId, notebook ?? null))} />;
}
function Sessions({ client, snapshot }: UiViewProps) {
  const page = useContext(WorkspaceViewsContext);
  return <SessionsPane client={client} snapshot={snapshot} notebooks={page?.notebookNames} onCell={page?.showCell && ((cellId, notebook) => page.showCell!(cellId, notebook ?? null))} />;
}
function Flow({ client, snapshot, shell }: UiViewProps) {
  const page = useContext(WorkspaceViewsContext);
  return <FlowPane client={client} snapshot={snapshot} shell={shell} notebooks={page?.notebookNames} onObject={page?.openValue} onPath={shell?.openPath} onRemote={page?.openRemote} />;
}
const Servers = ({ client, snapshot, shell }: UiViewProps) => <ServersPane client={client} snapshot={snapshot} shell={shell} onPath={shell?.openPath} />;
// One value of a live session; what reaches into it waits in the Notebook's line.
function Value({ view, client, snapshot }: UiViewProps) {
  const page = useContext(WorkspaceViewsContext);
  const language = view.props.language === 'python' ? 'python' : 'r', name = String(view.props.name ?? view.props.title ?? '');
  const notebook = typeof view.props.notebook === 'string' && view.props.notebook ? view.props.notebook : undefined;
  return <ObjectView client={client} snapshot={snapshot} language={language} name={name} notebook={notebook} onUse={expression => page?.toNotebook?.(language, expression, name)} />;
}

export const notebook = contribution('rho.notebook', Notebook, { type: 'object', properties: { title: { type: 'string' }, form: { enum: ['notebook', 'console'] }, notebook: { type: 'string' } } });
export const sessions = contribution('rho.sessions', Sessions);
export const variables = contribution('rho.variables', Variables);
export const plots = contribution('rho.plots', Plots);
export const flow = contribution('rho.flow', Flow);
export const servers = contribution('rho.servers', Servers);
export const object = contribution('rho.object', Value, { type: 'object', properties: { title: { type: 'string' }, language: { enum: ['r', 'python'] }, name: { type: 'string', minLength: 1 }, notebook: { type: 'string' } } });
