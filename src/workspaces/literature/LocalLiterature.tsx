import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import {
  FolderOpen,
  FolderPlus,
  Search,
  RefreshCw,
  Import,
  MoreHorizontal,
  Globe,
  NotebookPen,
  X,
} from 'lucide-react';
import { Button, Input } from '../../components/primitives';
import { TreeView, type TreeItem } from '../../components/workspace/TreeView';
import { DocumentTabs } from '../../components/workspace/DocumentTabs';
import { ResizeHandle } from '../../shell/ResizeHandle';
import { Modal } from '../../components/Modal';
import { t, translateError } from '../../i18n';
import {
  nativeLibrary,
  noteFiles,
  type LibraryBackend,
  type LibraryScan,
  type LibraryOperation,
} from '../../platform/library';
import {
  browserCommand,
  browserEvents,
  browserLayout,
  type BrowserTab,
} from '../../platform/browser-pane';
import {
  beginFileOperation,
  getFileRuntime,
  invalidateProjectFileSessions,
} from '../../editor/sessions';
import {
  emptyLocalSession,
  readLocalSession,
  saveLocalSession,
  openLocalPdf,
  closeLocalTab,
  paperNote,
  notesDirty,
  notesPending,
} from './local-session';
import { PaperNotes } from './PaperNotes';
import { BrowserPane } from './BrowserPane';
import type { Project } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import type { ResearchBackend } from '../../platform/research';
import type { WorkContext } from '../../domain/context';
import './local-literature.css';

const PdfReader = lazy(() => import('../../reader/PdfReader'));
const parent = (path: string) => path.split('/').slice(0, -1).join('/');
const filename = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const asError = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function LocalLiterature({
  project,
  store,
  backend,
  library = nativeLibrary,
  view,
  onView,
  width,
  resize,
  onContext,
  onLegacy,
  requestedPaper,
}: {
  project: Project;
  store: WorkspaceStore;
  backend: ResearchBackend;
  library?: LibraryBackend;
  view: string;
  onView: (view: string) => void;
  width: number;
  resize?: ReactNode;
  onContext: (context: WorkContext) => void;
  onLegacy: () => void;
  requestedPaper?: string | null;
}) {
  const data = useStore(store, (s) => s.data);
  const workspaceBusy = useStore(store, (s) => s.busy);
  const [scan, setScan] = useState<LibraryScan>({
    root: null,
    entries: [],
    papers: [],
    warnings: [],
  });
  const [session, setSession] = useState(() => readLocalSession(project.id));
  const [query, setQuery] = useState(''),
    [searchOpen, setSearchOpen] = useState(false),
    [showNotes, setShowNotes] = useState(false),
    [collapsed, setCollapsed] = useState(new Set<string>());
  const [selected, setSelected] = useState(''),
    [clipboard, setClipboard] = useState<{ path: string; copy: boolean } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<{
    kind: 'mkdir' | 'rename' | 'move' | 'relink';
    path: string;
    value: string;
  } | null>(null);
  const search = useRef<HTMLInputElement>(null),
    host = useRef<HTMLDivElement>(null),
    alive = useRef(true),
    generation = useRef(0),
    drag = useRef('');
  const currentSession = useRef(session);
  currentSession.current = session;
  const actionPending = useRef(false);
  const changed = useRef(onContext);
  changed.current = onContext;
  const panelId = useId(),
    notePanel = useId();
  const active = session.tabs.find((t) => t.id === session.active),
    paper = scan.papers.find((p) => p.id === active?.paperId);
  const [selection, setSelection] = useState<WorkContext>();
  const requestedPath = scan.papers.find((p) => p.id === requestedPaper)?.path;
  useEffect(() => {
    if (requestedPath) void open(requestedPath);
  }, [requestedPath, requestedPaper]);
  const selectedEntry = scan.entries.find((e) => e.path === selected);
  const directory = selectedEntry?.directory ? selected : parent(selected);
  const protect = () => {
    if (workspaceBusy) throw new Error(t('请等待当前保存完成。'));
    if (notesDirty(library) || notesPending(library))
      throw new Error(t('请先保存论文笔记，再操作文件。'));
  };
  const refresh = useCallback(async () => {
    const ticket = ++generation.current;
    try {
      const next = await library.command(project.id, { op: 'scan' });
      if (alive.current && ticket === generation.current) {
        setScan(next);
        setError('');
        setSession((previous) =>
          previous.root && next.root && previous.root !== next.root
            ? { ...emptyLocalSession(), root: next.root }
            : { ...previous, root: next.root },
        );
      }
    } catch (e) {
      if (alive.current && ticket === generation.current) setError(asError(e));
    }
  }, [project.id, library]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const events = library.changed((id, eventError) => {
      if (id === project.id) {
        if (eventError) setError(eventError);
        else void refresh();
        for (const note of getFileRuntime(noteFiles(library)).sessions.values())
          if (
            note.projectId === id &&
            !note.getSnapshot().dirty &&
            note.getSnapshot().phase === 'ready'
          )
            void note.reloadDiscardingEdits();
      }
    });
    return () => {
      alive.current = false;
      ++generation.current;
      void events.then((stop) => stop());
      void browserLayout({ op: 'hideAll' }).catch(() => {});
    };
  }, [project.id, library, refresh]);
  useEffect(() => {
    saveLocalSession(project.id, session);
  }, [project.id, session]);
  useEffect(() => {
    if (active?.kind !== 'web') void browserLayout({ op: 'hideAll' }).catch(() => {});
    setSelection(undefined);
    changed.current({
      projectId: project.id,
      workspace: 'literature',
      title: active?.kind === 'web' ? t('浏览器新页') : (active?.title ?? t('文献')),
      resourceId: active?.paperId,
    });
  }, [active?.id, active?.kind, project.id]);
  useEffect(() => {
    const listener = browserEvents('browser-created', (tab) => {
      if (tab.projectId !== project.id) return;
      setSession((s) => ({
        ...s,
        tabs: [
          ...s.tabs,
          { id: tab.id, kind: 'web', title: tab.title || t('浏览器新页'), url: tab.url },
        ],
        active: tab.id,
      }));
    });
    let cancelled = false;
    void browserCommand<BrowserTab[]>({ op: 'snapshot' })
      .then(async (current) => {
        for (const old of currentSession.current.tabs.filter((t) => t.kind === 'web')) {
          if (cancelled || current.some((t) => t.id === old.id)) continue;
          const next = await browserCommand<BrowserTab>({ op: 'open', project_id: project.id });
          if (cancelled) {
            await browserCommand({ op: 'close', id: next.id });
            return;
          }
          setSession((s) => ({
            ...s,
            tabs: s.tabs.map((t) => (t.id === old.id ? { ...t, id: next.id } : t)),
            active: s.active === old.id ? next.id : s.active,
          }));
        }
      })
      .catch((e) => {
        if (!cancelled) setError(asError(e));
      });
    return () => {
      cancelled = true;
      void listener.then((stop) => stop());
    };
  }, [project.id]);
  useEffect(() => {
    if (!menu) return;
    requestAnimationFrame(() =>
      host.current?.querySelector<HTMLElement>('[role="menu"] button')?.focus(),
    );
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);
  async function run(action: () => Promise<void>) {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setError('');
    const finish = beginFileOperation(backend);
    try {
      await action();
    } catch (e) {
      if (alive.current) setError(asError(e));
    } finally {
      finish();
      actionPending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const selectPdf = async (path: string) => {
    const binding = await library.open(project.id, path);
    if (!alive.current) return;
    setScan((s) => ({ ...s, papers: [...s.papers.filter((p) => p.id !== binding.id), binding] }));
    setSession((s) => openLocalPdf(s, binding.id, filename(binding.path)));
    setSelected(path);
  };
  async function open(path: string) {
    const entry = scan.entries.find((e) => e.path === path);
    if (!entry) return;
    await run(async () => {
      if (entry.pdf) await selectPdf(path);
      else await library.external(project.id, path, true);
    });
  }
  async function mutate(operation: LibraryOperation) {
    await run(async () => {
      protect();
      const next = await library.command(project.id, operation);
      setScan(next);
      if (operation.op === 'delete') {
        const remaining = new Set(next.papers.map((paper) => paper.id));
        setSession((previous) => {
          let current = previous;
          for (const tab of previous.tabs)
            if (tab.paperId && !remaining.has(tab.paperId))
              current = closeLocalTab(current, tab.id);
          const notes = current.notes.filter((id) => remaining.has(id));
          return {
            ...current,
            notes,
            activeNote:
              current.activeNote && notes.includes(current.activeNote)
                ? current.activeNote
                : (notes.at(-1) ?? null),
            showNotes: current.showNotes && notes.length > 0,
          };
        });
      }
      if (operation.op === 'transfer' && !operation.copy) {
        setSelected(operation.destination);
        setClipboard((value) => (value?.path === operation.path ? null : value));
      }
    });
  }
  async function choose() {
    await run(async () => {
      protect();
      const next = await library.choose(project.id);
      if (next) {
        invalidateProjectFileSessions(noteFiles(library), project.id);
        for (const tab of session.tabs)
          if (tab.kind === 'web') await browserCommand({ op: 'close', id: tab.id });
        setSession({ ...emptyLocalSession(), root: next.root });
        setScan(next);
      }
    });
  }
  async function newWeb() {
    await run(async () => {
      const tab = await browserCommand<BrowserTab>({ op: 'open', project_id: project.id });
      setSession((s) => ({
        ...s,
        tabs: [...s.tabs, { id: tab.id, title: t('浏览器新页'), kind: 'web' }],
        active: tab.id,
      }));
    });
  }
  async function closeTab(id: string) {
    const tab = session.tabs.find((t) => t.id === id);
    if (tab?.kind === 'web') await browserCommand({ op: 'close', id });
    setSession((s) => closeLocalTab(s, id));
  }
  async function closeNote(id: string) {
    const note = paperNote(library, project.id, id);
    if (note.getSnapshot().phase === 'saving' || note.getSnapshot().phase === 'loading') return;
    if (note.getSnapshot().dirty && !(await note.save())) {
      setError(note.getSnapshot().error ?? t('保存失败，请重试。'));
      return;
    }
    if (note.getSnapshot().dirty || note.getSnapshot().phase === 'saving') return;
    setSession((s) => {
      const notes = s.notes.filter((n) => n !== id);
      return {
        ...s,
        notes,
        activeNote: s.activeNote === id ? (notes.at(-1) ?? null) : s.activeNote,
        showNotes: notes.length > 0,
      };
    });
  }
  const reader = useMemo<ResearchBackend>(
    () => ({ ...backend, readPdf: (id) => library.pdf(project.id, id) }),
    [backend, library, project.id],
  );
  const visible = scan.entries.filter((e) => showNotes || !e.note);
  const matches = new Set<string>();
  for (const e of visible)
    if (!query || e.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
      matches.add(e.path);
      let p = parent(e.path);
      while (p) {
        matches.add(p);
        p = parent(p);
      }
    }
  const nodes = new Map<string, TreeItem>();
  for (const entry of visible.filter((e) => matches.has(e.path)))
    nodes.set(entry.path, {
      id: entry.path,
      label: entry.name,
      tooltip: entry.path,
      draggable: true,
      ...(entry.directory ? { children: [] } : {}),
    });
  const tree: TreeItem[] = [];
  for (const [path, item] of nodes) {
    const p = parent(path);
    if (p && nodes.has(p)) nodes.get(p)!.children!.push(item);
    else tree.push(item);
  }
  const target = menu?.path ?? selected;
  const targetEntry = scan.entries.find((e) => e.path === target);
  const targetFolder = targetEntry?.directory ? target : parent(target);
  function pasteDestination(source: string, folder: string, copy: boolean) {
    const wanted = join(folder, filename(source));
    if (!copy || wanted !== source) return wanted;
    const entry = scan.entries.find((e) => e.path === source),
      name = filename(source);
    const dot = entry?.directory ? -1 : name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name,
      ext = dot > 0 ? name.slice(dot) : '';
    let n = 1;
    while (
      scan.entries.some(
        (e) => e.path.toLowerCase() === join(folder, `${stem} (${n})${ext}`).toLowerCase(),
      )
    )
      n++;
    return join(folder, `${stem} (${n})${ext}`);
  }
  const binding = scan.papers.find((p) => p.path === target || p.notePath === target);
  const pathFrom = (element: EventTarget | null) =>
    element instanceof Element
      ? (element.closest('[data-tree-id]')?.getAttribute('data-tree-id') ?? '')
      : '';
  async function showMenu(path: string, x: number, y: number) {
    await browserLayout({ op: 'hideAll' }).catch(() => {});
    setSelected(path);
    setMenu({
      path,
      x: Math.min(x, window.innerWidth - 215),
      y: Math.min(y, window.innerHeight - 360),
    });
  }
  function command(kind: 'mkdir' | 'rename' | 'move' | 'relink', path = target) {
    setMenu(null);
    setDialog({
      kind,
      path,
      value:
        kind === 'mkdir'
          ? join(targetFolder, t('新建文件夹'))
          : kind === 'rename'
            ? filename(path)
            : path,
    });
  }
  return (
    <div
      className="literature-studio local-library"
      ref={host}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          setSearchOpen(true);
          requestAnimationFrame(() => search.current?.focus());
        }
      }}
    >
      <aside
        className="literature-sidebar"
        style={{ '--literature-sidebar-width': `${width}px` } as CSSProperties}
        aria-label={t('本地文献目录')}
      >
        <nav className="literature-sidebar-views">
          <Button
            variant="ghost"
            aria-current={view !== 'subscriptions' ? 'page' : undefined}
            onClick={() => onView('local')}
          >
            {t('Library')}
          </Button>
          <Button
            variant="ghost"
            aria-current={view === 'subscriptions' ? 'page' : undefined}
            onClick={() => onView('subscriptions')}
          >
            {t('Subscriptions')}
          </Button>
        </nav>
        {view === 'subscriptions' ? (
          <div className="subscription-placeholder">
            <Button onClick={() => void newWeb()}>
              <Globe />
              {t('打开浏览器')}
            </Button>
            <h3>{t('消息推荐')}</h3>
            <p>{t('尚未启用')}</p>
            <h3>{t('个人信息源')}</h3>
            <p>{t('尚未启用')}</p>
          </div>
        ) : (
          <>
            <div className="library-root-toolbar">
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('打开文献文件夹')}
                onClick={() => void choose()}
                disabled={busy}
              >
                <FolderOpen />
              </Button>
              <div className="library-root-title">
                <span className="truncate" title={scan.root ?? ''}>
                  {scan.root ? filename(scan.root) : t('文献库')}
                </span>
                <div className={`library-hover-search ${searchOpen || query ? 'is-open' : ''}`}>
                  <Input
                    ref={search}
                    aria-label={t('搜索文献')}
                    placeholder={t('搜索文件名和路径')}
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      if (e.target.value) setCollapsed(new Set());
                    }}
                  />
                </div>
              </div>
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('搜索文献')}
                onClick={() => {
                  setSearchOpen(!searchOpen);
                  requestAnimationFrame(() => search.current?.focus());
                }}
              >
                <Search />
              </Button>
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('更多操作')}
                onClick={(e) =>
                  void showMenu(
                    '',
                    e.currentTarget.getBoundingClientRect().left,
                    e.currentTarget.getBoundingClientRect().bottom,
                  )
                }
              >
                <MoreHorizontal />
              </Button>
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('新建文件夹')}
                disabled={!scan.root || busy}
                onClick={() => command('mkdir', directory)}
              >
                <FolderPlus />
              </Button>
            </div>
            <div
              className="local-file-tree"
              onContextMenu={(e) => {
                e.preventDefault();
                void showMenu(pathFrom(e.target), e.clientX, e.clientY);
              }}
              onDragStart={(e) => {
                drag.current = pathFrom(e.target);
                e.dataTransfer.setData('text/plain', drag.current);
              }}
              onDragEnd={() => {
                drag.current = '';
              }}
              onDragOver={(e) => {
                if (drag.current) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                const dest = pathFrom(e.target);
                const entry = scan.entries.find((v) => v.path === dest);
                if (drag.current) {
                  void mutate({
                    op: 'transfer',
                    path: drag.current,
                    destination: join(
                      entry?.directory ? dest : parent(dest),
                      filename(drag.current),
                    ),
                    copy: e.ctrlKey,
                  });
                  drag.current = '';
                }
              }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && ['c', 'x', 'v'].includes(e.key.toLowerCase())) {
                  e.preventDefault();
                  const focusPath = pathFrom(e.target) || selected;
                  const focusEntry = scan.entries.find((entry) => entry.path === focusPath);
                  const pasteFolder = focusEntry?.directory ? focusPath : parent(focusPath);
                  if (e.key.toLowerCase() === 'v' && clipboard)
                    void mutate({
                      op: 'transfer',
                      path: clipboard.path,
                      destination: pasteDestination(clipboard.path, pasteFolder, clipboard.copy),
                      copy: clipboard.copy,
                    });
                  else if (focusPath)
                    setClipboard({ path: focusPath, copy: e.key.toLowerCase() === 'c' });
                }
                if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                  e.preventDefault();
                  const r = (e.target as HTMLElement).getBoundingClientRect();
                  void showMenu(pathFrom(e.target), r.left, r.bottom);
                }
              }}
            >
              <TreeView
                label={t('项目文献')}
                items={tree}
                selectedId={selected}
                collapsed={collapsed}
                onToggle={(id) => {
                  setSelected(id);
                  setCollapsed((s) => {
                    const n = new Set(s);
                    if (n.has(id)) n.delete(id);
                    else n.add(id);
                    return n;
                  });
                }}
                onOpen={(path) => void open(path)}
              />
              {!scan.root && (
                <div className="library-unmounted">
                  <Button onClick={() => void choose()}>{t('打开文献文件夹')}</Button>
                  <p>{t('选择真实目录，PDF 与笔记保存在原位置。')}</p>
                </div>
              )}
              {scan.papers
                .filter((p) => !scan.entries.some((e) => e.path === p.path))
                .map((p) => (
                  <Button
                    key={p.id}
                    variant="ghost"
                    className="missing-paper"
                    onClick={() => {
                      setDialog({ kind: 'relink', path: p.id, value: p.path });
                    }}
                  >
                    {t('重新关联')} · {filename(p.path)}
                  </Button>
                ))}
            </div>
            <div className="library-bottom">
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('刷新')}
                onClick={() => void refresh()}
              >
                <RefreshCw />
              </Button>
              <span>{scan.entries.filter((e) => e.pdf).length} PDF</span>
              <span className="spacer" />
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('导入 PDF')}
                disabled={!scan.root || busy}
                onClick={() =>
                  void run(async () => {
                    const s = await library.import(project.id, false);
                    if (s) setScan(s);
                  })
                }
              >
                <Import />
              </Button>
              <Button variant="ghost" onClick={onLegacy}>
                {t('旧资料')}
              </Button>
            </div>
          </>
        )}
      </aside>
      {resize}
      <div className="local-library-center">
        {(error || scan.warnings.length > 0) && (
          <div className="inline-error" role="alert">
            {error ? translateError(error) : scan.warnings.map(translateError).join('\n')}
            <Button
              variant="ghost"
              iconOnly
              aria-label={t('关闭提示')}
              onClick={() => {
                setError('');
                setScan((s) => ({ ...s, warnings: [] }));
              }}
            >
              <X />
            </Button>
          </div>
        )}
        <div className="local-editor-groups">
          <div className="local-reading-group">
            <DocumentTabs
              tabs={session.tabs.map((tab) => ({
                id: tab.id,
                title: tab.paperId
                  ? filename(scan.papers.find((p) => p.id === tab.paperId)?.path ?? tab.title)
                  : tab.title,
              }))}
              activeId={session.active}
              panelId={panelId}
              newLabel={t('浏览器新页')}
              onSelect={(id) =>
                setSession((s) => {
                  const tab = s.tabs.find((t) => t.id === id);
                  return {
                    ...s,
                    active: id,
                    activeNote:
                      tab?.paperId && s.notes.includes(tab.paperId) ? tab.paperId : s.activeNote,
                  };
                })
              }
              onClose={(id) => void closeTab(id).catch((e) => setError(asError(e)))}
              onNew={() => void newWeb()}
            />
            <div className="local-reader" id={panelId} role="tabpanel" aria-label={t('文献呈现区')}>
              {active?.kind === 'web' ? (
                <BrowserPane
                  key={active.id}
                  id={active.id}
                  initialUrl={active.url}
                  onChanged={(tab) =>
                    setSession((s) => ({
                      ...s,
                      tabs: s.tabs.map((t) =>
                        t.id === tab.id
                          ? { ...t, title: tab.title || tab.url || t.title, url: tab.url || t.url }
                          : t,
                      ),
                    }))
                  }
                />
              ) : paper ? (
                <Suspense fallback={<p>{t('正在打开阅读器…')}</p>}>
                  <PdfReader
                    key={`${paper.id}:${paper.fingerprint}`}
                    assetId={paper.id}
                    paperId={paper.id}
                    title={filename(paper.path)}
                    projectId={project.id}
                    backend={reader}
                    compact
                    onContext={(value) => {
                      setSelection(value);
                      changed.current({
                        projectId: project.id,
                        workspace: 'literature',
                        title: filename(paper.path),
                        resourceId: paper.id,
                      });
                    }}
                    onTool={() =>
                      setSession((s) => ({
                        ...s,
                        notes: s.notes.includes(paper.id) ? s.notes : [...s.notes, paper.id],
                        activeNote: paper.id,
                        showNotes: true,
                      }))
                    }
                  />
                </Suspense>
              ) : (
                <div className="literature-blank">{t('从左侧打开文献')}</div>
              )}
            </div>
          </div>
          {session.showNotes && session.notes.length > 0 && (
            <>
              <ResizeHandle
                value={session.noteWidth}
                min={240}
                max={500}
                side="right"
                label={t('调整论文笔记宽度')}
                onChange={(noteWidth) => setSession((s) => ({ ...s, noteWidth }))}
              />
              <div className="local-note-group" style={{ width: session.noteWidth }}>
                <DocumentTabs
                  tabs={session.notes.map((id) => ({
                    id,
                    title: filename(scan.papers.find((p) => p.id === id)?.path ?? t('论文笔记')),
                  }))}
                  activeId={session.activeNote}
                  label={t('论文笔记标签')}
                  panelId={notePanel}
                  onSelect={(activeNote) => setSession((s) => ({ ...s, activeNote }))}
                  onClose={(id) => void closeNote(id)}
                />
                <div
                  id={notePanel}
                  className="local-note-body"
                  role="tabpanel"
                  aria-label={t('论文笔记')}
                >
                  {session.activeNote && (
                    <PaperNotes
                      key={session.activeNote}
                      library={library}
                      project={project.id}
                      id={session.activeNote}
                      paper={scan.papers.find((p) => p.id === session.activeNote)}
                      selection={selection}
                      onPage={(page) => {
                        const id = session.activeNote!;
                        const bound = scan.papers.find((p) => p.id === id);
                        if (!bound) return;
                        try {
                          localStorage.setItem(`scientify.reader.${id}`, String(page));
                        } catch {
                          /* Optional location. */
                        }
                        setSession((s) => openLocalPdf(s, id, filename(bound.path)));
                        requestAnimationFrame(() =>
                          window.dispatchEvent(
                            new CustomEvent('scientify-pdf-page', {
                              detail: { paperId: id, page },
                            }),
                          ),
                        );
                      }}
                    />
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      {menu && (
        <div
          className="library-context-menu"
          role="menu"
          data-native-overlay="true"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setMenu(null);
              host.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus();
            }
            const items = [
              ...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
            ];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              items[
                (index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length
              ]?.focus();
            }
          }}
        >
          <Button role="menuitem" onClick={() => command('mkdir')}>
            {t('新建文件夹')}
          </Button>
          {target && (
            <>
              <Button role="menuitem" onClick={() => command('rename')}>
                {t('重命名')}
              </Button>
              <Button
                role="menuitem"
                onClick={() => {
                  setClipboard({ path: target, copy: false });
                  setMenu(null);
                }}
              >
                {t('剪切')}
              </Button>
              <Button
                role="menuitem"
                onClick={() => {
                  setClipboard({ path: target, copy: true });
                  setMenu(null);
                }}
              >
                {t('复制')}
              </Button>
              <Button role="menuitem" onClick={() => command('move')}>
                {t('移动到')}
              </Button>
            </>
          )}
          <Button
            role="menuitem"
            disabled={!clipboard || !scan.root}
            onClick={() => {
              if (clipboard)
                void mutate({
                  op: 'transfer',
                  path: clipboard.path,
                  destination: pasteDestination(clipboard.path, targetFolder, clipboard.copy),
                  copy: clipboard.copy,
                });
              setMenu(null);
            }}
          >
            {t('粘贴')}
          </Button>
          {(binding || targetEntry?.pdf) && (
            <Button
              role="menuitem"
              onClick={() => {
                setMenu(null);
                void run(async () => {
                  const p = binding ?? (await library.open(project.id, target));
                  setSession((s) => ({
                    ...s,
                    notes: s.notes.includes(p.id) ? s.notes : [...s.notes, p.id],
                    activeNote: p.id,
                    showNotes: true,
                  }));
                  await refresh();
                });
              }}
            >
              <NotebookPen />
              {t('打开论文笔记')}
            </Button>
          )}
          <Button
            role="menuitem"
            disabled={!scan.root}
            onClick={() => {
              void library.external(project.id, target, false).catch((e) => setError(asError(e)));
              setMenu(null);
            }}
          >
            {t('在文件管理器中显示')}
          </Button>
          {target && (
            <Button
              role="menuitem"
              onClick={() => {
                setMenu(null);
                if (confirm(t('将所选项目及关联笔记移入系统回收站？文件夹包括全部子内容。')))
                  void mutate({ op: 'delete', path: target });
              }}
            >
              {t('移入回收站')}
            </Button>
          )}
          <Button
            role="menuitemcheckbox"
            aria-checked={showNotes}
            onClick={() => {
              setShowNotes(!showNotes);
              setMenu(null);
            }}
          >
            {t('显示笔记文件')}
          </Button>
          <Button
            role="menuitem"
            disabled={!scan.root || !data?.papers.length}
            onClick={() => {
              setMenu(null);
              if (confirm(t('复制当前项目旧附件和笔记，保留原记录；重复迁移会产生副本。继续？')))
                void run(async () => {
                  protect();
                  const s = await library.import(project.id, true);
                  if (s) setScan(s);
                });
            }}
          >
            {t('迁移旧文献')}
          </Button>
          <Button
            role="menuitem"
            disabled={!scan.root}
            onClick={() => {
              setMenu(null);
              if (confirm(t('解除目录关联不会删除文件，是否继续？')))
                void run(async () => {
                  protect();
                  setScan(await library.command(project.id, { op: 'detach' }));
                  invalidateProjectFileSessions(noteFiles(library), project.id);
                  for (const tab of currentSession.current.tabs)
                    if (tab.kind === 'web') await browserCommand({ op: 'close', id: tab.id });
                  setSession(emptyLocalSession());
                });
            }}
          >
            {t('解除目录关联')}
          </Button>
        </div>
      )}
      {dialog && (
        <Modal
          title={t(
            { mkdir: '新建文件夹', rename: '重命名', move: '移动到', relink: '重新关联' }[
              dialog.kind
            ],
          )}
          onClose={() => setDialog(null)}
          busy={busy}
        >
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                protect();
                const path =
                  dialog.kind === 'rename' ? join(parent(dialog.path), dialog.value) : dialog.value;
                const operation: LibraryOperation =
                  dialog.kind === 'mkdir'
                    ? { op: 'mkdir', path }
                    : dialog.kind === 'relink'
                      ? { op: 'relink', id: dialog.path, path }
                      : { op: 'transfer', path: dialog.path, destination: path, copy: false };
                setScan(await library.command(project.id, operation));
                setDialog(null);
              });
            }}
          >
            <Input
              aria-label={t('相对路径')}
              value={dialog.value}
              autoFocus
              onChange={(e) => setDialog({ ...dialog, value: e.target.value })}
              disabled={busy}
            />
            {error && <p role="alert">{translateError(error)}</p>}
            <Button type="submit" disabled={busy || !dialog.value.trim()}>
              {t('保存')}
            </Button>
          </form>
        </Modal>
      )}
    </div>
  );
}
