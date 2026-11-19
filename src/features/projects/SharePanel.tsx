import { useState, type CSSProperties } from 'react';
import { AlertTriangle, Check, ChevronDown, Cloud, CloudOff, RefreshCw } from 'lucide-react';
import { Button, Input } from '../../components/primitives';
import { Menu, type MenuAnchor } from '../../components/primitives/Menu';
import { confirmAction } from '../../components/prompts';
import { t, locale } from '../../i18n';
import type { Project } from '../../domain/workspace';
import {
  collaboration,
  type CollaborationMember,
  type ProjectSyncState,
  type SyncConflict,
} from '../../platform/collaboration';
import { maskPhone, normalizePhone } from '../account/account';
import {
  inviteRoles,
  roleDescriptions,
  roleName,
  validPhone,
  type InviteRole,
} from './ProjectDialogs';

const AVATAR_COLORS = ['#3370ff', '#00b96b', '#ff8800', '#7f3bf5', '#f54a45', '#14c0ff'];

/** A round initial in a color that stays the same for the same person. */
function Avatar({ seed, label }: { seed: string; label: string }) {
  const color = AVATAR_COLORS[[...seed].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 6];
  return (
    <span className="share-avatar" style={{ '--avatar': color } as CSSProperties} aria-hidden>
      {label}
    </span>
  );
}

function when(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? t('今天 {time}', {
        time: date.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }),
      })
    : date.toLocaleString(locale(), {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

/**
 * What a shared project's panel shows, laid out as a share card: invite by phone,
 * the people in it with their roles, and how syncing is going at the foot.
 */
export function SharePanel({
  project,
  userId,
  members,
  status,
  state,
  syncing,
  online,
  error,
  busy,
  onMembers,
  onCompare,
  run,
}: {
  project: Project;
  userId?: string | null;
  members: CollaborationMember[] | null;
  status: string;
  state: ProjectSyncState | null;
  syncing: boolean;
  online: boolean;
  error: string;
  busy: boolean;
  onMembers(members: CollaborationMember[]): void;
  onCompare(conflict: SyncConflict): void;
  run(action: () => Promise<void>): Promise<void>;
}) {
  const owner = project.collaborationRole === 'owner';
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<InviteRole>('editor');
  const [menu, setMenu] = useState<
    | { anchor: MenuAnchor; kind: 'invite' }
    | { anchor: MenuAnchor; kind: 'member'; member: CollaborationMember }
    | null
  >(null);
  const reload = async () => onMembers((await collaboration.members(project.id)).members);
  const invite = () =>
    run(async () => {
      if (!validPhone(phone)) return;
      await collaboration.inviteMember(project.id, normalizePhone(phone), role);
      setPhone('');
      await reload();
    });
  const open = (event: React.MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: rect.left, y: rect.bottom + 4, trigger: event.currentTarget };
  };
  const sorted = [...(members ?? [])].sort(
    (a, b) =>
      Number(b.id === userId) - Number(a.id === userId) ||
      Number(b.role === 'owner') - Number(a.role === 'owner') ||
      Number(!!a.pending) - Number(!!b.pending),
  );
  const problem = error || (state?.lastError ? state.lastError : '');
  return (
    <div className="share-panel">
      <header className="share-head">
        <h2>{t('共享「{name}」', { name: project.name })}</h2>
        <span
          className={`share-status${problem || state?.conflicts.length ? ' is-warning' : ''}`}
          role="status"
        >
          {syncing ? (
            <RefreshCw className="sync-spinning" size={13} />
          ) : !online || state?.paused ? (
            <CloudOff size={13} />
          ) : problem || state?.conflicts.length ? (
            <AlertTriangle size={13} />
          ) : (
            <Cloud size={13} />
          )}
          {status}
        </span>
      </header>
      {problem ? (
        <p role="alert" className="share-alert">
          {problem}
        </p>
      ) : null}
      {owner ? (
        <div className="share-invite">
          <div className="share-invite-field">
            <Input
              aria-label={t('成员手机号')}
              inputMode="tel"
              placeholder={t('输入手机号，邀请协作者')}
              value={phone}
              disabled={busy}
              onChange={(event) => setPhone(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void invite();
                }
              }}
            />
            <button
              type="button"
              className="share-role-pick"
              aria-label={t('邀请角色：{role}', { role: roleName(role) })}
              aria-haspopup="menu"
              onClick={(event) => setMenu({ anchor: open(event), kind: 'invite' })}
            >
              {roleName(role)}
              <ChevronDown size={13} />
            </button>
          </div>
          <Button
            variant="primary"
            disabled={busy || !validPhone(phone)}
            onClick={() => void invite()}
          >
            {t('邀请')}
          </Button>
        </div>
      ) : null}
      <section className="share-people" aria-label={t('协作者')}>
        <h3>
          {t('协作者')}
          {members ? <span>{members.length}</span> : null}
        </h3>
        {members === null ? (
          <p className="share-muted">{t('正在读取…')}</p>
        ) : (
          <ul>
            {sorted.map((member) => {
              const me = member.id === userId;
              const name = me ? t('我') : maskPhone(member.phone);
              const manage = owner && !me && member.role !== 'owner';
              return (
                <li key={member.id}>
                  <Avatar
                    seed={member.phone || member.id}
                    label={member.phone.slice(-2) || '·'}
                  />
                  <span className="share-person">
                    <strong>{name}</strong>
                    {member.pending ? <small>{t('待注册')}</small> : null}
                  </span>
                  {manage ? (
                    <button
                      type="button"
                      className="share-role-pick"
                      aria-label={t('{name} 的角色：{role}', { name, role: roleName(member.role) })}
                      aria-haspopup="menu"
                      onClick={(event) => setMenu({ anchor: open(event), kind: 'member', member })}
                    >
                      {roleName(member.role)}
                      <ChevronDown size={13} />
                    </button>
                  ) : (
                    <span className="share-role">{roleName(member.role)}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {state?.conflicts.length ? (
        <section className="share-conflicts" aria-label={t('待处理冲突')}>
          <h3>
            <AlertTriangle size={14} />
            {t('{count} 处冲突待处理', { count: state.conflicts.length })}
          </h3>
          <ul>
            {state.conflicts.map((conflict) => (
              <li key={`${conflict.domain}:${conflict.path}:${conflict.at}`}>
                <span className="share-person">
                  <strong>{conflict.path}</strong>
                  <small>{when(conflict.at)}</small>
                </span>
                <Button disabled={busy || syncing} onClick={() => onCompare(conflict)}>
                  {t('查看对比')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <footer className="share-foot">
        <span>
          {state?.lastSyncAt
            ? t('上次同步 {time}', { time: when(state.lastSyncAt) })
            : t('尚未同步')}
        </span>
        {state?.skipped ? (
          <span>{t('跳过 {count} 项（超过 200 MB）', { count: state.skipped })}</span>
        ) : null}
        {state?.deferred ? (
          <span>{t('{count} 项等任务结束后同步', { count: state.deferred })}</span>
        ) : null}
      </footer>
      <Menu nested anchor={menu?.anchor ?? null} label={t('角色')} onClose={() => setMenu(null)}>
        {menu
          ? inviteRoles.map((option) => {
              const current = menu.kind === 'invite' ? role : menu.member.role;
              return (
                <Button
                  key={option}
                  role="menuitemradio"
                  aria-checked={current === option}
                  variant="ghost"
                  className="share-role-option"
                  onClick={() => {
                    setMenu(null);
                    if (menu.kind === 'invite') return setRole(option);
                    if (menu.member.role === option) return;
                    // Inviting again with another role changes the member's role.
                    void run(async () => {
                      await collaboration.inviteMember(project.id, menu.member.phone, option);
                      await reload();
                    });
                  }}
                >
                  <span className="share-role-check">
                    {current === option ? <Check size={14} /> : null}
                  </span>
                  <span>
                    <strong>{roleName(option)}</strong>
                    <small>{t(roleDescriptions[option])}</small>
                  </span>
                </Button>
              );
            })
          : null}
        {menu?.kind === 'member' ? (
          <>
            <div className="sf-menu-separator" role="separator" />
            <Button
              role="menuitem"
              variant="ghost"
              className="sf-menu-danger"
              onClick={() => {
                const member = menu.member;
                setMenu(null);
                void run(async () => {
                  const name = maskPhone(member.phone);
                  const ok = await confirmAction(
                    member.pending
                      ? t('撤销对 {phone} 的邀请？', { phone: name })
                      : t('移除 {phone}？对方将不再同步这个项目。', { phone: name }),
                  );
                  if (!ok) return;
                  await collaboration.removeMember(project.id, member.id);
                  await reload();
                });
              }}
            >
              {menu.member.pending ? t('撤销邀请') : t('移出项目')}
            </Button>
          </>
        ) : null}
      </Menu>
    </div>
  );
}
