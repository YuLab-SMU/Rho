import { useEffect, type RefObject } from 'react';

// Small menus that open in place: a press outside closes them, and the arrows step through
// their items without leaving them.
export function useOutside(open: boolean, root: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
}

export function stepFocus(menu: HTMLElement, from: Element | null, by: number) {
  const items = [...menu.querySelectorAll<HTMLElement>('[data-item]:not(:disabled)')];
  if (!items.length) return;
  const at = items.indexOf(from as HTMLElement);
  items[at < 0 ? (by > 0 ? 0 : items.length - 1) : (at + by + items.length) % items.length].focus();
}
