import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ResizeHandle } from './ResizeHandle';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('captures left-edge dragging, clamps width, and cleans up on cancel and unmount', () => {
  const set = vi.fn(),
    release = vi.fn();
  function Example() {
    const [width, update] = useState(340);
    return (
      <ResizeHandle
        value={width}
        min={300}
        max={600}
        side="right"
        label="resize"
        onChange={update}
      />
    );
  }
  const view = render(<Example />);
  const handle = screen.getByRole('separator');
  handle.setPointerCapture = set;
  handle.hasPointerCapture = () => true;
  handle.releasePointerCapture = release;
  fireEvent.pointerDown(handle, { button: 0, clientX: 800, pointerId: 1 });
  expect(set).toHaveBeenCalledWith(1);
  fireEvent.pointerMove(handle, { clientX: 700, pointerId: 1 });
  expect(handle.getAttribute('aria-valuenow')).toBe('440');
  fireEvent.pointerMove(handle, { clientX: 300, pointerId: 1 });
  expect(handle.getAttribute('aria-valuenow')).toBe('600');
  fireEvent.pointerCancel(handle, { pointerId: 1 });
  expect(release).toHaveBeenCalledWith(1);
  expect(handle.dataset.nativeOverlay).toBeUndefined();
  fireEvent.keyDown(handle, { key: 'ArrowRight' });
  expect(handle.getAttribute('aria-valuenow')).toBe('584');
  fireEvent.pointerDown(handle, { button: 0, clientX: 700, pointerId: 2 });
  view.unmount();
  expect(release).toHaveBeenCalledWith(2);
});
