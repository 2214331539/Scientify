import { useCallback, useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { Button, Input } from '../../components/primitives';
import { locale, t, translateError } from '../../i18n';
import type { WorkspaceStore } from '../../stores/workspace';
import {
  collaboration,
  collaborationStateEvent,
  isSyncedProject,
  requestSignIn,
  type CollaborationState,
  type ProjectSyncState,
} from '../../platform/collaboration';
import { maskPhone } from '../account/account';

function notifyCollaborationStateChanged() {
  window.dispatchEvent(new Event(collaborationStateEvent));
}

const kinds: Record<string, string> = {
  library: '文献',
  code: '代码',
  asset: '笔记图片',
  record: '笔记',
  run: '运行记录',
  experiment: '实验',
  project: '项目信息',
};
const recordKinds = ['project', 'record', 'experiment', 'run'];
const when = (value: string) => new Date(value).toLocaleString(locale());

export function CollaborationPreferences({ store }: { store: WorkspaceStore }) {
  const data = useStore(store, (s) => s.data);
  const synced = (data?.projects ?? []).filter(isSyncedProject);
  const syncedIds = synced.map((project) => project.id).join(',');
  const [state, setState] = useState<CollaborationState | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [syncStates, setSyncStates] = useState<Record<string, ProjectSyncState>>({});
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const next = await collaboration.status();
      setState(next);
      setEndpoint(next.endpoint);
      setEnabled(next.enabled);
      const ids = syncedIds ? syncedIds.split(',') : [];
      const entries = await Promise.all(
        ids.map(async (id) => [id, await collaboration.syncState(id).catch(() => null)] as const),
      );
      setSyncStates(
        Object.fromEntries(
          entries.filter((entry): entry is readonly [string, ProjectSyncState] => !!entry[1]),
        ),
      );
      setError('');
    } catch (reason) {
      setError(translateError(String(reason)));
    }
  }, [syncedIds]);
  useEffect(() => {
    void refresh();
    const update = () => void refresh();
    window.addEventListener(collaborationStateEvent, update);
    return () => window.removeEventListener(collaborationStateEvent, update);
  }, [refresh]);
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      setState(await collaboration.configure(endpoint, enabled));
      notifyCollaborationStateChanged();
    });
  const logout = () =>
    run(async () => {
      setState(await collaboration.logout());
      notifyCollaborationStateChanged();
    });
  const syncNow = async (projectId: string) => {
    setSyncing(projectId);
    setError('');
    try {
      const outcome = await collaboration.syncProject(projectId);
      if (outcome.changed.some((kind) => recordKinds.includes(kind)))
        await store.getState().refreshSaved();
      if (outcome.errors.length) setError(outcome.errors.map(translateError).join('\n'));
      notifyCollaborationStateChanged();
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setSyncing(null);
    }
  };
  const conflicts = synced
    .flatMap((project) =>
      (syncStates[project.id]?.conflicts ?? []).map((conflict) => ({
        ...conflict,
        project: project.name,
      })),
    )
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, 20);
  return (
    <div className="settings-data settings-collaboration">
      <p className="muted">
        {t(
          '协作服务器在你的多台设备和项目成员之间同步云端项目：文献与笔记、代码文件、项目笔记、实验与运行记录。AI 对话、Python 环境与实验运行仍保留在本机。',
        )}
      </p>
      <label className="settings-input-row">
        {t('服务器地址')}
        <Input
          value={endpoint}
          placeholder="https://collab.example.com"
          disabled={busy}
          onChange={(event) => setEndpoint(event.target.value)}
        />
      </label>
      <div className="setting-row">
        <div>
          <h3>{t('启用项目协作')}</h3>
          <p>{t('登录后，云端项目会在打开时和每 30 秒自动同步，本机保存后也会尽快同步。')}</p>
        </div>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          aria-label={t('启用项目协作')}
          onChange={(event) => setEnabled(event.target.checked)}
        />
      </div>
      <section className="settings-collaboration-login">
        <h3>{t('协作登录')}</h3>
        {state?.authenticated ? (
          <div className="settings-collaboration-account">
            <p>{t('已登录：{phone}', { phone: maskPhone(state.phone ?? '') })}</p>
            <Button variant="ghost" disabled={busy} onClick={() => void logout()}>
              {t('退出登录')}
            </Button>
          </div>
        ) : (
          <div className="settings-collaboration-account">
            <p>{t('尚未登录。登录后，云端项目会在你的设备之间同步。')}</p>
            <Button variant="primary" disabled={busy} onClick={requestSignIn}>
              {t('登录')}
            </Button>
          </div>
        )}
      </section>
      {state?.authenticated ? (
        <section className="settings-collaboration-projects">
          <div className="settings-collaboration-projects-heading">
            <h3>{t('云端项目同步')}</h3>
          </div>
          {synced.length ? (
            synced.map((project) => {
              const info = syncStates[project.id];
              return (
                <div className="settings-collaboration-issue" key={project.id}>
                  <div>
                    <strong>{project.name}</strong>
                    <span>
                      {info?.lastSyncAt
                        ? t('上次同步：{time}', { time: when(info.lastSyncAt) })
                        : t('尚未同步')}
                    </span>
                    {info?.libraryRoot ? (
                      <small>{t('文献文件夹：{path}', { path: info.libraryRoot })}</small>
                    ) : null}
                    {info?.lastError ? (
                      <small className="error-text">{translateError(info.lastError)}</small>
                    ) : null}
                  </div>
                  <div className="settings-collaboration-issue-actions">
                    <Button
                      variant="ghost"
                      disabled={busy || syncing !== null}
                      onClick={() => void syncNow(project.id)}
                    >
                      {syncing === project.id ? t('正在同步…') : t('立即同步')}
                    </Button>
                  </div>
                </div>
              );
            })
          ) : (
            <p className="muted">
              {t('还没有云端项目。在“团队协作空间”中新建项目，或为本机项目开启多设备同步。')}
            </p>
          )}
        </section>
      ) : null}
      <section className="settings-collaboration-status" aria-live="polite">
        <span>{t('连接状态')}</span>
        <strong>
          {state?.authenticated
            ? t('已登录')
            : state?.enabled
              ? t('已启用，尚未登录')
              : t('未启用')}
        </strong>
      </section>
      {conflicts.length ? (
        <section className="settings-collaboration-issues" aria-live="polite">
          <div className="settings-collaboration-projects-heading">
            <h3>{t('最近的同步冲突')}</h3>
          </div>
          <p className="muted">
            {t('两台设备改了同一内容时两份都会保留：远端版本沿用原名，本机版本另存为冲突副本。')}
          </p>
          {conflicts.map((conflict) => (
            <div
              className="settings-collaboration-issue"
              key={`${conflict.project}-${conflict.domain}-${conflict.path}-${conflict.at}`}
            >
              <div>
                <strong>
                  {conflict.project} · {t(kinds[conflict.domain] ?? conflict.domain)}
                </strong>
                <span>{conflict.path}</span>
                <small>
                  {conflict.copy
                    ? t('本机版本另存为：{copy}', { copy: conflict.copy })
                    : t('已采用远端版本')}
                </small>
              </div>
              <div className="settings-collaboration-issue-actions">
                <small className="muted">{when(conflict.at)}</small>
              </div>
            </div>
          ))}
        </section>
      ) : null}
      {error ? (
        <p role="alert" className="error-text">
          {error}
        </p>
      ) : null}
      <footer className="settings-actions">
        <span className="muted">{t('服务器地址会保存在本地，不会上传 API Key。')}</span>
        <Button variant="primary" disabled={busy || !endpoint.trim()} onClick={() => void save()}>
          {busy ? t('正在保存…') : t('保存协作设置')}
        </Button>
      </footer>
    </div>
  );
}
