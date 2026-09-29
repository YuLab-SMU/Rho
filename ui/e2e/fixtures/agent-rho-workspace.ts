/** Actual Agent/Editor owners and Rig, with a local model protocol peer. */
import { expect, type Page, type FrameLocator, type TestInfo } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function startRhoModelPeer() {
  const bodies: unknown[] = [], errors: string[] = [];
  let release = () => {};
  const firstReply = new Promise<void>(done => { release = done; });
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') throw Error('Unexpected model route');
      if (request.headers.authorization !== 'Bearer disposable-rho-model-key') throw Error('Model credential was not delivered');
      let input = ''; for await (const bytes of request) { input += bytes; if (Buffer.byteLength(input) > 262144) throw Error('Oversized model input'); }
      const body = JSON.parse(input); if (!body.stream) throw Error('Expected production streaming request');
      bodies.push(body); const index = bodies.length;
      if (index === 1) await firstReply;
      const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({id:`rho-browser-${index}`,object:'chat.completion.chunk',created:1,model:'rho-browser-fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`;
      response.writeHead(200, {'Content-Type':'text/event-stream'});
      response.end(chunk({role:'assistant'},null) + chunk({content:`Rho original answer ${index} · 中文 Ω`},null) + chunk({},'stop') + 'data: [DONE]\n\n');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error)); response.writeHead(500).end('Fixture rejected the model request');
    }
  });
  await new Promise<void>(done => server.listen(0,'127.0.0.1',done));
  return { bodies, errors, release, url:`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    async close() { release(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); },
  };
}

type Peer = Awaited<ReturnType<typeof startRhoModelPeer>>;
type Query = (id: string, args: unknown) => Promise<any>;
export interface RhoRetainedInput { task: string; original: any; continued: any; draft: string; requests: number; }

export async function exerciseRhoInput(page: Page, frame: FrameLocator, info: TestInfo, peer: Peer,
  query: Query, sourceText: string, changeSource: () => Promise<void>): Promise<RhoRetainedInput> {
  const composer=frame.getByRole('textbox',{name:'Agent message',exact:true});
  await frame.getByRole('button',{name:'New task',exact:true}).click();
  await frame.getByRole('button',{name:'Rho',exact:true}).click();
  await expect(composer).toBeEnabled();
  const selected=await frame.getByLabel('Select task',{exact:true}).inputValue(); expect(selected).toMatch(/^rho:/); const task=selected.slice(4);
  const conversation=()=>query('agent.model.conversation',{conversation_id:task});
  const history=()=>query('agent.model.history',{conversation_id:task,before:null,limit:5});
  const run=(id:string)=>query('agent.model.run.get',{run_id:id});
  await frame.getByRole('button',{name:'Task actions',exact:true}).click();await frame.getByRole('button',{name:'Settings',exact:true}).click();
  const settings=frame.getByRole('dialog',{name:'Agent settings'});
  await settings.getByRole('checkbox',{name:'Enable Rho'}).check();
  await settings.getByRole('combobox',{name:'API format'}).selectOption('openai_completions');
  await settings.getByRole('textbox',{name:'Base URL'}).fill(peer.url);
  await settings.getByRole('textbox',{name:'Model ID'}).fill('rho-browser-fixture');
  await settings.getByRole('textbox',{name:'API key',exact:true}).fill('disposable-rho-model-key');
  await settings.getByRole('button',{name:'Save',exact:true}).click();
  await expect(settings.locator('#settings-key-status')).toContainText('Saved on this computer');
  await settings.getByRole('button',{name:'Close settings'}).click();expect(peer.bodies).toHaveLength(0);
  await frame.getByRole('button',{name:'Choose context',exact:true}).click();
  const picker=frame.getByRole('dialog',{name:'Choose context'});
  await picker.getByRole('button',{name:/上下文 Ω.R/}).click();
  await expect(picker.locator('#context-preview')).toHaveText(sourceText.trim());
  await picker.getByRole('button',{name:'Add to draft',exact:true}).click();
  const prompt='Explain this analysis from the selected Editor input · 中文 Ω';
  await composer.fill(prompt);await expect.poll(async()=>(await conversation()).draft).toBe(prompt);
  let sends=0, sourceReads=0;
  const routePattern='**/api/plugin-view';
  const routeHandler: Parameters<Page['route']>[1] = async route => {
    const body=route.request().postDataJSON()?.message?.body;
    if(body?.type==='query'&&body.capability.id==='editor.context.preview')sourceReads++;
    if(body?.type==='invoke'&&body.capability.id==='agent.model.run'){
      sends++;if(sends===1||sends===3){await route.fetch();await route.abort();return;}
    }
    await route.continue();
  };
  await page.route(routePattern,routeHandler);
  await frame.getByRole('button',{name:'Send message',exact:true}).click();
  await expect.poll(()=>peer.bodies.length,{timeout:45000}).toBe(1);
  expect(peer.errors).toEqual([]);expect(JSON.stringify(peer.bodies[0])).toContain(sourceText.trim());
  await expect.poll(async()=>(await history()).runs.length).toBe(1);
  const originalId=(await history()).runs[0].run_id;
  const captured=(await run(originalId)).context;
  expect(captured.sources[0].text.trim()).toBe(sourceText.trim());
  await changeSource();
  await expect(composer).toHaveValue('');
  const followup='Explain the earlier answer without changing the analysis · 后续输入';
  await composer.fill(followup);await expect.poll(async()=>(await conversation()).draft).toBe(followup);
  await page.reload();await expect(composer).toHaveValue(followup);
  await frame.locator('#inspect-original').click();await expect(frame.locator('#recovery')).toBeHidden();
  await frame.getByRole('button',{name:'Sent context',exact:true}).click();
  await expect(picker.locator('#context-captures')).toContainText(sourceText.trim());
  await picker.getByRole('button',{name:'Close context'}).click();
  expect(sourceReads).toBe(0);expect(sends).toBe(1);expect(peer.bodies).toHaveLength(1);
  peer.release();
  await expect.poll(async()=>(await run(originalId)).state).toBe('completed');
  await expect(frame.getByRole('log')).toContainText('Rho original answer 1');
  await frame.getByRole('button',{name:'Send message',exact:true}).click();
  await expect.poll(()=>peer.bodies.length).toBe(2);
  await expect(frame.getByRole('log')).toContainText('Rho original answer 2');
  expect(JSON.stringify(peer.bodies[1])).toContain(prompt);expect(JSON.stringify(peer.bodies[1])).toContain('Rho original answer 1');
  await frame.getByRole('button',{name:'Check tool outcomes',exact:true}).first().click();
  await expect.poll(async()=>(await run(originalId)).recovery?.unresolved_mutations).toBe(0);
  await composer.fill('Continue the checked original task · 续接');await expect(frame.locator('#draft-status')).toHaveText('Draft saved');
  await frame.getByRole('button',{name:'Continue task',exact:true}).click();
  const draft='Keep this Rho draft across the Host restart';
  await composer.fill(draft);await expect.poll(async()=>(await conversation()).draft).toBe(draft);
  await page.reload();await frame.locator('#inspect-original').click();await expect(frame.locator('#recovery')).toBeHidden();
  await expect.poll(()=>peer.bodies.length).toBe(3);await expect(frame.getByRole('log')).toContainText('Rho original answer 3');
  await expect(composer).toHaveValue(draft);
  await expect.poll(async()=>(await run((await history()).runs[0].run_id)).state).toBe('completed');
  const continued=await run((await history()).runs[0].run_id), original=await run(originalId);
  expect(continued.request.continuation).toEqual({run_id:originalId,recovery_digest:original.recovery.digest});
  expect(continued.context.history.prior_sources[0]).toEqual(captured.sources[0]);
  expect(JSON.stringify(peer.bodies[2])).toContain(sourceText.trim());expect(JSON.stringify(peer.bodies[2])).toContain('Confirmed earlier actions must not be executed again');
  await frame.getByRole('button',{name:'Sent context',exact:true}).last().click();
  await expect(picker.locator('#context-captures')).toContainText('Continued task input');
  await expect(picker.locator('#context-captures')).toContainText(sourceText.trim());
  for(const width of [1440,390,220]){
    await page.setViewportSize({width,height:900});
    expect(await picker.evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(false);
    await page.screenshot({path:info.outputPath(`agent-rho-continued-${width}.png`)});
  }
  await picker.getByRole('button',{name:'Close context'}).click();await page.setViewportSize({width:1440,height:900});
  expect(sourceReads).toBe(0);expect(sends).toBe(3);expect(peer.errors).toEqual([]);
  expect((await history()).runs).toHaveLength(3);expect((await run(originalId)).context).toEqual(captured);
  await page.unroute(routePattern,routeHandler);
  return {task,original,continued,draft,requests:peer.bodies.length};
}

export async function inspectRhoAfterRestart(frame: FrameLocator, query: Query, peer: Peer, retained: RhoRetainedInput) {
  await frame.getByLabel('Select task',{exact:true}).selectOption(`rho:${retained.task}`);
  await expect(frame.getByRole('textbox',{name:'Agent message',exact:true})).toHaveValue(retained.draft);
  expect(await query('agent.model.run.get',{run_id:retained.original.run_id})).toEqual(retained.original);
  expect(await query('agent.model.run.get',{run_id:retained.continued.run_id})).toEqual(retained.continued);
  await frame.getByRole('button',{name:'Sent context',exact:true}).last().click();
  const picker=frame.getByRole('dialog',{name:'Choose context'});
  await expect(picker.locator('#context-captures')).toContainText('Continued task input');
  await expect(picker.locator('#context-captures')).toContainText(retained.original.context.sources[0].text.trim());
  await picker.getByRole('button',{name:'Close context'}).click();
  expect(peer.bodies).toHaveLength(retained.requests);expect(peer.errors).toEqual([]);
}
