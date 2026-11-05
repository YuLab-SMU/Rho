// Assembles the GitHub Pages tree for https://yulab-smu.top/Rho/ in site/.pages:
//   index.html  the front page (site/home), filled with the npm release, the install sentence in
//               each language it is offered in, the setup page's steps, the recorded prompts and
//               the prompts each selected plugin declares for itself
//   demo/       the application's WebUI replaying site/demo/recording.json (no backend)
//   docs/       the documentation site, built from docs/ with base /Rho/docs/
//   doc/setup.md  SETUP.md as it is: the steps an Agent follows to install and configure Rho
//   skills/     the Agent Skill in skills/, as it is, which those steps install
// The branch's updates/*.json feeds and .nojekyll are not produced here; a deployment keeps them.
//
//   node scripts/pages-site.mjs [--no-docs | --home]
// --home builds the front page alone (index.html, img/, doc/ and skills/), for a deployment that
// leaves the demo and docs on the branch as they are.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve('site/.pages');
const run = (command, args, env = {}) => execFileSync(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });

// The setup page downloads the Skill file by file, so a file added to or removed from the Skill
// has to be named there too.
const skillFiles = fs.readdirSync('skills/rho', { recursive: true }).map(f => f.split(path.sep).join('/')).filter(f => f.endsWith('.md')).sort();
const downloads = [...new Set(fs.readFileSync('SETUP.md', 'utf8').match(/\b(?:SKILL|references\/[a-z-]+)\.md\b/g))].sort();
if (skillFiles.join() !== downloads.join()) throw new Error(`SETUP.md downloads ${downloads.join(', ')}, but skills/rho holds ${skillFiles.join(', ')}.`);
const home = process.argv.includes('--home'), docs = !home && !process.argv.includes('--no-docs');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const date = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

// The release a visitor installs is the registry's, not this checkout's version.
const registry = JSON.parse(execFileSync('npm', ['view', '@rho-workspace/rho', 'version', 'time', '--json'], { encoding: 'utf8' }));
const version = registry.version, published = date(registry.time[version]);

if (!home) run('npx', ['vite', 'build', '--logLevel', 'warn', '--config', 'site/demo/vite.config.ts'], { RHO_WEB_OUTPUT: path.join(out, 'demo') });
if (docs) {
  run('npm', ['run', 'docs:build', '--silent'], { RHO_DOCS_BASE: '/Rho/docs/', RHO_NPM_VERSION: version });
  fs.cpSync('site/.vitepress/dist', path.join(out, 'docs'), { recursive: true });
}

// The example's prompts are the ones the recording holds: what a person sent, in order.
const recording = JSON.parse(fs.readFileSync('site/demo/recording.json', 'utf8'));
const turns = new Map();
for (const { body } of Object.values(recording.calls['conversation.read'] ?? {})) {
  for (const turn of body.value?.turns ?? []) if (turn.by === 'browser:local' && !turns.has(turn.text)) turns.set(turn.text, turn);
}
const asked = [...turns.values()].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
const figures = new Set(fs.readdirSync('site/home/img'));
const exampleBands = asked.map(turn => {
  const minutes = Math.max(1, Math.round((Date.parse(turn.endedAt) - Date.parse(turn.startedAt)) / 60000));
  const written = (turn.files?.changed ?? []).filter(f => f.path !== 'project-notes.md').map(f => path.basename(f.path));
  const names = [...new Set(written)];
  const note = names.length ? 'Wrote ' + (names.length > 3 ? names.slice(0, 3).join(', ') + ' and ' + (names.length - 3) + ' more' : names.join(', ').replace(/, ([^,]*)$/, ' and $1')) + '.' : '';
  const figure = (turn.files?.changed ?? []).map(f => path.basename(f.path, '.png') + '.jpg').find(f => f.endsWith('.jpg') && figures.has(f));
  return `          <li class="band"><span class="took">${minutes} min<small>to answer</small></span><div><p class="ask">${escape(turn.text)}</p>${note ? `<p class="note">${escape(note)}</p>` : ''}</div><div class="side">${figure ? `<img class="thumb" src="img/${figure}" width="104" height="78" loading="lazy" alt="${escape(figure.replace('.jpg', '.png'))}, the figure this request produced">` : ''}<button class="btn copy" type="button" data-copy-ask>Copy</button></div></li>`;
});

// Each plugin's own presentation: its name, what it is for and the prompts it offers.
const plugins = [];
for (const name of fs.readdirSync('node_modules/@rho-workspace').sort()) {
  const file = path.resolve('node_modules/@rho-workspace', name, 'dist/presentation.js');
  if (!name.startsWith('plugin-') || !fs.existsSync(file)) continue;
  const { presentation } = await import(file);
  if (presentation?.examplePrompts?.length) plugins.push({ id: name.slice('plugin-'.length), ...presentation });
}
plugins.sort((a, b) => a.categoryOrder - b.categoryOrder || a.order - b.order);

const tab = (id, title, count) => `        <button role="tab" type="button" id="tab-${id}" aria-controls="set-${id}" aria-selected="false"><b>${escape(title)}</b><span>${count} prompts</span></button>`;
const tabs = [tab('example', 'PA14 example', exampleBands.length), ...plugins.map(p => tab(p.id, p.displayName, p.examplePrompts.length))];
const panels = [
  `        <div role="tabpanel" id="set-example" aria-labelledby="tab-example">\n          <p class="panel-intro"><strong>The PA14 quorum-sensing project.</strong> ${exampleBands.length} requests, in the order they were sent, each followed by how long the Agent took and what it wrote.</p>\n          <ol class="bands">\n${exampleBands.join('\n')}\n          </ol>\n        </div>`,
  ...plugins.map(p => `        <div role="tabpanel" id="set-${p.id}" aria-labelledby="tab-${p.id}">\n          <p class="panel-intro"><strong>${escape(p.displayName)}.</strong> ${escape(p.description)}</p>\n          <ul class="bands">\n${p.examplePrompts.map(q => `            <li class="band plain"><p class="ask">${escape(q.replace(/^[“"]|[”"]$/g, ''))}</p><div class="side"><button class="btn copy" type="button" data-copy-ask>Copy</button></div></li>`).join('\n')}\n          </ul>\n        </div>`),
];

// The install sentence, in each language it is offered in, names the setup page this build serves.
const setupUrl = 'https://yulab-smu.top/Rho/doc/setup.md';
const prompts = JSON.parse(fs.readFileSync('site/home/install-prompts.json', 'utf8'));
delete prompts.note;
for (const [lang, { text }] of Object.entries(prompts)) if (!text.includes(setupUrl)) throw new Error(`The ${lang} install sentence does not name ${setupUrl}.`);
// The address breaks only after a slash on a narrow screen, never at the hyphen in its host name.
const [, host, rest] = setupUrl.match(/^(https:\/\/[^/]+\/)(.+)$/);
const sentence = text => escape(text).replace(setupUrl, `<a href="doc/setup.md"><span class="nowrap">${host}</span><wbr>${rest.split('/').join('/<wbr>')}</a>`);
const promptBands = `<ul class="bands asks">\n${Object.entries(prompts).map(([lang, { text }]) => `  <li class="band plain"><p class="ask" lang="${lang}">${sentence(text)}</p><div class="side"><button class="btn copy" type="button" data-copy-text="${escape(text)}" data-copied="Copied. Paste it into Claude Code or Codex.">Copy</button></div></li>`).join('\n')}\n</ul>`;

// The setup page's own step headings, listed where the front page says what an Agent does.
const setupSteps = [...fs.readFileSync('SETUP.md', 'utf8').matchAll(/^## \d+\. (.+)$/gm)].map(m => `            <li>${escape(m[1])}</li>`);
const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const fill = {
  version, published,
  captured: date(recording.capturedAt),
  'demo-project': encodeURIComponent(Object.values(recording.calls['project.list'])[0].body.value[0].id),
  'demo-turns': words[asked.length] ?? String(asked.length),
  prompt: sentence(prompts.en.text),
  'prompt-text': escape(prompts.en.text),
  'prompt-bands': promptBands,
  'setup-steps': setupSteps.join('\n'),
  'setup-count': words[setupSteps.length] ?? String(setupSteps.length),
  'prompt-tabs': tabs.join('\n'),
  'prompt-panels': panels.join('\n'),
};
let html = fs.readFileSync('site/home/index.html', 'utf8');
html = html.replace(/\{\{([a-z-]+)\}\}/g, (all, key) => {
  if (!(key in fill)) throw new Error('No value for ' + all + ' in site/home/index.html.');
  return fill[key];
});
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.cpSync('site/home/img', path.join(out, 'img'), { recursive: true });
// Served as raw Markdown for an Agent to read; .nojekyll on the branch keeps them unrendered.
fs.mkdirSync(path.join(out, 'doc'));
fs.copyFileSync('SETUP.md', path.join(out, 'doc/setup.md'));
fs.cpSync('skills', path.join(out, 'skills'), { recursive: true });
console.log(`site/.pages: front page for npm ${version} (${published}), ${asked.length} recorded prompts, ${plugins.length} plugin prompt sets; ${home ? 'no demo or docs' : docs ? 'demo and docs' : 'demo'} built.`);
