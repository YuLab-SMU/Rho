/** Public R observations and the actual ordinary Agent picker. */
import { expect, type FrameLocator, type Page, type TestInfo } from '@playwright/test';

export const viewerText = '<html><body>Saved Agent Viewer context · 中文 Ω</body></html>';
type Query = (id: string, args: unknown) => Promise<any>;

export async function setAgentViewport(page: Page, frame: FrameLocator, width: number) {
  await page.setViewportSize({width,height:900});
  // The Host sizes the iframe through ResizeObserver after the outer viewport.
  // Wait for that actual geometry before checking overflow or taking evidence.
  // This single tab group has a one-pixel Host border on each side.
  await expect.poll(() => frame.locator('body').evaluate((_node,expected) => innerWidth >= expected - 2 && innerWidth <= expected, width)).toBe(true);
}

export async function observeHelp(query: Query, session: string) {
  const ready = async (id: string, args: unknown) => {
    const reply = await query(id, args);
    expect(reply.status).toBe('ready'); expect(reply.session_id).toBe(session);
    return reply.data;
  };
  const packages = await ready('r.packages', {expected_session:session,filter:'parallel',grouped:true});
  const copies = await ready('r.packages', {expected_session:session,observation_id:packages.observation_id,package_name:'parallel'});
  const copy = copies.packages[0]; expect(copy).toBeTruthy();
  const index = await ready('r.package_index', {expected_session:session,observation_id:packages.observation_id,
    package:'parallel',library_path:copy.library_path,limit:2});
  const help = await ready('r.read_help', {expected_session:session,observation_id:packages.observation_id,
    package:'parallel',library_path:copy.library_path,topic:'mclapply',expected_index_files:index.files,limit_bytes:16384,format:'text'});
  expect(help.found).toBe(true); expect(help.text).toContain('mclapply');
  return {session,observation:packages.observation_id,library:copy.library_path,help_files:help.help_files};
}

export async function selectContextSource(frame: FrameLocator, title: string) {
  const selector = frame.getByRole('combobox', {name:'Context source',exact:true});
  await expect(selector).toBeEnabled();
  const option = selector.locator('option').filter({hasText:title});
  await expect(option).toHaveCount(1);
  await selector.selectOption((await option.getAttribute('value'))!);
}

export async function addScientificContexts(page: Page, frame: FrameLocator, info: TestInfo, operation: string) {
  const texts: string[] = [];
  const picker = frame.getByRole('dialog', {name:'Choose context'});
  for (const [source, search, label, inclusion] of [
    ['Observed Help topics','parallel::mclapply',/parallel::mclapply/,'First 12 lines'],
    ['Saved HTML outputs',operation,/HTML output/,'HTML source'],
  ] as const) {
    await frame.getByRole('button', {name:'Choose context',exact:true}).click();
    await selectContextSource(frame, source);
    await picker.getByRole('textbox', {name:'Search context',exact:true}).fill(search);
    await picker.getByRole('button', {name:'Search',exact:true}).click();
    // The R owner pages the shared journal; an empty page can still continue.
    const item = picker.getByRole('button', {name:label});
    for (let pageNumber=0; pageNumber<20; pageNumber++) {
      await expect(picker.getByRole('button', {name:'Search',exact:true})).toBeEnabled();
      if (await item.count()) break;
      const more = picker.getByRole('button', {name:'More items',exact:true});
      await expect(more).toBeVisible(); await more.click();
    }
    await item.click();
    await picker.getByRole('combobox', {name:'Context inclusion',exact:true}).selectOption({label:inclusion});
    await expect(picker.getByRole('button', {name:'Add to draft',exact:true})).toBeEnabled();
    const text = await picker.locator('#context-preview').textContent(); expect(text).toBeTruthy(); texts.push(text!);
    if (source === 'Saved HTML outputs') expect(text).toContain(viewerText);
    else expect(text).toContain('mclapply');
    for (const width of [1440,390,220]) {
      await setAgentViewport(page,frame,width);
      await expect.poll(() => picker.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false);
      // Locator screenshots wait for the dialog's stable bounds and painted
      // iframe surface; a page screenshot can retain the old compositor frame.
      await picker.screenshot({path:info.outputPath(`agent-${source === 'Saved HTML outputs' ? 'viewer' : 'help'}-context-${width}.png`)});
    }
    await picker.getByRole('button', {name:'Add to draft',exact:true}).click();
    await setAgentViewport(page,frame,1440);
  }
  return texts;
}
