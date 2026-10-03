import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GitWorkspace, changeSides } from './GitWorkspace';
import { gitApi, type GitSnapshot } from '../../platform/git';
import { createWorkspaceStore } from '../../stores/workspace';
import { emptyWorkspace } from '../../domain/workspace';
import type { ResearchBackend } from '../../platform/research';
import { getFileSession } from '../../editor/sessions';
import { selectCodeRoot, codeContext } from './code-context';

vi.mock('../../components/prompts', () => ({ confirmAction: vi.fn(async () => true) }));
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
  codeContext.setState({ roots: {} });
});
const root = 'F:/fixture/main';
const other = 'F:/fixture/new-loss';
const initial: GitSnapshot = {
  root,
  repository: true,
  branch: 'main',
  head: '123456',
  busy: false,
  changes: [
    { path: 'train.py', status: 'MM' },
    { path: 'new.py', status: '??' },
  ],
  branches: [
    { name: 'main', current: true },
    { name: 'feature/new-loss', current: false },
  ],
  history: [
    { sha: '123456', subject: 'baseline', author: 'Fixture', time: '2026-10-02T00:00:00Z' },
  ],
  stashes: [],
  worktrees: [root, other].map((value, i) => ({
    root: value,
    branch: i ? 'feature/new-loss' : 'main',
    head: '123456',
    busy: false,
    locked: false,
    missing: false,
    changes: 0,
  })),
};
async function setup(snapshot = initial) {
  const data = emptyWorkspace();
  data.projects.push({ id: 'p1', name: 'Fixture', question: '', createdAt: '', space: 'personal' });
  const store = createWorkspaceStore({
    load: async () => ({ workspace: data, directory: '', legacyAvailable: false }),
    save: async (workspace) => workspace,
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  });
  await store.getState().load();
  const backend = {
    readFile: vi.fn(async (_project, path) => ({ path, content: 'print(1)', version: 'v1' })),
    writeFile: vi.fn(async (_project, path, content) => ({ path, content, version: 'v2' })),
  } as unknown as ResearchBackend;
  vi.spyOn(gitApi, 'available').mockReturnValue(true);
  const action = vi.spyOn(gitApi, 'action').mockResolvedValue('done');
  const diff = vi.spyOn(gitApi, 'diff').mockResolvedValue('@@ -1 +1 @@\n-old\n+new\n');
  const refresh = vi.fn();
  const code = { root: snapshot.root, snapshot, ready: true, loading: false, error: '', refresh };
  const onOpen = vi.fn();
  return { store, backend, action, diff, refresh, onOpen, code };
}
it('classifies both sides and keeps conflicts out of the staged commit list', () => {
  expect(changeSides({ path: 'a', status: 'MM' })).toEqual({
    staged: true,
    unstaged: true,
    conflict: false,
  });
  expect(changeSides({ path: 'a', status: 'UU' })).toEqual({
    staged: false,
    unstaged: true,
    conflict: true,
  });
  expect(changeSides({ path: 'a', status: '??' }).staged).toBe(false);
});
it('loads the selected index/worktree diff and stages only the selected file', async () => {
  const props = await setup();
  render(<GitWorkspace projectId="p1" {...props} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '查看已暂存 train.py' }));
  await waitFor(() =>
    expect(props.diff).toHaveBeenCalledWith('p1', root, 'train.py', true, undefined),
  );
  await user.click(screen.getByRole('button', { name: '暂存 new.py' }));
  await waitFor(() =>
    expect(props.action).toHaveBeenCalledWith('p1', root, { kind: 'stage', path: 'new.py' }),
  );
});
it('retains the commit message on failure and clears it only after a successful commit', async () => {
  const props = await setup();
  props.action.mockRejectedValueOnce(new Error('identity missing'));
  const page = render(<GitWorkspace projectId="p1" {...props} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '查看已暂存 train.py' }));
  await user.type(screen.getByLabelText('提交说明'), 'new loss');
  await user.click(screen.getByRole('button', { name: 'Commit' }));
  await screen.findByText('identity missing');
  page.rerender(
    <GitWorkspace projectId="p1" {...props} code={{ ...props.code, snapshot: { ...initial } }} />,
  );
  await waitFor(() => expect(props.diff).toHaveBeenCalledTimes(2));
  expect(screen.getByText('identity missing')).toBeTruthy();
  expect((screen.getByLabelText('提交说明') as HTMLTextAreaElement).value).toBe('new loss');
  expect(props.store.getState().dirty).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Commit' }));
  await waitFor(() =>
    expect((screen.getByLabelText('提交说明') as HTMLTextAreaElement).value).toBe(''),
  );
});
it('protects drafts in the affected directory while preserving another worktree draft', async () => {
  const props = await setup();
  const a = getFileSession(props.backend, 'p1', 'train.py', root);
  const b = getFileSession(props.backend, 'p1', 'train.py', other);
  await Promise.all([a.load(), b.load()]);
  a.edit('draft A');
  b.edit('draft B');
  render(<GitWorkspace projectId="p1" {...props} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '暂存 new.py' }));
  await screen.findByText(/未保存或正在读写/);
  expect(props.action).not.toHaveBeenCalled();
  await a.save();
  await user.click(screen.getByRole('button', { name: '暂存 new.py' }));
  await waitFor(() => expect(props.action).toHaveBeenCalledTimes(1));
  expect(b.getSnapshot().content).toBe('draft B');
  expect(b.getSnapshot().dirty).toBe(true);
});
it('switches worktree navigation while retaining independent file sessions', async () => {
  const props = await setup();
  const a = getFileSession(props.backend, 'p1', 'train.py', root);
  await a.load();
  a.edit('keep my draft');
  selectCodeRoot('p1', root);
  render(<GitWorkspace projectId="p1" {...props} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Worktree' }));
  await user.click(screen.getByRole('button', { name: '打开' }));
  expect(codeContext.getState().roots.p1).toBe(other);
  expect(getFileSession(props.backend, 'p1', 'train.py', root)).toBe(a);
  expect(a.getSnapshot().dirty).toBe(true);
});
it('retains independent commit drafts and close protection after leaving and remounting the page', async () => {
  const props = await setup();
  const user = userEvent.setup();
  const page = render(<GitWorkspace projectId="p1" {...props} />);
  await user.type(screen.getByLabelText('提交说明'), 'main draft');
  page.rerender(
    <GitWorkspace
      projectId="p1"
      {...props}
      code={{ ...props.code, root: other, snapshot: { ...initial, root: other } }}
    />,
  );
  expect((screen.getByLabelText('提交说明') as HTMLTextAreaElement).value).toBe('');
  await user.type(screen.getByLabelText('提交说明'), 'worktree draft');
  page.unmount();
  expect(props.store.getState().dirtySources['git-messages']).toBe(true);
  render(<GitWorkspace projectId="p1" {...props} />);
  expect((screen.getByLabelText('提交说明') as HTMLTextAreaElement).value).toBe('main draft');
});
it('protects existing unscoped manuscript drafts from manual Git overwrites', async () => {
  const props = await setup();
  const legacy = getFileSession(props.backend, 'p1', 'train.py');
  await legacy.load();
  legacy.edit('keep manuscript draft');
  render(<GitWorkspace projectId="p1" {...props} />);
  await userEvent.setup().click(screen.getByRole('button', { name: '暂存 new.py' }));
  await screen.findByText(/未保存或正在读写/);
  expect(props.action).not.toHaveBeenCalled();
  expect(legacy.getSnapshot().content).toBe('keep manuscript draft');
});
it('suggests an app-managed worktree directory and submits the standard branch and target', async () => {
  const props = await setup();
  props.store.setState({ directory: 'F:/ScientifyData/workspace' });
  render(<GitWorkspace projectId="p1" {...props} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Worktree' }));
  await user.click(screen.getByRole('button', { name: '创建 Worktree' }));
  expect(props.store.getState().dirty).toBe(false);
  await user.type(screen.getByLabelText('分支名称'), 'feature/new-loss');
  const target = 'F:/ScientifyData/workspace/projects/p1-worktrees/feature-new-loss';
  expect((screen.getByLabelText('Worktree 目录（新的绝对路径）') as HTMLInputElement).value).toBe(
    target,
  );
  await user.click(screen.getByRole('button', { name: '创建' }));
  await waitFor(() =>
    expect(props.action).toHaveBeenCalledWith('p1', root, {
      kind: 'worktree-add',
      name: 'feature/new-loss',
      revision: 'main',
      target,
    }),
  );
});
