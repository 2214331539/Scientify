import { useState } from 'react';
import { Button } from '../../components/primitives';
import { t } from '../../i18n';
import {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  setUpdatePrefs,
  skipUpdate,
  updatePrefs,
  useUpdate,
  type UpdateSnapshot,
} from './updater';
import './update.css';

export function downloadShare(state: UpdateSnapshot) {
  if (!state.total) return null;
  return Math.min(100, Math.round(((state.received ?? 0) / state.total) * 100));
}

/** Settings → 关于: the update status, its notes and what to do about it. */
export function UpdatePanel() {
  const state = useUpdate();
  const [autoDownload, setAutoDownload] = useState(() => updatePrefs().autoDownload);
  if (state.phase === 'off') return <p className="sf-update-status">{t('开发版不检查更新。')}</p>;
  const share = downloadShare(state);
  const status = {
    idle: '',
    checking: t('正在检查更新…'),
    latest: t('已是最新版本'),
    available: t('新版本 {version} 可用', { version: state.version ?? '' }),
    downloading:
      share === null
        ? t('正在下载 {version}…', { version: state.version ?? '' })
        : t('正在下载 {version}：{share}%', { version: state.version ?? '', share }),
    ready: t('{version} 已下载，重启后完成更新', { version: state.version ?? '' }),
    installing: t('正在安装，Scientify 会自动重启…'),
    error: state.error ?? '',
  }[state.phase];
  const offered = ['available', 'downloading', 'ready'].includes(state.phase);
  return (
    <div className="sf-update" aria-live="polite">
      {status ? (
        <p className={`sf-update-status${state.phase === 'error' ? ' error-text' : ''}`}>
          {status}
        </p>
      ) : null}
      {state.phase === 'downloading' ? (
        <progress className="sf-update-progress" max={100} value={share ?? undefined} />
      ) : null}
      {offered && state.notes ? (
        <div className="sf-update-notes">
          <strong>{t('更新内容')}</strong>
          <p>{state.notes}</p>
        </div>
      ) : null}
      <div className="sf-update-actions">
        {state.phase === 'ready' ? (
          <Button variant="primary" onClick={() => void installUpdate()}>
            {t('重启以完成更新')}
          </Button>
        ) : null}
        {state.phase === 'available' ? (
          <Button variant="primary" onClick={() => void installUpdate()}>
            {t('立即更新')}
          </Button>
        ) : null}
        {state.phase === 'available' && !autoDownload ? (
          <Button onClick={() => void downloadUpdate()}>{t('只下载')}</Button>
        ) : null}
        {state.phase === 'available' || state.phase === 'ready' ? (
          <Button variant="ghost" onClick={skipUpdate}>
            {t('跳过这个版本')}
          </Button>
        ) : null}
        {offered || state.phase === 'installing' ? null : (
          <Button disabled={state.phase === 'checking'} onClick={() => void checkForUpdates(true)}>
            {t('检查更新')}
          </Button>
        )}
      </div>
      <label className="sf-update-auto">
        <input
          type="checkbox"
          checked={autoDownload}
          onChange={(event) => {
            setAutoDownload(event.target.checked);
            setUpdatePrefs({ autoDownload: event.target.checked });
          }}
        />
        {t('有新版本时自动在后台下载')}
      </label>
    </div>
  );
}
