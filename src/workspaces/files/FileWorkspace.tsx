import { t, translateError } from '../../i18n';
import { Button, Input } from '../../components/primitives';
import { Panel } from '../../components/layout/Panel';
import { TreeView, type TreeItem } from '../../components/workspace/TreeView';
import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useStore } from 'zustand';
import {
  FileCode2,
  FilePlus2,
  FileText,
  GitBranch,
  RefreshCw,
  Save,
  X,
  Search,
  Replace,
  WrapText,
  ChevronsDownUp,
  Undo2,
  Redo2,
} from 'lucide-react';
import { undoDepth, redoDepth } from '@codemirror/commands';
import type { Project } from '../../domain/workspace';
import type { WorkContext } from '../../domain/context';
import type { ResearchBackend, ResearchFile } from '../../platform/research';
import type { WorkspaceStore } from '../../stores/workspace';
import {
  beginFileOperation,
  getFileRuntime,
  getFileSession,
  hasUnsavedFileChanges,
  notifyFileRuntime,
  type FileSession,
} from '../../editor/sessions';
import './files.css';

const CodeEditor = lazy(() =>
  import('../../editor/CodeEditor').then((module) => ({ default: module.CodeEditor })),
);
const MarkdownPreview = lazy(() => import('./MarkdownPreview'));

type Mode = 'experiments' | 'writing' | 'files';
type FileWorkspaceProps = {
  project: Project;
  store: WorkspaceStore;
  backend: ResearchBackend;
  mode: Mode;
  view: string;
  activePath?: string | null;
  onActivePathChange?: (path: string | null) => void;
  onContext: (context: WorkContext) => void;
  onDirtyChange?: (dirty: boolean) => void;
  workspaceRoot?: string;
  createRequest?: number;
  onCreateHandled?: () => void;
};
const fileName = (path: string) => path.split('/').pop() || path;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const resourceEvent = 'scientify-project-files-changed';

function useRuntime(backend: ResearchBackend) {
  const runtime = getFileRuntime(backend);
  const subscribe = useCallback(
    (listener: () => void) => {
      runtime.listeners.add(listener);
      return () => {
        runtime.listeners.delete(listener);
      };
    },
    [runtime],
  );
  const getSnapshot = useCallback(() => runtime.revision, [runtime]);
  useSyncExternalStore(subscribe, getSnapshot);
  return runtime;
}

export function FileWorkspace(props: FileWorkspaceProps) {
  const { project, backend, mode, view, onContext, onDirtyChange, onActivePathChange } = props;
  const runtime = useRuntime(backend);
  const workspaceRoot = props.workspaceRoot;
  const scope = JSON.stringify([project.id, mode, workspaceRoot ?? '']);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const tabs = runtime.tabs.get(scope) ?? [];
  const activePath =
    props.activePath === undefined ? (runtime.active.get(scope) ?? null) : props.activePath;
  const [createName, setCreateName] = useState('');
  const [createContent, setCreateContent] = useState('');
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createError, setCreateError] = useState('');
  const [closeTarget, setCloseTarget] = useState<string | null>(null);
  const onContextRef = useRef(onContext);
  onContextRef.current = onContext;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const dirty = hasUnsavedFileChanges(backend);

  const open = useCallback(
    (path: string) => {
      const current = runtime.tabs.get(scope) ?? [];
      if (!current.includes(path)) runtime.tabs.set(scope, [...current, path]);
      runtime.active.set(scope, path);
      notifyFileRuntime(backend);
      onActivePathChange?.(path);
    },
    [backend, runtime, scope, onActivePathChange],
  );
  useEffect(() => {
    if (!activePath) return;
    const tabs = runtime.tabs.get(scope) ?? [];
    let changed = false;
    if (!tabs.includes(activePath)) {
      runtime.tabs.set(scope, [...tabs, activePath]);
      changed = true;
    }
    if (runtime.active.get(scope) !== activePath) {
      runtime.active.set(scope, activePath);
      changed = true;
    }
    if (changed) notifyFileRuntime(backend);
  }, [activePath, backend, runtime, scope]);
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);
  useEffect(() => {
    setCloseTarget(null);
    setShowCreate(false);
    setCreateError('');
    setCreating(false);
  }, [project.id, mode, workspaceRoot]);
  useEffect(() => {
    if (!props.createRequest) return;
    setCreateContent('');
    setCreateName('');
    setShowCreate(true);
    props.onCreateHandled?.();
  }, [props.createRequest, props.onCreateHandled]);
  useEffect(() => {
    if (view === 'versions' || ['references', 'citations'].includes(view) || !activePath)
      onContextRef.current({
        projectId: project.id,
        workspace: mode,
        title:
          view === 'versions'
            ? t('Git 版本变更')
            : ['references', 'citations'].includes(view)
              ? t('项目引用')
              : mode === 'writing'
                ? t('Paper')
                : mode === 'files'
                  ? t('Files')
                  : t('Code'),
      });
  }, [activePath, project.id, mode, view]);

  function close(path: string) {
    const next = (runtime.tabs.get(scope) ?? []).filter((item) => item !== path);
    runtime.tabs.set(scope, next);
    if (activePath === path) {
      const nextPath = next.at(-1) ?? null;
      if (nextPath) runtime.active.set(scope, nextPath);
      else runtime.active.delete(scope);
      if (mounted.current && activeScope.current === scope) onActivePathChange?.(nextPath);
    }
    setCloseTarget(null);
    notifyFileRuntime(backend);
  }
  async function create() {
    const path = createName.trim().replace(/\\/g, '/');
    if (!path || path.startsWith('/') || path.split('/').some((part) => part === '..' || !part)) {
      setCreateError(t('请输入项目内相对路径，例如 notes/idea.md。'));
      return;
    }
    setCreating(true);
    setCreateError('');
    const finishOperation = beginFileOperation(backend);
    try {
      await backend.writeFile(
        project.id,
        path,
        createContent,
        null,
        ...(workspaceRoot ? [workspaceRoot] : []),
      );
      if (mounted.current && activeScope.current === scope) {
        open(path);
        setShowCreate(false);
        setCreateName('');
      }
      window.dispatchEvent(new CustomEvent(resourceEvent, { detail: project.id }));
    } catch (error) {
      if (mounted.current && activeScope.current === scope) setCreateError(errorText(error));
    } finally {
      finishOperation();
      if (mounted.current && activeScope.current === scope) setCreating(false);
    }
  }

  if (mode === 'experiments' && view === 'versions')
    return (
      <GitChanges
        project={project}
        backend={backend}
        onOpen={(path) => {
          open(path);
        }}
      />
    );
  if (mode === 'writing' && ['references', 'citations'].includes(view))
    return <ProjectReferences project={project} store={props.store} />;

  const session = activePath
    ? getFileSession(backend, project.id, activePath, workspaceRoot)
    : null;
  return (
    <Panel
      className="sf-file-workspace"
      aria-label={
        mode === 'writing'
          ? t('论文文件工作区')
          : mode === 'files'
            ? t('项目文件工作区')
            : t('实验文件工作区')
      }
    >
      <div className="sf-file-tabs" role="tablist" aria-label={t('打开的文件')}>
        {tabs.map((path) => (
          <div key={path} className={`sf-file-tab ${path === activePath ? 'is-active' : ''}`}>
            <Button
              variant="ghost"
              role="tab"
              aria-selected={path === activePath}
              title={path}
              onClick={() => open(path)}
            >
              <FileText
                size={14}
                className="sf-file-type-icon"
                data-extension={path.split('.').pop()?.toLowerCase()}
              />
              <span>{fileName(path)}</span>
              {getFileSession(backend, project.id, path, workspaceRoot).getSnapshot().dirty ? (
                <span className="sf-file-dirty" aria-label={t('未保存')}>
                  ●
                </span>
              ) : null}
            </Button>
            <Button
              variant="ghost"
              iconOnly
              className="sf-file-close"
              aria-label={t('关闭 {name}', { name: fileName(path) })}
              onClick={() =>
                getFileSession(backend, project.id, path, workspaceRoot).getSnapshot().dirty
                  ? setCloseTarget(path)
                  : close(path)
              }
            >
              <X size={12} />
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          iconOnly
          className="sf-file-add"
          title={t('新建文件')}
          aria-label={t('新建文件')}
          onClick={() => {
            setCreateContent('');
            setShowCreate(true);
          }}
        >
          <FilePlus2 size={15} />
        </Button>
      </div>
      {showCreate ? (
        <form
          className="sf-file-create"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label htmlFor="new-project-file">{createContent ? t('副本路径') : t('文件路径')}</label>
          <Input
            autoFocus
            id="new-project-file"
            placeholder={mode === 'writing' ? t('paper.md 或 main.tex') : 'experiments/train.py'}
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
            disabled={creating}
          />
          <Button variant="primary" type="submit" disabled={creating || !createName.trim()}>
            {creating ? t('创建中…') : t('创建')}
          </Button>
          <Button type="button" onClick={() => setShowCreate(false)} disabled={creating}>
            {t('取消')}
          </Button>
          {createError ? <p role="alert">{translateError(createError)}</p> : null}
        </form>
      ) : null}
      {closeTarget ? (
        <div className="sf-file-confirm" role="alert">
          <span>{t('“{name}” 尚未保存。', { name: fileName(closeTarget) })}</span>
          <Button
            onClick={async () => {
              if (await getFileSession(backend, project.id, closeTarget, workspaceRoot).save())
                close(closeTarget);
            }}
          >
            {t('保存并关闭')}
          </Button>
          <Button
            onClick={() => {
              close(closeTarget);
            }}
          >
            {t('关闭标签，保留草稿')}
          </Button>
          <Button onClick={() => setCloseTarget(null)}>{t('取消')}</Button>
        </div>
      ) : null}
      {session ? (
        <FileDocument
          key={JSON.stringify([project.id, activePath, workspaceRoot ?? ''])}
          session={session}
          project={project}
          mode={mode}
          onContext={onContext}
          onCreate={(content) => {
            setCreateContent(content ?? '');
            setCreateName('');
            setShowCreate(true);
          }}
        />
      ) : (
        <div className="sf-file-empty">
          <FileCode2 size={28} strokeWidth={1.4} />
          <h2>{mode === 'writing' ? t('Paper') : mode === 'files' ? t('Files') : t('Code')}</h2>

          <Button
            onClick={() => {
              setCreateContent('');
              setShowCreate(true);
            }}
          >
            <FilePlus2 size={15} />
            {t('新建文件')}
          </Button>
          <span>{project.path}</span>
        </div>
      )}
    </Panel>
  );
}

function FileDocument({
  session,
  project,
  mode,
  onContext,
  onCreate,
}: {
  session: FileSession;
  project: Project;
  mode: Mode;
  onContext: (value: WorkContext) => void;
  onCreate: (content?: string) => void;
}) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [layout, setLayout] = useState<'source' | 'split' | 'preview'>('split');
  const [wide, setWide] = useState(false);
  const [selection, setSelection] = useState('');
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [confirmReload, setConfirmReload] = useState(false);
  const [diskContent, setDiskContent] = useState<string | null>(null);
  const [compareError, setCompareError] = useState('');
  const canvas = useRef<HTMLDivElement>(null);
  const onContextRef = useRef(onContext);
  onContextRef.current = onContext;
  const isMarkdown = /\.(md|markdown|mdown)$/i.test(session.path);
  const isTex = /\.(tex|sty|cls|bib)$/i.test(session.path);
  const deferredText = useDeferredValue(snapshot.content);
  const actualLayout = layout === 'split' && !wide ? 'source' : layout;
  useEffect(() => {
    void session.load();
  }, [session]);
  useEffect(() => {
    if (session.pendingEditorCommand) setLayout('source');
  }, [session, snapshot]);
  useEffect(() => {
    onContextRef.current({
      projectId: project.id,
      workspace: mode,
      title: fileName(session.path),
      resourceId: session.path,
      path: session.path,
      workspaceRoot: session.workspaceRoot,
      text: snapshot.content.slice(0, 24000),
      selection,
    });
  }, [project.id, mode, session, snapshot.content, selection]);
  useEffect(() => {
    const element = canvas.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => setWide(entries[0].contentRect.width >= 960));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const loaded =
    snapshot.phase !== 'loading' && snapshot.phase !== 'idle' && snapshot.phase !== 'error';
  return (
    <>
      <div className="sf-file-toolbar">
        <span className="sf-file-breadcrumb" title={session.path}>
          {session.path}
        </span>
        <Button
          variant="ghost"
          onClick={() => void session.save()}
          disabled={!snapshot.dirty || !loaded || snapshot.phase === 'saving'}
          title={t('保存 (Ctrl+S)')}
        >
          <Save size={14} />
          {snapshot.phase === 'saving' ? t('保存中…') : t('保存')}
        </Button>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('重新读取文件')}
          title={t('重新读取磁盘文件')}
          disabled={snapshot.phase === 'saving' || snapshot.phase === 'loading'}
          onClick={() =>
            snapshot.dirty ? setConfirmReload(true) : void session.reloadDiscardingEdits()
          }
        >
          <RefreshCw size={14} />
        </Button>
        {mode === 'experiments' && (
          <>
            <Button
              variant="ghost"
              iconOnly
              aria-label={t('撤销')}
              disabled={!session.editorState || !undoDepth(session.editorState)}
              onClick={() => session.requestEditorCommand({ type: 'undo' })}
            >
              <Undo2 size={14} />
            </Button>
            <Button
              variant="ghost"
              iconOnly
              aria-label={t('重做')}
              disabled={!session.editorState || !redoDepth(session.editorState)}
              onClick={() => session.requestEditorCommand({ type: 'redo' })}
            >
              <Redo2 size={14} />
            </Button>
            <Button
              variant="ghost"
              iconOnly
              aria-label={t('查找文件内容')}
              disabled={!loaded}
              onClick={() => session.requestEditorCommand({ type: 'find' })}
            >
              <Search size={14} />
            </Button>
            <Button
              variant="ghost"
              iconOnly
              aria-label={t('替换文件内容')}
              disabled={!loaded}
              onClick={() => session.requestEditorCommand({ type: 'replace' })}
            >
              <Replace size={14} />
            </Button>
            <Button
              variant="ghost"
              iconOnly
              aria-label={t('自动换行')}
              aria-pressed={session.editorWrap}
              disabled={!loaded}
              onClick={() => session.requestEditorCommand({ type: 'toggleWrap' })}
            >
              <WrapText size={14} />
            </Button>
          </>
        )}
        {isMarkdown ? (
          <div className="sf-file-segments" aria-label={t('稿件显示模式')}>
            {(['source', 'split', 'preview'] as const).map((value) => (
              <Button
                variant="ghost"
                key={value}
                aria-pressed={actualLayout === value}
                disabled={value === 'split' && !wide}
                title={
                  value === 'split' && !wide ? t('中央区域宽度达到 960px 后可分栏') : undefined
                }
                onClick={() => setLayout(value)}
              >
                {{ source: t('源码'), split: t('分栏'), preview: t('预览') }[value]}
              </Button>
            ))}
          </div>
        ) : null}
        <span className={`sf-file-save-state ${snapshot.dirty ? 'is-dirty' : ''}`}>
          {snapshot.dirty ? t('未保存') : loaded ? t('已保存') : ''}
        </span>
      </div>
      {confirmReload ? (
        <div className="sf-file-confirm" role="alert">
          <span>{t('重新读取会丢弃当前未保存编辑。')}</span>
          <Button
            onClick={async () => {
              if (await session.reloadDiscardingEdits()) setConfirmReload(false);
            }}
          >
            {t('丢弃编辑并重新读取')}
          </Button>
          <Button onClick={() => setConfirmReload(false)}>{t('保留编辑')}</Button>
        </div>
      ) : null}
      {snapshot.error ? (
        <div className="sf-file-error" role="alert">
          <span>{translateError(snapshot.error)}</span>
          {snapshot.dirty ? (
            <>
              <span>{t('当前编辑已保留。')}</span>
              <Button
                onClick={async () => {
                  setCompareError('');
                  try {
                    setDiskContent(
                      (
                        await session.backend.readFile(
                          project.id,
                          session.path,
                          session.workspaceRoot,
                        )
                      ).content,
                    );
                  } catch (error) {
                    setCompareError(errorText(error));
                  }
                }}
              >
                {t('查看磁盘内容')}
              </Button>
              <Button onClick={() => onCreate(snapshot.content)}>{t('另存副本')}</Button>
            </>
          ) : (
            <Button onClick={() => void session.reloadDiscardingEdits()}>{t('重试')}</Button>
          )}
        </div>
      ) : null}
      {compareError ? (
        <div className="sf-file-error" role="alert">
          {translateError(compareError)}
        </div>
      ) : null}
      {diskContent !== null ? (
        <div className="sf-file-disk">
          <div>
            <strong>{t('磁盘版本 · 只读')}</strong>
            <Button
              variant="ghost"
              iconOnly
              onClick={() => setDiskContent(null)}
              aria-label={t('关闭磁盘内容')}
            >
              <X size={14} />
            </Button>
          </div>
          <pre>{diskContent}</pre>
          <p>{t('可将所需内容复制回编辑器；“重新读取”会丢弃当前未保存编辑。')}</p>
        </div>
      ) : null}
      {mode === 'writing' && isTex ? (
        <div className="sf-file-hint">{t('LaTeX 源码编辑 · 当前 MVP 尚未接入 TeX 编译器。')}</div>
      ) : null}
      <div
        ref={canvas}
        className={`sf-file-canvas ${isMarkdown && actualLayout === 'split' ? 'is-split' : ''}`}
      >
        {!loaded ? (
          <div className="sf-file-loading">
            {snapshot.phase === 'error'
              ? t('文件未能打开，请检查项目目录后重试。')
              : t('正在读取文件…')}
          </div>
        ) : (
          <>
            {!isMarkdown || actualLayout !== 'preview' ? (
              <Suspense fallback={<div className="sf-file-loading">{t('正在加载编辑器…')}</div>}>
                <CodeEditor
                  session={session}
                  onSelection={setSelection}
                  onCursor={(line, column) => setCursor({ line, column })}
                />
              </Suspense>
            ) : null}
            {isMarkdown && actualLayout !== 'source' ? (
              <Suspense fallback={<div className="sf-file-loading">{t('正在加载预览…')}</div>}>
                <MarkdownPreview content={deferredText} />
              </Suspense>
            ) : null}
          </>
        )}
      </div>
      <div className="sf-file-footer">
        <span>
          {isMarkdown
            ? 'Markdown'
            : isTex
              ? 'LaTeX / BibTeX'
              : /\.py$/i.test(session.path)
                ? 'Python'
                : t('纯文本 / 源码')}
        </span>
        <span>UTF-8</span>
        <span>{t('{count} 行', { count: snapshot.content.split('\n').length })}</span>
        <span className="sf-file-footer-tip">
          {mode === 'experiments' ? (
            t('行 {line}，列 {column}', cursor)
          ) : (
            <>
              {t('Ctrl+S 保存 ·')}{' '}
              {selection
                ? t('已选 {count} 字符', { count: selection.length })
                : t('选区可用于 AI 提问或研究笔记')}
            </>
          )}
        </span>
      </div>
    </>
  );
}

type TreeNode = { name: string; path: string; directory: boolean; children: TreeNode[] };
function createTree(files: ResearchFile[], mode: Mode, search: string): TreeNode[] {
  const root: TreeNode[] = [];
  for (const file of files) {
    if (
      mode === 'writing' &&
      (file.kind === 'directory' ||
        !/\.(md|markdown|mdown|tex|bib|sty|cls|txt|csv)$/i.test(file.path))
    )
      continue;
    if (search && !file.path.toLowerCase().includes(search.toLowerCase())) continue;
    const parts = file.path.replace(/\\/g, '/').split('/');
    let current = root;
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join('/');
      let node = current.find((item) => item.path === path);
      if (!node) {
        node = {
          name,
          path,
          directory: file.kind === 'directory' || index !== parts.length - 1,
          children: [],
        };
        current.push(node);
      }
      current = node.children;
    });
  }
  function sort(nodes: TreeNode[]) {
    nodes.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    nodes.forEach((node) => sort(node.children));
  }
  sort(root);
  return root;
}

export function FileResources({
  project,
  backend,
  mode,
  view,
  activePath,
  onOpen,
  workspaceRoot,
  onCreate,
}: {
  project: Project;
  backend: ResearchBackend;
  mode: Mode;
  view: string;
  activePath?: string | null;
  onOpen: (path: string) => void;
  workspaceRoot?: string;
  onCreate?: () => void;
}) {
  const [files, setFiles] = useState<ResearchFile[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    setPhase('loading');
    setError('');
    backend
      .listFiles(project.id, workspaceRoot)
      .then((result) => {
        if (alive) {
          setFiles(result);
          setPhase('ready');
        }
      })
      .catch((reason) => {
        if (alive) {
          setError(errorText(reason));
          setPhase('error');
        }
      });
    return () => {
      alive = false;
    };
  }, [backend, project.id, project.path, refresh, workspaceRoot]);
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail === project.id) setRefresh((value) => value + 1);
    };
    window.addEventListener(resourceEvent, changed);
    return () => window.removeEventListener(resourceEvent, changed);
  }, [project.id]);
  const tree = createTree(files, mode, search);
  const items = (nodes: TreeNode[]): TreeItem[] =>
    nodes.map((node) => ({
      id: node.path,
      label: node.name,
      children: node.directory ? items(node.children) : undefined,
    }));
  return (
    <div className="sf-file-resources">
      <div className="sf-resource-heading">
        <span>
          {view === 'versions'
            ? t('项目文件')
            : mode === 'writing'
              ? t('论文文件')
              : t('资源管理器')}
        </span>
        {onCreate && (
          <Button variant="ghost" iconOnly aria-label={t('新建文件')} onClick={onCreate}>
            <FilePlus2 size={13} />
          </Button>
        )}
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('折叠所有文件夹')}
          onClick={() =>
            setCollapsed(
              new Set(files.filter((file) => file.kind === 'directory').map((file) => file.path)),
            )
          }
        >
          <ChevronsDownUp size={13} />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('刷新项目文件')}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={13} />
        </Button>
      </div>
      <div className="sf-resource-search">
        <Input
          aria-label={t('筛选项目文件')}
          placeholder={t('筛选文件…')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && search) {
              const match = files.find(
                (file) =>
                  file.kind === 'file' &&
                  file.path.toLowerCase().includes(search.toLowerCase()) &&
                  (mode !== 'writing' ||
                    /\.(md|markdown|mdown|tex|bib|sty|cls|txt|csv)$/i.test(file.path)),
              );
              if (match) {
                event.preventDefault();
                onOpen(match.path);
              }
            }
          }}
        />
      </div>
      <div className="sf-resource-tree">
        {phase === 'loading' ? (
          <p>{t('正在读取…')}</p>
        ) : phase === 'error' ? (
          <p role="alert">{translateError(error)}</p>
        ) : tree.length ? (
          <TreeView
            label={t('项目文件')}
            items={items(tree)}
            selectedId={activePath}
            collapsed={search ? new Set() : collapsed}
            onToggle={(id) =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onOpen={onOpen}
          />
        ) : (
          <p>{search ? t('没有匹配的文件') : t('暂无文件')}</p>
        )}
      </div>
      <div className="sf-resource-root" title={workspaceRoot || project.path}>
        {workspaceRoot || project.path || t('本机项目目录')}
      </div>
    </div>
  );
}

function GitChanges({
  project,
  backend,
  onOpen,
}: {
  project: Project;
  backend: ResearchBackend;
  onOpen: (path: string) => void;
}) {
  const [changes, setChanges] = useState<{ path: string; status: string }[]>([]);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    setState('loading');
    backend
      .gitStatus(project.id)
      .then((result) => {
        if (alive) {
          setChanges(result);
          setState('ready');
        }
      })
      .catch((reason) => {
        if (alive) {
          setError(errorText(reason));
          setState('error');
        }
      });
    return () => {
      alive = false;
    };
  }, [project.id, backend, refresh]);
  return (
    <Panel className="sf-file-workspace">
      <div className="sf-file-view-heading">
        <GitBranch size={17} />
        <h2>{t('版本变更')}</h2>
        <Button onClick={() => setRefresh((value) => value + 1)}>
          <RefreshCw size={14} />
          {t('刷新')}
        </Button>
      </div>
      <div className="sf-file-view-body">
        {state === 'loading' ? (
          <p>{t('正在读取 Git 状态…')}</p>
        ) : state === 'error' ? (
          <div role="alert">
            <p>{translateError(error)}</p>
            <p className="sf-file-secondary">
              {t('当前 MVP 提供 Git 状态查看；初始化仓库和提交请使用现有 Git 工具。')}
            </p>
          </div>
        ) : changes.length ? (
          <>
            <p className="sf-file-secondary">
              {t('{count} 个变更 · 状态来自项目 Git 仓库', { count: changes.length })}
            </p>
            <div className="sf-git-list">
              {changes.map((change) => (
                <div key={change.path}>
                  <code>{change.status}</code>
                  <Button variant="ghost" onClick={() => onOpen(change.path)}>
                    {change.path}
                  </Button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p>{t('工作区干净，没有未提交变更。')}</p>
        )}
      </div>
    </Panel>
  );
}

function ProjectReferences({ project, store }: { project: Project; store: WorkspaceStore }) {
  const source = useStore(store, (state) => state.data?.papers);
  const papers = (source ?? []).filter((paper) => paper.projects.includes(project.id));
  return (
    <Panel className="sf-file-workspace">
      <div className="sf-file-view-heading">
        <FileText size={17} />
        <h2>{t('项目引用')}</h2>
      </div>
      <div className="sf-file-view-body">
        {papers.length ? (
          <div className="sf-citation-list">
            {papers.map((paper, index) => (
              <div key={paper.id}>
                <span>[{index + 1}]</span>
                <div>
                  <strong>{paper.title}</strong>
                  <p>
                    {typeof paper.authors === 'string' ? paper.authors : ''}
                    {paper.year ? ` · ${paper.year}` : ''}
                  </p>
                  {typeof paper.doi === 'string' ? <span>DOI: {paper.doi}</span> : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p>{t('还没有关联文献。请先到文献区添加论文。')}</p>
        )}
      </div>
    </Panel>
  );
}
