import { createRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';

afterEach(cleanup);

it('shows one custom tooltip for keyboard focus and dismisses it without losing focus', async () => {
  const user = userEvent.setup();
  render(
    <Button iconOnly title="Open notes">
      <span aria-hidden="true">N</span>
    </Button>,
  );
  const button = screen.getByRole('button', { name: 'Open notes' });
  expect(button.hasAttribute('title')).toBe(false);
  await user.tab();
  const tooltip = screen.getByRole('tooltip');
  expect(tooltip.textContent).toBe('Open notes');
  expect(button.getAttribute('aria-describedby')).toBe(tooltip.id);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(document.activeElement).toBe(button);
  await user.tab();
  await user.tab({ shift: true });
  expect(screen.getByRole('tooltip').textContent).toBe('Open notes');
});

it('keeps disabled icon explanations available on hover without enabling the action', async () => {
  const user = userEvent.setup();
  const onClick = vi.fn();
  render(
    <Button
      disabled
      iconOnly
      aria-label="Compile"
      tooltip="Choose a main file first"
      onClick={onClick}
    />,
  );
  const button = screen.getByRole('button', { name: 'Compile' });
  await user.hover(button);
  expect((await screen.findByRole('tooltip')).textContent).toBe('Choose a main file first');
  await user.click(button);
  expect(onClick).not.toHaveBeenCalled();
  await user.unhover(button);
  expect(screen.queryByRole('tooltip')).toBeNull();
});

it('dismisses hover and keyboard tooltips on activation until a new hover or focus', async () => {
  const user = userEvent.setup();
  const onClick = vi.fn();
  render(<Button iconOnly aria-label="Open assistant" onClick={onClick} />);
  const button = screen.getByRole('button', { name: 'Open assistant' });
  await user.hover(button);
  expect(await screen.findByRole('tooltip')).toBeTruthy();
  await user.click(button);
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(onClick).toHaveBeenCalledTimes(1);
  await user.unhover(button);
  await user.hover(button);
  expect(await screen.findByRole('tooltip')).toBeTruthy();
  await user.keyboard('{Enter}');
  expect(screen.queryByRole('tooltip')).toBeNull();
  await user.tab();
  await user.tab({ shift: true });
  expect(screen.getByRole('tooltip')).toBeTruthy();
  await user.keyboard(' ');
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(onClick).toHaveBeenCalledTimes(3);
});

it('preserves native form defaults, explicit button types, refs and accessible descriptions', async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn((event) => event.preventDefault());
  const ref = createRef<HTMLButtonElement>();
  render(
    <form onSubmit={onSubmit}>
      <span id="save-help">Save project changes</span>
      <Button ref={ref} aria-describedby="save-help" tooltip="Save">
        Save
      </Button>
      <Button type="button">Cancel</Button>
    </form>,
  );
  const save = screen.getByRole('button', { name: 'Save' });
  expect(ref.current).toBe(save);
  expect(save.getAttribute('type')).toBeNull();
  await user.click(save);
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(save.getAttribute('aria-describedby')).toContain('save-help');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it('keeps edge tooltips inside the viewport and inside a native modal top layer', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute('role') === 'tooltip'
      ? { x: 0, y: 0, top: 0, left: 0, right: 160, bottom: 30, width: 160, height: 30, toJSON() {} }
      : {
          x: window.innerWidth - 20,
          y: window.innerHeight - 20,
          top: window.innerHeight - 20,
          left: window.innerWidth - 20,
          right: window.innerWidth,
          bottom: window.innerHeight,
          width: 20,
          height: 20,
          toJSON() {},
        };
  });
  render(
    <dialog open>
      <Button iconOnly aria-label="Close dialog" />
    </dialog>,
  );
  fireEvent.focus(screen.getByRole('button', { name: 'Close dialog' }));
  const tooltip = screen.getByRole('tooltip');
  expect(tooltip.parentElement?.tagName).toBe('DIALOG');
  expect(Number.parseFloat(tooltip.style.left)).toBeLessThanOrEqual(window.innerWidth - 168);
  expect(Number.parseFloat(tooltip.style.top)).toBeLessThanOrEqual(window.innerHeight - 56);
});
