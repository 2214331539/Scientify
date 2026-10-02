import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { FileText, RefreshCw, Square } from 'lucide-react';
import { Button } from '../../components/primitives';
import { Modal } from '../../components/Modal';
import { t, translateError } from '../../i18n';
import type { ResearchFile } from '../../platform/research';
import { describeError, experimentApi, experimentOutput, type Execution } from './runtime';

export function ExecutionPanel({
  run,
  tab = 'logs',
  onMetrics,
}: {
  run?: Execution;
  tab?: string;
  onMetrics?: (metrics: { name: string; value: number }[]) => Promise<void>;
}) {
  const identity = useRef(run?.id);
  identity.current = run?.id;
  const [log, setLog] = useState('');
  const [files, setFiles] = useState<ResearchFile[]>([]);
  const [error, setError] = useState('');
  const [artifact, setArtifact] = useState<{ path: string; content: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const [stopping, setStopping] = useState(false);
  const outputRevision = useStore(experimentOutput, (s) => s.revisions[run?.id ?? ''] ?? 0);
  const logTicket = useRef(0);
  const logRef = useRef<HTMLPreElement>(null);
  const followLog = useRef(true);
  useEffect(() => {
    if (!run || tab !== 'logs' || !outputRevision) return;
    let alive = true;
    const ticket = ++logTicket.current;
    void experimentApi
      .log(run.id)
      .then((text) => {
        if (alive && ticket === logTicket.current) setLog(text);
      })
      .catch((e) => {
        if (alive) setError(describeError(e));
      });
    return () => {
      alive = false;
    };
  }, [run?.id, tab, outputRevision]);
  useEffect(() => {
    if (followLog.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);
  useEffect(() => {
    setLog('');
    setFiles([]);
    setError('');
    setArtifact(null);
    setStopping(false);
    followLog.current = true;
    if (!run) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        if (tab === 'logs') {
          const ticket = ++logTicket.current;
          const text = await experimentApi.log(run!.id);
          if (alive && ticket === logTicket.current) setLog(text);
        }
        if (tab === 'artifacts') {
          const result = await experimentApi.artifacts(run!.id);
          if (alive) setFiles(result.filter((f) => f.kind === 'file'));
        }
        if (alive) setError('');
      } catch (e) {
        if (alive) setError(describeError(e));
      }
      if (alive && run!.status === 'running') timer = setTimeout(() => void read(), 1000);
    }
    void read();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [run?.id, run?.status, tab, revision]);
  if (!run) return <p className="sf-experiment-empty">{t('尚无本地运行')}</p>;
  return (
    <div className="sf-execution-panel">
      <div className="sf-execution-toolbar">
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
        <span className="spacer" />
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('刷新运行输出')}
          onClick={() => setRevision((v) => v + 1)}
        >
          <RefreshCw size={14} />
        </Button>
        {run.status === 'running' && (
          <Button
            disabled={stopping}
            onClick={async () => {
              setStopping(true);
              try {
                await experimentApi.stop(run.id);
              } catch (e) {
                setError(describeError(e));
                setStopping(false);
              }
            }}
          >
            <Square size={12} />
            {t(stopping ? '停止中…' : '停止')}
          </Button>
        )}
      </div>
      {error || run.error ? <p role="alert">{translateError(error || run.error || '')}</p> : null}
      {tab === 'logs' && (
        <pre
          ref={logRef}
          className="sf-execution-log"
          aria-label={t('只读运行日志')}
          onScroll={(event) => {
            const el = event.currentTarget;
            followLog.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
        >
          {log || t('暂无输出')}
        </pre>
      )}
      {tab === 'environment' && (
        <dl className="sf-execution-definition">
          <dt>{t('可执行程序')}</dt>
          <dd>{run.executable}</dd>
          <dt>{t('参数')}</dt>
          <dd>
            <code>{JSON.stringify(run.configuration.args)}</code>
          </dd>
          <dt>{t('工作目录')}</dt>
          <dd>{run.directory}</dd>
          <dt>{t('平台')}</dt>
          <dd>{run.platform}</dd>
          <dt>{t('执行权限')}</dt>
          <dd>
            {t(run.permission === 'workspace-write' ? '工作区沙箱 · 网络关闭' : '旧版用户权限运行')}
          </dd>
          {run.source ? (
            <>
              <dt>{t('来源会话')}</dt>
              <dd>
                <code>{run.source.conversationId}</code>
              </dd>
              <dt>{t('来源任务')}</dt>
              <dd>
                <code>{run.source.turnId}</code>
              </dd>
            </>
          ) : null}
          <dt>{t('Git 提交')}</dt>
          <dd>{run.gitCommit || t('未记录')}</dd>
          <dt>{t('启动时变更')}</dt>
          <dd>
            <pre>{run.gitChanges.join('\n') || '—'}</pre>
          </dd>
          <dt>{t('退出码')}</dt>
          <dd>{run.exitCode ?? '—'}</dd>
        </dl>
      )}
      {tab === 'artifacts' && (
        <div className="sf-execution-artifacts">
          {files.length ? (
            files.map((file) => (
              <div key={file.path}>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    try {
                      const result = await experimentApi.artifact(run.id, file.path);
                      if (identity.current === run.id) setArtifact(result);
                    } catch (e) {
                      if (identity.current === run.id) setError(describeError(e));
                    }
                  }}
                >
                  <FileText size={14} />
                  {file.path}
                </Button>
                {onMetrics && file.path.endsWith('.json') && (
                  <Button
                    onClick={async () => {
                      try {
                        const result = await experimentApi.artifact(run.id, file.path);
                        if (identity.current === run.id)
                          await onMetrics(numericMetrics(JSON.parse(result.content)));
                      } catch (e) {
                        if (identity.current === run.id) setError(describeError(e));
                      }
                    }}
                  >
                    {t('导入指标')}
                  </Button>
                )}
              </div>
            ))
          ) : (
            <p>{t('暂无运行产物')}</p>
          )}
        </div>
      )}
      {artifact && (
        <Modal title={artifact.path} onClose={() => setArtifact(null)}>
          <pre className="sf-artifact-preview">{artifact.content}</pre>
        </Modal>
      )}
    </div>
  );
}
export function numericMetrics(value: unknown): { name: string; value: number }[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('指标文件需为 JSON 对象，字段值为有限数字。');
  const metrics = Object.entries(value).map(([name, value]) => {
    if (!name.trim() || typeof value !== 'number' || !Number.isFinite(value))
      throw new Error('指标文件需为 JSON 对象，字段值为有限数字。');
    return { name, value };
  });
  if (!metrics.length || metrics.length > 100) throw new Error('指标文件需包含 1 至 100 项指标。');
  return metrics;
}
