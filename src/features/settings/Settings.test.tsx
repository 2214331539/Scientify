import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsDialog } from './Settings';
import { createWorkspaceStore } from '../../stores/workspace';
import { emptyWorkspace } from '../../domain/workspace';
import type { WorkspaceBackend } from '../../platform/desktop';
import { usePreferences } from '../../i18n/preferences';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function fixture() {
  const adapter: WorkspaceBackend = {
    load: async () => ({
      workspace: emptyWorkspace(),
      directory: 'test/data',
      legacyAvailable: false,
    }),
    save: vi.fn(async (value) => value),
    restore: async () => emptyWorkspace(),
    migrateLegacy: async () => emptyWorkspace(),
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  const store = createWorkspaceStore(adapter);
  await store.getState().load();
  const close = vi.fn();
  function Host() {
    usePreferences();
    return <SettingsDialog store={store} onClose={close} />;
  }
  render(<Host />);
  return { store, adapter, close, user: userEvent.setup() };
}

it('keeps one dialog and the input draft when changing category or language', async () => {
  const { user, store } = await fixture();
  const dialog = screen.getByRole('dialog', { name: '设置' });
  const name = screen.getByRole('textbox', { name: '显示名称' });
  await user.type(name, 'Researcher');
  await user.selectOptions(screen.getByRole('combobox', { name: '界面语言' }), 'en');
  expect(screen.getByRole('dialog', { name: 'Settings' })).toBe(dialog);
  expect(screen.getByRole('textbox', { name: 'Display name' })).toBe(name);
  expect((name as HTMLInputElement).value).toBe('Researcher');
  const nav = within(screen.getByRole('navigation', { name: 'Settings categories' }));
  await user.click(nav.getByRole('button', { name: 'Appearance' }));
  expect(screen.queryByRole('combobox', { name: 'Language' })).toBeNull();
  expect(screen.getByRole('combobox', { name: 'Theme' })).toBeTruthy();
  await user.click(nav.getByRole('button', { name: 'Data & backups' }));
  expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(nav.getByRole('button', { name: 'General' }));
  expect(screen.getByRole('textbox', { name: 'Display name' })).toBe(name);
  expect(store.getState().dirty).toBe(true);
});

it('protects dirty profile input on close and allows retry after a failed save', async () => {
  const { user, store, adapter, close } = await fixture();
  await user.type(screen.getByRole('textbox', { name: '显示名称' }), 'Ada');
  await user.click(screen.getByRole('button', { name: '关闭弹窗' }));
  const confirm = await screen.findByRole('dialog', { name: '确认操作' });
  await user.click(within(confirm).getByRole('button', { name: '取消' }));
  expect(close).not.toHaveBeenCalled();
  vi.mocked(adapter.save).mockRejectedValueOnce(new Error('磁盘只读'));
  await user.click(screen.getByRole('button', { name: '保存偏好' }));
  expect((await screen.findByRole('alert')).textContent).toBe('磁盘只读');
  expect(store.getState().dirty).toBe(true);
  await user.click(screen.getByRole('button', { name: '保存偏好' }));
  await waitFor(() => expect(store.getState().dirty).toBe(false));
  expect(store.getState().data?.settings.name).toBe('Ada');
  fireEvent(
    screen.getByRole('dialog', { name: '设置' }),
    new Event('cancel', { bubbles: true, cancelable: true }),
  );
  expect(close).toHaveBeenCalledOnce();
});

it('blocks closing while a profile save is in flight', async () => {
  const { user, adapter, close } = await fixture();
  let finish!: () => void;
  vi.mocked(adapter.save).mockImplementationOnce(
    (value) =>
      new Promise((resolve) => {
        finish = () => resolve(value);
      }),
  );
  await user.type(screen.getByRole('textbox', { name: '显示名称' }), 'Grace');
  await user.click(screen.getByRole('button', { name: '保存偏好' }));
  fireEvent(
    screen.getByRole('dialog', { name: '设置' }),
    new Event('cancel', { bubbles: true, cancelable: true }),
  );
  expect(close).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: '关闭弹窗' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await act(async () => finish());
});
