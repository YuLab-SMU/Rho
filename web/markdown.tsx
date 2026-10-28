import { Fragment, useState, type ReactNode } from 'react';
import { markdownBlocks, type Block, type Inline } from '../src/agent-markdown.js';
import { Icon } from './icons.js';

// Copies text the Agent wrote: an answer or one block of code.
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const said = state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : label;
  return <button className="icon-button copy-button" aria-label={said} title={said} onClick={() => {
    const done = (next: 'copied' | 'failed') => { setState(next); setTimeout(() => setState('idle'), 1500); };
    if (!navigator.clipboard) { done('failed'); return; }
    navigator.clipboard.writeText(text).then(() => done('copied'), () => done('failed'));
  }}><Icon name={state === 'copied' ? 'check' : 'copy'} size={14} /></button>;
}

// The Agent's prose, rendered without HTML. The caret marks the one message that
// is still arriving; it moves with each update and never fakes text that is not there.
function inlineNodes(nodes: Inline[], caret = false): ReactNode[] {
  const out: ReactNode[] = nodes.map((node, i) => {
    switch (node.type) {
      case 'text': return node.text;
      case 'break': return <br key={i} />;
      case 'strong': return <strong key={i}>{inlineNodes(node.children)}</strong>;
      case 'em': return <em key={i}>{inlineNodes(node.children)}</em>;
      case 'code': return <code key={i} className="md-inline">{node.text}</code>;
      case 'link': return <a key={i} href={node.href} target="_blank" rel="noreferrer noopener">{inlineNodes(node.children)}</a>;
    }
  });
  if (caret) out.push(<span key="caret" className="stream-caret" aria-hidden="true" />);
  return out;
}
function blockNode(block: Block, key: string, caret: boolean): ReactNode {
  switch (block.type) {
    case 'paragraph': return <p key={key}>{inlineNodes(block.children, caret)}</p>;
    case 'heading': return <p key={key} className="md-heading" data-level={block.level}>{inlineNodes(block.children, caret)}</p>;
    case 'code': return <div key={key} className="md-code-block">
      <div className="md-code-head"><span>{block.language || 'Code'}</span>{!caret && <CopyButton text={block.text} label="Copy code" />}</div>
      <pre className="md-code"><code>{block.text}{caret && <span className="stream-caret" aria-hidden="true" />}</code></pre>
    </div>;
    case 'list': {
      const items = block.items.map((item, i) => <li key={i}>{inlineNodes(item, caret && i === block.items.length - 1)}</li>);
      return block.ordered ? <ol key={key} className="md-list">{items}</ol> : <ul key={key} className="md-list">{items}</ul>;
    }
    case 'quote': return <blockquote key={key}>{inlineNodes(block.children, caret)}</blockquote>;
    case 'table': return <div key={key} className="md-table"><table>
      <thead><tr>{block.head.map((cell, c) => <th key={c} style={block.align[c] ? { textAlign: block.align[c]! } : undefined}>{inlineNodes(cell)}</th>)}</tr></thead>
      <tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c} style={block.align[c] ? { textAlign: block.align[c]! } : undefined}>{inlineNodes(cell, caret && r === block.rows.length - 1 && c === row.length - 1)}</td>)}</tr>)}</tbody>
    </table></div>;
    case 'rule': return <Fragment key={key}><hr className="md-rule" />{caret && <span className="stream-caret" aria-hidden="true" />}</Fragment>;
    default: return null;
  }
}
export function AgentMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  const blocks = markdownBlocks(text);
  return <div className={'turn-text' + (streaming ? ' streaming' : '')}>
    {blocks.map((block, i) => blockNode(block, String(i), streaming && i === blocks.length - 1))}
  </div>;
}
