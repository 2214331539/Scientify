import { ProjectSyncControl } from '../projects/ProjectSyncControl';
import { useCallback, useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { Button, Input } from '../../components/primitives';
import { t, translateError } from '../../i18n';
import type { WorkspaceStore } from '../../stores/workspace';
import {
  collaboration,
  collaborationStateEvent,
  isSyncedProject,
  requestSignIn,
  type CollaborationState,
} from '../../platform/collaboration';
import { maskPhone } from '../account/account';

function notifyCollaborationStateChanged() {
  window.dispatchEvent(new Event(collaborationStateEvent));
}

export function CollaborationPreferences({ store }: { store: WorkspaceStore }) {
  const data = useStore(store, (s) => s.data);
  const synced = (data?.projects ?? []).filter(isSyncedProject);
  const [state, setState] = useState<CollaborationState | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const next = await collaboration.status();
      setState(next);
      setEndpoint(next.endpoint);
      setEnabled(next.enabled);
      setError('');
    } catch (reason) {
      setError(translateError(String(reason)));
    }
  }, []);
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
            synced.map((project) => (
              <div className="settings-collaboration-issue" key={project.id}>
                <strong>{project.name}</strong>
                <ProjectSyncControl project={project} store={store} />
              </div>
            ))
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
