import assert from 'node:assert/strict';
import path from 'node:path';
export async function testAgentComponentRenderer(browser, url, expect, output) {
  for (const kind of ['native','rho']) {
    const page=await browser.newPage({viewport:{width:960,height:820}});
    try {
      await page.goto(url);const frame=page.frameLocator('iframe'),input=frame.getByRole('textbox',{name:'Agent message',exact:true});
      await expect(input).toBeEnabled();const request=await page.evaluate(()=>window.fixture.componentRequest());
      await page.evaluate(()=>window.fixture.reload());await expect(input).toBeEnabled();
      if(kind==='rho'){await frame.getByRole('button',{name:'New task',exact:true}).click();await frame.getByRole('button',{name:'Rho',exact:true}).click();await expect(frame.getByLabel('Select task',{exact:true})).toHaveValue(/^rho:/);}
      await input.fill('My existing question 中文 Ω');await expect(frame.locator('#draft-status')).toHaveText('Draft saved');
      const before=await page.evaluate(()=>window.fixture.snapshot());
      await frame.locator('#component-request summary').click();
      await frame.getByRole('button',{name:'Preview Editor selection 中文 Ω',exact:true}).click();
      const preview=frame.getByRole('dialog',{name:'Choose context'});await expect(preview.locator('#context-preview')).toContainText('selected_value <- 42');
      await preview.getByRole('button',{name:'Close context'}).click();
      for(const width of [960,440,220]){
        await page.setViewportSize({width,height:820});await expect.poll(()=>frame.locator('body').evaluate(()=>innerWidth)).toBe(width);
        assert.equal(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        await frame.locator('#component-request').screenshot({path:path.join(output,`agent-component-${kind}-${width}.png`)});
      }
      await page.evaluate(()=>window.fixture.contextFault('changed'));
      await frame.getByRole('button',{name:'Add context to draft',exact:true}).click();await expect(frame.locator('#error')).toContainText('Source changed');
      await expect(input).toHaveValue('My existing question 中文 Ω');assert.equal((await page.evaluate(()=>window.fixture.snapshot())).view.state.componentRequestApplied,undefined);
      await page.evaluate(()=>window.fixture.contextFault(null));
      if(kind==='rho')await page.evaluate(()=>window.fixture.loseRhoReply('agent.model.draft'));
      await frame.getByRole('button',{name:'Add context to draft',exact:true}).click();
      if(kind==='rho'){
        await expect(frame.locator('#error')).toContainText('Lost original Rho reply');await page.evaluate(()=>window.fixture.reload());await frame.locator('#inspect-original').click();
        await frame.locator('#component-request summary').click();
      }
      await expect(input).toHaveValue('My existing question 中文 Ω');await expect(frame.locator('#selected-context')).toContainText('Editor selection 中文 Ω');
      await expect(frame.getByRole('button',{name:'Add context to draft',exact:true})).toBeDisabled();
      const after=await page.evaluate(()=>window.fixture.snapshot());assert.equal(after.view.state.componentRequestApplied.request,request.request_id);
      assert.deepEqual(after.view.state.tools,before.view.state.tools);assert.equal(after.view.state.rho?.tool,before.view.state.rho?.tool);
      assert.ok(after.calls.slice(before.calls.length).every(call=>call.capability?.id==='agent.model.draft'||call.arguments?.arguments?.command?.kind==='save_draft'));
      await page.evaluate(()=>window.fixture.reload());await expect(input).toHaveValue('My existing question 中文 Ω');
      await frame.locator('#component-request summary').click();await expect(frame.getByRole('button',{name:'Add context to draft',exact:true})).toBeDisabled();
    } finally {await page.close();}
  }
  console.log('Component input receiver: Native/Rho preview, stale source refusal, preserved drafts/tools, lost receipt and one-time insertion survive reload; synthetic peers.');
}
