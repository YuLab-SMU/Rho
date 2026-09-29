import assert from 'node:assert/strict';
import path from 'node:path';
export async function testAgentStudioRenderer(browser, url, expect, output) {
  const page=await browser.newPage({viewport:{width:960,height:820}});
  try {
    await page.goto(url);const frame=page.frameLocator('iframe'),input=frame.getByRole('textbox',{name:'Agent message',exact:true});
    await expect(input).toBeEnabled();
    const revision='sha256:'+'c'.repeat(64),request={request_id:crypto.randomUUID(),branch:'chosen-branch',revision,title:'Studio · Report controls 中文 Ω',text:`Plugin Studio request\nBranch: Report controls 中文 Ω\nCheckpoint: ${revision}\n\nKeep the selected plot visible while changing the report controls.`};
    const tools=[{name:'create_checkpoint',target:{type:'host',project:'project',capability:{id:'plugins.checkpoint',version:1},fixed_arguments:{branch:'chosen-branch',expected_head:revision}}}];
    await page.evaluate(config=>window.fixture.studioRequest(config),{studio_request:request,tools});
    await page.evaluate(()=>window.fixture.reload());await expect(input).toBeEnabled();
    const before=(await page.evaluate(()=>window.fixture.snapshot())).calls.length;
    await frame.locator('#studio-request summary').click();
    await expect(frame.locator('#studio-request-text')).toContainText('中文 Ω');
    for(const width of [960,440,220]) {
      await page.setViewportSize({width,height:820});await page.screenshot({path:path.join(output,`agent-studio-${width}.png`)});
      assert.equal(await frame.locator('body').evaluate(node=>node.scrollWidth>innerWidth),false);
    }
    await page.setViewportSize({width:440,height:820});
    await frame.getByRole('button',{name:'Add Studio request to draft',exact:true}).click();
    await expect(input).toHaveValue(request.text);await expect(frame.getByRole('button',{name:'Add Studio request to draft',exact:true})).toBeDisabled();
    await expect.poll(async()=> (await page.evaluate(()=>window.fixture.snapshot())).view.state.studioRequestApplied?.request).toBe(request.request_id);
    const after=(await page.evaluate(()=>window.fixture.snapshot())).calls.slice(before);
    assert.equal(after.filter(call=>['send','create'].includes(call.arguments?.arguments?.command?.kind)).length,0);
    await page.evaluate(()=>window.fixture.reload());await expect(input).toHaveValue(request.text);
    await frame.locator('#studio-request summary').click();
    await expect(frame.getByRole('button',{name:'Add Studio request to draft',exact:true})).toBeDisabled();
    await frame.getByRole('button',{name:'Tools',exact:true}).click();await expect(frame.getByRole('checkbox',{name:'create_checkpoint',exact:true})).toBeChecked();
    console.log('Agent Studio request renderer: scoped tools, Unicode request preview, explicit one-time draft insertion and iframe reload pass; no Send/create.');
  } finally {await page.close();}
}
