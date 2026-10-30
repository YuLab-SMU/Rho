// The project's one set of notes, shared by the person and every session: an ordinary
// Markdown file at the project root that Agents read and edit with their own tools. Each
// session started in Rho keeps one section, under a level-2 heading that names its task,
// with a marker line naming the session. That heading is the session's title in Studio.
export const projectNotesPath = 'project-notes.md';
// The protected resource is the browser tab: past this many bytes the notes are not read
// for titles, and sessions keep the titles their Agent or first message gave them.
export const notesLimits = { maxTitleBytes: 512 * 1024, titleChars: 80 };

const marker = /^\s*<!--\s*rho:session\s+([A-Za-z0-9_.:-]+)\s*-->\s*$/;
export const sessionMarker = (conversationId: string) => `<!-- rho:session ${conversationId} -->`;

// What a session started in Rho is told about the notes, appended to its Agent's own system
// prompt. It asks for the section; it grants nothing.
export function notesInstructions(conversationId: string): string {
  return [
    `This session was started in Rho as session ${conversationId}. The person reads your replies in Rho next to the project's files and its shared notes.`,
    `The project keeps one set of shared notes in ${projectNotesPath} at the project root, one section per session; the person and other sessions read and edit it too. The person follows your work through this section while you work, so keep it current as the work goes, in the language the person writes in:`,
    '- Write the section first, before you analyse anything: the heading, the Question and the Data & method you plan to use.',
    `- Start it with a level-2 heading that names the scientific task in a few words, and put ${sessionMarker(conversationId)} on the line right below it. Rho titles this session from that heading.`,
    '- Under it keep level-3 subsections with exactly these headings, in this order, written in English even when the content is not: Question, Data & method, Key results, Choices, Files, To do.',
    '- Link every project file you mention with its path from the project root, as [analysis.py](analysis.py). Rho reads these links to connect what you say to the files and their versions.',
    '- Data & method: one bullet for the data and one for each script, each linked, saying what it is and how it is used.',
    '- Key results: one bullet per finding, each linking the result files it rests on; embed a key figure on its own line as ![what it shows](path/to/figure.png).',
    '- Files: right after you write a result, table, figure or script, and before your next command, add a bullet as - [path](path) — what it holds; correct it when that changes. Do not leave this to the end.',
    '- Choices: when the analysis takes a choice that has a reasonable alternative (a test, a threshold, an exclusion, a model), go on with your choice and do not ask the person or wait. Where the alternative is cheap, compute it too. Write one bullet saying what you chose and what it gives, linking its results, with a nested bullet starting "Alternative:" that says what the other option gives, linking its results.',
    '- To do: a task list (- [ ] open, - [x] done).',
    `- Create ${projectNotesPath} if it does not exist. Change only your own section, and keep other sections and the person's edits as they are.`,
    '- Add each finding and choice when you have it, and update the section as results, files or to-dos change.',
  ].join('\n');
}

export interface NotesSection { title: string; line: number; conversationId: string | null }
// A heading as a person reads it, without its Markdown marks.
const plain = (heading: string) => heading.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '').replace(/\s+#+\s*$/, '').trim();

// The notes' level-2 sections, each with the session its marker names, if any. A marker
// counts in the lines before the section's first text; headings inside code are not sections.
export function notesSections(text: string): NotesSection[] {
  const out: NotesSection[] = [];
  let fence: string | null = null, open: NotesSection | null = null, looking = false;
  text.split('\n').forEach((line, index) => {
    const fenced = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenced) { fence = fence === null ? fenced[1]![0]! : fence === fenced[1]![0] ? null : fence; looking = false; return; }
    if (fence !== null) return;
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) { open = { title: plain(heading[1]!).slice(0, notesLimits.titleChars), line: index, conversationId: null }; out.push(open); looking = true; return; }
    if (/^#\s/.test(line)) { open = null; looking = false; return; }
    if (!looking || !open) return;
    const named = marker.exec(line);
    if (named) { if (!out.some(s => s.conversationId === named[1])) open.conversationId = named[1]!; looking = false; }
    else if (line.trim()) looking = false;
  });
  return out;
}

// Each session's title as its section names it.
export function sessionTitles(text: string): Map<string, string> {
  if (new TextEncoder().encode(text).length > notesLimits.maxTitleBytes) return new Map();
  return new Map(notesSections(text).flatMap(s => s.conversationId && s.title ? [[s.conversationId, s.title] as const] : []));
}
