import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleX,
  Code2,
  Columns2,
  Download,
  FileArchive,
  FileText,
  FolderOpen,
  History,
  Leaf,
  PackageOpen,
  List,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  PenLine,
  Plus,
  Quote,
  RefreshCw,
  Search,
  Settings2,
  Square,
  X,
  Files as FilesIcon,
} from 'lucide-react';
import { Button, Dropdown, Input } from '../../components/primitives';
import { Menu, type MenuAnchor } from '../../components/primitives/Menu';
import { Modal } from '../../components/Modal';
import { WorkspaceFrame } from '../../components/workspace/WorkspaceFrame';
import { useActiveView } from '../../components/workspace/ViewTransition';
import { confirmAction } from '../../components/prompts';
import type { WorkContext } from '../../domain/context';
import type { Project } from '../../domain/workspace';
import { isTauri } from '@tauri-apps/api/core';
import { projectFolders, withWorkspaceRoot, type ResearchBackend } from '../../platform/research';
import {
  writingApi,
  type CompileResult,
  type Engine,
  type Imported,
  type TexStatus,
} from '../../platform/writing';
import type { WorkspaceStore } from '../../stores/workspace';
import { useSidebarSlot } from '../../shell/Sidebar';
import { canEditProject } from '../../platform/collaboration';
import { getFileRuntime, getFileSession } from '../../editor/sessions';
import { latexCompletion, type LatexSource } from '../../editor/latex';
import { t, translateError } from '../../i18n';
import { errorMessage } from '../../domain/errors';
import { FileResources, FileWorkspace } from '../files/FileWorkspace';
import { CodeSearch } from '../experiments/CodeSearch';
import { SideSection } from '../experiments/SideSection';
import {
  bibKeys,
  citations,
  countWords,
  dependencies,
  detectCompiler,
  hint,
  isArtifact,
  isMainDocument,
  labels,
  missingFiles,
  networkFailure,
  outline,
  parseLog,
  type LogEntry,
} from './latex';
import {
  backwardSearch,
  forwardSearch,
  parseSynctex,
  type PdfSpot,
  type SyncData,
} from './synctex';
import { PdfPreview } from './PdfPreview';
import {
  compilerLabel,
  createManuscript,
  adoptManuscripts,
  join,
  manuscriptChoiceKey,
  manuscriptFromImport,
  manuscriptsOf,
  removeManuscript,
  saveManuscript,
  TEMPLATES,
  type Compiler,
  type Manuscript,
  type Template,
} from './manuscripts';
import '../experiments/workbench.css';
import './writing.css';

type Build = {
  running: boolean;
  result?: CompileResult;
  entries: LogEntry[];
  pdf?: Uint8Array;
  synctex?: SyncData;
  error?: string;
};
// Builds outlive the page, so coming back to Writing shows the last PDF and log.
const builds = new Map<string, Build>();
const IMAGE = /\.(png|jpe?g|pdf|eps|svg)$/i;
type Side = 'files' | 'search' | 'refs' | 'review' | 'history';
/**
 * Missing packages after a compile: the computer's TeX lacked them and the bundled engine took
 * over ('switched'), the computer's TeX lacks them ('missing'), or the bundled engine could not
 * download them ('offline').
 */
type Notice = { kind: 'switched' | 'missing' | 'offline'; files: string[] };
const SIDES: { id: Side; label: string; icon: typeof FilesIcon }[] = [
  { id: 'files', label: '文件', icon: FilesIcon },
  { id: 'search', label: '搜索', icon: Search },
  { id: 'refs', label: '参考文献', icon: Quote },
  { id: 'review', label: '审阅', icon: MessageSquare },
  { id: 'history', label: '历史', icon: History },
];
const remembered = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Preferences are optional. */
  }
};
const below = (event: React.MouseEvent<HTMLElement>): MenuAnchor => {
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4, trigger: event.currentTarget };
};
const STATUS: Record<CompileResult['status'], string> = {
  success: '编译成功',
  failed: '编译失败',
  cancelled: '已停止编译',
};
const fileList = (files: string[]) => files.slice(0, 3).join(', ') + (files.length > 3 ? '…' : '');

/** Every file of a manuscript, and the text of its .tex and .bib files (open buffers win). */
function useManuscriptFiles(
  backend: ResearchBackend,
  projectId: string,
  folder: string | null,
  revision: number,
) {
  const [state, setState] = useState<{ paths: string[]; texts: Map<string, string> }>({
    paths: [],
    texts: new Map(),
  });
  useEffect(() => {
    if (folder === null) return;
    let alive = true;
    void (async () => {
      const prefix = folder ? folder + '/' : '';
      const files = (await backend.listFiles(projectId)).filter(
        (file) => file.kind === 'file' && file.path.startsWith(prefix),
      );
      const texts = new Map<string, string>();
      for (const file of files.filter((item) => /\.(tex|bib)$/i.test(item.path)).slice(0, 300)) {
        const open = getFileRuntime(backend).sessions.get(
          JSON.stringify([projectId, file.path, '']),
        );
        const snapshot = open?.getSnapshot();
        try {
          texts.set(
            file.path,
            snapshot && snapshot.phase !== 'idle' && snapshot.phase !== 'error'
              ? snapshot.content
              : (await backend.readFile(projectId, file.path)).content,
          );
        } catch {
          /* An unreadable file only drops out of completion and references. */
        }
      }
      if (alive) setState({ paths: files.map((file) => file.path), texts });
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [backend, projectId, folder, revision]);
  return state;
}

/**
 * The writing module as a local Overleaf: a manuscript's files and outline on the left, its
 * LaTeX source and the compiled PDF side by side, the log in place of the PDF when asked.
 */
type WritingProps = {
  project: Project;
  store: WorkspaceStore;
  backend: ResearchBackend;
  view: string;
  onView(view: string): void;
  activePath: string | null | undefined;
  onOpen(path: string | null): void;
  onContext(context: WorkContext): void;
};

// Each project's writing folder, once asked.
const writingRoots = new Map<string, string>();

/**
 * Manuscripts live in the project's writing folder, apart from its code: every
 * file the page reads, writes or compiles is there. The browser preview and the
 * tests have no such folder and keep the project's files.
 */
export function WritingWorkspace(props: WritingProps) {
  const id = props.project.id;
  const [root, setRoot] = useState<string | null | undefined>(() =>
    isTauri() ? writingRoots.get(id) : null,
  );
  const [error, setError] = useState('');
  useEffect(() => {
    if (!isTauri() || writingRoots.has(id)) return;
    let current = true;
    void projectFolders(id)
      .then((folders) => {
        writingRoots.set(id, folders.writing);
        if (current) setRoot(folders.writing);
      })
      .catch((reason) => current && setError(translateError(errorMessage(reason))));
    return () => {
      current = false;
    };
  }, [id]);
  const backend = useMemo(
    () => (root ? withWorkspaceRoot(props.backend, root) : props.backend),
    [props.backend, root],
  );
  if (error)
    return (
      <p role="alert" className="error-text">
        {error}
      </p>
    );
  if (root === undefined) return null;
  return <WritingWorkspaceView {...props} backend={backend} writingRoot={root ?? undefined} />;
}

function WritingWorkspaceView({
  project,
  store,
  backend,
  activePath,
  onOpen,
  onContext,
  writingRoot,
}: WritingProps & { writingRoot?: string }) {
  const slot = useSidebarSlot();
  const viewActive = useActiveView();
  const readOnly = !canEditProject(project, 'code');
  const live = useStore(store, (state) =>
    state.data?.projects.find((item) => item.id === project.id),
  );
  const manuscripts = manuscriptsOf(live ?? project);
  const choiceKey = manuscriptChoiceKey(project.id);
  const [choice, setChoice] = useState(() => remembered(choiceKey, ''));
  // '' picks the first manuscript; '*' is the plain project files view (Markdown and others).
  const manuscript =
    choice === '*'
      ? null
      : (manuscripts.find((item) => item.id === choice) ?? manuscripts[0] ?? null);
  const choose = (id: string) => {
    setChoice(id);
    remember(choiceKey, id);
  };
  const choiceRef = useRef(choice);
  choiceRef.current = choice;
  // A file of a manuscript opened from the project files view goes to that manuscript,
  // where it compiles and shows the PDF.
  const folders = manuscripts.map((item) => `${item.id}\n${item.folder}`).join('\n');
  useEffect(() => {
    if (choice !== '*' || !activePath) return;
    const owner = manuscripts.find(
      (item) => item.folder && activePath.startsWith(item.folder + '/'),
    );
    if (owner) choose(owner.id);
  }, [activePath, choice, folders]); // `folders` stands for `manuscripts`
  const [side, setSide] = useState<Side>('files');
  const [layout, setLayoutState] = useState(() => remembered('scientify.writing.layout', 'split'));
  const setLayout = (value: string) => {
    setLayoutState(value);
    remember('scientify.writing.layout', value);
  };
  const [pane, setPane] = useState<'pdf' | 'log'>('pdf');
  // A log opened because a build failed closes again when a later build makes a PDF.
  const autoLog = useRef(false);
  const [tex, setTex] = useState<TexStatus | null>(null);
  const [draft, setDraft] = useState(false);
  const [stopOnError, setStopOnError] = useState(false);
  const [dialog, setDialog] = useState<
    'new' | 'add' | 'overleaf' | 'export' | 'settings' | 'words' | null
  >(null);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [menu, setMenu] = useState<{
    kind: 'manuscript' | 'compile' | 'more';
    anchor: MenuAnchor;
  } | null>(null);
  const [error, setError] = useState('');
  const [highlight, setHighlight] = useState<(PdfSpot & { at: number }) | null>(null);
  const [revision, setRevision] = useState(0);
  const [ratio, setRatio] = useState(0.5);
  const cursor = useRef<{ path: string; line: number } | null>(null);
  const key = manuscript ? `${project.id}:${manuscript.id}` : '';
  const keyRef = useRef(key);
  keyRef.current = key;
  const [build, setBuildState] = useState<Build>(
    () => builds.get(key) ?? { running: false, entries: [] },
  );
  useEffect(() => setBuildState(builds.get(key) ?? { running: false, entries: [] }), [key]);
  const setBuild = (target: string, next: Build) => {
    builds.set(target, next);
    if (target === keyRef.current) setBuildState(next);
  };
  const files = useManuscriptFiles(backend, project.id, manuscript?.folder ?? null, revision);
  // LaTeX folders that appear in the project (written by the AI, copied in) become manuscripts.
  useEffect(() => {
    if (readOnly) return;
    let alive = true;
    let running = false;
    let again = false;
    const look = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          const current = store.getState().data?.projects.find((item) => item.id === project.id);
          const added = current && alive ? await adoptManuscripts(store, backend, current) : [];
          // A paper that just appeared is shown rather than the plain file view.
          if (added.length && alive && choiceRef.current === '*') {
            setChoice(added[0].id);
            remember(manuscriptChoiceKey(project.id), added[0].id);
          }
        } while (again && alive);
      } catch {
        /* Only a convenience: the manuscript menu still adds folders by hand. */
      } finally {
        running = false;
      }
    };
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail === project.id) void look();
    };
    const focused = () => void look();
    void look();
    window.addEventListener('scientify-project-files-changed', changed);
    window.addEventListener('focus', focused);
    return () => {
      alive = false;
      window.removeEventListener('scientify-project-files-changed', changed);
      window.removeEventListener('focus', focused);
    };
  }, [backend, project.id, readOnly, store]);
  useEffect(() => {
    if (!writingApi.available()) return;
    void writingApi
      .status()
      .then(setTex)
      .catch(() => {});
  }, []);
  const relative = (path: string) =>
    manuscript?.folder && path.startsWith(manuscript.folder + '/')
      ? path.slice(manuscript.folder.length + 1)
      : path;
  const inside = (path: string) =>
    !!manuscript && (!manuscript.folder || path.startsWith(manuscript.folder + '/'));
  const target = manuscript ? { folder: manuscript.folder, main: manuscript.main } : null;

  async function compile(clean = false, engine?: Engine) {
    if (!manuscript || !target) return;
    if (!writingApi.available()) {
      setError(t('编译需要桌面应用。'));
      return;
    }
    const id = `${project.id}:${manuscript.id}`;
    const previous = builds.get(id) ?? { running: false, entries: [] };
    if (previous.running) return;
    setMenu(null);
    setError('');
    setBuild(id, { ...previous, running: true, error: undefined });
    try {
      // Like Overleaf, compile what is on screen: this manuscript's unsaved buffers are saved first.
      for (const session of getFileRuntime(backend).sessions.values())
        if (
          session.projectId === project.id &&
          session.workspaceRoot === writingRoot &&
          inside(session.path) &&
          session.getSnapshot().dirty &&
          !(await session.save())
        )
          throw new Error(t('文件保存失败，请处理冲突后再编译。'));
      const result = await writingApi.compile(project.id, {
        ...target,
        compiler: manuscript.compiler,
        engine: engine ?? manuscript.engine,
        draft,
        stopOnError,
        clean,
        writePdf: manuscript.writePdf,
      });
      const entries = parseLog(result.log, result.output, result.root);
      const pdf = result.pdf
        ? await writingApi.pdf(project.id, target).catch(() => undefined)
        : undefined;
      const sync = result.pdf
        ? await writingApi
            .synctex(project.id, target)
            .then((text) => parseSynctex(text, result.root))
            .catch(() => undefined)
        : undefined;
      setBuild(id, {
        running: false,
        result,
        entries,
        pdf: pdf ?? previous.pdf,
        synctex: sync ?? previous.synctex,
      });
      if (result.status === 'failed' && !pdf) {
        setPane('log');
        autoLog.current = true;
      } else if (pdf && autoLog.current) {
        setPane('pdf');
        autoLog.current = false;
      }
      // The bundled engine downloads missing packages by itself, so it takes over or retries.
      const missing = missingFiles(
        [...entries.map((entry) => entry.message), result.output].join('\n'),
      );
      if (result.status === 'success')
        setNotice((current) => (current?.kind === 'switched' ? current : null));
      else if (result.status === 'failed' && !result.bundled && missing.length) {
        const auto = (engine ?? manuscript.engine) === 'auto' && !!tex?.builtin;
        setNotice({ kind: auto ? 'switched' : 'missing', files: missing });
        if (auto) void compileRef.current(clean, 'builtin');
      } else if (result.status === 'failed' && result.bundled && networkFailure(result.output))
        setNotice({ kind: 'offline', files: missing });
      setRevision((value) => value + 1);
    } catch (reason) {
      setBuild(id, { ...previous, running: false, error: errorMessage(reason) });
    }
  }
  const compileRef = useRef(compile);
  compileRef.current = compile;
  useEffect(() => setNotice(null), [key]);
  // What could not be downloaded is fetched as soon as the computer is back online.
  useEffect(() => {
    if (notice?.kind !== 'offline') return;
    const retry = () => void compileRef.current();
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [notice?.kind]);
  // Like Overleaf, a manuscript shows its PDF when opened: the first visit compiles it.
  useEffect(() => {
    if (!key || !viewActive || !tex || builds.has(key) || !writingApi.available()) return;
    if (!manuscript?.autoCompile || (!tex.local && !tex.builtin)) return;
    void compileRef.current();
  }, [key, viewActive, tex, manuscript?.autoCompile]);
  const pendingSave = useRef<number | undefined>(undefined);
  function onSaved(path: string) {
    setRevision((value) => value + 1);
    if (!manuscript?.autoCompile || !inside(path)) return;
    window.clearTimeout(pendingSave.current);
    pendingSave.current = window.setTimeout(() => void compileRef.current(), 250);
  }
  useEffect(() => {
    function keys(event: KeyboardEvent) {
      if (!viewActive || document.querySelector('dialog[open]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        void compileRef.current();
      }
    }
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [viewActive]);

  async function reveal(path: string, line: number) {
    onOpen(path);
    const session = getFileSession(backend, project.id, path);
    await session.load();
    const lines = session.getSnapshot().content.split('\n');
    const from = lines
      .slice(0, Math.max(0, line - 1))
      .reduce((sum, text) => sum + text.length + 1, 0);
    session.requestEditorCommand({
      type: 'reveal',
      from,
      to: from + (lines[line - 1]?.length ?? 0),
    });
  }
  function syncForward() {
    if (!build.synctex) {
      setError(t('先编译一次，才能在 PDF 中定位。'));
      return;
    }
    const at = cursor.current ?? (activePath ? { path: activePath, line: 1 } : null);
    if (!at || !inside(at.path)) return;
    const spot = forwardSearch(build.synctex, relative(at.path), at.line);
    if (!spot) {
      setError(t('这一行在 PDF 里没有对应的位置。'));
      return;
    }
    if (layout === 'source') setLayout('split');
    setPane('pdf');
    setHighlight({ ...spot, at: Date.now() });
  }
  function syncBackward(page: number, x: number, y: number) {
    if (!build.synctex || !manuscript) return;
    const found = backwardSearch(build.synctex, page, x, y);
    if (found) void reveal(join(manuscript.folder, found.file), found.line);
  }
  /** Registers a folder that was just unpacked or cloned and opens its main document. */
  async function adopt(imported: Imported, name: string) {
    window.dispatchEvent(
      new CustomEvent('scientify-project-files-changed', { detail: project.id }),
    );
    const next = await manuscriptFromImport(backend, project.id, imported, name);
    await saveManuscript(store, project.id, next);
    choose(next.id);
    setDialog(null);
    onOpen(join(next.folder, next.main));
  }
  async function importZip() {
    setMenu(null);
    setDialog(null);
    setError('');
    if (!writingApi.available()) {
      setError(t('导入需要桌面应用。'));
      return;
    }
    setImporting(true);
    try {
      const imported = await writingApi.importZip(project.id);
      if (imported) await adopt(imported, imported.folder);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setImporting(false);
    }
  }

  // Completion reads the manuscript's labels, bibliography and files when it opens.
  const index = useRef(files);
  index.current = files;
  const folderRef = useRef(manuscript?.folder ?? '');
  folderRef.current = manuscript?.folder ?? '';
  const source = useMemo<LatexSource>(
    () => ({
      labels: () =>
        [...index.current.texts]
          .filter(([path]) => path.endsWith('.tex'))
          .flatMap(([, text]) => labels(text)),
      citations: () =>
        [...index.current.texts]
          .filter(([path]) => path.endsWith('.bib'))
          .flatMap(([, text]) =>
            bibKeys(text).map((entry) => {
              const rest = text.slice(text.indexOf(entry));
              const title = /title\s*=\s*[{"]([^}"]*)/i.exec(rest)?.[1];
              return { key: entry, detail: title?.replace(/\s+/g, ' ').slice(0, 80) };
            }),
          ),
      files: (kind) => {
        const prefix = folderRef.current ? folderRef.current + '/' : '';
        return index.current.paths
          .filter((path) => (kind === 'image' ? IMAGE.test(path) : /\.tex$/i.test(path)))
          .map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path));
      },
    }),
    [],
  );
  const extensions = useMemo(() => [latexCompletion(source)], [source]);

  const texPaths = files.paths.filter((path) => path.endsWith('.tex'));
  const words = useMemo(
    () =>
      [...files.texts]
        .filter(([path]) => path.endsWith('.tex'))
        .reduce((sum, [, text]) => sum + countWords(text), 0),
    [files.texts],
  );
  const refs = useMemo(() => {
    const bib = new Set(
      [...files.texts]
        .filter(([path]) => path.endsWith('.bib'))
        .flatMap(([, text]) => bibKeys(text)),
    );
    const cited = new Map<string, { path: string; line: number }>();
    for (const [path, text] of files.texts)
      if (path.endsWith('.tex'))
        for (const item of citations(text))
          if (!cited.has(item.key)) cited.set(item.key, { path, line: item.line });
    const missing = [...cited].filter(([entry]) => !bib.has(entry));
    const used = [...cited].filter(([entry]) => bib.has(entry));
    const unused = [...bib].filter((entry) => !cited.has(entry));
    return { missing, used, unused };
  }, [files.texts]);

  const errors = build.entries.filter((entry) => entry.kind === 'error');
  const warnings = build.entries.filter((entry) => entry.kind !== 'error');
  const engine = tex?.local
    ? tex.local.distribution
    : tex?.builtin
      ? t('内置引擎')
      : tex
        ? t('没有 TeX')
        : '';
  const noTex = !!tex && !tex.local && !tex.builtin;

  // ---------- Side views ----------
  const activeSession =
    activePath && /\.tex$/i.test(activePath)
      ? getFileSession(backend, project.id, activePath)
      : null;
  const sessionText = useSyncExternalStore(
    (listener) => activeSession?.subscribe(listener) ?? (() => {}),
    () => activeSession?.getSnapshot().content ?? '',
  );
  const headings = useMemo(() => outline(sessionText), [sessionText]);
  const sideBody: Record<Side, ReactNode> = {
    files: (
      <>
        <div className="sf-writing-files">
          <FileResources
            project={project}
            backend={backend}
            workspaceRoot={writingRoot}
            mode="writing"
            view="files"
            folder={manuscript ? manuscript.folder : undefined}
            label={manuscript ? manuscript.name : t('项目文件')}
            activePath={activePath}
            onOpen={onOpen}
          />
        </div>
        {manuscript ? (
          <SideSection title={t('大纲')}>
            {headings.map((item) => (
              <Button
                key={`${item.line}:${item.title}`}
                variant="ghost"
                className="sf-outline-row"
                style={{ paddingLeft: 12 + Math.max(0, item.level - 2) * 12 }}
                onClick={() => {
                  if (!activePath) return;
                  void reveal(activePath, item.line);
                  const spot = build.synctex
                    ? forwardSearch(build.synctex, relative(activePath), item.line)
                    : null;
                  if (spot) setHighlight({ ...spot, at: Date.now() });
                }}
              >
                {item.title}
              </Button>
            ))}
            {!headings.length ? <p className="sf-ide-hint">{t('这个文件没有章节')}</p> : null}
          </SideSection>
        ) : null}
      </>
    ),
    search: (
      <CodeSearch
        key={manuscript?.id ?? '*'}
        projectId={project.id}
        backend={backend}
        folder={manuscript?.folder || undefined}
        active={viewActive && side === 'search'}
        onOpen={(hit) => {
          onOpen(hit.path);
          const session = getFileSession(backend, project.id, hit.path);
          void session
            .load()
            .then(() =>
              session.requestEditorCommand({ type: 'reveal', from: hit.from, to: hit.to }),
            );
        }}
      />
    ),
    refs: (
      <div className="sf-writing-refs">
        {refs.missing.length ? (
          <SideSection title={t('缺失')} count={refs.missing.length}>
            {refs.missing.map(([entry, at]) => (
              <Button
                key={entry}
                variant="ghost"
                className="sf-ref-row is-missing"
                onClick={() => void reveal(at.path, at.line)}
              >
                <AlertTriangle size={13} />
                <span>{entry}</span>
              </Button>
            ))}
          </SideSection>
        ) : null}
        <SideSection title={t('已引用')} count={refs.used.length}>
          {refs.used.map(([entry, at]) => (
            <Button
              key={entry}
              variant="ghost"
              className="sf-ref-row"
              onClick={() => void reveal(at.path, at.line)}
            >
              <Quote size={13} />
              <span>{entry}</span>
            </Button>
          ))}
          {!refs.used.length && !refs.missing.length ? (
            <p className="sf-ide-hint">{t('还没有引用')}</p>
          ) : null}
        </SideSection>
        {refs.unused.length ? (
          <SideSection title={t('未使用')} count={refs.unused.length} defaultOpen={false}>
            {refs.unused.map((entry) => (
              <div key={entry} className="sf-ref-row is-unused">
                <Quote size={13} />
                <span>{entry}</span>
              </div>
            ))}
          </SideSection>
        ) : null}
      </div>
    ),
    review: <p className="sf-ide-empty">{t('待开发')}</p>,
    history: <p className="sf-ide-empty">{t('待开发')}</p>,
  };
  const sidebar = (
    <div className="sf-ide-side">
      <div className="sf-ide-views" role="tablist" aria-label={t('侧边视图')}>
        {SIDES.filter((item) => manuscript || item.id === 'files' || item.id === 'search').map(
          ({ id, label, icon: Icon }) => (
            <Button
              key={id}
              variant="ghost"
              iconOnly
              role="tab"
              aria-selected={side === id}
              aria-label={t(label)}
              tooltip={t(label)}
              onClick={() => setSide(id)}
            >
              <Icon size={16} />
              {id === 'refs' && refs.missing.length ? (
                <span className="sf-code-badge">{refs.missing.length}</span>
              ) : null}
            </Button>
          ),
        )}
      </div>
      <div className="sf-ide-view-title">{t(SIDES.find((item) => item.id === side)!.label)}</div>
      {sideBody[side]}
    </div>
  );

  // ---------- Editor, PDF and log ----------
  const editor = (
    <FileWorkspace
      project={project}
      store={store}
      backend={backend}
      workspaceRoot={writingRoot}
      mode="writing"
      view="files"
      scope={manuscript?.id ?? '*'}
      activePath={activePath}
      onActivePathChange={onOpen}
      // The writing folder is not a code folder: chats started here keep theirs.
      onContext={({ workspaceRoot: _, ...context }) => onContext(context)}
      onSaved={onSaved}
      onCursor={(path, line) => (cursor.current = { path, line })}
      editorExtensions={(path) => (/\.tex$/i.test(path) && manuscript ? extensions : [])}
      empty={
        manuscript ? (
          <div className="sf-ide-welcome">
            <h2>{manuscript.name}</h2>
            <div className="sf-ide-welcome-actions">
              <Button
                variant="ghost"
                onClick={() => onOpen(join(manuscript.folder, manuscript.main))}
              >
                <FileText size={15} />
                {t('打开主文档')}
              </Button>
              <Button variant="ghost" onClick={() => void compile()}>
                <RefreshCw size={15} />
                {t('重新编译')}
              </Button>
            </div>
          </div>
        ) : undefined
      }
    />
  );
  const groups = [
    ['error', '错误', errors],
    ['warning', '警告', warnings.filter((entry) => entry.kind === 'warning')],
    ['box', '排版', warnings.filter((entry) => entry.kind === 'box')],
  ] as const;
  const logView = (
    <div className="sf-writing-log">
      <div className="sf-writing-log-head">
        <strong>{t('日志')}</strong>
        <span>
          {build.result
            ? `${t(STATUS[build.result.status])} · ${t('{seconds} 秒', { seconds: (build.result.durationMs / 1000).toFixed(1) })} · ${build.result.engine}`
            : ''}
        </span>
        <span className="spacer" />
        <Button variant="ghost" onClick={() => setPane('pdf')}>
          {t('返回 PDF')}
        </Button>
      </div>
      {groups.map(([kind, title, list]) =>
        list.length ? (
          <section key={kind}>
            <h3 className="sf-writing-log-group" data-kind={kind}>
              {t(title)} <span>{list.length}</span>
            </h3>
            {list.map((entry, at) => (
              <button
                key={at}
                type="button"
                className="sf-writing-log-item"
                data-kind={entry.kind}
                disabled={!entry.file}
                onClick={() =>
                  entry.file &&
                  manuscript &&
                  void reveal(join(manuscript.folder, entry.file), entry.line ?? 1)
                }
              >
                <span className="sf-writing-log-line">
                  {entry.kind === 'error' ? <CircleX size={14} /> : <AlertTriangle size={14} />}
                  <strong>{entry.message}</strong>
                  {entry.file ? (
                    <small>{`${entry.file}${entry.line ? `:${entry.line}` : ''}`}</small>
                  ) : null}
                </span>
                {entry.detail ? <pre>{entry.detail}</pre> : null}
                {hint(entry.message) ? (
                  <span className="sf-writing-hint">{hint(entry.message)}</span>
                ) : null}
              </button>
            ))}
          </section>
        ) : null,
      )}
      {build.result && !build.entries.length ? (
        <p className="sf-ide-empty">{t('没有错误和警告')}</p>
      ) : null}
      {build.result ? (
        <details className="sf-writing-raw">
          <summary>{t('原始日志')}</summary>
          <pre>{build.result.log || build.result.output}</pre>
        </details>
      ) : null}
      <Button
        variant="ghost"
        className="sf-writing-clean"
        disabled={build.running}
        onClick={() => void compile(true)}
      >
        <RefreshCw size={13} />
        {t('清除缓存后重新编译')}
      </Button>
    </div>
  );
  const pdfPane = !manuscript ? null : pane === 'log' ? (
    logView
  ) : noTex && !build.pdf ? (
    <div className="sf-writing-setup">
      <h2>{t('没有找到内置引擎')}</h2>
      <p>{t('请重新安装 Scientify，或者安装 TeX Live、MiKTeX。')}</p>
    </div>
  ) : build.pdf ? (
    <PdfPreview data={build.pdf} highlight={highlight} onLocate={syncBackward} />
  ) : (
    <div className="sf-writing-setup">
      {build.running ? (
        <p>
          <LoaderCircle size={14} className="sf-ai-spinner" /> {t('正在编译…')}
        </p>
      ) : (
        <Button variant="primary" onClick={() => void compile()}>
          <RefreshCw size={14} />
          {t('重新编译')}
        </Button>
      )}
    </div>
  );
  const split = useRef<HTMLDivElement>(null);
  const body = !manuscript ? (
    editor
  ) : (
    <div className="sf-writing-split" ref={split} data-layout={layout}>
      {layout !== 'pdf' ? (
        <div
          className="sf-writing-editor"
          style={layout === 'split' ? { flexBasis: `${ratio * 100}%` } : undefined}
        >
          {editor}
        </div>
      ) : null}
      {layout === 'split' ? (
        <div
          className="sf-writing-divider"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={(event) => {
            const host = split.current;
            if (!host || (event.target as Element).closest('button')) return;
            const move = (next: PointerEvent) => {
              const rect = host.getBoundingClientRect();
              setRatio(Math.max(0.25, Math.min(0.75, (next.clientX - rect.left) / rect.width)));
            };
            const up = () => {
              window.removeEventListener('pointermove', move);
              window.removeEventListener('pointerup', up);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
          }}
        >
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('在 PDF 中定位')}
            tooltip={t('在 PDF 中定位')}
            onClick={syncForward}
          >
            <ChevronRight size={14} />
          </Button>
        </div>
      ) : null}
      {layout !== 'source' ? <div className="sf-writing-pdf">{pdfPane}</div> : null}
      {notice ? (
        <div className="sf-writing-notice" role="status">
          <AlertTriangle size={15} />
          <span>
            {notice.kind === 'switched'
              ? t('本机 TeX 缺少 {files}，已改用内置引擎编译', { files: fileList(notice.files) })
              : notice.kind === 'missing'
                ? t('本机 TeX 缺少 {files}', { files: fileList(notice.files) })
                : notice.files.length
                  ? t('{files} 需要联网下载', { files: fileList(notice.files) })
                  : t('缺少的宏包需要联网下载')}
          </span>
          {notice.kind === 'switched' ? (
            <Button
              disabled={readOnly}
              onClick={() => {
                setNotice(null);
                void saveManuscript(store, project.id, { ...manuscript, engine: 'builtin' }).catch(
                  (reason) => setError(errorMessage(reason)),
                );
              }}
            >
              {t('以后都用内置引擎')}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={build.running}
              onClick={() => {
                setNotice(null);
                void compile(false, notice.kind === 'missing' ? 'builtin' : undefined);
              }}
            >
              <Download size={13} />
              {t(notice.kind === 'missing' ? '用内置引擎下载并编译' : '重新下载')}
            </Button>
          )}
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('关闭提示')}
            onClick={() => setNotice(null)}
          >
            <X size={13} />
          </Button>
        </div>
      ) : null}
    </div>
  );

  // ---------- Toolbar and status bar ----------
  const toolbar = (
    <div className="sf-ide-toolbar">
      <Button
        variant="ghost"
        className="sf-ide-widget is-folder"
        aria-label={t('稿件：{name}', { name: manuscript?.name ?? t('项目文件') })}
        aria-haspopup="menu"
        onClick={(event) => setMenu({ kind: 'manuscript', anchor: below(event) })}
      >
        <PenLine size={14} />
        <span>{manuscript?.name ?? t('项目文件')}</span>
        <ChevronDown size={12} className="sf-ide-widget-caret" />
      </Button>
    </div>
  );
  const actions =
    manuscript && target ? (
      <div className="sf-writing-actions">
        <span className="sf-writing-compile">
          <Button
            variant="primary"
            className="sf-writing-compile-main"
            title={build.running ? t('停止编译') : t('重新编译 (Ctrl+Enter)')}
            onClick={() =>
              build.running ? void writingApi.cancel(project.id, target) : void compile()
            }
          >
            {build.running ? (
              <LoaderCircle size={13} className="sf-ai-spinner" />
            ) : (
              <RefreshCw size={13} />
            )}
            {build.running ? t('正在编译…') : t('重新编译')}
          </Button>
          <Button
            variant="primary"
            iconOnly
            className="sf-writing-compile-more"
            aria-label={t('编译选项')}
            aria-haspopup="menu"
            onClick={(event) => setMenu({ kind: 'compile', anchor: below(event) })}
          >
            <ChevronDown size={13} />
          </Button>
        </span>
        <Button
          variant="ghost"
          className="sf-writing-log-button"
          aria-label={t('日志和输出文件')}
          aria-pressed={pane === 'log'}
          onClick={() => {
            setPane(pane === 'log' ? 'pdf' : 'log');
            autoLog.current = false;
            if (layout === 'source') setLayout('split');
          }}
        >
          <List size={15} />
          {errors.length ? <span className="is-error">{errors.length}</span> : null}
          {warnings.length ? <span className="is-warning">{warnings.length}</span> : null}
        </Button>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('下载 PDF')}
          tooltip={t('下载 PDF')}
          disabled={!build.pdf}
          onClick={() =>
            void writingApi
              .exportPdf(project.id, target)
              .catch((reason) => setError(errorMessage(reason)))
          }
        >
          <Download size={15} />
        </Button>
        <span className="sf-writing-layout" role="group" aria-label={t('布局')}>
          {(
            [
              ['source', Code2, '只看源码'],
              ['split', Columns2, '源码和 PDF'],
              ['pdf', FileText, '只看 PDF'],
            ] as const
          ).map(([id, Icon, label]) => (
            <Button
              key={id}
              variant="ghost"
              iconOnly
              aria-label={t(label)}
              tooltip={t(label)}
              aria-pressed={layout === id}
              onClick={() => setLayout(id)}
            >
              <Icon size={14} />
            </Button>
          ))}
        </span>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('更多操作')}
          aria-haspopup="menu"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({
              kind: 'more',
              anchor: { x: rect.right - 200, y: rect.bottom + 4, trigger: event.currentTarget },
            });
          }}
        >
          <MoreHorizontal size={15} />
        </Button>
      </div>
    ) : undefined;
  const status = manuscript ? (
    <footer className="sf-ide-status" aria-label={t('状态栏')}>
      <Button variant="ghost" className="sf-ide-status-item" onClick={() => setDialog('settings')}>
        <Settings2 size={12} />
        {`${compilerLabel(manuscript.compiler)}${engine ? ` · ${engine}` : ''}`}
      </Button>
      <span className="sf-ide-status-item">{manuscript.main}</span>
      {manuscript.autoCompile ? (
        <span className="sf-ide-status-item">{t('保存时编译')}</span>
      ) : null}
      {build.result ? (
        <Button variant="ghost" className="sf-ide-status-item" onClick={() => setPane('log')}>
          {build.result.status === 'success' ? <Check size={12} /> : <CircleX size={12} />}
          {build.result.status === 'success'
            ? t('编译成功 · {seconds} 秒', {
                seconds: (build.result.durationMs / 1000).toFixed(1),
              })
            : build.result.status === 'cancelled'
              ? t('已停止编译')
              : t('编译失败 · {count} 个错误', { count: errors.length })}
        </Button>
      ) : null}
      <span className="spacer" />
      <Button variant="ghost" className="sf-ide-status-item" onClick={() => setDialog('words')}>
        {t('{count} 词', { count: words.toLocaleString() })}
      </Button>
    </footer>
  ) : undefined;
  const shownError = error || build.error;
  const check = (on: boolean) => (
    <span className="sf-ide-menu-check">{on ? <Check size={13} /> : null}</span>
  );

  return (
    <WorkspaceFrame
      label="写作"
      views={[]}
      view="files"
      onView={() => {}}
      sidebar={slot ? undefined : sidebar}
      sidebarOpen={!slot}
      onSidebarToggle={() => {}}
      width={240}
      activity={toolbar}
      actions={actions}
      footer={status}
    >
      {slot && viewActive ? createPortal(sidebar, slot) : null}
      {shownError ? (
        <div role="alert" className="sf-experiment-error">
          {translateError(shownError)}
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('关闭提示')}
            onClick={() => {
              setError('');
              if (manuscript) setBuild(key, { ...build, error: undefined });
            }}
          >
            <X size={13} />
          </Button>
        </div>
      ) : null}
      {!manuscript && !manuscripts.length ? (
        <div className="sf-writing-start">
          <div className="sf-ide-welcome">
            <h2>{t('还没有稿件')}</h2>
            <div className="sf-ide-welcome-actions">
              <Button variant="ghost" disabled={readOnly} onClick={() => setDialog('new')}>
                <Plus size={15} />
                {t('新建稿件…')}
              </Button>
              <Button
                variant="ghost"
                disabled={readOnly || importing}
                onClick={() => void importZip()}
              >
                <FileArchive size={15} />
                {t('导入 zip…')}
              </Button>
              <Button variant="ghost" disabled={readOnly} onClick={() => setDialog('overleaf')}>
                <Leaf size={15} />
                {t('从 Overleaf 导入…')}
              </Button>
              <Button variant="ghost" disabled={readOnly} onClick={() => setDialog('add')}>
                <FolderOpen size={15} />
                {t('使用项目里的 LaTeX 文件夹…')}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        body
      )}
      <Menu
        anchor={menu?.kind === 'manuscript' ? menu.anchor : null}
        label={t('稿件')}
        onClose={() => setMenu(null)}
      >
        {manuscripts.map((item) => (
          <Button
            key={item.id}
            variant="ghost"
            role="menuitemradio"
            aria-checked={item.id === manuscript?.id}
            onClick={() => choose(item.id)}
          >
            {check(item.id === manuscript?.id)}
            {item.name}
          </Button>
        ))}
        <Button
          variant="ghost"
          role="menuitemradio"
          aria-checked={!manuscript}
          onClick={() => choose('*')}
        >
          {check(!manuscript)}
          {t('项目文件')}
        </Button>
        <div role="separator" className="sf-menu-separator" />
        <Button
          variant="ghost"
          role="menuitem"
          disabled={readOnly}
          onClick={() => setDialog('new')}
        >
          <Plus size={14} />
          {t('新建稿件…')}
        </Button>
        <Button
          variant="ghost"
          role="menuitem"
          disabled={readOnly || importing}
          onClick={() => void importZip()}
        >
          <FileArchive size={14} />
          {t('导入 zip…')}
        </Button>
        <Button
          variant="ghost"
          role="menuitem"
          disabled={readOnly}
          onClick={() => setDialog('overleaf')}
        >
          <Leaf size={14} />
          {t('从 Overleaf 导入…')}
        </Button>
        <Button
          variant="ghost"
          role="menuitem"
          disabled={readOnly}
          onClick={() => setDialog('add')}
        >
          <FolderOpen size={14} />
          {t('使用项目里的 LaTeX 文件夹…')}
        </Button>
        {manuscript ? (
          <>
            <div role="separator" className="sf-menu-separator" />
            <Button variant="ghost" role="menuitem" onClick={() => setDialog('settings')}>
              <Settings2 size={14} />
              {t('编译设置…')}
            </Button>
            <Button
              variant="ghost"
              role="menuitem"
              disabled={readOnly}
              onClick={async () => {
                if (
                  !(await confirmAction(
                    t('从写作中移除“{name}”？文件夹和文件都会保留。', { name: manuscript.name }),
                  ))
                )
                  return;
                await removeManuscript(store, project.id, manuscript.id).catch((reason) =>
                  setError(errorMessage(reason)),
                );
                choose('');
              }}
            >
              {t('从写作中移除')}
            </Button>
          </>
        ) : null}
      </Menu>
      <Menu
        anchor={menu?.kind === 'compile' ? menu.anchor : null}
        label={t('编译选项')}
        onClose={() => setMenu(null)}
      >
        {manuscript && target ? (
          <>
            <Button
              variant="ghost"
              role="menuitemcheckbox"
              aria-checked={manuscript.autoCompile}
              disabled={readOnly}
              onClick={() =>
                void saveManuscript(store, project.id, {
                  ...manuscript,
                  autoCompile: !manuscript.autoCompile,
                }).catch((reason) => setError(errorMessage(reason)))
              }
            >
              {check(manuscript.autoCompile)}
              {t('保存时自动编译')}
            </Button>
            <Button
              variant="ghost"
              role="menuitemcheckbox"
              aria-checked={draft}
              onClick={() => setDraft(!draft)}
            >
              {check(draft)}
              {t('草稿模式（不渲染图片，更快）')}
            </Button>
            <Button
              variant="ghost"
              role="menuitemcheckbox"
              aria-checked={stopOnError}
              onClick={() => setStopOnError(!stopOnError)}
            >
              {check(stopOnError)}
              {t('遇到第一个错误就停止')}
            </Button>
            <div role="separator" className="sf-menu-separator" />
            {build.running ? (
              <Button
                variant="ghost"
                role="menuitem"
                onClick={() => void writingApi.cancel(project.id, target)}
              >
                <Square size={13} />
                {t('停止编译')}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              role="menuitem"
              disabled={build.running}
              onClick={() => void compile(true)}
            >
              <RefreshCw size={13} />
              {t('清除缓存后重新编译')}
            </Button>
            <Button variant="ghost" role="menuitem" onClick={() => setDialog('settings')}>
              <Settings2 size={13} />
              {t('编译设置…')}
            </Button>
          </>
        ) : null}
      </Menu>
      <Menu
        anchor={menu?.kind === 'more' ? menu.anchor : null}
        label={t('更多操作')}
        onClose={() => setMenu(null)}
      >
        <Button variant="ghost" role="menuitem" onClick={() => setDialog('words')}>
          <List size={14} />
          {t('字数统计')}
        </Button>
        {manuscript ? (
          <Button variant="ghost" role="menuitem" onClick={() => setDialog('export')}>
            <PackageOpen size={14} />
            {t('导出源码包…')}
          </Button>
        ) : null}
        <Button variant="ghost" role="menuitem" onClick={() => setDialog('settings')}>
          <Settings2 size={14} />
          {t('编译设置…')}
        </Button>
        {manuscript && backend.reveal ? (
          <Button
            variant="ghost"
            role="menuitem"
            onClick={() =>
              void backend.reveal!(project.id, join(manuscript.folder, manuscript.main)).catch(
                (reason) => setError(errorMessage(reason)),
              )
            }
          >
            <FolderOpen size={14} />
            {t('在文件管理器中显示')}
          </Button>
        ) : null}
      </Menu>
      {dialog === 'new' ? (
        <NewManuscript
          onClose={() => setDialog(null)}
          onCreate={async (name, template) => {
            const listed = await backend.listFiles(project.id);
            const taken = new Set(
              listed
                .filter((file) => !file.path.includes('/'))
                .map((file) => file.path.toLowerCase()),
            );
            const next = await createManuscript(backend, project, name, template, taken);
            await saveManuscript(store, project.id, next);
            window.dispatchEvent(
              new CustomEvent('scientify-project-files-changed', { detail: project.id }),
            );
            choose(next.id);
            setDialog(null);
            onOpen(join(next.folder, next.main));
          }}
        />
      ) : null}
      {dialog === 'add' ? (
        <AddFolder
          backend={backend}
          project={project}
          taken={manuscripts}
          onClose={() => setDialog(null)}
          onAdd={async (next) => {
            await saveManuscript(store, project.id, next);
            choose(next.id);
            setDialog(null);
            onOpen(join(next.folder, next.main));
          }}
        />
      ) : null}
      {dialog === 'settings' && manuscript ? (
        <Settings
          manuscript={manuscript}
          texFiles={texPaths.map(relative)}
          tex={tex}
          readOnly={readOnly}
          onClose={() => setDialog(null)}
          onSave={async (next) => {
            await saveManuscript(store, project.id, next);
            setDialog(null);
          }}
        />
      ) : null}
      {dialog === 'overleaf' ? (
        <OverleafImport
          onClose={() => setDialog(null)}
          onZip={() => void importZip()}
          onClone={async (url, name, token) => {
            if (!writingApi.available()) throw new Error(t('导入需要桌面应用。'));
            await adopt(await writingApi.clone(project.id, url, name, token), name);
          }}
        />
      ) : null}
      {dialog === 'export' && manuscript && target ? (
        <ExportSource
          main={manuscript.main}
          paths={files.paths.map(relative)}
          texts={new Map([...files.texts].map(([path, text]) => [relative(path), text] as const))}
          onClose={() => setDialog(null)}
          onExport={async (chosen, bbl) => {
            if (!writingApi.available()) throw new Error(t('导出需要桌面应用。'));
            if (await writingApi.exportSource(project.id, target, chosen, bbl)) setDialog(null);
          }}
        />
      ) : null}
      {dialog === 'words' ? (
        <Modal title={t('字数统计')} onClose={() => setDialog(null)}>
          <table className="sf-writing-words">
            <tbody>
              <tr>
                <td>{t('正文')}</td>
                <td>{words.toLocaleString()}</td>
              </tr>
              <tr>
                <td>{t('tex 文件')}</td>
                <td>{texPaths.length}</td>
              </tr>
            </tbody>
          </table>
        </Modal>
      ) : null}
    </WorkspaceFrame>
  );
}

function NewManuscript({
  onClose,
  onCreate,
}: {
  onClose(): void;
  onCreate(name: string, template: Template): Promise<void>;
}) {
  const [name, setName] = useState('');
  const [template, setTemplate] = useState(TEMPLATES[1]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title={t('新建稿件')} onClose={onClose} busy={busy} dirty={!!name}>
      <form
        className="sf-experiment-config-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          setError('');
          try {
            await onCreate(name.trim(), template);
          } catch (reason) {
            setError(errorMessage(reason));
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <label>
            {t('名称')}
            <Input
              autoFocus
              required
              value={name}
              placeholder="NeurIPS 2026"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="sf-writing-templates" role="radiogroup" aria-label={t('模板')}>
            {TEMPLATES.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={item.id === template.id}
                className="sf-writing-template"
                onClick={() => setTemplate(item)}
              >
                <span className="sf-writing-template-page" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <strong>{t(item.label)}</strong>
                <small>{t(item.description)}</small>
              </button>
            ))}
          </div>
        </fieldset>
        {error ? <p role="alert">{translateError(error)}</p> : null}
        <footer>
          <span className="spacer" />
          <Button type="button" disabled={busy} onClick={onClose}>
            {t('取消')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {t(busy ? '正在创建…' : '创建')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}

/** Picks a main .tex file already in the project; its folder becomes the manuscript. */
function AddFolder({
  backend,
  project,
  taken,
  onClose,
  onAdd,
}: {
  backend: ResearchBackend;
  project: Project;
  taken: Manuscript[];
  onClose(): void;
  onAdd(manuscript: Manuscript): Promise<void>;
}) {
  const [mains, setMains] = useState<{ path: string; compiler: Compiler }[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void (async () => {
      const tex = (await backend.listFiles(project.id)).filter(
        (file) => file.kind === 'file' && /\.tex$/i.test(file.path),
      );
      const found: { path: string; compiler: Compiler }[] = [];
      for (const file of tex.slice(0, 400)) {
        const text = await backend
          .readFile(project.id, file.path)
          .then((item) => item.content)
          .catch(() => '');
        if (isMainDocument(text)) found.push({ path: file.path, compiler: detectCompiler(text) });
      }
      if (alive) setMains(found);
    })().catch((reason) => {
      if (alive) setError(errorMessage(reason));
    });
    return () => {
      alive = false;
    };
  }, [backend, project.id]);
  return (
    <Modal title={t('使用项目里的 LaTeX 文件夹')} onClose={onClose}>
      <div className="sf-writing-pick">
        {error ? <p role="alert">{translateError(error)}</p> : null}
        {mains === null ? <p>{t('正在查找主文档…')}</p> : null}
        {mains?.length === 0 ? (
          <p>{t('项目里没有找到包含 \\documentclass 的 .tex 文件。')}</p>
        ) : null}
        {mains?.map(({ path, compiler }) => {
          const folder = path.split('/').slice(0, -1).join('/');
          const used = taken.some((item) => item.folder === folder);
          return (
            <Button
              key={path}
              variant="ghost"
              disabled={used}
              onClick={() =>
                void onAdd({
                  id: crypto.randomUUID(),
                  name: folder.split('/').at(-1) || project.name,
                  folder,
                  main: path.split('/').at(-1)!,
                  compiler,
                  engine: 'auto',
                  autoCompile: true,
                  writePdf: false,
                }).catch((reason) => setError(errorMessage(reason)))
              }
            >
              <FileText size={14} />
              <span>{path}</span>
              {used ? <small>{t('已在写作中')}</small> : null}
            </Button>
          );
        })}
      </div>
    </Modal>
  );
}

function Settings({
  manuscript,
  texFiles,
  tex,
  readOnly,
  onClose,
  onSave,
}: {
  manuscript: Manuscript;
  texFiles: string[];
  tex: TexStatus | null;
  readOnly: boolean;
  onClose(): void;
  onSave(next: Manuscript): Promise<void>;
}) {
  const [next, setNext] = useState(manuscript);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = JSON.stringify(next) !== JSON.stringify(manuscript);
  return (
    <Modal title={t('编译设置')} onClose={onClose} busy={busy} dirty={dirty}>
      <form
        className="sf-experiment-config-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await onSave({ ...next, name: next.name.trim() || manuscript.name });
          } catch (reason) {
            setError(errorMessage(reason));
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy || readOnly}>
          <label>
            {t('名称')}
            <Input
              value={next.name}
              onChange={(event) => setNext({ ...next, name: event.target.value })}
            />
          </label>
          <label>
            {t('编译器')}
            <Dropdown
              value={next.compiler}
              onChange={(event) => setNext({ ...next, compiler: event.target.value as Compiler })}
            >
              {(['pdflatex', 'xelatex', 'lualatex'] as Compiler[]).map((value) => (
                <option key={value} value={value}>
                  {compilerLabel(value)}
                </option>
              ))}
            </Dropdown>
          </label>
          <label>
            {t('TeX 环境')}
            <Dropdown
              value={next.engine}
              onChange={(event) => setNext({ ...next, engine: event.target.value as Engine })}
            >
              <option value="auto">{t('自动（有本机 TeX 时用本机）')}</option>
              <option value="builtin">
                {t('内置引擎 Tectonic {version}（XeTeX）', { version: tex?.builtin ?? '' })}
              </option>
              <option value="local">
                {tex?.local
                  ? t('本机 {name}', { name: tex.local.distribution })
                  : t('本机 TeX（没有找到）')}
              </option>
            </Dropdown>
          </label>
          <label>
            {t('主文档')}
            <Dropdown
              value={next.main}
              onChange={(event) => setNext({ ...next, main: event.target.value })}
            >
              {[...new Set([next.main, ...texFiles])].map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </Dropdown>
          </label>
          <label className="sf-writing-check">
            <input
              type="checkbox"
              checked={next.autoCompile}
              onChange={(event) => setNext({ ...next, autoCompile: event.target.checked })}
            />
            {t('保存时自动编译')}
          </label>
          <label className="sf-writing-check">
            <input
              type="checkbox"
              checked={next.writePdf}
              onChange={(event) => setNext({ ...next, writePdf: event.target.checked })}
            />
            {t('把 PDF 写回稿件文件夹')}
          </label>
        </fieldset>
        {error ? <p role="alert">{translateError(error)}</p> : null}
        <footer>
          <span className="spacer" />
          <Button type="button" disabled={busy} onClick={onClose}>
            {t('取消')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || readOnly || !dirty}>
            {t('保存')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}

/** Overleaf projects come in as their downloaded source zip, or by Git for paid accounts. */
function OverleafImport({
  onClose,
  onZip,
  onClone,
}: {
  onClose(): void;
  onZip(): void;
  onClone(url: string, name: string, token: string): Promise<void>;
}) {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title={t('从 Overleaf 导入')} onClose={onClose} busy={busy} dirty={!!(url || token)}>
      <form
        className="sf-experiment-config-form sf-writing-import"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!url.trim() || !name.trim()) return;
          setBusy(true);
          setError('');
          try {
            await onClone(url.trim(), name.trim(), token.trim());
          } catch (reason) {
            setError(errorMessage(reason));
            setBusy(false);
          }
        }}
      >
        <section>
          <h3>{t('下载的源码包')}</h3>
          <Button type="button" disabled={busy} onClick={onZip}>
            <FileArchive size={14} />
            {t('选择 zip…')}
          </Button>
        </section>
        <section>
          <h3>{t('Git 克隆')}</h3>
          <fieldset disabled={busy}>
            <label>
              {t('Git 地址')}
              <Input
                required
                value={url}
                placeholder="https://git.overleaf.com/…"
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <label>
              {t('Git 令牌')}
              <Input
                type="password"
                autoComplete="off"
                value={token}
                placeholder="olp_…"
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            <label>
              {t('名称')}
              <Input
                required
                value={name}
                placeholder="NeurIPS 2026"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          </fieldset>
        </section>
        {error ? <p role="alert">{translateError(error)}</p> : null}
        <footer>
          <span className="spacer" />
          <Button type="button" disabled={busy} onClick={onClose}>
            {t('取消')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !url.trim() || !name.trim()}>
            {busy ? <LoaderCircle size={14} className="sf-ai-spinner" /> : null}
            {t(busy ? '正在克隆…' : '克隆')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}

/** Picks what goes into a source package: what the main document uses is checked. */
function ExportSource({
  main,
  paths,
  texts,
  onClose,
  onExport,
}: {
  main: string;
  paths: string[];
  texts: Map<string, string>;
  onClose(): void;
  onExport(files: string[], bbl: boolean): Promise<void>;
}) {
  const files = useMemo(() => paths.filter((path) => !isArtifact(path)).sort(), [paths]);
  const used = useMemo(() => dependencies(main, texts, files), [main, texts, files]);
  const [chosen, setChosen] = useState(() => new Set(used));
  // The file list may still be loading when the dialog opens.
  const usedKey = [...used].join('\n');
  useEffect(() => setChosen(new Set(usedKey ? usedKey.split('\n') : [])), [usedKey]);
  const [bbl, setBbl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cites = [...used].some((path) => /\.bib$/i.test(path));
  const row = (path: string) => (
    <label key={path} className="sf-writing-check">
      <input
        type="checkbox"
        checked={chosen.has(path)}
        onChange={(event) => {
          const next = new Set(chosen);
          if (event.target.checked) next.add(path);
          else next.delete(path);
          setChosen(next);
        }}
      />
      <span>{path}</span>
    </label>
  );
  const unused = files.filter((path) => !used.has(path));
  return (
    <Modal title={t('导出源码包')} onClose={onClose} busy={busy}>
      <form
        className="sf-experiment-config-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            await onExport(
              files.filter((path) => chosen.has(path)),
              bbl,
            );
          } catch (reason) {
            setError(errorMessage(reason));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="sf-writing-export">
          <h3>
            {t('用到的文件')} <span>{used.size}</span>
          </h3>
          {files.filter((path) => used.has(path)).map(row)}
          {unused.length ? (
            <details>
              <summary>
                {t('没用到的文件')} <span>{unused.length}</span>
              </summary>
              {unused.map(row)}
            </details>
          ) : null}
        </div>
        {cites ? (
          <label className="sf-writing-check">
            <input
              type="checkbox"
              checked={bbl}
              onChange={(event) => setBbl(event.target.checked)}
            />
            {t('附上编译生成的 .bbl（arXiv 需要）')}
          </label>
        ) : null}
        {error ? <p role="alert">{translateError(error)}</p> : null}
        <footer>
          <span className="sf-writing-count">
            {t('{count} 个文件', { count: chosen.size + (bbl ? 1 : 0) })}
          </span>
          <span className="spacer" />
          <Button type="button" disabled={busy} onClick={onClose}>
            {t('取消')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !chosen.size}>
            {t('导出…')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
