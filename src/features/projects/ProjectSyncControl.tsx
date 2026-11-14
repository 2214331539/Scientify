import { useState } from 'react';
import { useStore } from 'zustand';
import { Cloud, CloudOff, RefreshCw, AlertCircle, UsersRound } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/primitives';
import { confirmAction } from '../../components/prompts';
import { t, locale, translateError } from '../../i18n';
import type { Project } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import {
  collaboration,
  canEditProject,
  requestSignIn,
  requestProjectSync,
  type SyncConflict,
  type ConflictPreview,
  type ConflictChoice,
  type ConflictVersion,
  type CollaborationMember,
} from '../../platform/collaboration';
import { useProjectSync } from './useProjectSync';
import { maskPhone } from '../account/account';
import { roleName } from './ProjectDialogs';
import './project-sync.css';

function Version({ label, version }: { label: string; version: ConflictVersion }) {
  return (
    <section>
      <h3>
        {label}
        <small>{t('{size} 字节', { size: version.bytes })}</small>
      </h3>
      {!version.exists ? (
        <p>{t('此版本不存在')}</p>
      ) : version.text === null ? (
        <p>{t('二进制文件不支持文本对比，可按版本选择保留。')}</p>
      ) : (
        <pre>{version.text}</pre>
      )}
      {version.truncated && <p>{t('内容较长，仅预览前 256 KB；保留操作使用完整文件。')}</p>}
    </section>
  );
}

export function ProjectSyncControl({
  project,
  store,
  automatic = false,
  trigger = 'status',
}: {
  project: Project;
  store: WorkspaceStore;
  automatic?: boolean;
  /** `share` shows a plain “Share” entry; problems are reported through notifications. */
  trigger?: 'status' | 'share';
}) {
  const sync = useProjectSync(project.id, store, automatic);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [members, setMembers] = useState<CollaborationMember[] | null>(null);
  const [comparison, setComparison] = useState<{
    conflict: SyncConflict;
    preview: ConflictPreview;
  } | null>(null);
  const dirty = useStore(store, (state) => state.dirty);
  const tasks = useStore(store, (state) => state.agentTasks);
  const blocked = dirty || Object.values(tasks).includes(project.id);
  const info = sync.info;
  const status = (() => {
    if (!sync.online) return t('离线');
    if (info?.paused) return t('本机同步已关闭');
    if (sync.error) return t('同步失败');
    if (!sync.account) return t('正在检查同步…');
    if (!sync.account.authenticated) return t('需要登录');
    if (!sync.account.enabled) return t('同步未启用');
    if (sync.syncing) return t('正在同步…');
    if (info?.lastError) return t('同步失败');
    if (info?.conflicts.length) return t('有冲突');
    if (info?.pending || info?.deferred) return t('等待同步');
    if (info?.skipped) return t('部分内容未同步');
    return info?.lastSyncAt ? t('已同步') : t('尚未同步');
  })();
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await sync.refresh();
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusy(false);
    }
  };
  const resolve = (choice: ConflictChoice) =>
    run(async () => {
      if (!comparison || blocked) return;
      if (
        choice !== 'both' &&
        !(await confirmAction(t('保留所选版本并移除另一份冲突副本？此更改将在下次同步时上传。')))
      )
        return;
      await collaboration.resolveConflict(
        project.id,
        comparison.conflict,
        comparison.preview.token,
        choice,
      );
      await store.getState().refreshSaved();
      requestProjectSync(project.id);
      setComparison(null);
    });
  return (
    <>
      <Button
        variant="ghost"
        className={trigger === 'share' ? 'sf-titlebar-tool' : 'project-sync-trigger'}
        aria-label={
          trigger === 'share'
            ? t('共享与同步：{status}', { status })
            : t('项目同步：{status}', { status })
        }
        onClick={() => {
          setOpen(true);
          void sync.refresh();
        }}
      >
        {trigger === 'share' ? (
          <>
            <UsersRound size={15} />
            <span>{t('共享')}</span>
          </>
        ) : (
          <>
            {sync.syncing ? (
              <RefreshCw className="sync-spinning" size={15} />
            ) : !sync.online || info?.paused ? (
              <CloudOff size={15} />
            ) : sync.error || info?.lastError || info?.conflicts.length ? (
              <AlertCircle size={15} />
            ) : (
              <Cloud size={15} />
            )}
            <span>{status}</span>
          </>
        )}
      </Button>
      {open && (
        <Modal
          title={comparison ? t('冲突对比') : t('项目同步')}
          className="project-sync-dialog"
          busy={busy}
          onClose={() => {
            setOpen(false);
            setComparison(null);
          }}
        >
          <div className="project-sync-content">
            <div className="project-sync-heading">
              <strong>{project.name}</strong>
              <span role="status">{status}</span>
            </div>
            {error || sync.error || info?.lastError ? (
              <p role="alert" className="error-text">
                {error || sync.error || translateError(info?.lastError ?? '')}
              </p>
            ) : null}
            {comparison ? (
              <>
                <Button variant="ghost" onClick={() => setComparison(null)}>
                  {t('返回同步面板')}
                </Button>
                <p className="sync-conflict-path">{comparison.conflict.path}</p>
                <p className="muted">
                  {t('右侧是当前已接收的远端版本；如果内容再次变化，需要重新打开对比。')}
                </p>
                <div className="sync-comparison">
                  <Version label={t('本机冲突副本')} version={comparison.preview.local} />
                  <Version label={t('远端版本')} version={comparison.preview.remote} />
                </div>
                {blocked && (
                  <p role="status">{t('请先保存草稿并结束此项目的 AI 任务，再处理冲突。')}</p>
                )}
                {!canEditProject(project, comparison.conflict.domain) && (
                  <p>{t('当前角色只能查看此冲突。')}</p>
                )}
                <div className="sync-actions">
                  {(['local', 'remote', 'both'] as const).map((choice) => (
                    <Button
                      key={choice}
                      disabled={
                        busy ||
                        blocked ||
                        !canEditProject(project, comparison.conflict.domain) ||
                        (choice === 'local' && !comparison.preview.canKeepLocal) ||
                        (choice === 'both' && !comparison.preview.canKeepBoth)
                      }
                      onClick={() => void resolve(choice)}
                    >
                      {t(
                        choice === 'local'
                          ? '保留本机'
                          : choice === 'remote'
                            ? '保留远端'
                            : '两份都保留',
                      )}
                    </Button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <dl className="sync-summary">
                  <dt>{t('上次同步')}</dt>
                  <dd>
                    {info?.lastSyncAt
                      ? new Date(info.lastSyncAt).toLocaleString(locale())
                      : t('尚未同步')}
                  </dd>
                  <dt>{t('等待上传')}</dt>
                  <dd>{info?.pending ?? '—'}</dd>
                  <dt>{t('已跟踪内容')}</dt>
                  <dd>{info?.tracked ?? '—'}</dd>
                </dl>
                {!!info?.skipped && (
                  <p role="status">
                    {t('上次同步跳过 {count} 项（例如超过 200 MB 的文件）。', {
                      count: info.skipped,
                    })}
                  </p>
                )}
                {!!info?.deferred && (
                  <p role="status">
                    {t('{count} 项暂缓同步，请等待目录中的任务结束后重试。', {
                      count: info.deferred,
                    })}
                  </p>
                )}
                <div className="sync-actions">
                  <Button
                    disabled={busy || !sync.online || !sync.account?.authenticated}
                    onClick={() =>
                      void run(async () =>
                        setMembers((await collaboration.members(project.id)).members),
                      )
                    }
                  >
                    {t('查看成员')}
                  </Button>
                  {!sync.account?.authenticated ? (
                    <Button onClick={requestSignIn}>{t('登录')}</Button>
                  ) : (
                    <Button
                      variant="primary"
                      disabled={
                        busy ||
                        sync.syncing ||
                        !sync.online ||
                        !sync.account.enabled ||
                        info?.paused
                      }
                      onClick={() => void sync.sync()}
                    >
                      {t('立即同步')}
                    </Button>
                  )}
                  <Button
                    disabled={busy || sync.syncing || !info}
                    onClick={() =>
                      void run(async () => {
                        if (
                          !info?.paused &&
                          !(await confirmAction(
                            t(
                              '关闭此设备上此项目的同步？本机和云端资料都会保留，其他设备继续同步。',
                            ),
                          ))
                        )
                          return;
                        await collaboration.setProjectSync(project.id, !!info?.paused);
                        if (info?.paused) requestProjectSync(project.id);
                      })
                    }
                  >
                    {t(info?.paused ? '开启本机同步' : '关闭本机同步')}
                  </Button>
                </div>
                <p className="muted">
                  {t('同步开关只影响当前设备，不删除资料，也不改变团队成员权限。')}
                </p>
                {members && (
                  <section>
                    <h3>{t('成员')}</h3>
                    <ul className="sync-conflicts">
                      {members.map((member) => (
                        <li key={member.id}>
                          <div>
                            <strong>
                              {member.id === sync.account?.userId
                                ? t('我')
                                : maskPhone(member.phone)}
                            </strong>
                            <small>
                              {roleName(member.role)}
                              {member.pending ? ` · ${t('待注册')}` : ''}
                            </small>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <h3>{t('待处理冲突')}</h3>
                {!info?.conflicts.length ? (
                  <p className="muted">{t('没有待处理冲突')}</p>
                ) : (
                  <ul className="sync-conflicts">
                    {info.conflicts.map((conflict) => (
                      <li key={`${conflict.domain}:${conflict.path}:${conflict.at}`}>
                        <div>
                          <strong>{conflict.path}</strong>
                          <small>{new Date(conflict.at).toLocaleString(locale())}</small>
                        </div>
                        <Button
                          disabled={busy || sync.syncing}
                          onClick={() =>
                            void run(async () =>
                              setComparison({
                                conflict,
                                preview: await collaboration.conflictPreview(project.id, conflict),
                              }),
                            )
                          }
                        >
                          {t('查看对比')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
