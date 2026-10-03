import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { emptyWorkspace, normalizeExperiments } from '../../domain/workspace';
import { createWorkspaceStore } from '../../stores/workspace';
import { ExperimentManager } from './ExperimentManager';
import { experimentCatalog, sameCodeRoot } from './catalog';
import { codeContext, selectExperiment } from './code-context';
import { ConfigurationForm } from './ExperimentWorkspace';
import { developmentStore } from './development';
vi.mock('../../components/prompts', () => ({
  confirmAction: vi.fn(async () => true),
  requestText: vi.fn(async () => 'Renamed'),
}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  codeContext.setState({ roots: {}, experiments: {} });
  developmentStore.setState({ terminals: [], tasks: [] });
  localStorage.removeItem('scientify.experiments.layout.v1');
});
async function setup() {
  const data = normalizeExperiments(emptyWorkspace());
  const project = {
    id: 'p1',
    name: 'Research',
    question: '',
    space: 'personal',
    createdAt: '2026-10-02',
  };
  data.projects.push(project);
  const store = createWorkspaceStore({
    load: async () => ({ workspace: data, directory: '', legacyAvailable: false }),
    save: async (d) => d,
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => 'F:/fixture/ablation',
  });
  await store.getState().load();
  return { store, project };
}
it('migrates once, keeps removed experiments removed and accepts maximum-length legacy ids', () => {
  const data = emptyWorkspace();
  data.projects.push({
    id: 'x'.repeat(80),
    name: 'Old',
    question: '',
    space: 'personal',
    createdAt: 'now',
    path: 'F:/old',
    runConfigurations: [{ id: 'c1' }],
  });
  normalizeExperiments(data);
  expect(data.experiments?.[0].id).toHaveLength(80);
  expect(data.experiments?.[0].runConfigurations).toEqual([{ id: 'c1' }]);
  normalizeExperiments(data);
  expect(data.experiments).toHaveLength(1);
  data.experiments = [];
  normalizeExperiments(data);
  expect(data.experiments).toEqual([]);
});
it('registers a new isolated root and retains it when renaming, archiving and removing metadata', async () => {
  const { store, project } = await setup();
  vi.spyOn(experimentCatalog, 'available').mockReturnValue(true);
  vi.spyOn(experimentCatalog, 'prepare').mockResolvedValue({
    id: 'e2',
    root: 'F:/fixture/ablation',
    source: 'existing',
  });
  const opened = vi.fn();
  const user = userEvent.setup();
  render(<ExperimentManager project={project} store={store} executions={[]} onOpen={opened} />);
  await user.click(screen.getByRole('button', { name: '新建实验' }));
  await user.type(screen.getByLabelText('实验名称'), 'Ablation');
  await user.selectOptions(screen.getByLabelText('代码来源'), 'existing');
  await user.click(screen.getByRole('button', { name: '选择目录' }));
  await user.click(screen.getByRole('button', { name: '创建实验' }));
  await waitFor(() =>
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e2', root: 'F:/fixture/ablation' }),
    ),
  );
  await user.click(screen.getAllByRole('button', { name: '重命名实验' })[1]);
  await waitFor(() => expect(store.getState().data?.experiments?.[1].name).toBe('Renamed'));
  await user.click(screen.getAllByRole('button', { name: '归档实验' })[1]);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Renamed' })).toBeNull());
  await user.click(screen.getByRole('checkbox', { name: '显示归档' }));
  expect((screen.getByRole('button', { name: 'Renamed' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await user.click(screen.getByRole('button', { name: '恢复实验' }));
  await waitFor(() => expect(store.getState().data?.experiments?.[1].archived).toBe(false));
  await user.click(screen.getAllByRole('button', { name: '移除实验' })[1]);
  await waitFor(() => expect(store.getState().data?.experiments).toHaveLength(1));
});
it('saves configurations to the selected experiment and preserves the sibling configuration', async () => {
  const { store, project } = await setup();
  await store.getState().update((data) => {
    data.experiments!.push({
      ...data.experiments![0],
      id: 'e2',
      name: 'Ablation',
      root: 'F:/ablation',
      source: 'existing',
      runConfigurations: [],
    });
  });
  const user = userEvent.setup();
  render(
    <ConfigurationForm
      project={project}
      experimentId="e2"
      store={store}
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
  await user.type(screen.getByLabelText('配置名称'), 'Train');
  await user.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() =>
    expect(store.getState().data?.experiments?.[1].runConfigurations).toEqual([
      expect.objectContaining({ name: 'Train' }),
    ]),
  );
  expect(store.getState().data?.experiments?.[0].runConfigurations).toEqual([]);
  act(() => selectExperiment('p1', store.getState().data!.experiments![1]));
  expect(codeContext.getState().roots.p1).toBe('F:/ablation');
  expect(sameCodeRoot('\\\\?\\F:\\ablation', 'f:/ablation')).toBe(true);
});
it('prevents removing an experiment with a running chat while other experiments stay editable', async () => {
  const { store, project } = await setup();
  await store.getState().update((data) => {
    data.sessions.push({ id: 'chat', project: 'p1', experimentId: 'p1' });
  });
  store.getState().setAgentTask('p1:chat', 'p1');
  render(<ExperimentManager project={project} store={store} executions={[]} onOpen={() => {}} />);
  await userEvent.setup().click(screen.getByRole('button', { name: '移除实验' }));
  expect(screen.getByRole('alert').textContent).toContain('请先停止');
  expect(store.getState().data?.experiments).toHaveLength(1);
});
it('switches card and vertical layouts, expands details and remembers the display preference', async () => {
  const { store, project } = await setup();
  const user = userEvent.setup();
  render(<ExperimentManager project={project} store={store} executions={[]} onOpen={() => {}} />);
  expect(screen.getByRole('button', { name: '卡片视图' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  const details = screen.getByText('实验详情').closest('details')!;
  await user.click(screen.getByText('实验详情'));
  expect(details.open).toBe(true);
  await user.click(screen.getByRole('button', { name: '列表视图' }));
  expect(screen.getByRole('table')).toBeTruthy();
  expect(localStorage.getItem('scientify.experiments.layout.v1')).toBe('list');
  expect(store.getState().data?.experiments).toHaveLength(1);
  cleanup();
  render(<ExperimentManager project={project} store={store} executions={[]} onOpen={() => {}} />);
  expect(screen.getByRole('button', { name: '列表视图' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
});
