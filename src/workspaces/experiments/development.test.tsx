import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createWorkspaceStore } from '../../stores/workspace';
import { desktop } from '../../platform/desktop';
import {
  developmentApi,
  developmentStore,
  useDevelopmentRuntime,
  type TerminalInfo,
  type EnvironmentTask,
} from './development';

const events = vi.hoisted(() => new Map<string, () => void>());
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, callback: () => void) => {
    events.set(name, callback);
    return () => events.delete(name);
  }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  events.clear();
  developmentStore.setState({ terminals: [], tasks: [], error: '' });
});

it('tracks all projects independently of the visible workspace and clears ended or removed tasks', async () => {
  const store = createWorkspaceStore(desktop);
  store.getState().setAgentTask('p1:chat', 'p1');
  store.getState().setAgentTask('terminal:old', 'p3');
  vi.spyOn(developmentApi, 'available').mockReturnValue(true);
  const snapshot = vi.spyOn(developmentApi, 'snapshot').mockResolvedValue({
    terminals: [{ id: 't1', project: 'p1', status: 'running' } as TerminalInfo],
    tasks: [{ id: 'env2', project: 'p2', status: 'running' } as EnvironmentTask],
  });
  const view = renderHook(() => useDevelopmentRuntime(store, true));
  await waitFor(() =>
    expect(store.getState().agentTasks).toEqual({
      'p1:chat': 'p1',
      'terminal:t1': 'p1',
      'python:env2': 'p2',
    }),
  );
  snapshot.mockResolvedValue({
    terminals: [],
    tasks: [{ id: 'env2', project: 'p2', status: 'completed' } as EnvironmentTask],
  });
  act(() => events.get('python-event')?.());
  await waitFor(() => expect(store.getState().agentTasks).toEqual({ 'p1:chat': 'p1' }));
  expect(developmentStore.getState().tasks[0].status).toBe('completed');
  view.unmount();
  expect(events.size).toBe(0);
});

it('does not clear active protection on a snapshot error or publish a result after unmount', async () => {
  const store = createWorkspaceStore(desktop);
  store.getState().setAgentTask('terminal:t1', 'p1');
  vi.spyOn(developmentApi, 'available').mockReturnValue(true);
  const snapshot = vi.spyOn(developmentApi, 'snapshot').mockRejectedValue(new Error('offline'));
  const view = renderHook(() => useDevelopmentRuntime(store, true));
  await waitFor(() => expect(developmentStore.getState().error).toContain('offline'));
  expect(store.getState().agentTasks['terminal:t1']).toBe('p1');
  let resolve!: (value: Awaited<ReturnType<typeof developmentApi.snapshot>>) => void;
  snapshot.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  act(() => events.get('terminal-event')?.());
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  view.unmount();
  await act(async () => resolve({ terminals: [], tasks: [] }));
  expect(store.getState().agentTasks['terminal:t1']).toBe('p1');
});

it('does not republish unchanged snapshots while still observing task completion', async () => {
  const store = createWorkspaceStore(desktop);
  vi.spyOn(developmentApi, 'available').mockReturnValue(true);
  const terminal = { id: 't1', project: 'p1', status: 'running' } as TerminalInfo;
  const snapshot = vi
    .spyOn(developmentApi, 'snapshot')
    .mockImplementation(async () => ({ terminals: [{ ...terminal }], tasks: [] }));
  renderHook(() => useDevelopmentRuntime(store, true));
  await waitFor(() => expect(store.getState().agentTasks['terminal:t1']).toBe('p1'));
  const changed = vi.fn();
  const unsubscribe = developmentStore.subscribe(changed);
  const previous = developmentStore.getState();
  act(() => events.get('terminal-event')?.());
  await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
  expect(developmentStore.getState()).toBe(previous);
  expect(changed).not.toHaveBeenCalled();
  terminal.status = 'completed';
  act(() => events.get('terminal-event')?.());
  await waitFor(() => expect(store.getState().agentTasks).toEqual({}));
  expect(developmentStore.getState().terminals[0].status).toBe('completed');
  expect(changed).toHaveBeenCalledOnce();
  unsubscribe();
});
