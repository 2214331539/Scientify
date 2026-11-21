import { canEditProject } from '../../platform/collaboration';
import { EmptySteps } from '../../components/EmptyState';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import {
  Blocks,
  ChevronDown,
  ChevronUp,
  FileDiff,
  FilePlus2,
  Files,
  FileText,
  FolderClosed,
  FolderOpen,
  GitBranch,
  GitFork,
  History,
  Maximize2,
  Minimize2,
  FlaskConical,
  Plus,
  Search,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import { Button, Input, Textarea } from '../../components/primitives';
import { Modal } from '../../components/Modal';
import { WorkspaceFrame } from '../../components/workspace/WorkspaceFrame';
import { PanelSash } from '../../components/workspace/PanelSash';
import { useActiveView } from '../../components/workspace/ViewTransition';
import { confirmAction, requestText } from '../../components/prompts';
import type { Project, Experiment } from '../../domain/workspace';
import type { WorkContext } from '../../domain/context';
import type { ResearchBackend } from '../../platform/research';
import type { WorkspaceStore } from '../../stores/workspace';
import { getFileRuntime, getFileSession } from '../../editor/sessions';
import { manuscriptsOf } from '../writing/manuscripts';
import {
  FileResources,
  FileWorkspace,
  type CreateRequest,
  type CustomTab,
} from '../files/FileWorkspace';
import { t, translateError } from '../../i18n';
import { displayPath, operatingSystem } from '../../platform/os';
import { GitWorkspace, type GitView } from './GitWorkspace';
import { CodeSearch, type SearchHit } from './CodeSearch';
import { clearCodeRoot, codeContext, selectExperiment, useCodeWorkspace } from './code-context';
import { ExperimentManager } from './ExperimentManager';
import { experimentCatalog, experimentsFor, registerExperiment, sameCodeRoot } from './catalog';
import { useSidebarSlot } from '../../shell/Sidebar';
import { ExperimentRuns } from './ExperimentRuns';
import { InterpreterPicker } from './InterpreterPicker';
import {
  bindInterpreter,
  developmentApi,
  ensureExecutionTrust,
  openTerminal,
  useDevelopment,
} from './development';
import {
  configurationsOf,
  experimentApi,
  parseArguments,
  startExecution,
  executionStore,
  type Execution,
  type RunConfiguration,
} from './runtime';
import { errorMessage } from '../../domain/errors';
import { useGitActions } from './git-actions';
import { BranchWidget, CloneDialog, FolderWidget, RunWidget } from './Toolbar';
import { DiffView, SourceControl } from './SourceControl';
import { RunPanel } from './RunPanel';
import { StatusBar } from './StatusBar';
import './experiments.css';
import './development.css';
import './workbench.css';
const TerminalPanel = lazy(() =>
  import('./TerminalPanel').then((module) => ({ default: module.TerminalPanel })),
);

/** Editor tabs that are not files. */
const RUNS_TAB = 'scientify:runs';
const PANEL_HEIGHT_KEY = 'scientify.experiments.panelHeight';
const GIT_TAB = 'scientify:git';
const FOLDERS_TAB = 'scientify:folders';
const diffTab = (path: string, staged: boolean) =>
  `scientify:diff:${staged ? 'index' : 'work'}:${path}`;
const isCustomTab = (id?: string | null) => !!id?.startsWith('scientify:');
const baseName = (path: string) =>
  path.replaceAll('\\', '/').replace(/\/+$/, '').split('/').at(-1) || path;

type SideView = 'explorer' | 'search' | 'scm' | 'experiments' | 'extensions';
const sideViews: { id: SideView; label: string; icon: typeof Files; keys?: string }[] = [
  { id: 'explorer', label: '资源管理器', icon: Files, keys: 'Ctrl+Shift+E' },
  { id: 'search', label: '搜索', icon: Search, keys: 'Ctrl+Shift+F' },
  { id: 'scm', label: '源代码管理', icon: GitBranch, keys: 'Ctrl+Shift+G' },
  { id: 'experiments', label: '实验', icon: FlaskConical, keys: 'Ctrl+Shift+D' },
  { id: 'extensions', label: '扩展', icon: Blocks },
];

/**
 * The experiment module as a code workbench (VS Code and PyCharm layout): side views,
 * folder, branch and run widgets, one row of editor tabs, a panel and a status bar.
 */
export function ExperimentWorkspace({
  project,
  store,
  backend,
  executions,
  runtimeError,
  view,
  onView,
  activePath,
  onOpen,
  selectedRunId,
  onSelect,
  onContext,
  sidebarOpen,
  onSidebarToggle,
  width,
  resize,
  onProjectRun,
}: {
  project: Project;
  store: WorkspaceStore;
  backend: ResearchBackend;
  executions: Execution[];
  runtimeError: string;
  view: string;
  onView(view: string): void;
  activePath?: string | null;
  onOpen(path: string | null): void;
  selectedRunId?: string | null;
  onSelect(id: string): void;
  onContext(context: WorkContext): void;
  sidebarOpen: boolean;
  onSidebarToggle(): void;
  width: number;
  resize: ReactNode;
  onProjectRun?: (projectId: string, runId: string) => void;
}) {
  const readOnly = !canEditProject(project, 'code');
  const viewActive = useActiveView();
  const data = useStore(store, (state) => state.data);
  const experimentId = useStore(codeContext, (state) => state.experiments[project.id]);
  const catalog = experimentsFor(data, project.id).filter((item) => !item.archived);
  const experiment = catalog.find((item) => item.id === experimentId) ?? catalog[0];
  // The default experiment is the project folder itself; its manuscripts belong to writing.
  const manuscriptFolders =
    experiment?.source === 'project'
      ? manuscriptsOf(data?.projects.find((item) => item.id === project.id) ?? project)
          .map((item) => item.folder)
          .filter(Boolean)
      : [];
  const code = useCodeWorkspace(project, experiment);
  const git = useGitActions({ projectId: project.id, backend, store, code });
  const development = useDevelopment();
  // In the app the side views live in the shared sidebar.
  const slot = useSidebarSlot();
  const docked = !!slot;
  const [side, setSide] = useState<SideView>('explorer');
  const sideOpen = docked || sidebarOpen;
  function pick(next: Experiment) {
    selectExperiment(project.id, next);
  }
  async function openWorktree(root: string) {
    try {
      const existing = catalog.find((item) => sameCodeRoot(item.root, root));
      if (existing) {
        pick(existing);
        return;
      }
      const main = catalog.find((item) => item.source === 'project');
      if (
        main &&
        sameCodeRoot(
          root,
          project.path || project.repo || `${store.getState().directory}/projects/${project.id}`,
        )
      ) {
        pick(main);
        return;
      }
      pick(await registerExperiment(store, project.id, baseName(root), '', 'existing', root));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }
  async function openFolder() {
    try {
      // The picker starts where the current experiment is, not wherever the app started.
      const directory = await store.getState().chooseDirectory(experiment?.root || undefined);
      if (!directory) return;
      const existing = catalog.find((item) => sameCodeRoot(item.root, directory));
      pick(
        existing ??
          (await registerExperiment(
            store,
            project.id,
            baseName(directory),
            '',
            'existing',
            directory,
          )),
      );
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }
  async function newFolder() {
    const name = (await requestText(t('文件夹名称'), ''))?.trim();
    if (!name) return;
    try {
      pick(await registerExperiment(store, project.id, name, '', 'empty'));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }
  async function cloneRepository(url: string, parent?: string) {
    const name = baseName(url.replace(/^.*:/, '')).replace(/\.git$/, '') || 'repository';
    pick(await registerExperiment(store, project.id, name, '', 'clone', parent, url));
    setDialog(null);
  }
  const root = code.root;
  const currentRoot = useRef(root);
  currentRoot.current = root;
  const [gitView, setGitView] = useState<GitView>('history');
  const [createRequest, setCreateRequest] = useState<CreateRequest>();
  const newFile = () => {
    setSide('explorer');
    setCreateRequest((current) => ({ kind: 'file', id: (current?.id ?? 0) + 1 }));
  };
  // Python is chosen from the status bar, as in VS Code; a new environment is used once ready.
  const [picker, setPicker] = useState(false);
  const preparing = useRef(new Set<string>());
  const [savingAll, setSavingAll] = useState(false);
  const initialRoot = useRef<string | undefined>(undefined);
  if (code.ready && root && !initialRoot.current) initialRoot.current = root;
  const [directoryPaths, setDirectoryPaths] = useState<Record<string, string | null>>({});
  const currentPath = root
    ? Object.hasOwn(directoryPaths, root)
      ? directoryPaths[root]
      : (getFileRuntime(backend).active.get(JSON.stringify([project.id, 'experiments', root])) ??
        (root === initialRoot.current ? activePath : null))
    : activePath;
  /** The open file, if the active tab is one. */
  const filePath = currentPath && !isCustomTab(currentPath) ? currentPath : null;
  function openPath(path: string | null) {
    if (root) setDirectoryPaths((paths) => ({ ...paths, [root]: path }));
    onOpen(path);
  }
  const saved = useStore(
    store,
    (s) => s.data?.experiments?.find((e) => e.id === experiment?.id)?.runConfigurations,
  );
  const configurations = configurationsOf(saved);
  const [selectedConfig, setSelectedConfig] = useState('');
  const config = configurations.find((c) => c.id === selectedConfig) ?? configurations[0];
  const [dialog, setDialog] = useState<'config' | 'tasks' | 'clone' | null>(null);
  const [editConfig, setEditConfig] = useState<RunConfiguration | undefined>();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelMaximized, setPanelMaximized] = useState(false);
  // The panel's height, dragged at its top edge and kept across sessions.
  const [panelHeight, setPanelHeight] = useState(() => {
    try {
      return Number(localStorage.getItem(PANEL_HEIGHT_KEY)) || 225;
    } catch {
      return 225;
    }
  });
  const codeArea = useRef<HTMLDivElement>(null);
  const [panelTab, setPanelTab] = useState<'terminal' | 'runs'>('runs');
  const [logRun, setLogRun] = useState('');
  const [terminalId, setTerminalId] = useState('');
  const ownTerminals = development.terminals.filter((info) => info.experimentId === experiment?.id);
  const ownRuns = executions
    .filter(
      (r) =>
        r.project === project.id &&
        (r.experimentId
          ? r.experimentId === experiment?.id
          : (r.workspaceRoot || r.source?.workspaceRoot || r.directory) === root ||
            (experiment?.source === 'project' && !r.workspaceRoot)),
    )
    .sort((a, b) => b.startedAt - a.startedAt);
  const activeRun = ownRuns.find((r) => r.id === logRun) ?? ownRuns[0];
  const runningRuns = ownRuns.filter((r) => r.status === 'running');
  const handledRun = useRef<string | null>(null);
  useEffect(() => {
    if (selectedRunId && handledRun.current !== selectedRunId) {
      const run = executions.find((r) => r.id === selectedRunId && r.project === project.id);
      const target = catalog.find(
        (e) => e.id === run?.experimentId || (e.root && e.root === run?.workspaceRoot),
      );
      if (target && target.id !== experiment?.id) selectExperiment(project.id, target);
      handledRun.current = selectedRunId;
      setLogRun(selectedRunId);
      setPanelTab('runs');
      setPanelOpen(true);
    }
  }, [selectedRunId, project.id, executions, experiment?.id]);
  // Older locations name a page; the workbench shows each as a tab or a side view.
  useEffect(() => {
    if (view === 'files' || !code.ready) return;
    if (view === 'runs') openPath(RUNS_TAB);
    else if (view === 'versions') showSide('scm');
    onView('files');
  }, [view, code.ready]);
  useEffect(() => {
    for (const task of development.tasks) {
      if (!preparing.current.has(task.id) || task.status === 'running') continue;
      preparing.current.delete(task.id);
      if (task.status === 'completed' && task.environment)
        void bindInterpreter(store, task.experimentId, task.environment).catch((reason) =>
          setError(errorMessage(reason)),
        );
      else if (task.status !== 'completed') setError(task.error || t('创建环境失败。'));
    }
  }, [development.tasks, store]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    // The run records tab names the selected run itself.
    if (!viewActive || !code.ready || !experiment || currentPath === RUNS_TAB) return;
    if (filePath)
      onContext({
        projectId: project.id,
        workspace: 'experiments',
        title: filePath,
        path: filePath,
        workspaceRoot: root,
        experimentId: experiment.id,
        text: getFileSession(backend, project.id, filePath, root).getSnapshot().content,
      });
    else
      onContext({
        projectId: project.id,
        workspace: 'experiments',
        title: experiment.name,
        workspaceRoot: root,
        experimentId: experiment.id,
        text: experiment.purpose,
      });
  }, [
    currentPath,
    filePath,
    project.id,
    backend,
    onContext,
    viewActive,
    root,
    code.ready,
    experiment?.id,
    experiment?.name,
    experiment?.purpose,
  ]);
  async function run(configuration = config) {
    if (!code.ready || !experiment) return;
    if (
      configuration &&
      ['python', 'python3', 'python.exe'].includes(configuration.executable) &&
      !experiment.python &&
      developmentApi.available()
    ) {
      setPicker(true);
      return;
    }
    if (starting || !configuration) {
      if (!configuration) {
        setEditConfig(undefined);
        setDialog('config');
      }
      return;
    }
    setStarting(true);
    setError('');
    try {
      if (developmentApi.available() && !(await ensureExecutionTrust(project.id, experiment.id)))
        return;
      const drafts = [...getFileRuntime(backend).sessions.values()].filter(
        (s) =>
          s.projectId === project.id &&
          (s.workspaceRoot ?? '') === (root ?? '') &&
          s.getSnapshot().dirty,
      );
      if (drafts.length) {
        if (
          !(await confirmAction(
            t('运行前保存此项目的 {count} 个未保存文件？保存失败时不会启动。', {
              count: drafts.length,
            }),
          ))
        )
          return;
        for (const session of drafts)
          if (!(await session.save())) throw new Error(t('文件保存失败，请处理冲突后再运行。'));
      }
      const result = await startExecution(store, project.id, configuration, root);
      if (alive.current) {
        setLogRun(result.id);
        setPanelTab('runs');
        setPanelOpen(true);
        onSelect(result.id);
        if (result.error) setError(result.error);
      }
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    } finally {
      if (alive.current) setStarting(false);
    }
  }
  function editConfiguration(configuration?: RunConfiguration) {
    setEditConfig(configuration);
    setDialog('config');
  }
  function showSide(next: SideView) {
    const same = side === next;
    setSide(next);
    if (!docked && (!sidebarOpen || same)) onSidebarToggle();
  }
  function showPanel(tab: 'terminal' | 'runs') {
    setPanelTab(tab);
    setPanelOpen(true);
  }
  // As in VS Code, opening the terminal tab starts a shell when none is open.
  function openTerminalTab() {
    showPanel('terminal');
    if (!ownTerminals.length && !readOnly && experimentApi.available()) void startTerminal();
  }
  async function startTerminal(pythonFile = false) {
    if (readOnly) return;
    if (!experiment || !code.ready || starting) return;
    if (pythonFile && !experiment.python) {
      setPicker(true);
      return;
    }
    const owner = experiment.id;
    setStarting(true);
    setError('');
    try {
      if (pythonFile) {
        if (!filePath?.endsWith('.py')) return;
        const session = getFileSession(backend, project.id, filePath, root);
        await session.load();
        if (session.getSnapshot().dirty && !(await session.save()))
          throw new Error(t('文件保存失败，请处理冲突后再运行。'));
      }
      const info = await openTerminal(
        project.id,
        owner,
        pythonFile
          ? 'python'
          : operatingSystem() === 'macos'
            ? 'zsh'
            : operatingSystem() === 'windows'
              ? 'powershell'
              : 'bash',
        pythonFile ? filePath! : undefined,
      );
      if (info && alive.current && currentRoot.current === root) {
        setTerminalId(info.id);
        showPanel('terminal');
      }
      if (info) store.getState().setAgentTask(`terminal:${info.id}`, project.id);
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    } finally {
      if (alive.current) setStarting(false);
    }
  }
  async function openMatch(hit: SearchHit) {
    openPath(hit.path);
    const session = getFileSession(backend, project.id, hit.path, root);
    await session.load();
    if (alive.current && currentRoot.current === root && session.getSnapshot().phase === 'ready')
      session.requestEditorCommand({ type: 'reveal', from: hit.from, to: hit.to });
  }
  async function saveAll() {
    if (savingAll || !code.ready) return;
    setSavingAll(true);
    setError('');
    try {
      for (const session of getFileRuntime(backend).sessions.values()) {
        if (
          session.projectId === project.id &&
          (session.workspaceRoot ?? '') === (root ?? '') &&
          session.getSnapshot().dirty &&
          !(await session.save())
        )
          throw new Error(t('文件保存失败，请处理冲突后再运行。'));
      }
      code.refresh();
    } catch (e) {
      if (alive.current && currentRoot.current === root) setError(errorMessage(e));
    } finally {
      if (alive.current) setSavingAll(false);
    }
  }
  function openGraph(next: GitView = 'history') {
    setGitView(next);
    openPath(GIT_TAB);
  }
  async function createBranch() {
    const name = (await requestText(t('新分支名称'), ''))?.trim();
    if (name)
      void git.execute(
        { kind: 'branch-create', name, revision: 'HEAD' },
        { kind: 'branch-switch', name },
      );
  }
  function stopRun() {
    const target = runningRuns.find((r) => r.id === logRun) ?? runningRuns[0];
    if (target)
      void experimentApi.stop(target.id).catch((e) => {
        if (alive.current) setError(errorMessage(e));
      });
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        !viewActive ||
        event.defaultPrevented ||
        event.isComposing ||
        (!event.ctrlKey && !event.metaKey) ||
        document.querySelector('dialog[open]')
      )
        return;
      const key = event.key.toLowerCase();
      const views: Record<string, SideView> = {
        e: 'explorer',
        f: 'search',
        g: 'scm',
        d: 'experiments',
      };
      if (event.key === 'F5') {
        event.preventDefault();
        if (!readOnly && experimentApi.available()) void run();
      } else if ((event.shiftKey && views[key]) || (!event.shiftKey && key === 'p')) {
        event.preventDefault();
        const next = event.shiftKey ? views[key] : 'explorer';
        setSide(next);
        if (!docked && !sidebarOpen) onSidebarToggle();
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLInputElement>(
              next === 'search'
                ? '.sf-code-search input'
                : next === 'explorer'
                  ? '.sf-resource-search input'
                  : '.sf-scm-commit textarea',
            )
            ?.focus(),
        );
      } else if (key === '`') {
        event.preventDefault();
        if (panelOpen && panelTab === 'terminal') setPanelOpen(false);
        else {
          openTerminalTab();
        }
      } else if (event.shiftKey && key === 's') {
        event.preventDefault();
        void saveAll();
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  });
  function customTab(id: string): CustomTab | null {
    if (!isCustomTab(id)) return null;
    if (id === RUNS_TAB)
      return {
        title: t('运行记录'),
        icon: <Table2 size={14} />,
        render: () =>
          experiment ? (
            <ExperimentRuns
              project={project}
              experimentId={experiment.id}
              store={store}
              executions={ownRuns}
              selectedId={selectedRunId}
              onSelect={onSelect}
              onContext={onContext}
              onRerun={(r) => void run(r.configuration)}
            />
          ) : null,
      };
    if (id === GIT_TAB)
      return {
        title: t('Git 图'),
        icon: <History size={14} />,
        render: () => (
          <div className="sf-experiment-git">
            <GitWorkspace
              projectId={project.id}
              backend={backend}
              store={store}
              code={code}
              view={gitView}
              views={['history', 'branches', 'stashes', 'worktrees']}
              onView={setGitView}
              onSelectRoot={(next) => void openWorktree(next)}
              onOpen={openPath}
            />
          </div>
        ),
      };
    if (id === FOLDERS_TAB)
      return {
        title: t('管理文件夹'),
        icon: <FolderClosed size={14} />,
        render: () => (
          <ExperimentManager
            project={project}
            store={store}
            executions={executions}
            onOpen={pick}
          />
        ),
      };
    const diff = /^scientify:diff:(index|work):(.+)$/.exec(id);
    if (diff)
      return {
        title: `${baseName(diff[2])} (${t(diff[1] === 'index' ? '已暂存' : '工作树')})`,
        icon: <FileDiff size={14} />,
        render: () => (
          <DiffView
            key={id}
            projectId={project.id}
            code={code}
            path={diff[2]}
            staged={diff[1] === 'index'}
            onOpenFile={openPath}
          />
        ),
      };
    return {
      title: id.slice('scientify:'.length),
      icon: <FileText size={14} />,
      render: () => <p className="sf-ide-empty">{t('此标签已不可用')}</p>,
    };
  }
  const changes = code.snapshot?.changes.length ?? 0;
  const sideContent = (
    <div className="sf-ide-side">
      <div className="sf-ide-views" role="tablist" aria-label={t('侧边视图')}>
        {sideViews.map(({ id, label, icon: Icon, keys }) => {
          const badge = id === 'scm' ? changes : 0;
          return (
            <Button
              key={id}
              variant="ghost"
              iconOnly
              role="tab"
              aria-selected={side === id}
              aria-label={t(label)}
              tooltip={keys ? `${t(label)} (${keys})` : t(label)}
              onClick={() => showSide(id)}
            >
              <Icon size={16} />
              {badge ? <span className="sf-code-badge">{badge}</span> : null}
            </Button>
          );
        })}
      </div>
      <div className="sf-ide-view-title">
        {t(sideViews.find((item) => item.id === side)!.label)}
      </div>
      {code.ready && experiment ? (
        <>
          <div hidden={side !== 'explorer'} className="sf-code-resource-content">
            <FileResources
              project={project}
              backend={backend}
              mode="experiments"
              view="files"
              label={experiment.name}
              changes={code.snapshot?.changes}
              activePath={filePath}
              onOpen={openPath}
              workspaceRoot={root}
              createRequest={createRequest}
              hide={manuscriptFolders}
            />
          </div>
          <div hidden={side !== 'search'} className="sf-code-resource-content">
            <CodeSearch
              key={JSON.stringify([project.id, root])}
              projectId={project.id}
              root={root}
              backend={backend}
              active={viewActive && sideOpen && side === 'search'}
              onOpen={(hit) => void openMatch(hit)}
            />
          </div>
          <div hidden={side !== 'scm'} className="sf-code-resource-content">
            <SourceControl
              projectId={project.id}
              backend={backend}
              store={store}
              code={code}
              onOpenFile={openPath}
              onOpenDiff={(path, staged) => openPath(diffTab(path, staged))}
              onGraph={() => openGraph()}
            />
          </div>
          <div hidden={side !== 'experiments'} className="sf-code-resource-content">
            <p className="sf-ide-empty">{t('待开发')}</p>
          </div>
          <div hidden={side !== 'extensions'} className="sf-code-resource-content">
            <p className="sf-ide-empty">{t('待开发')}</p>
          </div>
        </>
      ) : (
        <p className="sf-ide-empty" role={code.error ? 'alert' : 'status'}>
          {code.error ? translateError(code.error) : t('正在读取…')}
        </p>
      )}
    </div>
  );
  const welcome = experiment ? (
    <div className="sf-ide-welcome">
      <h2>{experiment.name}</h2>
      <div className="sf-ide-welcome-actions">
        <Button variant="ghost" disabled={readOnly} onClick={newFile}>
          <FilePlus2 size={15} />
          {t('新建文件…')}
        </Button>
        <Button
          variant="ghost"
          disabled={readOnly || !experimentCatalog.available()}
          onClick={() => void openFolder()}
        >
          <FolderOpen size={15} />
          {t('打开文件夹…')}
        </Button>
        <Button
          variant="ghost"
          disabled={readOnly || !experimentCatalog.available()}
          onClick={() => setDialog('clone')}
        >
          <GitFork size={15} />
          {t('克隆 Git 仓库…')}
        </Button>
      </div>
      {catalog.length > 1 ? (
        <section>
          <h3>{t('文件夹')}</h3>
          {catalog.map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              aria-current={item.id === experiment.id || undefined}
              onClick={() => pick(item)}
            >
              <span>{item.name}</span>
              <small>{displayPath(item.root)}</small>
            </Button>
          ))}
        </section>
      ) : null}
    </div>
  ) : null;
  const side_ = docked && viewActive && slot ? createPortal(sideContent, slot) : null;
  const shownError = error || git.error || runtimeError || development.error;
  return (
    <WorkspaceFrame
      label={experiment?.name ?? t('Experiments')}
      views={[]}
      view={view}
      onView={onView}
      sidebar={docked ? undefined : sideContent}
      sidebarOpen={sidebarOpen}
      onSidebarToggle={onSidebarToggle}
      width={width}
      resize={resize}
      activity={
        <div className="sf-ide-toolbar">
          <FolderWidget
            folders={catalog}
            current={experiment}
            readOnly={readOnly || !experimentCatalog.available()}
            onSwitch={pick}
            onOpenFolder={() => void openFolder()}
            onClone={() => setDialog('clone')}
            onNewFolder={() => void newFolder()}
            onManage={() => openPath(FOLDERS_TAB)}
          />
          <BranchWidget
            snapshot={code.snapshot}
            readOnly={readOnly || git.blocked}
            onInit={() => void git.execute({ kind: 'init' })}
            onCheckout={(name) => void git.execute({ kind: 'branch-switch', name })}
            onCreate={() => void createBranch()}
            onWorktree={() => openGraph('worktrees')}
            onGraph={() => openGraph()}
            onOpenRoot={(next) => void openWorktree(next)}
          />
        </div>
      }
      actions={
        experiment ? (
          <RunWidget
            configurations={configurations}
            current={config}
            currentFile={filePath}
            disabled={readOnly || !code.ready}
            starting={starting}
            running={runningRuns.length > 0}
            unavailable={!experimentApi.available()}
            onSelect={setSelectedConfig}
            onRun={() => void run()}
            onRunFile={() => void startTerminal(true)}
            onStop={stopRun}
            onEdit={() => editConfiguration(config)}
            onNew={() => editConfiguration(undefined)}
            onTerminal={() => void startTerminal()}
            onSaveAll={() => void saveAll()}
            onTasks={() => setDialog('tasks')}
            onGraph={() => openGraph()}
          />
        ) : undefined
      }
      footer={
        experiment ? (
          <StatusBar
            snapshot={code.snapshot}
            running={runningRuns.length}
            path={filePath}
            interpreter={experiment.python}
            preparing={development.tasks.some(
              (task) => task.experimentId === experiment.id && task.status === 'running',
            )}
            onBranch={() => showSide('scm')}
            onRuns={() => showPanel('runs')}
            onInterpreter={readOnly ? undefined : () => setPicker(true)}
          />
        ) : undefined
      }
    >
      {side_}
      {shownError && (
        <div role="alert" className="sf-experiment-error">
          {translateError(shownError)}
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('关闭提示')}
            onClick={() => {
              setError('');
              git.setError('');
              executionStore.setState({ error: '' });
            }}
          >
            <X size={13} />
          </Button>
        </div>
      )}
      {experiment ? (
        <div className="sf-experiment-code" ref={codeArea}>
          <div className="sf-experiment-editor" hidden={panelOpen && panelMaximized}>
            {code.ready ? (
              <FileWorkspace
                project={project}
                store={store}
                backend={backend}
                mode="experiments"
                view="files"
                activePath={currentPath}
                onActivePathChange={openPath}
                workspaceRoot={root}
                customTab={customTab}
                empty={welcome}
                onContext={(context) => onContext({ ...context, experimentId: experiment.id })}
              />
            ) : (
              <div className="sf-git-empty" role={code.error ? 'alert' : 'status'}>
                {code.error ? (
                  <>
                    <span>{translateError(code.error)}</span>
                    <Button onClick={() => clearCodeRoot(project.id)}>{t('打开项目原目录')}</Button>
                  </>
                ) : (
                  t('正在读取…')
                )}
              </div>
            )}
          </div>
          <div
            className={
              'sf-experiment-bottom ' +
              (!panelOpen ? 'is-collapsed' : '') +
              (panelOpen && panelMaximized ? ' is-maximized' : '')
            }
            style={panelOpen && !panelMaximized ? { height: panelHeight } : undefined}
          >
            <PanelSash
              label={t('调整面板高度')}
              height={panelHeight}
              open={panelOpen && !panelMaximized}
              max={() => codeArea.current?.clientHeight ?? 600}
              onResize={(height) => {
                setPanelMaximized(false);
                setPanelHeight(height);
              }}
              onOpen={setPanelOpen}
              onEnd={(height) => {
                try {
                  localStorage.setItem(PANEL_HEIGHT_KEY, String(height));
                } catch {
                  /* The height is only a preference. */
                }
              }}
            />
            <header>
              <div role="tablist" aria-label={t('面板')} className="sf-ide-panel-tabs">
                {(['terminal', 'runs'] as const).map((value) => (
                  <Button
                    key={value}
                    variant="ghost"
                    role="tab"
                    aria-selected={panelOpen && panelTab === value}
                    onClick={() => (value === 'terminal' ? openTerminalTab() : showPanel(value))}
                  >
                    {t(value === 'terminal' ? '终端' : '运行')}
                  </Button>
                ))}
              </div>
              <span className="spacer" />
              {panelTab === 'terminal' ? (
                <Button
                  variant="ghost"
                  iconOnly
                  tooltip={t('新建终端')}
                  aria-label={t('新建终端')}
                  disabled={readOnly || starting || !code.ready || !experimentApi.available()}
                  onClick={() => void startTerminal()}
                >
                  <Plus size={14} />
                </Button>
              ) : (
                // Results, artifacts and rerun live in the records tab; this is its everyday way in.
                <Button
                  variant="ghost"
                  iconOnly
                  tooltip={t('打开运行记录')}
                  aria-label={t('打开运行记录')}
                  onClick={() => openPath(RUNS_TAB)}
                >
                  <Table2 size={13} />
                </Button>
              )}
              <Button
                variant="ghost"
                iconOnly
                aria-label={t(panelMaximized ? '还原面板大小' : '最大化面板大小')}
                tooltip={t(panelMaximized ? '还原面板大小' : '最大化面板大小')}
                onClick={() => {
                  setPanelMaximized((value) => !value);
                  setPanelOpen(true);
                }}
              >
                {panelMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </Button>
              <Button
                variant="ghost"
                iconOnly
                aria-label={t(panelOpen ? '收起面板' : '展开面板')}
                tooltip={t(panelOpen ? '收起面板' : '展开面板')}
                onClick={() => setPanelOpen((value) => !value)}
              >
                {panelOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              </Button>
            </header>
            <div className="sf-terminal-container" hidden={!panelOpen || panelTab !== 'terminal'}>
              {panelTab === 'terminal' && (
                <Suspense fallback={<p>{t('正在读取…')}</p>}>
                  <TerminalPanel
                    projectId={project.id}
                    experimentId={experiment.id}
                    terminals={ownTerminals}
                    activeId={terminalId}
                    onActive={setTerminalId}
                    onError={setError}
                  />
                </Suspense>
              )}
            </div>
            {panelOpen && panelTab === 'runs' && (
              <RunPanel runs={ownRuns} active={activeRun} onActive={setLogRun} />
            )}
          </div>
        </div>
      ) : (
        <EmptySteps
          title={t('开始一个实验')}
          steps={[
            {
              title: t('打开或克隆代码文件夹'),
              detail: t('已有的代码直接打开；复现论文就克隆它的仓库。'),
              actions: (
                <>
                  <Button
                    variant="primary"
                    disabled={readOnly || !experimentCatalog.available()}
                    onClick={() => void openFolder()}
                  >
                    <FolderOpen size={15} />
                    {t('打开文件夹…')}
                  </Button>
                  <Button
                    disabled={readOnly || !experimentCatalog.available()}
                    onClick={() => setDialog('clone')}
                  >
                    <GitFork size={15} />
                    {t('克隆 Git 仓库…')}
                  </Button>
                </>
              ),
            },
            {
              title: t('选择 Python 环境'),
              detail: t('在底部状态栏选择解释器，或新建一个虚拟环境。'),
            },
            {
              title: t('让 AI 跑起来'),
              detail: t('按 Ctrl J 打开 AI 助手，说明要复现的实验。'),
            },
          ]}
        />
      )}
      {dialog === 'config' && (
        <ConfigurationForm
          key={editConfig?.id || 'new'}
          project={project}
          experimentId={experiment?.id}
          store={store}
          initial={editConfig}
          onClose={() => setDialog(null)}
          onSaved={(id) => {
            setSelectedConfig(id);
            setDialog(null);
          }}
        />
      )}
      {picker && experiment && (
        <InterpreterPicker
          projectId={project.id}
          experiment={experiment}
          store={store}
          backend={backend}
          root={root}
          onStarted={(task) => {
            if (['venv', 'conda'].includes(task.kind)) preparing.current.add(task.id);
          }}
          onClose={() => setPicker(false)}
        />
      )}
      {dialog === 'clone' && (
        <CloneDialog store={store} onClose={() => setDialog(null)} onClone={cloneRepository} />
      )}
      {dialog === 'tasks' && (
        <Modal title={t('后台任务')} onClose={() => setDialog(null)}>
          <div className="sf-experiment-dialog-body">
            {executions
              .filter((r) => r.status === 'running')
              .map((r) => (
                <div className="sf-experiment-task" key={r.id}>
                  <span>
                    <strong>{r.name}</strong>
                    <small>
                      {store.getState().data?.projects.find((p) => p.id === r.project)?.name ||
                        r.project}{' '}
                      · {r.id.slice(0, 8)}
                    </small>
                  </span>
                  <Button
                    onClick={() => {
                      if (r.project === project.id) {
                        setLogRun(r.id);
                        showPanel('runs');
                        setDialog(null);
                      } else if (onProjectRun) {
                        onProjectRun(r.project, r.id);
                        setDialog(null);
                      } else setError(t('请切换到对应项目查看运行详情。'));
                    }}
                  >
                    {t('查看')}
                  </Button>
                  <Button
                    onClick={async () => {
                      try {
                        await experimentApi.stop(r.id);
                      } catch (e) {
                        setError(errorMessage(e));
                      }
                    }}
                  >
                    {t('停止')}
                  </Button>
                </div>
              ))}
            {!executions.some((r) => r.status === 'running') && <p>{t('暂无后台实验任务')}</p>}
          </div>
        </Modal>
      )}
    </WorkspaceFrame>
  );
}
export function ConfigurationForm({
  project,
  experimentId,
  store,
  initial,
  onClose,
  onSaved,
}: {
  project: Project;
  experimentId?: string;
  store: WorkspaceStore;
  initial?: RunConfiguration;
  onClose(): void;
  onSaved(id: string): void;
}) {
  const [name, setName] = useState(initial?.name || '');
  const [executable, setExecutable] = useState(initial?.executable || 'python');
  const [args, setArgs] = useState(JSON.stringify(initial?.args || [], null, 2));
  const [cwd, setCwd] = useState(initial?.cwd || '.');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const source = 'run-config:' + project.id + ':' + (experimentId ?? 'legacy');
  useEffect(() => {
    store.getState().setDirtySource(source, dirty);
    return () => store.getState().setDirtySource(source, false);
  }, [store, source, dirty]);
  async function save() {
    try {
      const parsed = parseArguments(args);
      if (!name.trim() || !executable.trim()) throw new Error(t('请输入名称和可执行程序。'));
      setSaving(true);
      const id = initial?.id || crypto.randomUUID();
      const result = await store.getState().update((d) => {
        const p = d.projects.find((p) => p.id === project.id);
        if (!p) throw new Error(t('项目不存在'));
        const owner = experimentId
          ? d.experiments?.find((e) => e.id === experimentId && e.project === project.id)
          : p;
        if (!owner) throw new Error(t('实验不存在。'));
        const list = configurationsOf(owner.runConfigurations);
        owner.runConfigurations = [
          ...list.filter((c) => c.id !== id),
          {
            id,
            name: name.trim(),
            executable: executable.trim(),
            args: parsed,
            cwd: cwd.trim() || '.',
          },
        ];
      });
      if (result) onSaved(id);
      else setError(store.getState().error || t('保存失败'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={t(initial ? '编辑运行配置' : '新建运行配置')}
      onClose={onClose}
      dirty={dirty}
      busy={saving}
    >
      <form
        className="sf-experiment-config-form"
        onChange={() => setDirty(true)}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={saving}>
          <label>
            {t('配置名称')}
            <Input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            {t('可执行程序')}
            <Input
              required
              value={executable}
              onChange={(e) => setExecutable(e.target.value)}
              placeholder="python / .venv/Scripts/python.exe"
            />
          </label>
          <label>
            {t('参数（JSON 数组）')}
            <Textarea
              rows={4}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder={'["src/train.py", "--seed", "42"]'}
            />
          </label>
          <label>
            {t('工作目录（相对项目根目录）')}
            <Input value={cwd} onChange={(e) => setCwd(e.target.value)} />
          </label>
        </fieldset>
        {error && <p role="alert">{translateError(error)}</p>}
        <footer>
          {initial && (
            <>
              <Button
                type="button"
                disabled={saving}
                onClick={async () => {
                  if (!(await confirmAction(t('删除此运行配置？已有运行记录不会删除。')))) return;
                  setSaving(true);
                  try {
                    const ok = await store.getState().update((d) => {
                      const p = experimentId
                        ? d.experiments?.find(
                            (e) => e.id === experimentId && e.project === project.id,
                          )
                        : d.projects.find((p) => p.id === project.id);
                      if (p)
                        p.runConfigurations = configurationsOf(p.runConfigurations).filter(
                          (c) => c.id !== initial.id,
                        );
                    });
                    if (ok) onClose();
                    else setError(store.getState().error || t('保存失败'));
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                <Trash2 size={14} />
                {t('删除配置')}
              </Button>
            </>
          )}
          <span className="spacer" />
          <Button type="button" disabled={saving} onClick={onClose}>
            {t('取消')}
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {t(saving ? '保存中…' : '保存配置')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
