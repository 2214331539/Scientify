import { fireEvent, render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { Menu, type MenuAnchor } from './Menu';
import { Button } from './Button';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function Host({ action }: { action(): void }) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={trigger}
        onClick={() =>
          setAnchor({ x: innerWidth - 2, y: innerHeight - 2, trigger: trigger.current })
        }
      >
        Open
      </Button>
      <input aria-label="Outside" />
      <Menu label="Actions" anchor={anchor} onClose={() => setAnchor(null)}>
        <Button role="menuitem" onClick={action}>
          Edit
        </Button>
        <Button role="menuitem" disabled>
          Unavailable
        </Button>
        <Button role="menuitem" onClick={action}>
          Delete
        </Button>
      </Menu>
    </>
  );
}
it('supports keyboard navigation, skips unavailable items and restores focus after action', async () => {
  const action = vi.fn(),
    user = userEvent.setup();
  render(<Host action={action} />);
  const trigger = screen.getByRole('button', { name: 'Open' });
  await user.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Edit' }));
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }));
  await user.keyboard('{Home}{Enter}');
  expect(action).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it('outside dismissal lets the destination receive focus and reopening is not lost to an old exit', async () => {
  const user = userEvent.setup();
  render(<Host action={() => {}} />);
  const trigger = screen.getByRole('button', { name: 'Open' });
  await user.click(trigger);
  screen.getByRole('menu').style.setProperty('--sf-motion-exit', '100ms');
  const outside = screen.getByRole('textbox', { name: 'Outside' });
  await user.click(outside);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(outside);
  expect(screen.getByRole('menu', { hidden: true }).getAttribute('inert')).not.toBeNull();
  await user.click(trigger);
  await screen.findByRole('menu');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 130));
  });
  expect(screen.getByRole('menu')).toBeTruthy();
  fireEvent.scroll(outside);
  expect(screen.queryByRole('menu')).toBeNull();
  await user.click(trigger);
  await user.keyboard('{End}{Escape}');
  expect(document.activeElement).toBe(trigger);
});

it('removes the visual exit layer immediately when reduced motion is requested', async () => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true });
  const user = userEvent.setup();
  render(<Host action={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Open' }));
  screen.getByRole('menu').style.setProperty('--sf-motion-exit', '100ms');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu', { hidden: true })).toBeNull();
});

it.each([90, 900])('keeps an upward menu above its anchor with content height %i', (height) => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return Math.min(height, parseFloat(this.style.maxHeight) || height);
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200);
  const onClose = vi.fn();
  const { rerender } = render(
    <Menu label="Models" anchor={{ x: 120, y: 280, placement: 'top' }} onClose={onClose}>
      <Button role="menuitemradio">Model</Button>
    </Menu>,
  );
  const menu = screen.getByRole('menu');
  expect(parseFloat(menu.style.top) + menu.offsetHeight).toBe(280);
  expect(parseFloat(menu.style.top)).toBeGreaterThanOrEqual(8);
  expect(menu.style.left).toBe('120px');
  fireEvent.scroll(menu);
  expect(onClose).not.toHaveBeenCalled();
  // Switching back to a regular menu must not retain the previous height constraint.
  rerender(
    <Menu label="Actions" anchor={{ x: innerWidth - 2, y: 12 }} onClose={onClose}>
      <Button role="menuitem">Action</Button>
    </Menu>,
  );
  expect(menu.style.maxHeight).toBe('');
  expect(parseFloat(menu.style.left) + menu.offsetWidth).toBe(innerWidth - 8);
});
