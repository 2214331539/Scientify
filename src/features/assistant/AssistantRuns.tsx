import { useState } from 'react';
import { useStore } from 'zustand';
import { ArrowUpRight, FileText, LoaderCircle, Square } from 'lucide-react';
import { Button, Dropdown } from '../../components/primitives';
import { Modal } from '../../components/Modal';
import { t, translateError } from '../../i18n';
import { ExecutionPanel } from '../../workspaces/experiments/ExecutionPanel';
import {
  executionStore,
  experimentApi,
  openExecution,
  describeError,
} from '../../workspaces/experiments/runtime';
import '../../workspaces/experiments/experiments.css';

export function AssistantRuns({
  projectId,
  conversationId,
}: {
  projectId: string;
  conversationId: string;
}) {
  const runs = useStore(executionStore, (s) => s.runs);
  const linked = runs
    .filter((run) => run.project === projectId && run.source?.conversationId === conversationId)
    .sort((a, b) => b.startedAt - a.startedAt);
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState('logs');
  const [stopping, setStopping] = useState<string[]>([]);
  const [error, setError] = useState('');
  const active = linked.find((run) => run.id === selected);
  if (!linked.length) return null;
  return (
    <section className="sf-ai-runs" aria-label={t('关联实验运行')}>
      <div className="sf-ai-runs-title">{t('关联实验运行')}</div>
      {linked.map((run) => (
        <div className="sf-ai-run" key={run.id}>
          <div className="sf-ai-run-heading">
            {run.status === 'running' ? (
              <LoaderCircle className="sf-ai-spinner" size={13} />
            ) : (
              <FileText size={13} />
            )}
            <span title={run.name}>{run.name}</span>
            <Button
              variant="ghost"
              iconOnly
              size="sm"
              aria-label={t('打开实验运行')}
              tooltip={t('打开实验运行')}
              onClick={() => openExecution(run.project, run.id)}
            >
              <ArrowUpRight size={14} />
            </Button>
            <Button
              variant="ghost"
              iconOnly
              size="sm"
              aria-label={t('查看日志与结果')}
              tooltip={t('查看日志与结果')}
              onClick={() => {
                setSelected(run.id);
                setTab('logs');
              }}
            >
              <FileText size={14} />
            </Button>
            {run.status === 'running' ? (
              <Button
                variant="ghost"
                iconOnly
                size="sm"
                disabled={stopping.includes(run.id)}
                aria-label={t('停止实验')}
                tooltip={t('停止实验')}
                onClick={async () => {
                  setStopping((s) => [...s, run.id]);
                  setError('');
                  try {
                    await experimentApi.stop(run.id);
                  } catch (reason) {
                    setError(describeError(reason));
                    setStopping((s) => s.filter((id) => id !== run.id));
                  }
                }}
              >
                <Square size={13} />
              </Button>
            ) : null}
          </div>
          <div className="sf-ai-run-meta">
            <code>{run.id.slice(0, 8)}</code>
            <span>
              {t(
                run.status === 'running'
                  ? '运行中'
                  : run.status === 'completed'
                    ? '已完成'
                    : run.status === 'cancelled'
                      ? '已取消'
                      : run.status === 'interrupted'
                        ? '已中断'
                        : '失败',
              )}
            </span>
            {run.exitCode !== null ? (
              <span>
                {t('退出码')}: {run.exitCode}
              </span>
            ) : null}
          </div>
          {run.error ? <p role="alert">{translateError(run.error)}</p> : null}
        </div>
      ))}
      {error ? <p role="alert">{translateError(error)}</p> : null}
      {active ? (
        <Modal title={active.name} onClose={() => setSelected('')}>
          <Dropdown
            aria-label={t('运行详情视图')}
            value={tab}
            onChange={(event) => setTab(event.target.value)}
          >
            <option value="logs">{t('日志')}</option>
            <option value="artifacts">{t('结果文件')}</option>
            <option value="environment">{t('运行信息')}</option>
          </Dropdown>
          <ExecutionPanel run={active} tab={tab} />
        </Modal>
      ) : null}
    </section>
  );
}
