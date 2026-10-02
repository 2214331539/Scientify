import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { AssistantRuns } from './AssistantRuns';
import { ExecutionPanel } from '../../workspaces/experiments/ExecutionPanel';
import {
  executionStore,
  experimentApi,
  experimentOutput,
  type Execution,
} from '../../workspaces/experiments/runtime';

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
  experimentOutput.setState({ revisions: {} });
});
const run: Execution = {
  id: 'run1',
  project: 'p1',
  name: 'Evaluation',
  status: 'running',
  startedAt: 1,
  endedAt: null,
  exitCode: null,
  configuration: {
    id: 'cfg',
    name: 'Evaluation',
    executable: 'python',
    args: ['eval.py'],
    cwd: '.',
  },
  directory: 'C:/fixture',
  executable: 'python',
  platform: 'windows',
  gitCommit: null,
  gitChanges: [],
  error: null,
  permission: 'workspace-write',
  source: {
    conversationId: 'chat1',
    threadId: 'thread1',
    turnId: 'turn1',
    callId: 'call1',
    workspaceRoot: 'C:/fixture',
  },
};

it('links only this conversation runs, opens the exact run and stops it independently', async () => {
  executionStore.setState({
    runs: [
      run,
      { ...run, id: 'other-project', project: 'p2', name: 'Other project' },
      {
        ...run,
        id: 'other-chat',
        source: { ...run.source!, conversationId: 'chat2' },
        name: 'Other chat',
      },
    ],
  });
  const stop = vi.spyOn(experimentApi, 'stop').mockResolvedValue();
  const open = vi.fn();
  window.addEventListener('scientify-open-run', open);
  try {
    render(<AssistantRuns projectId="p1" conversationId="chat1" />);
    expect(screen.getByText('Evaluation')).toBeTruthy();
    expect(screen.queryByText('Other project')).toBeNull();
    expect(screen.queryByText('Other chat')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '打开实验运行' }));
    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({
      projectId: 'p1',
      runId: 'run1',
    });
    await user.click(screen.getByRole('button', { name: '停止实验' }));
    expect(stop).toHaveBeenCalledWith('run1');
    expect(executionStore.getState().runs).toHaveLength(3);
    act(() => executionStore.setState({ runs: [{ ...run, status: 'completed', exitCode: 0 }] }));
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '停止实验' })).toBeNull();
  } finally {
    window.removeEventListener('scientify-open-run', open);
  }
});

it('returns real logs and result files through the chat run detail view', async () => {
  executionStore.setState({ runs: [{ ...run, status: 'completed', exitCode: 0 }] });
  vi.spyOn(experimentApi, 'log').mockResolvedValue('finished: accuracy=0.9');
  vi.spyOn(experimentApi, 'artifacts').mockResolvedValue([
    { path: 'metrics.json', name: 'metrics.json', kind: 'file', size: 16 },
  ]);
  vi.spyOn(experimentApi, 'artifact').mockResolvedValue({
    path: 'metrics.json',
    content: '{"accuracy":0.9}',
    version: 'read-only',
  });
  const user = userEvent.setup();
  render(<AssistantRuns projectId="p1" conversationId="chat1" />);
  await user.click(screen.getByRole('button', { name: '查看日志与结果' }));
  await waitFor(() =>
    expect(screen.getByLabelText('只读运行日志').textContent).toContain('accuracy=0.9'),
  );
  await user.selectOptions(screen.getByRole('combobox', { name: '运行详情视图' }), 'artifacts');
  await user.click(await screen.findByRole('button', { name: 'metrics.json' }));
  expect(await screen.findByText('{"accuracy":0.9}')).toBeTruthy();
});

it('keeps newest event-driven output when an older log request resolves late', async () => {
  let old!: (value: string) => void;
  vi.spyOn(experimentApi, 'log')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    )
    .mockResolvedValue('newest output');
  render(<ExecutionPanel run={run} />);
  await waitFor(() => expect(old).toBeTypeOf('function'));
  act(() => experimentOutput.setState({ revisions: { run1: 1 } }));
  await waitFor(() =>
    expect(screen.getByLabelText('只读运行日志').textContent).toBe('newest output'),
  );
  await act(async () => old('old output'));
  expect(screen.getByLabelText('只读运行日志').textContent).toBe('newest output');
});
