import { describe, expect, it, vi } from 'vitest';
import { emptyWorkspace, selectProjects, type Workspace } from '../domain/workspace';
import type { WorkspaceBackend } from '../platform/desktop';
import { createWorkspaceStore } from './workspace';

function backend(initial = emptyWorkspace()): WorkspaceBackend {
  let disk = structuredClone(initial);
  return {
    load: async () => ({
      workspace: structuredClone(disk),
      directory: 'test/workspace',
      legacyAvailable: false,
    }),
    save: vi.fn(async (next, expected) => {
      if (disk.revision !== expected) throw new Error('冲突');
      disk = structuredClone(next);
      return structuredClone(disk);
    }),
    restore: async () => disk,
    migrateLegacy: async () => disk,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
}

describe('workspace transaction boundary', () => {
  it('keeps unmigrated records and extension fields across project edits', async () => {
    const data = emptyWorkspace();
    data.projects.push({
      id: 'p',
      name: '旧项目',
      question: '',
      space: 'personal',
      createdAt: '2026-09-23',
      future: { retained: true },
    });
    data.records.push({
      id: 'r',
      project: 'p',
      title: '研究',
      body: '不可丢失',
      type: '想法',
      status: '待梳理',
      createdAt: '',
      updatedAt: '',
    });
    const adapter = backend(data),
      store = createWorkspaceStore(adapter);
    await store.getState().load();
    expect(
      await store.getState().update((d) => {
        d.projects[0].name = '新名称';
      }),
    ).toBe(true);
    expect(store.getState().data?.records).toEqual(data.records);
    expect(store.getState().data?.projects[0].future).toEqual({ retained: true });
    expect(adapter.save).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }), 0);
  });
  it('does not publish failed saves and permits retry', async () => {
    const adapter = backend(),
      store = createWorkspaceStore(adapter);
    await store.getState().load();
    vi.mocked(adapter.save).mockRejectedValueOnce(new Error('磁盘已满'));
    expect(
      await store.getState().update((d) => {
        d.settings.name = 'Ada';
      }),
    ).toBe(false);
    expect(store.getState().data?.settings.name).toBe('');
    expect(store.getState().data?.revision).toBe(0);
    expect(store.getState().busy).toBe(false);
    expect(store.getState().error).toBe('磁盘已满');
    expect(
      await store.getState().update((d) => {
        d.settings.name = 'Ada';
      }),
    ).toBe(true);
    expect(store.getState().data?.settings.name).toBe('Ada');
  });
  it('serializes concurrent edits against the latest committed revision', async () => {
    const adapter = backend(),
      store = createWorkspaceStore(adapter);
    await store.getState().load();
    let finish!: (value: Workspace) => void;
    vi.mocked(adapter.save).mockImplementationOnce(
      (value) =>
        new Promise((resolve) => {
          finish = () => resolve(value);
        }),
    );
    const first = store.getState().update((d) => {
      d.settings.name = 'first';
    });
    const second = store.getState().update((d) => {
      d.settings.theme = 'dark';
    });
    expect(store.getState().busy).toBe(true);
    vi.mocked(adapter.save).mockImplementation(async (value) => value);
    finish(emptyWorkspace());
    await first;
    expect(await second).toBe(true);
    expect(store.getState().data?.settings.name).toBe('first');
    expect(store.getState().data?.settings.theme).toBe('dark');
    expect(store.getState().data?.revision).toBe(2);
  });
  it('tracks independent unsaved editors without clearing another source', () => {
    const store = createWorkspaceStore(backend());
    store.getState().setDirtySource('note', true);
    store.getState().setDirty(true);
    store.getState().setDirty(false);
    expect(store.getState().dirty).toBe(true);
    store.getState().setDirtySource('note', false);
    expect(store.getState().dirty).toBe(false);
  });
  it('does not replace data on cancelled import or while a form is dirty', async () => {
    const adapter = backend(),
      store = createWorkspaceStore(adapter);
    const load = vi.spyOn(adapter, 'load');
    await store.getState().load();
    const before = store.getState().data;
    expect(await store.getState().replace('importWorkspace')).toBe(false);
    expect(store.getState().data).toBe(before);
    store.getState().setDirty(true);
    await store.getState().load();
    expect(load).toHaveBeenCalledTimes(1);
    expect(await store.getState().replace('restore')).toBe(false);
  });
  it('isolates team projects, archived state and search', () => {
    const data = emptyWorkspace();
    data.projects = [
      { id: 'a', name: '个人研究', question: '泛化', space: 'personal', createdAt: '2026-09-01' },
      {
        id: 'b',
        name: '团队研究',
        question: '泛化',
        space: 'team',
        createdAt: '2026-09-02',
        favorite: true,
      },
      {
        id: 'c',
        name: '旧课题',
        question: '',
        space: 'personal',
        createdAt: '2026-09-03',
        archived: true,
      },
    ];
    expect(selectProjects(data, 'personal', '').map((p) => p.id)).toEqual(['c', 'a']);
    expect(selectProjects(data, 'team', '泛化').map((p) => p.id)).toEqual(['b']);
    expect(selectProjects(data, 'personal', '不存在')).toEqual([]);
  });
});
