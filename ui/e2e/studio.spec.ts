import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
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
  await expect(page.locator('.run[data-status=succeeded]')).toBeVisible();
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('jsonlite 可用 · rlang 可用 · Ark 可用')).toBeVisible();
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.screenshot({path:'../target/studio-browser/m1-shell.png'});
  expect(errors).toEqual([]);
});


test('incremental output precedes completion and plots keep their identity',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);
  const input=page.getByRole('textbox',{name:'R Console 输入'});
  await input.fill('cat("first-live\\n"); Sys.sleep(3); cat("second-live\\n"); plot(1:4)');
  await page.getByRole('button',{name:'执行',exact:true}).click();
  await expect(page.locator('.stream-output').getByText('first-live',{exact:true})).toBeVisible({timeout:2500});
  await expect(page.locator('.run[data-status=running]')).toBeVisible();
  await expect(page.locator('.stream-output').getByText('second-live',{exact:true})).toBeVisible();
  await expect(page.locator('.media-card img').last()).toBeVisible();
  await page.locator('.media-card').last().click();
  await expect(page.locator('.plot-image img')).toBeVisible();
  const original=await page.locator('.plot-image img').getAttribute('src');
  await input.fill('plot(4:1); cat("before failure\\n"); stop("expected studio failure")');
  await page.getByRole('button',{name:'执行',exact:true}).click();
  await expect(page.locator('.run[data-status=failed]')).toBeVisible();
  await expect(page.locator('.stream-output').getByText('before failure',{exact:true})).toBeVisible();
  await expect(page.locator('.media-card')).toHaveCount(2);
  await expect(page.locator('.plot-image img')).toHaveAttribute('src',original!);
  await page.getByRole('button',{name:'下一张图'}).click();
  await expect(page.locator('.plot-image img')).not.toHaveAttribute('src',original!);
  expect(errors).toEqual([]);
});


test('create a Chinese R file, save-run, inspect objects and edit-run again',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);
  await page.getByRole('button',{name:'＋ 新建 R 文件',exact:true}).click();
  const editor=page.locator('.document-panel .cm-content');
  await editor.fill('studio_data <- data.frame(组别 = c("甲", "乙"), value = c(1, 2))\ncat("saved file ran\\n")\nplot(studio_data$value)\n');
  await page.getByRole('button',{name:'运行文件',exact:true}).click();
  await page.getByLabel('文件路径',{exact:true}).fill('分析脚本.R');
  await page.getByRole('button',{name:'保存并运行',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.stream-output').getByText('saved file ran',{exact:true})).toBeVisible();
  await expect(page.locator('.save-status')).toHaveText('✓ 已保存');
  await expect(page.getByRole('button').filter({has:page.locator('code', {hasText:'studio_data'})})).toBeVisible();
  await page.getByRole('button').filter({has:page.locator('code',{hasText:'studio_data'})}).click();
  await expect(page.locator('.object-viewer table')).toContainText('甲');
  await editor.fill('studio_data$value <- c(3, 4)\ncat("modified file ran\\n")\nplot(studio_data$value)\n');
  await editor.press('Meta+Shift+Enter');
  await expect(page.locator('.stream-output').getByText('modified file ran',{exact:true})).toBeVisible();
  await expect(page.locator('.save-status')).toHaveText('✓ 已保存');
  await page.screenshot({path:'../target/studio-browser/m3-loop.png'});
  expect(errors).toEqual([]);
});


test('UTF-8 pages, BOM/CRLF saves, disk conflicts and draft refresh',async({page})=>{
  const fixture='\uFEFF# '+ '中'.repeat(23000)+'\r\nx <- 1\r\n';
  const file=join(directory,'中文项目','跨页 文件.R');await writeFile(file,fixture);
  await page.goto(url);
  await page.getByRole('button',{name:'项目文件',exact:true}).click();
  await page.getByRole('textbox',{name:'打开相对文件路径'}).fill('跨页 文件.R');
  await page.getByRole('button',{name:'打开',exact:true}).click();
  const editor=page.locator('.document-panel:visible .cm-content');
  await expect(editor).toContainText('x <- 1');
  await editor.press('Meta+End');await editor.press('End');await editor.press('Enter');await editor.press('x');
  await editor.press('Meta+s');
  await expect(page.locator('.document-panel:visible .save-status')).toHaveText('✓ 已保存');
  const saved=await readFile(file,'utf8');expect(saved.startsWith('\uFEFF')).toBe(true);expect(saved.replaceAll('\r\n','').includes('\n')).toBe(false);
  await editor.fill('cat("must not run after conflict\\n")');
  await writeFile(file,'# external disk edit\r\n');
  let runs=0;page.on('request',request=>{if(request.url().endsWith('/api/host')){const data=request.postDataJSON();if(data?.frame?.request?.method==='invoke'&&data.frame.request.params.capability.id==='workspace.run_r')runs++;}});
  await page.getByRole('button',{name:'运行文件',exact:true}).click();
  await expect(page.locator('.document-panel:visible [role=alert]')).toContainText(/precondition failed|patch does not apply/);
  expect(runs).toBe(0);expect(await readFile(file,'utf8')).toBe('# external disk edit\r\n');
  await expect(page.getByText('草稿已同步',{exact:true})).toBeVisible();
  await page.reload();await expect(page.locator('.document-panel:visible .cm-content')).toContainText('must not run after conflict');
  expect(runs).toBe(0);
});
