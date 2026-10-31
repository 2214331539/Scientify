import { isTauri } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';
import { LogIn, LogOut, RefreshCw, Shield, UserPlus, UsersRound } from 'lucide-react';
import { Button, Input, Dropdown } from '../../components/primitives';
import { BrandMark } from '../../components/layout/BrandMark';
import { WindowControls } from '../../components/layout/WindowControls';
import { t, translateError } from '../../i18n';
import {
  collaboration,
  collaborationStateEvent,
  type CollaborationMember,
  type CollaborationProject,
  type CollaborationState,
} from '../../platform/collaboration';
import './collaboration-workspace.css';

const roleLabel: Record<string, string> = {
  owner: '所有者',
  editor: '编辑者',
  reviewer: '审阅者',
  viewer: '查看者',
};

function notifyCollaborationStateChanged() {
  window.dispatchEvent(new Event(collaborationStateEvent));
}

function roleName(role?: string) {
  return roleLabel[role ?? ''] ?? role ?? '—';
}

export function CollaborationWorkspace({
  onOpenProject,
}: {
  onOpenProject(project: CollaborationProject): Promise<void>;
}) {
  const [state, setState] = useState<CollaborationState | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [projects, setProjects] = useState<CollaborationProject[]>([]);
  const [selected, setSelected] = useState<CollaborationProject | null>(null);
  const [members, setMembers] = useState<CollaborationMember[]>([]);
  const [projectName, setProjectName] = useState('');
  const [invitePhone, setInvitePhone] = useState('');
  const [inviteRole, setInviteRole] = useState<'editor' | 'reviewer' | 'viewer'>('editor');
  const [busy, setBusy] = useState(false);
  const [busyProject, setBusyProject] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadProjects = useCallback(async () => {
    const result = await collaboration.projects();
    setProjects(result.projects);
    setSelected((current) =>
      current ? (result.projects.find((project) => project.id === current.id) ?? null) : null,
    );
  }, []);

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const next = await collaboration.status();
      setState(next);
      setEndpoint(next.endpoint);
      setError('');
      if (next.authenticated) await loadProjects();
      else {
        setProjects([]);
        setSelected(null);
        setMembers([]);
      }
    } catch (reason) {
      setError(translateError(String(reason)));
    }
  }, [loadProjects]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function saveEndpoint() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await collaboration.configure(endpoint, true);
      setState(next);
      notifyCollaborationStateChanged();
      setNotice(t('协作服务器设置已保存。'));
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusy(false);
    }
  }

  async function checkHealth() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await collaboration.health(endpoint);
      setNotice(t('协作服务连接正常。'));
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusy(false);
    }
  }

  async function sendCode() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await collaboration.sendCode(endpoint, phone);
      setNotice(t('验证码已发送，请查收短信。'));
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusy(false);
    }
  }

  async function login() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await collaboration.login(endpoint, phone, code);
      setState(next);
      notifyCollaborationStateChanged();
      await loadProjects();
      setNotice(t('已登录协作服务器。'));
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setError('');
    try {
      const next = await collaboration.logout();
      setState(next);
      notifyCollaborationStateChanged();
      setProjects([]);
      setSelected(null);
      setMembers([]);
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusy(false);
    }
  }

  async function createProject() {
    if (!projectName.trim()) return;
    setBusy(true);
    setError('');
    try {
      const project = await collaboration.createProject(projectName.trim());
      setProjectName('');
      await loadProjects();
      setSelected(project);
      setNotice(t('协作项目已创建。'));
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusy(false);
    }
  }

  async function showMembers(project: CollaborationProject) {
    setSelected(project);
    setBusyProject(project.id);
    setError('');
    try {
      setMembers((await collaboration.members(project.id)).members);
    } catch (reason) {
      setMembers([]);
      setError(translateError(String(reason)));
    } finally {
      setBusyProject(null);
    }
  }

  async function invite() {
    if (!selected || !invitePhone.trim()) return;
    setBusy(true);
    setError('');
    try {
      await collaboration.inviteMember(selected.id, invitePhone.trim(), inviteRole);
      setInvitePhone('');
      await showMembers(selected);
      setNotice(t('成员邀请已发送。'));
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusy(false);
    }
  }

  async function open(project: CollaborationProject) {
    setBusyProject(project.id);
    setError('');
    try {
      await collaboration.bindProject(project.id);
      await onOpenProject(project);
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusyProject(null);
    }
  }

  if (!isTauri()) {
    return (
      <section className="collaboration-workspace" aria-label={t('团队协作空间')}>
        <header className="launcher-topbar" data-tauri-drag-region>
          <span className="spacer" />
          <WindowControls />
        </header>
        <div className="collaboration-empty">
          <UsersRound aria-hidden="true" />
          <h1>{t('团队协作空间')}</h1>
          <p>{t('登录和协作同步需要在 Scientify 桌面应用中使用。')}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="collaboration-workspace" aria-label={t('团队协作空间')}>
      <header className="collaboration-topbar" data-tauri-drag-region>
        <div className="collaboration-heading">
          <BrandMark />
          <div>
            <strong>{t('团队协作空间')}</strong>
            <span>{t('登录后管理共享文献与项目成员')}</span>
          </div>
        </div>
        <div className="collaboration-toolbar">
          {state?.authenticated ? (
            <Button variant="ghost" disabled={busy} onClick={() => void logout()}>
              <LogOut />
              {t('退出登录')}
            </Button>
          ) : null}
          <WindowControls />
        </div>
      </header>

      <div className="collaboration-content">
        <section className="collaboration-hero">
          <div>
            <p className="eyebrow">{t('本地优先协作')}</p>
            <h1>{state?.authenticated ? t('你的协作项目') : t('登录 Scientify 协作')}</h1>
            <p className="muted">
              {state?.authenticated
                ? t('选择一个远程项目，绑定到本机工作区后继续阅读、编辑和运行。')
                : t('服务器只负责身份、成员和同步索引；论文文件与实验代码仍由你控制。')}
            </p>
          </div>
          <div
            className="collaboration-status-chip"
            data-status={state?.authenticated ? 'on' : 'off'}
          >
            <span />
            {state?.authenticated ? t('已连接') : t('未登录')}
          </div>
        </section>

        <section className="collaboration-card collaboration-connection">
          <div className="collaboration-card-heading">
            <div>
              <h2>{t('连接协作服务器')}</h2>
              <p>{t('服务器地址和登录状态只保存在本机。')}</p>
            </div>
            <div className="collaboration-card-actions">
              <Button
                variant="ghost"
                disabled={busy || !endpoint.trim()}
                onClick={() => void checkHealth()}
              >
                <Shield />
                {t('检查连接')}
              </Button>
              <Button
                variant="ghost"
                disabled={busy || !endpoint.trim()}
                onClick={() => void saveEndpoint()}
              >
                <RefreshCw />
                {t('保存连接')}
              </Button>
            </div>
          </div>
          <label>
            {t('服务器地址')}
            <Input
              value={endpoint}
              disabled={busy || !!state?.authenticated}
              placeholder="https://collab.example.com"
              onChange={(event) => setEndpoint(event.target.value)}
            />
          </label>
          {state?.authenticated ? (
            <div className="collaboration-account">
              <Shield aria-hidden="true" />
              <span>{t('已登录：{phone}', { phone: state.phone ?? '' })}</span>
              <small>{t('JWT 会在本机安全存储并自动刷新')}</small>
            </div>
          ) : (
            <div className="collaboration-login-fields">
              <label>
                {t('手机号')}
                <Input
                  value={phone}
                  disabled={busy}
                  inputMode="tel"
                  placeholder={t('输入手机号')}
                  onChange={(event) => setPhone(event.target.value)}
                />
              </label>
              <label>
                {t('验证码')}
                <div className="collaboration-code-input">
                  <Input
                    value={code}
                    disabled={busy}
                    inputMode="numeric"
                    placeholder={t('短信验证码')}
                    onChange={(event) => setCode(event.target.value)}
                  />
                  <Button
                    variant="ghost"
                    disabled={busy || !phone.trim() || !endpoint.trim()}
                    onClick={() => void sendCode()}
                  >
                    {t('获取验证码')}
                  </Button>
                </div>
              </label>
              <Button
                variant="primary"
                disabled={busy || !phone.trim() || !code.trim() || !endpoint.trim()}
                onClick={() => void login()}
              >
                <LogIn />
                {t('登录并继续')}
              </Button>
            </div>
          )}
        </section>

        {state?.authenticated ? (
          <div className="collaboration-main-grid">
            <section className="collaboration-card collaboration-projects">
              <div className="collaboration-card-heading">
                <div>
                  <h2>{t('协作项目')}</h2>
                  <p>{t('{count} 个项目', { count: projects.length })}</p>
                </div>
                <Button variant="ghost" disabled={busy} onClick={() => void refresh()}>
                  <RefreshCw />
                  {t('刷新')}
                </Button>
              </div>
              <div className="collaboration-create-project">
                <Input
                  value={projectName}
                  disabled={busy}
                  placeholder={t('新建协作项目名称')}
                  onChange={(event) => setProjectName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void createProject();
                  }}
                />
                <Button
                  variant="primary"
                  disabled={busy || !projectName.trim()}
                  onClick={() => void createProject()}
                >
                  {t('新建')}
                </Button>
              </div>
              <div className="collaboration-project-list">
                {projects.length ? (
                  projects.map((project) => (
                    <article
                      className={selected?.id === project.id ? 'active' : ''}
                      key={project.id}
                    >
                      <div className="collaboration-project-icon">
                        <UsersRound />
                      </div>
                      <div className="collaboration-project-info">
                        <strong>{project.name}</strong>
                        <span>{roleName(project.role)}</span>
                      </div>
                      <div className="collaboration-project-actions">
                        <Button
                          variant="ghost"
                          disabled={busyProject === project.id}
                          onClick={() => void showMembers(project)}
                        >
                          {t('成员')}
                        </Button>
                        <Button
                          variant="primary"
                          disabled={busyProject === project.id}
                          onClick={() => void open(project)}
                        >
                          {busyProject === project.id ? t('正在打开…') : t('进入项目')}
                        </Button>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="collaboration-list-empty">
                    {t('还没有协作项目，先创建一个项目。')}
                  </div>
                )}
              </div>
            </section>

            <section className="collaboration-card collaboration-members">
              <div className="collaboration-card-heading">
                <div>
                  <h2>{t('项目成员')}</h2>
                  <p>{selected ? selected.name : t('选择项目查看成员')}</p>
                </div>
                <UsersRound aria-hidden="true" />
              </div>
              {selected ? (
                <>
                  <div className="collaboration-member-list">
                    {members.length ? (
                      members.map((member) => (
                        <div className="collaboration-member" key={member.id}>
                          <span>{member.phone}</span>
                          <small>{roleName(member.role)}</small>
                        </div>
                      ))
                    ) : (
                      <p className="muted">{t('暂无成员信息')}</p>
                    )}
                  </div>
                  {selected.role === 'owner' ? (
                    <div className="collaboration-invite">
                      <div className="collaboration-invite-heading">
                        <UserPlus />
                        <strong>{t('邀请成员')}</strong>
                      </div>
                      <Input
                        value={invitePhone}
                        disabled={busy}
                        inputMode="tel"
                        placeholder={t('成员手机号')}
                        onChange={(event) => setInvitePhone(event.target.value)}
                      />
                      <Dropdown
                        value={inviteRole}
                        disabled={busy}
                        onChange={(event) => setInviteRole(event.target.value as typeof inviteRole)}
                      >
                        <option value="editor">{t('编辑者')}</option>
                        <option value="reviewer">{t('审阅者')}</option>
                        <option value="viewer">{t('查看者')}</option>
                      </Dropdown>
                      <Button
                        variant="primary"
                        disabled={busy || !invitePhone.trim()}
                        onClick={() => void invite()}
                      >
                        {t('邀请')}
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="collaboration-members-empty">
                  <UsersRound />
                  <p>{t('成员列表会显示在这里。')}</p>
                </div>
              )}
            </section>
          </div>
        ) : null}

        {notice ? (
          <p className="collaboration-notice" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="error-text collaboration-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
