/** Ordinary handoff draft/receipt across the same real Host restart. */
import { expect, type Page, type FrameLocator, type TestInfo } from '@playwright/test';

type Query = (id: string, args: unknown) => Promise<any>;
export interface RetainedHandoff {
  request: string; receipt: any; targetDraft: string; calls: () => number; detach: () => Promise<void>;
}

export async function prepareRetainedHandoff(page: Page, frame: FrameLocator, info: TestInfo,
  query: Query, nativeTask: string, rhoTask: string, existingDraft: string): Promise<RetainedHandoff> {
  await frame.getByLabel('Select task',{exact:true}).selectOption(`native:${nativeTask}`);
  await frame.getByRole('button',{name:'Task actions',exact:true}).click();
  await frame.getByRole('button',{name:'Prepare handoff',exact:true}).click();
  const panel=frame.getByRole('region',{name:'Prepare handoff'});
  await expect(panel.getByRole('combobox',{name:'Send context to'})).toBeEnabled();
  await panel.getByRole('combobox',{name:'Send context to'}).selectOption(`rho:${rhoTask}`);
  await expect(panel.locator('#handoff-existing-text')).toHaveText(existingDraft);
  // The Editor changed after the original Send. Explicitly omit those original
  // references from this reviewed handoff; do not silently retarget them.
  const removals=panel.getByRole('button',{name:/^Remove .* from handoff$/});
  while(await removals.count()) { const count=await removals.count(); await removals.first().click(); await expect(removals).toHaveCount(count-1); }
  const body='Goal:\nContinue from the original recorded analysis.\n\nConfirmed:\nThe user reviewed the original result.\n\nNext:\nInspect the saved records before choosing another operation.';
  await panel.getByRole('textbox',{name:'Handoff draft'}).fill(body);
  let count=0, request='';
  const pattern='**/api/plugin-view';
  const handler: Parameters<Page['route']>[1] = async route => {
    const call=route.request().postDataJSON()?.message?.body;
    if(call?.type==='invoke'&&call.capability.id==='agent.handoff.append') {
      count++;request ||= call.arguments.arguments.request_id;
      if(count===1){await route.fetch();await route.abort();return;}
    }
    await route.continue();
  };
  await page.route(pattern,handler);
  await panel.getByRole('button',{name:'Add to draft',exact:true}).click();
  await expect(panel.getByRole('button',{name:'Check receipt',exact:true})).toBeEnabled();
  await expect.poll(()=>count).toBe(1);expect(request).toBeTruthy();
  await expect.poll(async()=>{try{return (await query('agent.handoff.receipt',{request_id:request}))?.request_id??null;}catch{return null;}}).toBe(request);
  const receipt=await query('agent.handoff.receipt',{request_id:request});
  expect(receipt).toMatchObject({request_id:request,source:{kind:'native',task_id:nativeTask},target:{kind:'rho',conversation_id:rhoTask}});
  const targetDraft=existingDraft+'\n\n'+body;
  expect((await query('agent.model.conversation',{conversation_id:rhoTask})).draft).toBe(targetDraft);
  await page.screenshot({path:info.outputPath('agent-handoff-lost-reply.png')});
  // Closing the editor retains its unknown original request in saved view state.
  await panel.getByRole('button',{name:'Back to task',exact:true}).click();await expect(panel).toBeHidden();
  return {request,receipt,targetDraft,calls:()=>count,detach:()=>page.unroute(pattern,handler)};
}

export async function inspectRetainedHandoff(page: Page, frame: FrameLocator, info: TestInfo,
  query: Query, nativeTask: string, retained: RetainedHandoff) {
  await frame.getByLabel('Select task',{exact:true}).selectOption(`native:${nativeTask}`);
  await frame.getByRole('button',{name:'Task actions',exact:true}).click();
  await frame.getByRole('button',{name:'Prepare handoff',exact:true}).click();
  const panel=frame.getByRole('region',{name:'Prepare handoff'});
  await expect(panel.getByRole('button',{name:'Check receipt',exact:true})).toBeEnabled();
  await panel.getByRole('button',{name:'Check receipt',exact:true}).click();
  await expect(panel.locator('#handoff-confirmed')).toBeVisible();
  expect(await query('agent.handoff.receipt',{request_id:retained.request})).toEqual(retained.receipt);
  expect((await query('agent.model.conversation',{conversation_id:retained.receipt.target.conversation_id})).draft).toBe(retained.targetDraft);
  expect(retained.calls()).toBe(1);
  await page.screenshot({path:info.outputPath('agent-handoff-after-host-restart.png')});
  await panel.getByRole('button',{name:'Done',exact:true}).click();await expect(panel).toBeHidden();
  await retained.detach();
}
