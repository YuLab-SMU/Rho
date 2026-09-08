import { rLanguage, parser } from "@codincod/codemirror-lang-r";
import {
  LanguageSupport,
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import { autocompletion, completeAnyWord } from "@codemirror/autocomplete";
import type { CompletionSource } from "@codemirror/autocomplete";
import { Decoration, ViewPlugin } from "@codemirror/view";
import type { EditorView, ViewUpdate, DecorationSet } from "@codemirror/view";
import { tags, styleTags } from "@lezer/highlight";
export const rTheme = HighlightStyle.define([
  { tag: tags.keyword, color: "#7946a2" },
  { tag: tags.function(tags.variableName), color: "#215dad" },
  { tag: tags.definition(tags.variableName), color: "#202936" },
  { tag: tags.namespace, color: "#7c5227" },
  {
    tag: [tags.propertyName, tags.labelName, tags.attributeName],
    color: "#785014",
  },
  { tag: [tags.string, tags.special(tags.string)], color: "#236943" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#94531d" },
  { tag: tags.comment, color: "#65717d", fontStyle: "italic" },
  { tag: tags.operator, color: "#596378" },
]);
const rhoRLanguage = rLanguage.configure({
  props: [styleTags({ "ParamName/Identifier": tags.attributeName })],
});
const functionNames = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.collect(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      )
        this.decorations = this.collect(update.view);
    }
    collect(view: EditorView) {
      const ranges: ReturnType<Decoration["range"]>[] = [];
      for (const visible of view.visibleRanges)
        syntaxTree(view.state).iterate({
          from: visible.from,
          to: visible.to,
          enter({ node }) {
            if (
              node.name === "Assignment" &&
              node.getChild("FunctionDefinition")
            ) {
              const target = node.getChild("AssignTarget");
              if (target)
                ranges.push(
                  Decoration.mark({ class: "cm-r-definition" }).range(
                    target.from,
                    target.to,
                  ),
                );
            }
          },
        });
      return Decoration.set(ranges, true);
    }
  },
  { decorations: (v) => v.decorations },
);
export const isR = (path: string | null) =>
  path === null || /\.[rR]$/.test(path);
const keywords = [
  "if",
  "else",
  "for",
  "while",
  "repeat",
  "function",
  "next",
  "break",
  "in",
  "TRUE",
  "FALSE",
  "NULL",
  "NA",
  "NaN",
  "Inf",
];
export function rSupport(objects: () => string[] = () => []) {
  const observed: CompletionSource = (context) => {
    const word = context.matchBefore(/[\p{L}\p{N}_.]+/u);
    if (!word || (!context.explicit && word.from === word.to)) return null;
    return {
      from: word.from,
      options: [
        ...keywords.map((label) => ({ label, type: "keyword" })),
        ...objects().map((label) => ({
          label,
          type: "variable",
          detail: "Last observed object",
        })),
      ],
      validFor: /^[\p{L}\p{N}_.]*$/u,
    };
  };
  return [
    new LanguageSupport(rhoRLanguage),
    syntaxHighlighting(rTheme),
    functionNames,
    autocompletion({ override: [observed, completeAnyWord] }),
  ];
}
/** An editing aid, never an assertion that R has parsed the code. */
export function locallyIncomplete(code: string) {
  const raw = /(?:^|[^\w.])[rR]"(-*)([([{])/g;
  for (let match = raw.exec(code); match; match = raw.exec(code)) {
    const closing =
      ({ "(": ")", "[": "]", "{": "}" } as Record<string, string>)[match[2]] +
      match[1] +
      '"';
    const end = code.indexOf(closing, raw.lastIndex);
    if (end < 0) return true;
    raw.lastIndex = end + closing.length;
  }
  let incomplete = false;
  parser.parse(code).iterate({
    enter(node) {
      if (node.type.isError && node.to >= code.trimEnd().length)
        incomplete = true;
    },
  });
  return (
    incomplete || /(?:<-|<<-|\|>|%[^%]*%|[+*/^=~,:$@-])\s*(?:#.*)?$/.test(code)
  );
}
