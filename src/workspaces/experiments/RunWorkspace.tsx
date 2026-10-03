import { t, translateError } from '../../i18n';
import { Badge, Button, Input, Textarea, Dropdown } from '../../components/primitives';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Panel } from '../../components/layout/Panel';
import { Section } from '../../components/workspace/Section';
import { ResourceList, ResourceRow } from '../../components/workspace/ResourceList';
import type { Entity, Project } from '../../domain/workspace';
import type { WorkContext } from '../../domain/context';
import type { WorkspaceStore } from '../../stores/workspace';
import { confirmAction } from '../../components/prompts';
import { Modal } from '../../components/Modal';
import './runs.css';

type Run = Entity & { project: string };
type Metric = { name: string; value: number | null; [key: string]: unknown };
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const statuses: Record<string, string> = {
  planned: '计划中',
  running: '进行中',
  completed: '已完成',
  failed: '未成功',
};
export function metricsOf(run?: Run): Metric[] {
  return Array.isArray(run?.metrics)
    ? run.metrics.filter(
        (metric): metric is Metric =>
          !!metric &&
          typeof metric.name === 'string' &&
          (metric.value === null || typeof metric.value === 'number'),
      )
    : [];
}

export function RunWorkspace({
  project,
  store,
  onContext,
  selectedRunId,
  onSelect,
}: {
  project: Project;
  store: WorkspaceStore;
  onContext: (context: WorkContext) => void;
  selectedRunId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const source = useStore(store, (state) => state.data?.runs);
  const runs = (source ?? [])
    .filter((run) => run.project === project.id)
    .sort((a, b) => str(b.updatedAt).localeCompare(str(a.updatedAt)));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Run | 'new' | null>(null);
  const selected =
    runs.find((run) => run.id === (selectedRunId === undefined ? selectedId : selectedRunId)) ??
    runs[0];
  function selectRun(id: string) {
    setSelectedId(id);
    onSelect?.(id);
  }
  const contextCallback = useRef(onContext);
  contextCallback.current = onContext;
  useEffect(() => {
    contextCallback.current({
      projectId: project.id,
      workspace: 'experiments',
      title: selected ? str(selected.name) : t('实验记录'),
      resourceId: selected?.id,
      text: selected
        ? [
            str(selected.protocol),
            str(selected.config),
            metricsOf(selected)
              .map((metric) => `${metric.name}: ${metric.value ?? t('未填写')}`)
              .join('\n'),
            str(selected.conclusion),
          ]
            .filter(Boolean)
            .join('\n\n')
        : undefined,
    });
  }, [project.id, selected]);
  useEffect(() => {
    setSelectedId(null);
    setEditing(null);
  }, [project.id]);
  return (
    <Panel
      className="sf-runs-workspace"
      aria-label={t('实验记录工作区')}
      header={
        <>
          <span>{t('Runs')}</span>
          <span className="muted">{t('{count} 条 · 手动记录', { count: runs.length })}</span>
          <span className="spacer" />
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus size={14} />
            {t('新建记录')}
          </Button>
        </>
      }
    >
      {runs.length ? (
        <div className="sf-runs-content">
          <ResourceList className="sf-runs-list" label={t('实验记录列表')}>
            {runs.map((run) => (
              <ResourceRow
                key={run.id}
                className="sf-run-resource"
                selected={selected?.id === run.id}
                onClick={() => selectRun(run.id)}
                aria-pressed={selected?.id === run.id}
              >
                <span>
                  <strong>{str(run.name) || t('未命名实验')}</strong>
                  <Badge>{t(statuses[str(run.status)] ?? str(run.status))}</Badge>
                </span>
                <time>{str(run.updatedAt).slice(0, 10)}</time>
              </ResourceRow>
            ))}
          </ResourceList>
          {selected ? (
            <article className="sf-run-detail">
              <header>
                <div>
                  <Badge>{t(statuses[str(selected.status)] ?? str(selected.status))}</Badge>
                  <h3>{str(selected.name)}</h3>
                </div>
                <Button onClick={() => setEditing(selected)}>
                  <Pencil size={14} />
                  {t('编辑记录')}
                </Button>
              </header>
              <Section title={t('实验方案')}>
                <p>{str(selected.protocol) || t('尚未记录实验方案')}</p>
              </Section>
              <Section title={t('配置与参数')}>
                {str(selected.config) ? (
                  <pre>{str(selected.config)}</pre>
                ) : (
                  <p className="sf-run-muted">{t('尚未记录配置')}</p>
                )}
              </Section>
              <Section title={t('指标')}>
                {metricsOf(selected).length ? (
                  <table>
                    <thead>
                      <tr>
                        <th>{t('指标名称')}</th>
                        <th>{t('数值')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metricsOf(selected).map((metric, index) => (
                        <tr key={index}>
                          <td>{metric.name}</td>
                          <td>{metric.value ?? t('未填写')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="sf-run-muted">{t('尚未记录指标')}</p>
                )}
              </Section>
              <Section title={t('结果与结论')}>
                <p>{str(selected.conclusion) || t('尚未记录结论')}</p>
              </Section>
              <footer>
                {t('状态与结果由你手动记录 · 更新于')}{' '}
                {str(selected.updatedAt).replace('T', ' ').slice(0, 16)}
              </footer>
            </article>
          ) : null}
        </div>
      ) : (
        <div className="sf-runs-empty">
          <h3>{t('暂无实验记录')}</h3>

          <Button onClick={() => setEditing('new')}>
            <Plus size={14} />
            {t('新建记录')}
          </Button>
        </div>
      )}
      {editing ? (
        <RunForm
          key={editing === 'new' ? `${project.id}:new` : editing.id}
          project={project}
          store={store}
          initial={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            selectRun(id);
            setEditing(null);
          }}
        />
      ) : null}
    </Panel>
  );
}

export function RunForm({
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
  initial?: Run;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const lockedExecution = !!initial?.executionId;
  const [fields, setFields] = useState(() => ({
    name: str(initial?.name),
    protocol: str(initial?.protocol),
    config: str(initial?.config),
    conclusion: str(initial?.conclusion),
    status: str(initial?.status) || 'planned',
  }));
  const [metrics, setMetrics] = useState(() =>
    metricsOf(initial).map((metric) => ({
      ...metric,
      text: metric.value === null ? '' : String(metric.value),
    })),
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirtySource = `run-form:${project.id}:${initial?.id ?? 'new'}`;
  useEffect(() => {
    store.getState().setDirtySource(dirtySource, dirty);
  }, [store, dirtySource, dirty]);
  useEffect(
    () => () => {
      store.getState().setDirtySource(dirtySource, false);
    },
    [store, dirtySource],
  );
  function edit(key: keyof typeof fields, value: string) {
    setFields((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }
  function editMetric(index: number, key: 'name' | 'text', value: string) {
    setMetrics((current) =>
      current.map((metric, position) =>
        index === position ? { ...metric, [key]: value } : metric,
      ),
    );
    setDirty(true);
  }
  async function save() {
    if (!fields.name.trim()) {
      setError(t('请输入实验名称。'));
      return;
    }
    const invalid = metrics.find(
      (metric) =>
        !metric.name.trim() || (metric.text.trim() !== '' && !Number.isFinite(Number(metric.text))),
    );
    if (invalid) {
      setError(t('每项指标需有名称，数值应为有限数字，也可以留空。'));
      return;
    }
    const id = initial?.id ?? crypto.randomUUID();
    const values = metrics.map(({ text, ...metric }) => ({
      ...metric,
      name: metric.name.trim(),
      value: text.trim() === '' ? null : Number(text),
    }));
    setSaving(true);
    setError('');
    const success = await store.getState().update((draft) => {
      const index = draft.runs.findIndex((run) => run.id === id && run.project === project.id);
      const saved = {
        ...(index >= 0 ? draft.runs[index] : (initial ?? {})),
        ...fields,
        id,
        project: project.id,
        ...(experimentId ? { experimentId } : {}),
        name: fields.name.trim(),
        metrics: values,
        updatedAt: new Date().toISOString(),
      };
      if (index >= 0) draft.runs[index] = saved;
      else draft.runs.push(saved);
    });
    setSaving(false);
    if (success) {
      store.getState().setDirtySource(dirtySource, false);
      onSaved(id);
    } else setError(store.getState().error || t('保存未完成，请稍后重试。当前输入已保留。'));
  }
  return (
    <Modal
      title={initial ? t('编辑实验记录') : t('新建实验记录')}
      onClose={onClose}
      busy={saving}
      dirty={dirty}
    >
      <form
        className="sf-run-form"
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
              disabled={lockedExecution}
              value={fields.name}
              onChange={(event) => edit('name', event.target.value)}
              placeholder={t('例如：不同学习率对收敛速度的影响')}
            />
          </label>
          <label>
            {t(lockedExecution ? '执行状态（只读）' : '状态（手动标记）')}
            <Dropdown
              disabled={lockedExecution}
              value={fields.status}
              onChange={(event) => edit('status', event.target.value)}
            >
              {!statuses[fields.status] ? (
                <option value={fields.status}>{fields.status}</option>
              ) : null}
              {Object.entries(statuses).map(([value, label]) => (
                <option key={value} value={value}>
                  {t(label)}
                </option>
              ))}
            </Dropdown>
          </label>
          <label>
            {t('实验方案')}
            <Textarea
              rows={3}
              value={fields.protocol}
              onChange={(event) => edit('protocol', event.target.value)}
              placeholder={t('研究问题、变量与对照方法')}
            />
          </label>
          <label>
            {t('配置与参数')}
            <Textarea
              className="sf-run-config-input"
              rows={3}
              disabled={lockedExecution}
              value={fields.config}
              onChange={(event) => edit('config', event.target.value)}
              placeholder={t('记录命令、环境与超参数')}
            />
          </label>
          <div className="sf-run-metric-heading">
            <span>{t('指标')}</span>
            <Button
              type="button"
              onClick={() => {
                setMetrics((current) => [...current, { name: '', value: null, text: '' }]);
                setDirty(true);
              }}
            >
              <Plus size={13} />
              {t('添加指标')}
            </Button>
          </div>
          {metrics.map((metric, index) => (
            <div className="sf-run-metric-row" key={index}>
              <Input
                aria-label={t('指标 {index} 名称', { index: index + 1 })}
                placeholder={t('指标名称')}
                value={metric.name}
                onChange={(event) => editMetric(index, 'name', event.target.value)}
              />
              <Input
                aria-label={t('指标 {index} 数值', { index: index + 1 })}
                inputMode="decimal"
                placeholder={t('数值（可留空）')}
                value={metric.text}
                onChange={(event) => editMetric(index, 'text', event.target.value)}
              />
              <Button
                variant="ghost"
                iconOnly
                type="button"
                aria-label={t('删除指标 {index}', { index: index + 1 })}
                onClick={() => {
                  setMetrics((current) => current.filter((_, position) => position !== index));
                  setDirty(true);
                }}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
          <label>
            {t('结果与结论')}
            <Textarea
              rows={4}
              value={fields.conclusion}
              onChange={(event) => edit('conclusion', event.target.value)}
              placeholder={t('观察结果、解释与下一步验证')}
            />
          </label>
        </fieldset>
        {error ? (
          <p role="alert" className="sf-run-form-error">
            {translateError(error)}
          </p>
        ) : null}
        <footer>
          <span>
            {saving
              ? t('正在保存到本机…')
              : dirty
                ? t('有未保存修改')
                : t('仅保存记录，不执行代码')}
          </span>
          <Button
            type="button"
            disabled={saving}
            onClick={async () => {
              if (!dirty || (await confirmAction(t('放弃尚未保存的修改？')))) onClose();
            }}
          >
            {t('取消')}
          </Button>
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? t('保存中…') : t('保存实验记录')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
