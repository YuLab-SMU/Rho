import assert from 'node:assert/strict';
import path from 'node:path';

// Browser observations, with no prescribed theme, type scale, layout proportions or design board.
export const viewports = [[1440, 900], [1024, 768], [768, 1024], [390, 844]];
export async function inspectPage(page) {
  return page.evaluate(() => {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[inert]'); };
    const unnamed = [...document.querySelectorAll('button')].filter(visible).filter(el => !el.textContent.trim() && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.title).map(el => el.outerHTML.slice(0, 180));
    return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth + 1, unnamed };
  });
}
export async function inspectResponsive(page, { name, evidence, report, settle, restore = [1440, 900] }) {
  const observations = [];
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (settle) await settle(width);
    const result = await inspectPage(page);
    const failures = [...(result.overflow ? ['Page scrolls horizontally'] : []), ...result.unnamed.map(html => 'Button has no accessible name: ' + html)];
    observations.push({ name, ...result, failures });
    if (evidence) await page.screenshot({ path: path.join(evidence, `${name}-${width}.png`) });
    assert.deepEqual(failures, [], `${name} at ${width}px`);
  }
  await page.setViewportSize({ width: restore[0], height: restore[1] });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (report) (report.responsive ??= []).push(...observations);
  return observations;
}
export const firstUnit = (view, kind) => view.locator(kind === 'editor' ? '.cm-line' : '.ag-row[row-index="0"] .ag-cell').first();
export async function agentMarker(page) {
  const marker = page.locator('.shell-bar [data-rho-agent]');
  return { visible: await marker.isVisible(), actionable: await marker.isEnabled(), text: (await marker.innerText()).replace(/\s+/g, ' ') };
}
export async function facts(page) {
  return page.evaluate(() => {
    const elements = [...document.querySelectorAll('[data-fact]')].filter(el => el.getBoundingClientRect().height > 0);
    return { kinds: [...new Set(elements.map(el => el.dataset.fact))], agentInVerified: elements.some(el => el.dataset.fact === 'agent' && el.closest('[data-fact="verified"]')) };
  });
}
