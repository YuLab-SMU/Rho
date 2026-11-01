import { useEffect, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { when } from './home.js';
import { Icon } from './icons.js';
import { AgentMarkdown } from './markdown.js';
import { askCell } from '@rho-workspace/plugin-kernel/ui';
import { didWhat, failure, headline, skillPath, skillTitle, askedSkill, answeredSkill, useAuthor, useSkillList, type Author, type SkillList } from './skills-work.js';
import './skills.css';

// How work is done in this project: the skills every Agent here reads, as the person and their
// Agent keep them. The newest change of the chosen skill leads, with who made it, why, from what
// and what it changed, beside an Undo; then the skill as Agents read it, then its earlier changes.
// The skills bound to the servers this project runs on are listed too, read only: they belong to
// the person's serverctl, not to the project.
type List = SkillList;
type Summary = List['skills'][number];
type Read = RhoOutput<'skills.read'>;
type Change = Read['changes'][number];
type Evidence = Change['evidence'][number];
type Diff = Change['diff'];
export const skillsPageLimits = { changes: 20 };
const subtitleVerb = { recorded: 'changed', removed: 'removed', undone: 'undid a change to', outside: 'changed' } as const;

export function SkillsPage({ client, snapshot, onPath, onConversation, onNotebook }: { client: BrowserClient; snapshot: WorkspaceSnapshot; onPath: (path: string) => void; onConversation: (id: string) => void; onNotebook: () => void }) {
  const projectId = snapshot.project.id;
  const { list, problem, again } = useSkillList(client, projectId, snapshot.cursor);
  const author = useAuthor(snapshot);
  // A skill chosen on another page opens here, on a narrow page too.
  const [chosen, setChosen] = useState<string | null>(askedSkill);
  const [showing, setShowing] = useState(chosen !== null);
  useEffect(answeredSkill, []);
  const skills = list?.skills ?? [], removed = list?.removed ?? [];
  // The skill changed last leads until the person chooses one.
  const newest = [...skills, ...removed].filter(s => s.last).sort((a, b) => b.last!.at.localeCompare(a.last!.at))[0] ?? skills[0] ?? null;
  const name = chosen && [...skills, ...removed].some(s => s.name === chosen) ? chosen : newest?.name ?? null;
  const choose = (next: string) => { setChosen(next); setShowing(true); };
  const latest = newest?.last;
  return <section className="project-page skills-page" aria-labelledby="skills-title">
    <header className="page-heading"><div><h1 id="skills-title">Skills</h1>
      {list && skills.length === 0 && <p>How work is done in this project, read by every Agent here</p>}
      {list && skills.length > 0 && <p>{skills.length} {skills.length === 1 ? 'skill' : 'skills'} every Agent here reads{latest ? ` · ${latest.kind === 'outside' ? skillTitle(newest!.name) + ' was changed outside Rho' : author(latest.by).name + ' ' + subtitleVerb[latest.kind] + ' ' + skillTitle(newest!.name)} ${when(latest.at).text.toLowerCase()}` : ''}</p>}
    </div></header>
    {problem && <div className="inline-error" role="alert"><p>The skills could not be read. {problem}</p><button onClick={() => void again()}>Try again</button></div>}
    {!list && !problem ? <p className="quiet-empty" role="status">Reading the skills…</p>
      : list && <div className={'skills-layout' + (showing && name ? ' showing' : '') + (name ? '' : ' none-yet')}>
        <nav className="skills-index" aria-label="Skills">
          {skills.length > 0 ? <ul className="skills-list">{skills.map(s => <li key={s.name}><SkillRow skill={s} current={s.name === name} author={author} onChoose={() => choose(s.name)} /></li>)}</ul>
            : <div className="skills-empty">
              <h2>No project skills yet</h2>
              <p>When you correct how your Agent works, or it finds why something failed, it records that here, and the next conversation starts from it. You can also tell it directly:</p>
              <ul>{['For this project we report proportions as percentages.', 'Remember how we filter the cells, so the next analysis does the same.'].map(t => <li key={t}>“{t}”</li>)}</ul>
              <small>Skills are kept as SKILL.md files in .claude/skills in the project folder. Claude Code reads them by itself; other Agents read them through Rho.</small>
            </div>}
          {removed.length > 0 && <details className="skills-removed" open={removed.some(s => s.name === name)}>
            <summary><Twisty />Removed <span className="section-count">{removed.length}</span></summary>
            <ul className="skills-list">{removed.map(s => <li key={s.name}><SkillRow skill={s} current={s.name === name} author={author} onChoose={() => choose(s.name)} /></li>)}</ul>
          </details>}
          <ServerSkills client={client} snapshot={snapshot} />
        </nav>
        {name && <SkillDetail key={name} client={client} snapshot={snapshot} name={name} summary={[...skills, ...removed].find(s => s.name === name)!} author={author}
          onBack={() => setShowing(false)} onPath={onPath} onConversation={onConversation} onNotebook={onNotebook} onChanged={() => void again()} />}
      </div>}
  </section>;
}

function SkillRow({ skill, current, author, onChoose }: { skill: Summary; current: boolean; author: (by: string) => Author; onChoose: () => void }) {
  const last = skill.last;
  return <button className="skills-row" aria-current={current ? 'true' : undefined} onClick={onChoose} title={skillPath(skill.name)}>
    <strong>{skillTitle(skill.name)}</strong>
    {skill.description && <span className="skills-row-desc">{skill.description}</span>}
    <small>{skill.problem ? <span className="skills-row-problem">{skill.problem}</span>
      : !last ? 'Written outside Rho'
      : skill.outside ? 'Changed outside Rho'
      : `${last.kind === 'outside' ? 'Changed outside Rho' : didWhat(last, author(last.by).name)} · ${when(last.at).text}`}</small>
  </button>;
}

function SkillDetail({ client, snapshot, name, summary, author, onBack, onPath, onConversation, onNotebook, onChanged }: { client: BrowserClient; snapshot: WorkspaceSnapshot; name: string; summary: Summary; author: (by: string) => Author; onBack: () => void; onPath: (path: string) => void; onConversation: (id: string) => void; onNotebook: () => void; onChanged: () => void }) {
  const projectId = snapshot.project.id;
  const [read, setRead] = useState<Read | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [undoProblem, setUndoProblem] = useState('');
  const again = () => client.call('skills.read', { projectId, name, limit: skillsPageLimits.changes }).then(value => { setRead(value); setProblem(''); }, error => setProblem(failure(error)));
  useEffect(() => { void again(); }, [client, projectId, name, snapshot.cursor]);
  const [newest, ...earlier] = read?.changes ?? [];
  // Only the newest change Rho recorded is undone here, while the file is as it left it.
  const undoable = !!newest && newest.kind !== 'outside' && !newest.undoneBy && !read?.outside;
  async function undo(change: Change) {
    setBusy(true); setUndoProblem('');
    try { await client.call('skills.undo', { projectId, name, change: change.id, changeId: 'undo-' + change.id + '-' + Date.now().toString(36) }); onChanged(); await again(); }
    catch (error) { setUndoProblem(failure(error)); }
    finally { setBusy(false); }
  }
  const who = (change: Change) => { const a = author(change.by); const name = didWhat(change, a.name);
    return a.conversationId ? <button className="text-button skills-who" onClick={() => onConversation(a.conversationId!)} title="Open the conversation">{name}</button> : name; };
  const conversations = new Set((snapshot.conversations ?? []).map(c => c.conversationId));
  const evidence = (e: Evidence) => <EvidenceChip key={e.kind + e.ref} evidence={e} known={conversations.has(e.ref)} onPath={onPath} onConversation={onConversation} onNotebook={onNotebook} />;
  return <article className="skills-detail" aria-labelledby="skill-title">
    <button className="text-button skills-back" onClick={onBack}><Icon name="back" size={14} />All skills</button>
    <header className="skills-detail-head">
      <div><h2 id="skill-title">{skillTitle(name)}</h2>{(read?.skill?.description ?? summary.description) && <p>{read?.skill?.description ?? summary.description}</p>}</div>
      {read?.skill && <button onClick={() => onPath(skillPath(name))} title={skillPath(name)}><Icon name="document" size={15} />Edit the file</button>}
    </header>
    {problem && <div className="inline-error" role="alert"><p>{problem}</p><button onClick={() => void again()}>Try again</button></div>}
    {!read && !problem && <p className="quiet-empty" role="status">Reading {skillTitle(name)}…</p>}
    {summary.problem && <p className="skills-note" role="status">{summary.problem}</p>}
    {read?.outside && (read.outside.since === null && !newest
      ? <p className="skills-note" role="status">Written outside Rho. Agents read it as it is; Rho records its changes from the first one made here.</p>
      : <section className="skills-change outside" aria-label="Changed outside Rho">
        <p className="skills-change-reason">Changed outside Rho since the last recorded change</p>
        <p className="skills-change-meta"><Counts added={read.outside.added} removed={read.outside.removed} /> · Agents read it as it is now; the next change recorded here starts from it</p>
        <DiffLines diff={read.outside.diff} />
      </section>)}
    {newest && <section className={'skills-change newest' + (newest.undoneBy ? ' undone' : '')} aria-label="Newest change">
      <p className="skills-change-reason">{headline(newest)}</p>
      <p className="skills-change-meta">{who(newest)} · {when(newest.at).text} · <Counts added={newest.added} removed={newest.removed} /></p>
      {newest.evidence.length > 0 && <div className="skills-evidence">{newest.evidence.map(evidence)}</div>}
      <ChangeDiff change={newest} />
      {(undoable || undoProblem) && <div className="skills-change-actions">
        {undoable && <button onClick={() => void undo(newest)} disabled={busy}>{busy ? 'Undoing…' : newest.kind === 'removed' ? 'Bring it back' : newest.kind === 'undone' ? 'Put the change back' : 'Undo this change'}</button>}
        {undoProblem && <p role="alert">{undoProblem}</p>}
      </div>}
    </section>}
    {read?.skill ? <section className="skills-text" aria-labelledby="skills-text-title"><h3 id="skills-text-title">What Agents read</h3><AgentMarkdown text={withoutTitle(read.skill.body, name)} streaming={false} /></section>
      : read && <p className="skills-note">This skill was removed. Its changes are kept below.</p>}
    {earlier.length > 0 && <section className="skills-history" aria-labelledby="skills-history-title">
      <h3 id="skills-history-title">Earlier changes</h3>
      <ol>{earlier.map(change => <li key={change.id} className={change.undoneBy ? 'undone' : undefined}>
        <details>
          <summary>
            <Twisty />
            <span className="skills-history-reason">{headline(change)}</span>
            <small>{didWhat(change, author(change.by).name)} · {when(change.at).text}{change.undoneBy ? ' · undone' : ''}</small>
            <Counts added={change.added} removed={change.removed} />
          </summary>
          {change.evidence.length > 0 && <div className="skills-evidence">{change.evidence.map(evidence)}</div>}
          <ChangeDiff change={change} />
        </details>
      </li>)}</ol>
      {(read?.omitted ?? 0) > 0 && <p className="quiet-empty">{read!.omitted} older {read!.omitted === 1 ? 'change' : 'changes'} kept</p>}
    </section>}
  </article>;
}

const Twisty = () => <span className="skills-twisty" aria-hidden="true"><Icon name="chevron" size={11} stroke={2} /></span>;
// The text's own first heading is left out when it only repeats the skill's name.
const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const withoutTitle = (body: string, name: string) => body.replace(/^\s*# (.+)\n+/, (line, title: string) => words(title) === words(name) ? '' : line);
const Counts = ({ added, removed }: { added: number; removed: number }) => <span className="skills-counts" aria-label={`${added} lines added, ${removed} removed`}><span className="added">+{added}</span> <span className="removed">−{removed}</span></span>;

// A change that writes or removes the whole file says enough in its reason; the text is a click away.
function ChangeDiff({ change }: { change: Change }) {
  if (change.before !== null && change.after !== null) return <DiffLines diff={change.diff} />;
  return <details className="skills-removed-text"><summary><Twisty />{change.after === null ? 'The text it removed' : 'The text it wrote'}</summary><DiffLines diff={change.diff} /></details>;
}

function DiffLines({ diff }: { diff: Diff }) {
  if (!diff.lines.length) return null;
  return <div className="skills-diff" role="group" aria-label="What changed">
    {diff.lines.map((line, i) => line.op === '…' ? <div key={i} className="fold">{line.text} unchanged {line.text === '1' ? 'line' : 'lines'}</div>
      : <div key={i} className={line.op === '+' ? 'add' : line.op === '-' ? 'del' : 'keep'}><span aria-hidden="true">{line.op}</span>{line.text || ' '}</div>)}
    {diff.cut && <div className="fold">The rest is not shown</div>}
  </div>;
}

// Evidence opens where it came from when Rho has it; a conversation Rho does not hold (an Agent
// outside Rho naming its own) is shown as the Agent described it.
function EvidenceChip({ evidence, known, onPath, onConversation, onNotebook }: { evidence: Evidence; known: boolean; onPath: (path: string) => void; onConversation: (id: string) => void; onNotebook: () => void }) {
  const label = evidence.label || evidence.ref;
  if (evidence.kind === 'cell') return <button className="skills-chip" onClick={() => { askCell(evidence.ref); onNotebook(); }} title="Open the cell in the Notebook"><Icon name="code" size={13} />{label}</button>;
  if (evidence.kind === 'file') return <button className="skills-chip" onClick={() => onPath(evidence.ref)} title={evidence.ref}><Icon name="file" size={13} />{label}</button>;
  if (evidence.kind === 'conversation' && known) return <button className="skills-chip" onClick={() => onConversation(evidence.ref)}><Icon name="prompt" size={13} />{evidence.label || 'The conversation'}</button>;
  return <span className="skills-chip quiet" title={evidence.kind === 'note' ? undefined : evidence.ref}>{evidence.kind === 'note' ? '“' + label.trim().replace(/^["“'‘]+|["”'’]+$/g, '') + '”' : label}</span>;
}

// The skills serverctl binds to the servers this project's places use: how those servers are
// used, read by the person and the Agent alike, kept in the person's serverctl.
type Places = RhoOutput<'kernel.places'>;
type Servers = RhoOutput<'kernel.servers'>;
function ServerSkills({ client, snapshot }: { client: BrowserClient; snapshot: WorkspaceSnapshot }) {
  const projectId = snapshot.project.id;
  const kernel = snapshot.catalog.operations.some(o => o.method === 'kernel.servers' && o.state === 'available' && o.authorized);
  const [found, setFound] = useState<{ places: Places; servers: Servers | null } | null>(null);
  const [text, setText] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!kernel) return;
    let current = true;
    void client.call('kernel.places', { projectId }).then(async places => {
      if (!places.places.some(p => p.via === 'serverctl')) { if (current) setFound({ places, servers: null }); return; }
      const servers = await client.call('kernel.servers', { projectId });
      if (current) setFound({ places, servers });
    }, () => {});
    return () => { current = false; };
  }, [client, projectId, kernel]);
  const rows = (found?.places.places ?? []).filter(p => p.via === 'serverctl').flatMap(place => (found!.servers?.servers.find(s => s.server === place.destination)?.skills ?? []).map(skill => ({ place, skill })));
  const unique = rows.filter((r, i) => rows.findIndex(o => o.place.destination === r.place.destination && o.skill.name === r.skill.name) === i);
  if (!unique.length) return null;
  const open = (server: string, name: string) => {
    const key = server + '/' + name;
    if (text[key] !== undefined) return;
    setText(t => ({ ...t, [key]: '' }));
    client.call('kernel.server.skill', { projectId, server, name }).then(value => setText(t => ({ ...t, [key]: value.text ?? '' })), error => setText(t => ({ ...t, [key]: failure(error) })));
  };
  return <section className="skills-servers" aria-labelledby="skills-servers-title">
    <h2 id="skills-servers-title">From your servers</h2>
    <ul>{unique.map(({ place, skill }) => { const key = place.destination + '/' + skill.name; return <li key={key}>
      <details onToggle={event => { if ((event.currentTarget as HTMLDetailsElement).open) open(place.destination, skill.name); }}>
        <summary><Icon name="server" size={14} /><span><strong>{skill.name}</strong><small>{place.destination} · through serverctl</small></span></summary>
        {skill.description && <p className="skills-servers-desc">{skill.description}</p>}
        {text[key] === '' ? <p className="quiet-empty" role="status">Reading…</p> : text[key] ? <div className="skills-servers-text"><AgentMarkdown text={text[key]!.replace(/^---[\s\S]*?\n---\n/, '')} streaming={false} /></div> : null}
      </details>
    </li>; })}</ul>
  </section>;
}
