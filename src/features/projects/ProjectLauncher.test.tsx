import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { emptyWorkspace, type Project, type Workspace } from '../../domain/workspace';
import { createWorkspaceStore } from '../../stores/workspace';
import type { WorkspaceBackend } from '../../platform/desktop';
import { createNote } from '../notes/model';
import { isTeamCloudProject } from './cloud';
import {
  COLLABORATION_TEAM_ID,
  deleteProject,
  deleteTeam,
  filterProjects,
  sortProjects,
} from './model';
import { setPreferences } from '../../i18n/preferences';

beforeAll(() => {
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
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
    load: async () => ({ workspace: data, directory: 'D:/ScientifyData', legacyAvailable: false }),
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
const project = (id: string, space = 'personal'): Project => ({
  id,
  name: id,
  space,
  question: '',
  createdAt: '2026-09-26',
});
/** A sidebar entry once the workspace has loaded. */
async function nav(name: RegExp) {
  const sidebar = within(await screen.findByRole('complementary', { name: '项目中心导航' }));
  const button = sidebar.getByRole('button', { name }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}
const openMine = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await nav(/我的项目/));

it('shows recent work on the home page, then filters, sorts and remembers the view in my projects', async () => {
  const now = new Date().toISOString();
  const data = emptyWorkspace();
  data.projects.push(
    project('Alpha'),
    project('Beta'),
    { ...project('Old'), archived: true },
    { ...project('Starred'), favorite: true },
  );
  data.records.push({ ...createNote('Alpha', 'Reading notes'), updatedAt: now });
  data.runs.push({ id: 'r1', project: 'Beta', name: 'ablation', status: 'failed', updatedAt: now });
  const { user } = fixture(data);
  const home = within(await screen.findByRole('region', { name: '首页' }));
  expect(home.getByRole('button', { name: 'Alpha' })).toBeTruthy();
  expect(home.queryByRole('button', { name: 'Old' })).toBeNull();
  expect(home.getByText('Reading notes')).toBeTruthy();
  expect(home.getByText('运行失败：ablation')).toBeTruthy();
  await user.click(home.getByRole('button', { name: '知道了' }));
  expect(home.queryByText('运行失败：ablation')).toBeNull();
  expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
  expect(
    within(screen.getByRole('complementary', { name: '项目中心导航' })).getByRole('button', {
      name: 'Starred',
    }),
  ).toBeTruthy();

  await openMine(user);
  const mine = within(screen.getByRole('region', { name: '我的项目' }));
  expect(mine.queryByRole('button', { name: 'Old' })).toBeNull();
  await user.click(mine.getByRole('button', { name: /已归档/ }));
  expect(mine.getByRole('button', { name: 'Old' })).toBeTruthy();
  await user.click(mine.getByRole('button', { name: /^收藏/ }));
  expect(mine.getByRole('button', { name: 'Starred' })).toBeTruthy();
  expect(mine.queryByRole('button', { name: 'Alpha' })).toBeNull();
  await user.click(mine.getByRole('button', { name: /^全部/ }));
  await user.type(mine.getByRole('searchbox', { name: '搜索项目' }), 'Beta');
  expect(mine.queryByRole('button', { name: 'Alpha' })).toBeNull();
  await user.click(mine.getByRole('button', { name: '列表视图' }));
  expect(
    within(screen.getByRole('table', { name: '项目列表' })).getByRole('button', { name: 'Beta' }),
  ).toBeTruthy();
  expect(localStorage.getItem('scientify.projects.view')).toBe('list');
  await user.click(mine.getByRole('button', { name: /排序/ }));
  await user.click(await screen.findByRole('menuitemradio', { name: /名称/ }));
  expect(localStorage.getItem('scientify.projects.sort')).toBe('name');
});

it('creates a project in two steps from the first-run home page', async () => {
  const { user, store } = fixture();
  await screen.findByText('开始使用');
  expect(screen.getByText('D:/ScientifyData')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /新建项目/ }));
  const dialog = within(screen.getByRole('dialog', { name: '新建项目' }));
  expect((dialog.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(dialog.getByLabelText('项目名称'), '视觉剪枝');
  await user.type(dialog.getByLabelText('研究问题'), '剪枝会不会加剧幻觉？');
  await user.click(dialog.getByRole('button', { name: '下一步' }));
  expect(dialog.getByText(/第 2 步/)).toBeTruthy();
  expect(dialog.getByText('登录后可用。')).toBeTruthy();
  await user.click(dialog.getByRole('button', { name: '上一步' }));
  expect((dialog.getByLabelText('项目名称') as HTMLInputElement).value).toBe('视觉剪枝');
  await user.click(dialog.getByRole('button', { name: '下一步' }));
  await user.click(dialog.getByRole('button', { name: '创建项目' }));
  await waitFor(() => expect(store.getState().data?.projects[0]?.name).toBe('视觉剪枝'));
  expect(store.getState().data?.projects[0]).toMatchObject({
    question: '剪枝会不会加剧幻觉？',
    space: 'personal',
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('explains that team projects need the desktop app and keeps local data untouched', async () => {
  const data = emptyWorkspace();
  data.teams.push({ id: 'team', name: 'Vision lab', color: '#657b71' });
  data.projects.push(project('Personal research'), project('Legacy team research', 'team'));
  const { user, store, save } = fixture(data);
  await user.click(await nav(/团队项目/));
  const team = within(screen.getByRole('region', { name: '团队项目' }));
  expect(team.getByText('登录和协作同步需要在 Scientify 桌面应用中使用。')).toBeTruthy();
  expect(store.getState().data?.projects).toEqual(data.projects);
  expect(save).not.toHaveBeenCalled();
  // Projects that never synced stay personal, whatever space older versions gave them.
  await openMine(user);
  expect(await screen.findByRole('button', { name: 'Legacy team research' })).toBeTruthy();
});

it('says what deletion removes, keeps the project when saving fails and removes records after a retry', async () => {
  const data = emptyWorkspace();
  data.projects.push(project('Alpha'));
  data.records.push(createNote('Alpha', 'Keep until saved'));
  const { user, store, save } = fixture(data);
  await openMine(user);
  await user.click(await screen.findByRole('button', { name: '项目操作 Alpha' }));
  await user.click(screen.getByRole('menuitem', { name: '删除项目…' }));
  const dialog = within(screen.getByRole('dialog', { name: '删除“Alpha”？' }));
  expect(dialog.getByText(/笔记 1 条/)).toBeTruthy();
  save.mockRejectedValueOnce(new Error('Disk unavailable'));
  await user.click(dialog.getByRole('button', { name: '删除项目' }));
  await dialog.findByText('Disk unavailable');
  expect(store.getState().data?.projects).toHaveLength(1);
  expect(store.getState().data?.records).toHaveLength(1);
  await user.click(dialog.getByRole('button', { name: '删除项目' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(store.getState().data?.projects).toHaveLength(0);
  expect(store.getState().data?.records).toHaveLength(0);
});

it('archives instead of deleting when asked', async () => {
  const data = emptyWorkspace();
  data.projects.push(project('Alpha'));
  const { user, store } = fixture(data);
  await openMine(user);
  await user.click(await screen.findByRole('button', { name: '项目操作 Alpha' }));
  await user.click(screen.getByRole('menuitem', { name: '删除项目…' }));
  await user.click(screen.getByRole('button', { name: '改为归档' }));
  await waitFor(() => expect(store.getState().data?.projects[0].archived).toBe(true));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('edits projects from the context menu, restores keyboard focus and restores archived projects', async () => {
  const data = emptyWorkspace();
  data.projects.push({ ...project('Alpha'), archived: true });
  const { user, store } = fixture(data);
  await openMine(user);
  await user.click(await screen.findByRole('button', { name: /已归档/ }));
  const cover = await screen.findByRole('button', { name: 'Alpha' });
  fireEvent.contextMenu(cover);
  await user.click(await screen.findByRole('menuitem', { name: '编辑信息…' }));
  await user.clear(screen.getByLabelText('项目名称'));
  await user.type(screen.getByLabelText('项目名称'), 'Renamed');
  await user.click(screen.getByRole('button', { name: '保存项目' }));
  await waitFor(() => expect(store.getState().data?.projects[0].name).toBe('Renamed'));
  const renamed = screen.getByRole('button', { name: 'Renamed' });
  renamed.focus();
  await user.keyboard('{Shift>}{F10}{/Shift}');
  await screen.findByRole('menu');
  await user.keyboard('{End}');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '删除项目…' }));
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(renamed);
  fireEvent.contextMenu(renamed);
  await user.click(await screen.findByRole('menuitem', { name: '恢复' }));
  await waitFor(() => expect(store.getState().data?.projects[0].archived).toBe(false));
});

it('lists inbox notes and opens them in the notes panel', async () => {
  const data = emptyWorkspace();
  data.records.push({
    ...createNote('__inbox__', '组会要问的问题'),
    updatedAt: new Date().toISOString(),
  });
  const { user } = fixture(data);
  await user.click(await nav(/收集箱/));
  const inbox = within(screen.getByRole('region', { name: '收集箱' }));
  await user.click(inbox.getByRole('button', { name: /组会要问的问题/ }));
  expect(await screen.findByRole('region', { name: '研究笔记内容' })).toBeTruthy();
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

it('keeps solo synced projects personal and treats shared ones as team projects', () => {
  const remote = (id: string, role = 'owner') => ({ id, name: id, role });
  const me = { id: 'me', phone: '13800000000', role: 'owner' };
  expect(isTeamCloudProject(remote('solo'), undefined, [me], 'me')).toBe(false);
  expect(
    isTeamCloudProject(
      remote('invited'),
      undefined,
      [me, { id: 'invite:13900000000', phone: '13900000000', role: 'viewer', pending: true }],
      'me',
    ),
  ).toBe(true);
  expect(isTeamCloudProject(remote('joined', 'editor'), undefined, undefined, 'me')).toBe(true);
  const synced = { ...project('mine'), collaborationRole: 'owner' };
  expect(isTeamCloudProject(remote('mine'), synced, [me], 'me')).toBe(false);
  const shared = { ...synced, space: COLLABORATION_TEAM_ID };
  expect(isTeamCloudProject(remote('mine'), shared, [me], 'me')).toBe(true);
});

it('filters archived and favorite projects and sorts by name, creation or last opening', () => {
  const list: Project[] = [
    { ...project('b'), createdAt: '2026-01-02' },
    { ...project('a'), createdAt: '2026-01-03', favorite: true },
    { ...project('c'), createdAt: '2026-01-01', archived: true },
  ];
  expect(filterProjects(list, 'all', '').map((p) => p.id)).toEqual(['b', 'a']);
  expect(filterProjects(list, 'favorite', '').map((p) => p.id)).toEqual(['a']);
  expect(filterProjects(list, 'archived', '').map((p) => p.id)).toEqual(['c']);
  expect(sortProjects(list, 'name', {}).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  expect(sortProjects(list, 'created', {}).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  expect(sortProjects(list, 'opened', { c: '2026-11-01' }).map((p) => p.id)[0]).toBe('c');
});
