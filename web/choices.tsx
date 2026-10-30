import { useRef, useState } from 'react';
import type { BrowserClient } from '../src/browser.js';
import { capital, topicOf, withoutPaths, type Statement, type Trace } from '../src/notes-meaning.js';
import { Icon } from './icons.js';
import './choices.css';

// A choice the Agent took and kept going with: what it is about, what was taken, and under it
// each option the notes name with what that option gives and the files that show it. Nothing
// waits on the person: the work stands as done, and asking for another option is a message to
// the same conversation, written and sent by them.
export function ChoiceOptions({ statement, trace, conversationId, client, projectId, onPath, onSent }: {
  statement: Statement; trace?: Trace; conversationId: string | null; client: BrowserClient; projectId: string;
  onPath: (path: string) => void; onSent?: (conversationId: string) => void;
}) {
  const [asking, setAsking] = useState<number | null>(null);
  const later = (path: string) => trace?.files.find(f => f.path === path)?.later;
  const files = (links: string[]) => links.map(path => <button key={path} className="work-file" title={path + (later(path) === 'kept' ? ' · a newer version was kept since this was written' : later(path) === 'written' ? ' · written again since this was written' : '')} onClick={() => onPath(path)}>
    <Icon name={/\.(png|jpe?g|svg)$/i.test(path) ? 'image' : /\.(csv|tsv)$/i.test(path) ? 'table' : 'file'} size={13} /><span>{path.split('/').at(-1)}</span>{later(path) && <small>changed since</small>}</button>);
  const { topic, rest } = topicOf(withoutPaths(statement.text, statement.links));
  const options = statement.alternatives ?? [];
  return <div className={'choice' + (topic ? '' : ' untitled')}>
    <div className="choice-grid">
      {topic && <p className="choice-topic">{topic}</p>}
      <div className="choice-body">
        <p className="choice-taken">{rest}</p>
        {statement.links.length > 0 && <div className="choice-foot">{files(statement.links)}</div>}
        {options.map((option, i) => <div key={i} className="choice-other">
          <p><span className="choice-other-label">Other option</span>{capital(withoutPaths(option.text, option.links))}</p>
          {option.links.length > 0 && <div className="choice-foot">{files(option.links)}</div>}
          {conversationId && asking !== i && <button className="text-button choice-instead" onClick={() => setAsking(i)}>Use this instead…</button>}
          {conversationId && asking === i && <SendInstead conversationId={conversationId} client={client} projectId={projectId} taken={statement.text} option={option.text} onCancel={() => setAsking(null)} onSent={id => { setAsking(null); onSent?.(id); }} />}
        </div>)}
      </div>
    </div>
  </div>;
}

// The person's words to the Agent, drafted from the choice and theirs to change; it keeps its
// request identity until sent, so sending the same words again never sends twice.
function SendInstead({ conversationId, client, projectId, taken, option, onCancel, onSent }: { conversationId: string; client: BrowserClient; projectId: string; taken: string; option: string; onCancel: () => void; onSent: (conversationId: string) => void }) {
  const [text, setText] = useState(`Use this option instead: “${option}” (in place of “${taken}”). Redo what depends on it and update the notes.`);
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState('');
  const sending = useRef<{ text: string; changeId: string } | null>(null);
  async function send() {
    if (!text.trim() || busy) return;
    if (sending.current?.text !== text) sending.current = { text, changeId: 'choice-' + crypto.randomUUID() };
    setBusy(true); setProblem('');
    try { await client.call('conversation.send', { projectId, conversationId, changeId: sending.current.changeId, text }); sending.current = null; onSent(conversationId); }
    catch (error) { setProblem(error instanceof Error ? error.message : 'The message could not be sent.'); }
    finally { setBusy(false); }
  }
  return <form className="choice-send" onSubmit={event => { event.preventDefault(); void send(); }} onKeyDown={event => { if (event.key === 'Escape') onCancel(); }}>
    <textarea rows={3} value={text} aria-label="Message to the Agent" onChange={event => setText(event.target.value)} autoFocus />
    {problem && <p className="inline-error" role="alert">{problem}</p>}
    <div className="choice-send-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="submit" className="primary" disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Send to the Agent'}</button></div>
  </form>;
}
