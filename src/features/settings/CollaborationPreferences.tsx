import { useCallback, useEffect, useState } from 'react';
import { Button, Input } from '../../components/primitives';
import { t, translateError } from '../../i18n';
import { collaboration, type CollaborationState } from '../../platform/collaboration';

export function CollaborationPreferences() {
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
  }, [refresh]);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const next = await collaboration.configure(endpoint, enabled);
      setState(next);
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-data settings-collaboration">
      <p className="muted">
        {t(
          '协作服务器用于同步项目成员、文献元数据、PDF、笔记和代码仓库。AI、Python 环境与实验运行仍保留在本机。',
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
          <p>{t('当前阶段先保存服务器配置；远程登录和同步服务将在服务器接口接入后启用。')}</p>
        </div>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          aria-label={t('启用项目协作')}
          onChange={(event) => setEnabled(event.target.checked)}
        />
      </div>
      <section className="settings-collaboration-status" aria-live="polite">
        <span>{t('连接状态')}</span>
        <strong>{state?.enabled ? t('已启用，等待服务器连接') : t('未启用')}</strong>
        <span>{t('待同步变更：{count}', { count: state?.pendingChanges ?? 0 })}</span>
        <span>{t('冲突：{count}', { count: state?.conflicts ?? 0 })}</span>
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
