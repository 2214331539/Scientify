import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import {
  ArrowUpRight,
  Archive,
  Check,
  GitBranch,
  GitCommitHorizontal,
  FolderGit2,
  History,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { Button, Dropdown, Input, Textarea } from '../../components/primitives';
import { Modal } from '../../components/Modal';
import { confirmAction } from '../../components/prompts';
import { directorySessions, reloadDirectorySessions } from '../../editor/sessions';
import { gitApi, type GitAction, type GitCommit } from '../../platform/git';
import type { ResearchBackend, GitChange } from '../../platform/research';
import type { WorkspaceStore } from '../../stores/workspace';
import { t, translateError } from '../../i18n';
import { describeError } from './runtime';
import { clearCodeRoot, selectCodeRoot, type useCodeWorkspace } from './code-context';
import { splitPatch } from './ChangesWorkspace';
import { beginGitOperation, gitDraftKey, gitDrafts, setGitMessage } from './git-drafts';
import './git.css';

export type GitView = 'changes' | 'history' | 'branches' | 'stashes' | 'worktrees';
const tabs = [
  { id: 'changes', label: '更改', icon: GitCommitHorizontal },
  { id: 'history', label: '提交历史', icon: History },
  { id: 'branches', label: '分支', icon: GitBranch },
  { id: 'stashes', label: 'Stash', icon: Archive },
  { id: 'worktrees', label: 'Worktree', icon: FolderGit2 },
] as const;
export function changeSides(change: GitChange) {
  const conflict = change.status.includes('U') || ['AA', 'DD'].includes(change.status);
  return {
    staged: !conflict && ![' ', '?'].includes(change.status[0]),
    unstaged: conflict || change.status === '??' || change.status[1] !== ' ',
    conflict,
  };
}
export function GitWorkspace({
  projectId,
  backend,
  store,
  code,
  onOpen,
  view: controlledView,
  onView,
  onSelectRoot,
}: {
  projectId: string;
  backend: ResearchBackend;
  store: WorkspaceStore;
  code: ReturnType<typeof useCodeWorkspace>;
  onOpen(path: string): void;
  view?: GitView;
  onView?: (view: GitView) => void;
  onSelectRoot?: (root: string) => void;
}) {
  const { root, snapshot, loading, refresh } = code;
  const [localView, setLocalView] = useState<GitView>('changes');
  const view = controlledView ?? localView;
  function setView(next: GitView) {
    setLocalView(next);
    onView?.(next);
  }
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null);
  const [patch, setPatch] = useState('');
  const [patchLoading, setPatchLoading] = useState(false);
  const [patchError, setPatchError] = useState('');
  const [commit, setCommit] = useState<GitCommit | null>(null);
  const [search, setSearch] = useState('');
  const binding = gitDraftKey(projectId, root ?? '');
  const drafts = gitDrafts(store);
  const message = useStore(drafts, (state) => state.messages[binding] ?? '');
  const pending = useStore(drafts, (state) => !!state.pending[binding]);
  const blocked = pending || !!code.error;
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [dialog, setDialog] = useState<'branch' | 'stash' | 'worktree' | null>(null);
  const [name, setName] = useState('');
  const [revision, setRevision] = useState('HEAD');
  const [target, setTarget] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [newBranch, setNewBranch] = useState(true);
  const [dialogDefaults, setDialogDefaults] = useState({ revision: 'HEAD', target: '' });
  const dialogDirty =
    !!dialog &&
    (!!name ||
      target !== dialogDefaults.target ||
      revision !== dialogDefaults.revision ||
      includeUntracked ||
      !newBranch);
  const current = useRef(binding);
  current.current = binding;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setSelected(null);
    setCommit(null);
    setError('');
    setResult('');
    setDialog(null);
  }, [binding]);
  useEffect(() => {
    const source = `git-form:${binding}`;
    store.getState().setDirtySource(source, dialogDirty);
    return () => store.getState().setDirtySource(source, false);
  }, [dialogDirty, store, binding]);
  useEffect(() => {
    let alive = true;
    setPatch('');
    setPatchError('');
    setPatchLoading(false);
    const selectedPath = view === 'history' && commit ? '' : selected?.path;
    if (!root || selectedPath === undefined || !['changes', 'history'].includes(view)) return;
    setPatchLoading(true);
    void gitApi
      .diff(
        projectId,
        root,
        selectedPath,
        selected?.staged ?? false,
        view === 'history' ? commit?.sha : undefined,
      )
      .then((value) => {
        if (alive) {
          setPatch(value);
        }
      })
      .catch((e) => {
        if (alive) setPatchError(describeError(e));
      })
      .finally(() => {
        if (alive) setPatchLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [root, projectId, selected, view, commit, snapshot]);
  useEffect(() => {
    if (
      selected &&
      snapshot &&
      !snapshot.changes.some(
        (change) =>
          change.path === selected.path &&
          changeSides(change)[selected.staged ? 'staged' : 'unstaged'],
      )
    )
      setSelected(null);
  }, [snapshot, selected]);
  async function execute(request: GitAction) {
    if (!root || blocked) return false;
    const dirtyRoot = request.kind === 'worktree-remove' ? request.target : root;
    const sessions = directorySessions(backend, projectId, dirtyRoot, true);
    if (
      sessions.some(
        (session) =>
          session.getSnapshot().dirty ||
          ['loading', 'saving'].includes(session.getSnapshot().phase),
      )
    ) {
      setError(t('此目录有未保存或正在读写的文件，请先保存后再执行 Git 操作。'));
      return false;
    }
    const finish = beginGitOperation(store, binding);
    if (!finish) return false;
    setError('');
    setResult('');
    const operationBinding = binding;
    try {
      const output = await gitApi.action(projectId, root, request);
      await reloadDirectorySessions(backend, projectId, dirtyRoot);
      if (
        request.kind === 'commit' &&
        drafts.getState().messages[operationBinding] === request.message
      )
        setGitMessage(store, operationBinding, '');
      refresh();
      if (mounted.current && current.current === operationBinding) {
        setResult(
          request.kind === 'commit'
            ? `Commit ${output.trim().slice(0, 12)}`
            : output.trim() || t('操作完成'),
        );
        setDialog(null);
      }
      return true;
    } catch (e) {
      if (mounted.current && current.current === operationBinding) {
        setError(describeError(e));
        refresh();
      }
      return false;
    } finally {
      finish();
    }
  }
  function openDialog(value: 'branch' | 'stash' | 'worktree') {
    const defaults = {
      revision: snapshot?.branch ?? 'HEAD',
      target: value === 'worktree' ? suggestedTarget('') : '',
    };
    setDialogDefaults(defaults);
    setName('');
    setRevision(defaults.revision);
    setTarget(defaults.target);
    setNewBranch(true);
    setIncludeUntracked(false);
    setDialog(value);
  }
  function suggestedTarget(branch: string) {
    const directory = store.getState().directory;
    const normalized = (root ?? '').replaceAll('\\', '/');
    const parent = /^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(directory)
      ? `${directory.replaceAll('\\', '/')}/projects/${projectId}-worktrees`
      : `${normalized.slice(0, normalized.lastIndexOf('/'))}/${normalized.split('/').at(-1)}-worktrees`;
    return `${parent}/${branch.replace(/[\\/:*?"<>|]/g, '-').trim() || 'new-worktree'}`;
  }
  function group(staged: boolean) {
    const changes =
      snapshot?.changes.filter((change) => changeSides(change)[staged ? 'staged' : 'unstaged']) ??
      [];
    return (
      <div className="sf-git-change-group">
        <h3>
          {t(staged ? '已暂存' : '更改')} <span>{changes.length}</span>
        </h3>
        {changes.map((change) => (
          <div
            key={change.path}
            className="sf-git-file"
            data-selected={selected?.path === change.path && selected.staged === staged}
          >
            <Button
              variant="ghost"
              aria-label={t(staged ? '查看已暂存 {path}' : '查看更改 {path}', {
                path: change.path,
              })}
              onClick={() => setSelected({ path: change.path, staged })}
              title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
            >
              <code className={changeSides(change).conflict ? 'is-conflict' : ''}>
                {change.status}
              </code>
              <span>{change.path}</span>
            </Button>
            <Button
              variant="ghost"
              iconOnly
              tooltip={t(staged ? '取消暂存' : '暂存文件')}
              aria-label={t(staged ? '取消暂存 {path}' : '暂存 {path}', { path: change.path })}
              disabled={blocked}
              onClick={() =>
                void execute({ kind: staged ? 'unstage' : 'stage', path: change.path })
              }
            >
              {staged ? <Minus size={13} /> : <Plus size={13} />}
            </Button>
            {!staged && change.status !== '??' && !changeSides(change).conflict && (
              <Button
                variant="ghost"
                iconOnly
                tooltip={t('从暂存区恢复文件')}
                aria-label={t('恢复 {path}', { path: change.path })}
                disabled={blocked}
                onClick={async () => {
                  try {
                    const expectedDiff = await gitApi.diff(projectId, root!, change.path, false);
                    if (
                      await confirmAction(
                        t('从暂存区恢复“{path}”？此文件尚未暂存的磁盘修改会被覆盖。', {
                          path: change.path,
                        }),
                      )
                    )
                      void execute({ kind: 'restore', path: change.path, expectedDiff });
                  } catch (e) {
                    setError(describeError(e));
                  }
                }}
              >
                <RotateCcw size={13} />
              </Button>
            )}
          </div>
        ))}
        {!changes.length && (
          <p className="sf-git-empty">
            {t(staged ? '暂无已暂存文件' : '工作区干净，没有未提交变更。')}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="sf-git-workspace">
      <header className="sf-git-toolbar">
        <GitBranch size={15} />
        <strong>{snapshot?.branch ?? (snapshot?.head ? snapshot.head.slice(0, 8) : 'Git')}</strong>
        <nav aria-label={t('Git 视图')}>
          {tabs.map(({ id, label, icon: Icon }) => (
            <Button key={id} variant="ghost" aria-pressed={view === id} onClick={() => setView(id)}>
              <Icon size={13} />
              {t(label)}
            </Button>
          ))}
        </nav>
        <Button
          variant="ghost"
          iconOnly
          tooltip={t('刷新 Git')}
          aria-label={t('刷新 Git')}
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw size={14} className={loading ? 'sf-ai-spinner' : ''} />
        </Button>
      </header>
      {(error || patchError || code.error) && (
        <div className="sf-git-feedback" role="alert">
          <span>{translateError(error || patchError || code.error)}</span>
          {code.error && root && (
            <Button onClick={() => clearCodeRoot(projectId)}>{t('打开项目原目录')}</Button>
          )}
        </div>
      )}
      {result && (
        <div className="sf-git-feedback" role="status">
          <Check size={13} />
          <span>{result}</span>
        </div>
      )}
      {!gitApi.available() ? (
        <p className="sf-git-empty">{t('Git 管理仅在桌面应用可用')}</p>
      ) : loading && !snapshot ? (
        <p className="sf-git-empty">
          <LoaderCircle size={14} className="sf-ai-spinner" />
          {t('正在读取…')}
        </p>
      ) : snapshot && !snapshot.repository ? (
        <div className="sf-git-no-repo">
          <FolderGit2 size={26} />
          <p>{t('此代码目录尚未初始化 Git。')}</p>
          <Button disabled={blocked} onClick={() => void execute({ kind: 'init' })}>
            <Plus size={14} />
            {t('初始化 Git 仓库')}
          </Button>
        </div>
      ) : snapshot ? (
        <>
          {view === 'changes' && (
            <div className="sf-git-changes-body">
              <aside className="sf-git-files">
                <form
                  className="sf-git-commit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void execute({ kind: 'commit', message });
                  }}
                >
                  <Textarea
                    aria-label={t('提交说明')}
                    rows={3}
                    placeholder={t('提交说明')}
                    value={message}
                    onChange={(e) => setGitMessage(store, binding, e.target.value)}
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={
                      blocked ||
                      !message.trim() ||
                      !snapshot.changes.some((c) => changeSides(c).staged)
                    }
                  >
                    <GitCommitHorizontal size={14} />
                    {t('Commit')}
                  </Button>
                </form>
                <div className="sf-git-file-scroll">
                  {group(true)}
                  {group(false)}
                </div>
              </aside>
              <section className="sf-git-diff">
                <header>
                  <span>{selected?.path ?? t('文件差异')}</span>
                  {selected && (
                    <Button
                      variant="ghost"
                      iconOnly
                      tooltip={t('打开文件')}
                      aria-label={t('打开文件')}
                      onClick={() => onOpen(selected.path)}
                    >
                      <ArrowUpRight size={14} />
                    </Button>
                  )}
                </header>
                {patchLoading ? (
                  <p className="sf-git-empty">{t('正在读取…')}</p>
                ) : selected ? (
                  <Patch patch={patch} staged={selected.staged} />
                ) : (
                  <p className="sf-git-empty">{t('选择文件查看差异')}</p>
                )}
              </section>
            </div>
          )}
          {view === 'history' && (
            <div className="sf-git-history">
              <aside>
                <Input
                  aria-label={t('搜索提交')}
                  placeholder={t('搜索提交')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="sf-git-history-list">
                  {snapshot.history
                    .filter((item) =>
                      `${item.subject} ${item.author} ${item.sha}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .map((item) => (
                      <Button
                        key={item.sha}
                        variant="ghost"
                        aria-pressed={commit?.sha === item.sha}
                        onClick={() => setCommit(item)}
                      >
                        <strong>{item.subject}</strong>
                        <small>
                          {item.sha.slice(0, 8)} · {item.author} ·{' '}
                          {new Date(item.time).toLocaleDateString()}
                        </small>
                      </Button>
                    ))}
                  {!snapshot.history.length && <p className="sf-git-empty">{t('尚无提交')}</p>}
                </div>
              </aside>
              <section className="sf-git-diff">
                {commit && (
                  <header>
                    <span>{commit.subject}</span>
                    <code>{commit.sha.slice(0, 12)}</code>
                  </header>
                )}
                {patchLoading ? (
                  <p className="sf-git-empty">{t('正在读取…')}</p>
                ) : commit ? (
                  <pre className="sf-git-history-patch">{patch || t('暂无文本差异')}</pre>
                ) : (
                  <p className="sf-git-empty">{t('选择提交查看差异')}</p>
                )}
              </section>
            </div>
          )}
          {view === 'branches' && (
            <div className="sf-git-management">
              <header>
                <Button disabled={blocked} onClick={() => openDialog('branch')}>
                  <Plus size={14} />
                  {t('创建分支')}
                </Button>
              </header>
              {snapshot.branches.map((branch) => (
                <div className="sf-git-row" key={branch.name}>
                  <GitBranch size={14} />
                  <span>{branch.name}</span>
                  {branch.current ? (
                    <small>{t('当前分支')}</small>
                  ) : (
                    <>
                      <Button
                        disabled={blocked}
                        onClick={() => void execute({ kind: 'branch-switch', name: branch.name })}
                      >
                        {t('切换')}
                      </Button>
                      <Button
                        variant="ghost"
                        iconOnly
                        tooltip={t('删除分支')}
                        aria-label={t('删除分支 {name}', { name: branch.name })}
                        disabled={blocked}
                        onClick={async () => {
                          if (
                            await confirmAction(
                              t('删除分支“{name}”？Git 将保护尚未合并的提交。', {
                                name: branch.name,
                              }),
                            )
                          )
                            void execute({ kind: 'branch-delete', name: branch.name });
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          {view === 'stashes' && (
            <div className="sf-git-management">
              <header>
                <Button disabled={blocked} onClick={() => openDialog('stash')}>
                  <Archive size={14} />
                  {t('保存到 Stash')}
                </Button>
              </header>
              {snapshot.stashes.map((stash) => (
                <div className="sf-git-row" key={stash.sha}>
                  <Archive size={14} />
                  <span>
                    <strong>{stash.id}</strong>
                    <small>{stash.subject}</small>
                  </span>
                  {['stash-apply', 'stash-pop'].map((kind) => (
                    <Button
                      key={kind}
                      disabled={blocked}
                      onClick={async () => {
                        if (
                          await confirmAction(
                            t('将 {name} 应用到当前 worktree？可能产生需要手动解决的冲突。', {
                              name: stash.id,
                            }),
                          )
                        )
                          void execute({
                            kind: kind as GitAction['kind'],
                            name: stash.id,
                            expectedSha: stash.sha,
                          });
                      }}
                    >
                      {kind === 'stash-pop' ? 'Pop' : 'Apply'}
                    </Button>
                  ))}
                </div>
              ))}
              {!snapshot.stashes.length && <p className="sf-git-empty">{t('暂无 Stash')}</p>}
            </div>
          )}
          {view === 'worktrees' && (
            <div className="sf-git-management">
              <header>
                <Button disabled={blocked} onClick={() => openDialog('worktree')}>
                  <Plus size={14} />
                  {t('创建 Worktree')}
                </Button>
              </header>
              {snapshot.worktrees.map((tree, index) => (
                <div className="sf-git-row" key={tree.root}>
                  <FolderGit2 size={16} />
                  <span>
                    <strong>{tree.branch ?? tree.head.slice(0, 8)}</strong>
                    <small>{tree.root}</small>
                  </span>
                  {tree.busy && <small>{t('运行中')}</small>}
                  {tree.changes !== null && (
                    <small>
                      {tree.changes ? t('{count} 项更改', { count: tree.changes }) : t('干净')}
                    </small>
                  )}
                  {tree.root === root ? (
                    <small>{t('当前目录')}</small>
                  ) : (
                    <Button
                      disabled={tree.missing}
                      onClick={() =>
                        onSelectRoot
                          ? onSelectRoot(tree.root)
                          : selectCodeRoot(projectId, tree.root)
                      }
                    >
                      {t('打开')}
                    </Button>
                  )}
                  {index > 0 && tree.root !== root && (
                    <Button
                      variant="ghost"
                      iconOnly
                      tooltip={t('移除 Worktree')}
                      aria-label={t('移除 Worktree {name}', { name: tree.branch ?? tree.root })}
                      disabled={blocked || tree.busy || tree.locked || tree.missing}
                      onClick={async () => {
                        if (
                          await confirmAction(
                            t(
                              '移除 worktree“{path}”？将删除该工作目录，保留分支和提交；未提交更改会阻止移除。',
                              { path: tree.root },
                            ),
                          )
                        )
                          void execute({ kind: 'worktree-remove', target: tree.root });
                      }}
                    >
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}
      {dialog && (
        <Modal
          title={t(
            dialog === 'branch'
              ? '创建分支'
              : dialog === 'stash'
                ? '保存到 Stash'
                : '创建 Worktree',
          )}
          onClose={() => setDialog(null)}
          busy={pending}
          dirty={dialogDirty}
        >
          <form
            className="sf-git-form"
            onSubmit={(e) => {
              e.preventDefault();
              void execute(
                dialog === 'branch'
                  ? { kind: 'branch-create', name, revision }
                  : dialog === 'stash'
                    ? { kind: 'stash-save', message: name, includeUntracked }
                    : { kind: 'worktree-add', target, revision, ...(newBranch ? { name } : {}) },
              );
            }}
          >
            <fieldset disabled={blocked}>
              {dialog === 'worktree' && (
                <label className="sf-git-checkbox">
                  <input
                    type="checkbox"
                    checked={newBranch}
                    onChange={(e) => setNewBranch(e.target.checked)}
                  />
                  {t('创建新分支')}
                </label>
              )}
              {(dialog !== 'worktree' || newBranch) && (
                <label>
                  {t(dialog === 'stash' ? '说明' : '分支名称')}
                  <Input
                    autoFocus
                    required={dialog !== 'stash'}
                    value={name}
                    onChange={(e) => {
                      if (dialog === 'worktree' && target === suggestedTarget(name))
                        setTarget(suggestedTarget(e.target.value));
                      setName(e.target.value);
                    }}
                    placeholder={dialog === 'stash' ? undefined : 'feature/new-loss'}
                  />
                </label>
              )}
              {dialog !== 'stash' && (
                <label>
                  {t(dialog === 'worktree' && !newBranch ? '已有分支' : '起始 Branch / Commit')}
                  {dialog === 'worktree' && !newBranch ? (
                    <Dropdown value={revision} onChange={(e) => setRevision(e.target.value)}>
                      {snapshot?.branches.map((b) => (
                        <option key={b.name}>{b.name}</option>
                      ))}
                    </Dropdown>
                  ) : (
                    <Input
                      required
                      value={revision}
                      onChange={(e) => setRevision(e.target.value)}
                    />
                  )}
                </label>
              )}
              {dialog === 'worktree' && (
                <label>
                  {t('Worktree 目录（新的绝对路径）')}
                  <Input
                    required
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    placeholder="F:\\Research\\new-loss"
                  />
                </label>
              )}
              {dialog === 'stash' && (
                <label className="sf-git-checkbox">
                  <input
                    type="checkbox"
                    checked={includeUntracked}
                    onChange={(e) => setIncludeUntracked(e.target.checked)}
                  />
                  {t('包含未跟踪文件')}
                </label>
              )}
            </fieldset>
            {error && <p role="alert">{translateError(error)}</p>}
            <footer>
              <Button type="button" disabled={pending} onClick={() => setDialog(null)}>
                {t('取消')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={
                  blocked ||
                  (dialog === 'worktree' && !target.trim()) ||
                  (dialog === 'worktree' && newBranch && !name.trim()) ||
                  (dialog === 'branch' && !name.trim())
                }
              >
                <Plus size={14} />
                {t(dialog === 'stash' ? '保存' : '创建')}
              </Button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
function Patch({ patch, staged }: { patch: string; staged: boolean }) {
  const rows = splitPatch(patch);
  return (
    <div className="sf-diff-scroll">
      <div className="sf-diff-labels">
        <span>{staged ? 'HEAD' : t('暂存区')}</span>
        <span>{staged ? t('暂存区') : t('工作区')}</span>
      </div>
      {rows.length ? (
        <table aria-label={t('文件版本差异')}>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={`sf-diff-${row.kind}`}>
                <td className="sf-diff-number">{row.oldNumber}</td>
                <td
                  className={row.kind === 'change' && row.oldText !== undefined ? 'is-removed' : ''}
                >
                  <pre>{row.oldText}</pre>
                </td>
                <td className="sf-diff-number">{row.newNumber}</td>
                <td
                  className={row.kind === 'change' && row.newText !== undefined ? 'is-added' : ''}
                >
                  <pre>{row.newText}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <pre>{patch || t('暂无文本差异')}</pre>
      )}
    </div>
  );
}
