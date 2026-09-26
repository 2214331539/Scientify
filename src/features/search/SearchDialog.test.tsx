import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyWorkspace } from '../../domain/workspace';
import type { WorkspaceBackend } from '../../platform/desktop';
import { createWorkspaceStore } from '../../stores/workspace';
import { createNote } from '../notes/model';
import { SearchDialog, searchWorkspace } from './SearchDialog';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

function fixture() {
  const data = emptyWorkspace();
  data.projects.push({
    id: 'p1',
    name: '检索实验',
    question: '验证检索结论',
    space: 'personal',
    createdAt: '',
  });
  data.papers.push({ id: 'paper', title: '检索论文', authors: '科研作者', projects: ['p1'] });
  data.records.push(
    createNote('p1', '实验结论', '检索的主要发现'),
    createNote('__inbox__', '个人想法', '检索待办'),
  );
  return data;
}

it('searches actual fields, carries scopes and returns no invented empty-query results', () => {
  const data = fixture();
  expect(searchWorkspace(data, '')).toEqual([]);
  const results = searchWorkspace(data, '检索');
  expect(results).toHaveLength(4);
  expect(results.find((result) => result.title === '个人想法')?.target).toMatchObject({
    projectId: undefined,
    workspace: 'projects',
    tool: 'notes',
  });
  expect(searchWorkspace(data, '科研作者')[0].target).toMatchObject({
    projectId: 'p1',
    workspace: 'literature',
    resourceId: 'paper',
  });
  expect(searchWorkspace(data, '未存在的材料')).toEqual([]);
});

it('navigates a matching saved note with its project and resource identity', async () => {
  const data = fixture();
  const adapter: WorkspaceBackend = {
    load: async () => ({ workspace: data, directory: '', legacyAvailable: false }),
    save: async (value) => value,
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  const store = createWorkspaceStore(adapter);
  await store.getState().load();
  const navigate = vi.fn();
  const close = vi.fn();
  const user = userEvent.setup();
  render(<SearchDialog store={store} onClose={close} onNavigate={navigate} />);
  await user.type(screen.getByLabelText('搜索项目、文献和笔记'), '主要发现');
  await user.click(screen.getByRole('button', { name: /实验结论/ }));
  expect(navigate).toHaveBeenCalledWith({
    projectId: 'p1',
    workspace: 'overview',
    resourceId: data.records[0].id,
    tool: 'notes',
  });
  expect(close).toHaveBeenCalledOnce();
});
