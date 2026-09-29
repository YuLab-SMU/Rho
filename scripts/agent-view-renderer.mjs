// Standalone browser acceptance for Agent rendering only. No Host/native claims.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
export async function testAgentRenderer(root, assets) {
  const { chromium, expect } = await import(pathToFileURL(path.join(root, 'ui/node_modules/@playwright/test/index.mjs')));
  const output = path.join(root, 'target/plugin-refactor/agent-view-renderer'); fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><style>html,body,iframe{margin:0;border:0;width:100%;height:100%;overflow:hidden}iframe{display:block}</style><iframe title="Agent" sandbox="allow-scripts"></iframe><script src="/fixture.js"></script>'); return; }
    const location = req.url === '/fixture.js' ? path.join(root, 'scripts/fixtures/agent-view-container.js') : path.resolve(assets, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (req.url !== '/fixture.js' && !location.startsWith(assets + path.sep) || !fs.existsSync(location) || !fs.statSync(location).isFile()) { res.writeHead(404).end(); return; }
    const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2' }[path.extname(location)] ?? 'application/octet-stream';
    res.setHeader('Content-Type', type.startsWith('text/') ? type + '; charset=utf-8' : type); res.setHeader('Access-Control-Allow-Origin', '*'); res.end(fs.readFileSync(location));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, page;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    page = await browser.newPage({ viewport: { width: 960, height: 820 } }); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const frame = page.frameLocator('iframe'), input = frame.getByRole('textbox', { name: 'Agent message' });
    await expect(input).toBeEnabled(); await expect(frame.getByRole('log')).toContainText('selected calculation returned 42');
    await expect(frame.getByRole('log')).toContainText('细胞类型 Ω');
    await expect(frame.getByRole('log')).not.toContainText('RENDERER_PRIVATE_REASONING');
    for (const width of [960, 440, 320, 220]) {
      await page.setViewportSize({ width, height: 820 });
      await expect(frame.locator('#task-rail'))[width >= 640 ? 'toBeVisible' : 'toBeHidden']();
      const overflow = await frame.locator('body').evaluate(node => node.scrollWidth > innerWidth); assert.equal(overflow, false, `No body overflow at ${width}`);
      await frame.getByRole('button', { name: 'New task', exact: true }).click(); await expect(frame.getByRole('button', { name: 'Kimi Code', exact: true })).toBeVisible();
      await expect.poll(async () => {
        const anchor = await frame.locator('#new-task').boundingBox(), menu = await frame.locator('#new-menu').boundingBox();
        return menu.x >= 0 && menu.x + menu.width <= width && Math.abs(menu.y - (anchor.y + anchor.height)) < 12;
      }, { message: 'New task menu stays beside its button' }).toBe(true);
      await page.screenshot({ path: path.join(output, `agent-${width}.png`) });
      await input.click();
    }
    await page.setViewportSize({ width: 440, height: 820 });
    await page.evaluate(() => { window.fixture.pagedTasks(true); window.fixture.pagedHistory(true); });
    await expect(frame.getByRole('button', {name:'Older tasks',exact:true})).toBeEnabled();
    await frame.getByRole('button', {name:'Older tasks',exact:true}).click();
    await expect(frame.getByRole('combobox', {name:'Select task'}).locator('option').filter({hasText:'Earlier task 24'})).toHaveCount(1);
    await expect(frame.getByRole('button', {name:'Newer tasks',exact:true})).toBeEnabled();
    await frame.getByRole('button', {name:'Newer tasks',exact:true}).click();
    await expect(frame.getByRole('combobox', {name:'Select task'})).toHaveValue('task-0');
    await expect(frame.getByRole('log')).toContainText('Retained message 220');
    await expect(frame.getByRole('log')).not.toContainText('Retained message 21 ·');
    await frame.getByRole('button', {name:'Earlier messages',exact:true}).click();
    await expect(frame.getByRole('log')).toContainText('Retained message 21 ·');
    await frame.getByRole('log').evaluate(node => node.scrollTop = 0);
    const historyReads = (await page.evaluate(() => window.fixture.snapshot())).reads['agent.native.task'];
    await page.waitForFunction(before => window.fixture.snapshot().reads['agent.native.task'] > before, historyReads);
    assert.ok(await frame.getByRole('log').evaluate(node => node.scrollTop < 2), 'Polling preserves earlier reading position');
    for (const width of [440, 220]) {
      await page.setViewportSize({width,height:820});
      await page.screenshot({path:path.join(output,`agent-history-${width}.png`)});
      assert.equal(await frame.locator('body').evaluate(node=>node.scrollWidth>innerWidth),false);
    }
    await frame.getByRole('button', {name:'Latest messages',exact:true}).click();
    await expect(frame.getByRole('log')).not.toContainText('Retained message 21 ·');
    await expect(frame.getByRole('log')).toContainText('Retained message 220');
    await page.evaluate(() => { window.fixture.pagedTasks(false); window.fixture.pagedHistory(false); });
    await expect(frame.getByRole('log')).toContainText('selected calculation returned 42');
    await page.setViewportSize({width:440,height:820});
    // Native composition event and Enter must neither save partial text nor Send.
    await input.dispatchEvent('compositionstart'); await input.fill('中文 Ω');
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
    assert.equal((await page.evaluate(() => window.fixture.snapshot())).calls.length, 0);
    await input.dispatchEvent('compositionend');
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter' });
    await expect(frame.locator('#draft-status')).toHaveText('Draft saved');
    let snapshot = await page.evaluate(() => window.fixture.snapshot()); assert.equal(snapshot.calls.filter(call => call.arguments?.arguments?.command?.kind === 'send').length, 0);
    assert.equal(snapshot.details[0][1].draft.content.text, '中文 Ω');
    // Switch within the debounce interval: the saved text must belong to task-0.
    await input.fill('Draft belongs to the first task');
    await frame.getByRole('combobox', { name: 'Select task' }).selectOption('task-1');
    await expect(input).toHaveValue('');
    await expect.poll(async () => (await page.evaluate(() => window.fixture.snapshot())).details[0][1].draft.content.text).toBe('Draft belongs to the first task');
    await frame.getByRole('combobox', { name: 'Select task' }).selectOption('task-0'); await expect(input).toHaveValue('Draft belongs to the first task');
    await frame.locator('#attachment-file').setInputFiles({ name: '完整附件.txt', mimeType: 'text/plain', buffer: Buffer.alloc(8 * 1024 * 1024, 82) });
    await expect(frame.locator('#attachments')).toContainText('完整附件.txt'); await expect(frame.locator('#draft-status')).toHaveText('Draft saved');
    snapshot = await page.evaluate(() => window.fixture.snapshot());
    assert.equal(snapshot.calls.filter(call => call.capability?.id === 'agent.native.assets.stage').length, 128);
    assert.ok(snapshot.calls.filter(call => call.capability?.id === 'agent.native.assets.stage').every(call => call.arguments.encoded_bytes <= 87384));
    await page.evaluate(() => window.fixture.loseAttachmentReply());
    await frame.locator('#attachment-file').setInputFiles({ name: 'lost-reply.txt', mimeType: 'text/plain', buffer: Buffer.from('Preserve the original import.') });
    await expect(frame.getByRole('alert')).toContainText('Lost attachment reply');
    await page.evaluate(() => window.fixture.reload()); await expect(frame.locator('#uploads')).toContainText('lost-reply.txt');
    await frame.locator('#uploads').getByRole('button', { name: 'Check status' }).click();
    await expect(frame.locator('#uploads')).toContainText('Ready to add'); await expect(frame.locator('#attachments')).not.toContainText('lost-reply.txt');
    await frame.locator('#uploads').getByRole('button', { name: 'Add to draft' }).click();
    await expect(frame.locator('#attachments')).toContainText('lost-reply.txt'); await expect(frame.locator('#draft-status')).toHaveText('Draft saved');
    snapshot = await page.evaluate(() => window.fixture.snapshot()); assert.equal(snapshot.calls.filter(call => call.capability?.id === 'agent.native.assets.finish').length, 2);
    for (const width of [440, 320, 220]) {
      await page.setViewportSize({ width, height: 820 }); await page.screenshot({ path: path.join(output, `agent-attachments-${width}.png`) });
      assert.equal(await frame.locator('body').evaluate(node => node.scrollWidth > innerWidth), false);
    }
    await page.setViewportSize({ width: 440, height: 820 });
    await frame.getByRole('button', { name: 'Tools', exact: true }).click(); await frame.getByRole('checkbox', { name: 'run_selected_r' }).check(); await frame.getByRole('button', { name: 'Tools', exact: true }).click();
    await frame.getByRole('button', { name: 'Send message' }).click(); await expect(frame.getByRole('button', { name: 'Stop Agent' })).toBeVisible();
    await expect(input).toHaveValue(''); await expect(frame.getByRole('log')).toContainText('完整附件.txt · lost-reply.txt'); await input.fill('Keep this next draft after reopening'); await expect(frame.locator('#draft-status')).toHaveText('Draft saved');
    snapshot = await page.evaluate(() => window.fixture.snapshot()); const send = snapshot.calls.filter(call => call.arguments?.arguments?.command?.kind === 'send');
    assert.equal(send.length, 1); assert.equal(send[0].arguments.arguments.tools.length, 1);
    assert.equal(snapshot.details[0][1].receipts.find(r => r.command === 'send').input_assets.length, 2);
    await page.evaluate(() => window.fixture.reload()); await expect(input).toHaveValue('Keep this next draft after reopening');
    await expect(frame.getByRole('button', { name: 'Stop Agent' })).toBeVisible();
    await page.screenshot({ path: path.join(output, 'agent-running-reopened.png') });
    snapshot = await page.evaluate(() => window.fixture.snapshot()); assert.equal(snapshot.calls.filter(call => call.arguments?.arguments?.command?.kind === 'send').length, 1);
    const { testSettingsRenderer } = await import('./fixtures/agent-settings-renderer.mjs');
    await testSettingsRenderer(page, frame, expect, output);
    await page.evaluate(() => window.fixture.close());
    await expect.poll(async () => (await page.evaluate(() => window.fixture.snapshot())).calls.filter(call => call.type === 'prepare_close').length).toBe(1);
    snapshot = await page.evaluate(() => window.fixture.snapshot()); assert.equal(snapshot.calls.filter(call => call.arguments?.arguments?.command?.kind === 'stop').length, 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', fixture: 'synthetic public MessagePort; no Host or native Agent', checks: ['opaque iframe bootstrap', '960/440/320/220 layout and anchored menu', 'reasoning excluded', 'IME Enter', 'debounced save across task switch', 'explicit tools captured by one Send', 'next draft and original Operation after reload', 'close does not Stop', '8 MiB file selection in bounded chunks', 'lost attachment receipt reload and explicit selection without reimport', 'task pagination', 'earlier history with stable scroll through polling; explicit return to latest'] }, null, 2) + '\n');
    console.log(`Agent renderer and Rho settings checks passed (960/440/320/220, original key/configuration/removal receipt recovery, explicit synthetic model test). Evidence: ${output}. Synthetic peer, not native/Host acceptance.`);
  } catch (error) {
    await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    if (page) {
      const snapshot = await page.evaluate(() => window.fixture.snapshot()).catch(() => null);
      const validation = await page.frameLocator('iframe').locator('#settings-form').evaluate(form => ({
        valid: form.checkValidity(), handler: typeof form.onsubmit,
        controls: [...form.elements].map(element => ({ id: element.id, disabled: element.disabled, valid: element.validity?.valid, message: element.validationMessage })),
      })).catch(() => null);
      fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({snapshot, validation}, null, 2));
    }
    throw error;
  }
  finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
