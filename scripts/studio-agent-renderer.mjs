import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
export async function testStudioAgentRenderer(root,plugin) {
  const {chromium,expect}=await import(pathToFileURL(path.join(root,'ui/node_modules/@playwright/test/index.mjs')));
  const output=path.join(root,'target/plugin-refactor/studio-agent-renderer');fs.mkdirSync(output,{recursive:true});
  const html=fs.readFileSync(path.join(plugin,'dist/src/index.html'),'utf8').replace('href="style.css"','href="/dist/src/style.css"').replace('src="main.js"','src="/fixture.js"');
  const server=http.createServer((req,res)=>{
    if(req.url==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);return;}
    const file=req.url==='/fixture.js'?path.join(root,'scripts/fixtures/studio-agent-container.js'):path.resolve(plugin,'.'+decodeURIComponent(req.url.split('?')[0]));
    if(req.url!=='/fixture.js'&&!file.startsWith(plugin+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser,page;
  try {
    browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:900}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByRole('button',{name:'Ask Agent',exact:true}).click();
    await expect(page.getByLabel('Requested change')).toBeEnabled();
    await page.getByLabel('Requested change').fill('Make the report controls clearer for 中文 Ω results. Preserve the original source checkpoint.');
    await page.getByLabel('Agent instance',{exact:true}).selectOption('agent');
    for(const width of [1440,960,390,220]) {
      await page.setViewportSize({width,height:900});await page.screenshot({path:path.join(output,`studio-agent-${width}.png`)});
      assert.equal(await page.locator('#agent-dialog').evaluate(n=>n.scrollWidth>n.clientWidth),false);
    }
    await page.setViewportSize({width:390,height:900});await page.evaluate(()=>window.fixture.lose());
    await page.getByRole('button',{name:'Open Agent draft',exact:true}).click();
    await expect(page.locator('#agent-pending')).toBeVisible();await page.screenshot({path:path.join(output,'studio-agent-pending.png')});
    await page.evaluate(()=>window.fixture.reopen());
    await page.getByRole('button',{name:'Inspect original Agent view',exact:true}).click();
    await expect(page.locator('#agent-opened')).toContainText('Agent view opened');
    assert.equal((await page.evaluate(()=>window.fixture.snapshot())).calls.length,1);
    await page.screenshot({path:path.join(output,'studio-agent-recovered.png')});assert.deepEqual(errors,[]);
    console.log('Studio Agent isolated panel: normal/constrained layouts, Unicode input, original-view reply loss and explicit recovery passed. Synthetic public replies only.');
  } catch(error){if(page)await page.screenshot({path:path.join(output,'failure.png')});throw error;}
  finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
}
