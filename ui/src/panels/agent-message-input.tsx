import { useLayoutEffect, useRef } from "react";
import type { ClipboardEventHandler } from "react";

interface Props {
  label?: string;
  maxLength?: number;
  value: string;
  placeholder: string;
  readOnly: boolean;
  canSubmit: boolean;
  onChange(text: string): void;
  onCompositionCommit(text: string): void;
  onComposingChange(active: boolean): void;
  onSubmit(): void;
  onEscape(): void;
  onMention(): void;
  onPaste: ClipboardEventHandler<HTMLTextAreaElement>;
}

/** The browser owns the preedit range. Task snapshots only reconcile committed
 * text; the external store intentionally batches its React notifications. */
export function AgentMessageInput(props: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const initial = useRef(props.value), committed = useRef(props.value);
  const composing = useRef(false), endedAt = useRef(-Infinity);
  const measured = useRef({ text: "", width: -1 });

  function resize() {
    const element = input.current;
    if (!element || composing.current) return;
    const width = element.clientWidth;
    if (measured.current.text === element.value && measured.current.width === width) return;
    measured.current = { text: element.value, width };
    element.style.height = "0px";
    element.style.height = `${Math.min(180, Math.max(54, element.scrollHeight))}px`;
  }
  useLayoutEffect(() => {
    const element = input.current;
    if (!element || composing.current) return;
    if (element.value !== props.value) element.value = props.value;
    committed.current = props.value;
    resize();
  });
  useLayoutEffect(() => {
    const element = input.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== measured.current.width) resize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  function commit(text: string, composition = false) {
    if (text === committed.current) return;
    committed.current = text;
    if (composition) props.onCompositionCommit(text);
    else if (!props.readOnly) props.onChange(text);
    if (!props.readOnly && text.endsWith("@")) props.onMention();
  }

  return <textarea ref={input} aria-label={props.label ?? "Agent message"} placeholder={props.placeholder}
    defaultValue={initial.current} readOnly={props.readOnly} maxLength={props.maxLength ?? 32768} rows={3}
    onCompositionStart={() => { composing.current = true; endedAt.current = -Infinity; props.onComposingChange(true); }}
    onCompositionEnd={event => {
      composing.current = false; endedAt.current = performance.now();
      commit(event.currentTarget.value, true); props.onComposingChange(false); resize();
    }}
    onChange={event => {
      if (composing.current || (event.nativeEvent as InputEvent).isComposing) return;
      commit(event.currentTarget.value); resize();
    }}
    onKeyDown={event => {
      const nativeComposition = composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
      const endingEnter = !nativeComposition && event.key === "Enter" && performance.now() - endedAt.current < 100;
      if (!nativeComposition) endedAt.current = -Infinity;
      if (nativeComposition) { event.stopPropagation(); return; }
      if (endingEnter) { event.preventDefault(); return; }
      if (event.key === "Escape") props.onEscape();
      else if (event.key === "Enter" && !event.shiftKey && props.canSubmit) { event.preventDefault(); props.onSubmit(); }
    }}
    onPaste={props.onPaste} />;
}
