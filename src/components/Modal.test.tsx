import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { useState } from 'react';
import { Button, Input } from './primitives';
import { Modal } from './Modal';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

it('restores focus to the trigger after the dialog is unmounted', async () => {
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open settings</button>
        {open && (
          <Modal title="Settings" onClose={() => setOpen(false)}>
            <input aria-label="Name" />
          </Modal>
        )}
      </>
    );
  }
  const user = userEvent.setup();
  render(<Host />);
  const trigger = screen.getByRole('button', { name: 'Open settings' });
  await user.click(trigger);
  await user.click(screen.getByRole('textbox', { name: 'Name' }));
  await user.click(screen.getByRole('button', { name: '关闭弹窗' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('focuses form input on open and returns to the launcher trigger after discarding a dirty nested dialog', async () => {
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Edit</Button>
        {open && (
          <Modal title="Edit project" dirty onClose={() => setOpen(false)}>
            <Input autoFocus aria-label="Project name" />
          </Modal>
        )}
      </>
    );
  }
  const user = userEvent.setup();
  render(<Host />);
  const trigger = screen.getByRole('button', { name: 'Edit' });
  await user.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Project name' }));
  await user.click(screen.getByRole('button', { name: '关闭弹窗' }));
  await user.click(screen.getByRole('button', { name: '确认' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
