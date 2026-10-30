import { useCallback, useEffect, useState } from 'react';
import { Button, Input } from '../../components/primitives';
import { t, translateError } from '../../i18n';
import {
  collaboration,
  type CollaborationInboxChange,
  type CollaborationOperation,
  type CollaborationState,
} from '../../platform/collaboration';

export function CollaborationPreferences() {
  const [state, setState] = useState<CollaborationState | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [projects, setProjects] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [conflictOperations, setConflictOperations] = useState<CollaborationOperation[]>([]);
  const [deferredChanges, setDeferredChanges] = useState<CollaborationInboxChange[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const next = await collaboration.status();
      setState(next);
      setEndpoint(next.endpoint);
      setEnabled(next.enabled);
      if (next.authenticated) {
        try {
          const [projectResult, operations, changes] = await Promise.all([
            collaboration.projects(),
            collaboration.outbox(),
            collaboration.inbox(),
          ]);
          setProjects(projectResult.projects);
          setConflictOperations(operations.filter((operation) => operation.status === 'conflict'));
          setDeferredChanges(changes.filter((change) => Boolean(change.error)));
        } catch {
          setProjects([]);
          setConflictOperations([]);
          setDeferredChanges([]);
        }
      } else {
        setProjects([]);
        setConflictOperations([]);
        setDeferredChanges([]);
      }
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
  const sendCode = async () => {
    setBusy(true);
    setError('');
    try {
      await collaboration.sendCode(endpoint, phone);
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusy(false);
    }
  };
  const login = async () => {
    setBusy(true);
    setError('');
    try {
      const next = await collaboration.login(endpoint, phone, code);
      setState(next);
      setEnabled(true);
      setProjects((await collaboration.projects()).projects);
      setConflictOperations([]);
      setDeferredChanges([]);
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    setBusy(true);
    try {
      setState(await collaboration.logout());
      setProjects([]);
      setConflictOperations([]);
      setDeferredChanges([]);
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusy(false);
    }
  };
  const bindProject = async (projectId: string) => {
    setBusy(true);
    try {
      setState(await collaboration.bindProject(projectId));
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusy(false);
    }
  };
  const sync = async () => {
    setBusy(true);
    try {
      setState(await collaboration.sync());
      await refresh();
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusy(false);
    }
  };
  const keepLocal = async (operationId: string) => {
    setBusy(true);
    setError('');
    try {
      setState(await collaboration.acknowledge(operationId));
      await refresh();
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusy(false);
    }
  };
  const retryConflict = async (operationId: string) => {
    if (!window.confirm(t('以本地版本覆盖远端变更并重试？'))) return;
    setBusy(true);
    setError('');
    try {
      setState(await collaboration.retryConflict(operationId));
      await refresh();
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusy(false);
    }
  };
  const discardRemote = async (operationId: string) => {
    if (!window.confirm(t('忽略远端变更并保留本地？'))) return;
    setBusy(true);
    setError('');
    try {
      setState(await collaboration.discardInbox(operationId));
      await refresh();
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
          <p>{t('登录后可以加入协作项目；本地变更会先进入离线队列，再由服务器同步。')}</p>
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
            <p>{t('已登录：{phone}', { phone: state.phone ?? '' })}</p>
            <Button variant="ghost" disabled={busy} onClick={() => void logout()}>
              {t('退出登录')}
            </Button>
          </div>
        ) : (
          <div className="settings-collaboration-login-fields">
            <Input
              value={phone}
              placeholder={t('手机号')}
              disabled={busy}
              onChange={(event) => setPhone(event.target.value)}
            />
            <div className="settings-collaboration-code">
              <Input
                value={code}
                placeholder={t('验证码')}
                disabled={busy}
                onChange={(event) => setCode(event.target.value)}
              />
              <Button
                variant="ghost"
                disabled={busy || !phone.trim()}
                onClick={() => void sendCode()}
              >
                {t('获取验证码')}
              </Button>
            </div>
            <Button
              variant="primary"
              disabled={busy || !phone.trim() || !code.trim()}
              onClick={() => void login()}
            >
              {t('登录协作服务器')}
            </Button>
          </div>
        )}
      </section>
      {state?.authenticated ? (
        <section className="settings-collaboration-projects">
          <div className="settings-collaboration-projects-heading">
            <h3>{t('协作项目')}</h3>
            <Button
              variant="ghost"
              disabled={busy || !state.workspaceId}
              onClick={() => void sync()}
            >
              {t('立即同步')}
            </Button>
          </div>
          {projects.length ? (
            <div className="settings-collaboration-project-list">
              {projects.map((project) => (
                <button
                  className={project.id === state.workspaceId ? 'active' : ''}
                  key={project.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void bindProject(project.id)}
                >
                  <span>{project.name}</span>
                  <small>{project.role}</small>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">{t('登录后还没有可加入的协作项目。')}</p>
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
        <span>{t('待同步变更：{count}', { count: state?.pendingChanges ?? 0 })}</span>
        <span>{t('冲突：{count}', { count: state?.conflicts ?? 0 })}</span>
        {state?.workspaceId ? (
          <span>
            {state.literatureBootstrapped
              ? t('文献库已完成首次同步')
              : t('打开文献页后将初始化本地文献库')}
          </span>
        ) : null}
      </section>
      {conflictOperations.length || deferredChanges.length ? (
        <section className="settings-collaboration-issues" aria-live="polite">
          <h3>{t('待处理的同步变更')}</h3>
          {conflictOperations.map((operation) => (
            <div className="settings-collaboration-issue" key={operation.operationId}>
              <div>
                <strong>{t('本地变更冲突')}</strong>
                <span>
                  {operation.payload &&
                  typeof operation.payload === 'object' &&
                  'path' in operation.payload
                    ? String((operation.payload as { path?: unknown }).path ?? operation.kind)
                    : operation.kind}
                </span>
                {operation.lastError ? <small>{operation.lastError}</small> : null}
              </div>
              <div className="settings-collaboration-issue-actions">
                <Button
                  variant="ghost"
                  disabled={busy || operation.conflictRevision == null}
                  onClick={() => void retryConflict(operation.operationId)}
                >
                  {t('重试本地变更')}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void keepLocal(operation.operationId)}
                >
                  {t('保留本地')}
                </Button>
              </div>
            </div>
          ))}
          {deferredChanges.map((change, index) => (
            <div
              className="settings-collaboration-issue"
              key={change.operationId ?? `${change.kind}-${change.entityId}-${index}`}
            >
              <div>
                <strong>{t('远端变更待处理')}</strong>
                <span>{change.payload?.path ?? change.kind ?? t('文献变更')}</span>
                {change.error ? <small>{change.error}</small> : null}
              </div>
              <div className="settings-collaboration-issue-actions">
                <small className="muted">{t('打开文献页后重试')}</small>
                {change.operationId ? (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void discardRemote(change.operationId!)}
                  >
                    {t('保留本地')}
                  </Button>
                ) : null}
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
