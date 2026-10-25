import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { resize, type Region } from '../../src/shell-layout.js';

type Tabs = Extract<Region, { kind: 'tabs' }>;
export interface TabRender { title: (id: string) => ReactNode; label: (id: string) => string; container: (id: string) => HTMLElement }

// Where an owner view's element is attached while it shows. The element itself lives for
// as long as the view is in the layout, so moving it between groups, splits and the narrow
// surface never remounts an editor or a grid; while hidden it is outside the document.
export function Slot({ container, id, labelledBy }: { container: HTMLElement; id: string; labelledBy: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current!; slot.appendChild(container);
    return () => { if (container.parentElement === slot) slot.removeChild(container); };
  }, [container]);
  return <div ref={ref} id={id} className="shell-panel" role="tabpanel" aria-labelledby={labelledBy} />;
}

// A tab list that scrolls says which side has more (M6) and keeps the selected tab in sight.
export function useTabOverflow(ref: RefObject<HTMLElement | null>, selected: string, shown = true) {
  useLayoutEffect(() => {
    const list = ref.current; if (!list) return;
    const update = () => {
      const start = list.scrollLeft > 1, end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
      if (start || end) list.dataset.overflow = start && end ? 'both' : start ? 'start' : 'end'; else delete list.dataset.overflow;
    };
    update();
    const resized = new ResizeObserver(update), changed = new MutationObserver(update);
    resized.observe(list); changed.observe(list, { childList: true, subtree: true, characterData: true });
    list.addEventListener('scroll', update, { passive: true });
    return () => { resized.disconnect(); changed.disconnect(); list.removeEventListener('scroll', update); };
  }, [ref, shown]);
  useEffect(() => { ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [ref, selected]);
}

// A tab group: arrows, Home and End move the selection and focus together (WAI-ARIA tabs).
export function TabGroup({ group, name, selected, onSelect, onHeader, render }: { group: Tabs; name: string; selected: string; onSelect: (id: string) => void; onHeader: (element: HTMLDivElement | null) => void; render: TabRender }) {
  const list = useRef<HTMLDivElement>(null);
  useTabOverflow(list, selected);
  const base = 'shell-' + group.id.replace(/[^A-Za-z0-9_-]/g, '_'), index = Math.max(0, group.views.indexOf(selected));
  function move(event: KeyboardEvent<HTMLDivElement>) {
    const count = group.views.length;
    const next = { ArrowRight: (index + 1) % count, ArrowLeft: (index - 1 + count) % count, Home: 0, End: count - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault(); onSelect(group.views[next]);
    (list.current?.children[next] as HTMLElement | undefined)?.focus();
  }
  return <section className="shell-group" data-group={group.id}>
    <div className="shell-tabbar">
      <div ref={list} className="shell-tabs" role="tablist" aria-label={name} onKeyDown={move}>
        {group.views.map((id, i) => <button key={id} id={base + '-tab-' + i} role="tab" aria-selected={id === selected} aria-controls={base + '-panel'} tabIndex={id === selected ? 0 : -1} title={render.label(id)} onClick={() => onSelect(id)}>{render.title(id)}</button>)}
      </div>
      <div className="shell-header-slot" ref={onHeader} />
    </div>
    <Slot key={selected} container={render.container(selected)} id={base + '-panel'} labelledBy={base + '-tab-' + index} />
  </section>;
}

// A split: children share the axis by weight; each divider is a focusable window splitter.
export function Split({ region, weights, onResize, label, children }: { region: Extract<Region, { kind: 'split' }>; weights: number[]; onResize: (weights: number[]) => void; label: (index: number) => string; children: ReactNode[] }) {
  const box = useRef<HTMLDivElement>(null), row = region.axis === 'horizontal', total = weights.reduce((a, b) => a + b, 0);
  const keys = row ? { less: 'ArrowLeft', more: 'ArrowRight' } : { less: 'ArrowUp', more: 'ArrowDown' };
  function key(i: number, event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === keys.less ? -0.05 : event.key === keys.more ? 0.05 : event.key === 'Home' ? -1 : event.key === 'End' ? 1 : 0;
    if (!step) return;
    event.preventDefault(); onResize(resize(weights, i, step));
  }
  function drag(i: number, event: PointerEvent<HTMLDivElement>) {
    const element = box.current; if (!element) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const size = row ? element.clientWidth : element.clientHeight, start = row ? event.clientX : event.clientY, from = weights;
    const moveTo = (e: globalThis.PointerEvent) => onResize(resize(from, i, ((row ? e.clientX : e.clientY) - start) / size));
    const target = event.currentTarget, stop = () => { target.removeEventListener('pointermove', moveTo); target.removeEventListener('pointerup', stop); target.removeEventListener('pointercancel', stop); };
    target.addEventListener('pointermove', moveTo); target.addEventListener('pointerup', stop); target.addEventListener('pointercancel', stop);
  }
  const parts: ReactNode[] = [];
  children.forEach((child, i) => {
    if (i) {
      const before = weights.slice(0, i).reduce((a, b) => a + b, 0);
      parts.push(<div key={'divider-' + i} className="shell-divider" role="separator" tabIndex={0} aria-orientation={row ? 'vertical' : 'horizontal'} aria-label={label(i)}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(before / total * 100)} onKeyDown={e => key(i - 1, e)} onPointerDown={e => drag(i - 1, e)} />);
    }
    parts.push(<div key={'pane-' + i} className="shell-pane" style={{ flex: `${weights[i]} 1 0` }}>{child}</div>);
  });
  return <div ref={box} className="shell-split" data-axis={region.axis} data-split={region.id}>{parts}</div>;
}
