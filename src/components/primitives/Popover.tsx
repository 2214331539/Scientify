import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './primitives.css';

/** A panel anchored under (or above) its trigger; Escape and outside clicks close it. */
export function Popover({
  anchor,
  label,
  width = 320,
  align = 'start',
  children,
  onClose,
}: {
  anchor: HTMLElement | null;
  label: string;
  width?: number;
  align?: 'start' | 'end';
  children: ReactNode;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!anchor || !panel) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const left = align === 'end' ? rect.right - panel.offsetWidth : rect.left;
      panel.style.left = `${Math.max(8, Math.min(left, innerWidth - panel.offsetWidth - 8))}px`;
      const below = rect.bottom + 6;
      panel.style.top =
        below + panel.offsetHeight > innerHeight - 8
          ? `${Math.max(8, rect.top - 6 - panel.offsetHeight)}px`
          : `${below}px`;
    };
    place();
    panel
      .querySelector<HTMLElement>('button:not(:disabled), input')
      ?.focus({ preventScroll: true });
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [anchor, align]);
  useEffect(() => {
    if (!anchor) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !anchor.contains(target)) close.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close.current();
      anchor.focus({ preventScroll: true });
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', close.current);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', close.current);
    };
  }, [anchor]);
  if (!anchor) return null;
  return createPortal(
    <div
      ref={ref}
      className="sf-popover sf-panel-popover"
      role="dialog"
      aria-label={label}
      data-native-overlay="true"
      style={{ width }}
    >
      {children}
    </div>,
    document.body,
  );
}
