import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './primitives.css';

export type MenuAnchor = { x: number; y: number; trigger?: HTMLElement | null };

/** Shared pointer/keyboard menu. Exit retention is visual only; actions run immediately. */
export function Menu({
  anchor,
  label,
  children,
  onClose,
}: {
  anchor: MenuAnchor | null;
  label: string;
  children: ReactNode;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [present, setPresent] = useState(!!anchor);
  const lastAnchor = useRef(anchor);
  const content = useRef(children);
  if (anchor) content.current = children;
  const close = useRef(onClose);
  close.current = onClose;
  if (anchor) lastAnchor.current = anchor;

  useLayoutEffect(() => {
    if (anchor) {
      setPresent(true);
      return;
    }
    if (!ref.current || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setPresent(false);
      return;
    }
    const duration =
      parseFloat(getComputedStyle(ref.current).getPropertyValue('--sf-motion-exit')) || 0;
    const timer = window.setTimeout(() => setPresent(false), duration);
    return () => clearTimeout(timer);
  }, [anchor]);

  useLayoutEffect(() => {
    if (!anchor || !present || !ref.current) return;
    const menu = ref.current;
    // offset sizes are not affected by the entry transform.
    menu.style.left = `${Math.max(8, Math.min(anchor.x, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(anchor.y, innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [anchor, present]);

  useEffect(() => {
    if (!anchor) return;
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close.current();
    };
    const dismiss = () => close.current();
    const scroll = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) dismiss();
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', scroll, true);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [anchor]);

  if (!present) return null;
  const restore = () => {
    const trigger = lastAnchor.current?.trigger;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  };
  return createPortal(
    <div
      ref={ref}
      className="sf-menu sf-popover"
      role="menu"
      aria-label={label}
      data-state={anchor ? 'open' : 'closed'}
      aria-hidden={!anchor || undefined}
      inert={!anchor}
      data-native-overlay={anchor ? 'true' : undefined}
      onContextMenu={(event) => event.preventDefault()}
      onClickCapture={(event) => {
        const item = (event.target as HTMLElement).closest<HTMLButtonElement>(
          'button[role^="menuitem"]',
        );
        if (item && !item.disabled) {
          restore();
          close.current();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          restore();
          close.current();
          return;
        }
        const items = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        ];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const target =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : event.key === 'ArrowDown'
                ? (index + 1) % items.length
                : event.key === 'ArrowUp'
                  ? (index + items.length - 1) % items.length
                  : -1;
        if (target >= 0) {
          event.preventDefault();
          items[target]?.focus();
        }
      }}
    >
      {content.current}
    </div>,
    lastAnchor.current?.trigger?.closest('dialog[open]') || document.body,
  );
}

export function menuAnchor(
  event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>,
): MenuAnchor {
  const rect = event.currentTarget.getBoundingClientRect();
  const pointer = 'clientX' in event && (event.clientX !== 0 || event.clientY !== 0);
  return {
    x: pointer ? event.clientX : rect.left,
    y: pointer ? event.clientY : rect.bottom + 4,
    trigger: event.currentTarget,
  };
}
