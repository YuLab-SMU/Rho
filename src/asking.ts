// What a person asks about, in the words the Agent receives: a passage of its answer, quoted,
// or a file as a message left it, named by the kept version when there is one.
export type Asking = { kind: 'passage'; text: string } | { kind: 'file'; path: string; title: string; resource?: { id: string; version: string } | null };
export function askText(about: Asking, question: string) {
  const head = about.kind === 'passage'
    ? 'About this part of your answer:\n' + about.text.trim().split('\n').map(line => '> ' + line).join('\n')
    : 'About ' + about.path + (about.resource ? ' as this message left it (resource ' + about.resource.id + '@' + about.resource.version + ')' : '') + ':';
  return head + '\n\n' + question.trim();
}
// The same message read back: what it was about and the person's own question. A message not
// written this way is its own question.
export function askedAbout(text: string): { about: string | null; quote: string | null; question: string } {
  const split = text.indexOf('\n\n');
  const head = split < 0 ? '' : text.slice(0, split), question = split < 0 ? text : text.slice(split + 2).trim();
  if (head.startsWith('About this part of your answer:\n')) return { about: null, quote: head.split('\n').slice(1).map(line => line.replace(/^> ?/, '')).join('\n'), question };
  const file = /^About (.+?)(?: as this message left it \(resource [^)\n]+\))?:$/.exec(head);
  return file ? { about: file[1]!, quote: null, question } : { about: null, quote: null, question: text.trim() };
}
