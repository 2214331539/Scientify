import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectSyncControl } from './ProjectSyncControl';
import { collaboration, canEditProject, type ProjectSyncState } from '../../platform/collaboration';
import { createWorkspaceStore } from '../../stores/workspace';
import { emptyWorkspace, type Workspace } from '../../domain/workspace';
import type { WorkspaceBackend } from '../../platform/desktop';
import { NotesPanel } from '../notes/NotesPanel';
import { createNote, expiredNotes } from '../notes/model';

vi.mock('../../components/prompts', () => ({ confirmAction: vi.fn(async () => true) }));
const project = {
  id: 'p',
  name: 'Study',
  question: '',
  space: 'personal',
  createdAt: '',
  collaborationRole: 'owner',
};
const conflict = { domain: 'record', path: 'n', copy: 'copy', at: '2026-11-11T00:00:00Z' };
let info: ProjectSyncState;
beforeEach(() => {
  info = {
    lastSyncAt: null,
    lastError: null,
    conflicts: [],
    tracked: 3,
    pending: 2,
    paused: false,
    libraryRoot: null,
  };
  vi.spyOn(collaboration, 'status').mockResolvedValue({
    authenticated: true,
    enabled: true,
    clientId: 'd',
    endpoint: '',
    userId: 'u',
    phone: null,
  });
  vi.spyOn(collaboration, 'syncState').mockImplementation(async () => ({ ...info }));
  vi.spyOn(collaboration, 'setProjectSync').mockImplementation(async (_, enabled) => {
    info = { ...info, paused: !enabled };
  });
  vi.spyOn(collaboration, 'conflictPreview').mockResolvedValue({
    token: 'version',
    canKeepLocal: true,
    canKeepBoth: true,
    local: { text: 'my edit', bytes: 7, exists: true, truncated: false },
    remote: { text: 'their edit', bytes: 10, exists: true, truncated: false },
  });
  vi.spyOn(collaboration, 'resolveConflict').mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function fixture(role = 'owner') {
  let data = emptyWorkspace();
  data.projects = [{ ...project, collaborationRole: role }];
  data.records = [createNote('p', 'Note', 'original')];
  const save = vi.fn(async (next: Workspace) => {
    data = next;
    return next;
  });
  const backend: WorkspaceBackend = {
    load: async () => ({ workspace: data, directory: 'test', legacyAvailable: false }),
    save,
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  const store = createWorkspaceStore(backend);
  await store.getState().load();
  return { store, save };
}

it('compares two versions and sends the preview token with the selected resolution', async () => {
  info.conflicts = [conflict];
  const { store } = await fixture();
  const user = userEvent.setup();
  render(<ProjectSyncControl project={project} store={store} />);
  await user.click(await screen.findByRole('button', { name: '项目同步：有冲突' }));
  await user.click(screen.getByRole('button', { name: '查看对比' }));
  expect(await screen.findByText('my edit')).toBeTruthy();
  expect(screen.getByText('their edit')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '保留本机' }));
  await waitFor(() =>
    expect(collaboration.resolveConflict).toHaveBeenCalledWith('p', conflict, 'version', 'local'),
  );
});

it('syncs by itself and shows failures and members with no buttons to press', async () => {
  vi.spyOn(collaboration, 'syncProject').mockRejectedValue(new Error('测试连接中断'));
  vi.spyOn(collaboration, 'members').mockResolvedValue({
    members: [{ id: 'u', phone: '18200000000', role: 'owner' }],
  });
  const { store } = await fixture();
  const user = userEvent.setup();
  render(<ProjectSyncControl project={project} store={store} automatic />);
  await user.click(await screen.findByRole('button', { name: '项目同步：同步失败' }));
  expect(screen.getByRole('alert').textContent).toContain('测试连接中断');
  expect(screen.queryByRole('button', { name: '立即同步' })).toBeNull();
  expect(screen.queryByRole('button', { name: /本机同步/ })).toBeNull();
  expect(await screen.findByText('我')).toBeTruthy();
  expect(store.getState().data?.projects[0].collaborationRole).toBe('owner');
});

it('keeps drafts safe by disabling conflict resolution while anything is unsaved', async () => {
  info.conflicts = [conflict];
  const { store } = await fixture();
  store.getState().setDirty(true);
  const user = userEvent.setup();
  render(<ProjectSyncControl project={project} store={store} />);
  await user.click(await screen.findByRole('button', { name: '项目同步：有冲突' }));
  await user.click(screen.getByRole('button', { name: '查看对比' }));
  const button = await screen.findByRole('button', { name: '保留本机' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  await user.click(button);
  expect(collaboration.resolveConflict).not.toHaveBeenCalled();
});

it('makes viewer notes read-only and rejects writes even without going through the editor', async () => {
  const { store, save } = await fixture('viewer');
  const user = userEvent.setup();
  render(
    <NotesPanel
      store={store}
      scope="p"
      context={{ projectId: 'p', workspace: 'notes', title: 'Notes' }}
    />,
  );
  expect(screen.queryByRole('button', { name: '新建笔记' })).toBeNull();
  await user.click(screen.getByRole('button', { name: /Note/ }));
  expect((screen.getByLabelText('笔记标题') as HTMLInputElement).disabled).toBe(true);
  expect(
    await store.getState().update((data) => {
      data.records[0].body = 'bypass';
    }),
  ).toBe(false);
  expect(save).not.toHaveBeenCalled();
  expect(store.getState().data?.records[0].body).toBe('original');
});

it('allows reviewers to edit project notes only and leaves viewer trash for an editor to purge', async () => {
  const { store } = await fixture('reviewer');
  expect(
    await store.getState().update((data) => {
      data.records[0].body = 'review';
    }),
  ).toBe(true);
  expect(
    await store.getState().update((data) => {
      data.projects[0].name = 'changed';
    }),
  ).toBe(false);
  expect(canEditProject({ collaborationRole: 'reviewer' }, 'library')).toBe(false);
  const data = store.getState().data!;
  data.projects[0].collaborationRole = 'viewer';
  data.records[0].deletedAt = '2020-01-01';
  expect(expiredNotes(data)).toEqual([]);
});

it('shares from a card under the button: invite, change a role, remove someone', async () => {
  vi.spyOn(collaboration, 'syncProject').mockResolvedValue({
    pulled: 0,
    applied: 0,
    pushed: 0,
    conflicts: 0,
    skipped: 0,
    deferred: 0,
    errors: [],
    changed: [],
    libraryRoot: null,
    lastSyncAt: '2026-11-19T08:00:00Z',
  } as never);
  const members = vi.spyOn(collaboration, 'members').mockResolvedValue({
    members: [
      { id: 'u', phone: '18200000000', role: 'owner' },
      { id: 'm', phone: '13800001234', role: 'editor' },
    ],
  });
  const invite = vi.spyOn(collaboration, 'inviteMember').mockResolvedValue({ ok: true });
  const remove = vi.spyOn(collaboration, 'removeMember').mockResolvedValue({ ok: true });
  const { store } = await fixture();
  const user = userEvent.setup();
  render(<ProjectSyncControl project={project} store={store} trigger="share" />);
  await user.click(await screen.findByRole('button', { name: /共享与同步/ }));
  expect(screen.getByRole('heading', { name: '共享「Study」' })).toBeTruthy();
  expect(await screen.findByText('我')).toBeTruthy();
  await user.type(screen.getByRole('textbox', { name: '成员手机号' }), '13900005678{Enter}');
  await waitFor(() => expect(invite).toHaveBeenCalledWith('p', '13900005678', 'editor'));
  await user.click(screen.getByRole('button', { name: /138\*{4}1234 的角色/ }));
  await user.click(await screen.findByRole('menuitemradio', { name: /查看者/ }));
  await waitFor(() => expect(invite).toHaveBeenLastCalledWith('p', '13800001234', 'viewer'));
  await user.click(screen.getByRole('button', { name: /138\*{4}1234 的角色/ }));
  await user.click(await screen.findByRole('menuitem', { name: '移出项目' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith('p', 'm'));
  expect(members).toHaveBeenCalled();
});
