import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { PythonSidebar } from './PythonSidebar';
import {
  developmentApi,
  developmentStore,
  type EnvironmentTask,
  type Interpreter,
} from './development';
import { emptyWorkspace, normalizeExperiments } from '../../domain/workspace';
import { createWorkspaceStore } from '../../stores/workspace';
import { confirmAction } from '../../components/prompts';
vi.mock('../../components/prompts', () => ({ confirmAction: vi.fn(async () => true) }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  developmentStore.setState({ terminals: [], tasks: [] });
});
const base: Interpreter = {
  executable: 'F:/Python/python.exe',
  prefix: 'F:/Python',
  version: '3.12.9',
  manager: 'system',
};
async function fixture() {
  const data = emptyWorkspace();
  data.projects.push({
    id: 'p1',
    name: 'Paper',
    question: '',
    space: 'personal',
    createdAt: 'now',
  });
  normalizeExperiments(data);
  data.experiments!.push({
    ...data.experiments![0],
    id: 'e2',
    source: 'existing',
    root: 'F:/other',
    name: 'Other',
  });
  const store = createWorkspaceStore({
    load: async () => ({ workspace: data, directory: 'F:/Data/workspace', legacyAvailable: false }),
    save: async (d) => d,
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  });
  await store.getState().load();
  return store;
}
it('validates the interpreter before persisting it and keeps the sibling experiment independent', async () => {
  const store = await fixture();
  vi.spyOn(developmentApi, 'available').mockReturnValue(true);
  vi.spyOn(developmentApi, 'trust').mockResolvedValue(true);
  const api = vi.spyOn(developmentApi, 'python').mockImplementation(async (_p, _e, request) => {
    if ((request as { action: string }).action === 'inspect') return base;
    return { interpreters: [base], condaAvailable: false };
  });
  render(
    <PythonSidebar
      projectId="p1"
      experiment={store.getState().data!.experiments![0]}
      store={store}
      active
      tasks={[]}
      onTerminal={() => {}}
    />,
  );
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByRole('button', { name: '使用解释器' })).toBeTruthy());
  await user.type(screen.getByLabelText('解释器路径'), base.executable);
  await user.click(screen.getByRole('button', { name: '使用解释器' }));
  await waitFor(() => expect(store.getState().data?.experiments?.[0].python).toEqual(base));
  expect(store.getState().data?.experiments?.[1].python).toBeUndefined();
  api.mockRejectedValue(new Error('Invalid interpreter'));
  await user.clear(screen.getByLabelText('解释器路径'));
  await user.type(screen.getByLabelText('解释器路径'), 'F:/broken.exe');
  await user.click(screen.getByRole('button', { name: '使用解释器' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('Invalid interpreter'),
  );
  expect(store.getState().data?.experiments?.[0].python).toEqual(base);
});
it('refuses execution when trust is cancelled and does not treat a running creation task as a usable environment', async () => {
  const store = await fixture();
  vi.spyOn(developmentApi, 'available').mockReturnValue(true);
  vi.spyOn(developmentApi, 'trust').mockResolvedValue(false);
  vi.mocked(confirmAction).mockResolvedValueOnce(false);
  const task: EnvironmentTask = {
    id: 'prep',
    project: 'p1',
    experimentId: 'p1',
    root: 'F:/project',
    kind: 'venv',
    command: [],
    prefix: 'F:/project/.venv',
    status: 'running',
    exitCode: null,
    error: null,
    environment: null,
    startedAt: 1,
  };
  const api = vi.spyOn(developmentApi, 'python').mockImplementation(async (_p, _e, request) => {
    const action = (request as { action: string }).action;
    if (action === 'discover') return { interpreters: [base], condaAvailable: false };
    if (action === 'start') return task;
    return '';
  });
  const props = {
    projectId: 'p1',
    experiment: store.getState().data!.experiments![0],
    store,
    active: true,
    tasks: [] as EnvironmentTask[],
    onTerminal: () => {},
  };
  const view = render(<PythonSidebar {...props} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '信任目录并检测 Python' }));
  expect(api).not.toHaveBeenCalled();
  vi.spyOn(developmentApi, 'trust').mockResolvedValue(true);
  await user.click(screen.getByRole('button', { name: '信任目录并检测 Python' }));
  await waitFor(() => expect(screen.getByLabelText('基础 Python').textContent).toContain('3.12.9'));
  await user.click(screen.getByRole('button', { name: '创建环境' }));
  await waitFor(() => expect(developmentStore.getState().tasks).toHaveLength(1));
  view.rerender(<PythonSidebar {...props} tasks={[task]} />);
  expect(store.getState().data?.experiments?.[0].python).toBeUndefined();
  expect(screen.queryByRole('button', { name: '使用此环境' })).toBeNull();
  view.rerender(
    <PythonSidebar
      {...props}
      tasks={[
        {
          ...task,
          status: 'completed',
          environment: {
            ...base,
            executable: 'F:/project/.venv/Scripts/python.exe',
            manager: 'venv',
          },
        },
      ]}
    />,
  );
  expect(screen.getByRole('button', { name: '使用此环境' })).toBeTruthy();
});
