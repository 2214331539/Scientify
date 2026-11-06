import { useState } from 'react';
import { useStore } from 'zustand';
import { Archive, Info, X } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Button, Input } from '../../components/primitives';
import { t, translateError } from '../../i18n';
import type { Project } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import {
  collaboration,
  isSyncedProject,
  type CollaborationRole,
} from '../../platform/collaboration';
import { maskPhone, normalizePhone } from '../account/account';
import { refreshCloud } from './cloud';
import { MiniCover } from './ProjectCover';
import {
  COLLABORATION_TEAM_ID,
  coverColor,
  deleteProject,
  ensureCollaborationTeam,
  personalProjects,
} from './model';

export type InviteRole = Exclude<CollaborationRole, 'owner'>;
export const inviteRoles: InviteRole[] = ['editor', 'reviewer', 'viewer'];
export const roleLabels: Record<string, string> = {
  owner: '所有者',
  editor: '编辑者',
  reviewer: '审阅者',
  viewer: '查看者',
};
export const roleDescriptions: Record<string, string> = {
  owner: '修改全部内容，管理成员',
  editor: '可以修改全部内容',
  reviewer: '只能修改项目笔记',
  viewer: '只接收，不能修改',
};
export const roleName = (role: string) => t(roleLabels[role] ?? role);
export const validPhone = (value: string) => /^1\d{10}$/.test(normalizePhone(value));

function DialogFooter({ children, extra }: { children: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <footer className="dialog-footer center-dialog-footer">
      {extra ? <span className="center-dialog-extra">{extra}</span> : <span />}
      <span className="center-dialog-buttons">{children}</span>
    </footer>
  );
}

/** Says what is deleted and what stays on disk, and offers archiving instead. */
export function DeleteProjectDialog({
  store,
  project,
  onClose,
  onArchive,
}: {
  store: WorkspaceStore;
  project: Project;
  onClose(): void;
  onArchive(): void;
}) {
  const data = useStore(store, (s) => s.data)!;
  const busy = useStore(store, (s) => s.busy);
  const dirty = useStore(store, (s) => s.dirty);
  const error = useStore(store, (s) => s.error);
  const notes = data.records.filter((item) => item.project === project.id).length;
  const runs = data.runs.filter((item) => item.project === project.id).length;
  const chats = data.sessions.filter((item) => item.project === project.id).length;
  return (
    <Modal title={t('删除“{name}”？', { name: project.name })} busy={busy} onClose={onClose}>
      <div className="form-grid center-dialog">
        <p>
          {t('将删除笔记 {notes} 条、运行记录 {runs} 条、AI 对话 {chats} 个。', {
            notes,
            runs,
            chats,
          })}
        </p>
        <p className="muted">{t('磁盘上的文件保留。')}</p>
        {dirty ? <p role="alert">{t('请先保存当前修改，再删除项目或团队。')}</p> : null}
        {error ? (
          <p role="alert" className="error-text">
            {translateError(error)}
          </p>
        ) : null}
        <DialogFooter
          extra={
            !project.archived ? (
              <Button variant="ghost" disabled={busy} onClick={onArchive}>
                <Archive />
                {t('改为归档')}
              </Button>
            ) : null
          }
        >
          <Button disabled={busy} onClick={onClose}>
            {t('取消')}
          </Button>
          <Button
            variant="primary"
            className="center-danger"
            disabled={busy || dirty}
            onClick={async () => {
              const saved = await store
                .getState()
                .update((value) => deleteProject(value, project.id));
              if (saved) onClose();
            }}
          >
            {busy ? t('正在保存…') : t('删除项目')}
          </Button>
        </DialogFooter>
      </div>
    </Modal>
  );
}

/** Turns on sync for a personal project; it stays personal and only the owner sees it. */
export function SyncProjectDialog({
  store,
  project,
  onClose,
}: {
  store: WorkspaceStore;
  project: Project;
  onClose(): void;
}) {
  const busy = useStore(store, (s) => s.busy);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  async function start() {
    setWorking(true);
    setError('');
    try {
      await collaboration.createProject(project.name, project.id);
      const saved = await store.getState().update((value) => {
        const target = value.projects.find((item) => item.id === project.id);
        if (target) Object.assign(target, { collaborationRole: 'owner' });
      });
      if (!saved) throw new Error(store.getState().error ?? t('项目没有保存，请重试。'));
      void collaboration
        .syncProject(project.id)
        .catch(() => {})
        .finally(() => void refreshCloud(store.getState().data?.projects ?? []));
      onClose();
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setWorking(false);
    }
  }
  return (
    <Modal title={t('在多台设备上同步')} busy={working} onClose={onClose}>
      <div className="form-grid center-dialog">
        <p className="center-dialog-subject">
          <MiniCover color={coverColor(project)} />
          <strong>{project.name}</strong>
        </p>
        <p>
          <strong>{t('会同步')}</strong> {t('文献、笔记、代码和运行记录')}
        </p>
        <p className="muted">
          <strong>{t('不会同步')}</strong> {t('AI 对话、模型密钥、终端和 Python 环境')}
        </p>
        <p className="muted">{t('其他设备登录同一账号后即可下载。')}</p>
        {error ? (
          <p role="alert" className="error-text">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button disabled={working} onClick={onClose}>
            {t('取消')}
          </Button>
          <Button variant="primary" disabled={working || busy} onClick={() => void start()}>
            {working ? t('正在开启…') : t('开始同步')}
          </Button>
        </DialogFooter>
      </div>
    </Modal>
  );
}

function RoleChoice({ value, onChange }: { value: InviteRole; onChange(role: InviteRole): void }) {
  return (
    <div className="center-roles" role="radiogroup" aria-label={t('角色')}>
      {inviteRoles.map((role) => (
        <label key={role} className={value === role ? 'checked' : ''}>
          <input
            type="radio"
            name="invite-role"
            checked={value === role}
            onChange={() => onChange(role)}
          />
          <span>
            <strong>{roleName(role)}</strong>
            <small>{t(roleDescriptions[role])}</small>
          </span>
        </label>
      ))}
    </div>
  );
}

/** Phone and role rows collected before a project is shared or created for a team. */
export function InviteList({
  invites,
  onChange,
  disabled,
}: {
  invites: { phone: string; role: InviteRole }[];
  onChange(next: { phone: string; role: InviteRole }[]): void;
  disabled?: boolean;
}) {
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<InviteRole>('editor');
  const add = () => {
    if (!validPhone(phone)) return;
    const normalized = normalizePhone(phone);
    onChange([...invites.filter((item) => item.phone !== normalized), { phone: normalized, role }]);
    setPhone('');
  };
  return (
    <div className="center-invites">
      <div className="center-phone">
        <span>+86</span>
        <Input
          aria-label={t('成员手机号')}
          inputMode="tel"
          placeholder={t('手机号')}
          value={phone}
          disabled={disabled}
          onChange={(event) => setPhone(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <select
          className="sf-dropdown"
          aria-label={t('角色')}
          value={role}
          disabled={disabled}
          onChange={(event) => setRole(event.target.value as InviteRole)}
        >
          {inviteRoles.map((item) => (
            <option key={item} value={item}>
              {roleName(item)}
            </option>
          ))}
        </select>
        <Button type="button" disabled={disabled || !validPhone(phone)} onClick={add}>
          {t('添加')}
        </Button>
      </div>
      {invites.length ? (
        <ul className="center-invite-chips">
          {invites.map((invite) => (
            <li key={invite.phone}>
              {maskPhone(invite.phone)} · {roleName(invite.role)}
              <Button
                type="button"
                variant="ghost"
                iconOnly
                aria-label={t('移除 {phone}', { phone: maskPhone(invite.phone) })}
                disabled={disabled}
                onClick={() => onChange(invites.filter((item) => item.phone !== invite.phone))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Publishes a personal project for a team; its id and local folders stay the same. */
export function ShareProjectDialog({
  store,
  projectId,
  onClose,
  onShared,
}: {
  store: WorkspaceStore;
  projectId?: string;
  onClose(): void;
  onShared(id: string): void;
}) {
  const data = useStore(store, (s) => s.data)!;
  const candidates = personalProjects(data).filter((project) => !project.archived);
  const [selected, setSelected] = useState(projectId ?? candidates[0]?.id ?? '');
  const [invites, setInvites] = useState<{ phone: string; role: InviteRole }[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const fixed = projectId ? data.projects.find((project) => project.id === projectId) : undefined;
  async function share() {
    const project = data.projects.find((item) => item.id === selected);
    if (!project) return;
    setWorking(true);
    setError('');
    try {
      if (!isSyncedProject(project)) await collaboration.createProject(project.name, project.id);
      for (const invite of invites)
        await collaboration.inviteMember(project.id, invite.phone, invite.role);
      const saved = await store.getState().update((value) => {
        ensureCollaborationTeam(value);
        const target = value.projects.find((item) => item.id === project.id);
        if (target)
          Object.assign(target, { space: COLLABORATION_TEAM_ID, collaborationRole: 'owner' });
      });
      if (!saved) throw new Error(store.getState().error ?? t('项目没有保存，请重试。'));
      void collaboration
        .syncProject(project.id)
        .catch(() => {})
        .finally(() => void refreshCloud(store.getState().data?.projects ?? []));
      onShared(project.id);
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setWorking(false);
    }
  }
  return (
    <Modal title={t('共享到团队')} busy={working} onClose={onClose}>
      <div className="form-grid center-dialog">
        {fixed ? (
          <p className="center-dialog-subject">
            <MiniCover color={coverColor(fixed)} />
            <strong>{fixed.name}</strong>
          </p>
        ) : candidates.length ? (
          <fieldset className="center-pick" disabled={working}>
            <legend>{t('选择项目')}</legend>
            {candidates.map((project) => (
              <label key={project.id} className={selected === project.id ? 'checked' : ''}>
                <input
                  type="radio"
                  name="share-project"
                  checked={selected === project.id}
                  onChange={() => setSelected(project.id)}
                />
                <MiniCover color={coverColor(project)} />
                <span>
                  <strong>{project.name}</strong>
                  <small>
                    {isSyncedProject(project) ? t('已开启多设备同步') : t('只在这台电脑上')}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="muted">{t('没有可以共享的个人项目。')}</p>
        )}
        <div className="center-field">
          <span className="center-label">
            {t('邀请成员')}
            <small>{t('可选')}</small>
          </span>
          <InviteList invites={invites} onChange={setInvites} disabled={working} />
          <small className="muted">{t('未注册的号码会在对方首次登录后加入。')}</small>
        </div>
        <p className="center-tip">
          <Info />
          <span>{t('共享后项目移到“团队项目”，你是所有者。')}</span>
        </p>
        {error ? (
          <p role="alert" className="error-text">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button disabled={working} onClick={onClose}>
            {t('取消')}
          </Button>
          <Button variant="primary" disabled={working || !selected} onClick={() => void share()}>
            {working ? t('正在共享…') : t('共享')}
          </Button>
        </DialogFooter>
      </div>
    </Modal>
  );
}

/** The owner invites one phone number; unregistered numbers join on their first sign-in. */
export function InviteMemberDialog({
  projectId,
  projectName,
  onClose,
  onInvited,
}: {
  projectId: string;
  projectName: string;
  onClose(): void;
  onInvited(phone: string): void;
}) {
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<InviteRole>('editor');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  async function invite() {
    setWorking(true);
    setError('');
    try {
      await collaboration.inviteMember(projectId, normalizePhone(phone), role);
      onInvited(normalizePhone(phone));
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setWorking(false);
    }
  }
  return (
    <Modal
      title={t('邀请成员')}
      heading={t('邀请成员到“{name}”', { name: projectName })}
      busy={working}
      onClose={onClose}
    >
      <form
        className="form-grid center-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (validPhone(phone)) void invite();
        }}
      >
        <label>
          {t('手机号')}
          <span className="center-phone">
            <span>+86</span>
            <Input
              autoFocus
              inputMode="tel"
              placeholder={t('对方的手机号')}
              value={phone}
              disabled={working}
              onChange={(event) => setPhone(event.target.value)}
            />
          </span>
        </label>
        <div className="center-field">
          <span className="center-label">{t('角色')}</span>
          <RoleChoice value={role} onChange={setRole} />
        </div>
        <p className="center-tip">
          <Info />
          <span>{t('未注册的号码会在对方首次登录后加入。')}</span>
        </p>
        {error ? (
          <p role="alert" className="error-text">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" disabled={working} onClick={onClose}>
            {t('取消')}
          </Button>
          <Button type="submit" variant="primary" disabled={working || !validPhone(phone)}>
            {working ? t('正在邀请…') : t('发送邀请')}
          </Button>
        </DialogFooter>
      </form>
    </Modal>
  );
}
