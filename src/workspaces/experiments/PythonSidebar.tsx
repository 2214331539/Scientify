import { useEffect, useRef, useState } from 'react';
import { Check, Play, RefreshCw, Square } from 'lucide-react';
import { Button, Dropdown, Input } from '../../components/primitives';
import { confirmAction } from '../../components/prompts';
import type { Experiment } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import { t, translateError } from '../../i18n';
import {
  bindInterpreter,
  developmentApi,
  developmentStore,
  ensureExecutionTrust,
  type EnvironmentTask,
  type Interpreter,
} from './development';
import { describeError } from './runtime';

export function PythonSidebar({
  projectId,
  experiment,
  store,
  active,
  tasks,
  onTerminal,
}: {
  projectId: string;
  experiment: Experiment;
  store: WorkspaceStore;
  active: boolean;
  tasks: EnvironmentTask[];
  onTerminal(): void;
}) {
  const [interpreters, setInterpreters] = useState<Interpreter[]>([]);
  const [executable, setExecutable] = useState(experiment.python?.executable || '');
  const [base, setBase] = useState('');
  const [manager, setManager] = useState('venv');
  const [target, setTarget] = useState('.venv');
  const [version, setVersion] = useState('3.12');
  const [conda, setConda] = useState(false);
  const [tab, setTab] = useState('environment');
  const [packages, setPackages] = useState<{ name: string; version: string }[]>([]);
  const [packageInput, setPackageInput] = useState('');
  const [requirements, setRequirements] = useState('requirements.txt');
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [logId, setLogId] = useState('');
  const [log, setLog] = useState('');
  const generation = useRef(0);
  const mine = tasks
    .filter((task) => task.experimentId === experiment.id)
    .sort((a, b) => b.startedAt - a.startedAt);
  const current = mine.find((item) => item.id === logId) ?? mine[0];
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  async function perform<T>(operation: () => Promise<T>) {
    const epoch = ++generation.current;
    setBusy(true);
    setError('');
    try {
      return await operation();
    } catch (e) {
      if (epoch === generation.current) setError(describeError(e));
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  }
  async function scan() {
    await perform(async () => {
      if (!(await ensureExecutionTrust(projectId, experiment.id))) return;
      setTrusted(true);
      const data = await developmentApi.python<{
        interpreters: Interpreter[];
        condaAvailable: boolean;
      }>(projectId, experiment.id, { action: 'discover' });
      setInterpreters(data.interpreters);
      setConda(data.condaAvailable);
      setBase(
        (value) =>
          value ||
          data.interpreters.find((item) => item.manager === 'system')?.executable ||
          data.interpreters[0]?.executable ||
          '',
      );
    });
  }
  useEffect(() => {
    if (!active || !developmentApi.available()) return;
    let alive = true;
    void developmentApi
      .trust(projectId, experiment.id)
      .then((value) => {
        if (alive) {
          setTrusted(value);
          if (value && !interpreters.length) void scan();
        }
      })
      .catch((e) => {
        if (alive) setError(describeError(e));
      });
    return () => {
      alive = false;
    };
  }, [active, projectId, experiment.id]);
  useEffect(() => {
    if (!active || !current) return;
    let alive = true;
    void developmentApi
      .python<string>(projectId, experiment.id, { action: 'log', id: current.id })
      .then((value) => {
        if (alive) setLog(value);
      })
      .catch((e) => {
        if (alive) setError(describeError(e));
      });
    return () => {
      alive = false;
    };
  }, [active, projectId, experiment.id, current?.id, tasks]);
  async function select(path: string) {
    await perform(async () => {
      if (!(await ensureExecutionTrust(projectId, experiment.id))) return;
      const info = await developmentApi.python<Interpreter>(projectId, experiment.id, {
        action: 'inspect',
        executable: path,
      });
      await bindInterpreter(store, experiment.id, info);
      setExecutable(info.executable);
      setTrusted(true);
    });
  }
  async function start(kind: string) {
    await perform(async () => {
      if (!(await ensureExecutionTrust(projectId, experiment.id))) return;
      if (kind === 'uninstall' && !(await confirmAction(t('从当前 Python 环境卸载这些包？'))))
        return;
      if (
        experiment.python?.manager === 'system' &&
        !['venv', 'conda'].includes(kind) &&
        !(await confirmAction(
          t('当前选择的是系统 Python，安装或删除包将影响其他使用此环境的项目。继续？'),
        ))
      )
        return;
      const task = await developmentApi.python<EnvironmentTask>(projectId, experiment.id, {
        action: 'start',
        kind,
        base,
        target: kind === 'requirements' ? requirements : target,
        packages: packageInput.trim().split(/\s+/).filter(Boolean),
        pythonVersion: version,
      });
      developmentStore.setState((data) => ({
        tasks: [...data.tasks.filter((item) => item.id !== task.id), task],
      }));
      store.getState().setAgentTask(`python:${task.id}`, projectId);
      setLogId(task.id);
      setTab('tasks');
      setTrusted(true);
    });
  }
  async function loadPackages() {
    setTab('packages');
    await perform(async () =>
      setPackages(await developmentApi.python(projectId, experiment.id, { action: 'packages' })),
    );
  }
  return (
    <section className="sf-python-sidebar" aria-label={t('Python 环境')}>
      <header>
        <strong>Python</strong>
        <span className="spacer" />
        <Button
          variant="ghost"
          iconOnly
          tooltip={t('刷新解释器')}
          aria-label={t('刷新解释器')}
          disabled={busy || !developmentApi.available()}
          onClick={() => void scan()}
        >
          <RefreshCw size={14} />
        </Button>
      </header>
      <nav aria-label={t('Python 工具')}>
        {['environment', 'packages', 'tasks'].map((value) => (
          <Button
            key={value}
            variant="ghost"
            aria-current={tab === value ? 'page' : undefined}
            onClick={() => (value === 'packages' ? void loadPackages() : setTab(value))}
            disabled={value === 'packages' && !experiment.python}
          >
            {t(value === 'environment' ? '环境' : value === 'packages' ? '依赖' : '任务')}
          </Button>
        ))}
      </nav>
      {error && <p role="alert">{translateError(error)}</p>}
      {!trusted && (
        <Button disabled={busy || !developmentApi.available()} onClick={() => void scan()}>
          {t('信任目录并检测 Python')}
        </Button>
      )}
      {tab === 'environment' && (
        <>
          <label>
            {t('当前解释器')}
            <Dropdown
              value={experiment.python?.executable || ''}
              title={experiment.python?.executable}
              disabled={busy || !trusted}
              onChange={(event) => {
                if (event.target.value) void select(event.target.value);
              }}
            >
              <option value="">{t('选择 Python 解释器')}</option>
              {[
                ...interpreters,
                ...(experiment.python &&
                !interpreters.some((i) => i.executable === experiment.python?.executable)
                  ? [experiment.python]
                  : []),
              ].map((info) => (
                <option
                  key={info.executable}
                  value={info.executable}
                >{`Python ${info.version} · ${info.manager} · ${info.executable}`}</option>
              ))}
            </Dropdown>
          </label>
          {experiment.python && (
            <div className="sf-python-binding">
              <span>
                Python {experiment.python.version} · {experiment.python.manager}
              </span>
              <code>{experiment.python.executable}</code>
              <Button variant="ghost" disabled={!developmentApi.available()} onClick={onTerminal}>
                <Play size={13} />
                {t('打开终端')}
              </Button>
            </div>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void select(executable);
            }}
          >
            <label>
              {t('解释器路径')}
              <Input value={executable} onChange={(event) => setExecutable(event.target.value)} />
            </label>
            <Button type="submit" disabled={busy || !executable || !developmentApi.available()}>
              <Check size={13} />
              {t('使用解释器')}
            </Button>
          </form>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void start(manager);
            }}
          >
            <h3>{t('创建环境')}</h3>
            <label>
              {t('环境类型')}
              <Dropdown
                value={manager}
                onChange={(event) => {
                  setManager(event.target.value);
                  setTarget(event.target.value === 'venv' ? '.venv' : '.conda');
                }}
              >
                <option value="venv">venv</option>
                <option value="conda" disabled={!conda}>
                  Conda
                </option>
              </Dropdown>
            </label>
            {manager === 'venv' ? (
              <label>
                {t('基础 Python')}
                <Dropdown value={base} onChange={(event) => setBase(event.target.value)}>
                  <option value="">{t('选择 Python 解释器')}</option>
                  {interpreters.map((info) => (
                    <option key={info.executable} value={info.executable}>
                      {info.version} · {info.executable}
                    </option>
                  ))}
                </Dropdown>
              </label>
            ) : (
              <label>
                {t('Python 版本')}
                <Input value={version} onChange={(event) => setVersion(event.target.value)} />
              </label>
            )}
            <label>
              {t('环境目录（相对实验根）')}
              <Input value={target} onChange={(event) => setTarget(event.target.value)} />
            </label>
            <Button
              type="submit"
              disabled={busy || !trusted || !target || (manager === 'venv' && !base)}
            >
              {t('创建环境')}
            </Button>
          </form>
        </>
      )}
      {tab === 'packages' && (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void start('install');
            }}
          >
            <label>
              {t('包名称')}
              <Input
                value={packageInput}
                onChange={(event) => setPackageInput(event.target.value)}
                placeholder="numpy pandas==2.3.0"
              />
            </label>
            <div className="sf-python-commands">
              <Button type="submit" disabled={busy || !packageInput}>
                {t('安装')}
              </Button>
              <Button
                type="button"
                disabled={busy || !packageInput}
                onClick={() => void start('upgrade')}
              >
                {t('升级')}
              </Button>
              <Button
                type="button"
                disabled={busy || !packageInput}
                onClick={() => void start('uninstall')}
              >
                {t('卸载')}
              </Button>
            </div>
          </form>
          <label>
            requirements
            <Input value={requirements} onChange={(event) => setRequirements(event.target.value)} />
          </label>
          <Button disabled={busy || !requirements} onClick={() => void start('requirements')}>
            {t('安装 requirements')}
          </Button>
          <Button disabled={busy} onClick={() => void start('editable')}>
            {t('安装当前项目（editable）')}
          </Button>
          {experiment.python?.manager === 'conda' && (
            <Button disabled={busy} onClick={() => void start('condaUpdate')}>
              {t('从 environment.yml 更新')}
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={() => void loadPackages()}>
            <RefreshCw size={13} />
            {t('刷新依赖')}
          </Button>
          <ul className="sf-python-packages">
            {packages.map((item) => (
              <li key={item.name}>
                <span>{item.name}</span>
                <code>{item.version}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {tab === 'tasks' && (
        <>
          {mine.map((task) => (
            <div className="sf-python-task" key={task.id}>
              <Button
                variant="ghost"
                aria-current={current?.id === task.id ? 'page' : undefined}
                onClick={() => setLogId(task.id)}
              >
                <span>
                  {task.kind} ·{' '}
                  {t(
                    task.status === 'running'
                      ? '运行中'
                      : task.status === 'completed'
                        ? '已完成'
                        : task.status === 'cancelled'
                          ? '已取消'
                          : '失败',
                  )}
                </span>
              </Button>
              {task.status === 'running' && (
                <Button
                  iconOnly
                  variant="ghost"
                  aria-label={t('停止环境任务')}
                  onClick={() =>
                    void developmentApi
                      .python(projectId, experiment.id, { action: 'stop', id: task.id })
                      .catch((e) => setError(describeError(e)))
                  }
                >
                  <Square size={13} />
                </Button>
              )}
              {task.status === 'completed' && task.environment && (
                <Button onClick={() => void select(task.environment!.executable)}>
                  {t('使用此环境')}
                </Button>
              )}
            </div>
          ))}
          {current && (
            <>
              <code className="sf-python-command">{JSON.stringify(current.command)}</code>
              <pre className="sf-python-log">{log}</pre>
            </>
          )}
        </>
      )}
    </section>
  );
}
