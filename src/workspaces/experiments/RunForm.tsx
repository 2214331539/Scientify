import { t, translateError } from '../../i18n';
import { Button, Input, Textarea, Dropdown } from '../../components/primitives';
import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { Entity, Project } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import { confirmAction } from '../../components/prompts';
import { Modal } from '../../components/Modal';
import { MANUAL_STATUSES, statusLabel } from './status';
import './runs.css';

type Run = Entity & { project: string };
type Metric = { name: string; value: number | null; [key: string]: unknown };
const str = (value: unknown) => (typeof value === 'string' ? value : '');
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
              {!MANUAL_STATUSES.includes(fields.status) ? (
                <option value={fields.status}>{statusLabel(fields.status)}</option>
              ) : null}
              {MANUAL_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {statusLabel(value)}
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
