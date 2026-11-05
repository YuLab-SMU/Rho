#!/usr/bin/env node
// Assemble the public documentation site from docs/*.md and check its coverage.
//
// docs/ stays the single source of truth. This script copies each Markdown file
// into site/content/<section>/, rewrites its links so they resolve inside the
// site, records the exact source of every published page, and fails when a
// document is neither published nor explicitly withheld.
//
//   node scripts/docs-site.mjs            assemble site/content
//   node scripts/docs-site.mjs --check    verify coverage without writing
//
// A rewritten link is recorded in site/.vitepress/generated/links.json so the
// release record can say which source line produced which target.
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = join(repo, 'docs');
const contentDir = join(repo, 'site', 'content');
const navFile = join(repo, 'site', '.vitepress', 'generated', 'navigation.json');
const linkFile = join(repo, 'site', '.vitepress', 'generated', 'links.json');
const blobBase = 'https://github.com/YuLab-SMU/Rho/blob/main';

// Section of every published document. A document appears once: the section is
// where a reader should meet it first, not every place it is relevant.
const SECTIONS = {
  concepts: [
    'ARCHITECTURE',
    'COLLABORATION',
    'EXECUTION',
    'TECHSTACK',
    'DEVELOPMENT',
    'ROADMAP',
    'AGENT-ACTIVITY',
  ],
  reference: ['HEADLESS', 'FRONTEND', 'STATUS', 'RELEASE', 'PLUGIN-AUTHORING', 'DEEPSEEK-HARNESS'],
};

// Withheld on purpose: the index is replaced by the site's own navigation, the
// JSON is a machine record, and design/ is a withdrawn commission.
const WITHHELD = new Set(['README', 'VERIFICATION', 'progressive-acceptance']);
const WITHHELD_DIRS = new Set(['design', 'backend-acceptance']);

const SECTION_TITLES = {
  concepts: 'Concepts',
  reference: 'Reference',
  records: 'Records',
};

const SECTION_INTROS = {
  concepts:
    'Who owns what, how work advances, and which guarantees hold. These pages describe Rho as it is implemented.',
  reference:
    'Contracts, operations and current state. Reference pages are checked against the code in this repository.',
  records:
    'Episodes, acceptance records and earlier plans, kept with their observations, failures and limits. A record says what happened on a date; it is not a requirement.',
};

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// These existing GitHub anchors differ from the IDs VitePress renders. Keep
// source Markdown links usable on GitHub and translate only the site copies.
const SITE_ANCHORS = {
  'DOCS-SITE-EPISODE': { 'the-documentation-for-054': 'the-documentation-for-0-5-4' },
  'AGENT-CANVAS-EPISODE': {
    'the-persons-own-hands-on-the-layout': 'the-person-s-own-hands-on-the-layout',
    'closing-every-view-of-a-conversations-studio': 'closing-every-view-of-a-conversation-s-studio',
  },
  'AGENT-PANEL-EPISODE': { 'connection--access': 'connection-access' },
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (WITHHELD_DIRS.has(entry)) continue;
      walk(full, out);
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function sectionOf(name) {
  for (const [section, names] of Object.entries(SECTIONS)) {
    if (names.includes(name)) return section;
  }
  if (/-EPISODE$/.test(name) || /-ACCEPTANCE$/.test(name) || /^PREVIEW-/.test(name)) return 'records';
  if (name === 'BACKEND-FIRST' || name === 'PLUGIN-EXTRACTION' || name === 'MAGPIE-FRONTEND-STUDY') {
    return 'records';
  }
  return null;
}

function titleOf(markdown, fallback) {
  const match = /^#\s+(.+)$/m.exec(markdown);
  if (!match) return fallback;
  return match[1].replace(/`/g, '').trim();
}

// A record opens with the date it was updated and then the question it answers.
// The index shows that first sentence, not a truncated line.
function summaryOf(markdown) {
  const body = markdown.replace(/^#[^\n]*\n+/, '');
  const paragraphs = body.split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    const text = paragraph
      .split('\n')
      .filter((line) => !line.trim().startsWith('|') && !line.trim().startsWith('```'))
      .join(' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`*_]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^(\d{4}-\d{2}-\d{2}\.?\s*)+/, '')
      .trim();
    if (text.length < 40 || /^Updated:?\s/.test(text)) continue;
    const sentence = /^(.{40,200}?[.!?])\s/.exec(text);
    const candidate = sentence ? sentence[1] : text;
    return candidate.length > 170 ? `${candidate.slice(0, 167).trimEnd()}…` : candidate;
  }
  return '';
}

function updatedOf(markdown) {
  const match = /^Updated:?\s*(\d{4}-\d{2}-\d{2})/m.exec(markdown) ?? /(\d{4}-\d{2}-\d{2})/.exec(markdown.slice(0, 600));
  return match ? match[1] : null;
}

const files = walk(docsDir);
const published = new Map(); // basename -> {section, url, title}
const problems = [];

for (const file of files) {
  const name = relative(docsDir, file).replace(/\.md$/, '').split('/').pop();
  if (WITHHELD.has(name)) continue;
  if (relative(docsDir, file).includes('/')) continue;
  const section = sectionOf(name);
  if (!section) {
    problems.push(`${relative(repo, file)}: no section. Add it to SECTIONS or WITHHELD.`);
    continue;
  }
  const markdown = readFileSync(file, 'utf8');
  published.set(name, {
    file,
    section,
    url: `/${section}/${slug(name)}`,
    title: titleOf(markdown, name),
  });
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

// Link targets that leave docs/ resolve on GitHub, not on the site.
const rewritten = [];

function rewriteLinks(markdown, name) {
  return markdown.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (whole, bang, text, target, title) => {
    if (/^(https?:|mailto:|#)/.test(target)) return whole;
    const [path, anchor] = target.split('#');
    if (!path) return whole;
    const base = path.split('/').pop().replace(/\.md$/, '');
    const hit = published.get(base);
    if (hit && !path.includes('/')) {
      const siteAnchor = SITE_ANCHORS[base]?.[anchor] ?? anchor;
      const url = `${hit.url}${siteAnchor ? `#${siteAnchor}` : ''}`;
      rewritten.push({ from: name, target, url });
      return `${bang}[${text}](${url}${title ?? ''})`;
    }
    const url = `${blobBase}/docs/${path}${anchor ? `#${anchor}` : ''}`;
    rewritten.push({ from: name, target, url });
    return `${bang}[${text}](${url}${title ?? ''})`;
  });
}

const navigation = Object.fromEntries(Object.keys(SECTION_TITLES).map((key) => [key, []]));
const assembled = [];

for (const [name, entry] of published) {
  const markdown = readFileSync(entry.file, 'utf8');
  const body = rewriteLinks(markdown, name);
  const banner =
    entry.section === 'records'
      ? `::: warning Historical record\nThis page records what happened on a date, with its observed failures and limits. It is not a requirement for the current implementation. Current behaviour is in [Status](/reference/status).\n:::\n\n`
      : '';
  const out = join(contentDir, entry.section, `${slug(name)}.md`);
  const content = `${banner}${banner ? '' : ''}${body}`;
  assembled.push({ out, content, entry, name });
  navigation[entry.section].push({
    text: entry.title,
    link: entry.url,
    summary: summaryOf(markdown),
    source: relative(repo, entry.file),
    updated: updatedOf(markdown),
  });
}

// Section indexes are generated so they cannot drift from what is published.
const generated = [];
for (const [section, items] of Object.entries(navigation)) {
  const sorted = items.sort((a, b) => {
    if (section === 'records') {
      const left = a.updated ?? '';
      const right = b.updated ?? '';
      if (left !== right) return right.localeCompare(left);
      return a.text.localeCompare(b.text);
    }
    if (section === 'reference') {
      const rank = (x) => (x.link.endsWith('/status') ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
    }
    return a.text.localeCompare(b.text);
  });
  navigation[section] = sorted;
  const lines = [
    `# ${SECTION_TITLES[section]}`,
    '',
    SECTION_INTROS[section],
    '',
    ...sorted.map(
      (item) =>
        `- ${item.updated ? `\`${item.updated}\` ` : ''}[${item.text}](${item.link}) — ${item.summary || 'Record.'}`,
    ),
    '',
  ];
  generated.push({ out: join(contentDir, section, 'index.md'), content: lines.join('\n') });
}

const linksReport = {
  generated_at: new Date().toISOString(),
  documents: assembled
    .map(({ entry, name }) => ({
      source: relative(repo, entry.file),
      page: entry.url,
      section: entry.section,
    }))
    .sort((a, b) => a.page.localeCompare(b.page)),
  rewritten_links: rewritten.sort((a, b) => a.from.localeCompare(b.from) || a.target.localeCompare(b.target)),
};

const withheld = files
  .map((file) => relative(docsDir, file).replace(/\.md$/, ''))
  .filter((name) => WITHHELD.has(name) || name.includes('/'));

if (process.argv.includes('--check')) {
  const existing = existsSync(navFile) ? JSON.parse(readFileSync(navFile, 'utf8')) : null;
  if (!existing) {
    console.error('No generated navigation. Run `npm run docs:assemble` first.');
    process.exit(1);
  }
  const count = Object.values(existing.sections ?? {}).reduce((sum, list) => sum + list.length, 0);
  if (count !== published.size) {
    console.error(`Generated navigation covers ${count} pages, docs/ publishes ${published.size}.`);
    process.exit(1);
  }
  console.log(`docs-site: ${published.size} documents covered, ${rewritten.length} links rewritten.`);
  process.exit(0);
}

mkdirSync(contentDir, { recursive: true });
for (const section of Object.keys(SECTION_TITLES)) {
  rmSync(join(contentDir, section), { recursive: true, force: true });
  mkdirSync(join(contentDir, section), { recursive: true });
}
mkdirSync(dirname(navFile), { recursive: true });

for (const { out, content } of [...assembled, ...generated]) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, content);
}
writeFileSync(
  navFile,
  `${JSON.stringify(
    {
      sections: navigation,
      withheld,
      titles: SECTION_TITLES,
      intros: SECTION_INTROS,
      documents: linksReport.documents.length,
    },
    null,
    2,
  )}\n`,
);
writeFileSync(linkFile, `${JSON.stringify(linksReport, null, 2)}\n`);

console.log(
  `docs-site: published ${published.size} documents in ${Object.keys(SECTION_TITLES).length} sections, ` +
    `rewrote ${rewritten.length} links, withheld ${withheld.length} files.`,
);
