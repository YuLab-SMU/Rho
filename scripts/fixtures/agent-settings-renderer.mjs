import assert from 'node:assert/strict';
import path from 'node:path';

export async function testSettingsRenderer(page, frame, expect, output) {
  const open = async () => { await frame.getByRole('button',{name:'Task actions',exact:true}).click(); await frame.getByRole('button',{name:'Settings',exact:true}).click(); };
  const dialog=frame.getByRole('dialog',{name:'Agent settings'}), key=dialog.getByRole('textbox',{name:'API key',exact:true});
  await open(); await expect(dialog.getByRole('checkbox',{name:'Enable Rho'})).toBeVisible();
  await dialog.getByRole('checkbox',{name:'Enable Rho'}).check();
  await dialog.getByRole('combobox',{name:'API format'}).selectOption('openai_completions');
  await dialog.getByRole('textbox',{name:'Base URL'}).fill('https://fixture.invalid/v1');
  await dialog.getByRole('textbox',{name:'Model ID'}).fill('Fixture model · 中文 Ω');
  await key.fill('SYNTHETIC-KEY-NOT-A-CREDENTIAL');
  await expect(dialog.getByRole('button',{name:'Test connection',exact:true})).toBeDisabled();
  await page.evaluate(()=>window.fixture.loseSettingsReply('agent.model.key.store'));
  await dialog.getByRole('button',{name:'Save',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('Lost settings reply'); await expect(key).toHaveValue('');
  let snapshot=await page.evaluate(()=>window.fixture.snapshot()); const count=snapshot.calls.filter(c=>c.capability?.id.startsWith('agent.model.')).length;
  assert.equal(JSON.stringify(snapshot).includes('SYNTHETIC-KEY-NOT-A-CREDENTIAL'),false);
  await page.evaluate(()=>window.fixture.reload()); await open();
  await expect(dialog.getByRole('textbox',{name:'Model ID'})).toHaveValue('Fixture model · 中文 Ω');
  await dialog.getByRole('button',{name:'Check original request',exact:true}).click();
  await expect(dialog.locator('#settings-recovery')).toBeHidden();
  snapshot=await page.evaluate(()=>window.fixture.snapshot()); assert.equal(snapshot.calls.filter(c=>c.capability?.id.startsWith('agent.model.')).length,count);
  await page.evaluate(()=>window.fixture.loseSettingsReply('agent.model.configure'));
  await dialog.getByRole('button',{name:'Save',exact:true}).click(); await expect(dialog.getByRole('alert')).toContainText('Lost settings reply');
  await page.evaluate(()=>window.fixture.reload()); await open();
  await dialog.getByRole('button',{name:'Check original request',exact:true}).click(); await expect(dialog.locator('#settings-recovery')).toBeHidden();
  await expect(dialog.getByRole('button',{name:'Test connection',exact:true})).toBeEnabled();
  await dialog.getByRole('button',{name:'Test connection',exact:true}).click();
  await expect(dialog.locator('#settings-tests')).toContainText('Connection · succeeded');
  await dialog.locator('summary').filter({hasText:'Credential source'}).click();
  await dialog.getByRole('combobox',{name:'Credential source'}).selectOption('environment');
  await dialog.getByRole('textbox',{name:'Environment variable name'}).fill('RHO_REPLACEMENT_KEY');
  await expect(dialog.locator('#settings-environment-status')).toContainText('Set this variable');
  await expect(dialog.getByRole('button',{name:'Test connection',exact:true})).toBeDisabled();
  await dialog.getByRole('button',{name:'Reload saved settings',exact:true}).click();
  await expect(dialog.getByRole('combobox',{name:'Credential source'})).toHaveValue('local_file');
  await dialog.locator('summary').filter({hasText:'Credential source'}).click();
  for(const width of [960,440,320,220]){
    await page.setViewportSize({width,height:820}); await dialog.evaluate(node=>node.scrollTop=0);
    assert.equal(await dialog.evaluate(node=>node.scrollWidth>node.clientWidth),false,`Settings have no horizontal overflow at ${width}`);
    await page.screenshot({path:path.join(output,`agent-settings-${width}.png`)});
    if(width===220){await dialog.locator('#settings-tests').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'agent-settings-220-bottom.png')});}
  }
  await page.setViewportSize({width:440,height:820});
  await page.evaluate(()=>window.fixture.loseSettingsReply('agent.model.key.remove'));
  await dialog.getByRole('button',{name:'Remove API key',exact:true}).click(); await expect(dialog.getByRole('alert')).toContainText('Lost settings reply');
  await page.evaluate(()=>window.fixture.reload()); await open(); await dialog.getByRole('button',{name:'Check original request',exact:true}).click();
  await expect(dialog.locator('#settings-recovery')).toBeHidden(); await expect(dialog.getByRole('button',{name:'Test connection',exact:true})).toBeDisabled();
  snapshot=await page.evaluate(()=>window.fixture.snapshot());
  assert.equal(snapshot.records.filter(r=>r.operation.capability.id==='agent.model.configure').length,1);
  assert.equal(snapshot.records.filter(r=>r.operation.capability.id==='agent.model.test').length,1);
  assert.equal(snapshot.calls.filter(c=>c.capability?.id==='agent.model.key.remove').length,1);
  assert.equal(JSON.stringify(snapshot).includes('SYNTHETIC-KEY-NOT-A-CREDENTIAL'),false);
  await dialog.getByRole('button',{name:'Close settings'}).click();
  await expect(frame.getByRole('textbox',{name:'Agent message'})).toHaveValue('Keep this next draft after reopening');
  await frame.getByRole('button',{name:'Task actions',exact:true}).click(); await frame.getByRole('button',{name:'Rename',exact:true}).click();
  await frame.getByRole('textbox',{name:'Task title',exact:true}).fill('Saved title · 中文 Ω');
  await frame.getByRole('button',{name:'Save title',exact:true}).click();
  await expect(frame.getByRole('combobox',{name:'Select task'}).locator('option:checked')).toHaveText('Saved title · 中文 Ω');
}
