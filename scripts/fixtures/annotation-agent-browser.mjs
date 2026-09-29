// Uses the existing approved Agent context picker; no annotation editor UI.
import fs from 'node:fs';
import path from 'node:path';
import {chromium, expect} from '../../ui/node_modules/@playwright/test/index.mjs';

export async function annotationAgentBrowser({url, window, agent, query, invoke, pluginQuery, notePreview, image, directory}) {
  const layout = await query('windows.layout', {window});
  const view = (await invoke('windows.open_view', {expected_layout_version: layout.version,
    group: layout.layout.kind === 'tabs' ? layout.layout.id : null,
    view: {instance: agent, contribution: 'agent', window, configuration: {}, state: {}}})).output.view;
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  const output = path.join(directory, 'agent-browser'); fs.mkdirSync(output);
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}});
    page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const address = new URL(url); address.searchParams.set('window', window);
    await page.goto(address.href);
    const frame = page.locator(`[data-plugin-frame="${view.view}"]`).frameLocator('iframe');
    await frame.getByRole('button', {name: 'New task', exact: true}).click();
    await frame.getByRole('button', {name: 'Rho', exact: true}).click();
    await expect(frame.getByRole('textbox', {name: 'Agent message', exact: true})).toBeEnabled();
    const selected = await frame.getByLabel('Select task', {exact: true}).inputValue();
    expect(selected).toMatch(/^rho:/);
    const task = selected.slice(4);
    await frame.getByRole('button', {name: 'Choose context', exact: true}).click();
    const picker = frame.getByRole('dialog', {name: 'Choose context'});
    const source = picker.getByRole('combobox', {name: 'Context source', exact: true});
    const option = source.locator('option').filter({hasText: 'Saved annotations'});
    await expect(option).toHaveCount(1);
    await source.selectOption(await option.getAttribute('value'));
    await picker.getByRole('textbox', {name: 'Search context', exact: true}).fill('Check the original');
    await picker.getByRole('button', {name: 'Search', exact: true}).click();
    await expect(picker.locator('#context-items').getByRole('button', {name: /研究\.R/})).toHaveCount(1);
    await picker.locator('#context-items').getByRole('button', {name: /研究\.R/}).click();
    await expect(picker.locator('#context-preview')).toContainText('Check the original 🧬 result');
    await expect(picker.locator('#context-preview')).toContainText('Current source status: unknown');
    await expect(picker.getByRole('button', {name: 'Add to draft', exact: true})).toBeEnabled();
    const screenshots = [];
    for (const width of [1440, 960, 390, 220]) {
      await page.setViewportSize({width, height: 900});
      await expect.poll(() => frame.locator('body').evaluate((_node, width) => innerWidth >= width - 2 && innerWidth <= width, width)).toBe(true);
      await expect.poll(() => picker.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false);
      const file = path.join(output, `annotation-picker-${width}.png`);
      await picker.screenshot({path: file}); screenshots.push(file);
    }
    await picker.getByRole('button', {name: 'Add to draft', exact: true}).click();
    const conversation = () => pluginQuery(agent, 'agent.model.conversation', {conversation_id: task});
    await expect.poll(async () => (await conversation()).draft_content.context.length).toBe(1);
    const capture = (await conversation()).draft_content.context[0];
    expect(capture.reference).toEqual(notePreview.reference);
    expect(JSON.parse(capture.inclusion)).toEqual(notePreview.inclusion);
    await page.setViewportSize({width: 1440, height: 900});
    await page.reload();
    await expect(frame.getByLabel('Select task', {exact: true})).toHaveValue(selected);
    expect((await conversation()).draft_content.context).toEqual([capture]);
    let imageCapture=null;
    if (image) {
      await frame.getByRole('button',{name:'Choose context',exact:true}).click();
      await source.selectOption(await source.locator('option').filter({hasText:'Saved annotations'}).getAttribute('value'));
      await picker.getByRole('textbox',{name:'Search context',exact:true}).fill('Captured view with a marked region');
      await picker.getByRole('button',{name:'Search',exact:true}).click();
      await expect(picker.locator('#context-items').getByRole('button',{name:/研究\.R/})).toHaveCount(1);
      await picker.locator('#context-items').getByRole('button',{name:/研究\.R/}).click();
      await picker.getByRole('combobox',{name:'Context inclusion',exact:true}).selectOption({label:'Note, evidence and captured image'});
      const thumbnail=picker.getByRole('img',{name:'Selected captured image 1'});
      await expect(thumbnail).toBeVisible();await expect.poll(()=>thumbnail.evaluate(img=>img.naturalWidth)).toBe(256);
      await expect(picker.getByRole('button',{name:'Add to draft',exact:true})).toBeEnabled();
      for(const width of [1440,960,390,220]){
        await page.setViewportSize({width,height:900});await expect.poll(()=>picker.evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(false);
        const file=path.join(output,`annotation-image-picker-${width}.png`);await picker.screenshot({path:file});screenshots.push(file);
        await picker.getByRole('button',{name:'Add to draft',exact:true}).scrollIntoViewIfNeeded();
        const bottom=path.join(output,`annotation-image-picker-bottom-${width}.png`);await picker.screenshot({path:bottom});screenshots.push(bottom);
        await picker.evaluate(node=>{node.scrollTop=0;});
      }
      await picker.getByRole('button',{name:'Add to draft',exact:true}).click();
      await expect.poll(async()=>(await conversation()).draft_content.context.length).toBe(2);
      imageCapture=(await conversation()).draft_content.context[1];expect(imageCapture.reference).toEqual(image.selection.reference);
      expect(JSON.parse(imageCapture.inclusion)).toEqual({kind:'note_evidence_and_image'});
      await page.reload();expect((await conversation()).draft_content.context).toEqual([capture,imageCapture]);
    }
    expect(errors).toEqual([]);
    return {task, capture, image_capture:imageCapture, screenshots, draft_survives_reload: true, sent: false};
  } finally { await browser.close(); }
}
