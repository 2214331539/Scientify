import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import './panel-sash.css';

/**
 * The top edge of a bottom panel: drag it up or down, from a closed panel to
 * one that fills its area. Below `collapseBelow` the panel closes; dragging
 * a closed panel up opens it again.
 */
export function PanelSash({
  height,
  max,
  min = 33,
  collapseBelow = 64,
  open,
  onResize,
  onOpen,
  onEnd,
  label,
}: {
  height: number;
  /** The tallest the panel may be, read when a drag starts. */
  max(): number;
  min?: number;
  collapseBelow?: number;
  open: boolean;
  onResize(height: number): void;
  onOpen(open: boolean): void;
  /** The drag ended; a good time to remember the height. */
  onEnd?(height: number): void;
  label: string;
}) {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    cleanup.current?.();
    const startY = event.clientY;
    const startHeight = open ? height : min;
    const upper = Math.max(min, max());
    const target = event.currentTarget;
    let last = startHeight;
    target.setPointerCapture(event.pointerId);
    target.dataset.resizing = 'true';
    // Native browser views step aside while something is being dragged over them.
    target.dataset.nativeOverlay = 'true';
    const move = (e: globalThis.PointerEvent) => {
      last = Math.round(Math.min(upper, Math.max(min, startHeight + startY - e.clientY)));
      if (last < collapseBelow) {
        onOpen(false);
      } else {
        onOpen(true);
        onResize(last);
      }
    };
    const stop = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', stop);
      target.removeEventListener('lostpointercapture', stop);
      target.removeEventListener('pointercancel', stop);
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      delete target.dataset.resizing;
      delete target.dataset.nativeOverlay;
      cleanup.current = null;
      if (last >= collapseBelow) onEnd?.(last);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
    target.addEventListener('lostpointercapture', stop);
    target.addEventListener('pointercancel', stop);
    cleanup.current = stop;
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const next = Math.min(
      Math.max(min, max()),
      Math.max(collapseBelow, (open ? height : min) + (event.key === 'ArrowUp' ? 24 : -24)),
    );
    onOpen(true);
    onResize(next);
    onEnd?.(next);
  }
  return (
    <div
      className="sf-panel-sash"
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={open ? height : min}
      tabIndex={0}
      onPointerDown={start}
      onKeyDown={key}
    />
  );
}
