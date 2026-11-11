import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { resize, type Region, type Side } from '../../src/shell-layout.js';
import { Icon } from '../icons.js';
import { FloatingMenu, MenuItems, under, type MenuItem, type MenuPoint } from './menu.js';

type Tabs = Extract<Region, { kind: 'tabs' }>;
// `name` is the tab's accessible name where its drawn title is laid out in parts.
export interface TabRender { title: (id: string) => ReactNode; label: (id: string) => string; name?: (id: string) => string; container: (id: string) => HTMLElement }
// What the person can do with a group's tabs besides choosing one: close a tab, open its menu,
// add a view into the group, maximize the group, and move the whole group by its empty strip.
export interface TabTools { close?: (id: string) => void; menu?: (id: string) => MenuItem[]; add?: () => ReactNode; movable?: boolean; maximized?: boolean; onMaximize?: () => void }
// Where a dragged tab or group would go: among a group's tabs (before one, or last), into the
// group, into a pane of its own on one side of it, or along one side of the whole page.
export type DropTarget = { group: string; zone: 'tab'; before: string | null } | { group: string; zone: 'center' | Side } | { edge: Side };
export type Dragged = { kind: 'view' | 'group'; id: string };
export interface TabDrag { dragging: Dragged | null; target: DropTarget | null; start(dragged: Dragged): void; end(): void; over(target: DropTarget | null): void; drop(target: DropTarget): void }
const dragType = 'application/x-rho-view';
const same = (a: DropTarget | null, b: DropTarget) => JSON.stringify(a) === JSON.stringify(b);
export const groupOfTarget = (target: DropTarget | null) => target && 'group' in target ? target.group : null;
// The side nearest the pointer when it is within a quarter of the panel from that edge.
function zoneAt(event: DragEvent<HTMLElement>): 'center' | Side {
  const box = event.currentTarget.getBoundingClientRect(), x = (event.clientX - box.left) / box.width, y = (event.clientY - box.top) / box.height;
  const [side, distance] = ([['left', x], ['right', 1 - x], ['top', y], ['bottom', 1 - y]] as Array<[Side, number]>).sort((a, b) => a[1] - b[1])[0];
  return distance < 0.25 ? side : 'center';
}

// Where an owner view's element is attached while it shows. The element itself lives for
// as long as the view is in the layout, so moving it between groups, splits and the narrow
// surface never remounts an editor or a grid; while hidden it is outside the document.
// Moving an element that holds focus blurs it, so a move carries the person's focus along:
// the old place records it on the way out and the new place gives it back.
const carried = new WeakMap<HTMLElement, HTMLElement>();
export function place(element: HTMLElement, target: HTMLElement) {
  const active = document.activeElement, focused = active instanceof HTMLElement && element.contains(active) ? active : carried.get(element);
  carried.delete(element);
  if (element.parentElement !== target) target.appendChild(element);
  if (focused && element.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
}
export function unplace(element: HTMLElement, from: HTMLElement) {
  if (element.parentElement !== from) return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && element.contains(active)) carried.set(element, active);
  from.removeChild(element);
}
export function Slot({ container, id, labelledBy }: { container: HTMLElement; id: string; labelledBy: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current!; place(container, slot);
    return () => unplace(container, slot);
  }, [container]);
  return <div ref={ref} id={id} className="shell-panel" role="tabpanel" aria-labelledby={labelledBy} />;
}

// A tab list that scrolls says which side has more and keeps the selected tab in sight.
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

// A tab group: arrows, Home and End move the selection and focus together (WAI-ARIA tabs);
// Delete closes the tab with focus, and the context menu key or Shift+F10 opens its menu. The
// tab shown has a close button; any tab closes from its menu or with a middle click, so a click
// meant to show a tab never lands on a close button.
export function TabGroup({ group, name, selected, onSelect, onHeader, render, drag, tools }: { group: Tabs; name: string; selected: string; onSelect: (id: string) => void; onHeader: (element: HTMLDivElement | null) => void; render: TabRender; drag?: TabDrag; tools?: TabTools }) {
  const list = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ id: string; at: MenuPoint; from: HTMLElement } | null>(null);
  useTabOverflow(list, selected);
  const base = 'shell-' + group.id.replace(/[^A-Za-z0-9_-]/g, '_'), index = Math.max(0, group.views.indexOf(selected));
  const tabElements = () => [...(list.current?.querySelectorAll<HTMLElement>('[role=tab]') ?? [])];
  function move(event: KeyboardEvent<HTMLDivElement>) {
    const count = group.views.length;
    const next = { ArrowRight: (index + 1) % count, ArrowLeft: (index - 1 + count) % count, Home: 0, End: count - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault(); onSelect(group.views[next]);
    tabElements()[next]?.focus();
  }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    if (event.key === 'Delete' && tools?.close) { event.preventDefault(); tools.close(id); }
    else if ((event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) && tools?.menu) { event.preventDefault(); setMenu({ id, at: under(event.currentTarget), from: event.currentTarget }); }
  }
  function tabMenu(event: MouseEvent<HTMLButtonElement>, id: string) {
    if (!tools?.menu) return;
    event.preventDefault(); setMenu({ id, at: { x: event.clientX, y: event.clientY }, from: event.currentTarget });
  }
  const closeMenu = (refocus: boolean) => { const from = menu?.from; setMenu(null); if (refocus && from?.isConnected) from.focus(); };
  // A group cannot be dropped on itself.
  const self = drag?.dragging?.kind === 'group' && drag.dragging.id === group.id;
  // Among the tabs, the drop goes before the first tab whose middle is past the pointer.
  function overTabs(event: DragEvent<HTMLDivElement>) {
    if (!drag?.dragging || self) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    const tabs = [...(list.current?.querySelectorAll<HTMLElement>('.shell-tab') ?? [])];
    const at = tabs.findIndex(tab => { const box = tab.getBoundingClientRect(); return event.clientX < box.left + box.width / 2; });
    const target: DropTarget = { group: group.id, zone: 'tab', before: at < 0 ? null : group.views[at] };
    if (!same(drag.target, target)) drag.over(target);
  }
  function overPanel(event: DragEvent<HTMLDivElement>) {
    if (!drag?.dragging || self) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    const target: DropTarget = { group: group.id, zone: zoneAt(event) };
    if (!same(drag.target, target)) drag.over(target);
  }
  const drop = (event: DragEvent<HTMLElement>) => { if (!drag?.dragging || !drag.target || groupOfTarget(drag.target) !== group.id) return; event.preventDefault(); drag.drop(drag.target); };
  const here = drag?.target && 'group' in drag.target && drag.target.group === group.id ? drag.target : null;
  const draggingView = drag?.dragging?.kind === 'view' ? drag.dragging.id : null;
  // The strip beside the tabs carries the whole group: drag it to move the group, double-click
  // it to maximize the group or bring the others back.
  const movable = !!drag && !!tools?.movable;
  return <section className="shell-group" data-group={group.id} data-dragging={self ? '' : undefined} data-maximized={tools?.maximized ? '' : undefined}>
    <div className="shell-tabbar">
      <div className="shell-tabstrip" style={{ '--tabs': group.views.length } as CSSProperties} onDragOver={overTabs} onDrop={drop} data-drop={here?.zone === 'tab' && here.before === null ? 'end' : undefined}>
        <div ref={list} className="shell-tabs" role="tablist" aria-label={name} onKeyDown={move}>
          {group.views.map((id, i) => <div key={id} className="shell-tab" data-dragging={draggingView === id ? '' : undefined} data-drop={here?.zone === 'tab' && here.before === id ? 'before' : undefined} data-closable={tools?.close ? '' : undefined}>
            <button id={base + '-tab-' + i} role="tab" aria-selected={id === selected} aria-controls={base + '-panel'} tabIndex={id === selected ? 0 : -1} title={render.label(id)} aria-label={render.name?.(id)} onClick={() => onSelect(id)}
              onKeyDown={event => tabKey(event, id)} onContextMenu={event => tabMenu(event, id)} aria-keyshortcuts={tools?.close ? 'Delete' : undefined}
              onMouseDown={event => { if (event.button === 1 && tools?.close) event.preventDefault(); }} onAuxClick={event => { if (event.button === 1 && tools?.close) { event.preventDefault(); tools.close(id); } }}
              draggable={!!drag} onDragStart={event => { if (!drag) return; event.stopPropagation(); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(dragType, id); drag.start({ kind: 'view', id }); }} onDragEnd={() => drag?.end()}>{render.title(id)}</button>
            {tools?.close && id === selected && <button className="shell-tab-close" tabIndex={-1} aria-hidden="true" title={'Close ' + render.label(id)} draggable={false} onClick={() => tools.close!(id)}><Icon name="close" size={12} stroke={2} /></button>}
          </div>)}
        </div>
        {tools?.add && <AddButton name={name} content={tools.add} />}
        <div className="shell-tabs-fill" aria-hidden="true" data-movable={movable ? '' : undefined} title={movable ? 'Drag to move these views together. Double-click to maximize.' : tools?.maximized ? 'Double-click to show every group' : undefined}
          draggable={movable} onDoubleClick={() => (movable || tools?.maximized) && tools?.onMaximize?.()}
          onDragStart={event => { if (!movable) return; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(dragType, group.id); if (list.current) event.dataTransfer.setDragImage(list.current, 16, 16); drag!.start({ kind: 'group', id: group.id }); }} onDragEnd={() => drag?.end()} />
      </div>
      <div className="shell-header-slot" ref={onHeader} />
      {tools?.maximized && <button className="shell-restore" title="Show every group again" onClick={tools.onMaximize}><Icon name="restore" size={14} />Restore</button>}
    </div>
    <div className="shell-body">
      <Slot key={selected} container={render.container(selected)} id={base + '-panel'} labelledBy={base + '-tab-' + index} />
      {drag?.dragging && !self && <div className="shell-drop" data-zone={here && here.zone !== 'tab' ? here.zone : undefined} onDragOver={overPanel} onDrop={drop} aria-hidden="true"
        onDragLeave={event => { if (here && !event.currentTarget.contains(event.relatedTarget as Node | null)) drag.over(null); }}><div className="shell-drop-preview" /></div>}
    </div>
    {menu && tools?.menu && <FloatingMenu at={menu.at} anchor={menu.from} label={render.label(menu.id)} onClose={closeMenu}><MenuItems items={tools.menu(menu.id)} /></FloatingMenu>}
  </section>;
}

// The + after a group's tabs: what can be put into that group, in a menu over the page.
export function AddButton({ name, content }: { name: string; content: () => ReactNode }) {
  const button = useRef<HTMLButtonElement>(null), [at, setAt] = useState<MenuPoint | null>(null);
  return <>
    <button ref={button} className="shell-tab-add" aria-label={'Add a view to ' + name} title="Add a view here" aria-haspopup="dialog" aria-expanded={!!at}
      onClick={event => setAt(at ? null : under(event.currentTarget))}><Icon name="plus" size={15} stroke={1.8} /></button>
    {at && <FloatingMenu at={at} anchor={button.current} label={'Add a view to ' + name} role="dialog" className="add-into" onClose={refocus => { setAt(null); if (refocus) button.current?.focus(); }}>{content()}</FloatingMenu>}
  </>;
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
