import { defineConfig } from 'vitepress';
import navigation from './generated/navigation.json';

// The site is published under /Rho/docs/ on GitHub Pages. `RHO_DOCS_BASE` keeps
// local preview at / and the published build at the real prefix.
const base = process.env.RHO_DOCS_BASE ?? '/';

// The release a visitor installs is the registry's, which pages-site.mjs passes in. A build
// without it names no version rather than this checkout's.
const npmVersion = process.env.RHO_NPM_VERSION ?? '';

type Item = { text: string; link: string; summary?: string; source?: string; updated?: string | null };
const sections = (navigation as { sections: Record<string, Item[]> }).sections;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// Records are a dated log. Grouping by month keeps a 36-entry list readable and
// says when each record was written without opening it.
function recordGroups() {
  const groups = new Map<string, { text: string; link: string }[]>();
  for (const item of sections.records ?? []) {
    const date = item.updated ?? '';
    const [year, month] = date.split('-');
    const label = month ? `${MONTHS[Number(month) - 1]} ${year}` : 'Undated';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push({ text: item.text, link: item.link });
  }
  return [...groups.entries()].map(([text, items]) => ({ text, collapsed: true, items }));
}

const sidebarGroup = (key: string, label: string, collapsed: boolean) => ({
  text: label,
  link: `/${key}/`,
  collapsed,
  items: (sections[key] ?? []).map((item) => ({ text: item.text, link: item.link })),
});

export default defineConfig({
  base,
  srcDir: 'content',
  lang: 'en-US',
  title: 'Rho',
  description: 'An agent-native scientific workbench for R.',
  cleanUrls: true,
  lastUpdated: false,
  appearance: false,
  ignoreDeadLinks: false,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}rho.svg` }],
    ['meta', { name: 'theme-color', content: '#1e6b52' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Rho — an agent-native scientific workbench for R' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'A person and an external Agent work on the same R project: the same files, the same runs, the same results, and a record of what happened.',
      },
    ],
    // Social cards need an absolute URL, not a path the build prefixes.
    ['meta', { property: 'og:image', content: 'https://yulab-smu.top/Rho/docs/shots/studio.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],
  themeConfig: {
    // VitePress prepends `base` to this itself; adding it here doubles the prefix.
    logo: { src: '/rho.svg', width: 24, height: 24 },
    siteTitle: 'Rho',
    nav: [
      { text: 'Get started', link: '/start/' },
      { text: 'Concepts', link: '/concepts/' },
      { text: 'Reference', link: '/reference/' },
      { text: 'Records', link: '/records/' },
      { text: 'Current state', link: '/reference/status' },
    ],
    sidebar: {
      '/start/': [{ text: 'Get started', items: [{ text: 'Install and open a project', link: '/start/' }] }],
      '/concepts/': [sidebarGroup('concepts', 'Concepts', false)],
      '/reference/': [sidebarGroup('reference', 'Reference', false)],
      '/records/': [{ text: 'Records', link: '/records/', collapsed: false, items: recordGroups() }],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/YuLab-SMU/Rho' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/@rho-workspace/rho' },
    ],
    search: {
      provider: 'local',
      options: {
        detailedView: true,
        miniSearch: {
          options: {
            boost: { title: 4, text: 2, titles: 1 },
            fuzzy: 0.2,
            prefix: true,
          },
        },
      },
    },
    outline: { level: [2, 3], label: 'On this page' },
    docFooter: { prev: 'Previous', next: 'Next' },
    footer: {
      message:
        'Rho is developed in the open. Scientific claims need the evidence recorded beside them.',
    },
    notFound: {
      title: 'Not found',
      quote: 'This page does not exist. The documentation index lists every published page.',
      linkText: 'Back to the documentation',
    },
  },
  markdown: {
    lineNumbers: false,
    theme: { light: 'github-light', dark: 'github-light' },
  },
  vite: {
    server: { fs: { allow: ['..'] } },
    define: { __RHO_NPM_VERSION__: JSON.stringify(npmVersion) },
  },
});
