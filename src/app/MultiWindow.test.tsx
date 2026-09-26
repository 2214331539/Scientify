import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { emptyWorkspace } from '../domain/workspace';
import { createWorkspaceStore } from '../stores/workspace';
import type { WorkspaceBackend } from '../platform/desktop';
import { browserResearch } from '../platform/browser';

const native = vi.hoisted(() => ({
  invoke: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  refresh: undefined as (() => void) | undefined,
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: native.invoke }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ close: native.close }) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name, callback) => {
    native.refresh = callback;
    return () => {
      native.refresh = undefined;
    };
  }),
}));

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
  window.history.replaceState(null, '', '/');
});

function fixture() {
  const disk = emptyWorkspace();
  disk.projects.push({
    id: 'p1',
    name: 'Research',
    space: 'personal',
    question: '',
    createdAt: '',
  });
  const adapter: WorkspaceBackend = {
    load: vi.fn(async () => ({
      workspace: structuredClone(disk),
      directory: '',
      legacyAvailable: false,
    })),
    save: async (value) => value,
    restore: async () => disk,
    migrateLegacy: async () => disk,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  return { store: createWorkspaceStore(adapter), disk, adapter };
}

it('keeps Projects independent of the previously selected project and reloads after returning', async () => {
  localStorage.setItem(
    'scientify.ui.v2',
    JSON.stringify({ version: 2, projectId: 'p1', locations: {} }),
  );
  const { store, disk, adapter } = fixture();
  render(<App store={store} backend={browserResearch} windowMode="projects" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Research' }));
  expect(native.invoke).toHaveBeenCalledWith('open_project_window', {
    projectId: 'p1',
    target: null,
  });
  expect(screen.queryByRole('navigation', { name: '一级导航' })).toBeNull();
  expect(store.getState().busy).toBe(true);
  disk.projects[0].name = 'Updated research';
  await act(async () => native.refresh?.());
  await screen.findByRole('button', { name: 'Updated research' });
  expect(store.getState().busy).toBe(false);
  expect(adapter.load).toHaveBeenCalledTimes(2);
});

it('preserves manager access when workspace creation fails', async () => {
  native.invoke.mockRejectedValueOnce(new Error('window creation failed'));
  const { store } = fixture();
  render(<App store={store} backend={browserResearch} windowMode="projects" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Research' }));
  await waitFor(() => expect(store.getState().error).toBe('window creation failed'));
  expect(store.getState().busy).toBe(false);
  expect(screen.queryByRole('dialog', { name: '正在打开项目' })).toBeNull();
});

it('opens the requested project and returns through the guarded native close path', async () => {
  window.history.replaceState(null, '', '/?project=p1');
  const { store } = fixture();
  render(<App store={store} backend={browserResearch} windowMode="workspace" />);
  await screen.findByRole('navigation', { name: '一级导航' });
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('workspace_window_ready'));
  await userEvent.click(screen.getByRole('button', { name: 'Scientify 项目管理' }));
  expect(native.close).toHaveBeenCalledTimes(1);
});

it('does not hand off while the manager has an unsaved draft', async () => {
  const { store } = fixture();
  render(<App store={store} backend={browserResearch} windowMode="projects" />);
  const open = await screen.findByRole('button', { name: 'Research' });
  act(() => store.getState().setDirtySource('test-draft', true));
  await userEvent.click(open);
  expect(native.invoke).not.toHaveBeenCalled();
  expect(store.getState().dirty).toBe(true);
  expect(store.getState().error).toContain('请先保存');
});
