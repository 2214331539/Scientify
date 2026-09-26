import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import './primitives.css';

export interface TooltipProps {
  targetRef: RefObject<HTMLElement | null>;
  id: string;
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
}

/** A portal keeps tooltips clear of clipped toolbars without adding a layout wrapper. */
export function Tooltip({ targetRef, id, children, onOpenChange }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const bubbleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let hovered = false;
    let focused = false;
    let dismissed = false;
    let pointerFocus = false;
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    const clearHover = () => {
      clearTimeout(hoverTimer);
      hoverTimer = undefined;
    };
    const enter = () => {
      hovered = true;
      dismissed = false;
      clearHover();
      hoverTimer = setTimeout(() => {
        if (hovered && !dismissed) setOpen(true);
      }, 250);
    };
    const leave = () => {
      hovered = false;
      clearHover();
      if (!focused) dismissed = false;
      if (!focused || dismissed) setOpen(false);
    };
    const focus = () => {
      if (pointerFocus) {
        pointerFocus = false;
        return;
      }
      focused = true;
      dismissed = false;
      clearHover();
      setOpen(true);
    };
    const blur = () => {
      focused = false;
      pointerFocus = false;
      dismissed = false;
      clearHover();
      setOpen(false);
    };
    const close = () => {
      dismissed = true;
      clearHover();
      setOpen(false);
    };
    const activate = () => {
      if (target instanceof HTMLButtonElement && target.disabled) return;
      close();
    };
    const pointerDown = () => {
      pointerFocus = true;
      activate();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') activate();
    };
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    // Native pointer listeners also run on disabled buttons, unlike React mouse handlers.
    target.addEventListener('pointerenter', enter);
    target.addEventListener('pointerleave', leave);
    target.addEventListener('pointerdown', pointerDown);
    target.addEventListener('click', activate);
    target.addEventListener('keydown', keyDown);
    target.addEventListener('focus', focus);
    target.addEventListener('blur', blur);
    document.addEventListener('keydown', dismiss);
    return () => {
      clearHover();
      target.removeEventListener('pointerenter', enter);
      target.removeEventListener('pointerleave', leave);
      target.removeEventListener('pointerdown', pointerDown);
      target.removeEventListener('click', activate);
      target.removeEventListener('keydown', keyDown);
      target.removeEventListener('focus', focus);
      target.removeEventListener('blur', blur);
      document.removeEventListener('keydown', dismiss);
    };
  }, [targetRef]);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const target = targetRef.current;
      const bubble = bubbleRef.current;
      if (!target || !bubble) return;
      const anchor = target.getBoundingClientRect();
      const size = bubble.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const maxLeft = Math.max(margin, window.innerWidth - size.width - margin);
      const below = anchor.bottom + gap;
      const above = anchor.top - size.height - gap;
      setPosition({
        left: Math.max(margin, Math.min(maxLeft, anchor.left + (anchor.width - size.width) / 2)),
        top: Math.max(
          margin,
          Math.min(
            window.innerHeight - size.height - margin,
            below + size.height + margin > window.innerHeight ? above : below,
          ),
        ),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, children, targetRef]);

  if (!open) return null;
  return createPortal(
    <div ref={bubbleRef} role="tooltip" id={id} className="sf-tooltip" style={position}>
      {children}
    </div>,
    targetRef.current?.closest('dialog[open]') || document.body,
  );
}
