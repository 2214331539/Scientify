import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyWorkspace, type Workspace } from '../domain/workspace';
import { createWorkspaceStore } from '../stores/workspace';
import type { WorkspaceBackend } from '../platform/desktop';
import { App } from './App';

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

it('locks form fields while persistence is pending so late input cannot be lost', async () => {
  let complete!: () => void;
  const adapter: WorkspaceBackend = {
    load: async () => ({
      workspace: emptyWorkspace(),
      directory: 'test/data',
      legacyAvailable: false,
    }),
    save: (value) =>
      new Promise((resolve) => {
        complete = () => resolve(value);
      }),
    restore: async () => emptyWorkspace(),
    migrateLegacy: async () => emptyWorkspace(),
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  const store = createWorkspaceStore(adapter);
  const user = userEvent.setup();
  render(<App store={store} />);
  await screen.findByText('暂无项目');
  await user.click(screen.getAllByRole('button', { name: /新建项目/ })[0]);
  await user.type(screen.getByLabelText('项目名称'), '延迟保存');
  await user.keyboard('{Control>}k{/Control}');
  expect(screen.getByRole('dialog', { name: '新建科研项目' })).toBeTruthy();
  expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('延迟保存');
  await user.click(screen.getByRole('button', { name: '保存项目' }));
  expect((screen.getByLabelText('项目名称') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText('研究问题') as HTMLTextAreaElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: '关闭弹窗' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await act(async () => complete());
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(store.getState().data?.projects[0].name).toBe('延迟保存');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

it('creates a project, retains failed form edits, and retries into the real store', async () => {
  let disk: Workspace | null = null;
  const save = vi.fn(async (value: Workspace) => {
    disk = structuredClone(value);
    return value;
  });
  save.mockRejectedValueOnce(new Error('测试写入失败'));
  const adapter: WorkspaceBackend = {
    load: async () => ({ workspace: disk, directory: 'test/data', legacyAvailable: false }),
    save,
    restore: async () => emptyWorkspace(),
    migrateLegacy: async () => emptyWorkspace(),
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => 'F:\\research',
  };
  const store = createWorkspaceStore(adapter);
  const user = userEvent.setup();
  render(<App store={store} />);
  await screen.findByText('暂无项目');
  await user.click(screen.getAllByRole('button', { name: /新建项目/ })[0]);
  await user.type(screen.getByLabelText('项目名称'), '迁移验证项目');
  await user.type(screen.getByLabelText('研究问题'), '数据是否完整？');
  await user.click(screen.getByRole('button', { name: '保存项目' }));
  await screen.findByText('测试写入失败');
  expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('迁移验证项目');
  expect(store.getState().data?.projects).toHaveLength(0);
  expect(store.getState().dirty).toBe(true);
  await user.click(screen.getByRole('button', { name: '保存项目' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(store.getState().data?.projects[0].question).toBe('数据是否完整？');
  expect(store.getState().dirty).toBe(false);
  await user.click(screen.getByRole('button', { name: '项目操作 迁移验证项目' }));
  await user.click(screen.getByRole('menuitem', { name: '收藏' }));
  await waitFor(() => expect(store.getState().data?.projects[0].favorite).toBe(true));
  await user.click(screen.getByRole('button', { name: '项目操作 迁移验证项目' }));
  await user.click(screen.getByRole('menuitem', { name: '归档' }));
  await user.click(screen.getByRole('button', { name: '已归档' }));
  await user.click(await screen.findByRole('button', { name: '项目操作 迁移验证项目' }));
  await screen.findByRole('menuitem', { name: '恢复' });
});

it.each([
  ['restore', '恢复备份'],
  ['importWorkspace', '导入'],
] as const)(
  '%s replaces an open saved note with the same ID and edits the replacement rather than the stale draft',
  async (kind, action) => {
    const initial = emptyWorkspace();
    initial.projects.push({
      id: 'restore-project',
      name: '恢复测试项目',
      question: '',
      space: 'personal',
      createdAt: '2026-09-23',
    });
    initial.records.push({
      id: 'same-note',
      project: 'restore-project',
      title: '同 ID 笔记',
      body: '恢复前的旧正文',
      type: 'note',
      status: 'draft',
      createdAt: '2026-09-23',
      updatedAt: '2026-09-23',
    });
    const replacement = structuredClone(initial);
    replacement.revision = 20;
    replacement.records[0].body = '恢复后的权威正文';
    let disk = structuredClone(initial);
    const replace = vi.fn(async () => {
      disk = structuredClone(replacement);
      return structuredClone(disk);
    });
    const save = vi.fn(async (value: Workspace, expectedRevision: number) => {
      expect(expectedRevision).toBe(disk.revision);
      disk = structuredClone(value);
      return structuredClone(disk);
    });
    const adapter: WorkspaceBackend = {
      load: async () => ({
        workspace: structuredClone(disk),
        directory: 'test/data',
        legacyAvailable: false,
      }),
      save,
      restore: kind === 'restore' ? replace : async () => structuredClone(disk),
      migrateLegacy: async () => structuredClone(disk),
      importWorkspace: kind === 'importWorkspace' ? replace : async () => null,
      exportWorkspace: async () => true,
      chooseDirectory: async () => null,
    };
    localStorage.setItem(
      'scientify.ui.v1',
      JSON.stringify({
        version: 1,
        projectId: 'restore-project',
        space: 'personal',
        locations: {},
        dock: 'notes',
        dockOpen: true,
        leftWidth: 240,
        rightWidth: 340,
      }),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const store = createWorkspaceStore(adapter);
    const user = userEvent.setup();
    render(<App store={store} />);
    await user.click(
      within(await screen.findByRole('complementary', { name: '全局辅助工具' })).getByRole(
        'button',
        { name: /同 ID 笔记/ },
      ),
    );
    expect((screen.getByRole('textbox', { name: '笔记正文' }) as HTMLTextAreaElement).value).toBe(
      '恢复前的旧正文',
    );
    expect(store.getState().dirty).toBe(false);

    // Keep the note editor mounted behind the real data dialog while replacing its record.
    await user.click(screen.getByRole('button', { name: '数据与备份' }));
    await user.click(screen.getByRole('button', { name: action }));
    await waitFor(() => expect(replace).toHaveBeenCalledOnce());
    await waitFor(() => expect(store.getState().busy).toBe(false));
    expect(store.getState().data?.records[0].body).toBe('恢复后的权威正文');
    await user.click(screen.getByRole('button', { name: '关闭弹窗' }));

    // Cache invalidation returns the dock to its list; reopening must use restored content.
    expect(screen.queryByRole('textbox', { name: '笔记正文' })).toBeNull();
    await user.click(
      within(screen.getByRole('complementary', { name: '全局辅助工具' })).getByRole('button', {
        name: /同 ID 笔记/,
      }),
    );
    expect((screen.getByRole('textbox', { name: '笔记正文' }) as HTMLTextAreaElement).value).toBe(
      '恢复后的权威正文',
    );
    await user.type(screen.getByRole('textbox', { name: '笔记正文' }), '，新的补充');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(store.getState().dirty).toBe(false));
    expect(save).toHaveBeenCalledOnce();
    expect(disk.records[0]).toMatchObject({ id: 'same-note', body: '恢复后的权威正文，新的补充' });
    expect(JSON.stringify(save.mock.calls)).not.toContain('恢复前的旧正文');
  },
);
