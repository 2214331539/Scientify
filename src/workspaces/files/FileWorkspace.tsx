import { t, translateError } from '../../i18n';
import { Button, Input } from '../../components/primitives';
import { Panel } from '../../components/layout/Panel';
import { TreeView, type TreeItem } from '../../components/workspace/TreeView';
import { useActiveView } from '../../components/workspace/ViewTransition';
import type { Extension } from '@codemirror/state';
import {
  lazy,
  Suspense,
  type ReactNode,
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
  FolderPlus,
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
import type {
  FileContent,
  GitChange,
  ResearchBackend,
  ResearchFile,
} from '../../platform/research';
import { canEditProject, requestProjectSync } from '../../platform/collaboration';
import { displayPath } from '../../platform/os';
import type { WorkspaceStore } from '../../stores/workspace';
import {
  beginFileOperation,
  getFileRuntime,
  getFileSession,
  hasUnsavedFileChanges,
  notifyFileRuntime,
  type FileSession,
} from '../../editor/sessions';
import MarkdownPreview from './MarkdownPreview';
import { BinaryView, fileKind, NotebookView, TableView } from './viewers';
import { errorMessage } from '../../domain/errors';
import './files.css';

const CodeEditor = lazy(() =>
  import('../../editor/CodeEditor').then((module) => ({ default: module.CodeEditor })),
);

type Mode = 'experiments' | 'writing' | 'files';
/** A tab that is not a file: run records, the Git log, a diff. */
export interface CustomTab {
  title: string;
  icon: ReactNode;
  render(): ReactNode;
}
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
  /** Resolves tab ids that are not files; files get `null`. */
  customTab?: (id: string) => CustomTab | null;
  /** Shown when no tab is open, instead of the default. */
  empty?: ReactNode;
  /** Keeps a separate set of tabs, for example one per manuscript. */
  scope?: string;
  /** After a file is saved. */
  onSaved?: (path: string) => void;
  onCursor?: (path: string, line: number) => void;
  /** Extra editor behavior for a file, such as LaTeX completion. */
  editorExtensions?: (path: string) => Extension[];
};
const fileName = (path: string) => path.split('/').pop() || path;
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
  const viewActive = useActiveView();
  const { project, backend, mode, view, onContext, onDirtyChange, onActivePathChange } = props;
  const readOnly = !canEditProject(project, 'code');
  const runtime = useRuntime(backend);
  const shortcuts = useStore(props.store, (state) => state.data?.settings.shortcuts);
  const workspaceRoot = props.workspaceRoot;
  const scope = JSON.stringify(
    props.scope
      ? [project.id, mode, workspaceRoot ?? '', props.scope]
      : [project.id, mode, workspaceRoot ?? ''],
  );
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
  // "Save a copy" after a conflict: the current buffer goes to a new path.
  const [copy, setCopy] = useState<{ content: string; name: string } | null>(null);
  const [copyError, setCopyError] = useState('');
  const [copying, setCopying] = useState(false);
  const [closeTarget, setCloseTarget] = useState<string | null>(null);
  const onContextRef = useRef(onContext);
  onContextRef.current = onContext;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const dirty = hasUnsavedFileChanges(backend);
  const onSavedRef = useRef(props.onSaved);
  onSavedRef.current = props.onSaved;
  const notifySaves = mode === 'experiments' || !!props.onSaved;
  const onCodeSaved = useCallback(
    async (file: FileContent, _previousVersion: string | null) => {
      if (mode === 'experiments') requestProjectSync(project.id);
      onSavedRef.current?.(file.path);
    },
    [mode, project.id],
  );
  const getSession = useCallback(
    (path: string) =>
      getFileSession(
        backend,
        project.id,
        path,
        workspaceRoot,
        notifySaves ? onCodeSaved : undefined,
      ),
    [backend, notifySaves, onCodeSaved, project.id, workspaceRoot],
  );

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
    setCopy(null);
    setCopyError('');
    setCopying(false);
  }, [project.id, mode, workspaceRoot]);
  useEffect(() => {
    if (!viewActive) return;
    if (!activePath)
      onContextRef.current({
        projectId: project.id,
        workspace: mode,
        title: mode === 'writing' ? t('Paper') : mode === 'files' ? t('Files') : t('Code'),
      });
  }, [activePath, project.id, mode, view, viewActive]);

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
  async function saveCopy() {
    if (!copy) return;
    const path = copy.name.trim().replace(/\\/g, '/');
    if (!path || path.startsWith('/') || path.split('/').some((part) => part === '..' || !part)) {
      setCopyError(t('请输入项目内相对路径，例如 notes/idea.md。'));
      return;
    }
    setCopying(true);
    setCopyError('');
    const finishOperation = beginFileOperation(backend);
    try {
      const created = await backend.writeFile(
        project.id,
        path,
        copy.content,
        null,
        ...(workspaceRoot ? [workspaceRoot] : []),
      );
      if (mode === 'experiments') void onCodeSaved(created, null);
      if (mounted.current && activeScope.current === scope) {
        open(path);
        setCopy(null);
      }
      window.dispatchEvent(new CustomEvent(resourceEvent, { detail: project.id }));
    } catch (error) {
      if (mounted.current && activeScope.current === scope) setCopyError(errorMessage(error));
    } finally {
      finishOperation();
      if (mounted.current && activeScope.current === scope) setCopying(false);
    }
  }

  const custom = activePath ? props.customTab?.(activePath) : null;
  // Images, PDFs and other binary files are shown, not loaded as editable text.
  const binary =
    !!activePath && !custom && ['image', 'pdf', 'binary'].includes(fileKind(activePath));
  const session = activePath && !custom && !binary ? getSession(activePath) : null;
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
      <div
        className="sf-file-tabs"
        role="tablist"
        aria-label={t('打开的文件')}
        hidden={!tabs.length}
      >
        {tabs.map((path) => {
          const custom = props.customTab?.(path);
          const title = custom?.title ?? fileName(path);
          const dirty = !custom && getSession(path).getSnapshot().dirty;
          return (
            <div key={path} className={`sf-file-tab ${path === activePath ? 'is-active' : ''}`}>
              <Button
                variant="ghost"
                role="tab"
                aria-selected={path === activePath}
                title={custom ? title : path}
                onClick={() => open(path)}
              >
                {custom?.icon ?? (
                  <FileText
                    size={14}
                    className="sf-file-type-icon"
                    data-extension={path.split('.').pop()?.toLowerCase()}
                  />
                )}
                <span>{title}</span>
                {dirty ? (
                  <span className="sf-file-dirty" aria-label={t('未保存')}>
                    ●
                  </span>
                ) : null}
              </Button>
              <Button
                variant="ghost"
                iconOnly
                className="sf-file-close"
                aria-label={t('关闭 {name}', { name: title })}
                onClick={() => (dirty ? setCloseTarget(path) : close(path))}
              >
                <X size={12} />
              </Button>
            </div>
          );
        })}
      </div>
      {copy ? (
        <form
          className="sf-file-create"
          onSubmit={(event) => {
            event.preventDefault();
            void saveCopy();
          }}
        >
          <label htmlFor="file-copy-path">{t('副本路径')}</label>
          <Input
            autoFocus
            id="file-copy-path"
            value={copy.name}
            onChange={(event) => setCopy({ ...copy, name: event.target.value })}
            disabled={copying}
          />
          <Button variant="primary" type="submit" disabled={copying || !copy.name.trim()}>
            {copying ? t('保存中…') : t('保存副本')}
          </Button>
          <Button type="button" onClick={() => setCopy(null)} disabled={copying}>
            {t('取消')}
          </Button>
          {copyError ? <p role="alert">{translateError(copyError)}</p> : null}
        </form>
      ) : null}
      {closeTarget ? (
        <div className="sf-file-confirm" role="alert">
          <span>{t('“{name}” 尚未保存。', { name: fileName(closeTarget) })}</span>
          <Button
            onClick={async () => {
              if (await getSession(closeTarget).save()) close(closeTarget);
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
      {custom ? (
        <div className="sf-file-custom">{custom.render()}</div>
      ) : binary ? (
        <BinaryView
          key={JSON.stringify([project.id, activePath, workspaceRoot ?? ''])}
          backend={backend}
          projectId={project.id}
          path={activePath!}
          workspaceRoot={workspaceRoot}
          onContext={onContext}
        />
      ) : session ? (
        <FileDocument
          key={JSON.stringify([project.id, activePath, workspaceRoot ?? ''])}
          session={session}
          project={project}
          mode={mode}
          shortcuts={shortcuts}
          onContext={onContext}
          extensions={props.editorExtensions?.(activePath!)}
          onCursor={props.onCursor}
          onSaveCopy={(content) => {
            if (readOnly) return;
            setCopyError('');
            setCopy({ content, name: '' });
          }}
        />
      ) : props.empty ? (
        props.empty
      ) : (
        <div className="sf-file-empty">
          <FileCode2 size={30} strokeWidth={1.3} aria-hidden="true" />
          <h2>{t('没有打开的文件')}</h2>
        </div>
      )}
    </Panel>
  );
}

function FileDocument({
  session,
  project,
  mode,
  shortcuts,
  onContext,
  onSaveCopy,
  extensions,
  onCursor,
}: {
  session: FileSession;
  project: Project;
  mode: Mode;
  shortcuts?: import('../../platform/shortcuts').ShortcutSettings;
  onContext: (value: WorkContext) => void;
  extensions?: Extension[];
  onCursor?: (path: string, line: number) => void;
  onSaveCopy: (content: string) => void;
}) {
  const viewActive = useActiveView();
  const readOnly = !canEditProject(project, 'code');
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
  const kind = fileKind(session.path);
  const rendered = kind === 'table' || kind === 'notebook';
  const [showSource, setShowSource] = useState(false);
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
    if (!viewActive) return;
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
  }, [project.id, mode, session, snapshot.content, selection, viewActive]);
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
          disabled={readOnly || !snapshot.dirty || !loaded || snapshot.phase === 'saving'}
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
        {rendered ? (
          <div className="sf-file-segments" aria-label={t('显示方式')}>
            <Button variant="ghost" aria-pressed={!showSource} onClick={() => setShowSource(false)}>
              {t(kind === 'table' ? '表格' : '笔记本')}
            </Button>
            <Button variant="ghost" aria-pressed={showSource} onClick={() => setShowSource(true)}>
              {t('源码')}
            </Button>
          </div>
        ) : null}
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
                    setCompareError(errorMessage(error));
                  }
                }}
              >
                {t('查看磁盘内容')}
              </Button>
              <Button onClick={() => onSaveCopy(snapshot.content)}>{t('另存副本')}</Button>
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
      <div
        ref={canvas}
        className={`sf-file-canvas ${isMarkdown && actualLayout === 'split' ? 'is-split' : ''}`}
      >
        {!loaded ? (
          <div className="sf-file-loading" role={snapshot.phase === 'error' ? 'alert' : undefined}>
            {snapshot.phase === 'error'
              ? translateError(snapshot.error ?? t('文件未能打开，请检查项目目录后重试。'))
              : t('正在读取文件…')}
          </div>
        ) : rendered && !showSource ? (
          kind === 'table' ? (
            <TableView content={deferredText} path={session.path} />
          ) : (
            <NotebookView content={deferredText} />
          )
        ) : (
          <>
            {!isMarkdown || actualLayout !== 'preview' ? (
              <Suspense fallback={<div className="sf-file-loading">{t('正在加载编辑器…')}</div>}>
                <CodeEditor
                  readOnly={readOnly}
                  session={session}
                  shortcuts={shortcuts}
                  onSelection={setSelection}
                  extensions={extensions}
                  onCursor={(line, column) => {
                    setCursor({ line, column });
                    onCursor?.(session.path, line);
                  }}
                />
              </Suspense>
            ) : null}
            {isMarkdown && actualLayout !== 'source' ? (
              <MarkdownPreview content={deferredText} />
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
                : kind === 'table'
                  ? 'CSV'
                  : kind === 'notebook'
                    ? 'Jupyter'
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

/** A request from outside the explorer (a start page, a menu) to name a new file or folder. */
export type CreateRequest = { kind: 'file' | 'folder'; id: number };

export function FileResources({
  project,
  backend,
  mode,
  view,
  activePath,
  onOpen,
  workspaceRoot,
  label,
  changes,
  createRequest,
  folder,
  hide,
}: {
  project: Project;
  backend: ResearchBackend;
  mode: Mode;
  view: string;
  activePath?: string | null;
  onOpen: (path: string) => void;
  workspaceRoot?: string;
  label?: string;
  /** Git changes shown as M, A, U, D on rows; folders with changes get a dot. */
  changes?: GitChange[];
  createRequest?: CreateRequest;
  /** Shows only this project-relative folder, with every file in it ('' is the whole project). */
  folder?: string;
  /** Folders that belong to another page, such as manuscripts inside the project folder. */
  hide?: string[];
}) {
  const editable = canEditProject(project, 'code');
  const scoped = folder !== undefined;
  const prefix = folder ? folder + '/' : '';
  const canMakeFolders = (mode !== 'writing' || scoped) && !!backend.createDirectory;
  const [files, setFiles] = useState<ResearchFile[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [refresh, setRefresh] = useState(0);
  // The explorer's own selection, as in VS Code: new items go into the selected folder
  // (or the selected file's folder); clicking empty space selects the root.
  const [selected, setSelected] = useState(activePath ?? '');
  const [draft, setDraft] = useState<{
    kind: 'file' | 'folder';
    parent: string;
    value: string;
    error?: string;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (activePath) setSelected(activePath);
  }, [activePath]);
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
          setError(errorMessage(reason));
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
  useEffect(() => {
    setDraft(null);
    setSelected('');
  }, [project.id, workspaceRoot]);
  function startCreate(kind: 'file' | 'folder') {
    if (!editable || creating || (kind === 'folder' && !canMakeFolders)) return;
    const entry = files.find((file) => file.path === selected);
    const parent =
      (entry?.kind === 'directory' ? selected : selected.split('/').slice(0, -1).join('/')) ||
      (folder ?? '');
    if (parent)
      setCollapsed((current) => {
        const next = new Set(current);
        next.delete(parent);
        return next;
      });
    setSearch('');
    setDraft({ kind, parent, value: '' });
  }
  const startRef = useRef(startCreate);
  startRef.current = startCreate;
  useEffect(() => {
    if (createRequest?.id) startRef.current(createRequest.kind);
  }, [createRequest?.id, createRequest?.kind]);
  async function commitCreate() {
    if (!draft || creating) return;
    const name = draft.value.trim().replace(/\\/g, '/');
    if (!name) {
      setDraft(null);
      return;
    }
    const parts = name.split('/');
    if (/[:*?"<>|]/.test(name) || parts.some((part) => !part || part === '.' || part === '..')) {
      setDraft({ ...draft, error: t('名称不能包含 \\ / : * ? " < > |') });
      return;
    }
    const path = draft.parent ? `${draft.parent}/${name}` : name;
    if (files.some((file) => file.path.toLowerCase() === path.toLowerCase())) {
      setDraft({ ...draft, error: t('此位置已存在文件或文件夹“{name}”。', { name }) });
      return;
    }
    setCreating(true);
    const finishOperation = beginFileOperation(backend);
    try {
      if (draft.kind === 'folder') await backend.createDirectory!(project.id, path, workspaceRoot);
      else
        await backend.writeFile(
          project.id,
          path,
          '',
          null,
          ...(workspaceRoot ? [workspaceRoot] : []),
        );
      if (mode === 'experiments') requestProjectSync(project.id);
      setDraft(null);
      setSelected(path);
      window.dispatchEvent(new CustomEvent(resourceEvent, { detail: project.id }));
      if (draft.kind === 'file') onOpen(path);
    } catch (reason) {
      setDraft({ ...draft, error: translateError(errorMessage(reason)) });
    } finally {
      finishOperation();
      setCreating(false);
    }
  }
  // In a folder view, the tree is built from paths inside it and its ids get the folder back.
  const outside = (path: string) =>
    !!hide?.some((item) => path === item || path.startsWith(item + '/'));
  const shown = scoped
    ? files
        .filter((file) => file.path.startsWith(prefix) && file.path !== folder)
        .map((file) => ({ ...file, path: file.path.slice(prefix.length) }))
    : files.filter((file) => !outside(file.path));
  const tree = createTree(shown, scoped ? 'files' : mode, search);
  const status = new Map(changes?.map((change) => [change.path, change.status]));
  const changedFolders = new Set(
    changes?.flatMap((change) =>
      change.path
        .split('/')
        .slice(0, -1)
        .map((_, index, parts) => parts.slice(0, index + 1).join('/')),
    ),
  );
  const decoration = (node: TreeNode): TreeItem['decoration'] => {
    if (node.directory)
      return changedFolders.has(prefix + node.path) ? { text: '•', tone: 'modified' } : undefined;
    const code = status.get(prefix + node.path);
    if (!code) return undefined;
    if (code.includes('U') || code === 'AA' || code === 'DD')
      return { text: '!', tone: 'conflict' };
    if (code === '??') return { text: 'U', tone: 'added' };
    if (code.includes('A')) return { text: 'A', tone: 'added' };
    if (code.includes('D')) return { text: 'D', tone: 'deleted' };
    return { text: 'M', tone: 'modified' };
  };
  const items = (nodes: TreeNode[]): TreeItem[] =>
    nodes.map((node) => ({
      id: prefix + node.path,
      label: node.name,
      children: node.directory ? items(node.children) : undefined,
      decoration: decoration(node),
    }));
  const root = workspaceRoot || project.path;
  return (
    <div className="sf-file-resources">
      <div className="sf-resource-heading">
        <span>
          {label ??
            (view === 'versions' ? t('项目文件') : mode === 'writing' ? t('论文文件') : t('文件'))}
        </span>
        {editable ? (
          <>
            <Button
              variant="ghost"
              iconOnly
              aria-label={t('新建文件')}
              tooltip={t('新建文件…')}
              disabled={phase !== 'ready' || creating}
              onClick={() => startCreate('file')}
            >
              <FilePlus2 size={13} />
            </Button>
            {canMakeFolders ? (
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('新建文件夹')}
                tooltip={t('新建文件夹…')}
                disabled={phase !== 'ready' || creating}
                onClick={() => startCreate('folder')}
              >
                <FolderPlus size={13} />
              </Button>
            ) : null}
          </>
        ) : null}
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
      <div
        className="sf-resource-tree"
        onClick={(event) => {
          // Empty space selects the root, so the next new item goes there.
          if (!(event.target as Element).closest('[data-tree-id], button, input')) setSelected('');
        }}
      >
        {phase === 'loading' ? (
          <p>{t('正在读取…')}</p>
        ) : phase === 'error' ? (
          <p role="alert">{translateError(error)}</p>
        ) : tree.length || draft ? (
          <TreeView
            label={t('项目文件')}
            items={items(tree)}
            selectedId={selected || null}
            draft={
              draft
                ? {
                    ...draft,
                    parent: draft.parent === (folder ?? '') ? '' : draft.parent,
                    label: t(draft.kind === 'file' ? '文件名称' : '文件夹名称'),
                    onChange: (value) => setDraft({ ...draft, value, error: undefined }),
                    onCommit: () => void commitCreate(),
                    onCancel: () => setDraft(null),
                  }
                : null
            }
            collapsed={search ? new Set() : collapsed}
            onToggle={(id) => {
              setSelected(id);
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onOpen={(id) => {
              setSelected(id);
              onOpen(id);
            }}
          />
        ) : (
          <p>{search ? t('没有匹配的文件') : t('暂无文件')}</p>
        )}
      </div>
      {/* The code workbench names its folder in the title bar widget instead. */}
      {root && mode !== 'experiments' ? (
        <div className="sf-resource-root" title={displayPath(root)}>
          {displayPath(root)}
        </div>
      ) : null}
    </div>
  );
}
