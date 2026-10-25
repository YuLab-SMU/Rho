// Structural rulers M1–M10 and behaviour-contract probes E1/E4 (docs/WORKSPACE-PLAN.md §2),
// and the hi-fi rulers R3–R7 (docs/HIFI-PLAN.md).
// They read the real page only; nothing here imports expression.ts, so an implementation
// cannot generate its own expected answer. A profile maps the plan's terms onto a shell's DOM.
import assert from 'node:assert/strict';
import path from 'node:path';
import { protocol } from '../dist/protocol.js';

export const viewports = [[1440, 900], [1024, 768], [768, 1024], [390, 844]];
const methods = Object.keys(protocol.operations);
// Person and scientific content: data cells, column names, editor text and the person's own words.
const content = '.ag-cell, .ag-header-cell, .cm-content, [data-user-text]';
export const profiles = {
  shell: {
    persistent: '[data-rho-layer="persistent"]', transient: '[data-rho-layer="transient"]', interruption: '[data-rho-interruption]',
    digestItem: '[data-rho-digest] li', evidence: '[data-rho-evidence]', ownerBody: '[data-owner-body]', agent: '[data-rho-agent]', content,
  },
};
// The first content unit of an owner view, by the kind of work it holds.
export function firstUnit(view, kind) {
  return kind === 'table' ? view.locator('.ag-row[row-index="0"] .ag-cell[col-id]:not([col-id^="ag-Grid"])').first()
    : kind === 'editor' ? view.locator('.cm-line').first() : kind === 'image' ? view.locator('img').first() : view.locator('h2').first();
}

// One viewport, everything measurable without input. Runs in the page.
function inPage([{ p, methods, transientAllowed }, unit]) {
  const visible = e => e.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? !!e.getClientRects().length;
  const all = sel => [...document.querySelectorAll(sel)].filter(visible);
  const label = e => (e.getAttribute('aria-label') || e.className?.toString() || e.tagName.toLowerCase() + ' in ' + (e.parentElement?.getAttribute('aria-label') || e.parentElement?.className || e.parentElement?.tagName)).slice(0, 60);
  // The visually-hidden pattern (live regions, skip-link text) clips by design.
  const hidden = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width <= 1 || r.height <= 1 || s.clip !== 'auto' && s.position === 'absolute' || s.clipPath !== 'none'; };
  const inViewport = r => Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
  const out = { width: innerWidth, height: innerHeight };
  // M1: the unit is in the viewport, nothing covers its corners or centre, and it is legible.
  if (unit?.isConnected) {
    const r = unit.getBoundingClientRect(), i = 2;
    const points = [[r.left + i, r.top + i], [r.right - i, r.top + i], [r.left + i, r.bottom - i], [r.right - i, r.bottom - i], [r.left + r.width / 2, r.top + r.height / 2]];
    const covered = points.filter(([x, y]) => { const hit = document.elementFromPoint(x, y); return !hit || !(hit === unit || unit.contains(hit)); });
    const textual = unit.tagName === 'IMG' ? null : [unit, ...unit.querySelectorAll('*')].find(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) ?? unit;
    out.m1 = { inside: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth, covered: covered.length, fontSize: textual ? parseFloat(getComputedStyle(textual).fontSize) : null, imageScale: unit.tagName === 'IMG' && unit.naturalWidth ? r.width / unit.naturalWidth : null, actualSize: !!all('button').find(b => /actual size|100%/i.test(b.getAttribute('aria-label') ?? b.textContent)) };
  } else out.m1 = null;
  // M2: persistent and transient additions as a share of the viewport height.
  const top = sel => all(sel).filter(e => !all(sel).some(o => o !== e && o.contains(e)));
  const persistent = top(p.persistent), transient = top(p.transient).filter(e => !persistent.some(o => o.contains(e)));
  out.m2 = {
    persistent: persistent.reduce((s, e) => s + inViewport(e.getBoundingClientRect()), 0) / innerHeight,
    total: [...persistent, ...transient].reduce((s, e) => s + inViewport(e.getBoundingClientRect()), 0) / innerHeight,
    transient: transient.map(label), transientAllowed,
    // A disclosure may sit outside what it opens; it then names it with aria-controls.
    uncollapsible: transient.filter(e => ![...e.querySelectorAll('button')].some(b => b.hasAttribute('aria-expanded') || /dismiss|hide|collapse|close|less/i.test(b.getAttribute('aria-label') ?? b.textContent))
      && !all('[aria-expanded="true"][aria-controls]').some(b => b.getAttribute('aria-controls').split(/\s+/).some(id => e.id === id || e.querySelector('#' + CSS.escape(id))))).map(label),
    interruptions: all(p.interruption).length,
  };
  // M4/M5: visible words outside the person's content; M5 also outside the evidence panel.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let quiet = '', loud = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const e = n.parentElement; if (!e || !visible(e) || e.closest(p.content) || e.closest('script,style')) continue;
    loud += ' ' + n.textContent; if (!e.closest(p.evidence)) quiet += ' ' + n.textContent;
  }
  out.m4 = loud.match(/(^|\s)\?(?=\s|$)|\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]/g)?.map(s => s.trim()) ?? [];
  out.m5 = [...(quiet.match(/\b(agent|browser|operator):[0-9a-f]{8,}\b|\b[0-9a-f]{16,}\b/g) ?? []), ...methods.filter(m => new RegExp('(^|[^\\w.])' + m.replace(/\./g, '\\.') + '($|[^\\w.])').test(quiet))];
  // M6: clipping is allowed only in a declared, named, focusable scroll region or an owner body.
  out.m6 = { clipped: [...document.body.querySelectorAll('*')].filter(e => {
    if (!visible(e) || e.closest(p.ownerBody) || hidden(e)) return false;
    const s = getComputedStyle(e), y = s.overflowY !== 'visible' && e.scrollHeight > e.clientHeight + 1, x = s.overflowX !== 'visible' && e.scrollWidth > e.clientWidth + 1;
    if (!x && !y) return false;
    const named = e.getAttribute('aria-label') || e.getAttribute('aria-labelledby');
    if (e.matches('[data-scroll-region]') && named && e.tabIndex >= 0) return false;
    // A tab list's own keys reach every tab; it still has to show which side has more.
    if (e.matches('[role=tablist]') && named && x && !y && e.dataset.overflow) return false;
    if (x && !y && s.textOverflow === 'ellipsis' && e.closest('[title],[aria-label]')) return false;
    return true;
  }).map(label), digest: all(p.digestItem).length };
  // M7: text contrast, computed through a canvas so any colour syntax resolves to sRGB.
  const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  const rgba = c => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data; return [r, g, b, a / 255]; };
  const over = (f, b) => [0, 1, 2].map(i => f[i] * f[3] + b[i] * (1 - f[3]));
  const background = e => { const stack = []; for (let x = e; x; x = x.parentElement) { const s = getComputedStyle(x); if (s.backgroundImage !== 'none') return null; const c = rgba(s.backgroundColor); if (c[3] > 0) { stack.push(c); if (c[3] >= 1) break; } } return stack.reverse().reduce((b, c) => over(c, b), [255, 255, 255]); };
  const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const low = [];
  for (const e of document.body.querySelectorAll('*')) {
    // Disabled controls and decoration hidden from assistive technology are exempt (WCAG 1.4.3).
    if (!visible(e) || hidden(e) || ![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) || e.closest(':disabled,[aria-disabled="true"],[aria-hidden="true"]')) continue;
    const s = getComputedStyle(e), bg = background(e); if (!bg) continue;
    const fg = over(rgba(s.color), bg), ratio = (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);
    const size = parseFloat(s.fontSize), large = size >= 24 || size >= 18.66 && Number(s.fontWeight) >= 700;
    if (ratio < (large ? 3 : 4.5)) low.push({ text: e.textContent.trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100, owner: !!e.closest(p.ownerBody) });
  }
  // M7 scale: shell text uses one of the five type sizes (owner views keep their own).
  const scale = new Set([12, 13, 15, 20, 28]);
  const offScale = [...document.body.querySelectorAll('*')].filter(e => visible(e) && !hidden(e) && !e.closest(p.ownerBody) && !e.closest(p.content) && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && !scale.has(parseFloat(getComputedStyle(e).fontSize)));
  out.m7 = { lowContrast: low, offScale: [...new Set(offScale.map(e => `${parseFloat(getComputedStyle(e).fontSize)}px ${label(e)}`))] };
  // M7 selection: a selected, current or pressed control stands off what it sits on by its
  // fill (1.15:1, the panel's own step off the canvas) or by a 3:1 border (WCAG 1.4.11).
  const ratioOf = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  out.m7.faintSelected = all('[aria-selected="true"], [aria-current="page"], [aria-current="true"], [aria-pressed="true"]').filter(e => !hidden(e) && !e.closest(p.ownerBody) && !e.closest('.ag-root-wrapper, .cm-editor')).flatMap(e => {
    const fill = background(e), under = e.parentElement && background(e.parentElement); if (!fill || !under) return [];
    const s = getComputedStyle(e), edge = ['Top', 'Right', 'Bottom', 'Left'].some(k => parseFloat(s['border' + k + 'Width']) >= 1 && s['border' + k + 'Style'] !== 'none' && ratioOf(over(rgba(s['border' + k + 'Color']), under), under) >= 3);
    const r = ratioOf(fill, under);
    return r >= 1.15 || edge ? [] : [`${label(e)} ${Math.round(r * 100) / 100}`];
  });
  out.m9 = { scrollWidth: document.documentElement.scrollWidth, innerWidth };
  // R3: a run's id is said once per view, and once in the activity bar.
  const runIds = new Set([...document.querySelectorAll('.shell-run-id, .shell-run h2'), ...document.querySelectorAll('.shell-mark[aria-label]')].map(e => (e.getAttribute('aria-label') ?? e.textContent).trim().split(/\s+/)[0]).filter(Boolean));
  const said = root => {
    const counts = {}, walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const e = n.parentElement; if (!e || !visible(e) || hidden(e) || e.closest(p.content) || e.closest('[aria-hidden="true"]')) continue;
      for (const t of n.textContent.match(/(?<![\w.-])[A-Za-z][\w.-]*-\d+(?![\w.-])/g) ?? []) if (runIds.has(t)) counts[t] = (counts[t] ?? 0) + 1;
    }
    return counts;
  };
  out.r3 = [...all('[data-owner-view]'), ...all('.shell-bar')].flatMap(root => Object.entries(said(root)).filter(([, n]) => n > 1).map(([id, n]) => `${id} ×${n} in ${root.dataset.ownerView ? 'view ' + root.dataset.ownerView : 'the bar'}`));
  // R4: text set in the monospace token draws the platform's monospace, not Courier's glyphs.
  const mono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
  const families = new Set(all('*').filter(e => !hidden(e) && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && /mono|menlo|consolas|courier/i.test(getComputedStyle(e).fontFamily)).map(e => getComputedStyle(e).fontFamily));
  const glyphs = family => { const c = Object.assign(document.createElement('canvas'), { width: 240, height: 48 }).getContext('2d', { willReadFrequently: true }); c.font = `32px ${family}`; c.fillText('a0Mi{}-5', 4, 36); return c.getImageData(0, 0, 240, 48).data.join(''); };
  const courier = [glyphs('Courier'), glyphs('"Courier New"')];
  out.r4 = { token: mono, courier: [...families].filter(f => courier.includes(glyphs(f))) };
  // R5: a number cell shows its source value to within 0.5%, exponent included.
  const parse = text => {
    const t = text.replace(/[\u2212\u2012\u2013]/g, '-').replace(/,/g, '').trim(), sup = { '\u2070': 0, '\u00b9': 1, '\u00b2': 2, '\u00b3': 3, '\u2074': 4, '\u2075': 5, '\u2076': 6, '\u2077': 7, '\u2078': 8, '\u2079': 9 };
    const m = t.match(/^(-?[\d.]+)\s*[\u00d7x]\s*10([\u207b-]?)([\u2070\u00b9\u00b2\u00b3\u2074-\u2079]+|\d+)$/);
    if (m) { const exp = Number([...m[3]].map(d => sup[d] ?? d).join('')); return Number(m[1]) * 10 ** (m[2] ? -exp : exp); }
    return /^-?[\d.]+(e-?\d+)?%?$/i.test(t) ? Number(t.replace('%', '')) : NaN;
  };
  out.r5 = all('.ag-cell span[title]').flatMap(e => {
    const source = Number(e.getAttribute('title')), shown = parse(e.textContent);
    if (!Number.isFinite(source) || e.getAttribute('title').trim() === '') return [];
    const error = source === 0 ? Math.abs(shown) : Math.abs(shown - source) / Math.abs(source);
    return Number.isFinite(shown) && error <= 0.005 + 1e-12 ? [] : [`"${e.textContent.trim()}" for ${source}`];
  });
  // R6: a fitted figure fills its room to 95% on one axis, unless it reached the 2x cap.
  out.r6 = all('figure[data-fit="fit"]').flatMap(f => {
    const img = f.querySelector('img'); if (!img?.naturalWidth || !visible(img)) return [];
    const s = getComputedStyle(f), w = f.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight), h = f.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom), r = img.getBoundingClientRect();
    const fill = Math.max(r.width / w, r.height / h);
    return fill >= 0.95 || r.width >= 2 * img.naturalWidth - 1 ? [] : [`${img.alt || 'figure'} ${Math.round(fill * 100)}%`];
  });
  // R7: a failure that a later run replaced never wears the failed colour.
  const failed = rgba(getComputedStyle(document.documentElement).getPropertyValue('--color-failed').trim()).slice(0, 3).join();
  const paints = (e, pseudo) => { const s = getComputedStyle(e, pseudo); return [s.color, s.backgroundColor, s.borderTopColor, s.borderLeftColor].some(c => { const v = rgba(c); return v[3] > 0 && v.slice(0, 3).join() === failed; }); };
  out.r7 = all('.superseded, [data-rho-superseded]').filter(e => paints(e) || paints(e, '::before')).map(label);
  return out;
}

// M8 from the browser's accessibility tree, which is what assistive technology reads.
async function unnamed(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const roles = new Set(['button', 'textbox', 'combobox', 'checkbox', 'radio', 'tab', 'menuitem', 'link', 'switch', 'slider', 'searchbox', 'spinbutton', 'listbox']);
    const missing = nodes.filter(n => !n.ignored && roles.has(n.role?.value) && !String(n.name?.value ?? '').trim());
    return Promise.all(missing.map(async n => {
      try { const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: n.backendDOMNodeId }); const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(){return this.outerHTML.slice(0,100)}', returnByValue: true }); return n.role.value + ' ' + result.value; }
      catch { return n.role.value; }
    }));
  } finally { await cdp.detach().catch(() => {}); }
}

// M7 states: each control's look at rest, hovered and pressed, through the browser's forced
// pseudo-classes, so no pointer moves and nothing is clicked. Pressed must differ from hovered;
// a hover that changes the fill changes it by at least 1.08:1.
async function states(page, profile) {
  const count = await page.evaluate(p => {
    const visible = e => e.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? !!e.getClientRects().length;
    const modal = document.querySelector('dialog:modal');
    const still = Object.assign(document.createElement('style'), { textContent: '*, *::before, *::after { transition: none !important; }' });
    still.dataset.rulerStill = ''; document.head.append(still);
    const list = [...document.querySelectorAll('button, summary, a[href], [role=button], [role=tab]')].filter(e => visible(e) && e.getBoundingClientRect().width > 1 && !e.closest(p.ownerBody) && !e.closest(':disabled,[aria-disabled="true"]') && !e.closest('.ag-root-wrapper, .cm-editor') && (!modal || modal.contains(e)));
    list.forEach((e, i) => { e.dataset.rulerState = String(i); });
    return list.length;
  }, profile);
  const read = () => page.evaluate(() => {
    const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
    const rgba = c => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data; return [r, g, b, a / 255]; };
    const over = (f, b) => [0, 1, 2].map(i => f[i] * f[3] + b[i] * (1 - f[3]));
    const background = e => { const stack = []; for (let x = e; x; x = x.parentElement) { const s = getComputedStyle(x); if (s.backgroundImage !== 'none') return null; const c = rgba(s.backgroundColor); if (c[3] > 0) { stack.push(c); if (c[3] >= 1) break; } } return stack.reverse().reduce((b, c) => over(c, b), [255, 255, 255]); };
    return [...document.querySelectorAll('[data-ruler-state]')].map(e => { const s = getComputedStyle(e); return { key: e.dataset.rulerState, label: (e.getAttribute('aria-label') || e.textContent || e.className || e.tagName).trim().slice(0, 40), fill: background(e), look: [s.backgroundColor, s.color, s.opacity, s.boxShadow, s.borderColor, s.textDecorationLine, s.outlineStyle].join('|') }; });
  });
  const cdp = await page.context().newCDPSession(page);
  try {
    if (!count) return { samePressed: [], faintHover: [] };
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-ruler-state]' });
    const force = async forcedPseudoClasses => { for (const nodeId of nodeIds) await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses }); };
    const rest = await read();
    await force(['hover']); const hover = await read();
    await force(['hover', 'active']); const pressed = await read();
    await force([]);
    const lum = c => c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const samePressed = [], faintHover = [];
    rest.forEach((r, i) => {
      const h = hover[i], d = pressed[i];
      if (d.look === h.look) samePressed.push(r.label);
      if (r.fill && h.fill && r.fill.some((v, k) => Math.abs(v - h.fill[k]) > 0.5) && ratio(r.fill, h.fill) < 1.08) faintHover.push(`${r.label} ${Math.round(ratio(r.fill, h.fill) * 100) / 100}`);
    });
    return { samePressed: [...new Set(samePressed)], faintHover: [...new Set(faintHover)] };
  } finally {
    await cdp.detach().catch(() => {});
    await page.evaluate(() => { document.querySelector('[data-ruler-still]')?.remove(); document.querySelectorAll('[data-ruler-state]').forEach(e => { delete e.dataset.rulerState; }); });
  }
}

// M7 focus states and M10 reach: Tab through the page as a keyboard user would.
// Leaves an editor with Escape first so Tab never inserts into the person's buffer; a data
// grid is left at its next tabbable element (its own Tab walks every cell, then exits).
export async function keyboard(page, profile) {
  const candidates = await page.evaluate(p => {
    const visible = e => e.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? !!e.getClientRects().length;
    document.activeElement?.blur?.();
    const sel = 'button, a[href], input:not([type=hidden]), select, textarea, [tabindex], [role=tab], [role=button]';
    // While a modal dialog is open everything outside it is inert, so reach is measured inside it.
    const modal = document.querySelector('dialog:modal');
    return [...document.querySelectorAll(sel)].filter(e => visible(e) && !e.closest(':disabled') && e.tabIndex >= 0 && !e.closest('.ag-root-wrapper, .cm-editor') && (!modal || modal.contains(e))).map((e, i) => {
      e.dataset.rulerKey = String(i); const s = getComputedStyle(e);
      e.dataset.rulerRest = [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor].join('|');
      return { key: String(i), label: (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 50), owner: !!e.closest(p.ownerBody) };
    });
  }, profile);
  // Start from the top of the document, not wherever focus last was.
  await page.evaluate(() => { const start = Object.assign(document.createElement('span'), { tabIndex: 0 }); start.dataset.rulerStart = ''; (document.querySelector('dialog:modal') ?? document.body).prepend(start); start.focus(); });
  const reached = new Set(), noFocusStyle = [];
  let last = null, same = 0;
  for (let step = 0; step < candidates.length + 60 && step < 400; step++) {
    const where = await page.evaluate(() => { const a = document.activeElement; return a?.closest('.cm-editor') ? 'editor' : a?.closest('.ag-root-wrapper') ? 'grid' : 'page'; });
    if (where === 'editor') await page.keyboard.press('Escape');
    if (where === 'grid') await page.evaluate(() => { const grid = document.activeElement.closest('.ag-root-wrapper'), all = [...document.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')].filter(e => e.tabIndex >= 0 && !grid.contains(e) && grid.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING); all[0]?.focus(); });
    else await page.keyboard.press('Tab');
    const now = await page.evaluate(() => { const a = document.activeElement; if (a?.dataset.rulerStart !== undefined) return 'start'; if (!a?.dataset.rulerKey) return a?.closest('.cm-editor, .ag-root-wrapper') ? 'owner-content' : null; const s = getComputedStyle(a); return { key: a.dataset.rulerKey, styled: [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor].join('|') !== a.dataset.rulerRest }; });
    if (now === 'start' && step > 0) break;
    if (now?.key) { reached.add(now.key); if (!now.styled) noFocusStyle.push(now.key); }
    const id = now?.key ?? now; same = id === last ? same + 1 : 0; last = id; if (same > 3) break;
  }
  await page.evaluate(() => { document.querySelector('[data-ruler-start]')?.remove(); document.querySelectorAll('[data-ruler-key]').forEach(e => { delete e.dataset.rulerKey; delete e.dataset.rulerRest; }); });
  const name = key => candidates.find(c => c.key === key)?.label;
  return { candidates: candidates.length, unreached: candidates.filter(c => !reached.has(c.key)).map(c => c.label), noFocusStyle: [...new Set(noFocusStyle)].map(name) };
}

export async function measure(page, profile, { first = null, transientAllowed = false, keys = true } = {}) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // Owner DOM (an editor's lines) can be replaced at any frame, so the unit is resolved in the same evaluation.
  const unit = first ? await first.elementHandle({ timeout: 10000 }).catch(() => null) : null;
  const m = await page.evaluate(inPage, [{ p: profile, methods, transientAllowed }, unit]);
  await unit?.dispose();
  m.m8 = await unnamed(page);
  m.states = await states(page, profile);
  if (keys) m.keys = await keyboard(page, profile);
  return m;
}

// The thresholds of §2.2, as named failures. `owner` contrast is reported apart: it belongs
// to the plugin that renders it, and is listed rather than silently passed.
export function failures(m, { digest = false } = {}) {
  const f = [], wide = m.width >= 768;
  if (m.m1) {
    if (!m.m1.inside || m.m1.covered) f.push(`M1 first unit ${m.m1.inside ? '' : 'outside the viewport '}${m.m1.covered ? m.m1.covered + '/5 points covered' : ''}`.trim());
    if (m.m1.fontSize !== null && m.m1.fontSize < 12) f.push(`M1 first unit text ${m.m1.fontSize}px`);
    if (m.m1.imageScale !== null && (wide ? m.m1.imageScale < 0.5 : m.m1.imageScale < 0.5 && !m.m1.actualSize)) f.push(`M1 image scale ${m.m1.imageScale.toFixed(2)}`);
  } else f.push('M1 no first unit');
  const persistentBudget = wide ? 0.10 : 0.15;
  if (m.m2.persistent > persistentBudget) f.push(`M2 persistent ${(m.m2.persistent * 100).toFixed(1)}% > ${persistentBudget * 100}%`);
  if (m.m2.transient.length && !m.m2.transientAllowed && !digest) f.push(`M2 transient without a fact awaiting the person: ${m.m2.transient.join(', ')}`);
  if (m.m2.total > 0.40) f.push(`M2 total ${(m.m2.total * 100).toFixed(1)}% > 40%`);
  if (m.m2.uncollapsible.length) f.push(`M2 transient not collapsible: ${m.m2.uncollapsible.join(', ')}`);
  if (m.m2.interruptions > 1) f.push(`M2 ${m.m2.interruptions} interruptions`);
  if (m.m4.length) f.push(`M4 placeholders: ${[...new Set(m.m4)].join(' ')}`);
  if (m.m5.length) f.push(`M5 identifiers: ${[...new Set(m.m5)].slice(0, 6).join(' ')}`);
  if (m.m6.clipped.length) f.push(`M6 undeclared clipping: ${[...new Set(m.m6.clipped)].slice(0, 6).join(', ')}`);
  if (m.m6.digest > 6) f.push(`M6 digest ${m.m6.digest} lines`);
  const shellLow = m.m7.lowContrast.filter(x => !x.owner);
  if (shellLow.length) f.push(`M7 contrast: ${shellLow.slice(0, 4).map(x => `"${x.text}" ${x.ratio}`).join(', ')}${shellLow.length > 4 ? ` +${shellLow.length - 4}` : ''}`);
  if (m.keys?.noFocusStyle.length) f.push(`M7 no focus style: ${m.keys.noFocusStyle.slice(0, 6).join(', ')}`);
  if (m.m7.offScale?.length) f.push(`M7 type off the scale: ${m.m7.offScale.slice(0, 6).join(', ')}${m.m7.offScale.length > 6 ? ` +${m.m7.offScale.length - 6}` : ''}`);
  if (m.m7.faintSelected?.length) f.push(`M7 faint selection: ${m.m7.faintSelected.slice(0, 6).join(', ')}`);
  if (m.states?.samePressed.length) f.push(`M7 no pressed state: ${m.states.samePressed.slice(0, 6).join(', ')}${m.states.samePressed.length > 6 ? ` +${m.states.samePressed.length - 6}` : ''}`);
  if (m.states?.faintHover.length) f.push(`M7 faint hover: ${m.states.faintHover.slice(0, 6).join(', ')}`);
  if (m.m8.length) f.push(`M8 unnamed: ${m.m8.slice(0, 4).join(' | ')}${m.m8.length > 4 ? ` +${m.m8.length - 4}` : ''}`);
  if (m.m9.scrollWidth > m.m9.innerWidth) f.push(`M9 page ${m.m9.scrollWidth}px wide in ${m.m9.innerWidth}px`);
  if (m.keys?.unreached.length) f.push(`M10 not reachable by Tab: ${m.keys.unreached.slice(0, 6).join(', ')}${m.keys.unreached.length > 6 ? ` +${m.keys.unreached.length - 6}` : ''}`);
  if (m.r3.length) f.push(`R3 run id repeated: ${m.r3.slice(0, 4).join(', ')}`);
  if (m.r4.courier.length) f.push(`R4 monospace draws Courier: ${m.r4.courier.join(' | ')}`);
  if (m.r5.length) f.push(`R5 number cells: ${m.r5.slice(0, 4).join(', ')}${m.r5.length > 4 ? ` +${m.r5.length - 4}` : ''}`);
  if (m.r6.length) f.push(`R6 figure under 95%: ${m.r6.join(', ')}`);
  if (m.r7.length) f.push(`R7 replaced failure in the failed colour: ${m.r7.slice(0, 4).join(', ')}`);
  return f;
}

// Every viewport for one state. `first(width)` returns that width's first-unit locator.
// Tab counts as the person working, so a scenario measures keys only where that cannot
// change what follows.
// With `enforce` the first failure throws; without it the numbers are only recorded.
export async function rulers(page, { name, profile, first, transientAllowed = false, digest = false, keys = true, enforce = false, evidence, report, settle, restore = [1440, 956] }) {
  const results = [];
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    if (settle) await settle(width);
    const m = await measure(page, profile, { first: first ? first(width) : null, transientAllowed, keys });
    const failed = failures(m, { digest });
    results.push({ name, width, height, failures: failed, persistent: round(m.m2.persistent), total: round(m.m2.total), lowContrastInOwners: m.m7.lowContrast.filter(x => x.owner).length });
    if (evidence) await page.screenshot({ path: path.join(evidence, `${name}-${width}.png`) });
    if (enforce) assert.deepEqual(failed, [], `${name} ${width}x${height}`);
  }
  await page.setViewportSize({ width: restore[0], height: restore[1] });
  report?.rulers?.push(...results);
  return results;
}
const round = x => Math.round(x * 1000) / 1000;

// E1: the Agent's current object, by name and state, one action from the default screen.
export async function agentMarker(page, profile) {
  const marker = page.locator(profile.agent).first();
  if (!await marker.isVisible().catch(() => false)) return { visible: false };
  return { visible: true, text: (await marker.innerText()).replace(/\s+/g, ' ').trim(), actionable: await marker.evaluate(e => !!e.closest('button, a[href], [role=button]')) };
}
// E4: the three kinds of statement live in separate elements; the Agent's words never wear
// the colour reserved for owner-verified facts.
export async function facts(page) {
  return page.evaluate(() => {
    const kinds = {}; for (const e of document.querySelectorAll('[data-fact]')) if (e.checkVisibility?.() ?? true) (kinds[e.dataset.fact] ??= []).push(getComputedStyle(e).color);
    const probe = document.createElement('span'); probe.style.color = 'var(--color-verified)'; document.body.append(probe); const verified = getComputedStyle(probe).color; probe.remove();
    return { kinds: Object.keys(kinds), agentInVerified: (kinds.agent ?? []).some(c => c === verified) };
  });
}
