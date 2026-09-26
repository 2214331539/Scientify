import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { emptyWorkspace } from '../domain/workspace';
import { createWorkspaceStore } from '../stores/workspace';
import { browserResearch } from '../platform/browser';

const native = vi.hoisted(() => ({
  request: undefined as undefined | ((event: { preventDefault(): void }) => Promise<void>),
  destroy: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setTitle: async () => {},
    destroy: native.destroy,
    onCloseRequested: async (callback: typeof native.request) => {
      native.request = callback;
      return () => {
        native.request = undefined;
      };
    },
  }),
}));
vi.mock('../components/layout/WindowControls', () => ({ WindowControls: () => null }));
beforeEach(() => {
  vi.clearAllMocks();
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
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
});
it('merges repeated native close requests, preserves dirty work on cancel and destroys only after confirmation', async () => {
  const data = emptyWorkspace();
  const store = createWorkspaceStore({
    load: async () => ({ workspace: data, directory: 'test-only', legacyAvailable: false }),
    save: async (value) => value,
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  });
  const user = userEvent.setup();
  render(<App store={store} backend={browserResearch} windowMode="projects" />);
  await screen.findByText('暂无项目');
  act(() => store.getState().setDirtySource('test-note', true));
  const event = { preventDefault: vi.fn() };
  let first!: Promise<void>;
  await act(async () => {
    first = native.request!(event);
  });
  await screen.findByRole('dialog', { name: '确认操作' });
  await act(async () => {
    await native.request!(event);
  });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: '取消' }));
  await first;
  expect(native.destroy).not.toHaveBeenCalled();
  expect(store.getState().dirty).toBe(true);
  act(() => store.setState({ busy: true }));
  await act(async () => {
    await native.request!(event);
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => store.setState({ busy: false }));
  await act(async () => {
    first = native.request!(event);
  });
  await user.click(
    within(await screen.findByRole('dialog', { name: '确认操作' })).getByRole('button', {
      name: '确认',
    }),
  );
  await first;
  await waitFor(() => expect(native.destroy).toHaveBeenCalledOnce());
  expect(event.preventDefault).toHaveBeenCalledTimes(4);
});
