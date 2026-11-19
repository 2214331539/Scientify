import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Cloud, CloudOff, RefreshCw, AlertCircle, UsersRound } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/primitives';
import { Popover } from '../../components/primitives/Popover';
import { confirmAction } from '../../components/prompts';
import { t, translateError } from '../../i18n';
import type { Project } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import {
  collaboration,
  canEditProject,
  requestProjectSync,
  type SyncConflict,
  type ConflictPreview,
  type ConflictChoice,
  type ConflictVersion,
  type CollaborationMember,
} from '../../platform/collaboration';
import { useProjectSync } from './useProjectSync';
import { SharePanel } from './SharePanel';
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
  const button = useRef<HTMLButtonElement>(null);
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
    if (sync.error) return t('同步失败');
    if (!sync.account) return t('正在检查同步…');
    if (!sync.account.authenticated) return t('需要登录');
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
  // The members are part of what the panel shows, not something to ask for.
  const signedIn = !!sync.account?.authenticated;
  useEffect(() => {
    if (!open || !signedIn) return;
    let alive = true;
    void collaboration
      .members(project.id)
      .then((result) => alive && setMembers(result.members))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, signedIn, project.id]);
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
  const panel = (
    <SharePanel
      project={project}
      userId={sync.account?.userId}
      members={signedIn ? members : []}
      status={status}
      state={info}
      syncing={sync.syncing}
      online={sync.online}
      error={error || sync.error || translateError(info?.lastError ?? '')}
      busy={busy}
      onMembers={setMembers}
      onCompare={(conflict) =>
        void run(async () =>
          setComparison({
            conflict,
            preview: await collaboration.conflictPreview(project.id, conflict),
          }),
        )
      }
      run={run}
    />
  );
  const close = () => setOpen(false);
  return (
    <>
      <Button
        ref={button}
        variant="ghost"
        iconOnly={trigger === 'share'}
        data-tour={trigger === 'share' ? 'share' : undefined}
        className={trigger === 'share' ? undefined : 'project-sync-trigger'}
        aria-label={
          trigger === 'share'
            ? t('共享与同步：{status}', { status })
            : t('项目同步：{status}', { status })
        }
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          void sync.refresh();
        }}
      >
        {trigger === 'share' ? (
          <UsersRound />
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
      {/* In the title bar the panel drops down from its button, as share cards do. */}
      {open && trigger === 'share' ? (
        <Popover
          anchor={button.current}
          label={t('共享与同步')}
          width={440}
          align="end"
          onClose={close}
        >
          {panel}
        </Popover>
      ) : null}
      {open && trigger !== 'share' ? (
        <Modal title={t('项目同步')} className="project-sync-dialog" busy={busy} onClose={close}>
          {panel}
        </Modal>
      ) : null}
      {comparison ? (
        <Modal
          title={t('冲突对比')}
          className="sync-compare-dialog"
          busy={busy}
          onClose={() => setComparison(null)}
        >
          <div className="project-sync-content">
            {error ? (
              <p role="alert" className="error-text">
                {error}
              </p>
            ) : null}
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
          </div>
        </Modal>
      ) : null}
    </>
  );
}
