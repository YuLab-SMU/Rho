import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let directory:string, url:string, host:ReturnType<typeof spawn>;
test.beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),'rho-studio-'));
  await mkdir(join(directory,'中文项目'));
  host=spawn(resolve('../target/debug/rho'),['--database',join(directory,'next.sqlite'),'--project',join(directory,'中文项目'),'workbench'],{stdio:['ignore','pipe','pipe']});
  url=await new Promise<string>((resolve,reject)=>{
    let output='',errors='';
    const timeout=setTimeout(()=>reject(new Error(`Host startup timed out: ${errors}`)),40000);
    host.stderr!.on('data',b=>errors+=b);
    host.stdout!.on('data',b=>{output+=b;const match=output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-z0-9]+/);if(match){clearTimeout(timeout);resolve(match[0]);}});
    host.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Host exited ${code}: ${errors}`));});
  });
});
test.afterAll(async()=>{
  if(host?.exitCode===null){host.kill('SIGINT');await new Promise<void>(resolve=>host.once('exit',()=>resolve()));}
  if(directory)await rm(directory,{recursive:true,force:true});
});
test('real R Console, settings and docking shell',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(url);
  await expect(page.getByText('中文项目',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'执行',exact:true})).toBeDisabled();
  await page.getByRole('textbox',{name:'R Console 输入'}).fill('cat("Studio R ready\\n")');
  await page.getByRole('button',{name:'执行',exact:true}).click();
  await expect(page.getByText('Studio R ready',{exact:true})).toBeVisible();
  await expect(page.getByText('succeeded',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('jsonlite 可用 · rlang 可用 · Ark 可用')).toBeVisible();
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.screenshot({path:'../target/studio-browser/m1-shell.png'});
  expect(errors).toEqual([]);
});
