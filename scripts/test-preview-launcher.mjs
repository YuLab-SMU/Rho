// Explicit local app acceptance in an owned, retained state directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from '../ui/node_modules/playwright/index.mjs';
const [app,reportFile,retainedState]=process.argv.slice(2);assert.ok(app&&reportFile);
const resources=path.resolve(app,'Contents/Resources'),state=fs.realpathSync(retainedState??fs.mkdtempSync(path.join(os.tmpdir(),'rho-preview-launcher-')));
const report={app:path.resolve(app),state,status:'running',events:[],checks:[]};const save=()=>fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');save();
let service,exit,browser,page;
const deadline=(p,ms,label)=>Promise.race([p,new Promise((_,no)=>{const t=setTimeout(()=>no(Error(label+' timed out')),ms);t.unref();})]);
async function start(){
 service=spawn(path.join(resources,'node'),[path.join(resources,'service.mjs')],{env:{...process.env,RHO_PREVIEW_STATE:state},stdio:['pipe','pipe','pipe']});
 exit=new Promise(resolve=>service.once('exit',(code,signal)=>resolve({code,signal})));
 service.stderr.on('data',bytes=>fs.appendFileSync(path.join(state,'service-stderr.log'),bytes));
 let buffer='';
 return deadline(new Promise((resolve,reject)=>{service.on('error',reject);service.stdout.on('data',bytes=>{buffer+=bytes;let line;while((line=buffer.indexOf('\n'))>=0){const event=JSON.parse(buffer.slice(0,line));buffer=buffer.slice(line+1);const {url,...safe}=event;report.events.push(safe);save();if(event.type==='ready')resolve(event);if(event.type==='error'||event.type==='blocked')reject(Error(event.message));}});exit.then(value=>reject(Error('Launcher exited before ready: '+JSON.stringify(value))));}),360000,'App preparation');
}
async function stop(){if(service?.exitCode===null){service.stdin.write('quit\n');const ended=await deadline(exit,60000,'App quit');assert.equal(ended.code,0);}}
async function frameWith(selector){for(let i=0;i<200;i++){for(const frame of page.frames())if(await frame.locator(selector).count() && await frame.locator(selector).first().isVisible())return frame;await new Promise(r=>setTimeout(r,100));}throw Error('Missing view '+selector);}
try{
 const ready=await start();report.checks.push('First launch prepares scientific Demo');save();
 browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1720,height:1080}});await page.goto(ready.url);
 const editor=await frameWith('#save-run');await editor.getByLabel('Code Editor',{exact:true}).filter({hasText:'source('}).waitFor();
 const consoleUI=await frameWith('#start');const startR=consoleUI.getByRole('button',{name:'Start R',exact:true});if(await startR.isVisible())await startR.click();
 await consoleUI.locator('#status').filter({hasText:'Ready'}).waitFor({timeout:60000});
 await editor.getByRole('button',{name:'Save and Run',exact:true}).click();
 await consoleUI.locator('#transcript').filter({hasText:'Rho demo complete'}).waitFor({timeout:120000});
 await editor.locator('#code-status').filter({hasText:'R run · succeeded'}).waitFor({timeout:30000});
 const objects=await frameWith('[aria-label="Filter Objects"]');await objects.getByText('latest_year',{exact:true}).waitFor({timeout:30000});
 assert.ok((await page.getByRole('tab').count())>=10);await page.screenshot({path:path.join(state,'demo.png')});
 report.checks.push('Bundled Ark starts R; Demo finishes; Objects populates');save();
 await page.getByRole('tab',{name:'Packages',exact:true}).click();
 const packages=await frameWith('[aria-label="Search Packages"]');
 await packages.getByRole('textbox',{name:'Search Packages',exact:true}).fill('jsonlite');
 await packages.locator('.package-row').filter({hasText:'jsonlite'}).first().waitFor({timeout:60000});
 await page.screenshot({path:path.join(state,'packages.png')});report.checks.push('Packages reads installed jsonlite from the current R session');save();
 await page.getByRole('tab',{name:'Files',exact:true}).click();
 await page.reload();const restored=await frameWith('#save-run');await restored.getByLabel('Code Editor',{exact:true}).filter({hasText:'source('}).waitFor();
 report.checks.push('Browser reload retains runnable Editor');
 await browser.close();browser=null;await stop();
 const reopened=await start();assert.equal(reopened.reused,false);report.checks.push('Graceful quit and saved workspace restart');
 report.status='passed';save();console.log(JSON.stringify({report:reportFile,state,checks:report.checks}));
}catch(error){report.status='failed';report.error=error.stack;if(page&&!page.isClosed())await page.screenshot({path:path.join(state,'failure.png')}).catch(()=>{});save();throw error;}
finally{if(browser)await browser.close();await stop();}
