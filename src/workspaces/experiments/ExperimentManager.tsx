import { useState } from 'react';
import { useStore } from 'zustand';
import {
  Archive,
  ArchiveRestore,
  FolderOpen,
  Pencil,
  Plus,
  Trash2,
  LayoutGrid,
  List,
  FlaskConical,
  ChevronRight,
} from 'lucide-react';
import type { Experiment, Project } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import { Button, Dropdown, Input, Textarea } from '../../components/primitives';
import { Modal } from '../../components/Modal';
import { confirmAction, requestText } from '../../components/prompts';
import { t, locale, translateError } from '../../i18n';
import { experimentsFor, experimentCatalog, registerExperiment } from './catalog';
import { describeError, type Execution } from './runtime';
import { developmentStore } from './development';

export function ExperimentManager({
  project,
  store,
  executions,
  onOpen,
}: {
  project: Project;
  store: WorkspaceStore;
  executions: Execution[];
  onOpen(experiment: Experiment): void;
}) {
  const data = useStore(store, (state) => state.data);
  const development = useStore(developmentStore);
  const experiments = experimentsFor(data, project.id);
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [layout, setLayout] = useState<'grid' | 'list'>(() => {
    try {
      return localStorage.getItem('scientify.experiments.layout.v1') === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });
  function selectLayout(next: 'grid' | 'list') {
    setLayout(next);
    try {
      localStorage.setItem('scientify.experiments.layout.v1', next);
    } catch {
      /* Optional preference. */
    }
  }
  async function edit(experiment: Experiment, action: 'rename' | 'archive' | 'remove') {
    setError('');
    const running = executions.some(
      (run) =>
        run.status === 'running' &&
        (run.experimentId === experiment.id ||
          (experiment.root && run.workspaceRoot === experiment.root)),
    );
    const chats = data?.sessions.filter((chat) => chat.experimentId === experiment.id) ?? [];
    if (
      action !== 'rename' &&
      (running ||
        development.terminals.some(
          (item) => item.experimentId === experiment.id && item.status === 'running',
        ) ||
        development.tasks.some(
          (item) => item.experimentId === experiment.id && item.status === 'running',
        ) ||
        chats.some((chat) => store.getState().agentTasks[`${project.id}:${chat.id}`]))
    ) {
      setError(t('请先停止此实验的 AI 和运行任务。'));
      return;
    }
    const name = action === 'rename' ? await requestText(t('重命名实验'), experiment.name) : null;
    if (action === 'rename' && !name?.trim()) return;
    if (
      action === 'remove' &&
      !(await confirmAction(t('移除实验登记？磁盘文件、Git 提交、AI 对话和运行记录会保留。')))
    )
      return;
    setBusy(true);
    try {
      const ok = await store.getState().update((draft) => {
        const target = draft.experiments?.find((e) => e.id === experiment.id);
        if (!target) throw new Error(t('实验不存在。'));
        if (action === 'remove')
          draft.experiments = draft.experiments?.filter((e) => e.id !== experiment.id);
        else {
          if (action === 'rename') target.name = name!.trim();
          else target.archived = !target.archived;
          target.updatedAt = new Date().toISOString();
        }
      });
      if (!ok) throw new Error(store.getState().error ?? t('保存失败'));
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  const visible = experiments.filter(
    (e) =>
      (archived || !e.archived) &&
      `${e.name} ${e.purpose}`.toLowerCase().includes(query.toLowerCase()),
  );
  const actions = (experiment: Experiment) => (
    <div className="sf-experiment-row-actions">
      <Button
        variant="ghost"
        iconOnly
        tooltip={t('打开实验')}
        aria-label={t('打开实验')}
        disabled={busy || experiment.archived}
        onClick={() => onOpen(experiment)}
      >
        <FolderOpen size={15} />
      </Button>
      <Button
        variant="ghost"
        iconOnly
        tooltip={t('重命名实验')}
        aria-label={t('重命名实验')}
        disabled={busy}
        onClick={() => void edit(experiment, 'rename')}
      >
        <Pencil size={15} />
      </Button>
      <Button
        variant="ghost"
        iconOnly
        tooltip={t(experiment.archived ? '恢复实验' : '归档实验')}
        aria-label={t(experiment.archived ? '恢复实验' : '归档实验')}
        disabled={busy}
        onClick={() => void edit(experiment, 'archive')}
      >
        {experiment.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
      </Button>
      <Button
        variant="ghost"
        iconOnly
        tooltip={t('移除实验')}
        aria-label={t('移除实验')}
        disabled={busy}
        onClick={() => void edit(experiment, 'remove')}
      >
        <Trash2 size={15} />
      </Button>
    </div>
  );
  const runsOf = (experiment: Experiment) =>
    executions
      .filter(
        (run) =>
          run.experimentId === experiment.id ||
          (!run.experimentId &&
            (experiment.root ? run.workspaceRoot === experiment.root : run.project === project.id)),
      )
      .sort((a, b) => b.startedAt - a.startedAt);
  return (
    <section className="sf-experiment-manager" aria-label={t('实验管理')}>
      <header className="sf-experiment-manager-toolbar">
        <h2>{t('实验管理')}</h2>
        <Input
          aria-label={t('搜索实验')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('搜索实验')}
        />
        <label>
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => setArchived(event.target.checked)}
          />
          {t('显示归档')}
        </label>
        <div
          className="sf-experiment-layout-switch"
          role="group"
          aria-label={t('实验显示方式')}
          data-view={layout}
        >
          <Button
            variant="ghost"
            iconOnly
            tooltip={t('卡片视图')}
            aria-label={t('卡片视图')}
            aria-pressed={layout === 'grid'}
            onClick={() => selectLayout('grid')}
          >
            <LayoutGrid size={16} />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            tooltip={t('列表视图')}
            aria-label={t('列表视图')}
            aria-pressed={layout === 'list'}
            onClick={() => selectLayout('list')}
          >
            <List size={16} />
          </Button>
        </div>
        <Button
          variant="primary"
          disabled={busy || !experimentCatalog.available()}
          onClick={() => setCreating(true)}
        >
          <Plus size={15} />
          {t('新建实验')}
        </Button>
      </header>
      {error && <p role="alert">{translateError(error)}</p>}
      {layout === 'grid' ? (
        <div className="sf-experiment-card-grid">
          {visible.map((experiment) => {
            const runs = runsOf(experiment);
            const running = runs.filter((r) => r.status === 'running').length;
            const terminals = development.terminals.filter(
              (item) => item.experimentId === experiment.id && item.status === 'running',
            ).length;
            const environmentTasks = development.tasks.filter(
              (item) => item.experimentId === experiment.id && item.status === 'running',
            ).length;
            const activeCount = running + terminals + environmentTasks;
            return (
              <article
                key={experiment.id}
                className={'sf-experiment-card' + (experiment.archived ? ' is-archived' : '')}
              >
                <header>
                  <FlaskConical size={22} />
                  <Button
                    variant="ghost"
                    disabled={experiment.archived}
                    onClick={() => onOpen(experiment)}
                  >
                    <span title={experiment.name}>{experiment.name}</span>
                  </Button>
                </header>
                <p className="sf-experiment-card-purpose">{experiment.purpose || t('默认实验')}</p>
                <div className="sf-experiment-card-meta">
                  <span>
                    {experiment.python
                      ? `Python ${experiment.python.version} · ${experiment.python.manager}`
                      : t('未配置 Python')}
                  </span>
                  <span>
                    {experiment.archived
                      ? t('已归档')
                      : activeCount
                        ? t('{count} 个活动任务', { count: activeCount })
                        : t('暂无活动任务')}
                  </span>
                </div>
                <details>
                  <summary className="sf-disclosure">
                    <ChevronRight size={14} aria-hidden="true" />
                    {t('实验详情')}
                  </summary>
                  <dl>
                    <dt>{t('代码目录')}</dt>
                    <dd>{experiment.root || project.path || project.repo || t('应用托管目录')}</dd>
                    <dt>{t('当前解释器')}</dt>
                    <dd>{experiment.python?.executable || t('未配置')}</dd>
                    <dt>{t('最近运行')}</dt>
                    <dd>{runs[0]?.name || '—'}</dd>
                    <dt>{t('更新时间')}</dt>
                    <dd>
                      {experiment.updatedAt
                        ? new Date(experiment.updatedAt).toLocaleDateString(locale())
                        : '—'}
                    </dd>
                  </dl>
                </details>
                <footer>{actions(experiment)}</footer>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="sf-experiment-table-scroll">
          <table className="sf-experiment-table">
            <thead>
              <tr>
                {['实验', '代码目录', 'Python', '最近运行', '更新时间', '操作'].map((label) => (
                  <th key={label} scope="col">
                    {t(label)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((experiment) => {
                const runs = executions
                  .filter(
                    (run) =>
                      run.experimentId === experiment.id ||
                      (!run.experimentId &&
                        (experiment.root
                          ? run.workspaceRoot === experiment.root
                          : run.project === project.id)),
                  )
                  .sort((a, b) => b.startedAt - a.startedAt);
                const latest = runs.find((run) => run.status === 'running') ?? runs[0];
                return (
                  <tr key={experiment.id} className={experiment.archived ? 'is-archived' : ''}>
                    <td>
                      <Button
                        variant="ghost"
                        disabled={experiment.archived}
                        onClick={() => onOpen(experiment)}
                      >
                        <span title={experiment.name}>{experiment.name}</span>
                      </Button>
                      {experiment.purpose && <small>{experiment.purpose}</small>}
                    </td>
                    <td title={experiment.root || project.path || project.repo}>
                      <span>
                        {experiment.root || project.path || project.repo || t('应用托管目录')}
                      </span>
                    </td>
                    <td>
                      {experiment.python
                        ? `${experiment.python.version} · ${experiment.python.manager}`
                        : t('未配置')}
                    </td>
                    <td>
                      {latest
                        ? `${latest.name} · ${t(latest.status === 'running' ? '运行中' : latest.status === 'completed' ? '已完成' : latest.status === 'failed' ? '失败' : '已结束')}`
                        : '—'}
                    </td>
                    <td>
                      {experiment.updatedAt
                        ? new Date(experiment.updatedAt).toLocaleDateString(locale())
                        : '—'}
                    </td>
                    <td>{actions(experiment)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!visible.length && <p className="sf-git-empty">{t('暂无实验')}</p>}
      {creating && (
        <ExperimentForm
          project={project}
          store={store}
          onClose={() => setCreating(false)}
          onSaved={(experiment) => {
            setCreating(false);
            onOpen(experiment);
          }}
        />
      )}
    </section>
  );
}

function ExperimentForm({
  project,
  store,
  onClose,
  onSaved,
}: {
  project: Project;
  store: WorkspaceStore;
  onClose(): void;
  onSaved(experiment: Experiment): void;
}) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [source, setSource] = useState<'empty' | 'existing'>('empty');
  const [directory, setDirectory] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    if (!name.trim() || (source === 'existing' && !directory)) return;
    setSaving(true);
    setError('');
    try {
      onSaved(
        await registerExperiment(store, project.id, name, purpose, source, directory || undefined),
      );
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title={t('新建实验')} onClose={onClose} busy={saving} dirty={dirty}>
      <form
        className="sf-experiment-config-form"
        onChange={() => setDirty(true)}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={saving}>
          <label>
            {t('实验名称')}
            <Input
              autoFocus
              required
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            {t('实验目的')}
            <Textarea
              rows={3}
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
            />
          </label>
          <label>
            {t('代码来源')}
            <Dropdown
              value={source}
              onChange={(event) => setSource(event.target.value as typeof source)}
            >
              <option value="empty">{t('新建空目录')}</option>
              <option value="existing">{t('关联已有目录 / worktree')}</option>
            </Dropdown>
          </label>
          {source === 'existing' && (
            <label>
              {t('代码目录')}
              <div className="sf-experiment-directory-input">
                <Input
                  required
                  value={directory}
                  onChange={(event) => setDirectory(event.target.value)}
                />
                <Button
                  type="button"
                  iconOnly
                  aria-label={t('选择目录')}
                  onClick={async () => {
                    try {
                      const value = await store.getState().chooseDirectory();
                      if (value) {
                        setDirectory(value);
                        setDirty(true);
                      }
                    } catch (reason) {
                      setError(describeError(reason));
                    }
                  }}
                >
                  <FolderOpen size={16} />
                </Button>
              </div>
            </label>
          )}
        </fieldset>
        {error && <p role="alert">{translateError(error)}</p>}
        <footer>
          <span className="spacer" />
          <Button type="button" disabled={saving} onClick={onClose}>
            {t('取消')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={saving || !name.trim() || (source === 'existing' && !directory)}
          >
            {t(saving ? '保存中…' : '创建实验')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
