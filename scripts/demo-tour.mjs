// One walk through the shipped PA14 project, as a visitor would take it. The same walk
// records the demo against a running service (demo-capture.mjs) and checks the replay
// (demo-check.mjs), so a screen the demo shows is a screen this walk reached.

// Settles when no request other than the event stream has been open for `quiet` ms.
export function network(page) {
  const open = new Set();
  const counted = request => { const { pathname } = new URL(request.url()); return pathname.startsWith('/api/') && pathname !== '/api/v2/events'; };
  page.on('request', r => { if (counted(r)) open.add(r); });
  page.on('requestfinished', r => open.delete(r));
  page.on('requestfailed', r => open.delete(r));
  return async function settle(quiet = 700, limit = 15000) {
    const started = Date.now();
    let idleSince = Date.now();
    while (Date.now() - started < limit) {
      if (open.size) idleSince = Date.now();
      else if (Date.now() - idleSince >= quiet) return;
      await page.waitForTimeout(100);
    }
  };
}

export async function tour(page, url, { settle, step = () => {} }) {
  const project = () => page.getByRole('navigation', { name: 'Project', exact: true }).first();
  const main = () => page.locator('main').first();
  async function go(name) {
    // A place is a tab above the work; a kind of file, the Agent's page and the rest are in the sidebar.
    await page.locator('.place-tabs, .project-nav').getByRole('button', { name, exact: true }).first().click();
    await settle(); await step(name);
  }

  await page.goto(url);
  await settle(); await step('home');
  await page.getByText('PA14 quorum sensing').first().click();
  await settle(1200); await step('overview');

  // Every answer the board can show, each opened in full, then each of its results.
  const answers = main().getByRole('combobox', { name: 'Answer to show' });
  const count = await answers.locator('option').count();
  for (let i = 0; i < count; i++) {
    await go('Overview');
    await answers.selectOption({ index: i });
    await settle();
    const whole = main().getByRole('button', { name: 'Show the whole answer' });
    while (await whole.count()) { await whole.first().click(); await settle(300); }
    await step('answer-' + i);
    const results = await main().getByRole('article').count();
    for (let r = 0; r < results; r++) {
      const result = main().getByRole('article').nth(r).getByRole('button').first();
      if (!await result.isVisible().catch(() => false)) continue;
      await result.scrollIntoViewIfNeeded().catch(() => {});
      await result.click().catch(() => {});
      await settle();
      await page.keyboard.press('Escape');
      await settle(300);
    }
  }
  await go('Overview');
  const conversation = main().getByRole('button', { name: 'Conversation', exact: true });
  if (await conversation.count()) { await conversation.click(); await settle(1000); await step('conversation'); }

  for (const name of ['Studio', 'Graph', 'Console', 'Notebook', 'Skills', 'Agent']) await go(name);
  const sessions = project().getByRole('group', { name: 'Sessions' }).getByRole('button');
  for (let i = 0; i < await sessions.count(); i++) { await sessions.nth(i).click(); await settle(1200); await step('session-' + i); }

  for (const category of ['Data', 'Code', 'Variables', 'Results & figures', 'Notes', 'Files']) {
    await go(category);
    const files = project().getByRole('list', { name: category, exact: true }).getByRole('button');
    for (let i = 0; i < await files.count(); i++) {
      await files.nth(i).scrollIntoViewIfNeeded().catch(() => {});
      await files.nth(i).click();
      await settle(); await step(category + '-' + i);
    }
  }

  await page.getByRole('button', { name: 'Project settings' }).click();
  await settle(); await step('settings');
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await settle(); await step('plugins');
  const plugins = main().getByRole('button').filter({ has: page.locator('strong') });
  const pluginCount = await plugins.count();
  for (let i = 0; i < pluginCount; i++) {
    await page.getByRole('button', { name: 'Plugins', exact: true }).click(); await settle(300);
    await plugins.nth(i).click(); await settle(); await step('plugin-' + i);
  }
  await page.getByRole('button', { name: 'All projects' }).first().click();
  await settle(); await step('home-again');
}
