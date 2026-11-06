// Publish metadata from one immutable, already-built source commit.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { commit: { type: 'string' }, output: { type: 'string', default: 'site/market/index.json' } } });
if (!/^[0-9a-f]{40}$/.test(values.commit ?? '')) throw new Error('Pass --commit with the full published source commit.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const git = (...args) => execFileSync('git', args, { cwd: root });
const file = name => git('show', `${values.commit}:adapters/dsh-rho/${name}`);
const manifest = JSON.parse(file('package.json'));
const locale = JSON.parse(file('locale/en.json'));
const icon = file('icon.svg');
file('lib/client.js');
file('lib/observe.cjs');
file('lib/observe-source.json');
file('lib/observe.LICENSES.txt');
file('src/host.cjs');
file('cordis.patch.yml');
if (icon.length > 32768 || !manifest.engines?.dsh || !manifest.dsh?.bundle?.patch) throw new Error('The selected commit is not a complete market bundle.');
const repository = { url: manifest.repository.url.replace(/\.git$/, ''), directory: manifest.repository.directory };
const index = {
  format: 1,
  title: { en: 'Rho plugins' },
  description: { en: 'Rho integrations for DeepSeek Harness.' },
  metadata: {
    categories: { science: { title: { en: 'Science and data analysis' } } },
    labels: { prototype: { title: { en: 'Prototype' } } },
  },
  plugins: [{
    name: manifest.name,
    title: { en: locale.meta.title },
    description: { en: locale.meta.description },
    icon: `data:image/svg+xml;base64,${icon.toString('base64')}`,
    author: manifest.author,
    homepage: manifest.homepage,
    repository,
    metadata: { category: 'science', labels: ['prototype'], keywords: manifest.keywords },
    versions: [{
      version: manifest.version,
      publishTimestamp: Number(git('show', '-s', '--format=%ct', values.commit).toString().trim()),
      source: { type: 'git', url: repository.url, commit: values.commit, path: repository.directory },
      engines: { dsh: manifest.engines.dsh },
    }],
  }],
};
const output = path.resolve(root, values.output);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(index, null, 2) + '\n');
console.log(JSON.stringify({ output, name: manifest.name, version: manifest.version, commit: values.commit }));
