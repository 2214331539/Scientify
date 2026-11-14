import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

it('starts in the project center and opens a project in the same window', async () => {
  localStorage.setItem(
    'scientify.ui.v2.main',
    JSON.stringify({ version: 2, projectId: 'p1', locations: {} }),
  );
  const { store } = fixture();
  render(<App store={store} backend={browserResearch} windowMode="main" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Research' }));
  await screen.findByRole('navigation', { name: '一级导航' });
  expect(native.invoke).not.toHaveBeenCalledWith('open_project_window', expect.anything());
  await userEvent.click(screen.getByRole('button', { name: '回到项目中心' }));
  expect(native.close).not.toHaveBeenCalled();
  expect(await screen.findByRole('button', { name: 'Research' })).toBeTruthy();
});
