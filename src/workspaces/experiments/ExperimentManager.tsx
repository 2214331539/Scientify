import { canEditProject } from '../../platform/collaboration';
import { useState } from 'react';
import { useStore } from 'zustand';
import { Archive, ArchiveRestore, FolderOpen, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import type { Experiment, Project } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import { Button, Dropdown, Input, Textarea } from '../../components/primitives';
import { Modal } from '../../components/Modal';
import { confirmAction, requestText } from '../../components/prompts';
import { t, translateError } from '../../i18n';
import { relativeTime } from '../../features/projects/model';
import { statusLabel } from './status';
import { experimentsFor, experimentCatalog, registerExperiment } from './catalog';
import { type Execution } from './runtime';
import { developmentStore } from './development';
import { errorMessage } from '../../domain/errors';

/** Runs that belong to an experiment, newest first. */
export function runsOfExperiment(
  project: Project,
  experiment: Experiment,
  executions: Execution[],
) {
  return executions
    .filter(
      (run) =>
        run.experimentId === experiment.id ||
        (!run.experimentId &&
          (experiment.root ? run.workspaceRoot === experiment.root : run.project === project.id)),
    )
    .sort((a, b) => b.startedAt - a.startedAt);
}

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
  const readOnly = !canEditProject(project, 'code');
  const data = useStore(store, (state) => state.data);
  const development = useStore(developmentStore);
  const experiments = experimentsFor(data, project.id);
  const [query, setQuery] = useState('');
  const [archivedView, setArchivedView] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const archivedCount = experiments.filter((e) => e.archived).length;
  const archived = archivedView && archivedCount > 0;
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
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  const visible = experiments.filter(
    (e) =>
      !!e.archived === archived &&
      `${e.name} ${e.purpose}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section className="sf-page sf-experiment-manager" aria-label={t('实验管理')}>
      <header className="sf-page-head">
        <h1 className="sf-page-title">
          {t('全部实验')}
          <span className="sf-page-count">{visible.length}</span>
        </h1>
        <span className="spacer" />
        {archivedCount ? (
          <div className="sf-segmented" role="group" aria-label={t('实验状态')}>
            <Button variant="ghost" aria-pressed={!archived} onClick={() => setArchivedView(false)}>
              {t('进行中')}
            </Button>
            <Button variant="ghost" aria-pressed={archived} onClick={() => setArchivedView(true)}>
              {t('已归档')}
            </Button>
          </div>
        ) : null}
        <label className="sf-search-field">
          <Search />
          <Input
            aria-label={t('搜索实验')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('搜索实验')}
          />
        </label>
        <Button
          variant="primary"
          disabled={readOnly || busy || !experimentCatalog.available()}
          onClick={() => setCreating(true)}
        >
          <Plus size={15} />
          {t('新建实验')}
        </Button>
      </header>
      {error && (
        <p role="alert" className="sf-page-error">
          {translateError(error)}
        </p>
      )}
      {visible.length ? (
        <div className="sf-table-scroll">
          <table className="sf-table sf-experiment-table">
            <colgroup>
              <col />
              <col style={{ width: 128 }} />
              <col style={{ width: 150 }} />
              <col style={{ width: 168 }} />
              <col style={{ width: 96 }} />
              <col style={{ width: 132 }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">{t('实验')}</th>
                <th scope="col">{t('状态')}</th>
                <th scope="col">Python</th>
                <th scope="col">{t('最近运行')}</th>
                <th scope="col">{t('更新')}</th>
                <th scope="col">
                  <span className="sf-visually-hidden">{t('操作')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((experiment) => {
                const runs = runsOfExperiment(project, experiment, executions);
                const active =
                  runs.filter((r) => r.status === 'running').length +
                  development.terminals.filter(
                    (item) => item.experimentId === experiment.id && item.status === 'running',
                  ).length +
                  development.tasks.filter(
                    (item) => item.experimentId === experiment.id && item.status === 'running',
                  ).length;
                const latest = runs[0];
                const where = experiment.root || project.path || project.repo || '';
                return (
                  <tr
                    key={experiment.id}
                    className={experiment.archived ? 'is-archived' : ''}
                    onDoubleClick={() => {
                      if (!experiment.archived) onOpen(experiment);
                    }}
                  >
                    <td className="sf-experiment-name" title={where}>
                      <Button
                        variant="ghost"
                        disabled={experiment.archived}
                        onClick={() => onOpen(experiment)}
                      >
                        <span>{experiment.name}</span>
                      </Button>
                      {experiment.purpose ? <small>{experiment.purpose}</small> : null}
                    </td>
                    <td>
                      {experiment.archived ? (
                        t('已归档')
                      ) : active ? (
                        <span className="sf-state" data-status="running">
                          {t('{count} 个任务运行中', { count: active })}
                        </span>
                      ) : latest ? (
                        <span className="sf-state" data-status={latest.status}>
                          {statusLabel(latest.status)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {experiment.python
                        ? `${experiment.python.version} · ${experiment.python.manager}`
                        : t('未配置')}
                    </td>
                    <td>{latest?.name ?? '—'}</td>
                    <td>{relativeTime(experiment.updatedAt) || '—'}</td>
                    <td>
                      <div className="sf-row-actions">
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
                          disabled={readOnly || busy}
                          onClick={() => void edit(experiment, 'rename')}
                        >
                          <Pencil size={15} />
                        </Button>
                        <Button
                          variant="ghost"
                          iconOnly
                          tooltip={t(experiment.archived ? '恢复实验' : '归档实验')}
                          aria-label={t(experiment.archived ? '恢复实验' : '归档实验')}
                          disabled={readOnly || busy}
                          onClick={() => void edit(experiment, 'archive')}
                        >
                          {experiment.archived ? (
                            <ArchiveRestore size={15} />
                          ) : (
                            <Archive size={15} />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          iconOnly
                          tooltip={t('移除实验')}
                          aria-label={t('移除实验')}
                          disabled={readOnly || busy}
                          onClick={() => void edit(experiment, 'remove')}
                        >
                          <Trash2 size={15} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="sf-page-empty">{query ? t('没有匹配的实验') : t('暂无实验')}</div>
      )}
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

export function ExperimentForm({
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
      setError(errorMessage(reason));
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
                      setError(errorMessage(reason));
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
