// A box to write code in, for views that run it (the Notebook's cells). It is the editor Rho
// already has for scripts, without a file behind it: the language's colours as the editor and
// rendered code have them, matching and closing brackets, indentation, undo, and a list of names
// from whoever made the box (the Notebook asks the live session). The view owns the frame, the
// font and the room around the text; this owns what happens inside it.
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import type { ShellServices } from '../src/ui-contract.js';
import { languageExtensions } from './languages.js';

type Make = NonNullable<ShellServices['codeBox']>;
// The file a language's code would be in, for the extensions chosen by file name.
const files: Record<string, string> = { r: 'cell.R', python: 'cell.py' };
// What each kind of name is called beside it in the list; a name of no known kind says nothing.
const kinds: Record<string, string> = { variable: 'value', function: 'function', property: 'part', argument: 'argument', keyword: 'keyword', file: 'file' };
// Names are offered unasked once a name is typedBeforeNames letters long (and at once after $, @,
// ::, a dot in Python or an open quote in a subscript); at most `names` are listed.
export const codeBoxLimits = { typedBeforeNames: 3, names: 200 };

export const codeBox: Make = async (parent, options) => {
  const [{ EditorState, Compartment, Prec }, { EditorView, keymap, placeholder, tooltips }, { bracketMatching, indentOnInput, indentUnit }, { autocompletion, closeBrackets, closeBracketsKeymap, acceptCompletion, closeCompletion, startCompletion, completionStatus }, { history, historyKeymap, defaultKeymap, indentMore, indentLess, temporarilySetTabFocusMode }] = await Promise.all([
    import('@codemirror/state'), import('@codemirror/view'), import('@codemirror/language'), import('@codemirror/autocomplete'), import('@codemirror/commands')]);
  let current = options.language;
  const language = new Compartment(), example = new Compartment(), named = new Compartment();
  // A language that fails to load leaves the code plain; it is still written and run.
  const of = async (name: string): Promise<Extension[]> => [...await languageExtensions(files[name] ?? '').catch(() => []), indentUnit.of(name === 'r' ? '  ' : '    ')];
  const label = (text: string) => EditorView.contentAttributes.of({ 'aria-label': text, 'aria-multiline': 'true', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' });

  const names = async (context: CompletionContext): Promise<CompletionResult | null> => {
    if (!options.complete) return null;
    const line = context.state.doc.lineAt(context.pos), before = line.text.slice(0, context.pos - line.from);
    const word = before.match(/[\p{L}_.][\p{L}\p{N}_.]*$/u)?.[0] ?? '';
    const reaching = /(\$|@|::|\[\s*["'])$/.test(before) || (current === 'python' && /[\p{L}\p{N}_\])]\.$/u.test(before));
    if (!context.explicit && !reaching && word.length < codeBoxLimits.typedBeforeNames) return null;
    const got = await options.complete(before).catch(() => null);
    if (!got || context.aborted || !got.items.length) return null;
    const r = current === 'r';
    return {
      from: line.from + Math.max(0, Math.min(got.from, before.length)), validFor: r ? /^[\p{L}\p{N}_.]*$/u : /^[\p{L}\p{N}_]*$/u,
      options: got.items.slice(0, codeBoxLimits.names).map(item => ({ label: item.label, detail: kinds[item.type] ?? '',
        // An argument is written with the sign that gives it a value; the session's own values come first.
        ...(item.type === 'argument' ? { apply: item.label + (r ? ' = ' : '=') } : {}), boost: item.type === 'argument' ? 2 : item.type === 'variable' || item.type === 'property' ? 1 : 0 })),
    };
  };

  const look = EditorView.theme({
    '&': { background: 'transparent', color: 'inherit' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit', overflow: 'auto' },
    '.cm-content': { padding: '0', caretColor: 'var(--color-ink)' },
    '.cm-line': { padding: '0' },
    '.cm-placeholder': { color: 'var(--color-meta)' },
    '.cm-cursor': { borderLeftColor: 'var(--color-ink)' },
    '&.cm-focused .cm-matchingBracket': { background: 'var(--color-accent-soft)', outline: '1px solid var(--color-accent)', borderRadius: '2px' },
    '&.cm-focused .cm-nonmatchingBracket': { background: 'transparent', color: 'var(--color-failed)' },
    '.cm-tooltip': { border: '1px solid var(--color-hairline-strong)', borderRadius: '8px', background: 'var(--color-surface)', boxShadow: '0 8px 24px rgb(0 0 0 / 14%)', color: 'var(--color-ink)', overflow: 'hidden' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': { maxHeight: '15em', minWidth: '13em', fontFamily: 'var(--font-mono)', fontSize: '12.5px' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px', lineHeight: '1.5' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { background: 'var(--color-selected)', color: 'var(--color-ink)' },
    '.cm-completionDetail': { float: 'right', marginLeft: '2em', color: 'var(--color-meta)', fontFamily: 'var(--font-ui)', fontSize: '11.5px', fontStyle: 'normal' },
    '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '650', color: 'var(--color-accent-strong)' },
  });

  const view = new EditorView({ parent, state: EditorState.create({ doc: options.value, extensions: [
    // Running is the view's: Shift+Enter, or Enter with Ctrl or Cmd, before a new line is made.
    // Escape closes the list of names when it is open. Otherwise it leaves the box where the view
    // gives a way to, and where it does not, the next Tab moves on from the box.
    Prec.highest(keymap.of([...['Shift-Enter', 'Mod-Enter'].map(key => ({ key, preventDefault: true, run: () => { options.onRun?.(); return true; } })),
      { key: 'Escape', run: target => {
        if (completionStatus(target.state) === 'active') return closeCompletion(target);
        closeCompletion(target);
        if (options.onCancel) { options.onCancel(); return true; }
        return temporarilySetTabFocusMode(target);
      } }])),
    history(), bracketMatching(), closeBrackets(), indentOnInput(), EditorState.tabSize.of(4), options.wrap ? EditorView.lineWrapping : [],
    language.of(await of(current)), example.of(options.placeholder ? placeholder(options.placeholder) : []), named.of(label(options.label)),
    // The list is drawn on the page itself, so the view that holds the box does not cut it off.
    autocompletion({ override: [names], icons: false, maxRenderedOptions: 100 }), tooltips({ parent: document.body }),
    keymap.of([
      // Tab takes the name chosen in the list; else it indents at the start of a line or over a
      // selection, and after something typed it offers names.
      { key: 'Tab', shift: indentLess, run: target => {
        if (completionStatus(target.state) === 'active') return acceptCompletion(target);
        const { main } = target.state.selection, line = target.state.doc.lineAt(main.head);
        return !main.empty || !/\S/.test(line.text.slice(0, main.head - line.from)) ? indentMore(target) : startCompletion(target);
      } },
      ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap,
    ]),
    EditorView.updateListener.of(update => { if (update.docChanged) options.onChange(update.state.doc.toString()); }),
    look,
  ] }) });

  return {
    setValue(value) { if (value !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: { anchor: value.length } }); },
    update(now) {
      if (now.label !== undefined) view.dispatch({ effects: named.reconfigure(label(now.label)) });
      if (now.placeholder !== undefined) view.dispatch({ effects: example.reconfigure(now.placeholder ? placeholder(now.placeholder) : []) });
      if (now.language !== undefined && now.language !== current) { const next = current = now.language; void of(next).then(extensions => { if (current === next) view.dispatch({ effects: language.reconfigure(extensions) }); }); }
    },
    focus(at) { view.focus(); view.dispatch({ selection: { anchor: at ? view.posAtCoords(at, false) : view.state.doc.length }, scrollIntoView: !at }); },
    destroy() { view.destroy(); },
  };
};
