import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';

export function ResizeHandle({
  value,
  min,
  max,
  onChange,
  side,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  side: 'left' | 'right';
  label: string;
}) {
  const upper = Math.max(min, max);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const clamp = (next: number) => Math.round(Math.min(upper, Math.max(min, next)));
  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    cleanup.current?.();
    const startX = event.clientX;
    const startValue = value;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    target.dataset.resizing = 'true';
    target.dataset.nativeOverlay = 'true';
    const move = (e: globalThis.PointerEvent) =>
      onChange(clamp(startValue + (e.clientX - startX) * (side === 'left' ? 1 : -1)));
    const stop = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', stop);
      target.removeEventListener('lostpointercapture', stop);
      target.removeEventListener('pointercancel', stop);
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      delete target.dataset.resizing;
      delete target.dataset.nativeOverlay;
      cleanup.current = null;
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
    target.addEventListener('lostpointercapture', stop);
    target.addEventListener('pointercancel', stop);
    cleanup.current = stop;
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      onChange(clamp(value + (event.key === 'ArrowRight' ? 16 : -16) * (side === 'left' ? 1 : -1)));
    }
    if (event.key === 'Home') {
      event.preventDefault();
      onChange(clamp(side === 'left' ? 240 : 340));
    }
  }
  return (
    <div
      className={`resize-handle ${side === 'right' ? 'dock-resize' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={upper}
      tabIndex={0}
      onPointerDown={start}
      onKeyDown={key}
      onDoubleClick={() => onChange(clamp(side === 'left' ? 240 : 340))}
    />
  );
}
