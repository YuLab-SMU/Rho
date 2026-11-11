// Real browser and a real Agent configuring itself from the page's copied prompt.
// All client configuration and project work are disposable; model credentials stay in env.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { chromium } from '@playwright/test';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { mcpName } from '../dist/agent-connect.js';
import { BrowserClient } from '../dist/browser.js';
import { inspectResponsive } from './browser-checks.mjs';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rho-connect-episode-')));
const evidence = path.resolve(process.env.RHO_CONNECT_EVIDENCE ?? 'work/agent-connect/' + Date.now());
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const report = { passed: false, root, checks: [], turns: [], browserErrors: [] };
const check = text => { report.checks.push(text); console.log('ok · ' + text); };
let service, browser;
const wait = async (read, accept, label) => {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await new Promise(r => setTimeout(r, 200)); }
  throw new Error(label);
};
try {
  service = await new RhoService({ root, stateDir: path.join(root, 'state'), coreBinary: path.join(root, 'absent-core'), rscript: 'Rscript', example: false }).start();
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const person = new BrowserClient({ url: service.url });
  const project = await operator.call('project.create', { name: '连接 study' });
  const call = (method, body = {}) => person.call(method, { projectId: project.id, ...body });
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => report.browserErrors.push(e.message));
  await page.goto(service.url + '/#project=' + project.id);
  await page.locator('.project-nav').getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  const pane = page.locator('.outside-agents');
  const reload = async () => { await page.reload(); await page.locator('.project-nav').getByRole('button', { name: 'Agents', exact: true }).click(); await page.getByRole('tab', { name: 'Agents', exact: true }).click(); };
  await pane.getByRole('button', { name: 'Copy setup prompt', exact: true }).click();
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(prompt, (await call('session.instructions')).prompt);
  assert.equal((await call('observation.snapshot')).agents.length, 0);
  check('the real clipboard holds the project prompt; copying grants no access');
  await inspectResponsive(page, { name: 'empty', evidence, report });

  // Reload through a real failed request, then recover through the page's Try again.
  await page.route('**/api/v2/session.instructions', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { kind: 'unavailable', message: 'Setup temporarily unavailable.' } }) }));
  await reload(); await pane.getByText('Setup temporarily unavailable.', { exact: false }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'failed-request.png'), fullPage: true });
  await page.unroute('**/api/v2/session.instructions');
  await pane.getByRole('button', { name: 'Try again', exact: true }).click();
  await pane.getByRole('button', { name: 'Copy setup prompt', exact: true }).waitFor();
  await wait(() => pane.getByRole('button', { name: 'Copy setup prompt', exact: true }).isEnabled(), Boolean, 'instructions did not recover');
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('clipboard denied'); }; });
  await pane.getByRole('button', { name: 'Copy setup prompt', exact: true }).click();
  await pane.getByText('Could not copy.', { exact: false }).waitFor();
  await pane.locator('summary').filter({ hasText: 'Full setup prompt' }).click();
  assert.equal(await pane.getByRole('textbox', { name: 'Full setup prompt' }).inputValue(), prompt);
  await page.screenshot({ path: path.join(evidence, 'clipboard-fallback.png'), fullPage: true });
  check('request failure recovers; clipboard refusal leaves a selectable full prompt');
  await reload();

  const settings = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude/settings.json'), 'utf8'));
  const configDir = path.join(root, 'claude-config'); await fs.mkdir(configDir);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']) if (settings.env?.[key]) env[key] = settings.env[key];
  const model = process.env.RHO_CONNECT_MODEL ?? settings.model ?? env.ANTHROPIC_MODEL;
  const common = ['--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', 'dontAsk', '--setting-sources', 'user,project,local', '--max-turns', '24', ...(model ? ['--model', model] : [])];
  const run = async (name, message, extra) => {
    const started = Date.now();
    const result = await new Promise(resolve => execFile(process.env.RHO_CLAUDE ?? 'claude', [...common, ...extra, '--', message], { cwd: project.root, env, timeout: 300000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
    await fs.writeFile(path.join(evidence, name + '.json'), result.stdout, { mode: 0o600 });
    await fs.writeFile(path.join(evidence, name + '.stderr'), result.stderr, { mode: 0o600 });
    assert.ok(result.stdout.trim(), name + ': ' + result.stderr);
    const events = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const value = events.find(event => event.type === 'result');
    assert.ok(value, name + ' returned no result');
    const toolNames = events.flatMap(event => event.type === 'assistant' ? (event.message?.content ?? []).filter(block => block.type === 'tool_use').map(block => block.name) : []);
    report.turns.push({ name, code: result.code, elapsedMs: Date.now() - started, result: value.result, toolNames, permissionDenials: value.permission_denials?.length ?? 0 });
    assert.equal(result.code, 0, name + ' failed'); assert.equal(value.is_error, false, name + ' returned an error');
    return { value, toolNames };
  };
  console.log('Running the copied prompt in an isolated real Claude Code client…');
  await run('configure', prompt + '\n\nThis is a disposable connection check. CLAUDE_CONFIG_DIR is isolated; keep configuration there or in this project. Do not modify any other client settings.', ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Bash,Read,Write,Edit', '--allowedTools', 'Bash,Read,Write,Edit']);
  const granted = (await call('observation.snapshot')).agents.filter(a => !a.conversationId);
  assert.equal(granted.length, 1, 'the Agent provisioned one named connection');
  report.agentLabel = granted[0].label;
  await wait(() => pane.innerText(), text => text.includes(granted[0].label), 'the generic grant did not appear');
  await page.screenshot({ path: path.join(evidence, 'configured.png'), fullPage: true });
  check('a real Agent chose its identity and configured its own MCP entry from the prompt');
  console.log('Starting a new client session to verify the configured tools…');
  const beforeVerify = Date.now();
  const verified = await run('verify', `Use your configured Rho MCP server to call rho_index and report scopeHint.projectId. It should equal ${project.id}. This check needs only rho_index; do not call other tools, edit files or reconfigure anything.`, ['--tools', '', '--allowedTools', `mcp__${mcpName(project.root)}__rho_index`]);
  assert.equal(verified.value.permission_denials?.length ?? 0, 0, 'the verification tool must be allowed by the native client');
  assert.ok(verified.toolNames.some(name => /^mcp__.+__rho_index$/.test(name)), 'the new client must call its configured MCP tool, not a direct protocol probe');
  await wait(async () => (await call('observation.snapshot')).agents.find(a => a.principal === granted[0].principal), a => a?.last?.method === 'capability.index' && a.last.outcome === 'returned' && Date.parse(a.last.at) >= beforeVerify, 'no successful rho_index call from the configured client');
  await wait(() => pane.innerText(), text => text.includes('Call verified'), 'verified call did not appear');
  await inspectResponsive(page, { name: 'verified', evidence, report });
  check('a new real client session loaded its own configuration and called rho_index successfully');
  await page.getByRole('radiogroup', { name: 'Agent for new conversations', exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'conversation-settings.png'), fullPage: true });
  assert.deepEqual(report.browserErrors, []);
  report.passed = true;
} finally {
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  await browser?.close(); await service?.close();
  console.log('Evidence: ' + evidence);
}
