import assert from 'node:assert/strict';
import path from 'node:path';

export async function testRhoRenderer(page, frame, expect, output) {
  const input=frame.getByRole('textbox',{name:'Agent message'}), tasks=frame.getByRole('combobox',{name:'Select task'});
  await page.evaluate(()=>window.fixture.loseRhoReply('agent.model.create'));
  await frame.getByRole('button',{name:'New task',exact:true}).click();await frame.getByRole('button',{name:'Rho',exact:true}).click();
  await expect(frame.getByRole('alert')).toContainText('Lost original Rho reply');
  await page.evaluate(()=>window.fixture.reload());await expect(frame.locator('#recovery')).toBeVisible();
  await frame.locator('#inspect-original').click();await expect(input).toBeEnabled();
  const selection=await tasks.inputValue();assert.match(selection,/^rho:/);
  await input.fill('Explain this captured result · 中文 Ω');await expect(frame.locator('#draft-status')).toHaveText('Draft saved');
  await frame.getByRole('button',{name:'Send message'}).click();await expect(frame.getByRole('alert')).toContainText('key is unavailable');
  await expect(input).toHaveValue('Explain this captured result · 中文 Ω');
  await frame.getByRole('button',{name:'Task actions',exact:true}).click();await frame.getByRole('button',{name:'Settings',exact:true}).click();
  const dialog=frame.getByRole('dialog',{name:'Agent settings'});
  await dialog.getByRole('textbox',{name:'API key',exact:true}).fill('RHO-RENDERER-SYNTHETIC-KEY');
  await dialog.getByRole('button',{name:'Save',exact:true}).click();await expect(dialog.locator('#settings-key-status')).toContainText('Saved on this computer');
  await dialog.getByRole('button',{name:'Close settings'}).click();
  await page.evaluate(()=>window.fixture.loseRhoReply('agent.model.run'));
  await frame.getByRole('button',{name:'Send message'}).click();await expect(frame.getByRole('alert')).toContainText('Lost original Rho reply');
  await expect(input).toHaveValue('');await input.fill('Keep my next Rho draft · 后续输入');await expect(frame.locator('#draft-status')).toHaveText('Draft saved');
  await tasks.selectOption('native:task-0');await expect(input).toHaveValue('Keep this next draft after reopening');
  await tasks.selectOption(selection);await expect(input).toHaveValue('Keep my next Rho draft · 后续输入');
  await page.evaluate(()=>window.fixture.reload());await expect(input).toHaveValue('Keep my next Rho draft · 后续输入');
  await expect(frame.locator('#recovery')).toBeVisible();await frame.locator('#inspect-original').click();
  await expect(frame.locator('#recovery')).toBeHidden();await expect(frame.getByRole('button',{name:'Stop Agent'})).toBeVisible();
  let snapshot=await page.evaluate(()=>window.fixture.snapshot());
  assert.equal(snapshot.calls.filter(c=>c.capability?.id==='agent.model.run').length,1);
  assert.equal(snapshot.calls.filter(c=>c.capability?.id==='agent.model.create').length,1);
  assert.equal(JSON.stringify(snapshot).includes('RHO-RENDERER-SYNTHETIC-KEY'),false);
  await page.evaluate(()=>window.fixture.finishRho('rho-run-0'));
  await expect(frame.getByRole('log')).toContainText('Retained Rho answer · 中文 Ω');
  await expect(frame.getByRole('log')).not.toContainText('RHO_PRIVATE_REASONING');
  await expect(frame.getByRole('button',{name:'Send message'})).toBeVisible();
  for(const width of [960,440,320,220]){
    await page.setViewportSize({width,height:820});
    assert.equal(await frame.locator('body').evaluate(node=>node.scrollWidth>innerWidth),false,`Rho has no overflow at ${width}`);
    await page.screenshot({path:path.join(output,`agent-rho-${width}.png`)});
  }
  await page.setViewportSize({width:440,height:820});await page.evaluate(()=>window.fixture.reload());
  await expect(frame.getByRole('log')).toContainText('Retained Rho answer · 中文 Ω');await expect(input).toHaveValue('Keep my next Rho draft · 后续输入');
  snapshot=await page.evaluate(()=>window.fixture.snapshot());assert.equal(snapshot.rhoRuns.length,1);
  await tasks.selectOption('native:task-0');await expect(input).toHaveValue('Keep this next draft after reopening');
}
