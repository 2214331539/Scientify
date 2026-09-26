import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { emptyWorkspace, type Workspace } from '../../domain/workspace';
import { createWorkspaceStore } from '../../stores/workspace';
import type { WorkspaceBackend } from '../../platform/desktop';
import { createNote } from '../notes/model';
import { deleteProject, deleteTeam } from './model';
import { setPreferences } from '../../i18n/preferences';

beforeAll(() => {
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
  setPreferences({ theme: 'light', language: 'zh-CN' });
  vi.restoreAllMocks();
});
function fixture(data = emptyWorkspace()) {
  const save = vi.fn(async (value: Workspace) => structuredClone(value));
  const backend: WorkspaceBackend = {
    load: async () => ({ workspace: data, directory: '', legacyAvailable: false }),
    save,
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  const store = createWorkspaceStore(backend);
  render(<App store={store} />);
  return { store, save, user: userEvent.setup() };
}
const project = (id: string, space = 'personal') => ({
  id,
  name: id,
  space,
  question: '',
  createdAt: '2026-09-26',
});

it('switches project views, filters records and provides a static profile with one sidebar theme control', async () => {
  const data = emptyWorkspace();
  data.projects.push(project('Alpha'), project('Beta'));
  const { user } = fixture(data);
  await screen.findByRole('button', { name: 'Alpha' });
  expect(screen.getByLabelText('登录入口占位').tagName).toBe('DIV');
  for (const name of ['全部项目', '已收藏', '已归档', '数据与备份', '关于 MVP'])
    expect(screen.queryByRole('button', { name })).toBeNull();
  expect(screen.queryByRole('combobox', { name: '项目排序' })).toBeNull();
  expect(screen.queryByRole('button', { name: '登录' })).toBeNull();
  const sidebar = within(screen.getByRole('complementary', { name: '项目空间' }));
  await user.click(sidebar.getByRole('button', { name: '切换为深色' }));
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(screen.getAllByRole('button', { name: '切换为浅色' })).toHaveLength(1);
  await user.type(screen.getByRole('searchbox', { name: '搜索项目' }), 'Beta');
  expect(screen.queryByRole('button', { name: 'Alpha' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '列表视图' }));
  expect(
    within(screen.getByRole('table', { name: '项目列表' })).getByRole('button', { name: 'Beta' }),
  ).toBeTruthy();
  expect(localStorage.getItem('scientify.projects.view')).toBe('list');
});

it('creates and edits a team, assigns projects and moves them safely when deleting the team', async () => {
  const { user, store } = fixture();
  await screen.findByText('暂无项目');
  await user.click(screen.getByRole('button', { name: '团队协作空间' }));
  await user.click(screen.getAllByRole('button', { name: '创建团队空间' })[0]);
  await user.type(screen.getByLabelText('团队名称'), 'Vision lab');
  await user.click(screen.getByRole('button', { name: '保存团队' }));
  await waitFor(() => expect(store.getState().data?.teams).toHaveLength(1));
  expect(screen.queryByRole('searchbox', { name: '搜索团队' })).toBeNull();
  await user.click(screen.getByRole('button', { name: /Vision lab.*0 个项目/ }));
  await user.click(screen.getByRole('button', { name: '新建项目' }));
  expect((screen.getByLabelText('所属空间') as HTMLSelectElement).value).toBe(
    store.getState().data?.teams[0].id,
  );
  await user.type(screen.getByLabelText('项目名称'), 'Team research');
  await user.click(screen.getByRole('button', { name: '保存项目' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.contextMenu(screen.getByRole('button', { name: /Vision lab.*1 个项目/ }));
  await user.click(await screen.findByRole('menuitem', { name: '重命名 / 编辑' }));
  await user.clear(screen.getByLabelText('团队名称'));
  await user.type(screen.getByLabelText('团队名称'), 'Research lab');
  await user.click(screen.getByRole('button', { name: '保存团队' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await user.click(
    within(screen.getByRole('navigation', { name: '空间导航' })).getByRole('button', {
      name: '团队协作空间',
    }),
  );
  fireEvent.contextMenu(screen.getByRole('button', { name: /Research lab.*1 个项目/ }));
  await user.click(await screen.findByRole('menuitem', { name: '删除团队空间' }));
  await user.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(store.getState().data?.teams).toHaveLength(0));
  expect(store.getState().data?.projects[0].space).toBe('personal');
  await user.click(screen.getByRole('button', { name: '个人空间' }));
  expect(await screen.findByRole('button', { name: 'Team research' })).toBeTruthy();
});

it('keeps the project when deletion fails and only removes records after a successful retry', async () => {
  const data = emptyWorkspace();
  data.projects.push(project('Alpha'));
  data.records.push(createNote('Alpha', 'Keep until saved'));
  const { user, store, save } = fixture(data);
  await user.click(await screen.findByRole('button', { name: '项目操作 Alpha' }));
  await user.click(screen.getByRole('menuitem', { name: '删除项目' }));
  save.mockRejectedValueOnce(new Error('Disk unavailable'));
  await user.click(screen.getByRole('button', { name: '确认删除' }));
  await within(screen.getByRole('dialog', { name: '删除项目' })).findByText('Disk unavailable');
  expect(store.getState().data?.projects).toHaveLength(1);
  expect(store.getState().data?.records).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(store.getState().data?.projects).toHaveLength(0);
  expect(store.getState().data?.records).toHaveLength(0);
});

it('removes only owned project records and preserves shared literature, other projects and disk references', () => {
  const data = emptyWorkspace();
  data.projects.push(project('a', 'team'), project('b', 'team'));
  data.teams.push({ id: 'team', name: 'Lab', color: '#657b71' });
  data.records.push(createNote('a'), createNote('b'), createNote('__inbox__'));
  data.papers.push({
    id: 'paper',
    title: 'Shared',
    projects: ['a', 'b'],
    assetId: 'retained-asset',
  });
  data.runs.push({ id: 'run-a', project: 'a' }, { id: 'run-b', project: 'b' });
  data.tasks.push({ id: 'task-a', project: 'a', title: 'todo' });
  data.sessions.push({ id: 'session-a', project: 'a' });
  deleteProject(data, 'a');
  expect(data.records.map((record) => record.project)).toEqual(['b', '__inbox__']);
  expect(data.papers[0]).toMatchObject({ projects: ['b'], assetId: 'retained-asset' });
  expect(data.runs.map((run) => run.id)).toEqual(['run-b']);
  expect(data.tasks).toHaveLength(0);
  expect(data.sessions).toHaveLength(0);
  deleteTeam(data, 'team');
  expect(data.projects[0].space).toBe('personal');
  expect(data.projects[0].id).toBe('b');
});

it('renames personal projects from the context menu, keeps archived items reachable and restores keyboard focus', async () => {
  const data = emptyWorkspace();
  data.projects.push({ ...project('Alpha'), archived: true });
  const { user, store } = fixture(data);
  const cover = await screen.findByRole('button', { name: 'Alpha' });
  fireEvent.contextMenu(cover);
  await user.click(await screen.findByRole('menuitem', { name: '重命名 / 编辑' }));
  await user.clear(screen.getByLabelText('项目名称'));
  await user.type(screen.getByLabelText('项目名称'), 'Renamed');
  await user.click(screen.getByRole('button', { name: '保存项目' }));
  await waitFor(() => expect(store.getState().data?.projects[0].name).toBe('Renamed'));
  const renamed = screen.getByRole('button', { name: 'Renamed' });
  renamed.focus();
  await user.keyboard('{Shift>}{F10}{/Shift}');
  await screen.findByRole('menu');
  await user.keyboard('{End}');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '删除项目' }));
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(renamed);
  fireEvent.contextMenu(renamed);
  await user.click(await screen.findByRole('menuitem', { name: '恢复' }));
  await waitFor(() => expect(store.getState().data?.projects[0].archived).toBe(false));
});
