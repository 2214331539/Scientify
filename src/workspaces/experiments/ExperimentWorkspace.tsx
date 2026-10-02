import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { Box, ListTodo, PanelBottom, Play, Save, Settings2, Trash2, X } from 'lucide-react';
import { Button, Dropdown, Input, Textarea } from '../../components/primitives';
import { Modal } from '../../components/Modal';
import { WorkspaceFrame } from '../../components/workspace/WorkspaceFrame';
import { confirmAction } from '../../components/prompts';
import type { Project } from '../../domain/workspace';
import type { WorkContext } from '../../domain/context';
import type { ResearchBackend } from '../../platform/research';
import type { WorkspaceStore } from '../../stores/workspace';
import { getFileRuntime, getFileSession } from '../../editor/sessions';
import { FileResources, FileWorkspace } from '../files/FileWorkspace';
import { t, translateError } from '../../i18n';
import { ChangesWorkspace } from './ChangesWorkspace';
import { ExperimentRuns } from './ExperimentRuns';
import { ExecutionPanel } from './ExecutionPanel';
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
  const normalizePath = (value: string) => value.trim().replaceAll('\\', '/').replace(/\/$/, '');
  const canOpenGitFile =
    !project.repo?.trim() || normalizePath(project.repo) === normalizePath(project.path || '');
  const saved = useStore(
    store,
    (s) => s.data?.projects.find((p) => p.id === project.id)?.runConfigurations,
  );
  const configurations = configurationsOf(saved);
  const [selectedConfig, setSelectedConfig] = useState('');
  const config = configurations.find((c) => c.id === selectedConfig) ?? configurations[0];
  const [dialog, setDialog] = useState<'config' | 'environment' | 'tasks' | null>(null);
  const [editConfig, setEditConfig] = useState<RunConfiguration | undefined>();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelTab, setPanelTab] = useState('logs');
  const [logRun, setLogRun] = useState('');
  const ownRuns = executions
    .filter((r) => r.project === project.id)
    .sort((a, b) => b.startedAt - a.startedAt);
  const activeRun = ownRuns.find((r) => r.id === logRun) ?? ownRuns[0];
  useEffect(() => {
    if (selectedRunId) {
      setLogRun(selectedRunId);
      setPanelOpen(true);
    }
  }, [selectedRunId]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (view === 'files' && activePath)
      onContext({
        projectId: project.id,
        workspace: 'experiments',
        title: activePath,
        path: activePath,
        text: getFileSession(backend, project.id, activePath).getSnapshot().content,
      });
  }, [view, activePath, project.id, backend, onContext]);
  async function run(configuration = config) {
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
      const drafts = [...getFileRuntime(backend).sessions.values()].filter(
        (s) => s.projectId === project.id && s.getSnapshot().dirty,
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
      const result = await startExecution(store, project.id, configuration);
      if (alive.current) {
        setLogRun(result.id);
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
  return (
    <WorkspaceFrame
      label={t('Experiments')}
      views={[
        { id: 'files', label: 'Code' },
        { id: 'runs', label: 'Runs' },
        { id: 'versions', label: 'Changes' },
      ]}
      view={view}
      onView={onView}
      sidebar={
        view === 'files' ? (
          <FileResources
            project={project}
            backend={backend}
            mode="experiments"
            view="files"
            activePath={activePath}
            onOpen={onOpen}
          />
        ) : undefined
      }
      sidebarOpen={sidebarOpen}
      onSidebarToggle={onSidebarToggle}
      width={width}
      resize={resize}
      actions={
        <div className="sf-experiment-actions">
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
            tooltip={t('环境与依赖')}
            aria-label={t('环境与依赖')}
            onClick={() => setDialog('environment')}
          >
            <Box size={15} />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            tooltip={t('保存当前文件')}
            aria-label={t('保存当前文件')}
            disabled={!activePath || view !== 'files'}
            onClick={() => {
              if (activePath) void getFileSession(backend, project.id, activePath).save();
            }}
          >
            <Save size={15} />
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
          <Button
            variant="primary"
            disabled={starting || !experimentApi.available()}
            title={!experimentApi.available() ? t('本地执行仅在桌面应用可用') : undefined}
            onClick={() => void run()}
          >
            <Play size={13} />
            {t(starting ? '启动中…' : '运行')}
          </Button>
          <Button
            variant="ghost"
            tooltip={t('后台任务')}
            aria-label={t('后台任务')}
            onClick={() => setDialog('tasks')}
          >
            <ListTodo size={15} />
            <span>{executions.filter((r) => r.status === 'running').length}</span>
          </Button>
        </div>
      }
    >
      {(error || runtimeError) && (
        <div role="alert" className="sf-experiment-error">
          {translateError(error || runtimeError)}
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
      <div className="sf-experiment-code" hidden={view !== 'files'}>
        <div className="sf-experiment-editor">
          <FileWorkspace
            project={project}
            store={store}
            backend={backend}
            mode="experiments"
            view="files"
            activePath={activePath}
            onActivePathChange={onOpen}
            onContext={view === 'files' ? onContext : noContext}
          />
        </div>
        <div className={'sf-experiment-bottom ' + (!panelOpen ? 'is-collapsed' : '')}>
          <header>
            <Button
              variant="ghost"
              iconOnly
              aria-label={t(panelOpen ? '收起运行日志' : '展开运行日志')}
              onClick={() => setPanelOpen((v) => !v)}
            >
              <PanelBottom size={14} />
            </Button>
            {['logs', 'artifacts'].map((value) => (
              <Button
                key={value}
                variant="ghost"
                aria-current={panelTab === value ? 'page' : undefined}
                onClick={() => {
                  setPanelTab(value);
                  setPanelOpen(true);
                }}
              >
                {t(value === 'logs' ? '日志' : '产物')}
              </Button>
            ))}
            <span className="spacer" />
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
          </header>
          {panelOpen && <ExecutionPanel run={activeRun} tab={panelTab} />}
        </div>
      </div>
      {view === 'runs' && (
        <ExperimentRuns
          project={project}
          store={store}
          executions={ownRuns}
          selectedId={selectedRunId}
          onSelect={onSelect}
          onContext={onContext}
          onRerun={(r) => void run(r.configuration)}
        />
      )}
      {view === 'versions' && (
        <ChangesWorkspace
          projectId={project.id}
          backend={backend}
          canOpenFile={canOpenGitFile}
          onOpen={(p) => {
            onOpen(p);
            onView('files');
          }}
        />
      )}
      {dialog === 'config' && (
        <ConfigurationForm
          key={editConfig?.id || 'new'}
          project={project}
          store={store}
          initial={editConfig}
          onClose={() => setDialog(null)}
          onSaved={(id) => {
            setSelectedConfig(id);
            setDialog(null);
          }}
        />
      )}
      {dialog === 'environment' && (
        <Modal title={t('环境与依赖')} onClose={() => setDialog(null)}>
          <div className="sf-experiment-dialog-body">
            <dl className="sf-execution-definition">
              <dt>{t('项目目录')}</dt>
              <dd>{project.path || t('应用托管目录')}</dd>
              <dt>{t('可执行程序')}</dt>
              <dd>{config?.executable || '—'}</dd>
              <dt>{t('工作目录')}</dt>
              <dd>{config?.cwd || '.'}</dd>
              <dt>{t('参数')}</dt>
              <dd>
                <code>{config ? JSON.stringify(config.args) : '—'}</code>
              </dd>
              <dt>{t('执行权限')}</dt>
              <dd>{t('工作区沙箱 · 网络关闭')}</dd>
            </dl>
            <p>{t('以上为配置值，不表示环境检测已通过。运行时会验证路径和程序。')}</p>
            <p>{t('产物目录由 SCIENTIFY_RUN_DIR 提供，脚本需显式将结果写入该目录。')}</p>
            <Button
              onClick={() => {
                setDialog('config');
                setEditConfig(config);
              }}
            >
              <Settings2 size={14} />
              {t('编辑运行配置')}
            </Button>
          </div>
        </Modal>
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
  store,
  initial,
  onClose,
  onSaved,
}: {
  project: Project;
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
  const source = 'run-config:' + project.id;
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
        const list = configurationsOf(p.runConfigurations);
        p.runConfigurations = [
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
                      const p = d.projects.find((p) => p.id === project.id);
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
