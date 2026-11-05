<script setup lang="ts">
import { ref } from 'vue';
import { withBase } from 'vitepress';

// The registry's version when pages-site.mjs built the site; empty in a build without it.
declare const __RHO_NPM_VERSION__: string;
const version = __RHO_NPM_VERSION__;

const install = `npm install -g @rho-workspace/rho
rho --root /absolute/projects --state-dir /absolute/service-state`;

const copied = ref(false);
async function copyInstall() {
  try {
    await navigator.clipboard.writeText(install);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1600);
  } catch {
    copied.value = false;
  }
}

const shot = (name: string) => withBase(`/shots/${name}`);

const claims = [
  {
    title: 'The same files',
    body: 'The Agent edits the project you have open, through its own tools. When it changes a file while you have unsaved text, Rho tells you whose version is on screen before anything is written.',
  },
  {
    title: 'The same runs',
    body: 'Commands run in your project and their output is kept with the exit code and duration. A failed run stays visible as a failure; nothing is retried behind your back under a new identity.',
  },
  {
    title: 'A record of what happened',
    body: 'Every question, file, run and decision is joined in one graph. It is the same record the Agent reads when you ask a follow-up, and the same record you export.',
  },
];

const verified = [
  {
    label: 'Checked',
    tone: 'ok',
    items: [
      'Each release of @rho-workspace/rho is published from the exact candidate the CI suite tested, with provenance.',
      'The suite runs on macOS, Linux and Windows; the packed candidate is installed offline on each, and on Linux also with Node 24 and 26.',
      'The example project ships with the application and is copied once into your projects folder.',
    ],
  },
  {
    label: 'Limited',
    tone: 'warn',
    items: [
      'macOS x64 starts only under Rosetta.',
      'Releases since 0.5.2 carry platform installs and package checks; the full 0.5.1 acceptance was not repeated on them.',
      'Row questions on an ordinary CSV still need a declared key column or a row position.',
    ],
  },
  {
    label: 'Not established',
    tone: 'stop',
    items: [
      'Use by an independent researcher is unobserved. No usability claim is made.',
      'Scientific novelty and human benefit are not established by the existing checks.',
      'The desktop client is deferred; this delivery is npm plus a local WebUI.',
    ],
  },
];
</script>

<template>
  <main class="rho-home">
    <section class="hero">
      <p class="eyebrow">Scientific workbench for R<template v-if="version"> · {{ version }}</template></p>
      <h1><span>An Agent works in your project.</span><span>You see everything it did.</span></h1>
      <p class="lede">
        Rho puts a person and an external Agent on the same R project: the same files, the same
        runs, the same results — and one record of how each result was reached. The Agent keeps
        its own tools and permissions. Rho is the workspace they share.
      </p>
      <div class="cta">
        <a class="btn primary" :href="withBase('/start/')">Install Rho</a>
        <a class="btn ghost" :href="withBase('/reference/headless')">Read the documentation</a>
        <a class="btn ghost" :href="withBase('/reference/deepseek-harness')">DeepSeek Harness plugin</a>
      </div>
      <div class="repro">
        <pre><code>{{ install }}</code></pre>
        <button type="button" class="copy" @click="copyInstall">
          {{ copied ? 'Copied' : 'Copy' }}
        </button>
      </div>
    </section>

    <figure class="frame hero-frame">
      <img
        :src="shot('studio.png')"
        width="1440"
        height="900"
        alt="Rho Studio showing the PA14 quorum sensing project: project notes, the Agent's command list with one failed command, its answer, and a reply box."
      />
      <figcaption>
        <span class="tag">Studio</span> A real run on the bundled PA14 quorum sensing project. The
        Agent's commands, one failure among them, its answer, and the notes left for the next
        question.
      </figcaption>
    </figure>

    <section class="claims">
      <article v-for="claim in claims" :key="claim.title" class="claim">
        <h2>{{ claim.title }}</h2>
        <p>{{ claim.body }}</p>
      </article>
    </section>

    <section class="feature">
      <div class="feature-text">
        <p class="kicker">Understand a result before you accept it</p>
        <h2>The answer, with what produced it</h2>
        <p>
          An answer is not a paragraph. Rho shows the question, the result files, the method, the
          commands that ran, and the report they produced — each one openable at the version it was
          captured at.
        </p>
        <p class="asides">
          <a :href="withBase('/records/simulated-project-episode')">What changed after a simulated project</a>
          <a :href="withBase('/concepts/collaboration')">Conditional compositions</a>
        </p>
      </div>
      <figure class="frame side">
        <img
          :src="shot('overview.png')"
          width="1440"
          height="900"
          loading="lazy"
          alt="Rho Overview of an answer: the question, Results, Method, the command that ran, the report, and a decision prompt under it."
        />
        <figcaption>
          <span class="tag">Overview</span> Question, results, method, run and report in one place.
        </figcaption>
      </figure>
    </section>

    <section class="feature reverse">
      <div class="feature-text">
        <p class="kicker">The record is the interface</p>
        <h2>What the Agent did, folded by what it means</h2>
        <p>
          Questions, findings, choices, files and runs become one graph. Meaning and process are
          separated so you can read the reasoning or the sequence, and failures stay in the count
          instead of disappearing from it.
        </p>
        <p class="asides">
          <a :href="withBase('/records/graph-episode')">The Graph episode</a>
          <a :href="withBase('/concepts/agent-activity')">Agent activity</a>
        </p>
      </div>
      <figure class="frame side">
        <img
          :src="shot('graph.png')"
          width="1440"
          height="900"
          loading="lazy"
          alt="Rho Graph: cards for questions, findings, choices and results linked by edges, above a timeline of 267 actions with failed or refused actions counted separately."
        />
        <figcaption>
          <span class="tag">Graph</span> 267 actions over 8 messages, with refused and failed ones
          counted, not hidden.
        </figcaption>
      </figure>
    </section>

    <section class="feature">
      <div class="feature-text">
        <p class="kicker">One workspace, chosen by you</p>
        <h2>Arrange the views, keep the ownership</h2>
        <p>
          Code, tables, figures, notebooks and conversations are separate components with their own
          owners. Rho arranges them in tabs and splits without taking over their content, so closing
          a view releases the view, not the work.
        </p>
        <p class="asides">
          <a :href="withBase('/concepts/architecture')">Architecture</a>
          <a :href="withBase('/reference/plugin-authoring')">Author a view</a>
        </p>
      </div>
      <figure class="frame side">
        <img
          :src="shot('notebook.png')"
          width="1440"
          height="900"
          loading="lazy"
          alt="Rho Notebook with R cells, their output and figures inside the same project workspace."
        />
        <figcaption>
          <span class="tag">Notebook</span> R cells and their figures in the project, not in a
          separate session.
        </figcaption>
      </figure>
    </section>

    <section class="evidence">
      <div class="evidence-inner">
        <header>
          <p class="kicker">What is actually established</p>
          <h2>Claims come with the evidence beside them</h2>
          <p class="lede small">
            Rho is a research project, and its documentation records failures and open questions
            with the same weight as passes. Current work varies by area, so the
            <a :href="withBase('/reference/status')">Status page</a> is the single summary.
          </p>
        </header>
        <div class="evidence-grid">
          <article
            v-for="group in verified"
            :key="group.label"
            :class="['evidence-card', group.tone]"
          >
            <h3>{{ group.label }}</h3>
            <ul>
              <li v-for="item in group.items" :key="item">{{ item }}</li>
            </ul>
          </article>
        </div>
      </div>
    </section>

    <section class="ownership">
      <p class="kicker">Four repositories, separate owners</p>
      <h2>Nothing here is one monolith</h2>
      <div class="repo-grid">
        <a class="repo" href="https://github.com/YuLab-SMU/Rho">
          <strong>Rho</strong>
          <span>Application assembly, windows, layout and the shared interaction. This site.</span>
        </a>
        <a class="repo" href="https://github.com/YuLab-SMU/Rho-core">
          <strong>Rho-core</strong>
          <span>Optional managed execution, retained execution facts, the resident Host.</span>
        </a>
        <a class="repo" href="https://github.com/YuLab-SMU/Rho-plugins">
          <strong>Rho-plugins</strong>
          <span>Documents, files, tables, charts, media, kernel, skills and the Agent adapter.</span>
        </a>
        <a class="repo" href="https://github.com/YuLab-SMU/Rho-paper">
          <strong>Rho-paper</strong>
          <span>The research proposal, its claims and the related work it relies on.</span>
        </a>
      </div>
    </section>

    <section class="start-block">
      <div>
        <p class="kicker">Start</p>
        <h2>Node 22, 24 or 26, R, and one of your own Agent clients</h2>
        <p>
          Rho is a local service with a WebUI, on Node 22.22 or later, below 27. R and any project
          packages are yours to install, and so are the Agent clients: conversations drive the
          Claude Code or Codex you already have. DeepSeek Harness connects as an external Agent
          through the dsh-rho plugin. The service, documents and readers work without R.
        </p>
        <p class="asides">
          <a :href="withBase('/start/')">Installation and first project</a>
          <a :href="withBase('/reference/headless')">HTTP, SSE and budgets</a>
        </p>
      </div>
      <div class="panel">
        <p class="panel-label">Published to npm</p>
        <p class="version">@rho-workspace/rho {{ version }}</p>
      </div>
    </section>
  </main>
</template>
