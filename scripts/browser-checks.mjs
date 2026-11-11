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
  // The person's workspace has no bar since 2026-11-11; the marker is in the Agent panel when that is open.
  const marker = page.locator('[data-rho-agent]').first();
  if (!await marker.count()) return { visible: false, actionable: false, text: '' };
  return { visible: await marker.isVisible(), actionable: await marker.isEnabled(), text: (await marker.innerText()).replace(/\s+/g, ' ') };
}
export async function facts(page) {
  return page.evaluate(() => {
    const elements = [...document.querySelectorAll('[data-fact]')].filter(el => el.getBoundingClientRect().height > 0);
    return { kinds: [...new Set(elements.map(el => el.dataset.fact))], agentInVerified: elements.some(el => el.dataset.fact === 'agent' && el.closest('[data-fact="verified"]')) };
  });
}
// What one page shows at its current width, read without changing it: whether it scrolls sideways,
// the elements that cross the right edge (`clippedBy` names a box that scrolls or hides what is beyond
// its own width; the ones no box keeps in are counted in `elementsPastEdgeUnclipped` and listed first),
// unnamed buttons, the visible boxes of `selector` that overlap one another (a box inside another is not
// an overlap), and how many fonts loaded.
export async function pageFindings(page, { selector = null } = {}) {
  const base = await inspectPage(page);
  const measured = await page.evaluate(selector => {
    const shown = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const describe = el => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const classes = [...el.classList].slice(0, 2).map(c => '.' + c).join('');
      return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + classes + (text ? ` "${text}"` : '');
    };
    const width = document.documentElement.clientWidth;
    const clipper = el => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (/hidden|auto|scroll|clip/.test(getComputedStyle(p).overflowX) && p.getBoundingClientRect().right <= width + 1) return p;
      }
      return null;
    };
    const past = [...document.querySelectorAll('body *')].filter(el => shown(el) && el.getBoundingClientRect().right > width + 1).map(el => ({ el, clip: clipper(el) }));
    const unclipped = past.filter(item => !item.clip).length;
    past.sort((a, b) => (a.clip ? 1 : 0) - (b.clip ? 1 : 0));
    const elementsPastEdge = past.slice(0, 50).map(({ el, clip }) => {
      const r = el.getBoundingClientRect();
      return { element: describe(el), right: Math.round(r.right), width: Math.round(r.width), clippedBy: clip ? describe(clip) : null };
    });
    let overlaps = null;
    if (selector) {
      const matched = [...document.querySelectorAll(selector)];
      const boxes = matched.filter(shown).slice(0, 400);
      const pairs = [];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          if (a.contains(b) || b.contains(a)) continue;
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          if (Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left) > 1 && Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top) > 1) pairs.push([describe(a), describe(b)]);
        }
      }
      overlaps = { selector, matched: matched.length, considered: boxes.length, total: pairs.length, pairs: pairs.slice(0, 50) };
    }
    return { scrollWidth: document.documentElement.scrollWidth, clientWidth: width, pastTotal: past.length, unclipped, elementsPastEdge, overlaps };
  }, selector);
  const fontsLoaded = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter(f => f.status === 'loaded').length; });
  return {
    width: base.width, height: base.height, horizontalOverflow: base.overflow,
    scrollWidth: measured.scrollWidth, clientWidth: measured.clientWidth,
    elementsPastEdge: measured.elementsPastEdge, elementsPastEdgeTotal: measured.pastTotal, elementsPastEdgeUnclipped: measured.unclipped,
    unnamedButtons: base.unnamed, overlaps: measured.overlaps, fontsLoaded,
  };
}
