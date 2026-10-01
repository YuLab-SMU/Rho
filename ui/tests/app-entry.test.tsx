import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const { render, workspace, view } = vi.hoisted(() => ({ render:vi.fn(), workspace:vi.fn(), view:vi.fn() }));
vi.mock('react-dom/client', () => ({ createRoot:() => ({render}) }));
vi.mock('../src/plugin-workspace-window', () => ({PluginWorkspaceWindow:workspace}));
vi.mock('../src/plugin-view-window', () => ({PluginViewWindow:view}));
vi.mock('get-nonce', () => ({setNonce:vi.fn()}));
beforeEach(() => {
  vi.resetModules();render.mockClear();
  document.head.innerHTML='<meta name="rho-csp-nonce" content="test-nonce">';
  document.body.innerHTML='<div id="root"></div>';
});
afterEach(() => { history.replaceState(null,'','/');document.body.innerHTML=''; });

it.each(['/', '/?plugin-window', '/?test-project=owned-test', '/?window=saved-window'])('opens the generic workspace for %s without a fixed scientific fallback', async address => {
  history.replaceState(null,'',address);
  const fetch=vi.spyOn(globalThis,'fetch');
  try {
    await import('../src/app');
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0][0].type).toBe(workspace);
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});

it('opens an explicitly selected contributed view', async () => {
  history.replaceState(null,'','/?plugin-view=retained-view');
  await import('../src/app');
  expect(render.mock.calls[0][0].type).toBe(view);
  expect(render.mock.calls[0][0].props).toEqual({view:'retained-view'});
});
