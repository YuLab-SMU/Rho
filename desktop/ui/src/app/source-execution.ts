export interface SourceExecutionRange {
  readonly start_line: number;
  readonly start_column: number;
  readonly end_line: number;
  readonly end_column: number;
}

export interface SourceExecution {
  readonly kind: "selection" | "expression";
  readonly code: string;
  readonly start: number;
  readonly end: number;
  readonly range: SourceExecutionRange;
  readonly next_cursor: number | null;
}

export interface SourceExecutionSubmission extends SourceExecution {
  readonly source_path: string;
  readonly document_version: number;
}

interface SourceLine {
  readonly start: number;
  readonly end: number;
  readonly delimiterEnd: number;
  readonly text: string;
}

interface LexicalState {
  quote: "\"" | "'" | "`" | null;
  escaped: boolean;
  parentheses: number;
  brackets: number;
  braces: number;
  invalid: boolean;
}

function clampOffset(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(length, Math.trunc(value)));
}

function sourceLines(value: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start <= value.length) {
    const nextBreak = value.indexOf("\n", start);
    const delimiterStart = nextBreak < 0 ? value.length : nextBreak;
    const end = delimiterStart > start && value[delimiterStart - 1] === "\r"
      ? delimiterStart - 1
      : delimiterStart;
    lines.push({
      start,
      end,
      delimiterEnd: nextBreak < 0 ? value.length : nextBreak + 1,
      text: value.slice(start, end),
    });
    if (nextBreak < 0) break;
    start = nextBreak + 1;
  }
  return lines;
}

function positionAt(value: string, offset: number): { readonly line: number; readonly column: number } {
  const clamped = clampOffset(offset, value.length);
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < clamped; index += 1) {
    if (value[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

function rangeAt(value: string, start: number, end: number): SourceExecutionRange {
  const first = positionAt(value, start);
  const last = positionAt(value, end);
  return {
    start_line: first.line,
    start_column: first.column,
    end_line: last.line,
    end_column: last.column,
  };
}

function scanLine(text: string, state: LexicalState): string {
  let visible = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (state.quote != null) {
      visible += character;
      if (state.escaped) state.escaped = false;
      else if (character === "\\") state.escaped = true;
      else if (character === state.quote) state.quote = null;
      continue;
    }
    if (character === "#") break;
    visible += character;
    if (character === "\"" || character === "'" || character === "`") {
      state.quote = character;
      state.escaped = false;
      continue;
    }
    if (character === "(") state.parentheses += 1;
    else if (character === ")") {
      if (state.parentheses === 0) state.invalid = true;
      else state.parentheses -= 1;
    } else if (character === "[") state.brackets += 1;
    else if (character === "]") {
      if (state.brackets === 0) state.invalid = true;
      else state.brackets -= 1;
    } else if (character === "{") state.braces += 1;
    else if (character === "}") {
      if (state.braces === 0) state.invalid = true;
      else state.braces -= 1;
    }
  }
  return visible;
}

function codeBeforeComment(text: string): string {
  let quote: "\"" | "'" | "`" | null = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote != null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "#") return text.slice(0, index);
    if (character === "\"" || character === "'" || character === "`") quote = character;
  }
  return text;
}

function hasExecutableCode(code: string): boolean {
  return code.split(/\r?\n/u).some((line) => codeBeforeComment(line).trim().length > 0);
}

function requiresFollowingLine(code: string): boolean {
  const normalized = code.trim();
  if (!normalized) return false;
  if (/^(?:if|for|while)\s*\(.*\)\s*$/.test(normalized)) return true;
  if (/(?:^|(?:<-|<<-|=)\s*)function\s*\(.*\)\s*$/.test(normalized)) return true;
  if (/^repeat\s*$/.test(normalized)) return true;
  return /(?:<<-|<-|->>|->|\|>|%[^%\r\n]*%|%%|%\/%|%\*%|&&|\|\||==|!=|<=|>=|:::{0,1}|[=+\-*/^&|<>~:$@,])\s*$/.test(normalized);
}

function nextSignificantLineBeginsElse(lines: readonly SourceLine[], current: number): boolean {
  for (let index = current + 1; index < lines.length; index += 1) {
    const code = codeBeforeComment(lines[index]!.text).trim();
    if (!code) continue;
    return /^else\b/.test(code);
  }
  return false;
}

function cursorLineIndex(lines: readonly SourceLine[], cursor: number): number {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (cursor >= line.start && (cursor <= line.end || cursor < line.delimiterEnd)) return index;
  }
  return Math.max(0, lines.length - 1);
}

function nextExecutableLineStart(
  value: string,
  lines: readonly SourceLine[],
  afterLine: number,
): number {
  for (let index = afterLine + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (hasExecutableCode(line.text)) return line.start;
  }
  return value.length;
}

function expressionOffsetsAt(value: string, cursor: number): { readonly start: number; readonly end: number; readonly next: number } | null {
  const lines = sourceLines(value);
  const cursorLine = cursorLineIndex(lines, cursor);
  const state: LexicalState = {
    quote: null,
    escaped: false,
    parentheses: 0,
    brackets: 0,
    braces: 0,
    invalid: false,
  };
  let expressionStart = 0;
  let continuation = false;
  for (let index = 0; index < lines.length; index += 1) {
    const visible = scanLine(lines[index]!.text, state);
    if (visible.trim()) continuation = requiresFollowingLine(visible);
    const balanced = state.quote == null && state.parentheses === 0 && state.brackets === 0 && state.braces === 0;
    const complete = balanced && !state.invalid && !continuation &&
      !nextSignificantLineBeginsElse(lines, index);
    if (!complete) continue;
    if (cursorLine >= expressionStart && cursorLine <= index) {
      const first = lines[expressionStart]!;
      const last = lines[index]!;
      return {
        start: first.start,
        end: last.end,
        next: nextExecutableLineStart(value, lines, index),
      };
    }
    expressionStart = index + 1;
    state.invalid = false;
    continuation = false;
  }
  return null;
}

export function sourceGapNavigationAt(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): number | null {
  const first = clampOffset(selectionStart, value.length);
  const second = clampOffset(selectionEnd, value.length);
  if (first !== second) return null;
  const lines = sourceLines(value);
  const lineIndex = cursorLineIndex(lines, first);
  if (hasExecutableCode(lines[lineIndex]!.text)) return null;
  return nextExecutableLineStart(value, lines, lineIndex);
}

export function sourceExecutionAt(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): SourceExecution | null {
  const first = clampOffset(selectionStart, value.length);
  const second = clampOffset(selectionEnd, value.length);
  const start = Math.min(first, second);
  const end = Math.max(first, second);
  if (start !== end) {
    const code = value.slice(start, end);
    return hasExecutableCode(code)
      ? { kind: "selection", code, start, end, range: rangeAt(value, start, end), next_cursor: null }
      : null;
  }

  const expression = expressionOffsetsAt(value, start);
  if (expression == null) return null;
  const code = value.slice(expression.start, expression.end);
  if (!hasExecutableCode(code)) return null;
  return {
    kind: "expression",
    code,
    start: expression.start,
    end: expression.end,
    range: rangeAt(value, expression.start, expression.end),
    next_cursor: expression.next,
  };
}
