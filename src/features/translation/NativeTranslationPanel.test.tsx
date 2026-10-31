import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NativeTranslationPanel } from './NativeTranslationPanel';

const native = vi.hoisted(() => ({ invoke: vi.fn(), stop: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => native.stop) }));
beforeEach(() => {
  native.invoke.mockImplementation(async (_command, { action }) => ({
    enabled: action.type !== 'enabled' || action.enabled,
    running: true,
    hotkeyRunning: true,
    settingsError: null,
  }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('opens the original settings and controls the same native engine without a second translator', async () => {
  render(<NativeTranslationPanel />);
  await screen.findByText('自动划词已启用');
  expect(screen.queryByRole('textbox')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: '暂停划词' }));
  await screen.findByText('自动划词已暂停');
  await userEvent.click(screen.getByRole('button', { name: '打开完整翻译设置' }));
  expect(native.invoke).toHaveBeenCalledWith('translation_service', {
    action: { type: 'settings' },
  });
});

it('shows startup failures and can restart the service', async () => {
  native.invoke.mockRejectedValueOnce(new Error('fixture startup failure'));
  const view = render(<NativeTranslationPanel />);
  await screen.findByRole('alert');
  await userEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  view.unmount();
  await waitFor(() => expect(native.stop).toHaveBeenCalledOnce());
});
