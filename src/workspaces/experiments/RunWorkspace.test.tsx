import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyWorkspace, type Project, type Workspace } from '../../domain/workspace';
import type { WorkspaceBackend } from '../../platform/desktop';
import { createWorkspaceStore } from '../../stores/workspace';
import { RunWorkspace } from './RunWorkspace';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);
const project: Project = {
  id: 'p1',
  name: 'Experiment',
  question: '',
  space: 'personal',
  createdAt: '2026-09-23',
};
async function setup(data = emptyWorkspace()) {
  const backend: WorkspaceBackend = {
    load: async () => ({ workspace: data, directory: '', legacyAvailable: false }),
    save: vi.fn(async (draft) => draft),
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  const store = createWorkspaceStore(backend);
  await store.getState().load();
  return { backend, store };
}

it('keeps failed experimental notes and saves finite numeric or missing metrics on retry', async () => {
  const { backend, store } = await setup();
  vi.mocked(backend.save).mockRejectedValueOnce(new Error('写入失败'));
  const user = userEvent.setup();
  render(<RunWorkspace project={project} store={store} onContext={vi.fn()} />);
  await user.click(screen.getAllByRole('button', { name: '新建记录' })[0]);
  await user.type(screen.getByLabelText('实验名称'), 'Ablation test');
  await user.type(screen.getByLabelText('结果与结论'), 'The smaller model converges faster.');
  await user.click(screen.getByRole('button', { name: '添加指标' }));
  await user.type(screen.getByLabelText('指标 1 名称'), 'loss');
  await user.type(screen.getByLabelText('指标 1 数值'), '0.12');
  await user.click(screen.getByRole('button', { name: '添加指标' }));
  await user.type(screen.getByLabelText('指标 2 名称'), 'accuracy');
  await user.click(screen.getByRole('button', { name: '保存实验记录' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '写入失败');
  expect((screen.getByLabelText('实验名称') as HTMLInputElement).value).toBe('Ablation test');
  expect(store.getState().dirtySources['run-form:p1:new']).toBe(true);
  await user.click(screen.getByRole('button', { name: '保存实验记录' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(store.getState().data?.runs[0]).toMatchObject({
    project: 'p1',
    name: 'Ablation test',
    metrics: [
      { name: 'loss', value: 0.12 },
      { name: 'accuracy', value: null },
    ],
  });
  expect(store.getState().dirty).toBe(false);
});

it('preserves old run and metric extension fields while editing known fields', async () => {
  const data = emptyWorkspace();
  data.runs.push({
    id: 'r1',
    project: 'p1',
    name: 'Original',
    protocol: '',
    config: '',
    conclusion: '',
    status: 'completed',
    updatedAt: '2026-09-23',
    legacyArtifact: 'keep-me',
    metrics: [{ name: 'duration', value: 2, unit: 'seconds' }],
  });
  const { store } = await setup(data);
  const user = userEvent.setup();
  render(<RunWorkspace project={project} store={store} onContext={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: '编辑记录' }));
  await user.clear(screen.getByLabelText('实验名称'));
  await user.type(screen.getByLabelText('实验名称'), 'Renamed');
  await user.click(screen.getByRole('button', { name: '保存实验记录' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(store.getState().data?.runs[0]).toMatchObject({
    name: 'Renamed',
    legacyArtifact: 'keep-me',
    metrics: [{ name: 'duration', value: 2, unit: 'seconds' }],
  });
});

it('blocks invalid metrics and disables fields until an in-flight save is acknowledged', async () => {
  const { store, backend } = await setup();
  const user = userEvent.setup();
  let finish!: (value: Workspace) => void;
  let pending!: Workspace;
  backend.save = vi.fn((value) => {
    pending = value;
    return new Promise<Workspace>((resolve) => {
      finish = resolve;
    });
  });
  render(<RunWorkspace project={project} store={store} onContext={vi.fn()} />);
  await user.click(screen.getAllByRole('button', { name: '新建记录' })[0]);
  await user.type(screen.getByLabelText('实验名称'), 'Pending');
  await user.click(screen.getByRole('button', { name: '添加指标' }));
  await user.type(screen.getByLabelText('指标 1 名称'), 'bad');
  await user.type(screen.getByLabelText('指标 1 数值'), 'NaN');
  await user.click(screen.getByRole('button', { name: '保存实验记录' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    '每项指标需有名称，数值应为有限数字，也可以留空。',
  );
  expect(backend.save).not.toHaveBeenCalled();
  await user.clear(screen.getByLabelText('指标 1 数值'));
  await user.type(screen.getByLabelText('指标 1 数值'), '3');
  await user.click(screen.getByRole('button', { name: '保存实验记录' }));
  expect(screen.getByLabelText('实验名称').closest('fieldset')?.disabled).toBe(true);
  expect((screen.getByRole('button', { name: '关闭弹窗' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await act(async () => finish(pending));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
