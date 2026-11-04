#!/usr/bin/env node
// Opens a page in a real browser at each viewport and reports what it shows: whether it scrolls
// sideways, the elements that cross the right edge, unnamed buttons, overlapping boxes of a selector,
// page and console errors, requests that leave the page, and a screenshot per viewport. It reports
// what the page does; it does not judge the design, and it changes nothing on the page.
//
//   rho-screen-check <url or page.html> [--viewport WxH]... [--out DIR] [--overlap SELECTOR]
//                    [--full-page] [--settle MS] [--browser auto|chrome|msedge|chromium|PATH]
//
// Prints the report as JSON and writes it to DIR/report.json (default ./screen-check).
// Exit status: 0 the check ran (its findings are in the report); 1 an argument was wrong;
// 2 the check did not run (error.kind, error.message and error.next say why and what to do).
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { pageFindings, viewports } from './browser-checks.mjs';

class CheckError extends Error {
  constructor(kind, message, next) {
    super(message);
    this.kind = kind;
    this.next = next;
  }
}

const usage = `Usage: rho-screen-check <url or page.html> [options]

Options:
  --viewport WxH       a viewport to check, repeatable
                       (default 1440x900, 1024x768, 768x1024, 390x844)
  --out DIR            folder for the screenshots and report.json (default ./screen-check)
  --overlap SELECTOR   report pairs of visible boxes matching SELECTOR that overlap
  --full-page          screenshot the whole page, not only the window
  --settle MS          wait after load before measuring (default 800)
  --browser NAME       auto (default: Chrome, then Edge, then Playwright's Chromium), chrome,
                       msedge, chromium, or the path of a Chromium-based browser
  -h, --help           show this help

Prints the report as JSON on stdout and writes it to DIR/report.json.
Exit status: 0 the check ran; 1 an argument was wrong; 2 the check did not run.
`;

const firstLine = error => String(error?.message ?? error).split('\n')[0].slice(0, 300);

function parseSize(text) {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(text);
  const width = match ? Number(match[1]) : 0;
  const height = match ? Number(match[2]) : 0;
  if (!match || width < 200 || width > 3840 || height < 200 || height > 2400) {
    throw new CheckError('usage', `Viewport "${text}" is not WIDTHxHEIGHT, between 200 and 3840 wide and 200 and 2400 high.`, 'Use a form such as --viewport 390x844.');
  }
  return [width, height];
}

async function targetOf(text) {
  if (/^https?:\/\//i.test(text)) {
    try {
      return new URL(text);
    } catch {
      throw new CheckError('usage', `"${text}" is not a valid address.`, 'Give the full address, such as http://127.0.0.1:8080/.');
    }
  }
  const file = path.resolve(text);
  try {
    await fs.access(file);
  } catch {
    throw new CheckError('usage', `There is no file at ${file}.`, 'Give the path of an HTML file, or an address that starts with http:// or https://.');
  }
  return new URL(pathToFileURL(file).href);
}

// The report names the page without its query, fragment or credentials: a token in an address stays out of the output.
function shownTarget(url) {
  const copy = new URL(url.href);
  copy.username = '';
  copy.password = '';
  copy.search = '';
  copy.hash = '';
  return copy.href;
}

async function launchBrowser(choice) {
  const names = choice === 'auto' ? ['chrome', 'msedge', 'chromium'] : [choice];
  const attempts = [];
  for (const name of names) {
    const options = { headless: true };
    if (name === 'chrome' || name === 'msedge') options.channel = name;
    else if (name !== 'chromium') options.executablePath = name;
    try {
      return { browser: await chromium.launch(options), name };
    } catch (error) {
      attempts.push(`${name}: ${firstLine(error)}`);
    }
  }
  throw new CheckError('browser_missing', `No browser could be started. ${attempts.join(' | ')}`, 'Install Google Chrome or Microsoft Edge, or pass --browser with the path of an installed Chromium-based browser; then run the check again.');
}

async function checkViewport(browser, target, [width, height], out, settle, values) {
  const context = await browser.newContext({ viewport: { width, height } });
  try {
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const outside = new Set();
    page.on('pageerror', error => pageErrors.push(firstLine(error)));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)); });
    page.on('request', request => {
      const url = new URL(request.url());
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== target.origin) outside.add(url.origin + url.pathname);
    });
    const httpErrors = new Map();
    page.on('response', response => {
      if (response.status() < 400) return;
      const url = new URL(response.url()), address = url.origin + url.pathname;
      httpErrors.set(`${response.status()} ${address}`, { status: response.status(), url: address });
    });
    try {
      await page.goto(target.href, { waitUntil: 'load', timeout: 30000 });
    } catch (error) {
      throw new CheckError('unreachable', `The page did not load: ${firstLine(error)}`, 'Check the address, that the service is running or the file exists, and that the page opens in a browser; then run the check again.');
    }
    await page.waitForTimeout(settle);
    const findings = await pageFindings(page, { selector: values.overlap ?? null });
    const screenshot = path.join(out, `${width}x${height}.png`);
    await page.screenshot({ path: screenshot, fullPage: Boolean(values['full-page']) });
    return {
      viewport: `${width}x${height}`, screenshot, ...findings,
      pageErrors, consoleErrors,
      httpErrors: [...httpErrors.values()].slice(0, 20), httpErrorsTotal: httpErrors.size,
      requestsOutsideTarget: [...outside].slice(0, 20), requestsOutsideTargetTotal: outside.size,
    };
  } finally {
    await context.close();
  }
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        viewport: { type: 'string', multiple: true },
        out: { type: 'string' },
        overlap: { type: 'string' },
        'full-page': { type: 'boolean' },
        settle: { type: 'string' },
        browser: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new CheckError('usage', firstLine(error), 'Run rho-screen-check --help to see the options.');
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(usage);
    return 0;
  }
  if (positionals.length !== 1) throw new CheckError('usage', 'Give exactly one page: a URL or an HTML file.', 'Run rho-screen-check --help to see the forms.');
  const target = await targetOf(positionals[0]);
  const sizes = values.viewport?.length ? values.viewport.map(parseSize) : viewports;
  const settle = values.settle === undefined ? 800 : Number(values.settle);
  if (!Number.isInteger(settle) || settle < 0 || settle > 10000) throw new CheckError('usage', `--settle must be a whole number of milliseconds from 0 to 10000, not "${values.settle}".`, 'Use a form such as --settle 800.');
  const out = path.resolve(values.out ?? 'screen-check');
  await fs.mkdir(out, { recursive: true });
  const { browser, name } = await launchBrowser(values.browser ?? 'auto');
  try {
    const reports = [];
    for (const size of sizes) reports.push(await checkViewport(browser, target, size, out, settle, values));
    const report = { tool: 'rho-screen-check', target: shownTarget(target), browser: name, checkedAt: new Date().toISOString(), viewports: reports };
    const file = path.join(out, 'report.json');
    await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ ok: true, ...report, report: file }, null, 2) + '\n');
    return 0;
  } finally {
    await browser.close();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const usageError = error instanceof CheckError && error.kind === 'usage';
  const detail = error instanceof CheckError
    ? { kind: error.kind, message: error.message, next: error.next }
    : { kind: 'failed', message: firstLine(error), next: 'Run the check again. If it fails the same way, open the page in a browser and read what it shows.' };
  process.stdout.write(JSON.stringify({ ok: false, error: detail }, null, 2) + '\n');
  process.exitCode = usageError ? 1 : 2;
}
