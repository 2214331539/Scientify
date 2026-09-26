import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WindowControls } from './WindowControls';

const native = vi.hoisted(() => ({ enabled: true, maximized: false }));
const win = vi.hoisted(() => ({
  minimize: vi.fn(async () => {}),
  toggleMaximize: vi.fn(async () => {
    native.maximized = !native.maximized;
  }),
  isMaximized: vi.fn(async () => native.maximized),
  close: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
  onResized: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => native.enabled }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  native.enabled = true;
  native.maximized = false;
});

it('uses native controls and requests a guarded close rather than destroying the window', async () => {
  const user = userEvent.setup();
  render(<WindowControls />);
  await user.click(screen.getByRole('button', { name: '最小化窗口' }));
  expect(win.minimize).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('button', { name: '最大化窗口' }));
  await screen.findByRole('button', { name: '还原窗口' });
  await user.click(screen.getByRole('button', { name: '还原窗口' }));
  await screen.findByRole('button', { name: '最大化窗口' });
  await user.click(screen.getByRole('button', { name: '关闭窗口' }));
  await waitFor(() => expect(win.close).toHaveBeenCalledOnce());
  expect(win.destroy).not.toHaveBeenCalled();
});

it('does not show or call desktop window controls in browser preview', () => {
  native.enabled = false;
  render(<WindowControls />);
  expect(screen.queryByRole('group', { name: '窗口控制' })).toBeNull();
  expect(win.isMaximized).not.toHaveBeenCalled();
});
