import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Project } from '../../domain/workspace';
import { gitApi, type GitSnapshot } from '../../platform/git';
import { codeContext, selectCodeRoot, useCodeWorkspace } from './code-context';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  codeContext.setState({ roots: {} });
});
const project: Project = {
  id: 'p1',
  name: 'Fixture',
  space: 'personal',
  question: '',
  createdAt: '',
};
const root = 'F:/fixture/main';
const snapshot = (path: string): GitSnapshot => ({
  root: path,
  repository: false,
  branch: null,
  head: null,
  changes: [],
  branches: [],
  history: [],
  stashes: [],
  worktrees: [],
  busy: false,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it('withholds editable directory state until the native root has resolved', async () => {
  const pending = deferred<GitSnapshot>();
  vi.spyOn(gitApi, 'available').mockReturnValue(true);
  vi.spyOn(gitApi, 'inspect').mockImplementation(async (_id, selected) =>
    selected ? snapshot(selected) : pending.promise,
  );
  const { result } = renderHook(() => useCodeWorkspace(project));
  expect(result.current.ready).toBe(false);
  expect(result.current.root).toBeUndefined();
  await act(async () => pending.resolve(snapshot(root)));
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.root).toBe(root);
});
it('never renders an old worktree snapshot under a newly selected directory', async () => {
  const other = 'F:/fixture/new-loss';
  const pending = deferred<GitSnapshot>();
  selectCodeRoot(project.id, root);
  vi.spyOn(gitApi, 'available').mockReturnValue(true);
  vi.spyOn(gitApi, 'inspect').mockImplementation(async (_id, selected) =>
    selected === other ? pending.promise : snapshot(root),
  );
  const { result, rerender } = renderHook((p) => useCodeWorkspace(p), { initialProps: project });
  await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => selectCodeRoot(project.id, other));
  expect(result.current.root).toBe(other);
  expect(result.current.snapshot).toBeNull();
  expect(result.current.ready).toBe(false);
  await act(async () => pending.resolve(snapshot(other)));
  await waitFor(() => expect(result.current.snapshot?.root).toBe(other));
  rerender({ ...project, path: 'F:/different-repository' });
  expect(result.current.ready).toBe(false);
});
it('canonicalizes a selected subdirectory to the actual repository root', async () => {
  selectCodeRoot(project.id, root + '/src');
  vi.spyOn(gitApi, 'available').mockReturnValue(true);
  vi.spyOn(gitApi, 'inspect').mockResolvedValue(snapshot(root));
  const { result } = renderHook(() => useCodeWorkspace(project));
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.root).toBe(root);
  expect(result.current.snapshot?.root).toBe(root);
});
it('keeps a validated code directory usable when Git metadata is unavailable', async () => {
  vi.spyOn(gitApi, 'available').mockReturnValue(true);
  vi.spyOn(gitApi, 'inspect').mockResolvedValue({
    ...snapshot(root),
    repository: true,
    error: 'Git unavailable',
  });
  const { result } = renderHook(() => useCodeWorkspace(project));
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.root).toBe(root);
  expect(result.current.error).toBe('Git unavailable');
});
