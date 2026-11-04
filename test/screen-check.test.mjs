import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { pageFindings } from '../scripts/browser-checks.mjs';

// The findings are read from real pages in a real browser. The command tests run it as a user would,
// and they need a browser; without one they are skipped, and the skip says so.
const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/screen-check.mjs', import.meta.url));

const fixtures = {
  'wide.html': '<div class="wide" style="width:600px;height:20px;background:#ccc">wide</div><button style="width:40px;height:40px"></button>',
  'overlap.html': '<div class="node" style="position:absolute;left:10px;top:10px;width:100px;height:50px">a</div>'
    + '<div class="node" style="position:absolute;left:60px;top:30px;width:100px;height:50px">b</div>'
    + '<div class="node" style="position:absolute;left:300px;top:200px;width:50px;height:50px"><span class="node">inside</span></div>',
  'clip.html': '<div style="overflow-x:auto;width:200px"><div class="inner" style="width:500px;height:10px">scrolls</div></div>',
  'error.html': '<p>before</p><script>console.error("warned"); throw new Error("boom");</script>',
  'outside.html': '<img alt="remote" src="http://127.0.0.1:9/pixel.png">',
  'missing-image.html': '<img alt="gone" src="absent.png">',
  'many-clipped.html': '<div style="overflow-x:auto;width:380px">' + '<span style="display:inline-block;width:500px">x</span>'.repeat(60) + '</div><div class="loose" style="width:600px;height:10px">loose</div>',
};

let dir;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-screen-check-'));
  for (const [name, body] of Object.entries(fixtures)) {
    await fs.writeFile(path.join(dir, name), `<!doctype html><meta name="viewport" content="width=device-width"><title>${name}</title>${body}`);
  }
});
after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const filePath = name => path.join(dir, name);
const fileUrl = name => pathToFileURL(filePath(name)).href;

async function openBrowser() {
  for (const options of [{ channel: 'chrome' }, {}]) {
    try {
      return await chromium.launch({ headless: true, ...options });
    } catch {
      // Try the next browser; the caller skips when none starts.
    }
  }
  return null;
}

async function withPage(browser, width, address, measure) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(address, { waitUntil: 'load' });
    return await measure(page);
  } finally {
    await context.close();
  }
}

async function cli(args) {
  try {
    const { stdout } = await run(process.execPath, [script, ...args], { timeout: 180000 });
    return { code: 0, stdout, json: stdout.startsWith('{') ? JSON.parse(stdout) : null };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, json: JSON.parse(error.stdout) };
  }
}

describe('pageFindings on fixture pages', () => {
  let browser;
  before(async () => {
    browser = await openBrowser();
  });
  after(async () => {
    await browser?.close();
  });

  test('a wide box makes the page scroll sideways at phone width, not at desktop width', async t => {
    if (!browser) return t.skip('no Chrome, Edge or Chromium on this machine');
    const phone = await withPage(browser, 390, fileUrl('wide.html'), page => pageFindings(page));
    assert.equal(phone.horizontalOverflow, true);
    assert.ok(phone.elementsPastEdge.some(el => el.element.startsWith('div.wide')), JSON.stringify(phone.elementsPastEdge));
    assert.equal(phone.unnamedButtons.length, 1);
    assert.ok(phone.elementsPastEdgeUnclipped >= 1, String(phone.elementsPastEdgeUnclipped));
    const desktop = await withPage(browser, 1440, fileUrl('wide.html'), page => pageFindings(page));
    assert.equal(desktop.horizontalOverflow, false);
  });

  test('a box that scrolls inside its own width is named as clipped and does not make the page scroll', async t => {
    if (!browser) return t.skip('no Chrome, Edge or Chromium on this machine');
    const found = await withPage(browser, 390, fileUrl('clip.html'), page => pageFindings(page));
    assert.equal(found.horizontalOverflow, false);
    const inner = found.elementsPastEdge.find(el => el.element.startsWith('div.inner'));
    assert.ok(inner, JSON.stringify(found.elementsPastEdge));
    assert.match(inner.clippedBy, /^div/);
    assert.equal(found.elementsPastEdgeUnclipped, 0);
  });

  test('boxes that no box keeps in are counted and listed before the clipped ones', async t => {
    if (!browser) return t.skip('no Chrome, Edge or Chromium on this machine');
    const found = await withPage(browser, 390, fileUrl('many-clipped.html'), page => pageFindings(page));
    assert.ok(found.elementsPastEdgeTotal > 50, String(found.elementsPastEdgeTotal));
    assert.equal(found.elementsPastEdgeUnclipped, 1);
    assert.ok(found.elementsPastEdge[0].element.startsWith('div.loose'), JSON.stringify(found.elementsPastEdge[0]));
    assert.equal(found.elementsPastEdge[0].clippedBy, null);
  });

  test('overlapping boxes of the selector are reported, and a box inside another is not an overlap', async t => {
    if (!browser) return t.skip('no Chrome, Edge or Chromium on this machine');
    const found = await withPage(browser, 1440, fileUrl('overlap.html'), page => pageFindings(page, { selector: '.node' }));
    assert.equal(found.overlaps.matched, 4);
    assert.equal(found.overlaps.total, 1);
    assert.deepEqual(found.overlaps.pairs[0], ['div.node "a"', 'div.node "b"']);
  });
});

describe('rho-screen-check command', () => {
  let browserAvailable = false;
  let server;
  let serverUrl;
  before(async () => {
    const probe = await openBrowser();
    browserAvailable = probe !== null;
    await probe?.close();
    server = http.createServer((request, response) => {
      const name = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname.slice(1));
      fs.readFile(path.join(dir, name)).then(body => {
        response.setHeader('content-type', 'text/html');
        response.end(body);
      }, () => {
        response.statusCode = 404;
        response.end();
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    serverUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  test('writes one screenshot per viewport and the report, and exits 0', async t => {
    if (!browserAvailable) return t.skip('no Chrome, Edge or Chromium on this machine');
    const out = path.join(dir, 'out-screens');
    const result = await cli([filePath('wide.html'), '--viewport', '390x844', '--viewport', '1440x900', '--out', out]);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.viewports.length, 2);
    for (const view of result.json.viewports) {
      const png = await fs.readFile(view.screenshot);
      assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${view.viewport} screenshot is a PNG`);
    }
    assert.ok((await fs.stat(path.join(out, 'report.json'))).isFile());
  });

  test('page and console errors are reported, and the run still exits 0', async t => {
    if (!browserAvailable) return t.skip('no Chrome, Edge or Chromium on this machine');
    const result = await cli([filePath('error.html'), '--viewport', '1024x768', '--out', path.join(dir, 'out-errors')]);
    assert.equal(result.code, 0, result.stdout);
    assert.ok(result.json.viewports[0].pageErrors.some(message => message.includes('boom')), JSON.stringify(result.json.viewports[0].pageErrors));
    assert.ok(result.json.viewports[0].consoleErrors.includes('warned'));
  });

  test('a response that fails is named with its status and address', async t => {
    if (!browserAvailable) return t.skip('no Chrome, Edge or Chromium on this machine');
    const result = await cli([`${serverUrl}/missing-image.html`, '--viewport', '390x844', '--out', path.join(dir, 'out-http-errors')]);
    assert.equal(result.code, 0, result.stdout);
    const errors = result.json.viewports[0].httpErrors;
    assert.ok(errors.some(error => error.status === 404 && error.url === `${serverUrl}/absent.png`), JSON.stringify(errors));
  });

  test('requests that leave the page are listed', async t => {
    if (!browserAvailable) return t.skip('no Chrome, Edge or Chromium on this machine');
    const result = await cli([filePath('outside.html'), '--viewport', '390x844', '--out', path.join(dir, 'out-outside')]);
    assert.equal(result.code, 0, result.stdout);
    assert.ok(result.json.viewports[0].requestsOutsideTargetTotal >= 1);
    assert.ok(result.json.viewports[0].requestsOutsideTarget.includes('http://127.0.0.1:9/pixel.png'));
  });

  test('an http address is reported without its query, so a token stays out of the output', async t => {
    if (!browserAvailable) return t.skip('no Chrome, Edge or Chromium on this machine');
    const result = await cli([`${serverUrl}/wide.html?token=secret-token`, '--viewport', '390x844', '--out', path.join(dir, 'out-http')]);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.json.target, `${serverUrl}/wide.html`);
    assert.ok(!result.stdout.includes('secret-token'));
  });

  test('--overlap reports the overlapping boxes from the command line', async t => {
    if (!browserAvailable) return t.skip('no Chrome, Edge or Chromium on this machine');
    const result = await cli([filePath('overlap.html'), '--viewport', '1440x900', '--overlap', '.node', '--out', path.join(dir, 'out-overlap')]);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.json.viewports[0].overlaps.total, 1);
  });

  test('a missing browser exits 2 and says what to do', async () => {
    const result = await cli([filePath('wide.html'), '--browser', '/nonexistent/browser', '--out', path.join(dir, 'out-nobrowser')]);
    assert.equal(result.code, 2);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.error.kind, 'browser_missing');
    assert.match(result.json.error.next, /Install Google Chrome/);
  });

  test('a page that does not load exits 2 with unreachable and what to do', async t => {
    if (!browserAvailable) return t.skip('no Chrome, Edge or Chromium on this machine');
    const result = await cli(['http://127.0.0.1:9/', '--viewport', '390x844', '--out', path.join(dir, 'out-unreachable')]);
    assert.equal(result.code, 2);
    assert.equal(result.json.error.kind, 'unreachable');
    assert.match(result.json.error.next, /Check the address/);
  });

  test('a wrong viewport exits 1 with usage', async () => {
    const result = await cli([filePath('wide.html'), '--viewport', '39x0']);
    assert.equal(result.code, 1);
    assert.equal(result.json.error.kind, 'usage');
  });

  test('no page exits 1 with usage', async () => {
    const result = await cli([]);
    assert.equal(result.code, 1);
    assert.equal(result.json.error.kind, 'usage');
  });

  test('--help lists the options and exits 0', async () => {
    const result = await cli(['--help']);
    assert.equal(result.code, 0);
    for (const option of ['--viewport', '--out', '--overlap', '--full-page', '--settle', '--browser']) {
      assert.ok(result.stdout.includes(option), `help mentions ${option}`);
    }
  });
});
