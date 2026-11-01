import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '../icons.js';

export interface MenuItem { id: string; label: string; icon: IconName; run: () => void; keys?: string }
export type MenuPoint = { x: number; y: number; above?: number };
// Where a menu opens for a control: under it, or above it when the window has no room below.
export const under = (element: Element): MenuPoint => { const box = element.getBoundingClientRect(); return { x: box.left, y: box.bottom + 4, above: box.top - 4 }; };

// A menu over the page, at a point or under a control, kept inside the window. It is outside
// the pane it belongs to, so a pane's edge never cuts it. A press outside it, Escape or Tab
// closes it; the arrows step through its buttons; a choice closes it.
export function FloatingMenu({ at, label, anchor, onClose, className, role = 'menu', children }: { at: MenuPoint; label: string; anchor?: Element | null; onClose: (refocus: boolean) => void; className?: string; role?: 'menu' | 'dialog'; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current!, width = menu.offsetWidth, below = innerHeight - at.y - 8, over = (at.above ?? at.y) - 8;
    const up = below < Math.min(menu.scrollHeight, 320) && over > below;
    menu.style.left = Math.max(8, Math.min(at.x, innerWidth - width - 8)) + 'px';
    menu.style.maxHeight = (up ? over : below) + 'px';
    if (up) menu.style.bottom = innerHeight - (at.above ?? at.y) + 'px'; else menu.style.top = at.y + 'px';
    menu.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const away = (event: PointerEvent) => { const target = event.target as Node; if (!ref.current?.contains(target) && !anchor?.contains(target)) onClose(false); };
    const gone = () => onClose(false);
    document.addEventListener('pointerdown', away, true); addEventListener('resize', gone); addEventListener('blur', gone);
    return () => { document.removeEventListener('pointerdown', away, true); removeEventListener('resize', gone); removeEventListener('blur', gone); };
  }, [anchor]);
  function key(event: KeyboardEvent<HTMLDivElement>) {
    const items = [...ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled)')], at = items.indexOf(document.activeElement as HTMLElement);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true); }
    else if (event.key === 'Tab') onClose(false);
    else if (next !== undefined && items.length) { event.preventDefault(); items[(next + items.length) % items.length].focus(); }
  }
  return createPortal(<div ref={ref} className={'floating-menu' + (className ? ' ' + className : '')} role={role} aria-label={label} onKeyDown={key}
    onClick={event => { if ((event.target as HTMLElement).closest('button')) onClose(false); }}>{children}</div>, document.body);
}

export function MenuItems({ items }: { items: MenuItem[] }) {
  return <>{items.map(item => <button key={item.id} role="menuitem" onClick={item.run}><Icon name={item.icon} size={15} /><span>{item.label}</span>{item.keys && <kbd>{item.keys}</kbd>}</button>)}</>;
}
