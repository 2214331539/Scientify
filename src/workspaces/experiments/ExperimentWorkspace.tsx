import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import {
  Box,
  FlaskConical,
  Files,
  FolderGit2,
  GitBranch,
  ListTodo,
  PanelBottom,
  PanelLeftClose,
  Play,
  SaveAll,
  Search,
  Settings2,
  Square,
  Trash2,
  TerminalSquare,
  X,
} from 'lucide-react';
import { Button, Dropdown, Input, Textarea } from '../../components/primitives';
import { Modal } from '../../components/Modal';
import { WorkspaceFrame } from '../../components/workspace/WorkspaceFrame';
import { confirmAction } from '../../components/prompts';
import type { Project, Experiment } from '../../domain/workspace';
import type { WorkContext } from '../../domain/context';
import type { ResearchBackend } from '../../platform/research';
import type { WorkspaceStore } from '../../stores/workspace';
import { getFileRuntime, getFileSession } from '../../editor/sessions';
import { FileResources, FileWorkspace } from '../files/FileWorkspace';
import { t, translateError } from '../../i18n';
import { GitWorkspace, type GitView } from './GitWorkspace';
import { CodeSearch, type SearchHit } from './CodeSearch';
import { clearCodeRoot, codeContext, selectExperiment, useCodeWorkspace } from './code-context';
import { ExperimentManager } from './ExperimentManager';
import { experimentsFor, registerExperiment, sameCodeRoot } from './catalog';
import { ExperimentRuns } from './ExperimentRuns';
import { ExecutionPanel } from './ExecutionPanel';
import { PythonSidebar } from './PythonSidebar';
import { developmentApi, ensureExecutionTrust, openTerminal, useDevelopment } from './development';
import {
  configurationsOf,
  describeError,
  experimentApi,
  parseArguments,
  startExecution,
  executionStore,
  type Execution,
  type RunConfiguration,
} from './runtime';
import './experiments.css';
import './development.css';
const TerminalPanel = lazy(() =>
  import('./TerminalPanel').then((module) => ({ default: module.TerminalPanel })),
);
const noContext = () => {};
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
  const data = useStore(store, (state) => state.data);
  const experimentId = useStore(codeContext, (state) => state.experiments[project.id]);
  const catalog = experimentsFor(data, project.id).filter((item) => !item.archived);
  const experiment = catalog.find((item) => item.id === experimentId) ?? catalog[0];
  const code = useCodeWorkspace(project, experiment);
  const development = useDevelopment();
  function openExperiment(next: Experiment) {
    selectExperiment(project.id, next);
    onView('files');
  }
  async function openWorktree(root: string) {
    try {
      const existing = catalog.find((item) => sameCodeRoot(item.root, root));
      if (existing) {
        openExperiment(existing);
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
        openExperiment(main);
        return;
      }
      const next = await registerExperiment(
        store,
        project.id,
        root.replaceAll('\\', '/').split('/').at(-1) || 'Worktree',
        '',
        'existing',
        root,
      );
      openExperiment(next);
    } catch (reason) {
      setError(describeError(reason));
    }
  }
  const root = code.root;
  const currentRoot = useRef(root);
  currentRoot.current = root;
  const [resourceView, setResourceView] = useState<'files' | 'search' | 'python'>('files');
  const [gitView, setGitView] = useState<GitView>('changes');
  const [createRequest, setCreateRequest] = useState(0);
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
  const [dialog, setDialog] = useState<'config' | 'tasks' | null>(null);
  const [editConfig, setEditConfig] = useState<RunConfiguration | undefined>();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelMaximized, setPanelMaximized] = useState(false);
  const [panelTab, setPanelTab] = useState('logs');
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
      setPanelOpen(true);
    }
  }, [selectedRunId, project.id, executions, experiment?.id]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (view === 'manage') {
      onContext({
        projectId: project.id,
        workspace: 'experiments',
        title: project.name,
        text: project.question,
      });
    } else if (code.ready && experiment && (view !== 'files' || !currentPath)) {
      onContext({
        projectId: project.id,
        workspace: 'experiments',
        title: experiment.name,
        workspaceRoot: root,
        experimentId: experiment.id,
        text: experiment.purpose,
      });
    } else if (code.ready && view === 'files' && currentPath)
      onContext({
        projectId: project.id,
        workspace: 'experiments',
        title: currentPath,
        path: currentPath,
        workspaceRoot: root,
        experimentId: experiment?.id,
        text: getFileSession(backend, project.id, currentPath, root).getSnapshot().content,
      });
  }, [
    view,
    currentPath,
    project.id,
    project.name,
    project.question,
    backend,
    onContext,
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
      showResource('python');
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
        setPanelTab('logs');
        setPanelOpen(true);
        onSelect(result.id);
        if (result.error) setError(result.error);
      }
    } catch (e) {
      if (alive.current) setError(describeError(e));
    } finally {
      if (alive.current) setStarting(false);
    }
  }
  function openConfiguration() {
    setEditConfig(config);
    setDialog('config');
  }
  function showResource(next: 'files' | 'search' | 'python') {
    const same = view === 'files' && resourceView === next;
    setResourceView(next);
    onView('files');
    if (!sidebarOpen || same) onSidebarToggle();
  }
  async function startTerminal(pythonFile = false) {
    if (!experiment || !code.ready || starting) return;
    if (pythonFile && !experiment.python) {
      showResource('python');
      return;
    }
    const owner = experiment.id;
    setStarting(true);
    setError('');
    try {
      if (pythonFile) {
        if (!currentPath?.endsWith('.py')) return;
        const session = getFileSession(backend, project.id, currentPath, root);
        await session.load();
        if (session.getSnapshot().dirty && !(await session.save()))
          throw new Error(t('文件保存失败，请处理冲突后再运行。'));
      }
      const info = await openTerminal(
        project.id,
        owner,
        pythonFile
          ? 'python'
          : navigator.platform.toLowerCase().includes('win')
            ? 'powershell'
            : 'bash',
        pythonFile ? currentPath! : undefined,
      );
      if (info && alive.current && currentRoot.current === root) {
        setTerminalId(info.id);
        setPanelTab('terminal');
        setPanelOpen(true);
      }
      if (info) store.getState().setAgentTask(`terminal:${info.id}`, project.id);
    } catch (e) {
      if (alive.current) setError(describeError(e));
    } finally {
      if (alive.current) setStarting(false);
    }
  }
  async function openMatch(hit: SearchHit) {
    onView('files');
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
      if (alive.current && currentRoot.current === root) setError(describeError(e));
    } finally {
      if (alive.current) setSavingAll(false);
    }
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        (!event.ctrlKey && !event.metaKey) ||
        document.querySelector('dialog[open]')
      )
        return;
      const key = event.key.toLowerCase();
      const next =
        event.shiftKey && key === 'f'
          ? 'search'
          : (event.shiftKey && key === 'e') || (!event.shiftKey && key === 'p')
            ? 'files'
            : null;
      if (next) {
        event.preventDefault();
        setResourceView(next);
        onView('files');
        if (!sidebarOpen) onSidebarToggle();
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLInputElement>(
              next === 'search' ? '.sf-code-search input' : '.sf-resource-search input',
            )
            ?.focus(),
        );
      } else if (event.shiftKey && key === 'g') {
        event.preventDefault();
        setGitView('changes');
        onView('versions');
      } else if (!event.shiftKey && key === 'j') {
        event.preventDefault();
        onView('files');
        setPanelOpen((value) => !value);
      } else if (key === '`') {
        event.preventDefault();
        onView('files');
        setPanelTab('terminal');
        setPanelOpen(true);
        if (!ownTerminals.length) void startTerminal();
      } else if (event.shiftKey && key === 's') {
        event.preventDefault();
        void saveAll();
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  });
  return (
    <WorkspaceFrame
      label={view === 'manage' ? t('Experiments') : (experiment?.name ?? t('Experiments'))}
      views={[]}
      view={view}
      onView={onView}
      sidebar={
        code.ready && experiment ? (
          <>
            <div hidden={resourceView !== 'files'} className="sf-code-resource-content">
              <FileResources
                project={project}
                backend={backend}
                mode="experiments"
                view="files"
                activePath={currentPath}
                onOpen={openPath}
                workspaceRoot={root}
                onCreate={() => {
                  setCreateRequest((value) => value + 1);
                  onView('files');
                }}
              />
            </div>
            <div hidden={resourceView !== 'search'} className="sf-code-resource-content">
              <CodeSearch
                key={JSON.stringify([project.id, root])}
                projectId={project.id}
                root={root}
                backend={backend}
                active={view === 'files' && sidebarOpen && resourceView === 'search'}
                onOpen={(hit) => void openMatch(hit)}
              />
            </div>
            <div hidden={resourceView !== 'python'} className="sf-code-resource-content">
              <PythonSidebar
                key={experiment.id}
                projectId={project.id}
                experiment={experiment}
                store={store}
                active={view === 'files' && sidebarOpen && resourceView === 'python'}
                tasks={development.tasks}
                onTerminal={() => void startTerminal()}
              />
            </div>
          </>
        ) : undefined
      }
      sidebarOpen={sidebarOpen && view === 'files'}
      onSidebarToggle={onSidebarToggle}
      width={width}
      resize={resize}
      activity={
        <nav className="sf-code-activity" aria-label={t('代码工具')}>
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('实验管理')}
            tooltip={t('实验管理')}
            aria-current={view === 'manage' ? 'page' : undefined}
            onClick={() => onView('manage')}
          >
            <FlaskConical size={21} />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('Code')}
            tooltip={t('资源管理器')}
            aria-current={view === 'files' && resourceView === 'files' ? 'page' : undefined}
            onClick={() => showResource('files')}
          >
            <Files size={21} />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('搜索工作区')}
            tooltip={t('搜索工作区')}
            aria-current={view === 'files' && resourceView === 'search' ? 'page' : undefined}
            onClick={() => showResource('search')}
          >
            <Search size={21} />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            aria-label="Git"
            tooltip={t('源代码管理')}
            aria-current={view === 'versions' && gitView !== 'worktrees' ? 'page' : undefined}
            onClick={() => {
              setGitView('changes');
              onView('versions');
            }}
          >
            <GitBranch size={21} />
            {!!code.snapshot?.changes.length && (
              <span className="sf-code-badge">{code.snapshot.changes.length}</span>
            )}
          </Button>
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('Runs')}
            tooltip={t('Runs')}
            aria-current={view === 'runs' ? 'page' : undefined}
            onClick={() => onView('runs')}
          >
            <Play size={21} />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('管理 worktree')}
            tooltip={t('管理 worktree')}
            aria-current={view === 'versions' && gitView === 'worktrees' ? 'page' : undefined}
            onClick={() => {
              setGitView('worktrees');
              onView('versions');
            }}
          >
            <FolderGit2 size={21} />
          </Button>
          <span className="spacer" />
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('后台任务')}
            onClick={() => setDialog('tasks')}
          >
            <ListTodo size={20} />
            {executions.some((r) => r.status === 'running') && (
              <span className="sf-code-badge">
                {executions.filter((r) => r.status === 'running').length}
              </span>
            )}
          </Button>
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('环境与依赖')}
            tooltip={t('Python 环境')}
            aria-current={view === 'files' && resourceView === 'python' ? 'page' : undefined}
            onClick={() => showResource('python')}
          >
            <Box size={20} />
          </Button>
        </nav>
      }
      footer={
        view === 'manage' ? undefined : (
          <footer className="sf-code-statusbar">
            <Button
              variant="ghost"
              aria-label={t('分支')}
              onClick={() => {
                setGitView('branches');
                onView('versions');
              }}
            >
              <GitBranch size={12} />
              <span>{code.snapshot?.branch || 'Git'}</span>
            </Button>
            <span>
              {code.snapshot ? t('{count} 个变更', { count: code.snapshot.changes.length }) : ''}
            </span>
            <span className="spacer" />
            <Button
              variant="ghost"
              aria-label={t('选择 Python 解释器')}
              onClick={() => showResource('python')}
            >
              {experiment?.python
                ? `Python ${experiment.python.version} (${experiment.python.manager})`
                : t('选择 Python 解释器')}
            </Button>
            <Button
              variant="ghost"
              iconOnly
              tooltip={t('新建终端')}
              aria-label={t('新建终端')}
              disabled={starting || !code.ready || !experimentApi.available()}
              onClick={() => {
                onView('files');
                void startTerminal();
              }}
            >
              <TerminalSquare size={14} />
            </Button>
            <Button
              variant="ghost"
              iconOnly
              aria-label={t(sidebarOpen ? '收起资源' : '展开资源')}
              onClick={() => {
                onView('files');
                onSidebarToggle();
              }}
            >
              <PanelLeftClose size={13} />
            </Button>
            <Button
              variant="ghost"
              iconOnly
              aria-label={t(panelOpen ? '收起运行日志' : '展开运行日志')}
              onClick={() => {
                onView('files');
                setPanelOpen((value) => !value);
              }}
            >
              <PanelBottom size={13} />
            </Button>
          </footer>
        )
      }
      actions={
        view !== 'manage' && experiment ? (
          <div className="sf-experiment-actions">
            <Dropdown
              aria-label={t('当前实验')}
              value={experiment.id}
              onChange={(event) => {
                const next = catalog.find((e) => e.id === event.target.value);
                if (next) openExperiment(next);
              }}
            >
              {catalog.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Dropdown>
            <Dropdown
              aria-label={t('运行配置')}
              value={config?.id || ''}
              onChange={(e) => {
                if (e.target.value === '__new') {
                  setEditConfig(undefined);
                  setDialog('config');
                } else setSelectedConfig(e.target.value);
              }}
            >
              <option value="" disabled>
                {t('选择运行配置')}
              </option>
              {configurations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value="__new">{t('新建运行配置')}</option>
            </Dropdown>
            <Button
              variant="ghost"
              iconOnly
              tooltip={t('保存全部')}
              aria-label={t('保存全部')}
              disabled={!code.ready || savingAll}
              onClick={() => void saveAll()}
            >
              <SaveAll size={15} />
            </Button>
            <Button
              variant="ghost"
              iconOnly
              tooltip={t('编辑运行配置')}
              aria-label={t('编辑运行配置')}
              onClick={openConfiguration}
            >
              <Settings2 size={15} />
            </Button>
            {currentPath?.endsWith('.py') && (
              <Button
                variant="ghost"
                iconOnly
                tooltip={t('在终端运行当前 Python 文件')}
                aria-label={t('在终端运行当前 Python 文件')}
                disabled={starting || !code.ready || !experimentApi.available()}
                onClick={() => void startTerminal(true)}
              >
                <Play size={15} />
              </Button>
            )}
            <Button
              variant="primary"
              disabled={starting || !code.ready || !experimentApi.available()}
              title={!experimentApi.available() ? t('本地执行仅在桌面应用可用') : undefined}
              onClick={() => void run()}
            >
              <Play size={13} />
              {t(starting ? '启动中…' : '运行')}
            </Button>
            {activeRun?.status === 'running' &&
              (!root ||
                (activeRun.workspaceRoot ||
                  activeRun.source?.workspaceRoot ||
                  activeRun.directory) === root) && (
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label={t('停止当前运行')}
                  onClick={() => {
                    void experimentApi.stop(activeRun.id).catch((e) => {
                      if (alive.current) setError(describeError(e));
                    });
                  }}
                >
                  <Square size={14} />
                </Button>
              )}
          </div>
        ) : undefined
      }
    >
      {(view === 'manage' || !experiment) && (
        <ExperimentManager
          project={project}
          store={store}
          executions={executions}
          onOpen={openExperiment}
        />
      )}
      {(error || runtimeError || development.error) && (
        <div role="alert" className="sf-experiment-error">
          {translateError(error || runtimeError || development.error)}
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('关闭提示')}
            onClick={() => {
              setError('');
              executionStore.setState({ error: '' });
            }}
          >
            <X size={13} />
          </Button>
        </div>
      )}
      <div className="sf-experiment-code" hidden={view !== 'files' || !experiment}>
        <div className="sf-experiment-editor" hidden={panelOpen && panelMaximized}>
          {code.ready && experiment ? (
            <FileWorkspace
              project={project}
              store={store}
              backend={backend}
              mode="experiments"
              view="files"
              activePath={currentPath}
              onActivePathChange={openPath}
              workspaceRoot={root}
              createRequest={createRequest}
              onCreateHandled={() => setCreateRequest(0)}
              onContext={
                view === 'files'
                  ? (context) => onContext({ ...context, experimentId: experiment?.id })
                  : noContext
              }
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
        >
          <header>
            {['terminal', 'logs', 'artifacts'].map((value) => (
              <Button
                key={value}
                variant="ghost"
                aria-current={panelTab === value ? 'page' : undefined}
                onClick={() => {
                  setPanelTab(value);
                  setPanelOpen(true);
                }}
              >
                {t(value === 'terminal' ? '终端' : value === 'logs' ? '日志' : '产物')}
              </Button>
            ))}
            <span className="spacer" />
            {panelTab !== 'terminal' && (
              <Dropdown
                aria-label={t('查看运行输出')}
                value={activeRun?.id || ''}
                onChange={(e) => setLogRun(e.target.value)}
              >
                {!ownRuns.length && <option value="">{t('尚无本地运行')}</option>}
                {ownRuns.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {r.id.slice(0, 8)}
                  </option>
                ))}
              </Dropdown>
            )}
            <Button
              variant="ghost"
              iconOnly
              aria-label={t(panelMaximized ? '还原输出面板' : '最大化输出面板')}
              onClick={() => {
                setPanelMaximized((value) => !value);
                setPanelOpen(true);
              }}
            >
              <PanelBottom size={14} />
            </Button>
            <Button
              variant="ghost"
              iconOnly
              aria-label={t('关闭输出面板')}
              onClick={() => setPanelOpen(false)}
            >
              <X size={14} />
            </Button>
          </header>
          <div className="sf-terminal-container" hidden={!panelOpen || panelTab !== 'terminal'}>
            {panelTab === 'terminal' && experiment && (
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
          {panelOpen && panelTab !== 'terminal' && (
            <ExecutionPanel run={activeRun} tab={panelTab} />
          )}
        </div>
      </div>
      {view === 'runs' && experiment && (
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
      )}
      <div className="sf-experiment-git" hidden={view !== 'versions' || !experiment}>
        <GitWorkspace
          projectId={project.id}
          backend={backend}
          store={store}
          code={code}
          view={gitView}
          onView={setGitView}
          onSelectRoot={(root) => void openWorktree(root)}
          onOpen={(p) => {
            openPath(p);
            onView('files');
          }}
        />
      </div>
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
                        onSelect(r.id);
                        onView('runs');
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
                        setError(describeError(e));
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
      setError(describeError(e));
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
