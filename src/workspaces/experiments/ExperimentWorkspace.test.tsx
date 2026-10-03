import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, useSyncExternalStore } from 'react';
import { emptyWorkspace, type Project } from '../../domain/workspace';
import { createWorkspaceStore } from '../../stores/workspace';
import type { ResearchBackend } from '../../platform/research';
import type { FileSession } from '../../editor/sessions';
import { getFileSession } from '../../editor/sessions';
import { ExperimentWorkspace, ConfigurationForm } from './ExperimentWorkspace';
import { ExperimentRuns } from './ExperimentRuns';
import {
  configurationsOf,
  executionStore,
  experimentApi,
  parseArguments,
  startExecution,
  useExecutions,
  type Execution,
} from './runtime';
import { ExecutionPanel, numericMetrics } from './ExecutionPanel';
import { ChangesWorkspace, splitPatch } from './ChangesWorkspace';
import { codeContext, selectExperiment } from './code-context';
vi.mock('../../components/prompts', () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock('../../editor/CodeEditor', () => ({
  CodeEditor: ({ session }: { session: FileSession }) => {
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
    return (
      <textarea
        aria-label="代码编辑"
        value={snapshot.content}
        onChange={(e) => session.edit(e.target.value)}
      />
    );
  },
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
  executionStore.setState({ runs: [], error: '' });
  codeContext.setState({ roots: {}, experiments: {} });
});
const project: Project = {
  id: 'p1',
  name: 'Test',
  question: '',
  space: 'personal',
  createdAt: '2026-10-01',
};
const config = { id: 'c1', name: 'Baseline', executable: 'python', args: ['train.py'], cwd: '.' };
it('switches experiment configurations and files while preserving the previous draft and chat binding', async () => {
  const { store, backend } = await setup();
  await store.getState().update((data) => {
    data.experiments![0].root = 'F:/fixture/a';
    data.experiments![0].source = 'existing';
    data.experiments!.push({
      ...data.experiments![0],
      id: 'e2',
      name: 'Ablation',
      root: 'F:/fixture/b',
      runConfigurations: [{ ...config, id: 'c2', name: 'Ablation config' }],
    });
    data.sessions.push({
      id: 'old-chat',
      project: 'p1',
      experimentId: 'p1',
      agentCwd: 'F:/fixture/a',
    });
  });
  selectExperiment('p1', store.getState().data!.experiments![0]);
  vi.mocked(backend.readFile).mockImplementation(async (_project, path, root) => ({
    path,
    content: root === 'F:/fixture/b' ? 'print("B")' : 'print("A")',
    version: 'v1',
  }));
  const onContext = vi.fn();
  function Harness() {
    const [view, setView] = useState('files');
    const [path, setPath] = useState<string | null>('train.py');
    return (
      <ExperimentWorkspace
        project={project}
        store={store}
        backend={backend}
        executions={[]}
        runtimeError=""
        view={view}
        onView={setView}
        activePath={path}
        onOpen={setPath}
        onSelect={() => {}}
        onContext={onContext}
        sidebarOpen
        onSidebarToggle={() => {}}
        width={220}
        resize={null}
      />
    );
  }
  const user = userEvent.setup();
  render(<Harness />);
  await waitFor(() =>
    expect(
      (screen.getByRole('textbox', { name: '代码编辑' }) as HTMLTextAreaElement).value,
    ).toContain('"A"'),
  );
  await user.type(screen.getByRole('textbox', { name: '代码编辑' }), '# A draft');
  await user.selectOptions(screen.getByLabelText('当前实验'), 'e2');
  await user.click(await screen.findByRole('treeitem', { name: 'train.py' }));
  await waitFor(() =>
    expect((screen.getByRole('textbox', { name: '代码编辑' }) as HTMLTextAreaElement).value).toBe(
      'print("B")',
    ),
  );
  expect((screen.getByLabelText('运行配置') as HTMLSelectElement).textContent).toContain(
    'Ablation config',
  );
  expect((screen.getByLabelText('运行配置') as HTMLSelectElement).textContent).not.toContain(
    'Baseline',
  );
  await user.selectOptions(screen.getByLabelText('当前实验'), 'p1');
  await waitFor(() =>
    expect(
      (screen.getByRole('textbox', { name: '代码编辑' }) as HTMLTextAreaElement).value,
    ).toContain('# A draft'),
  );
  expect(getFileSession(backend, 'p1', 'train.py', 'F:/fixture/a').getSnapshot().dirty).toBe(true);
  expect(store.getState().data?.sessions[0].agentCwd).toBe('F:/fixture/a');
  expect(store.getState().data?.sessions[0].experimentId).toBe('p1');
});
const run: Execution = {
  id: 'r1',
  project: 'p1',
  name: 'Baseline',
  status: 'completed',
  startedAt: 1000,
  endedAt: 2000,
  exitCode: 0,
  configuration: config,
  directory: 'C:/test',
  executable: 'C:/Python/python.exe',
  platform: 'windows / x86_64',
  gitCommit: null,
  gitChanges: [],
  error: null,
};
async function setup() {
  const data = emptyWorkspace();
  data.projects = [{ ...project, runConfigurations: [config] }];
  const persistence = {
    load: async () => ({ workspace: data, directory: '', legacyAvailable: false }),
    save: vi.fn(async (d: typeof data) => d),
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  const store = createWorkspaceStore(persistence);
  await store.getState().load();
  const backend: ResearchBackend = {
    listFiles: async () => [{ path: 'train.py', name: 'train.py', kind: 'file', size: 20 }],
    readFile: vi.fn(async (_p, path) => ({ path, content: 'print(1)', version: 'v1' })),
    writeFile: vi.fn(async (_p, path, content) => ({ path, content, version: 'v2' })),
    gitStatus: async () => [],
    importPdf: async () => null,
    readPdf: async () => new Uint8Array(),
    askAI: async () => '',
    listModels: async () => [],
    testModel: async () => {},
    fetchArxiv: async () => '',
  };
  return { store, backend, persistence };
}
it('preserves existing runs and tasks when the native list response is invalid', async () => {
  const { store } = await setup();
  executionStore.setState({ runs: [run], error: '' });
  store.getState().setAgentTask('experiment:r1', 'p1');
  vi.spyOn(experimentApi, 'available').mockReturnValue(true);
  vi.spyOn(experimentApi, 'list').mockResolvedValue(undefined as unknown as Execution[]);
  function Harness() {
    const snapshot = useExecutions(store);
    return <span role="status">{snapshot.error}</span>;
  }
  render(<Harness />);
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('Invalid experiment list'),
  );
  expect(executionStore.getState().runs).toEqual([run]);
  expect(store.getState().agentTasks['experiment:r1']).toBe('p1');
});
it('validates structured configuration and numeric metrics without coercion', () => {
  expect(parseArguments('[' + '"a b", "--seed", "42"' + ']')).toEqual(['a b', '--seed', '42']);
  expect(() => parseArguments('{"args":1}')).toThrow();
  expect(() => parseArguments('[1]')).toThrow();
  expect(configurationsOf([{ ...config, args: [1] }])).toEqual([]);
  expect(numericMetrics({ accuracy: 0.8, loss: 0 })).toEqual([
    { name: 'accuracy', value: 0.8 },
    { name: 'loss', value: 0 },
  ]);
  expect(() => numericMetrics({ loss: '0.2' })).toThrow();
  expect(() => numericMetrics({ loss: Infinity })).toThrow();
});
it('disables code navigation when the Git repository has a different root', async () => {
  const { backend } = await setup();
  backend.gitStatus = vi.fn(async () => [{ path: 'train.py', status: 'M' }]);
  vi.spyOn(experimentApi, 'diff').mockResolvedValue('@@ -1 +1 @@\n-old\n+new\n');
  const onOpen = vi.fn();
  render(<ChangesWorkspace projectId="p1" backend={backend} canOpenFile={false} onOpen={onOpen} />);
  await userEvent.setup().click(await screen.findByRole('button', { name: /train\.py/ }));
  await waitFor(() => expect(screen.getByRole('table', { name: '文件版本差异' })).toBeTruthy());
  expect((screen.getByRole('button', { name: '打开文件' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(onOpen).not.toHaveBeenCalled();
});
it('pairs real unified hunks with correct independent line numbers', () => {
  const rows = splitPatch(
    '--- a/x\n+++ b/x\n@@ -2,3 +2,4 @@\n before\n-old\n+new\n+extra\n after\n@@ -20 +21 @@\n-a\n+b\n',
  );
  expect(rows[2]).toMatchObject({
    kind: 'change',
    oldNumber: 3,
    newNumber: 3,
    oldText: 'old',
    newText: 'new',
  });
  expect(rows[3]).toMatchObject({ newNumber: 4, newText: 'extra' });
  expect(rows.at(-1)).toMatchObject({ oldNumber: 20, newNumber: 21 });
});
it('preserves configuration input after persistence fails and keeps project extensions', async () => {
  const { store, persistence } = await setup();
  vi.mocked(persistence.save).mockRejectedValueOnce(new Error('写入失败'));
  const saved = vi.fn();
  const user = userEvent.setup();
  render(
    <ConfigurationForm
      project={project}
      store={store}
      initial={config}
      onClose={vi.fn()}
      onSaved={saved}
    />,
  );
  await user.clear(screen.getByLabelText('配置名称'));
  await user.type(screen.getByLabelText('配置名称'), 'New name');
  await user.click(screen.getByRole('button', { name: '保存配置' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '写入失败');
  expect((screen.getByLabelText('配置名称') as HTMLInputElement).value).toBe('New name');
  expect(store.getState().dirty).toBe(true);
  await user.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(saved).toHaveBeenCalledWith('c1'));
  expect(configurationsOf(store.getState().data?.projects[0].runConfigurations)[0].name).toBe(
    'New name',
  );
});
it('preserves code draft across Runs and blocks execution when saving fails', async () => {
  const { store, backend } = await setup();
  const user = userEvent.setup();
  vi.spyOn(experimentApi, 'available').mockReturnValue(true);
  const start = vi.spyOn(experimentApi, 'start').mockResolvedValue(run);
  function Harness() {
    const [view, setView] = useState('files');
    return (
      <ExperimentWorkspace
        project={project}
        store={store}
        backend={backend}
        executions={[]}
        runtimeError=""
        view={view}
        onView={setView}
        activePath="train.py"
        onOpen={vi.fn()}
        onSelect={vi.fn()}
        onContext={vi.fn()}
        sidebarOpen
        width={210}
        onSidebarToggle={vi.fn()}
        resize={null}
      />
    );
  }
  render(<Harness />);
  await user.type(await screen.findByRole('textbox', { name: '代码编辑' }), '\n# draft');
  await user.click(screen.getByRole('button', { name: '实验记录' }));
  await user.click(screen.getByRole('button', { name: '代码' }));
  expect(
    (screen.getByRole('textbox', { name: '代码编辑' }) as HTMLTextAreaElement).value,
  ).toContain('# draft');
  vi.mocked(backend.writeFile).mockRejectedValueOnce(new Error('冲突'));
  await user.click(screen.getByRole('button', { name: '运行' }));
  await waitFor(() =>
    expect(screen.getAllByRole('alert').some((e) => e.textContent?.includes('文件保存失败'))).toBe(
      true,
    ),
  );
  expect(start).not.toHaveBeenCalled();
  expect(getFileSession(backend, 'p1', 'train.py').getSnapshot().dirty).toBe(true);
});
it('late failure stopping an old run cannot replace the newly selected run output', async () => {
  vi.spyOn(experimentApi, 'log').mockResolvedValue('current output');
  let reject!: (error: Error) => void;
  vi.spyOn(experimentApi, 'stop').mockImplementation(
    () =>
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
  );
  const view = render(<ExecutionPanel run={{ ...run, status: 'running' }} />);
  await userEvent.setup().click(screen.getByRole('button', { name: '停止' }));
  view.rerender(<ExecutionPanel run={{ ...run, id: 'r2', status: 'running' }} />);
  await act(async () => reject(new Error('old stop failed')));
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByRole('button', { name: '停止' }) as HTMLButtonElement).disabled).toBe(false);
});
it('merges annotations without allowing manual overwrite of actual execution status', async () => {
  const { store } = await setup();
  await store.getState().update((d) => {
    d.runs = [
      {
        id: 'r1',
        project: 'p1',
        name: 'old',
        status: 'failed',
        metrics: [{ name: 'accuracy', value: 0.8 }],
      },
    ];
  });
  vi.spyOn(experimentApi, 'log').mockResolvedValue('done');
  const user = userEvent.setup();
  render(
    <ExperimentRuns
      project={project}
      store={store}
      executions={[run]}
      onSelect={vi.fn()}
      onContext={vi.fn()}
      onRerun={vi.fn()}
    />,
  );
  expect(screen.getByRole('table', { name: '实验记录列表' }).textContent).toContain('已完成');
  expect(screen.getByRole('table', { name: '实验记录列表' }).textContent).toContain('本地运行');
  await user.click(screen.getByRole('button', { name: '编辑记录' }));
  expect((screen.getByLabelText('执行状态（只读）') as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByLabelText('配置与参数') as HTMLTextAreaElement).disabled).toBe(true);
});
it('tracks real starts independently without overwriting existing tasks', async () => {
  const { store } = await setup();
  store.getState().setAgentTask('agent-task', 'p1');
  vi.spyOn(experimentApi, 'start').mockImplementation(async () => ({
    ...run,
    id: crypto.randomUUID(),
    status: 'running',
  }));
  const [a, b] = await Promise.all([
    startExecution(store, 'p1', config),
    startExecution(store, 'p1', config),
  ]);
  expect(a.id).not.toBe(b.id);
  expect(executionStore.getState().runs).toHaveLength(2);
  expect(Object.keys(store.getState().agentTasks)).toHaveLength(3);
});
it('compares manual records and keeps missing metric values explicitly empty', async () => {
  const { store } = await setup();
  await store.getState().update((d) => {
    d.runs = [
      {
        id: 'a',
        project: 'p1',
        name: 'A',
        status: 'completed',
        metrics: [
          { name: 'accuracy', value: 0 },
          { name: '状态', value: 7 },
        ],
      },
      {
        id: 'b',
        project: 'p1',
        name: 'B',
        status: 'completed',
        metrics: [{ name: 'accuracy', value: null }],
      },
    ];
  });
  const user = userEvent.setup();
  render(
    <ExperimentRuns
      project={project}
      store={store}
      executions={[]}
      onSelect={vi.fn()}
      onContext={vi.fn()}
      onRerun={vi.fn()}
    />,
  );
  await user.click(screen.getByRole('checkbox', { name: '比较 A' }));
  await user.click(screen.getByRole('checkbox', { name: '比较 B' }));
  await user.click(screen.getByRole('button', { name: /比较 \(2/ }));
  const table = screen.getByRole('table', { name: '运行比较' });
  expect(table.textContent).toContain('手动记录');
  expect(table.textContent).toContain('accuracy0—');
  expect(table.textContent).toContain('状态7—');
});
