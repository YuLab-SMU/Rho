// Compact line diff for the Agent file review surface.
// In-repo on purpose: no new dependency. LCS over lines, then hunks with
// symmetric context. Callers pass a total-line budget; over budget the
// caller falls back to the raw proposed-content view with the reason shown.

export interface DiffLine {
  readonly kind: "context" | "add" | "remove";
  readonly text: string;
}

export interface DiffHunk {
  readonly beforeStart: number;
  readonly afterStart: number;
  readonly lines: readonly DiffLine[];
}

export interface LineDiff {
  readonly hunks: readonly DiffHunk[];
  readonly additions: number;
  readonly removals: number;
}

interface RawEdit {
  readonly kind: "context" | "add" | "remove";
  readonly text: string;
  readonly beforeLine: number;
  readonly afterLine: number;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline produces a final empty segment that is not a line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lcsRows(before: readonly string[], after: readonly string[]): RawEdit[] {
  const rows = before.length;
  const columns = after.length;
  const table = new Uint32Array((rows + 1) * (columns + 1));
  const at = (row: number, column: number) => row * (columns + 1) + column;
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[at(row, column)] = before[row] === after[column]
        ? (table[at(row + 1, column + 1)] ?? 0) + 1
        : Math.max(table[at(row + 1, column)] ?? 0, table[at(row, column + 1)] ?? 0);
    }
  }
  const edits: RawEdit[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (before[row] === after[column]) {
      edits.push({ kind: "context", text: before[row]!, beforeLine: row + 1, afterLine: column + 1 });
      row += 1;
      column += 1;
    } else if ((table[at(row + 1, column)] ?? 0) >= (table[at(row, column + 1)] ?? 0)) {
      edits.push({ kind: "remove", text: before[row]!, beforeLine: row + 1, afterLine: 0 });
      row += 1;
    } else {
      edits.push({ kind: "add", text: after[column]!, beforeLine: 0, afterLine: column + 1 });
      column += 1;
    }
  }
  while (row < rows) {
    edits.push({ kind: "remove", text: before[row]!, beforeLine: row + 1, afterLine: 0 });
    row += 1;
  }
  while (column < columns) {
    edits.push({ kind: "add", text: after[column]!, beforeLine: 0, afterLine: column + 1 });
    column += 1;
  }
  return edits;
}

export const LINE_DIFF_TOTAL_BUDGET = 2_000;

export function computeLineDiff(
  before: string,
  after: string,
  contextLines = 3,
): LineDiff | null {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  if (beforeLines.length + afterLines.length > LINE_DIFF_TOTAL_BUDGET) return null;
  const edits = lcsRows(beforeLines, afterLines);
  let additions = 0;
  let removals = 0;
  for (const edit of edits) {
    if (edit.kind === "add") additions += 1;
    if (edit.kind === "remove") removals += 1;
  }

  // Group edits into hunks with symmetric context, merging hunks whose
  // context windows overlap.
  const hunks: DiffHunk[] = [];
  let index = 0;
  while (index < edits.length) {
    while (index < edits.length && edits[index]!.kind === "context") index += 1;
    if (index >= edits.length) break;
    const hunkStart = Math.max(0, index - contextLines);
    let hunkEnd = index;
    let lastChange = index;
    let cursor = index;
    while (cursor < edits.length) {
      if (edits[cursor]!.kind !== "context") {
        lastChange = cursor;
        cursor += 1;
        continue;
      }
      // A gap of more than 2 * contextLines context lines closes the hunk.
      let gap = 0;
      let lookahead = cursor;
      while (lookahead < edits.length && edits[lookahead]!.kind === "context") {
        gap += 1;
        lookahead += 1;
      }
      if (lookahead >= edits.length) {
        // Keep up to contextLines trailing context lines after the last change.
        hunkEnd = Math.min(lastChange + 1 + contextLines, edits.length);
        break;
      }
      if (gap > contextLines * 2) {
        hunkEnd = Math.min(cursor + contextLines, edits.length);
        break;
      }
      lastChange = lookahead - 1;
      cursor = lookahead;
    }
    if (cursor >= edits.length) hunkEnd = Math.min(lastChange + 1 + contextLines, edits.length);
    const slice = edits.slice(hunkStart, hunkEnd);
    hunks.push({
      beforeStart: slice.find((line) => line.beforeLine > 0)?.beforeLine ?? 1,
      afterStart: slice.find((line) => line.afterLine > 0)?.afterLine ?? 1,
      lines: slice.map((line) => ({ kind: line.kind, text: line.text })),
    });
    index = hunkEnd;
  }
  return { hunks, additions, removals };
}
