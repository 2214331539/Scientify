import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { ArrowLeft, Columns3, Pencil, Plus, RotateCcw } from 'lucide-react';
import { Button, Dropdown, Input } from '../../components/primitives';
import type { Entity, Project } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import type { WorkContext } from '../../domain/context';
import { t } from '../../i18n';
import { confirmAction } from '../../components/prompts';
import { RunForm, metricsOf } from './RunWorkspace';
import { ExecutionPanel } from './ExecutionPanel';
import type { Execution } from './runtime';
type Record = Entity & { project: string };
const text = (v: unknown) => (typeof v === 'string' ? v : '');
const labels: { [key: string]: string } = {
  planned: '计划中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};
export function ExperimentRuns({
  project,
  experimentId,
  store,
  executions,
  selectedId,
  onSelect,
  onContext,
  onRerun,
}: {
  project: Project;
  experimentId?: string;
  store: WorkspaceStore;
  executions: Execution[];
  selectedId?: string | null;
  onSelect(id: string): void;
  onContext(context: WorkContext): void;
  onRerun(run: Execution): void;
}) {
  const records = useStore(store, (s) => s.data?.runs);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [checked, setChecked] = useState<string[]>([]);
  const [compare, setCompare] = useState(false);
  const [editing, setEditing] = useState<Record | 'new' | null>(null);
  const [tab, setTab] = useState('results');
  const native = new Map(executions.map((r) => [r.id, r]));
  const runs: Record[] = (records ?? [])
    .filter(
      (r) =>
        r.project === project.id &&
        (!experimentId ||
          r.experimentId === experimentId ||
          (!r.experimentId && experimentId === project.id)) &&
        !native.has(r.id),
    )
    .concat(
      executions.map((r) => ({
        ...(records?.find((v) => v.id === r.id) ?? {}),
        id: r.id,
        project: r.project,
        experimentId: r.experimentId,
        name: r.name,
        status: r.status,
        executionId: r.id,
        config: JSON.stringify(r.configuration, null, 2),
        updatedAt: new Date(r.startedAt).toISOString(),
      })),
    )
    .sort((a, b) => text(b.updatedAt).localeCompare(text(a.updatedAt)));
  const selected = runs.find((r) => r.id === selectedId) ?? runs[0];
  const execution = selected ? native.get(selected.id) : undefined;
  const visible = runs.filter(
    (r) =>
      (filter === 'all' || (filter === 'manual' ? !native.has(r.id) : text(r.status) === filter)) &&
      text(r.name).toLowerCase().includes(query.toLowerCase()),
  );
  const compared = checked
    .map((id) => runs.find((r) => r.id === id))
    .filter((r): r is Record => !!r);
  const contextText = [
    text(selected?.protocol),
    text(selected?.config),
    metricsOf(selected)
      .map((metric) => metric.name + ': ' + (metric.value ?? '—'))
      .join('\n'),
    text(selected?.conclusion),
  ].join('\n\n');
  useEffect(() => {
    if (selected)
      onContext({
        projectId: project.id,
        workspace: 'experiments',
        resourceId: selected.id,
        title: text(selected.name),
        experimentId,
        workspaceRoot: execution?.workspaceRoot,
        text: contextText,
      });
  }, [project.id, selected?.id, selected?.name, contextText, onContext]);
  async function importMetrics(metrics: { name: string; value: number }[]) {
    if (!selected) return;
    if (
      metricsOf(selected).length &&
      !(await confirmAction(t('导入指标将替换此记录的已有指标，继续？')))
    )
      return;
    const ok = await store.getState().update((draft) => {
      const index = draft.runs.findIndex((r) => r.id === selected.id);
      const record = { ...selected, metrics, updatedAt: new Date().toISOString() };
      if (index < 0) draft.runs.push(record);
      else draft.runs[index] = record;
    });
    if (!ok) throw new Error(store.getState().error || '指标保存失败。');
    setTab('results');
  }
  return (
    <div className="sf-experiment-runs">
      <div className="sf-experiment-list-toolbar">
        {compare ? (
          <Button onClick={() => setCompare(false)}>
            <ArrowLeft size={14} />
            {t('返回列表')}
          </Button>
        ) : (
          <>
            <Input
              aria-label={t('搜索实验记录')}
              placeholder={t('搜索运行…')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Dropdown
              aria-label={t('筛选实验状态')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">{t('全部状态')}</option>
              <option value="running">{t('运行中')}</option>
              <option value="completed">{t('已完成')}</option>
              <option value="failed">{t('失败')}</option>
              <option value="manual">{t('手动记录')}</option>
            </Dropdown>
          </>
        )}
        <span className="spacer" />
        <Button disabled={compared.length < 2} onClick={() => setCompare(true)}>
          <Columns3 size={14} />
          {t('比较')} ({checked.length}/4)
        </Button>
        <Button onClick={() => setEditing('new')}>
          <Plus size={14} />
          {t('新建记录')}
        </Button>
      </div>
      {compare ? (
        <div className="sf-experiment-comparison">
          <table aria-label={t('运行比较')}>
            <thead>
              <tr>
                <th>{t('字段')}</th>
                {compared.map((r) => (
                  <th key={r.id}>{text(r.name)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                ...['来源', '状态', '配置与参数', '结果与结论'].map((name) => ({
                  kind: 'field',
                  name,
                })),
                ...[...new Set(compared.flatMap((r) => metricsOf(r).map((m) => m.name)))].map(
                  (name) => ({ kind: 'metric', name }),
                ),
              ].map((field) => (
                <tr key={field.kind + ':' + field.name}>
                  <th>{field.kind === 'metric' ? field.name : t(field.name)}</th>
                  {compared.map((r) => (
                    <td key={r.id}>
                      {field.kind === 'metric' ? (
                        (metricsOf(r).find((m) => m.name === field.name)?.value ?? '—')
                      ) : field.name === '来源' ? (
                        t(
                          native.get(r.id)?.source
                            ? 'AI 实验'
                            : native.has(r.id)
                              ? '本地运行'
                              : '手动记录',
                        )
                      ) : field.name === '状态' ? (
                        t(labels[text(r.status)] || text(r.status))
                      ) : field.name === '配置与参数' ? (
                        <pre>{text(r.config) || '—'}</pre>
                      ) : field.name === '结果与结论' ? (
                        text(r.conclusion) || '—'
                      ) : (
                        '—'
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="sf-experiment-runs-body">
          <div className="sf-experiment-table-wrap">
            <table aria-label={t('实验记录列表')}>
              <thead>
                <tr>
                  <th></th>
                  <th>{t('运行')}</th>
                  <th>{t('状态')}</th>
                  <th>{t('来源')}</th>
                  <th>{t('更新时间')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id} className={r.id === selected?.id ? 'is-selected' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={t('比较 {name}', { name: text(r.name) })}
                        checked={checked.includes(r.id)}
                        disabled={!checked.includes(r.id) && checked.length >= 4}
                        onChange={(e) =>
                          setChecked((ids) =>
                            e.target.checked ? [...ids, r.id] : ids.filter((id) => id !== r.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          onSelect(r.id);
                          setTab('results');
                        }}
                      >
                        {text(r.name) || t('未命名实验')}
                      </Button>
                    </td>
                    <td>{t(labels[text(r.status)] || text(r.status))}</td>
                    <td>
                      {t(
                        native.get(r.id)?.source
                          ? 'AI 实验'
                          : native.has(r.id)
                            ? '本地运行'
                            : '手动记录',
                      )}
                    </td>
                    <td>{text(r.updatedAt).slice(0, 16).replace('T', ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visible.length && <p className="sf-experiment-empty">{t('暂无实验记录')}</p>}
          </div>
          {selected && (
            <article className="sf-experiment-run-detail">
              <header>
                <div>
                  <small>{execution ? selected.id.slice(0, 8) : t('手动记录')}</small>
                  <h2>{text(selected.name)}</h2>
                </div>
                <Button
                  iconOnly
                  aria-label={t('编辑记录')}
                  tooltip={t('编辑记录')}
                  onClick={() => setEditing(selected)}
                >
                  <Pencil size={14} />
                </Button>
                {execution && (
                  <Button
                    iconOnly
                    aria-label={t('再次运行')}
                    tooltip={t('再次运行')}
                    disabled={execution.status === 'running'}
                    onClick={() => onRerun(execution)}
                  >
                    <RotateCcw size={14} />
                  </Button>
                )}
              </header>
              <nav className="sf-experiment-detail-tabs">
                {(execution ? ['results', 'logs', 'artifacts', 'environment'] : ['results']).map(
                  (value) => (
                    <Button
                      key={value}
                      variant="ghost"
                      aria-current={tab === value ? 'page' : undefined}
                      onClick={() => setTab(value)}
                    >
                      {t(
                        (
                          {
                            results: '结果',
                            logs: '日志',
                            artifacts: '产物',
                            environment: '环境与版本',
                          } as { [key: string]: string }
                        )[value],
                      )}
                    </Button>
                  ),
                )}
              </nav>
              {tab === 'results' ? (
                <div className="sf-experiment-results">
                  <h3>{t('指标')}</h3>
                  <table>
                    <tbody>
                      {metricsOf(selected).map((m, i) => (
                        <tr key={i}>
                          <th>{m.name}</th>
                          <td>{m.value ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!metricsOf(selected).length && <p className="muted">{t('未填写')}</p>}
                  <h3>{t('实验方案')}</h3>
                  <p>{text(selected.protocol) || '—'}</p>
                  <h3>{t('配置与参数')}</h3>
                  <pre>{text(selected.config) || '—'}</pre>
                  <h3>{t('结果与结论')}</h3>
                  <p>{text(selected.conclusion) || '—'}</p>
                  {execution && (
                    <p className="muted">
                      {t('退出码')}：{execution.exitCode ?? '—'} ·{' '}
                      {Math.round(((execution.endedAt ?? Date.now()) - execution.startedAt) / 1000)}
                      s
                    </p>
                  )}
                </div>
              ) : (
                <ExecutionPanel run={execution} tab={tab} onMetrics={importMetrics} />
              )}
            </article>
          )}
        </div>
      )}
      {editing && (
        <RunForm
          project={project}
          experimentId={experimentId}
          store={store}
          initial={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            onSelect(id);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
