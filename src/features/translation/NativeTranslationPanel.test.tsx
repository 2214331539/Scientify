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

it('controls the same native engine and sends text only after an explicit action', async () => {
  render(<NativeTranslationPanel />);
  await screen.findByText('自动划词已启用');
  await userEvent.type(screen.getByRole('textbox'), 'fixture text');
  expect(native.invoke).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole('button', { name: /^翻译$/ }));
  expect(native.invoke).toHaveBeenCalledWith('translation_service', {
    action: { type: 'translate', text: 'fixture text' },
  });
  await userEvent.click(screen.getByRole('button', { name: '暂停划词' }));
  await screen.findByText('自动划词已暂停');
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'fixture text');
  await userEvent.click(screen.getByRole('button', { name: '打开完整翻译设置' }));
  expect(native.invoke).toHaveBeenCalledWith('translation_service', {
    action: { type: 'settings' },
  });
});

it('shows startup failures and can restart without discarding the draft', async () => {
  native.invoke.mockRejectedValueOnce(new Error('fixture startup failure'));
  const view = render(<NativeTranslationPanel />);
  await screen.findByRole('alert');
  await userEvent.type(screen.getByRole('textbox'), 'keep draft');
  await userEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'keep draft');
  view.unmount();
  await waitFor(() => expect(native.stop).toHaveBeenCalledOnce());
});
