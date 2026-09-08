import type { OutputEvent } from "./generated/OutputEvent";
/** Small text-only terminal interpreter. Unsupported escape controls are discarded. */
export class TerminalText {
  private rows: { char: string; color: string }[][] = [[]];
  private column = 0;
  private color = "";
  private pending = "";
  write(value: string) {
    const text = this.pending + value;
    this.pending = "";
    for (let i = 0; i < text.length; ) {
      const char = text[i];
      if (char === "\x1b") {
        const remaining = text.slice(i),
          csi = /^\x1b\[([\d;?]*)([ -/]*)([@-~])/.exec(remaining),
          osc = /^\x1b\][\s\S]*?(?:\x07|\x1b\\)/.exec(remaining);
        if (osc) {
          i += osc[0].length;
          continue;
        }
        if (csi) {
          const values = csi[1].split(";").map(Number),
            command = csi[3],
            row = this.rows.at(-1)!;
          if (command === "m")
            for (const code of values) {
              if (code === 0 || code === 39) this.color = "";
              else if (code >= 30 && code <= 37) this.color = `ansi-${code}`;
              else if (code >= 90 && code <= 97)
                this.color = `ansi-${code - 60}`;
            }
          if (command === "K") {
            if (values[0] === 2) {
              this.rows[this.rows.length - 1] = [];
            } else if (values[0] === 1) {
              for (let j = 0; j <= this.column; j++)
                row[j] = { char: " ", color: "" };
            } else row.splice(this.column);
          }
          i += csi[0].length;
          continue;
        }
        if (
          remaining.length < 1024 &&
          (remaining.startsWith("\x1b[") || remaining.startsWith("\x1b]"))
        ) {
          this.pending = remaining;
          break;
        }
        i += 2;
        continue;
      }
      i++;
      if (char === "\r") {
        this.column = 0;
        continue;
      }
      if (char === "\b") {
        this.column = Math.max(0, this.column - 1);
        continue;
      }
      if (char === "\n") {
        this.rows.push([]);
        this.column = 0;
        continue;
      }
      if (char === "\t") {
        const spaces = 8 - (this.column % 8);
        for (let j = 0; j < spaces; j++)
          this.rows.at(-1)![this.column++] = { char: " ", color: this.color };
        continue;
      }
      if (char.charCodeAt(0) < 32 || char === "\x7f") continue;
      this.rows.at(-1)![this.column++] = { char, color: this.color };
    }
  }
  result() {
    let text = "";
    const colors: { from: number; to: number; class: string }[] = [];
    for (let r = 0; r < this.rows.length; r++) {
      if (r) text += "\n";
      for (const cell of this.rows[r]) {
        const from = text.length;
        text += cell?.char ?? " ";
        if (cell?.color) {
          const last = colors.at(-1);
          if (last?.class === cell.color && last.to === from)
            last.to = text.length;
          else colors.push({ from, to: text.length, class: cell.color });
        }
      }
    }
    return { text, colors };
  }
}
const cache = new Map<
  string,
  {
    events: OutputEvent[];
    terminal: TerminalText;
    rendered?: ReturnType<TerminalText["result"]>;
  }
>();
export function observedText(id: string, events: OutputEvent[]) {
  let entry = cache.get(id);
  if (!entry || entry.events.length > events.length) {
    entry = { events: [], terminal: new TerminalText() };
    cache.set(id, entry);
  }
  if (entry.events === events && entry.rendered) return entry.rendered;
  for (const event of events.slice(entry.events.length))
    if (event.text) entry.terminal.write(event.text);
  entry.events = events;
  entry.rendered = entry.terminal.result();
  if (cache.size > 128) cache.delete(cache.keys().next().value!);
  return entry.rendered;
}
