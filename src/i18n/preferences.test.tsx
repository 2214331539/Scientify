import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import { emptyWorkspace } from '../domain/workspace';
import { createWorkspaceStore } from '../stores/workspace';
import type { WorkspaceBackend } from '../platform/desktop';
import { browserResearch } from '../platform/browser';
import { preferenceKey, getPreferences, setPreferences } from './preferences';
import { t, translateError } from './index';
import catalog from './messages.json';

let systemChanged: (() => void) | undefined;
let systemDark = false;
beforeEach(() => {
  localStorage.clear();
  systemDark = false;
  window.matchMedia = vi.fn().mockReturnValue({
    get matches() {
      return systemDark;
    },
    addEventListener: (_event: string, callback: () => void) => {
      systemChanged = callback;
    },
    removeEventListener: () => {
      systemChanged = undefined;
    },
  });
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
  document.documentElement.classList.remove('dark');
  document.documentElement.lang = 'zh-CN';
});

function fixture() {
  const data = emptyWorkspace();
  data.projects.push({
    id: 'p',
    name: 'Notes',
    question: '未保存',
    space: 'personal',
    createdAt: '',
  });
  data.records.push({
    id: 'n',
    project: 'p',
    title: 'Saved research',
    body: '原始材料',
    type: 'note',
    status: 'draft',
    createdAt: '',
    updatedAt: '',
  });
  data.papers.push({ id: 'paper', title: 'Original paper', projects: ['p'], status: '未读' });
  const backend: WorkspaceBackend = {
    load: async () => ({ workspace: data, directory: '', legacyAvailable: false }),
    save: vi.fn(async (next) => next),
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  return { store: createWorkspaceStore(backend), backend, data };
}

it('switches both appearance and language immediately without saving or translating research data', async () => {
  const { store, backend } = fixture();
  const user = userEvent.setup();
  render(<App store={store} backend={browserResearch} />);
  await screen.findByRole('button', { name: /^Notes/ });
  expect(within(screen.getByRole('banner')).queryByRole('button', { name: '全局搜索' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '切换为深色' }));
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(
    within(screen.getByRole('banner')).queryByRole('button', { name: '切换为英文' }),
  ).toBeNull();
  await user.click(screen.getByRole('button', { name: '设置' }));
  await user.selectOptions(screen.getByRole('combobox', { name: '界面语言' }), 'en');
  expect(document.documentElement.lang).toBe('en');
  expect(screen.getByRole('button', { name: 'New project' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Notes/ })).toBeTruthy();
  expect(backend.save).not.toHaveBeenCalled();
  expect(store.getState().data?.projects[0]).toMatchObject({ name: 'Notes', question: '未保存' });
  expect(JSON.parse(localStorage.getItem(preferenceKey)!)).toEqual({
    language: 'en',
    theme: 'dark',
  });
  await user.click(
    within(screen.getByRole('navigation', { name: 'Settings categories' })).getByRole('button', {
      name: 'Appearance',
    }),
  );
  await user.selectOptions(screen.getByRole('combobox', { name: 'Theme' }), 'system');
  expect(document.documentElement.classList.contains('dark')).toBe(false);
  act(() => {
    systemDark = true;
    systemChanged?.();
  });
  expect(document.documentElement.classList.contains('dark')).toBe(true);
});

it('retains an unsaved note while switching language and keeps status values stable', async () => {
  const { store, backend } = fixture();
  const user = userEvent.setup();
  render(<App store={store} backend={browserResearch} />);
  await user.click(await screen.findByRole('button', { name: /^Notes/ }));
  await user.click(
    within(screen.getByRole('navigation', { name: '一级导航' })).getByRole('button', {
      name: '笔记',
    }),
  );
  await user.click(await screen.findByRole('button', { name: /Saved research/ }));
  await user.type(screen.getByRole('textbox', { name: '笔记正文' }), ' new draft');
  const revision = store.getState().data?.revision;
  act(() => setPreferences({ language: 'en' }));
  expect((screen.getByRole('textbox', { name: 'Note content' }) as HTMLTextAreaElement).value).toBe(
    '原始材料 new draft',
  );
  expect(store.getState().data?.revision).toBe(revision);
  expect(store.getState().dirty).toBe(true);
  expect(backend.save).not.toHaveBeenCalled();
  await user.click(
    within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', {
      name: 'Literature',
    }),
  );
  const filter = screen.getByRole('combobox', { name: 'Filter reading status' });
  await user.selectOptions(filter, '未读');
  expect((filter as HTMLSelectElement).value).toBe('未读');
  expect(within(filter).getByRole('option', { name: 'Unread' })).toBeTruthy();
});

it('receives a preference change from another window and restores it on mount', async () => {
  const { store } = fixture();
  render(<App store={store} backend={browserResearch} />);
  await screen.findByRole('button', { name: /^Notes/ });
  act(() => {
    localStorage.setItem(preferenceKey, JSON.stringify({ language: 'en', theme: 'dark' }));
    window.dispatchEvent(new StorageEvent('storage', { key: preferenceKey }));
  });
  await waitFor(() => expect(document.documentElement.lang).toBe('en'));
  expect(screen.getByRole('button', { name: 'New project' })).toBeTruthy();
  cleanup();
  render(<App store={fixture().store} backend={browserResearch} />);
  await screen.findByRole('button', { name: 'New project' });
  expect(document.documentElement.classList.contains('dark')).toBe(true);
});

it('falls back safely for corrupt preferences and localizes parameterized backend errors', () => {
  localStorage.setItem(preferenceKey, '{broken');
  expect(getPreferences()).toEqual({ language: 'zh-CN', theme: 'system' });
  setPreferences({ language: 'en' });
  expect(translateError('服务返回 HTTP 401，请检查服务地址、模型名称和访问凭据。')).toBe(
    'Service returned HTTP 401. Check the endpoint, model name and credentials.',
  );
  expect(translateError('文件操作失败：Access denied')).toBe(
    'File operation failed: Access denied',
  );
  expect(translateError('Custom provider detail')).toBe('Custom provider detail');
  expect(t('{count} 篇文献', { count: 12 })).toBe('12 papers');
});

it('preserves all placeholders in both languages', () => {
  for (const [key, pair] of Object.entries(catalog)) {
    const parameters = (value: string) =>
      [...value.matchAll(/\{(\w+)\}/g)].map((item) => item[1]).sort();
    expect(parameters(pair[1]), key).toEqual(parameters(pair[0]));
    expect(pair[0].length).toBeGreaterThan(0);
    expect(pair[1].length).toBeGreaterThan(0);
  }
});
